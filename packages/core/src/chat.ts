/**
 * Text chat turns (Phase 1, L0): daily budget check -> persist user message -> stream Claude ->
 * persist reply + usage. One turn at a time per conversation; cancellable (chat.cancel, disconnect).
 */
import { randomUUID } from "node:crypto";
import type { BudgetGet, ChatCancel, ChatSend, ConversationsGet, ConversationsList, ConversationsSetMode } from "@jarvis/shared";
import { type ChatModel, TurnCancelledError, UpstreamError } from "./claude/model.js";
import type { ProjectStore } from "./projects/store.js";
import type { ToolRuntime } from "./tools/hub.js";
import type { Channel } from "./tools/permissions.js";
import { costOf } from "./claude/pricing.js";
import { localDay } from "./db.js";
import { type Logger, silentLogger } from "./log.js";
import type { Session } from "./server.js";
import type { ConversationStore } from "./store.js";

export interface ChatServiceOptions {
  store: ConversationStore;
  /** Resolved per turn so a key stored while the Core runs is picked up without a restart. */
  model: () => ChatModel | undefined;
  systemPrompt: string;
  /** Extra instructions for spoken turns (prompts/voice.md). */
  voicePrompt?: string;
  /** Extra instructions for turns from the WhatsApp self-chat (prompts/whatsapp.md, ADR-029). */
  whatsappPrompt?: string;
  /** Read tools over registered projects (ADR-017). */
  tools?: ToolRuntime;
  /** Active-project card for a conversation, appended to the system prompt (ADR-017). */
  projectContext?: (conversationId: string) => Promise<string | undefined>;
  /** Relevant memories for this turn as a data block (Phase 6, ADR-024); records which ones were used. */
  memoryContext?: (o: { conversationId: string; turnId: string; text: string }) => string | undefined;
  /** Thinking-mode instructions of the conversation (sparring, brainstorm, abogado del diablo). */
  modePrompt?: (conversationId: string) => string | undefined;
  /** Current local date and time for the model (Phase 7: reminders need it), first in the suffix. */
  clock?: (now: Date) => string;
  /** Index of the owner's active skills (Phase 7, ADR-027): names and when to use them. */
  skillsContext?: () => string | undefined;
  /** Links new conversations to the project chosen in the client (chat.send projectId). */
  projects?: ProjectStore;
  dailyBudgetUsd: number;
  logger?: Logger;
  now?: () => Date;
}

interface ActiveTurn {
  controller: AbortController;
  sessionId: string;
  conversationId: string;
}

const HISTORY_LIMIT = 200;

/** How the owner's message arrived and how the reply will be consumed (also the tool gate's channel). */
export type ChatMode = Channel;

const NO_KEY =
  "No hay API key de Anthropic configurada. Guardala con: node packages/core/dist/set-secret.js anthropic-api-key";

export class ChatService {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly opts: ChatServiceOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * `spoken`: the owner talked (a WhatsApp voice note, ADR-030) and the reply will be heard, so the
   * voice prompt applies on top of the channel's. Voice turns on the PC are always spoken.
   */
  async chatSend(session: Session, msg: ChatSend, mode: ChatMode = "text", opts: { spoken?: boolean } = {}): Promise<void> {
    const { store } = this.opts;
    const fail = (code: "budget_exceeded" | "upstream_error" | "invalid_message", message: string) =>
      session.send({ type: "error", id: msg.id, code, message });

    const model = this.opts.model();
    if (!model) return fail("upstream_error", NO_KEY);

    const spent = store.spentOn(localDay(this.now()));
    if (spent >= this.opts.dailyBudgetUsd) {
      return fail(
        "budget_exceeded",
        `Se alcanzó el tope diario de US$ ${this.opts.dailyBudgetUsd.toFixed(2)} (gastado: US$ ${spent.toFixed(2)}).`,
      );
    }

    const conversation = msg.conversationId ? store.getConversation(msg.conversationId) : store.createConversation(msg.text);
    if (!conversation) return fail("invalid_message", "la conversación no existe");
    if (!msg.conversationId && msg.projectId && this.opts.projects?.get(msg.projectId)) {
      this.opts.projects.setConversationProject(conversation.id, msg.projectId);
    }
    if ([...this.active.values()].some((t) => t.conversationId === conversation.id)) {
      return fail("invalid_message", "ya hay una respuesta en curso en esta conversación");
    }

    const turnId = randomUUID();
    const controller = new AbortController();
    this.active.set(turnId, { controller, sessionId: session.id, conversationId: conversation.id });
    try {
      store.appendMessage({ conversationId: conversation.id, turnId, role: "user", content: msg.text });
      session.send({ type: "chat.started", id: msg.id, turnId, conversationId: conversation.id });

      const history = store.messages(conversation.id).map((m) => ({ role: m.role, content: m.content }));
      const card = await this.opts.projectContext?.(conversation.id);
      let memories: string | undefined;
      try {
        memories = this.opts.memoryContext?.({ conversationId: conversation.id, turnId, text: msg.text });
      } catch (err) {
        this.logger.log("warn", "memory.retrieve_failed", { error: err instanceof Error ? err.message : String(err) });
      }
      const thinking = this.opts.modePrompt?.(conversation.id);
      const suffix = [this.opts.clock?.(this.now()), this.opts.skillsContext?.(), card, memories, thinking, mode === "whatsapp" ? this.opts.whatsappPrompt : undefined, mode === "voice" || opts.spoken ? this.opts.voicePrompt : undefined].filter(Boolean).join("\n\n");
      const result = await model.complete({
        system: this.opts.systemPrompt,
        systemSuffix: suffix || undefined,
        tools: this.opts.tools,
        turnId,
        channel: mode,
        onTool: (e) => session.send({ type: "chat.tool", turnId, tool: e.name, summary: e.summary.slice(0, 300), status: e.status }),
        messages: history,
        signal: controller.signal,
        onText: (text) => session.send({ type: "chat.delta", turnId, text }),
      });

      if (result.text) store.appendMessage({ conversationId: conversation.id, turnId, role: "assistant", content: result.text });
      const costUsd = costOf(result.model, result.usage);
      store.recordUsage({ turnId, conversationId: conversation.id, model: result.model, usage: result.usage, costUsd });
      this.logger.log("info", "chat.turn_done", {
        turnId,
        mode,
        model: result.model,
        stopReason: result.stopReason,
        costUsd: Number(costUsd.toFixed(6)),
        ...result.usage,
      });
      session.send({ type: "chat.done", turnId, stopReason: result.stopReason, usage: result.usage, costUsd });
    } catch (err) {
      if (err instanceof TurnCancelledError) {
        if (err.partialText) {
          store.appendMessage({ conversationId: conversation.id, turnId, role: "assistant", content: err.partialText, interrupted: true });
        }
        this.logger.log("info", "chat.turn_cancelled", { turnId });
        session.send({ type: "error", id: msg.id, code: "cancelled", message: "respuesta cancelada" });
        return;
      }
      const upstream = err instanceof UpstreamError ? err : undefined;
      this.logger.log("error", "chat.turn_failed", { turnId, status: upstream?.status, error: err instanceof Error ? err.message : String(err) });
      fail("upstream_error", upstream?.message ?? "Error inesperado hablando con Claude.");
    } finally {
      this.active.delete(turnId);
    }
  }

  chatCancel(session: Session, msg: ChatCancel): void {
    const turn = this.active.get(msg.turnId);
    if (turn && turn.sessionId === session.id) turn.controller.abort();
  }

  disconnected(session: Session): void {
    for (const turn of this.active.values()) if (turn.sessionId === session.id) turn.controller.abort();
  }

  conversationsList(session: Session, msg: ConversationsList): void {
    const conversations = this.opts.store
      .listConversations(100)
      .map(({ id, title, updatedAt, projectId }) => ({ id, title, updatedAt, ...(projectId ? { projectId } : {}) }));
    session.send({ type: "conversations.list.result", id: msg.id, conversations });
  }

  /** Last HISTORY_LIMIT messages: keeps the reply well under the 1 MB IPC frame. */
  conversationsGet(session: Session, msg: ConversationsGet): void {
    const conversation = this.opts.store.getConversation(msg.conversationId);
    if (!conversation) {
      session.send({ type: "error", id: msg.id, code: "invalid_message", message: "la conversación no existe" });
      return;
    }
    const messages = this.opts.store
      .messages(conversation.id)
      .slice(-HISTORY_LIMIT)
      .map(({ role, content, interrupted, createdAt }) => ({ role, content, interrupted, createdAt }));
    session.send({
      type: "conversations.history",
      id: msg.id,
      conversationId: conversation.id,
      title: conversation.title,
      ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
      ...(this.opts.store.thinkingMode(conversation.id) ? { thinkingMode: this.opts.store.thinkingMode(conversation.id) } : {}),
      messages,
    });
  }

  /** Thinking mode of a conversation (Phase 6); replies with the updated history header. */
  conversationsSetMode(session: Session, msg: ConversationsSetMode): void {
    if (!this.opts.store.getConversation(msg.conversationId)) {
      session.send({ type: "error", id: msg.id, code: "invalid_message", message: "la conversación no existe" });
      return;
    }
    this.opts.store.setThinkingMode(msg.conversationId, msg.mode);
    this.conversationsGet(session, { type: "conversations.get", id: msg.id, conversationId: msg.conversationId });
  }

  budgetGet(session: Session, msg: BudgetGet): void {
    session.send({
      type: "budget.status",
      id: msg.id,
      spentTodayUsd: this.opts.store.spentOn(localDay(this.now())),
      dailyBudgetUsd: this.opts.dailyBudgetUsd,
    });
  }

  cancelAll(): void {
    for (const turn of this.active.values()) turn.controller.abort();
  }
}
