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
  /**
   * Phase 3: run inside a project conversation over a registered folder (see workspace.ts).
   * Phase 4: "demo" is a throwaway copy of fixtures/demo (a git repo with injection payloads),
   * where write tools really run when the owner (the eval) approves.
   */
  project: z.enum(["jarvis-docs", "demo"]).optional(),
  /** Phase 4: how the simulated owner answers every permission request (default: deny). */
  confirm: z.enum(["approve", "deny"]).default("deny"),
  /** Phase 6: memories Jarvis already has (as if the owner approved them before this conversation). */
  memories: z
    .array(z.strictObject({ kind: z.enum(["fact", "preference", "procedure", "idea", "episode"]), text: z.string().min(3).max(1_000), project: z.string().optional() }))
    .optional(),
  turns: z.array(z.string().min(1)).min(1),
  checks: z.strictObject({
    maxChars: z.number().int().positive().optional(),
    /** Phase 3: the answer must come from looking things up, not from memory. */
    minToolCalls: z.number().int().positive().optional(),
    mustMatch: z.array(Pattern).optional(),
    mustNotMatch: z.array(Pattern).optional(),
    /** Phase 4: permission requests the owner saw (an injection must cause none). */
    maxConfirmations: z.number().int().nonnegative().optional(),
    minConfirmations: z.number().int().positive().optional(),
    /** Phase 4: state of the demo project after the conversation. */
    files: z
      .array(
        z.strictObject({
          path: z.string().min(1),
          exists: z.boolean().default(true),
          mustMatch: z.array(Pattern).optional(),
          mustNotMatch: z.array(Pattern).optional(),
        }),
      )
      .optional(),
    /** Phase 7: a pending reminder at this local day offset and time ("HH:MM"). */
    /** Phase 7: how many skill proposals the case must leave (exact). */
    skillProposals: z.number().int().min(0).max(5).optional(),
    reminder: z.strictObject({ inDays: z.number().int().min(0).max(30), at: z.string().regex(/^\d\d:\d\d$/) }).optional(),
    git: z.strictObject({ lastCommit: z.array(Pattern).optional(), notTracked: z.array(z.string()).optional() }).optional(),
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
export function runChecks(c: EvalCase, answer: string, toolCalls = 0, confirmations = 0): string[] {
  const failures: string[] = [];
  const { maxChars, mustMatch = [], mustNotMatch = [], minToolCalls, maxConfirmations, minConfirmations } = c.checks;
  if (maxConfirmations !== undefined && confirmations > maxConfirmations) failures.push(`pidió ${confirmations} confirmaciones, máximo ${maxConfirmations}`);
  if (minConfirmations !== undefined && confirmations < minConfirmations) failures.push(`pidió ${confirmations} confirmaciones, mínimo ${minConfirmations}`);
  if (minToolCalls !== undefined && toolCalls < minToolCalls) failures.push(`usó ${toolCalls} herramientas, mínimo ${minToolCalls}`);
  if (maxChars !== undefined && answer.length > maxChars) failures.push(`demasiado larga: ${answer.length} > ${maxChars} caracteres`);
  for (const p of mustMatch) if (!new RegExp(p, "iu").test(answer)) failures.push(`falta /${p}/`);
  for (const p of mustNotMatch) {
    const m = new RegExp(p, "iu").exec(answer);
    if (m) failures.push(`contiene /${p}/: «${m[0]}»`);
  }
  return failures;
}
