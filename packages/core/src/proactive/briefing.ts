/**
 * The daily briefing (ADR-026): composed locally from Jarvis' own data, without calling a model.
 * Free, instant and immune to injection: no third-party text reaches it, only the owner's
 * approved reminders and ideas.
 */
import type { DatabaseSync } from "node:sqlite";
import { dashboard } from "../dashboard.js";
import type { ProactiveStore } from "./store.js";

const usd = (n: number) => `US$ ${n.toFixed(2).replace(".", ",")}`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function composeBriefing(db: DatabaseSync, store: ProactiveStore, now: Date, dailyBudgetUsd: number): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const d = dashboard(db, { dailyBudgetUsd, googleTts: false, now });
  const today = store.between(start.toISOString(), end.toISOString());
  const overdue = store.due(start.toISOString());
  const date = now.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });

  const lines = [`Buen día. Hoy es ${date}.`];
  if (today.length) lines.push(`Recordatorios de hoy: ${today.map((r) => `${hhmm(r.dueAt)} ${r.text}`).join("; ")}.`);
  else lines.push("No tenés recordatorios para hoy.");
  if (overdue.length) lines.push(`Pendientes de antes: ${overdue.map((r) => r.text).join("; ")}.`);
  const waiting = [
    d.memory.pendingProposals ? plural(d.memory.pendingProposals, "propuesta de memoria", "propuestas de memoria") : undefined,
    d.builder.review ? plural(d.builder.review, "tarea del Builder para revisar", "tareas del Builder para revisar") : undefined,
  ].filter(Boolean);
  if (waiting.length) lines.push(`Esperan tu OK: ${waiting.join(" y ")}.`);
  const inProgress = d.memory.openIdeas.filter((i) => i.status === "en_curso");
  if (inProgress.length) lines.push(`Ideas en curso: ${inProgress.map((i) => i.text.split("\n")[0]?.slice(0, 80)).join("; ")}.`);
  const yesterday = d.spend.days.at(-2);
  const spentYesterday = yesterday ? yesterday.chatUsd + yesterday.builderUsd + yesterday.reflectionUsd : 0;
  lines.push(`Ayer gastaste ${usd(spentYesterday)}; en el mes, ${usd(d.spend.monthUsd)}.`);
  return lines.join("\n");
}
