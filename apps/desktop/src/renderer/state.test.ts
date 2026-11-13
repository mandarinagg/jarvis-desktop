import { describe, expect, it } from "vitest";
import { type State, budgetLevel, initialState, reduce } from "./state.js";

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
