import type { CoreMessage } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { type State, budgetLevel, initialState, pttPressed, reduce, voiceLabel } from "./state.js";

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function streamTurn(state: State = initialState): State {
  let s = reduce(state, { kind: "send", requestId: "r1", text: "hola" });
  s = reduce(s, { kind: "core", message: { type: "chat.started", id: "r1", turnId: "t1", conversationId: "c1" } });
  s = reduce(s, { kind: "core", message: { type: "chat.delta", turnId: "t1", text: "Ho" } });
  return reduce(s, { kind: "core", message: { type: "chat.delta", turnId: "t1", text: "la" } });
}

describe("reduce", () => {
  it("streams a reply into a pending assistant message", () => {
    const s = streamTurn();
    expect(s.activeId).toBe("c1");
    expect(s.messages).toEqual([
      { role: "user", content: "hola", interrupted: false, pending: false },
      { role: "assistant", content: "Hola", interrupted: false, pending: true },
    ]);
  });

  it("finishes the turn and adds its cost to today's spend", () => {
    let s = reduce(initialState, { kind: "core", message: { type: "budget.status", id: "b", spentTodayUsd: 1, dailyBudgetUsd: 3 } });
    s = streamTurn(s);
    s = reduce(s, { kind: "core", message: { type: "chat.done", turnId: "t1", stopReason: "end_turn", usage, costUsd: 0.25 } });
    expect(s.streaming).toBeUndefined();
    expect(s.messages.at(-1)?.pending).toBe(false);
    expect(s.budget?.spentTodayUsd).toBeCloseTo(1.25);
    expect(s.lastTurnCostUsd).toBe(0.25);
  });

  it("marks a cancelled reply as interrupted and keeps what was said", () => {
    const s = reduce(streamTurn(), { kind: "core", message: { type: "error", id: "r1", code: "cancelled", message: "x" } });
    expect(s.messages.at(-1)).toMatchObject({ content: "Hola", interrupted: true, pending: false });
    expect(s.error).toBeUndefined();
  });

  it("on failure drops the empty placeholder, keeps the question and shows the error", () => {
    let s = reduce(initialState, { kind: "send", requestId: "r1", text: "hola" });
    s = reduce(s, { kind: "core", message: { type: "error", id: "r1", code: "budget_exceeded", message: "Tope alcanzado" } });
    expect(s.messages).toEqual([{ role: "user", content: "hola", interrupted: false, pending: false }]);
    expect(s.error).toBe("Tope alcanzado");
  });

  it("ignores deltas from other turns", () => {
    const s = reduce(streamTurn(), { kind: "core", message: { type: "chat.delta", turnId: "other", text: "!!" } });
    expect(s.messages.at(-1)?.content).toBe("Hola");
  });

  it("loads history only for the selected conversation and not mid-stream", () => {
    let s = reduce(initialState, { kind: "select", conversationId: "c9" });
    const history = {
      type: "conversations.history" as const,
      id: "h",
      conversationId: "c9",
      title: "t",
      messages: [{ role: "user" as const, content: "viejo", interrupted: false, createdAt: "x" }],
    };
    s = reduce(s, { kind: "core", message: history });
    expect(s.messages.map((m) => m.content)).toEqual(["viejo"]);
    s = reduce(s, { kind: "core", message: { ...history, conversationId: "other" } });
    expect(s.messages.map((m) => m.content)).toEqual(["viejo"]);
  });

  it("new conversation clears the transcript", () => {
    const s = reduce(streamTurn(), { kind: "new" });
    expect(s.activeId).toBeUndefined();
    expect(s.messages).toEqual([]);
  });
});

describe("budgetLevel", () => {
  it("warns at 80% and flags the cap", () => {
    expect(budgetLevel({ spentTodayUsd: 1, dailyBudgetUsd: 3 })).toBe("ok");
    expect(budgetLevel({ spentTodayUsd: 2.4, dailyBudgetUsd: 3 })).toBe("warn");
    expect(budgetLevel({ spentTodayUsd: 3, dailyBudgetUsd: 3 })).toBe("over");
  });
});

describe("voice", () => {
  const core = (s: State, message: CoreMessage) => reduce(s, { kind: "core", message });

  it("tracks the voice state and the microphone indicator", () => {
    const s = core(initialState, { type: "voice.state", state: "listening", micOpen: true });
    expect(s.voice).toEqual({ state: "listening", micOpen: true });
    expect(core(s, { type: "voice.state", state: "idle", micOpen: false, detail: "sin micrófono" }).voice.detail).toBe("sin micrófono");
  });

  it("the shortcut toggles listening and interrupts otherwise", () => {
    expect(pttPressed({ state: "idle", micOpen: false })).toBe(true);
    expect(pttPressed({ state: "listening", micOpen: true })).toBe(false);
    expect(pttPressed({ state: "speaking", micOpen: false })).toBe(true);
    expect(voiceLabel({ state: "speaking", micOpen: false })).toBe("Hablando");
    expect(voiceLabel({ state: "speaking", micOpen: true })).toBe("Hablando · te escucho");
    expect(voiceLabel({ state: "listening", micOpen: true })).toBe("Micrófono abierto");
    expect(voiceLabel({ state: "idle", micOpen: false, wake: true })).toBe("Atento a «Hey Jarvis»");
    expect(voiceLabel({ state: "thinking", micOpen: false, wake: true })).toBe("Pensando");
  });

  it("shows a spoken turn as a user message and streams the reply", () => {
    let s = core({ ...initialState, activeId: "c1" }, { type: "voice.transcript", utteranceId: "u1", text: "¿Qué tengo hoy?" });
    expect(s.streaming).toEqual({ requestId: "voice:u1", voice: true });
    s = core(s, { type: "chat.started", id: "core-req", turnId: "t9", conversationId: "c1" });
    s = core(s, { type: "chat.delta", turnId: "t9", text: "Nada." });
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "¿Qué tengo hoy?"],
      ["assistant", "Nada."],
    ]);
    s = core(s, { type: "chat.done", turnId: "t9", stopReason: "end_turn", usage, costUsd: 0.01 });
    expect(s.streaming).toBeUndefined();
  });

  it("switches to the conversation the voice turn went to", () => {
    let s: State = { ...initialState, activeId: "old", messages: [{ role: "user", content: "viejo", interrupted: false, pending: false }] };
    s = core(s, { type: "voice.transcript", utteranceId: "u1", text: "nuevo" });
    s = core(s, { type: "chat.started", id: "r", turnId: "t", conversationId: "new" });
    expect(s.activeId).toBe("new");
    expect(s.messages.map((m) => m.content)).toEqual(["nuevo", ""]);
  });

  it("an error before the voice turn starts is shown and clears the placeholder", () => {
    let s = core(initialState, { type: "voice.transcript", utteranceId: "u1", text: "hola" });
    s = core(s, { type: "error", id: "core-req", code: "upstream_error", message: "No hay API key" });
    expect(s.streaming).toBeUndefined();
    expect(s.error).toBe("No hay API key");
    expect(s.messages.map((m) => m.content)).toEqual(["hola"]);
  });

  it("a barge-in marks the spoken reply as cut", () => {
    let s = core(initialState, { type: "voice.transcript", utteranceId: "u1", text: "hola" });
    s = core(s, { type: "chat.started", id: "r", turnId: "t", conversationId: "c" });
    s = core(s, { type: "chat.delta", turnId: "t", text: "Te cuento" });
    s = core(s, { type: "error", id: "r", code: "cancelled", message: "respuesta cancelada" });
    expect(s.messages.at(-1)).toMatchObject({ content: "Te cuento", interrupted: true, pending: false });
  });

  it("ignores a transcript while a typed turn is streaming", () => {
    const s = streamTurn();
    expect(core(s, { type: "voice.transcript", utteranceId: "u1", text: "x" })).toBe(s);
  });
});

describe("projects", () => {
  const project = { id: "p1", name: "Pagos", description: "", goals: "", root: "C:\\dev\\pagos", indexedAt: null, files: 3, indexing: false };
  const conv = (projectId?: string) => ({ id: "c1", title: "t", updatedAt: "2026-11-19T10:00:00Z", ...(projectId ? { projectId } : {}) });

  it("follows the active conversation's project and forgets deleted projects", () => {
    let s = reduce(initialState, { kind: "core", message: { type: "projects.list.result", projects: [project] } });
    s = reduce(s, { kind: "core", message: { type: "conversations.list.result", id: "l", conversations: [conv("p1")] } });
    s = reduce(s, { kind: "select", conversationId: "c1" });
    expect(s.projectId).toBe("p1");
    s = reduce(s, { kind: "core", message: { type: "conversations.list.result", id: "l", conversations: [conv()] } });
    expect(s.projectId).toBeUndefined();
    s = reduce(s, { kind: "setProject", projectId: "p1" });
    s = reduce(s, { kind: "new" });
    expect(s.projectId).toBe("p1");
    s = reduce(s, { kind: "core", message: { type: "projects.list.result", projects: [] } });
    expect(s.projectId).toBeUndefined();
  });

  it("shows tool activity on the reply being written", () => {
    let s = reduce(initialState, { kind: "send", requestId: "r", text: "¿dónde está?" });
    s = reduce(s, { kind: "core", message: { type: "chat.started", id: "r", turnId: "t", conversationId: "c" } });
    const tool = { type: "chat.tool", turnId: "t", tool: "projects__search", summary: "Buscando «pagos»" } as const;
    s = reduce(s, { kind: "core", message: { ...tool, status: "started" } });
    s = reduce(s, { kind: "core", message: { ...tool, status: "done" } });
    s = reduce(s, { kind: "core", message: { ...tool, summary: "Leyendo Pagos/README.md", status: "started" } });
    s = reduce(s, { kind: "core", message: { ...tool, summary: "Otro turno", turnId: "x", status: "started" } });
    expect(s.messages.at(-1)?.tools).toEqual([
      { summary: "Buscando «pagos»", status: "done" },
      { summary: "Leyendo Pagos/README.md", status: "started" },
    ]);
  });
});
