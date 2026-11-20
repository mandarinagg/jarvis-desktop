#!/usr/bin/env node
/**
 * Phase 5 exit evals (ADR-023): 5 real tasks for the Builder. Spends real money.
 *   pnpm --filter @jarvis/evals builder-eval --dry-run          list tasks and estimate cost
 *   pnpm --filter @jarvis/evals builder-eval                    run the 5 tasks
 *   pnpm --filter @jarvis/evals builder-eval --task b2 --budget 1
 * Runs in temp folders; reports go to %APPDATA%/Jarvis/evals/ (outside the repo). Exit code 1 if a
 * task fails, 2 without an API key. Acceptance tests run the code the agent wrote on this machine.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { KeyringSecretStore, jarvisHome } from "@jarvis/core";
import { type BuilderEvalResult, runBuilderTask } from "./builder-eval.js";
import { BUILDER_TASKS } from "./builder-tasks.js";

const out = (s: string) => process.stdout.write(s + "\n");

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      task: { type: "string" },
      budget: { type: "string", default: "1.5" },
      "max-cost": { type: "string", default: "8" },
    },
  });
  const tasks = values.task ? BUILDER_TASKS.filter((t) => t.id.startsWith(values.task ?? "")) : BUILDER_TASKS;
  const budget = Number(values.budget);
  const maxCost = Number(values["max-cost"]);
  out(`${tasks.length} tareas del Builder, tope de US$ ${budget.toFixed(2)} cada una (estimado ~US$ 0.50–1.00 por tarea).`);
  for (const t of tasks) out(`  ${t.id}: ${t.task.slice(0, 100)}…`);
  if (values["dry-run"]) return 0;

  const apiKey = new KeyringSecretStore().get("anthropic-api-key") ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write("Falta la API key. Guardala con: node packages/core/dist/set-secret.js anthropic-api-key\n");
    return 2;
  }
  const results: BuilderEvalResult[] = [];
  let spent = 0;
  for (const t of tasks) {
    if (spent + budget > maxCost) {
      out(`Corto acá: el próximo podría pasar el tope total de US$ ${maxCost.toFixed(2)} (gastado US$ ${spent.toFixed(2)}).`);
      break;
    }
    const r = await runBuilderTask(t, { apiKey, budgetUsd: budget });
    spent += r.costUsd;
    results.push(r);
    out(`${r.passed ? "✓" : "✗"} ${r.id}  (US$ ${r.costUsd.toFixed(2)}, ${r.filesChanged} archivos, ${r.allowed} acciones, ${r.denied.length} rechazadas)`);
    for (const f of r.failures) out(`    ${f}`);
    for (const d of r.denied.slice(0, 5)) out(`    rechazado: ${d}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const outsideTouched = results.filter((r) => r.failures.some((f) => /fuera del workspace|carpeta de Jarvis|carpeta del owner cambió|\.env/.test(f))).length;
  out(`\n${passed}/${results.length} tareas OK. Costo total: US$ ${spent.toFixed(2)}. Tareas que tocaron algo fuera del workspace: ${outsideTouched}.`);
  const dir = path.join(jarvisHome(), "evals");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `builder-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ results, spentUsd: spent }, null, 2));
  out(`Reporte: ${file}`);
  const exitOk = passed === BUILDER_TASKS.length && outsideTouched === 0;
  out(exitOk ? "OK: salida de la Fase 5 (5 tareas con diff aprobado, nada fuera del workspace)." : "Todavía no se cumple la salida de la Fase 5.");
  return results.length === passed && outsideTouched === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
