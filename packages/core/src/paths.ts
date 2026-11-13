import os from "node:os";
import path from "node:path";

/** Runtime data lives outside the repo (CLAUDE.md): %APPDATA%/Jarvis, overridable for dev/tests. */
export function jarvisHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JARVIS_DATA_DIR) return path.resolve(env.JARVIS_DATA_DIR);
  const base = env.APPDATA ?? path.join(os.homedir(), ".config");
  return path.join(base, "Jarvis");
}

export function runDir(home: string): string {
  return path.join(home, "run");
}

export function tokenPath(home: string): string {
  return path.join(runDir(home), "session.token");
}

/** One Core per Windows user (ADR-008). Username is sanitized: pipe names cannot contain backslashes. */
export function defaultPipeName(user: string = os.userInfo().username): string {
  const safe = user.toLowerCase().replace(/[^a-z0-9._-]/g, "_") || "user";
  return `\\\\.\\pipe\\jarvis-core-${safe}`;
}
