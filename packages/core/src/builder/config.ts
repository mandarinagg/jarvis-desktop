/**
 * Owner configuration for the Builder (ADR-023): `%APPDATA%/Jarvis/builder.json`, outside every
 * project, read at the start of each task (edits apply to the next task). Only the owner writes it:
 * no tool can, so Jarvis cannot widen its own command allowlist.
 *
 *   {
 *     "budgetUsd": 1,              // per task (max 10)
 *     "maxTurns": 60,
 *     "projects": { "Recetario": { "commands": ["node --test", "npm test"] } }
 *   }
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { type Logger, silentLogger } from "../log.js";

export const DEFAULT_BUDGET_USD = 1;
export const DEFAULT_MAX_TURNS = 60;

const Command = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\w@./:=+-]+( [\w@./:=+-]+)*$/, "un comando simple: palabras separadas por un espacio");

export const BuilderConfig = z.strictObject({
  budgetUsd: z.number().positive().max(10).default(DEFAULT_BUDGET_USD),
  maxTurns: z.number().int().min(5).max(300).default(DEFAULT_MAX_TURNS),
  projects: z.record(z.string().min(1).max(80), z.strictObject({ commands: z.array(Command).max(30).default([]) })).default({}),
});
export type BuilderConfig = z.infer<typeof BuilderConfig>;

export function loadBuilderConfig(file: string, logger: Logger = silentLogger): BuilderConfig {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return BuilderConfig.parse({});
  }
  try {
    return BuilderConfig.parse(JSON.parse(raw));
  } catch (err) {
    logger.log("warn", "builder.config_invalid", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    return BuilderConfig.parse({});
  }
}

/** Commands the owner allowed for a project (name matched case-insensitively). */
export function projectCommands(config: BuilderConfig, projectName: string): string[] {
  const key = Object.keys(config.projects).find((k) => k.toLowerCase() === projectName.toLowerCase());
  return key ? (config.projects[key]?.commands ?? []) : [];
}
