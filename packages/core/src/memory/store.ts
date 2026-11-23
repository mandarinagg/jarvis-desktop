/** Memory store (Phase 6, ADR-024, migration 008). Plain SQL over node:sqlite; FTS5 for search. */
import type { DatabaseSync } from "node:sqlite";

export type MemoryKind = "fact" | "preference" | "procedure" | "idea" | "episode";
export type IdeaStatus = "nueva" | "en_curso" | "hecha" | "descartada";
export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "preference", "procedure", "idea", "episode"];
export const MAX_MEMORY_CHARS = 1_000;

export interface Memory {
  id: number;
  kind: MemoryKind;
  text: string;
  projectId: string | null;
  source: "owner" | "reflection";
  sourceConversationId: string | null;
  status: "active" | "disabled";
  ideaStatus: IdeaStatus | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
}

const COLUMNS = `id, kind, text, project_id AS projectId, source, source_conversation_id AS sourceConversationId, status,
  idea_status AS ideaStatus, created_at AS createdAt, updated_at AS updatedAt, expires_at AS expiresAt,
  last_used_at AS lastUsedAt, use_count AS useCount`;
const M_COLUMNS = COLUMNS.split(",").map((c) => `m.${c.trim()}`).join(", ");

export interface NewMemory {
  kind: MemoryKind;
  text: string;
  projectId?: string | null | undefined;
  source: "owner" | "reflection";
  sourceConversationId?: string | null | undefined;
  expiresAt?: string | null | undefined;
}

export class MemoryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(m: NewMemory): Memory {
    const ts = this.now().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO memories (kind, text, project_id, source, source_conversation_id, idea_status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.kind, m.text.trim().slice(0, MAX_MEMORY_CHARS), m.projectId ?? null, m.source, m.sourceConversationId ?? null, m.kind === "idea" ? "nueva" : null, ts, ts, m.expiresAt ?? null);
    return this.get(Number(r.lastInsertRowid)) as Memory;
  }

  get(id: number): Memory | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`).get(id) as Memory | undefined;
  }

  update(id: number, changes: { text?: string | undefined; status?: Memory["status"] | undefined; ideaStatus?: IdeaStatus | undefined; projectId?: string | null | undefined }): Memory | undefined {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    const set = (column: string, value: string | null) => {
      sets.push(`${column} = ?`);
      vals.push(value);
    };
    if (changes.text !== undefined) set("text", changes.text.trim().slice(0, MAX_MEMORY_CHARS));
    if (changes.status !== undefined) set("status", changes.status);
    if (changes.ideaStatus !== undefined) set("idea_status", changes.ideaStatus);
    if (changes.projectId !== undefined) set("project_id", changes.projectId);
    if (sets.length) this.db.prepare(`UPDATE memories SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, this.now().toISOString(), id);
    return this.get(id);
  }

  delete(ids: number[]): number {
    let n = 0;
    for (const id of ids) n += Number(this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes);
    return n;
  }

  /** "Olvidá todo lo de esta semana": memories and pending proposals created in [since, until). */
  forgetRange(since: string, until: string): number {
    const n = Number(this.db.prepare("DELETE FROM memories WHERE created_at >= ? AND created_at < ?").run(since, until).changes);
    this.db.prepare("DELETE FROM memory_proposals WHERE created_at >= ? AND created_at < ? AND status = 'pending'").run(since, until);
    return n;
  }

  list(o: { kind?: MemoryKind | undefined; query?: string | undefined; limit?: number | undefined; includeDisabled?: boolean | undefined } = {}): Memory[] {
    const limit = Math.min(o.limit ?? 100, 500);
    const where = [o.includeDisabled ? "1 = 1" : "m.status = 'active'", ...(o.kind ? ["m.kind = ?"] : [])];
    const args: (string | number)[] = o.kind ? [o.kind] : [];
    const match = o.query ? ftsQuery(o.query) : undefined;
    if (match) {
      return this.db
        .prepare(`SELECT ${M_COLUMNS} FROM memory_fts f JOIN memories m ON m.id = f.rowid WHERE memory_fts MATCH ? AND ${where.join(" AND ")} ORDER BY bm25(memory_fts) LIMIT ?`)
        .all(match, ...args, limit) as unknown as Memory[];
    }
    return this.db.prepare(`SELECT ${COLUMNS} FROM memories m WHERE ${where.join(" AND ")} ORDER BY m.updated_at DESC LIMIT ?`).all(...args, limit) as unknown as Memory[];
  }

  /** Full-text candidates for retrieval, with their bm25 rank (lower = better). Excludes expired. */
  search(match: string, nowIso: string, limit = 30): (Memory & { rank: number })[] {
    return this.db
      .prepare(
        `SELECT ${M_COLUMNS}, bm25(memory_fts) AS rank FROM memory_fts f JOIN memories m ON m.id = f.rowid
         WHERE memory_fts MATCH ? AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
         ORDER BY rank LIMIT ?`,
      )
      .all(match, nowIso, limit) as unknown as (Memory & { rank: number })[];
  }

  /** Preferences apply almost everywhere: the most used/recent ones go in every turn. */
  topPreferences(limit: number): Memory[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM memories WHERE kind = 'preference' AND status = 'active' ORDER BY use_count DESC, updated_at DESC LIMIT ?`)
      .all(limit) as unknown as Memory[];
  }

  recordUses(turnId: string, conversationId: string, ids: number[]): void {
    const ts = this.now().toISOString();
    for (const id of ids) {
      this.db.prepare("INSERT OR IGNORE INTO memory_uses (turn_id, memory_id, conversation_id, ts) VALUES (?, ?, ?, ?)").run(turnId, id, conversationId, ts);
      this.db.prepare("UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?").run(ts, id);
    }
  }

  /** Memories shown to the model in the turns of a conversation before `turnId` (most recent turn first). */
  usedBefore(conversationId: string, turnId: string, turns = 1): { turnId: string; memories: Memory[] }[] {
    const rows = this.db
      .prepare(`SELECT turn_id AS turnId, MAX(ts) AS ts FROM memory_uses WHERE conversation_id = ? AND turn_id <> ? GROUP BY turn_id ORDER BY ts DESC LIMIT ?`)
      .all(conversationId, turnId, turns) as { turnId: string }[];
    return rows.map((r) => ({
      turnId: r.turnId,
      memories: this.db.prepare(`SELECT ${M_COLUMNS} FROM memory_uses u JOIN memories m ON m.id = u.memory_id WHERE u.turn_id = ? ORDER BY m.id`).all(r.turnId) as unknown as Memory[],
    }));
  }

  conversationOfTurn(turnId: string): string | undefined {
    const row = this.db.prepare("SELECT conversation_id AS c FROM messages WHERE turn_id = ? LIMIT 1").get(turnId) as { c: string } | undefined;
    return row?.c;
  }

  setting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  enabled(): boolean {
    return this.setting("memory.enabled") !== "0";
  }
}

const STOPWORDS = new Set(
  (
    "que de la el en y a los las del se un una por con no es para lo al como mas pero sus le ya o fue este ha si porque esta son entre cuando muy sin sobre " +
    "tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos unos yo otro otras otra el tanto " +
    "esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros tu te ti vos sos tenes tengo tiene hace hacer puedo podes queres quiero " +
    "decime deci dame hola che bueno dale ahi aca eso esa cosa cosas jarvis favor gracias como cual cuales cuanto donde cuando the and for with"
  ).split(" "),
);

export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Significant words of a message (no stopwords, 3+ letters), deduplicated, at most 12. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const w of foldText(text).split(/[^a-z0-9ñ]+/)) {
    if (w.length < 3 || STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * FTS5 query from free text: each term as a crude Spanish stem prefix ("preferencias" -> "prefer*"),
 * OR-ed. Terms are reduced to [a-z0-9], so nothing in the text can inject FTS syntax.
 */
export function ftsQuery(text: string): string | undefined {
  const parts = terms(text).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w.length >= 3).map((w) => `${w.length > 6 ? w.slice(0, Math.max(5, w.length - 3)) : w}*`);
  return parts.length ? [...new Set(parts)].join(" OR ") : undefined;
}
