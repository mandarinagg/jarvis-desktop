#!/usr/bin/env node
/**
 * Jarvis Core daemon entry point (ADR-001 / ADR-008).
 * Owns the per-user named pipe (single instance), the SQLite database and the Claude adapter.
 */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatService } from "./chat.js";
import { AnthropicChatModel, type ChatModel, type Effort } from "./claude/model.js";
import { openDatabase } from "./db.js";
import { createLogger } from "./log.js";
import { defaultPipeName, jarvisHome, tokenPath } from "./paths.js";
import { KeyringSecretStore } from "./secrets.js";
import { AlreadyRunningError, CoreServer } from "./server.js";
import { ConversationStore } from "./store.js";
import { newSessionToken, writeSessionToken } from "./token.js";

export const CORE_VERSION = "0.1.0";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

function loadSystemPrompt(): string {
  return readFileSync(fileURLToPath(new URL("../prompts/system.md", import.meta.url)), "utf8").trim();
}

/** Key from Credential Manager; ANTHROPIC_API_KEY only as a dev fallback (.env is never committed). */
function modelResolver(env: NodeJS.ProcessEnv): () => ChatModel | undefined {
  const secrets = new KeyringSecretStore();
  const effort = EFFORTS.find((e) => e === env.JARVIS_EFFORT) ?? "low";
  let cached: { key: string; model: ChatModel } | undefined;
  return () => {
    const key = secrets.get("anthropic-api-key") ?? env.ANTHROPIC_API_KEY;
    if (!key) return undefined;
    if (cached?.key !== key) {
      cached = { key, model: new AnthropicChatModel({ apiKey: key, model: env.JARVIS_DEFAULT_MODEL || "claude-opus-5-5", effort }) };
    }
    return cached.model;
  };
}

async function main(): Promise<number> {
  const env = process.env;
  const logger = createLogger();
  const home = jarvisHome(env);
  const pipe = env.JARVIS_PIPE ?? defaultPipeName();
  const token = newSessionToken();
  const budget = Number(env.JARVIS_DAILY_BUDGET_USD || 3);

  const db = openDatabase(path.join(home, "jarvis.db"));
  const chat = new ChatService({
    store: new ConversationStore(db),
    model: modelResolver(env),
    systemPrompt: loadSystemPrompt(),
    dailyBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 3,
    logger,
  });

  const stop = async (reason: string) => {
    logger.log("info", "core.stopping", { reason });
    chat.cancelAll();
    await server.close();
    db.close();
    await rm(tokenPath(home), { force: true });
    process.exit(0);
  };

  const server: CoreServer = new CoreServer({
    pipe,
    token,
    coreVersion: CORE_VERSION,
    logger,
    handlers: {
      chatSend: (s, m) => chat.chatSend(s, m),
      chatCancel: (s, m) => chat.chatCancel(s, m),
      disconnected: (s) => chat.disconnected(s),
      shutdown: () => stop("core.shutdown"),
    },
  });
  try {
    await server.listen();
  } catch (err) {
    db.close();
    if (err instanceof AlreadyRunningError) {
      logger.log("warn", "core.already_running", { pipe });
      return 1;
    }
    throw err;
  }
  // The token is written only after we own the pipe, so a second instance never overwrites it.
  await writeSessionToken(tokenPath(home), token);
  logger.log("info", "core.ready", { pipe, version: CORE_VERSION, dailyBudgetUsd: budget });

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
