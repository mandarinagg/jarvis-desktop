import type { CoreMessage } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { localDay, openDatabase } from "../db.js";
import { ProjectStore } from "../projects/store.js";
import type { Session } from "../server.js";
import { ConversationStore } from "../store.js";
import { type ReflectionModel, type ReflectionOutput, Reflector } from "./reflection.js";
import { MemoryService } from "./service.js";
import { MemoryStore } from "./store.js";

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
