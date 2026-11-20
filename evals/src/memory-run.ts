#!/usr/bin/env node
/**
 * Phase 6 memory retrieval eval (offline, no API, ADR-024):
 *   pnpm --filter @jarvis/evals memory-eval
 * Exit code 1 if any query misses its memory or gets a disabled/expired one.
 */
import { runRetrievalEval } from "./memory-retrieval.js";

const { results, score } = runRetrievalEval();
for (const r of results) {
  process.stdout.write(`${r.hit ? "✓" : "✗"} ${r.text}\n`);
  if (!r.hit) process.stdout.write(`    faltó: ${r.missing.join(", ") || "—"}  sobró: ${r.leaked.join(", ") || "—"}  vino: ${r.got.join(", ")}\n`);
}
process.stdout.write(`\nRecuperación correcta: ${results.filter((r) => r.hit).length}/${results.length} (${Math.round(score * 100)} %).\n`);
process.exit(score === 1 ? 0 : 1);
