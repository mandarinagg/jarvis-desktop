/**
 * How the Core launches the Voice Service. `uv run python -m …` and never the uv-generated
 * `.exe` launchers, which Smart App Control blocks (ADR-009, TROUBLESHOOTING.md).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VoiceChild, VoiceSpawner } from "./supervisor.js";

/** Secrets the voice child must never inherit; it receives only what it needs over stdio. */
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "JARVIS_GOOGLE_TTS_API_KEY"];

export interface VoiceLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** services/voice relative to packages/core/{src,dist}/voice; JARVIS_VOICE_DIR overrides it. */
export function defaultVoiceDir(env: NodeJS.ProcessEnv): string {
  if (env.JARVIS_VOICE_DIR) return path.resolve(env.JARVIS_VOICE_DIR);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../services/voice");
}

export function voiceLaunch(env: NodeJS.ProcessEnv): VoiceLaunch {
  const cwd = defaultVoiceDir(env);
  // Electron launches the Core with ELECTRON_RUN_AS_NODE; it means nothing to Python.
  const dropped = new Set([...SCRUBBED_ENV, "ELECTRON_RUN_AS_NODE"]);
  const childEnv: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(env).filter(([k]) => !dropped.has(k))),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
  return {
    command: env.JARVIS_UV ?? "uv",
    args: ["run", "--project", cwd, "--locked", "python", "-m", "jarvis_voice.service"],
    cwd,
    env: childEnv,
  };
}

export function createVoiceSpawner(env: NodeJS.ProcessEnv): VoiceSpawner {
  const launch = voiceLaunch(env);
  return () =>
    spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as VoiceChild;
}
