/**
 * Home panel (Phase 7, ADR-025): one read-only snapshot of what Jarvis spent, did and has pending.
 * Pure queries over the local database; nothing here calls a model or sends data anywhere.
 */
import type { DatabaseSync } from "node:sqlite";
import type { DashboardResult, SpendDay } from "@jarvis/shared";
import { localDay } from "./db.js";

export interface DashboardOptions {
  dailyBudgetUsd: number;
  /** The neural voice sends spoken replies to Google (ADR-011); Piper stays local. */
  googleTts: boolean;
  now?: Date;
}

type Snapshot = Omit<DashboardResult, "type" | "id">;

const num = (v: unknown) => Number(v ?? 0);
const DAYS = 30;

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Local day of the start of the day `n` days before `now` (the dashboard's 30-day window). */
function dayKeys(now: Date): string[] {
  return Array.from({ length: DAYS }, (_, i) => localDay(addDays(now, i - (DAYS - 1))));
}

export function dashboard(db: DatabaseSync, o: DashboardOptions): Snapshot {
  const now = o.now ?? new Date();
  const today = localDay(now);
  const keys = dayKeys(now);
  const from = keys[0] as string;
  const monthStart = `${today.slice(0, 8)}01`;

  const perDay = (table: string) =>
    new Map(
      (db.prepare(`SELECT day, SUM(cost_usd) AS usd FROM ${table} WHERE day >= ? GROUP BY day`).all(from) as { day: string; usd: number }[]).map(
        (r) => [r.day, num(r.usd)],
      ),
    );
  const chat = perDay("usage");
  const builder = perDay("builder_tasks");
  const reflection = perDay("reflections");
  const days: SpendDay[] = keys.map((day) => ({
    day,
    chatUsd: chat.get(day) ?? 0,
    builderUsd: builder.get(day) ?? 0,
    reflectionUsd: reflection.get(day) ?? 0,
  }));

  const monthOf = (table: string) => num((db.prepare(`SELECT SUM(cost_usd) AS usd FROM ${table} WHERE day >= ?`).get(monthStart) as { usd: number | null }).usd);
  const month = { chatUsd: monthOf("usage"), builderUsd: monthOf("builder_tasks"), reflectionUsd: monthOf("reflections") };
  const monthUsd = month.chatUsd + month.builderUsd + month.reflectionUsd;
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const todayRow = days[days.length - 1] as SpendDay;

  const topConversations = (
    db
      .prepare(
        `SELECT c.id AS id, c.title AS title, SUM(u.cost_usd) AS usd FROM usage u JOIN conversations c ON c.id = u.conversation_id
         WHERE u.day >= ? GROUP BY c.id ORDER BY usd DESC LIMIT 5`,
      )
      .all(monthStart) as { id: string; title: string; usd: number }[]
  )
    .filter((r) => num(r.usd) > 0)
    .map((r) => ({ id: r.id, title: r.title, costUsd: num(r.usd) }));

  const tokens = db
    .prepare("SELECT SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite FROM usage WHERE day >= ?")
    .get(monthStart) as { input: number | null; cacheRead: number | null; cacheWrite: number | null };
  const promptTokens = num(tokens.input) + num(tokens.cacheRead) + num(tokens.cacheWrite);

  const count = (sql: string, ...args: (string | number)[]) => num((db.prepare(sql).get(...args) as { n: number }).n);
  // Audit timestamps are UTC ISO; "today" is the local day, so compare against its local midnight.
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.toISOString();
  const activity = {
    actionsToday: count("SELECT COUNT(*) AS n FROM audit_log WHERE ts >= ? AND decision = 'allow'", since),
    confirmedToday: count("SELECT COUNT(*) AS n FROM audit_log WHERE ts >= ? AND approved_by LIKE 'owner%'", since),
    deniedToday: count("SELECT COUNT(*) AS n FROM audit_log WHERE ts >= ? AND decision = 'deny'", since),
  };

  const chatTurnsToday = count("SELECT COUNT(*) AS n FROM usage WHERE day = ?", today);
  const builderToday = count("SELECT COUNT(*) AS n FROM builder_tasks WHERE day = ?", today);
  const reflectionsToday = count("SELECT COUNT(*) AS n FROM reflections WHERE day = ? AND error IS NULL", today);
  const cloud: Snapshot["cloud"] = [
    { provider: "Anthropic", purpose: "Chat y voz (respuestas)", callsToday: chatTurnsToday },
    { provider: "Anthropic", purpose: "Builder", callsToday: builderToday },
    { provider: "Anthropic", purpose: "Reflexión diaria", callsToday: reflectionsToday },
  ];
  if (o.googleTts) cloud.push({ provider: "Google", purpose: "Voz neural (texto de las respuestas)" });

  const nowIso = now.toISOString();
  const memoryEnabled = (db.prepare("SELECT value FROM settings WHERE key = 'memory.enabled'").get() as { value: string } | undefined)?.value !== "0";
  const openIdeas = (
    db
      .prepare(
        `SELECT id, text, idea_status AS status FROM memories WHERE kind = 'idea' AND status = 'active'
         AND idea_status IN ('nueva', 'en_curso') ORDER BY idea_status = 'en_curso' DESC, updated_at DESC LIMIT 5`,
      )
      .all() as { id: number; text: string; status: "nueva" | "en_curso" }[]
  ).map((r) => ({ id: r.id, text: r.text, status: r.status }));

  return {
    generatedAt: nowIso,
    spend: {
      todayUsd: todayRow.chatUsd + todayRow.builderUsd + todayRow.reflectionUsd,
      dailyBudgetUsd: o.dailyBudgetUsd,
      monthUsd,
      projectedMonthUsd: (monthUsd / dayOfMonth) * daysInMonth,
      days,
      month,
      topConversations,
      ...(promptTokens > 0 ? { cacheHitRate: num(tokens.cacheRead) / promptTokens } : {}),
    },
    cloud,
    activity,
    builder: {
      running: count("SELECT COUNT(*) AS n FROM builder_tasks WHERE status = 'running'"),
      review: count("SELECT COUNT(*) AS n FROM builder_tasks WHERE status = 'review'"),
    },
    memory: {
      enabled: memoryEnabled,
      active: count(
        "SELECT COUNT(*) AS n FROM memories WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)",
        nowIso,
      ),
      pendingProposals: count("SELECT COUNT(*) AS n FROM memory_proposals WHERE status = 'pending'"),
      openIdeas,
    },
  };
}
