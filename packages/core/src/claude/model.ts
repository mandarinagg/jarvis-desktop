/**
 * Claude adapter (ADR-005, docs/CLAUDE_API.md): official SDK only, streaming always,
 * cancellation through AbortSignal, SDK retries for 408/409/429/5xx, cached system prompt,
 * server-side refusal fallbacks.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "@jarvis/shared";
import type { ToolRuntime } from "../tools/hub.js";
import type { Channel } from "../tools/permissions.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatTurnRequest {
  system: string;
  /** Per-turn instructions after the cached system prompt (e.g. voice mode); not cached on their own. */
  systemSuffix?: string | undefined;
  messages: { role: "user" | "assistant"; content: string }[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  /** Read tools (ADR-017). The adapter runs the tool loop; every call goes through the runtime's gate. */
  tools?: ToolRuntime | undefined;
  turnId?: string | undefined;
  /** Where the owner's request came from; the tool gate uses it (ADR-029). */
  channel?: Channel | undefined;
  onTool?: ((event: ToolEvent) => void) | undefined;
}

export interface ToolEvent {
  name: string;
  summary: string;
  status: "started" | "waiting" | "done" | "error" | "denied";
}

/** Tool rounds per turn; the last round is forced to answer with what it has (tool_choice none). */
export const MAX_TOOL_ROUNDS = 8;

export interface ChatTurnResult {
  text: string;
  stopReason: string;
  /** Model that actually served the turn (a refusal fallback may differ from the requested one). */
  model: string;
  usage: Usage;
}

export interface ChatModel {
  readonly model: string;
  complete(req: ChatTurnRequest): Promise<ChatTurnResult>;
}

/** Thrown when the caller aborted the turn (chat.cancel / barge-in). */
export class TurnCancelledError extends Error {
  constructor(readonly partialText: string) {
    super("turn cancelled");
    this.name = "TurnCancelledError";
  }
}

/** API failure with a message that is safe to show and log (never contains the key). */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface AnthropicChatModelOptions {
  apiKey: string;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Tests only: a stand-in for the SDK client. */
  client?: Anthropic;
}

export class AnthropicChatModel implements ChatModel {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort;
  private readonly maxTokens: number;

  constructor(opts: AnthropicChatModelOptions) {
    this.model = opts.model ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "low";
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.client = opts.client ?? new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: opts.maxRetries ?? 2,
    });
  }

  async complete(req: ChatTurnRequest): Promise<ChatTurnResult> {
    let text = "";
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    // Fixed for the whole turn: system and tools never change between rounds (history-editing check).
    const tools = req.tools?.definitions() ?? [];
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
      ...(req.systemSuffix ? [{ type: "text" as const, text: req.systemSuffix }] : []),
    ];
    let model: string;
    let stopReason: string;
    try {
      for (let round = 0; ; round++) {
        const lastRound = round >= MAX_TOOL_ROUNDS;
        const stream = this.client.beta.messages.stream(
          {
            model: this.model,
            max_tokens: this.maxTokens,
            // Stable prefix first so it is cached across turns (CLAUDE_API.md §3).
            system,
            messages,
            ...(tools.length ? { tools, ...(lastRound ? { tool_choice: { type: "none" as const } } : {}) } : {}),
            cache_control: { type: "ephemeral" }, // also cache the growing conversation history
            output_config: { effort: this.effort },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          },
          { signal: req.signal },
        );
        let firstDelta = true;
        stream.on("text", (delta) => {
          if (firstDelta && round > 0 && text && !/\s$/.test(text)) {
            text += "\n\n";
            req.onText("\n\n");
          }
          firstDelta = false;
          text += delta;
          req.onText(delta);
        });
        const message = await stream.finalMessage();
        const u = message.usage;
        usage.inputTokens += u.input_tokens;
        usage.outputTokens += u.output_tokens;
        usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
        model = message.model;
        stopReason = message.stop_reason ?? "unknown";

        const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (message.stop_reason !== "tool_use" || !uses.length || !req.tools) break;

        // Append-only: the assistant turn goes back unchanged, thinking blocks included.
        messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const use of uses) {
          const summary = req.tools.describe(use.name, use.input);
          req.onTool?.({ name: use.name, summary, status: "started" });
          const r = await req.tools.call(use.name, use.input, {
            turnId: req.turnId,
            channel: req.channel,
            signal: req.signal,
            onWaiting: () => req.onTool?.({ name: use.name, summary, status: "waiting" }),
          });
          const status = !r.isError ? "done" : r.content.startsWith("Permiso denegado") ? "denied" : "error";
          req.onTool?.({ name: use.name, summary, status });
          results.push({ type: "tool_result", tool_use_id: use.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
      }
      return { text, stopReason, model, usage };
    } catch (err) {
      if (req.signal.aborted || err instanceof Anthropic.APIUserAbortError) throw new TurnCancelledError(text);
      throw toUpstreamError(err);
    }
  }
}

export function toUpstreamError(err: unknown): UpstreamError {
  if (err instanceof Anthropic.AuthenticationError) return new UpstreamError("La API key de Anthropic es inválida o fue revocada.", 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new UpstreamError("La API key no tiene permiso para este modelo.", 403);
  if (err instanceof Anthropic.RateLimitError) return new UpstreamError("Límite de uso de la API alcanzado; probá en un rato.", 429, true);
  if (err instanceof Anthropic.BadRequestError) return new UpstreamError("La API rechazó el pedido (400).", 400);
  if (err instanceof Anthropic.APIConnectionError) return new UpstreamError("No hay conexión con la API de Anthropic.", undefined, true);
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : undefined;
    return new UpstreamError(`Error de la API de Anthropic${status ? ` (${status})` : ""}.`, status, (status ?? 0) >= 500);
  }
  return new UpstreamError("Error inesperado hablando con Claude.");
}
