#!/usr/bin/env node
/**
 * Jarvis Core daemon entry point (ADR-001 / ADR-008).
 * Owns the per-user named pipe (single instance), the SQLite database and the Claude adapter.
 */
import { unwatchFile, watchFile } from "node:fs";
import { rm } from "node:fs/promises";
import type { CoreMessage, TtsConfig } from "@jarvis/shared";
import type { Session } from "./server.js";
import path from "node:path";
import { ChatService } from "./chat.js";
import { AnthropicChatModel, type ChatModel, type Effort } from "./claude/model.js";
import { openDatabase } from "./db.js";
import { createLogger } from "./log.js";
import { defaultPipeName, jarvisHome, tokenPath } from "./paths.js";
import { projectCard } from "./projects/context.js";
import { ProjectIndex } from "./projects/indexer.js";
import { ProjectsService } from "./projects/service.js";
import { ProjectStore } from "./projects/store.js";
import { loadSystemPrompt, loadVoicePrompt } from "./prompt.js";
import { KeyringSecretStore, mcpSecret } from "./secrets.js";
import { AlreadyRunningError, CoreServer } from "./server.js";
import { ConversationStore } from "./store.js";
import { newSessionToken, writeSessionToken } from "./token.js";
import { AuditService } from "./tools/audit-service.js";
import { ConfirmationBroker } from "./tools/confirm.js";
import { connectExternalServers, loadExternalServers } from "./tools/external.js";
import { ToolHub } from "./tools/hub.js";
import { JARVIS_SERVER, JARVIS_TOOLS, createJarvisServer } from "./tools/jarvis-server.js";
import { AuditLog, PermissionEngine, loadRules } from "./tools/permissions.js";
import { PROJECTS_SERVER, PROJECTS_TOOLS, createProjectsServer, projectsPreviews } from "./tools/projects-server.js";
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
  // Tools (ADR-003, ADR-017, ADR-018): model -> Permission Engine -> (owner confirmation) -> MCP server -> Audit Log.
  // Owner rules live in the Jarvis folder, which no project and no tool can reach; edits apply live.
  const rulesFile = path.join(home, "permissions.json");
  const permissions = new PermissionEngine(loadRules(rulesFile, logger));
  watchFile(rulesFile, { interval: 2_000 }, () => permissions.setRules(loadRules(rulesFile, logger)));
  const audit = new AuditLog(db);
  let sessions: () => Session[] = () => [];
  const confirmations = new ConfirmationBroker({ sessions: () => sessions(), logger });
  const tools = new ToolHub(permissions, audit, logger, confirmations);
  const projectsDeps = { projects, index, trashDir: path.join(home, "trash") };
  await tools.addInProcess(PROJECTS_SERVER, createProjectsServer(projectsDeps), PROJECTS_TOOLS, projectsPreviews(projectsDeps));
  await tools.addInProcess(JARVIS_SERVER, createJarvisServer({ audit }), JARVIS_TOOLS);
  const auditService = new AuditService(audit, path.join(home, "exports"));
  const chat = new ChatService({
    store,
    model: modelResolver(env),
    systemPrompt: loadSystemPrompt(),
    voicePrompt: loadVoicePrompt(),
    tools,
    projects,
    projectContext: async (conversationId) => {
      const p = projects.conversationProject(conversationId);
      return p ? projectCard(p) : undefined;
    },
    dailyBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 3,
    logger,
  });

  // The server is created below; voice events only flow once it is listening.
  let broadcast: (m: CoreMessage) => void = () => {};
  const projectsService = new ProjectsService({
    projects,
    index,
    jarvisHome: home,
    broadcast: (m) => broadcast(m),
    conversationsChanged: (s, id) => chat.conversationsList(s, { type: "conversations.list", id }),
    logger,
  });
  const turns = new VoiceTurns({
    voice: { send: (m) => voice?.send(m) ?? false },
    chat,
    broadcast: (m) => broadcast(m),
    metrics: new VoiceMetricsStore(db),
    markInterrupted: (turnId) => store.markInterrupted(turnId),
    logger,
    // Barge-in by voice (ADR-016) assumes headphones: with speakers Jarvis would interrupt himself.
    vadBargeIn: env.JARVIS_BARGE_IN !== "0",
    // Wake word (ADR-021): off unless JARVIS_WAKE_WORD=1; the app can toggle it at runtime.
    wakeWord: { enabled: env.JARVIS_WAKE_WORD === "1", threshold: env.JARVIS_WAKE_THRESHOLD ? Number(env.JARVIS_WAKE_THRESHOLD) : undefined },
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
    confirmations.cancelAll();
    unwatchFile(rulesFile);
    index.close();
    await tools.close();
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
      disconnected: (s) => {
        chat.disconnected(s);
        confirmations.disconnected(s);
      },
      permissionRespond: (s, m) => confirmations.respond(s, m),
      audit: (s, m) => auditService.handle(s, m),
      conversationsList: (s, m) => chat.conversationsList(s, m),
      conversationsGet: (s, m) => chat.conversationsGet(s, m),
      budgetGet: (s, m) => chat.budgetGet(s, m),
      voicePtt: (s, m) => turns.ptt(s, m),
      voiceStatusGet: (s, m) => turns.statusGet(s, m),
      voiceWake: (s, m) => turns.voiceWake(s, m),
      projects: (s, m) => projectsService.handle(s, m),
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
  sessions = () => server.sessionList();
  logger.log("info", "core.ready", { pipe, version: CORE_VERSION, dailyBudgetUsd: budget });
  voice?.start();
  // Phase 4 (ADR-020): third-party MCP servers the owner listed, each in its own process. In the
  // background: a slow server never delays startup; its tools appear from the next turn on.
  void connectExternalServers(loadExternalServers(path.join(home, "mcp-servers.json"), logger), {
    hub: tools,
    workDir: path.join(home, "mcp"),
    secret: mcpSecret,
    logger,
  });
  // Phase 3: bring every registered project's index up to date, then follow changes (ADR-017).
  for (const project of projects.list()) projectsService.reindex(project.id);

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
