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
import { Builder } from "./builder/service.js";
import { BuilderTaskStore } from "./builder/store.js";
import { ChatService } from "./chat.js";
import { dashboard } from "./dashboard.js";
import { nowLine } from "./proactive/schedule.js";
import { Proactive } from "./proactive/service.js";
import { ProactiveStore } from "./proactive/store.js";
import { AnthropicSkillEvalModel } from "./skills/evaluate.js";
import { SkillsService } from "./skills/service.js";
import { SkillStore } from "./skills/store.js";
import { SKILLS_SERVER, SKILLS_TOOLS, createSkillsServer, skillsIndex } from "./tools/skills-server.js";
import { REMINDERS_SERVER, REMINDERS_TOOLS, createRemindersServer, remindersPreviews } from "./tools/reminders-server.js";
import { AnthropicChatModel, type ChatModel, type Effort } from "./claude/model.js";
import { openDatabase } from "./db.js";
import { localDay } from "./db.js";
import { AnthropicReflectionModel, Reflector, SKILL_WINDOW_DAYS } from "./memory/reflection.js";
import { retrieve } from "./memory/retrieve.js";
import { MemoryService } from "./memory/service.js";
import { MemoryStore } from "./memory/store.js";
import { createLogger } from "./log.js";
import { defaultPipeName, jarvisHome, tokenPath } from "./paths.js";
import { projectCard } from "./projects/context.js";
import { ProjectIndex } from "./projects/indexer.js";
import { ProjectsService } from "./projects/service.js";
import { ProjectStore } from "./projects/store.js";
import { loadModePrompts, loadSystemPrompt, loadVoicePrompt } from "./prompt.js";
import { KeyringSecretStore, mcpSecret } from "./secrets.js";
import { AlreadyRunningError, CoreServer } from "./server.js";
import { ConversationStore } from "./store.js";
import { newSessionToken, writeSessionToken } from "./token.js";
import { AuditService } from "./tools/audit-service.js";
import { BUILDER_SERVER, BUILDER_SERVER_TOOLS, builderPreviews, createBuilderServer } from "./tools/builder-server.js";
import { ConfirmationBroker } from "./tools/confirm.js";
import { connectExternalServers, loadExternalServers } from "./tools/external.js";
import { ToolHub } from "./tools/hub.js";
import { JARVIS_SERVER, JARVIS_TOOLS, createJarvisServer } from "./tools/jarvis-server.js";
import { MEMORY_SERVER, MEMORY_TOOLS, createMemoryServer, memoryPreviews } from "./tools/memory-server.js";
import { AuditLog, PermissionEngine, loadRules } from "./tools/permissions.js";
import { PROJECTS_SERVER, PROJECTS_TOOLS, createProjectsServer, projectsPreviews } from "./tools/projects-server.js";
import { VoiceMetricsStore } from "./voice/metrics.js";
import { createVoiceSpawner } from "./voice/spawn.js";
import { VoiceSupervisor } from "./voice/supervisor.js";
import { VoiceTurns } from "./voice/turns.js";

export const CORE_VERSION = "0.1.0";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Key from Credential Manager; ANTHROPIC_API_KEY only as a dev fallback (.env is never committed). */
function anthropicKey(env: NodeJS.ProcessEnv): () => string | undefined {
  const secrets = new KeyringSecretStore();
  return () => secrets.get("anthropic-api-key") ?? env.ANTHROPIC_API_KEY;
}

function modelResolver(env: NodeJS.ProcessEnv): () => ChatModel | undefined {
  const apiKey = anthropicKey(env);
  const effort = EFFORTS.find((e) => e === env.JARVIS_EFFORT) ?? "low";
  let cached: { key: string; model: ChatModel } | undefined;
  return () => {
    const key = apiKey();
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
  // Phase 6 (ADR-024): memory that learns. Saving needs the owner's OK; retrieval is per turn, as data.
  const memories = new MemoryStore(db);
  const memoryDeps = { memories, projects, conversations: store };
  await tools.addInProcess(MEMORY_SERVER, createMemoryServer(memoryDeps), MEMORY_TOOLS, memoryPreviews(memoryDeps));
  const modePrompts = loadModePrompts();
  // The server is created below; events only flow once it is listening.
  let broadcast: (m: CoreMessage) => void = () => {};
  const dailyBudgetUsd = Number.isFinite(budget) && budget > 0 ? budget : 3;
  // Daily reflection (ADR-024): episodes + proposals the owner decides. JARVIS_REFLECTION=0 turns it off.
  const reflectionKey = anthropicKey(env);
  let reflectionModel: { key: string; model: AnthropicReflectionModel } | undefined;
  // Phase 7 (ADR-027): skills Jarvis proposes; created here so the reflection can propose them too (ADR-028).
  const skillStore = new SkillStore(db);
  const reflector = new Reflector({
    db,
    memories,
    projects,
    skills: {
      names: () => skillStore.takenNames(new Date(Date.now() - SKILL_WINDOW_DAYS * 86_400_000).toISOString()),
      pendingCount: () => skillStore.pendingProposals().length,
      propose: (p) => {
        skillStore.propose(p);
        broadcast(skills.result("skills")); // declared below; the reflection only runs once the Core is up
      },
    },
    model: () => {
      const key = reflectionKey();
      if (!key) return undefined;
      if (reflectionModel?.key !== key) reflectionModel = { key, model: new AnthropicReflectionModel(key) };
      return reflectionModel.model;
    },
    spentToday: () => store.spentOn(localDay(new Date())),
    dailyBudgetUsd,
    logger,
  });
  const memoryService = new MemoryService(memories, projects, reflector);
  const reflectionTimer =
    env.JARVIS_REFLECTION === "0" ? undefined : setInterval(() => void reflector.runIfDue(), 30 * 60_000);
  reflectionTimer?.unref();
  // Phase 5 (ADR-023): the Builder, reached through the `builder` tools (owner confirms start and merge).
  const builder = new Builder({
    tasks: new BuilderTaskStore(db),
    projects,
    audit,
    home,
    apiKey: anthropicKey(env),
    model: env.JARVIS_BUILDER_MODEL || "claude-opus-5-5",
    spentToday: () => store.spentOn(localDay(new Date())),
    dailyBudgetUsd,
    broadcast: (m) => broadcast(m),
    logger,
  });
  builder.recoverInterrupted();
  await tools.addInProcess(BUILDER_SERVER, createBuilderServer(builder), BUILDER_SERVER_TOOLS, builderPreviews(builder));
  const tts = ttsResolver(env);
  // Phase 7 (ADR-026): reminders (owner confirms each one) and the daily briefing, as notifications.
  const proactiveStore = new ProactiveStore(db);
  const proactive = new Proactive({
    db,
    store: proactiveStore,
    broadcast: (m) => broadcast(m),
    canNotify: () => sessions().some((s) => s.client === "desktop"),
    dailyBudgetUsd,
    logger,
  });
  const remindersDeps = { store: proactiveStore, briefing: () => proactive.briefingNow(), conversationOfTurn: (t: string) => memories.conversationOfTurn(t) };
  await tools.addInProcess(REMINDERS_SERVER, createRemindersServer(remindersDeps), REMINDERS_TOOLS, remindersPreviews(remindersDeps));
  // Phase 7 (ADR-027): skills Jarvis proposes; active only after their evals pass and the owner approves.
  await tools.addInProcess(SKILLS_SERVER, createSkillsServer({ store: skillStore, conversationOfTurn: (t) => memories.conversationOfTurn(t) }), SKILLS_TOOLS);
  const skillKey = anthropicKey(env);
  let skillModel: { key: string; model: AnthropicSkillEvalModel } | undefined;
  const systemPrompt = loadSystemPrompt();
  const skills = new SkillsService({
    store: skillStore,
    confirmer: confirmations,
    audit,
    model: () => {
      const key = skillKey();
      if (!key) return undefined;
      if (skillModel?.key !== key) skillModel = { key, model: new AnthropicSkillEvalModel(key) };
      return skillModel.model;
    },
    systemPrompt,
    clock: nowLine,
    spentToday: () => store.spentOn(localDay(new Date())),
    dailyBudgetUsd,
    mirrorDir: path.join(home, "skills"),
    broadcast: (m) => broadcast(m),
    logger,
  });
  const proactiveTimer = setInterval(() => proactive.tick(), 30_000);
  proactiveTimer.unref();
  const auditService = new AuditService(audit, path.join(home, "exports"));
  const chat = new ChatService({
    store,
    model: modelResolver(env),
    systemPrompt,
    skillsContext: () => skillsIndex(skillStore),
    voicePrompt: loadVoicePrompt(),
    tools,
    projects,
    projectContext: async (conversationId) => {
      const p = projects.conversationProject(conversationId);
      return p ? projectCard(p) : undefined;
    },
    dailyBudgetUsd,
    memoryContext: ({ conversationId, turnId, text }) => {
      const r = retrieve(memories, { text, projectId: projects.conversationProject(conversationId)?.id, now: new Date() });
      if (r.memories.length) memories.recordUses(turnId, conversationId, r.memories.map((m) => m.id));
      return r.block;
    },
    clock: nowLine,
    modePrompt: (conversationId) => {
      const mode = store.thinkingMode(conversationId);
      return mode ? modePrompts[mode] : undefined;
    },
    logger,
  });

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
          tts,
          stt: env.JARVIS_STT !== "0",
          logger,
          onState: (state, detail) => turns.supervisorState(state, detail),
          onMessage: (m) => turns.onVoiceMessage(m),
        });

  const stop = async (reason: string) => {
    logger.log("info", "core.stopping", { reason });
    chat.cancelAll();
    confirmations.cancelAll();
    await builder.close();
    if (reflectionTimer) clearInterval(reflectionTimer);
    clearInterval(proactiveTimer);
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
      memory: (s, m) => memoryService.handle(s, m),
      conversationsSetMode: (s, m) => chat.conversationsSetMode(s, m),
      proactive: (s, m) => proactive.handle(s, m),
      skills: (s, m) => skills.handle(s, m),
      dashboardGet: (s, m) =>
        s.send({ type: "dashboard.result", id: m.id, ...dashboard(db, { dailyBudgetUsd, googleTts: tts().engine === "google" }) }),
      builder: (s, m) => {
        if (m.type === "builder.list") s.send({ type: "builder.list.result", id: m.id, tasks: builder.list() });
        else {
          builder.cancel(m.taskId);
          s.send({ type: "builder.list.result", id: m.id, tasks: builder.list() });
        }
      },
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
  // A reflection missed while the Core was off runs shortly after startup.
  if (reflectionTimer) setTimeout(() => void reflector.runIfDue(), 2 * 60_000).unref();
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
