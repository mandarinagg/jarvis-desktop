#!/usr/bin/env node
/**
 * Jarvis Core daemon entry point (ADR-001 / ADR-008).
 * Owns the per-user named pipe (single instance), the SQLite database and the Claude adapter.
 */
import { rm } from "node:fs/promises";
import type { CoreMessage, TtsConfig } from "@jarvis/shared";
import path from "node:path";
import { ChatService } from "./chat.js";
import { AnthropicChatModel, type ChatModel, type Effort } from "./claude/model.js";
import { openDatabase } from "./db.js";
import { createLogger } from "./log.js";
import { defaultPipeName, jarvisHome, tokenPath } from "./paths.js";
import { ProjectIndex } from "./projects/indexer.js";
import { ProjectStore } from "./projects/store.js";
import { loadSystemPrompt, loadVoicePrompt } from "./prompt.js";
import { KeyringSecretStore } from "./secrets.js";
import { AlreadyRunningError, CoreServer } from "./server.js";
import { ConversationStore } from "./store.js";
import { newSessionToken, writeSessionToken } from "./token.js";
import { VoiceMetricsStore } from "./voice/metrics.js";
import { createVoiceSpawner } from "./voice/spawn.js";
import { VoiceSupervisor } from "./voice/supervisor.js";
import { VoiceTurns } from "./voice/turns.js";

export const CORE_VERSION = "0.1.0";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

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

/** Neural2 when there is a Google key (ADR-011), otherwise the offline Piper voice. */
function ttsResolver(env: NodeJS.ProcessEnv): () => TtsConfig {
  const secrets = new KeyringSecretStore();
  return () => {
    const googleApiKey = secrets.get("google-tts-api-key") ?? env.JARVIS_GOOGLE_TTS_API_KEY;
    return googleApiKey
      ? { engine: "google", voice: env.JARVIS_TTS_VOICE || "es-US-Neural2-B", googleApiKey }
      : { engine: "piper", voice: "es_AR-daniela-high" };
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
  const store = new ConversationStore(db);
  const projects = new ProjectStore(db);
  const index = new ProjectIndex(db, projects, logger);
  const chat = new ChatService({
    store,
    model: modelResolver(env),
    systemPrompt: loadSystemPrompt(),
    voicePrompt: loadVoicePrompt(),
    dailyBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 3,
    logger,
  });

  // The server is created below; voice events only flow once it is listening.
  let broadcast: (m: CoreMessage) => void = () => {};
  const turns = new VoiceTurns({
    voice: { send: (m) => voice?.send(m) ?? false },
    chat,
    broadcast: (m) => broadcast(m),
    metrics: new VoiceMetricsStore(db),
    markInterrupted: (turnId) => store.markInterrupted(turnId),
    logger,
    // Barge-in by voice (ADR-016) assumes headphones: with speakers Jarvis would interrupt himself.
    vadBargeIn: env.JARVIS_BARGE_IN !== "0",
  });
  // Voice is on by default (Phase 2); JARVIS_VOICE=0 keeps the Core text-only.
  const voice: VoiceSupervisor | undefined =
    env.JARVIS_VOICE === "0"
      ? undefined
      : new VoiceSupervisor({
          spawn: createVoiceSpawner(env),
          tts: ttsResolver(env),
          stt: env.JARVIS_STT !== "0",
          logger,
          onState: (state, detail) => turns.supervisorState(state, detail),
          onMessage: (m) => turns.onVoiceMessage(m),
        });

  const stop = async (reason: string) => {
    logger.log("info", "core.stopping", { reason });
    chat.cancelAll();
    index.close();
    await voice?.stop();
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
      conversationsList: (s, m) => chat.conversationsList(s, m),
      conversationsGet: (s, m) => chat.conversationsGet(s, m),
      budgetGet: (s, m) => chat.budgetGet(s, m),
      voicePtt: (s, m) => turns.ptt(s, m),
      voiceStatusGet: (s, m) => turns.statusGet(s, m),
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
  broadcast = (m) => server.broadcast(m);
  logger.log("info", "core.ready", { pipe, version: CORE_VERSION, dailyBudgetUsd: budget });
  voice?.start();
  // Phase 3: bring every registered project's index up to date, then follow changes (ADR-017).
  void (async () => {
    for (const project of projects.list()) {
      try {
        await index.scan(project);
        index.watch(project);
      } catch (err) {
        logger.log("warn", "index.startup_failed", { project: project.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  })();

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
