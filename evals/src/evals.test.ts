import type { ChatModel, ChatTurnRequest } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { type EvalCase, loadCases, runChecks } from "./cases.js";
import { type Judge, type Verdict, judgePrompt, verdictPasses } from "./judge.js";
import { runAll } from "./runner.js";

const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("conversation cases", () => {
  const cases = loadCases();

  it("has the 15 Phase 1 cases, all valid, with unique ids", () => {
    expect(cases).toHaveLength(15);
    expect(new Set(cases.map((c) => c.id)).size).toBe(15);
  });

  it("covers the behaviours Phase 1 cares about", () => {
    const categories = new Set(cases.map((c) => c.category));
    for (const c of ["personalidad", "brevedad", "honestidad", "seguridad", "criterio", "contexto"]) expect(categories).toContain(c);
  });

  it("contains no real-looking secrets", () => {
    const text = JSON.stringify(cases);
    expect(text).not.toMatch(/sk-ant-api03-[A-Za-z0-9_-]{80,}/);
    expect(text).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
  });
});

describe("runChecks", () => {
  const voseo = loadCases().find((c) => c.id === "001-saludo-voseo") as EvalCase;

  it("flags tuteo but not voseo, including accented words", () => {
    expect(runChecks(voseo, "¡Hola! Todo bien, ¿y vos? ¿En qué te puedo ayudar?")).toEqual([]);
    expect(runChecks(voseo, "Hola, ¿qué tal estás tú? ¿Qué quieres hacer?")).toHaveLength(2);
  });

  it("flags answers that are too long", () => {
    expect(runChecks(voseo, "a".repeat(401))).toEqual([expect.stringContaining("demasiado larga")]);
  });

  it("checks required matches", () => {
    const memory = loadCases().find((c) => c.id === "011-memoria-en-conversacion") as EvalCase;
    expect(runChecks(memory, "Tu proyecto se llama Atalaya y monitorea precios de cripto.")).toEqual([]);
    expect(runChecks(memory, "No me acuerdo.")).toHaveLength(1);
  });
});

describe("judge helpers", () => {
  const c = loadCases()[0] as EvalCase;

  it("wraps the conversation as data for the judge", () => {
    const p = judgePrompt(c, [{ role: "user", content: "hola" }, { role: "assistant", content: "¿Cómo andás?" }]);
    expect(p).toContain("<conversacion>");
    expect(p).toContain("1. ");
  });

  it("passes only when every criterion is graded and met", () => {
    const all = (met: boolean): Verdict => ({ criteria: c.rubric.map((r) => ({ criterion: r, met, reason: "x" })) });
    expect(verdictPasses(c, all(true))).toBe(true);
    expect(verdictPasses(c, all(false))).toBe(false);
    expect(verdictPasses(c, { criteria: [] })).toBe(false);
  });
});

describe("runAll", () => {
  const model: ChatModel = {
    model: "claude-opus-5-5",
    async complete(req: ChatTurnRequest) {
      const last = req.messages.at(-1)?.content ?? "";
      return { text: last.includes("Atalaya") ? "Anotado." : "Se llama Atalaya, un monitor de cripto.", stopReason: "end_turn", model: "claude-opus-5-5", usage };
    },
  };
  const judge = (met: boolean): Judge => ({
    model: "claude-opus-5-5",
    async grade(c) {
      return { verdict: { criteria: c.rubric.map((r) => ({ criterion: r, met, reason: "ok" })) }, usage };
    },
  });

  it("runs multi-turn cases, combines checks and verdict, and adds up cost", async () => {
    const cases = loadCases().filter((c) => c.id.startsWith("011"));
    const s = await runAll(cases, model, judge(true), "SYS", { maxCostUsd: 10 });
    expect(s).toMatchObject({ passed: 1, total: 1, score: 1 });
    expect(s.costUsd).toBeGreaterThan(0);
  });

  it("stops spending once the run cost cap is reached", async () => {
    const cases = loadCases().slice(0, 3);
    const s = await runAll(cases, model, judge(true), "SYS", { maxCostUsd: 0.000001 });
    expect(s.results.filter((r) => r.error?.includes("tope"))).toHaveLength(2);
  });
});
