/**
 * Connects the desktop app to Jarvis Core, starting the Core if it is not running (ADR-008).
 * The Core runs on Electron's own Node (ELECTRON_RUN_AS_NODE), detached: closing the UI keeps it alive.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CoreClient } from "@jarvis/core/client";
import { defaultPipeName, jarvisHome, tokenPath } from "@jarvis/core/paths";
import { readSessionToken } from "@jarvis/core/token";

async function tryConnect(pipe: string): Promise<CoreClient | undefined> {
  try {
    const token = await readSessionToken(tokenPath(jarvisHome()));
    return await CoreClient.connect({ pipe, token, client: "desktop", timeoutMs: 2_000 });
  } catch {
    return undefined;
  }
}

function startCore(): void {
  const coreMain = fileURLToPath(import.meta.resolve("@jarvis/core/main"));
  const child = spawn(process.execPath, [coreMain], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function ensureCore(timeoutMs = 10_000): Promise<CoreClient> {
  const pipe = process.env.JARVIS_PIPE ?? defaultPipeName();
  const existing = await tryConnect(pipe);
  if (existing) return existing;
  startCore();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    const client = await tryConnect(pipe);
    if (client) return client;
  }
  throw new Error("No se pudo iniciar Jarvis Core.");
}
