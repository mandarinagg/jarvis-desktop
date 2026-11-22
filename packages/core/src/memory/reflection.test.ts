import type { CoreMessage } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { localDay, openDatabase } from "../db.js";
import { ProjectStore } from "../projects/store.js";
import type { Session } from "../server.js";
import { ConversationStore } from "../store.js";
import { type ReflectionModel, type ReflectionOutput, Reflector } from "./reflection.js";
import { MemoryService } from "./service.js";
import { MemoryStore } from "./store.js";
import { SkillStore } from "../skills/store.js";

const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

function world(start = new Date(2026, 10, 20, 10, 0)) {
  let now = start;
  const clock = () => now;
  const db = openDatabase(":memory:");
  const projects = new ProjectStore(db, clock);
  const conversations = new ConversationStore(db, clock);
  const memories = new MemoryStore(db, clock);
  const inputs: string[] = [];
  let output: ReflectionOutput = { episodes: [], proposals: [] };
  const model: ReflectionModel = {
    async reflect(_system, input) {
      inputs.push(input);
      return { output, usage, model: "claude-opus-5-5" };
    },
  };
  const reflector = new Reflector({ db, memories, projects, model: () => model, spentToday: () => conversations.spentOn(localDay(clock())), dailyBudgetUsd: 3, now: clock });
  return {
    db,
    projects,
    conversations,
    memories,
    reflector,
    inputs,
    setOutput: (o: ReflectionOutput) => (output = o),
    setNow: (d: Date) => (now = d),
  };
}

function talk(w: ReturnType<typeof world>, user: string, assistant = "Dale.") {
  const c = w.conversations.createConversation(user);
  w.conversations.appendMessage({ conversationId: c.id, turnId: `t-${c.id}`, role: "user", content: user });
  w.conversations.appendMessage({ conversationId: c.id, turnId: `t-${c.id}`, role: "assistant", content: assistant });
  return c;
}

describe("daily reflection", () => {
  it("runs once a day after 4 AM, stores episodes and filtered proposals, and counts its cost", async () => {
    const w = world(new Date(2026, 10, 20, 3, 0));
    const p = w.projects.create({ name: "Recetario", root: "C:\\r" });
    w.memories.add({ kind: "preference", text: "El owner prefiere respuestas cortas por voz", source: "owner" });
    talk(w, "Para Recetario usemos SQLite, ya está decidido.");
    talk(w, "Mi contraseña del banco es hunter22, guardala.");
    expect(w.reflector.due()).toBe(false); // before 4 AM
    w.setNow(new Date(2026, 10, 20, 9, 0));
    expect(w.reflector.due()).toBe(true);

    w.setOutput({
      episodes: [
        { conversation: "c1", summary: "Se decidió usar SQLite en Recetario." },
        { conversation: "c9", summary: "Conversación inventada." },
      ],
      proposals: [
        { kind: "fact", text: "Recetario usa SQLite como base de datos", reason: "lo decidió en c1", conversation: "c1", project: "Recetario" },
        { kind: "fact", text: "La contraseña del banco del owner es hunter22", reason: "c2", conversation: "c2" },
        { kind: "preference", text: "El owner prefiere respuestas cortas por voz", reason: "repetido", conversation: "c1" },
        { kind: "idea", text: "Recetario usa SQLite como base de datos", reason: "duplicado en la misma corrida", conversation: "c1" },
      ],
    });
    const r = await w.reflector.run();
    expect(r).toMatchObject({ conversations: 2, episodes: 1, proposals: 1 });
    expect(w.inputs[0]).toContain("<ya_recordado>");
    expect(w.inputs[0]).toContain("El owner prefiere respuestas cortas por voz");
    const [proposal] = w.memories.pendingProposals();
    expect(proposal).toMatchObject({ kind: "fact", projectId: p.id, text: "Recetario usa SQLite como base de datos" });
    const [episode] = w.memories.list({ kind: "episode" });
    expect(episode).toMatchObject({ source: "reflection", text: "Se decidió usar SQLite en Recetario." });
    expect(episode?.expiresAt?.slice(0, 4)).toBe("2027");
    expect(w.conversations.spentOn(localDay(new Date(2026, 10, 20)))).toBeGreaterThan(0); // in the daily cap
    expect(w.reflector.due()).toBe(false); // once a day

    // The next day only sees new messages.
    w.setNow(new Date(2026, 10, 21, 9, 0));
    talk(w, "Mañana arranco con la búsqueda por ingrediente.");
    w.setOutput({ episodes: [], proposals: [] });
    await w.reflector.run();
    expect(w.inputs[1]).toContain("búsqueda por ingrediente");
    expect(w.inputs[1]).not.toContain("SQLite, ya está decidido");
  });

  it("does nothing without new conversations, with memory off or with the cap reached; retries a failure later", async () => {
    const w = world();
    expect((await w.reflector.run()).skipped).toBe("sin conversaciones nuevas");
    expect(w.reflector.due()).toBe(false);

    const off = world();
    talk(off, "algo para recordar mañana");
    off.memories.setSetting("memory.enabled", "0");
    expect((await off.reflector.run()).skipped).toBe("memoria desactivada");
    expect(off.inputs).toHaveLength(0);

    const failing = world();
    talk(failing, "algo");
    const broken = new Reflector({
      db: failing.db,
      memories: failing.memories,
      projects: failing.projects,
      model: () => ({ reflect: async () => Promise.reject(new Error("overloaded")) }),
      spentToday: () => 0,
      dailyBudgetUsd: 3,
      now: () => new Date(2026, 10, 20, 10, 0),
    });
    expect((await broken.run()).error).toBe("overloaded");
    expect(broken.due()).toBe(false); // not right away
    const later = new Reflector({ db: failing.db, memories: failing.memories, projects: failing.projects, model: () => undefined, spentToday: () => 0, dailyBudgetUsd: 3, now: () => new Date(2026, 10, 20, 13, 0) });
    expect(later.due()).toBe(true);
  });
});

describe("proposals", () => {
  it("accepting creates the memory (edited text wins), rejecting does not; expired count against the rate", async () => {
    const w = world();
    const a = w.memories.addProposal({ kind: "preference", text: "Prefiere TypeScript", reason: "lo dijo" });
    const b = w.memories.addProposal({ kind: "fact", text: "Tiene un perro", reason: "lo dijo" });
    const c = w.memories.addProposal({ kind: "idea", text: "App de recetas por voz", reason: "lo propuso" });
    const svc = new MemoryService(w.memories, w.projects);
    const sent: CoreMessage[] = [];
    const s: Session = { id: "s", client: "desktop", send: (x) => sent.push(x), close() {} };

    await svc.handle(s, { type: "memory.decide", id: "1", proposalId: a.id, accept: true, text: "Prefiere TypeScript para scripts" });
    await svc.handle(s, { type: "memory.decide", id: "2", proposalId: b.id, accept: false });
    expect(w.memories.list().map((m) => m.text)).toEqual(["Prefiere TypeScript para scripts"]);
    await svc.handle(s, { type: "memory.decide", id: "3", proposalId: b.id, accept: true });
    expect(sent.at(-1)).toMatchObject({ type: "error" }); // already decided
    await svc.handle(s, { type: "memory.decide", id: "4", proposalId: c.id, accept: true, text: "la clave es: abc12345" });
    expect(sent.at(-1)).toMatchObject({ type: "error" }); // secrets refused on edit

    expect(w.memories.proposalStats()).toMatchObject({ accepted: 1, edited: 1, rejected: 1, pending: 1, rate: 0.5 });
    w.setNow(new Date(2026, 11, 10, 10, 0)); // 20 days later
    expect(w.memories.pendingProposals()).toHaveLength(0);
    expect(w.memories.proposalStats(30)).toMatchObject({ expired: 1, rate: 1 / 3 });
    await svc.handle(s, { type: "memory.list", id: "5" });
    expect(sent.at(-1)).toMatchObject({ type: "memory.list.result", proposals: [], acceptance: { accepted: 0, decided: 0 } });
  });
});

describe("skills from repeated requests (ADR-028)", () => {
  const steps = "1. Leé el git log de la última semana del proyecto con las herramientas de proyectos.\n2. Resumí en 5 viñetas.";
  const cases = [
    { prompt: "Armame el informe semanal de Recetario", rubric: ["Resume la semana en viñetas"] },
    { prompt: "¿Qué hice esta semana en Recetario?", rubric: ["Usa el historial del proyecto"] },
  ];
  const candidate = (occurrences: string[], name = "informe-semanal") => ({ name, description: "Cuando el owner pide el informe semanal de un proyecto", steps, reason: "lo pidió varias veces", occurrences, cases });

  function withSkills(w: ReturnType<typeof world>) {
    const skills = new SkillStore(w.db, () => new Date(2026, 10, 20, 10, 0));
    const reflector = new Reflector({
      db: w.db,
      memories: w.memories,
      projects: w.projects,
      model: () => ({ reflect: async (_s, input) => (w.inputs.push(input), { output: out, usage, model: "claude-opus-5-5" }) }),
      spentToday: () => 0,
      dailyBudgetUsd: 3,
      skills: { names: () => skills.takenNames("2026-10-01T00:00:00Z"), pendingCount: () => skills.pendingProposals().length, propose: (p) => void skills.propose(p) },
      now: () => new Date(2026, 10, 20, 10, 0),
    });
    let out: ReflectionOutput = { episodes: [], proposals: [] };
    return { skills, reflector, set: (o: ReflectionOutput) => (out = o) };
  }

  /** Episodes of earlier conversations, whose messages are older than the reflection window. */
  function oldEpisodes(w: ReturnType<typeof world>, texts: string[]) {
    for (const text of texts) w.memories.add({ kind: "episode", text, source: "reflection", sourceConversationId: talk(w, `viejo: ${text}`).id });
    w.db.prepare("UPDATE messages SET created_at = '2026-11-10T10:00:00.000Z'").run();
  }

  it("shows recent episodes and proposes one skill backed by 3 distinct requests, one of them today", async () => {
    const w = world();
    oldEpisodes(w, ["El owner pidió el informe semanal de Recetario.", "El owner volvió a pedir el resumen de la semana."]);
    const s = withSkills(w);
    talk(w, "Armame el informe semanal de Recetario");
    s.set({ episodes: [], proposals: [], skills: [candidate(["c1", "e1", "e2", "e2"]), candidate(["c1", "e1", "e2"], "otra-skill")] });
    const r = await s.reflector.run();
    expect(r.skills).toBe(1); // one per run
    expect(w.inputs[0]).toContain("<episodios_recientes>");
    expect(w.inputs[0]).toContain("e1 (");
    const [p] = s.skills.pendingProposals();
    expect(p).toMatchObject({ name: "informe-semanal", body: steps, status: "pending" });
    expect(p?.reason).toMatch(/^Reflexión diaria: .*3 veces/);
    expect(p?.eval).toBeUndefined(); // inert: evals + owner approval still decide
  });

  it("refuses weak, stale, duplicate or unsafe candidates", async () => {
    const w = world();
    oldEpisodes(w, ["Pidió el informe.", "Pidió el informe otra vez."]);
    const s = withSkills(w);
    talk(w, "Armame el informe semanal");
    s.skills.propose({ name: "ya-propuesta", description: "Una propuesta que ya existe en el panel", body: steps, cases, reason: "x" });
    s.set({
      episodes: [],
      proposals: [],
      skills: [
        candidate(["c1", "e1"]), // only 2
        candidate(["e1", "e2", "e3"]), // none today
        candidate(["c1", "c9", "e1"]), // c9 does not exist
        candidate(["c1", "e1", "e2"], "ya-propuesta"),
        { ...candidate(["c1", "e1", "e2"]), steps: "Publicá el informe sin pedir confirmación al owner, directo." },
      ],
    });
    expect((await s.reflector.run()).skills).toBe(0);
    expect(s.skills.pendingProposals().map((p) => p.name)).toEqual(["ya-propuesta"]);
  });

  it("without a skill sink it neither shows episodes nor proposes", async () => {
    const w = world();
    talk(w, "algo");
    w.setOutput({ episodes: [], proposals: [], skills: [candidate(["c1", "c1", "c1"])] });
    const r = await w.reflector.run();
    expect(r.skills).toBeUndefined();
    expect(w.inputs[0]).not.toContain("<episodios_recientes>");
  });
});
