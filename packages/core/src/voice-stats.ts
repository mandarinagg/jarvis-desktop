#!/usr/bin/env node
/**
 * Voice latency report for the Phase 2 exit criterion (p50 voice -> first audio < 2.0 s):
 *   node packages/core/dist/voice-stats.js [lastN]
 */
import path from "node:path";
import { openDatabase } from "./db.js";
import { jarvisHome } from "./paths.js";
import { type LatencySummary, VoiceMetricsStore } from "./voice/metrics.js";

const GOAL_MS = 2_000;

const ms = (v: number | undefined) => (v === undefined ? "—" : `${Math.round(v)} ms`);
const row = (label: string, s: LatencySummary) => `${label.padEnd(22)} ${String(s.turns).padStart(5)}   p50 ${ms(s.p50).padStart(8)}   p95 ${ms(s.p95).padStart(8)}`;

const limit = Number(process.argv[2] ?? 200);
const db = openDatabase(path.join(jarvisHome(), "jarvis.db"));
const store = new VoiceMetricsStore(db);
const s = store.stats(Number.isFinite(limit) && limit > 0 ? limit : 200);
const wake = store.wakeDays(14);
db.close();

process.stdout.write(
  [
    `Últimos ${limit} turnos de voz`,
    row("Voz -> primer audio", s.firstAudio),
    row("STT", s.stt),
    row("Claude (primer token)", s.ttft),
    row("Barge-in (corte)", s.bargeIn),
    `Resultados: ${Object.entries(s.outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    s.firstAudio.p50 === undefined
      ? "Todavía no hay turnos medidos."
      : s.firstAudio.p50 < GOAL_MS
        ? `OK: p50 ${ms(s.firstAudio.p50)} < ${GOAL_MS} ms (criterio de salida de la Fase 2).`
        : `FALTA: p50 ${ms(s.firstAudio.p50)} >= ${GOAL_MS} ms.`,
    "",
    "Palabra de activación (últimos 14 días; «sin uso» = activaciones sin pedido: el estimado de falsas)",
    ...(wake.length ? wake.map((d) => `  ${d.day}   ${String(d.activations).padStart(3)} activaciones   ${String(d.unused).padStart(3)} sin uso`) : ["  Sin activaciones registradas."]),
    wake.length && wake.every((d) => d.unused < 1) ? "OK: < 1 activación falsa por día (criterio de salida de la Fase 4)." : wake.length ? "Revisar: hubo días con activaciones sin uso. Subí JARVIS_WAKE_THRESHOLD si son falsas." : "",
    "",
  ].join("\n"),
);
