/** Reminders, briefings and the owner's proactivity rules (Phase 7, ADR-026). */
import type { DatabaseSync } from "node:sqlite";

export interface Reminder {
  id: number;
  text: string;
  dueAt: string;
  status: "pending" | "fired" | "cancelled";
  createdAt: string;
  firedAt?: string | undefined;
}

/** "HH:MM", 24 h, local time. */
export type Clock = string;
export interface QuietHours {
  start: Clock;
  end: Clock;
}
export interface ProactiveSettings {
  /** Daily briefing time, or null when off (the default). */
  briefingTime: Clock | null;
  /** No notifications in this window; what falls inside waits until it ends. Default 22:00–08:00. */
  quietHours: QuietHours | null;
}

export const DEFAULT_SETTINGS: ProactiveSettings = { briefingTime: null, quietHours: { start: "22:00", end: "08:00" } };
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MAX_REMINDER_CHARS = 300;

type Row = { id: number; text: string; dueAt: string; status: Reminder["status"]; createdAt: string; firedAt: string | null };
const toReminder = (r: Row): Reminder => ({ id: r.id, text: r.text, dueAt: r.dueAt, status: r.status, createdAt: r.createdAt, ...(r.firedAt ? { firedAt: r.firedAt } : {}) });
const COLS = "id, text, due_at AS dueAt, status, created_at AS createdAt, fired_at AS firedAt";

export class ProactiveStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  addReminder(r: { text: string; dueAt: string; sourceConversationId?: string | null }): Reminder {
    const ts = this.now().toISOString();
    const res = this.db
      .prepare("INSERT INTO reminders (text, due_at, source_conversation_id, created_at) VALUES (?, ?, ?, ?)")
      .run(r.text, r.dueAt, r.sourceConversationId ?? null, ts);
    return this.reminder(Number(res.lastInsertRowid)) as Reminder;
  }

  reminder(id: number): Reminder | undefined {
    const row = this.db.prepare(`SELECT ${COLS} FROM reminders WHERE id = ?`).get(id) as Row | undefined;
    return row ? toReminder(row) : undefined;
  }

  /** Pending reminders, soonest first. */
  pending(limit = 50): Reminder[] {
    return (this.db.prepare(`SELECT ${COLS} FROM reminders WHERE status = 'pending' ORDER BY due_at LIMIT ?`).all(limit) as Row[]).map(toReminder);
  }

  /** Pending reminders whose time has come (UTC ISO compares as text). */
  due(nowIso: string): Reminder[] {
    return (this.db.prepare(`SELECT ${COLS} FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at`).all(nowIso) as Row[]).map(toReminder);
  }

  /** Pending reminders due in [fromIso, toIso). */
  between(fromIso: string, toIso: string): Reminder[] {
    return (
      this.db.prepare(`SELECT ${COLS} FROM reminders WHERE status = 'pending' AND due_at >= ? AND due_at < ? ORDER BY due_at`).all(fromIso, toIso) as Row[]
    ).map(toReminder);
  }

  markFired(id: number): void {
    this.db.prepare("UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ? AND status = 'pending'").run(this.now().toISOString(), id);
  }

  /** Returns false when it was not pending. */
  cancel(id: number): boolean {
    return Number(this.db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id).changes) > 0;
  }

  briefing(day: string): { day: string; text: string; createdAt: string } | undefined {
    return this.db.prepare("SELECT day, text, created_at AS createdAt FROM briefings WHERE day = ?").get(day) as { day: string; text: string; createdAt: string } | undefined;
  }

  saveBriefing(day: string, text: string): void {
    this.db.prepare("INSERT OR REPLACE INTO briefings (day, text, created_at) VALUES (?, ?, ?)").run(day, text, this.now().toISOString());
  }

  settings(): ProactiveSettings {
    const get = (k: string) => (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
    const briefing = get("proactive.briefing");
    const quiet = get("proactive.quiet");
    const [start, end] = (quiet ?? "").split("-");
    return {
      briefingTime: briefing && CLOCK.test(briefing) ? briefing : briefing === undefined ? DEFAULT_SETTINGS.briefingTime : null,
      quietHours:
        quiet === undefined ? DEFAULT_SETTINGS.quietHours : start && end && CLOCK.test(start) && CLOCK.test(end) && start !== end ? { start, end } : null,
    };
  }

  setSettings(s: Partial<ProactiveSettings>): ProactiveSettings {
    const set = (k: string, v: string) =>
      this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
    if (s.briefingTime !== undefined) set("proactive.briefing", s.briefingTime ?? "");
    if (s.quietHours !== undefined) set("proactive.quiet", s.quietHours ? `${s.quietHours.start}-${s.quietHours.end}` : "");
    return this.settings();
  }
}
