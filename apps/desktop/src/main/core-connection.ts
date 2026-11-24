/**
 * Connects the desktop app to Jarvis Core, starting the Core if it is not running (ADR-008).
 * The Core runs on Electron's own Node (ELECTRON_RUN_AS_NODE), detached: closing the UI keeps it alive.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CoreClient } from "@jarvis/core/client";
import { defaultPipeName, isCoreStale, jarvisHome, tokenPath } from "@jarvis/core/paths";
import { readSessionToken } from "@jarvis/core/token";

async function tryConnect(pipe: string): Promise<CoreClient | undefined> {
  try {
    const token = await readSessionToken(tokenPath(jarvisHome()));
    return await CoreClient.connect({ pipe, token, client: "desktop", timeoutMs: 2_000 });
  } catch {
    return undefined;
  }
}

const coreMain = () => fileURLToPath(import.meta.resolve("@jarvis/core/main"));

/** Graceful stop (closes WhatsApp and the DB cleanly); resolves when the Core hangs up or after 20 s. */
function stopCore(client: CoreClient): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 20_000);
    client.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    client.send({ type: "core.shutdown", id: "stale-core" });
  });
}

function startCore(): void {
  const child = spawn(process.execPath, [coreMain()], {
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
  // A Core from an older build keeps running across rebuilds: replace it instead of using old code.
  if (existing && isCoreStale(jarvisHome(), coreMain())) await stopCore(existing);
  else if (existing) return existing;
  startCore();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    const client = await tryConnect(pipe);
    if (client) return client;
  }
  throw new Error("No se pudo iniciar Jarvis Core.");
}
