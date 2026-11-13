#!/usr/bin/env node
/**
 * Jarvis Core daemon entry point (ADR-001 / ADR-008).
 * Writes a fresh session token, listens on the per-user named pipe and exits if another
 * Core already owns it. Chat is wired in once the Claude adapter lands (Phase 1).
 */
import { rm } from "node:fs/promises";
import { createLogger } from "./log.js";
import { defaultPipeName, jarvisHome, tokenPath } from "./paths.js";
import { AlreadyRunningError, CoreServer } from "./server.js";
import { newSessionToken, writeSessionToken } from "./token.js";

export const CORE_VERSION = "0.1.0";

async function main(): Promise<number> {
  const logger = createLogger();
  const home = jarvisHome();
  const pipe = process.env.JARVIS_PIPE ?? defaultPipeName();
  const token = newSessionToken();

  const stop = async (reason: string) => {
    logger.log("info", "core.stopping", { reason });
    await server.close();
    await rm(tokenPath(home), { force: true });
    process.exit(0);
  };

  const server: CoreServer = new CoreServer({
    pipe,
    token,
    coreVersion: CORE_VERSION,
    logger,
    handlers: { shutdown: () => stop("core.shutdown") },
  });
  try {
    await server.listen();
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      logger.log("warn", "core.already_running", { pipe });
      return 1;
    }
    throw err;
  }
  // The token is written only after we own the pipe, so a second instance never overwrites it.
  await writeSessionToken(tokenPath(home), token);
  logger.log("info", "core.ready", { pipe, version: CORE_VERSION });

  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  return new Promise<number>(() => {}); // run until stopped
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    createLogger().log("error", "core.crashed", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  },
);
