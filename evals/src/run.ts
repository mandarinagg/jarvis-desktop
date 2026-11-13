#!/usr/bin/env node
/**
 * Conversation evals CLI (CLAUDE.md: run on any change to prompts, orchestration, router or skills).
 *   pnpm --filter @jarvis/evals eval --dry-run             validate cases, estimate cost, no API calls
 *   pnpm --filter @jarvis/evals eval                       run all cases (spends real money)
 *   pnpm --filter @jarvis/evals eval --case 006 --max-cost 0.5
 * Reports go to %APPDATA%/Jarvis/evals/ (outside the repo). Exit code 1 when the score is below 80%.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { AnthropicChatModel, KeyringSecretStore, jarvisHome, loadSystemPrompt } from "@jarvis/core";
import { loadCases } from "./cases.js";
import { AnthropicJudge } from "./judge.js";
import { PASS_THRESHOLD, runAll } from "./runner.js";

const out = (s: string) => process.stdout.write(s + "\n");
const EST_COST_PER_TURN_USD = 0.02; // generation + judge, effort low (CLAUDE_API.md §4.1)

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      case: { type: "string" },
      "max-cost": { type: "string", default: "1.5" },
    },
  });
  const all = loadCases();
  const cases = values.case ? all.filter((c) => c.id.startsWith(values.case ?? "")) : all;
  const turns = cases.reduce((n, c) => n + c.turns.length, 0);
  out(`${cases.length} casos, ${turns} turnos. Costo estimado: ~US$ ${(turns * EST_COST_PER_TURN_USD).toFixed(2)}.`);
  if (values["dry-run"]) {
    out("Dry run: casos válidos, no se llamó a la API.");
    return 0;
  }

  const apiKey = new KeyringSecretStore().get("anthropic-api-key") ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write("Falta la API key. Guardala con: node packages/core/dist/set-secret.js anthropic-api-key\n");
    return 2;
  }
  const maxCostUsd = Number(values["max-cost"]);
  const model = new AnthropicChatModel({ apiKey, effort: "low" });
  const summary = await runAll(cases, model, new AnthropicJudge(apiKey), loadSystemPrompt(), {
    maxCostUsd: Number.isFinite(maxCostUsd) ? maxCostUsd : 1.5,
    onResult: (r) => {
      out(`${r.passed ? "✓" : "✗"} ${r.id}  (US$ ${r.costUsd.toFixed(4)})`);
      for (const f of r.checkFailures) out(`    chequeo: ${f}`);
      for (const c of r.criteria.filter((x) => !x.met)) out(`    criterio: ${c.criterion} → ${c.reason}`);
      if (r.error) out(`    error: ${r.error}`);
    },
  });

  const dir = path.join(jarvisHome(), "evals");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `conversations-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ model: model.model, ...summary }, null, 2), "utf8");
  out(`\n${summary.passed}/${summary.total} (${(summary.score * 100).toFixed(0)}%), costo US$ ${summary.costUsd.toFixed(3)}. Reporte: ${file}`);
  return summary.score >= PASS_THRESHOLD ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
