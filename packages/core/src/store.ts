/** Persistence of conversations, messages and per-turn usage. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Usage } from "@jarvis/shared";
import { localDay } from "./db.js";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Active project (Phase 3), null when none. */
  projectId?: string | null;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  interrupted: boolean;
  createdAt: string;
}

const TITLE_MAX = 60;

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= TITLE_MAX ? oneLine : oneLine.slice(0, TITLE_MAX - 1).trimEnd() + "…";
}

export class ConversationStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createConversation(firstMessage: string): Conversation {
    const ts = this.now().toISOString();
    const c: Conversation = { id: randomUUID(), title: titleFrom(firstMessage) || "Conversación", createdAt: ts, updatedAt: ts };
    this.db
      .prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(c.id, c.title, c.createdAt, c.updatedAt);
    return c;
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db
      .prepare("SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, project_id AS projectId FROM conversations WHERE id = ?")
      .get(id);
    return row as Conversation | undefined;
  }

  listConversations(limit = 50): Conversation[] {
    return this.db
      .prepare(
        "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, project_id AS projectId FROM conversations ORDER BY updated_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit) as unknown as Conversation[];
  }

  /** Thinking mode of a conversation (Phase 6); null = normal. */
  thinkingMode(conversationId: string): "sparring" | "brainstorm" | "abogado" | undefined {
    const row = this.db.prepare("SELECT thinking_mode AS m FROM conversations WHERE id = ?").get(conversationId) as { m: string | null } | undefined;
    return (row?.m ?? undefined) as "sparring" | "brainstorm" | "abogado" | undefined;
  }

  setThinkingMode(conversationId: string, mode: "sparring" | "brainstorm" | "abogado" | null): void {
    this.db.prepare("UPDATE conversations SET thinking_mode = ? WHERE id = ?").run(mode, conversationId);
  }

  /** The owner cut the spoken reply short (barge-in after the text had already been stored). */
  markInterrupted(turnId: string): void {
    this.db.prepare("UPDATE messages SET interrupted = 1 WHERE turn_id = ? AND role = 'assistant'").run(turnId);
  }

  appendMessage(m: {
    conversationId: string;
    turnId: string;
    role: "user" | "assistant";
    content: string;
    interrupted?: boolean;
  }): StoredMessage {
    const ts = this.now().toISOString();
    const id = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, turn_id, role, content, interrupted, seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?), ?)`,
        )
        .run(id, m.conversationId, m.turnId, m.role, m.content, m.interrupted ? 1 : 0, m.conversationId, ts);
      this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(ts, m.conversationId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { id, conversationId: m.conversationId, turnId: m.turnId, role: m.role, content: m.content, interrupted: !!m.interrupted, createdAt: ts };
  }

  messages(conversationId: string): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id AS conversationId, turn_id AS turnId, role, content, interrupted, created_at AS createdAt
         FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversationId);
    return rows.map((r) => ({ ...(r as unknown as StoredMessage), interrupted: r.interrupted === 1 }));
  }

  recordUsage(u: { turnId: string; conversationId: string; model: string; usage: Usage; costUsd: number }): void {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO usage (turn_id, conversation_id, model, input_tokens, output_tokens, cache_read_tokens,
                            cache_write_tokens, cost_usd, day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.turnId,
        u.conversationId,
        u.model,
        u.usage.inputTokens,
        u.usage.outputTokens,
        u.usage.cacheReadTokens,
        u.usage.cacheWriteTokens,
        u.costUsd,
        localDay(at),
        at.toISOString(),
      );
  }

  spentOn(day: string): number {
    // Chat turns plus Builder tasks (Phase 5): one daily cap for everything Jarvis spends.
    const row = this.db
      .prepare(
        "SELECT (SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE day = ?) + (SELECT COALESCE(SUM(cost_usd), 0) FROM builder_tasks WHERE day = ?) AS total",
      )
      .get(day, day);
    return Number(row?.total ?? 0);
  }

  conversationCost(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE conversation_id = ?")
      .get(conversationId);
    return Number(row?.total ?? 0);
  }
}
