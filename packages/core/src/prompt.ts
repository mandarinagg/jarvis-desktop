import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The production system prompt; evals load the same file so they measure what ships. */
export const SYSTEM_PROMPT_PATH = fileURLToPath(new URL("../prompts/system.md", import.meta.url));

export function loadSystemPrompt(file: string = SYSTEM_PROMPT_PATH): string {
  return readFileSync(file, "utf8").trim();
}

/** Appended to the system prompt on spoken turns: short, no markdown, written to be heard. */
export const VOICE_PROMPT_PATH = fileURLToPath(new URL("../prompts/voice.md", import.meta.url));

export function loadVoicePrompt(file: string = VOICE_PROMPT_PATH): string {
  return readFileSync(file, "utf8").trim();
}

/** Thinking modes (Phase 6): appended while a conversation is in that mode. */
export function loadModePrompts(): Record<"sparring" | "brainstorm" | "abogado", string> {
  const read = (m: string) => readFileSync(fileURLToPath(new URL(`../prompts/modes/${m}.md`, import.meta.url)), "utf8").trim();
  return { sparring: read("sparring"), brainstorm: read("brainstorm"), abogado: read("abogado") };
}
