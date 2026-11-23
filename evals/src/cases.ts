/** Golden conversation cases (synthetic data only) and their deterministic checks. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const CONVERSATIONS_DIR = fileURLToPath(new URL("../conversations/", import.meta.url));

/** Patterns are JavaScript regex sources, always compiled case-insensitive + Unicode. */
const Pattern = z.string().refine((p) => {
  try {
    new RegExp(p, "iu");
    return true;
  } catch {
    return false;
  }
}, "invalid regular expression");

export const EvalCase = z.strictObject({
  id: z.string().regex(/^\d{3}-[a-z0-9-]+$/),
  category: z.string().min(1),
  /** "voice": every turn arrives spoken and the reply is heard (adds prompts/voice.md, like the Core). */
  mode: z.enum(["text", "voice"]).default("text"),
  /** Phase 3: run inside a project conversation over a registered folder (see workspace.ts). */
  project: z.enum(["jarvis-docs"]).optional(),
  turns: z.array(z.string().min(1)).min(1),
  checks: z.strictObject({
    maxChars: z.number().int().positive().optional(),
    /** Phase 3: the answer must come from looking things up, not from memory. */
    minToolCalls: z.number().int().positive().optional(),
    mustMatch: z.array(Pattern).optional(),
    mustNotMatch: z.array(Pattern).optional(),
  }),
  rubric: z.array(z.string().min(1)).min(1),
});
export type EvalCase = z.infer<typeof EvalCase>;

export function loadCases(dir: string = CONVERSATIONS_DIR): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const parsed = EvalCase.safeParse(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
      if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      if (`${parsed.data.id}.json` !== f) throw new Error(`${f}: id must match the file name`);
      return parsed.data;
    });
}

/** Deterministic checks on the final answer: returns the list of failures (empty = pass). */
export function runChecks(c: EvalCase, answer: string, toolCalls = 0): string[] {
  const failures: string[] = [];
  const { maxChars, mustMatch = [], mustNotMatch = [], minToolCalls } = c.checks;
  if (minToolCalls !== undefined && toolCalls < minToolCalls) failures.push(`usó ${toolCalls} herramientas, mínimo ${minToolCalls}`);
  if (maxChars !== undefined && answer.length > maxChars) failures.push(`demasiado larga: ${answer.length} > ${maxChars} caracteres`);
  for (const p of mustMatch) if (!new RegExp(p, "iu").test(answer)) failures.push(`falta /${p}/`);
  for (const p of mustNotMatch) {
    const m = new RegExp(p, "iu").exec(answer);
    if (m) failures.push(`contiene /${p}/: «${m[0]}»`);
  }
  return failures;
}
