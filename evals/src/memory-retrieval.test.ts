import { describe, expect, it } from "vitest";
import { QUERIES, runRetrievalEval } from "./memory-retrieval.js";

describe("memory retrieval evals (Phase 6 exit, offline)", () => {
  it("retrieves the needed memory for every query, never disabled or expired ones", () => {
    const { results, score } = runRetrievalEval();
    const failed = results.filter((r) => !r.hit).map((r) => `${r.text} → faltó ${r.missing.join(",")} sobró ${r.leaked.join(",")} (vino: ${r.got.join(",")})`);
    expect(failed).toEqual([]);
    expect(score).toBe(1);
    expect(results).toHaveLength(QUERIES.length);
  });
});
