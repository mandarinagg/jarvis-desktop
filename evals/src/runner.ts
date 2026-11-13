/** Runs conversation cases through the production chat model + system prompt and grades them. */
import { type ChatModel, costOf } from "@jarvis/core";
import { type EvalCase, runChecks } from "./cases.js";
import { type Judge, verdictPasses } from "./judge.js";

export interface CaseResult {
  id: string;
  category: string;
  passed: boolean;
  answer: string;
  checkFailures: string[];
  criteria: { criterion: string; met: boolean; reason: string }[];
  costUsd: number;
  error?: string;
}

export interface RunSummary {
  passed: number;
  total: number;
  score: number;
  costUsd: number;
  results: CaseResult[];
}

export const PASS_THRESHOLD = 0.8; // ROADMAP Phase 1 exit: evals >= 80%

export async function runCase(c: EvalCase, model: ChatModel, judge: Judge, systemPrompt: string): Promise<CaseResult> {
  const transcript: { role: "user" | "assistant"; content: string }[] = [];
  let costUsd = 0;
  try {
    for (const turn of c.turns) {
      transcript.push({ role: "user", content: turn });
      const r = await model.complete({
        system: systemPrompt,
        messages: [...transcript],
        signal: AbortSignal.timeout(120_000),
        onText: () => {},
      });
      costUsd += costOf(r.model, r.usage);
      transcript.push({ role: "assistant", content: r.text });
    }
    const answer = transcript.at(-1)?.content ?? "";
    const checkFailures = runChecks(c, answer);
    const { verdict, usage } = await judge.grade(c, transcript);
    costUsd += costOf(judge.model, usage);
    return {
      id: c.id,
      category: c.category,
      passed: checkFailures.length === 0 && verdictPasses(c, verdict),
      answer,
      checkFailures,
      criteria: verdict.criteria,
      costUsd,
    };
  } catch (err) {
    return {
      id: c.id,
      category: c.category,
      passed: false,
      answer: transcript.at(-1)?.role === "assistant" ? (transcript.at(-1)?.content ?? "") : "",
      checkFailures: [],
      criteria: [],
      costUsd,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runAll(
  cases: EvalCase[],
  model: ChatModel,
  judge: Judge,
  systemPrompt: string,
  opts: { maxCostUsd: number; onResult?: (r: CaseResult) => void },
): Promise<RunSummary> {
  const results: CaseResult[] = [];
  let spent = 0;
  for (const c of cases) {
    if (spent >= opts.maxCostUsd) {
      results.push({ id: c.id, category: c.category, passed: false, answer: "", checkFailures: [], criteria: [], costUsd: 0, error: "omitido: se alcanzó el tope de costo de la corrida" });
      continue;
    }
    const r = await runCase(c, model, judge, systemPrompt);
    spent += r.costUsd;
    results.push(r);
    opts.onResult?.(r);
  }
  const passed = results.filter((r) => r.passed).length;
  return { passed, total: results.length, score: results.length ? passed / results.length : 0, costUsd: spent, results };
}
