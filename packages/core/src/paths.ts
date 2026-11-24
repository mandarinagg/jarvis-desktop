import { readFileSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Build stamp of the running Core (the mtime of its main.js when it started). The Core is a detached
 * daemon that outlives the app, so after a rebuild the app compares stamps and restarts a stale Core
 * instead of silently talking to old code (seen 2026-11-24).
 */
export function coreBuildStampPath(home: string): string {
  return path.join(runDir(home), "core.build");
}

export function buildIdOf(file: string): string {
  return String(Math.trunc(statSync(file).mtimeMs));
}

export function writeCoreBuildStamp(home: string, mainFile: string): void {
  writeFileSync(coreBuildStampPath(home), buildIdOf(mainFile), "utf8");
}

/** True when the running Core started from an older build than the one on disk. Unknown = not stale. */
export function isCoreStale(home: string, mainFile: string): boolean {
  let running: string;
  try {
    running = readFileSync(coreBuildStampPath(home), "utf8").trim();
  } catch {
    return false;
  }
  try {
    return running !== buildIdOf(mainFile);
  } catch {
    return false;
  }
}
