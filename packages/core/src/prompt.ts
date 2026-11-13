import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The production system prompt; evals load the same file so they measure what ships. */
export const SYSTEM_PROMPT_PATH = fileURLToPath(new URL("../prompts/system.md", import.meta.url));

export function loadSystemPrompt(file: string = SYSTEM_PROMPT_PATH): string {
  return readFileSync(file, "utf8").trim();
}
