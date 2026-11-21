/**
 * Static checks on a proposed skill (ADR-027), before it is stored and again before it is
 * evaluated or approved. A skill can only describe how to use the tools Jarvis already has: it
 * must never try to skip confirmations or touch the rules that control Jarvis (EVOLUTION.md §4).
 */
import { sensitiveReason } from "../memory/retrieve.js";
import { foldText } from "../memory/store.js";
import type { SkillCase } from "./store.js";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const LIMITS = { description: 300, body: 4_000, prompt: 1_000, rubricItem: 300, minCases: 2, maxCases: 5, maxRubric: 4 } as const;

/** Instructions no skill may carry (matched on folded text: lowercase, no accents). */
const FORBIDDEN: [RegExp, string][] = [
  [/\bsin (pedir|esperar|mostrar|necesitar) (la |el |su )?(confirmacion|permiso|ok|aprobacion|dialogo)/, "saltear confirmaciones"],
  [/\bno (le )?(pidas|preguntes|muestres|esperes) (la |el |su )?(confirmacion|permiso|ok|aprobacion|dialogo)/, "saltear confirmaciones"],
  [/\b(no le (avises|cuentes|digas) al owner|ocultale|sin que (el owner )?(se entere|lo sepa|lo vea))/, "ocultarle algo al owner"],
  [/\bignora(r|) (las |tus |todas las )?(reglas|instrucciones|politicas)/, "ignorar las reglas"],
  [/permissions\.json|builder\.json|mcp-servers\.json|audit[_ ]?log|permission engine|motor de permisos/, "tocar la configuración de seguridad"],
  [/\b(desactiva|apaga|borra)(r|) (la |el )?(memoria|confirmacion|registro|auditoria|horario silencioso)/, "apagar controles"],
];

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  cases: SkillCase[];
}

/** The reason the draft is refused, or undefined when it is acceptable. */
export function skillProblem(s: SkillDraft): string | undefined {
  if (!SKILL_NAME.test(s.name)) return "el nombre tiene que ser corto, en minúsculas y con guiones (ej.: informe-semanal)";
  if (s.description.trim().length < 10 || s.description.length > LIMITS.description) return `la descripción tiene que tener entre 10 y ${LIMITS.description} caracteres`;
  if (s.body.trim().length < 20 || s.body.length > LIMITS.body) return `los pasos tienen que tener entre 20 y ${LIMITS.body} caracteres`;
  if (s.cases.length < LIMITS.minCases || s.cases.length > LIMITS.maxCases) return `hacen falta entre ${LIMITS.minCases} y ${LIMITS.maxCases} casos de prueba`;
  for (const c of s.cases) {
    if (c.prompt.trim().length < 5 || c.prompt.length > LIMITS.prompt) return "cada caso necesita un pedido de prueba de hasta 1000 caracteres";
    if (!c.rubric.length || c.rubric.length > LIMITS.maxRubric || c.rubric.some((r) => !r.trim() || r.length > LIMITS.rubricItem)) return "cada caso necesita entre 1 y 4 criterios cortos";
  }
  const all = [s.name, s.description, s.body, ...s.cases.flatMap((c) => [c.prompt, ...c.rubric])];
  for (const t of all) {
    const why = sensitiveReason(t);
    if (why) return why;
  }
  const folded = foldText([s.description, s.body].join("\n"));
  for (const [re, what] of FORBIDDEN) if (re.test(folded)) return `una skill no puede ${what}`;
  return undefined;
}

/** The skill as Jarvis reads it with use_skill, and as it is mirrored to SKILL.md. */
export function skillMarkdown(s: { name: string; description: string; body: string; version?: number }): string {
  return `---\nname: ${s.name}\ndescription: ${s.description.replace(/\n/g, " ")}\n${s.version ? `version: ${s.version}\n` : ""}---\n\n${s.body.trim()}\n`;
}
