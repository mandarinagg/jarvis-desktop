/**
 * Minimal structured logger. Everything goes through `redact` first: the session token,
 * Anthropic/Google API keys and bearer tokens must never reach a log (Phase 1 exit criterion).
 */

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[REDACTED]"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "AIza[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\b[0-9a-f]{64}\b/g, "[REDACTED-TOKEN]"],
];

export function redact(text: string): string {
  return PATTERNS.reduce((s, [re, repl]) => s.replace(re, repl), text);
}

export type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(write: (line: string) => void = (l) => process.stderr.write(l)): Logger {
  return {
    log(level, msg, fields) {
      const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
      write(redact(line) + "\n");
    },
  };
}

export const silentLogger: Logger = { log() {} };
