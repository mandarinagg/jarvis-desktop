#!/usr/bin/env node
/**
 * Memory report for the Phase 6 exit criterion (>= 70% of proposed memories accepted in 2 weeks):
 *   node packages/core/dist/memory-stats.js [days]
 */
import path from "node:path";
import { openDatabase } from "./db.js";
import { MemoryStore } from "./memory/store.js";
import { jarvisHome } from "./paths.js";

const GOAL = 0.7;
const days = Number(process.argv[2] ?? 14);
const db = openDatabase(path.join(jarvisHome(), "jarvis.db"));
const memories = new MemoryStore(db);
const s = memories.proposalStats(Number.isFinite(days) && days > 0 ? days : 14);
const counts = db.prepare("SELECT kind, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY kind").all() as { kind: string; n: number }[];
const runs = db.prepare("SELECT day, conversations, episodes, proposals, cost_usd AS cost, error FROM reflections ORDER BY ran_at DESC LIMIT 14").all() as {
  day: string;
  conversations: number;
  episodes: number;
  proposals: number;
  cost: number;
  error: string | null;
}[];
const uses = db.prepare("SELECT COUNT(DISTINCT turn_id) AS turns, COUNT(*) AS n FROM memory_uses WHERE ts >= ?").get(new Date(Date.now() - days * 86_400_000).toISOString()) as { turns: number; n: number };
db.close();

const pct = (r: number | undefined) => (r === undefined ? "—" : `${Math.round(r * 100)} %`);
process.stdout.write(
  [
    `Memoria: ${counts.map((c) => `${c.kind} ${c.n}`).join(", ") || "vacía"}${memories.enabled() ? "" : " (DESACTIVADA)"}`,
    `Propuestas de los últimos ${days} días: ${s.proposed} (aceptadas ${s.accepted}, editadas ${s.edited}, rechazadas ${s.rejected}, vencidas ${s.expired}, pendientes ${s.pending})`,
    `Tasa de aceptación: ${pct(s.rate)} (las vencidas cuentan como no aceptadas)`,
    s.rate === undefined
      ? "Todavía no hay propuestas decididas."
      : s.rate >= GOAL
        ? `OK: ${pct(s.rate)} >= 70 % (criterio de salida de la Fase 6, con 2 semanas de uso).`
        : `FALTA: ${pct(s.rate)} < 70 %. Revisá qué rechazás y ajustá REFLECTION_SYSTEM (memory/reflection.ts).`,
    `Recuerdos usados: ${uses.n} veces en ${uses.turns} turnos.`,
    "",
    "Reflexiones recientes",
    ...(runs.length
      ? runs.map((r) => `  ${r.day}  ${String(r.conversations).padStart(3)} conv  ${String(r.episodes).padStart(3)} episodios  ${String(r.proposals).padStart(3)} propuestas  US$ ${r.cost.toFixed(3)}${r.error ? `  (${r.error})` : ""}`)
      : ["  Todavía no hubo reflexiones."]),
    "",
  ].join("\n"),
);
