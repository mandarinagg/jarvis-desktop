import { DashboardResult } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { dashboard } from "./dashboard.js";
import { localDay, openDatabase } from "./db.js";
import { MemoryStore } from "./memory/store.js";
import { ProjectStore } from "./projects/store.js";
import { ConversationStore } from "./store.js";
import { AuditLog } from "./tools/permissions.js";

const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 0 };

function seed(now: Date) {
  const db = openDatabase(":memory:");
  let clock = now;
  const store = new ConversationStore(db, () => clock);
  const a = store.createConversation("Plan del lanzamiento de Recetario");
  const b = store.createConversation("Dudas de TypeScript");
  // Today: 0.40 in a, 0.10 in b. Five days ago: 0.25 in b. Last month (outside the month total).
  store.recordUsage({ turnId: "t1", conversationId: a.id, model: "m", usage, costUsd: 0.4 });
  store.recordUsage({ turnId: "t2", conversationId: b.id, model: "m", usage, costUsd: 0.1 });
  clock = new Date(now.getTime() - 5 * 86_400_000);
  store.recordUsage({ turnId: "t3", conversationId: b.id, model: "m", usage, costUsd: 0.25 });
  clock = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12);
  store.recordUsage({ turnId: "t4", conversationId: b.id, model: "m", usage, costUsd: 9 });

  const projects = new ProjectStore(db);
  const p = projects.create({ name: "Recetario", root: "C:\\proyectos\\recetario" });
  const task = db.prepare(
    `INSERT INTO builder_tasks (id, project_id, task, branch, base_branch, base_sha, worktree, status, budget_usd, cost_usd, day, created_at)
     VALUES (?, ?, 'x', 'b', 'main', 'abc', 'w', ?, 1, ?, ?, ?)`,
  );
  task.run("k1", p.id, "review", 0.6, localDay(now), now.toISOString());
  task.run("k2", p.id, "running", 0.05, localDay(now), now.toISOString());

  const memories = new MemoryStore(db, () => now);
  memories.recordReflection({ day: localDay(now), conversations: 2, episodes: 2, proposals: 1, costUsd: 0.03 });
  memories.add({ kind: "preference", text: "Respuestas cortas", source: "owner" });
  memories.add({ kind: "idea", text: "App de recetas por voz", source: "owner" });
  const done = memories.add({ kind: "idea", text: "Idea vieja", source: "owner" });
  memories.update(done.id, { ideaStatus: "hecha" });
  memories.addProposal({ kind: "fact", text: "Usa SQLite", reason: "lo dijo" });

  const audit = new AuditLog(db, () => now);
  audit.record({ server: "projects", tool: "search", args: {}, risk: "read", decision: "allow", approvedBy: "policy", ok: true });
  audit.record({ server: "projects", tool: "write_file", args: {}, risk: "confirm", decision: "allow", approvedBy: "owner:desktop", ok: true });
  audit.record({ server: "projects", tool: "delete", args: {}, risk: "destructive", decision: "deny", reason: "rechazado" });
  return { db, a, b };
}

describe("dashboard", () => {
  const now = new Date(2026, 10, 20, 15, 0); // 20 Nov 2026, local

  it("adds up today's and this month's spend by kind and fills 30 days", () => {
    const { db } = seed(now);
    const d = dashboard(db, { dailyBudgetUsd: 3, googleTts: false, now });
    expect(d.spend.todayUsd).toBeCloseTo(0.4 + 0.1 + 0.6 + 0.05 + 0.03);
    expect(d.spend.month.chatUsd).toBeCloseTo(0.75);
    expect(d.spend.month.builderUsd).toBeCloseTo(0.65);
    expect(d.spend.month.reflectionUsd).toBeCloseTo(0.03);
    expect(d.spend.monthUsd).toBeCloseTo(1.43);
    expect(d.spend.projectedMonthUsd).toBeCloseTo((1.43 / 20) * 30);
    expect(d.spend.days).toHaveLength(30);
    expect(d.spend.days.at(-1)?.day).toBe("2026-11-20");
    expect(d.spend.days.find((x) => x.day === "2026-11-15")?.chatUsd).toBeCloseTo(0.25);
    expect(d.spend.days.filter((x) => x.chatUsd + x.builderUsd + x.reflectionUsd > 0)).toHaveLength(2);
    // 300 cached of 400 prompt tokens per turn (the old month is excluded).
    expect(d.spend.cacheHitRate).toBeCloseTo(0.75);
  });

  it("ranks this month's most expensive conversations", () => {
    const { db, a, b } = seed(now);
    const d = dashboard(db, { dailyBudgetUsd: 3, googleTts: false, now });
    expect(d.spend.topConversations.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(d.spend.topConversations[1]?.costUsd).toBeCloseTo(0.35);
  });

  it("counts today's actions, pending work and open ideas", () => {
    const { db } = seed(now);
    const d = dashboard(db, { dailyBudgetUsd: 3, googleTts: true, now });
    expect(d.activity).toEqual({ actionsToday: 2, confirmedToday: 1, deniedToday: 1 });
    expect(d.builder).toEqual({ running: 1, review: 1 });
    expect(d.memory).toMatchObject({ enabled: true, active: 3, pendingProposals: 1 });
    expect(d.memory.openIdeas.map((i) => i.text)).toEqual(["App de recetas por voz"]);
    expect(d.cloud.map((c) => c.provider)).toEqual(["Anthropic", "Anthropic", "Anthropic", "Google"]);
    expect(d.cloud[0]?.callsToday).toBe(2);
  });

  it("works on an empty database and matches the protocol schema", () => {
    const db = openDatabase(":memory:");
    const d = dashboard(db, { dailyBudgetUsd: 3, googleTts: false, now });
    expect(d.spend.monthUsd).toBe(0);
    expect(d.spend.cacheHitRate).toBeUndefined();
    expect(d.cloud).toHaveLength(3);
    expect(DashboardResult.safeParse({ type: "dashboard.result", id: "x", ...d }).success).toBe(true);
    expect(DashboardResult.safeParse({ type: "dashboard.result", id: "x", ...seedResult(now) }).success).toBe(true);
  });
});

function seedResult(now: Date) {
  return dashboard(seed(now).db, { dailyBudgetUsd: 3, googleTts: true, now });
}
