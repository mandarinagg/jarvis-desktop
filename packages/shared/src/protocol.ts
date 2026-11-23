/**
 * IPC contracts between the Core and its clients (ADR-008). Single source of truth:
 * every message is validated with these schemas when it enters a process.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = "1.3"; // 1.1: voice.* (Phase 2); 1.2: chat.tool, projects.* (Phase 3); 1.3: permission.*, audit.* (Phase 4)

const Id = z.string().min(1).max(64);
const SessionToken = z.string().regex(/^[0-9a-f]{64}$/, "token must be 256-bit lowercase hex");

// ------------------------------------------------------------------ client -> core

export const AuthHello = z.strictObject({
  type: z.literal("auth.hello"),
  id: Id,
  token: SessionToken,
  protocolVersion: z.string().max(16),
  client: z.enum(["desktop", "cli", "voice"]),
});
export type AuthHello = z.infer<typeof AuthHello>;

export const CorePing = z.strictObject({ type: z.literal("core.ping"), id: Id });
export type CorePing = z.infer<typeof CorePing>;

export const CoreShutdown = z.strictObject({ type: z.literal("core.shutdown"), id: Id });
export type CoreShutdown = z.infer<typeof CoreShutdown>;

export const ChatSend = z.strictObject({
  type: z.literal("chat.send"),
  id: Id,
  conversationId: Id.optional(),
  /** Phase 3: active project for a new conversation (ignored when continuing one). */
  projectId: Id.optional(),
  text: z.string().min(1).max(32_000),
});
export type ChatSend = z.infer<typeof ChatSend>;

export const ChatCancel = z.strictObject({ type: z.literal("chat.cancel"), id: Id, turnId: Id });
export type ChatCancel = z.infer<typeof ChatCancel>;

export const ConversationsList = z.strictObject({ type: z.literal("conversations.list"), id: Id });
export type ConversationsList = z.infer<typeof ConversationsList>;

export const ConversationsGet = z.strictObject({ type: z.literal("conversations.get"), id: Id, conversationId: Id });
export type ConversationsGet = z.infer<typeof ConversationsGet>;

export const BudgetGet = z.strictObject({ type: z.literal("budget.get"), id: Id });
export type BudgetGet = z.infer<typeof BudgetGet>;

// Phase 3 (ADR-017): projects are registered only by the owner, through an authenticated client.
const ProjectName = z.string().trim().min(1).max(80);
const ProjectText = (max: number) => z.string().max(max);

export const ProjectsList = z.strictObject({ type: z.literal("projects.list"), id: Id });
export type ProjectsList = z.infer<typeof ProjectsList>;

export const ProjectsCreate = z.strictObject({
  type: z.literal("projects.create"),
  id: Id,
  name: ProjectName,
  root: z.string().min(3).max(1_000),
  description: ProjectText(500).optional(),
  goals: ProjectText(1_000).optional(),
});
export type ProjectsCreate = z.infer<typeof ProjectsCreate>;

export const ProjectsUpdate = z.strictObject({
  type: z.literal("projects.update"),
  id: Id,
  projectId: Id,
  name: ProjectName.optional(),
  description: ProjectText(500).optional(),
  goals: ProjectText(1_000).optional(),
});
export type ProjectsUpdate = z.infer<typeof ProjectsUpdate>;

export const ProjectsDelete = z.strictObject({ type: z.literal("projects.delete"), id: Id, projectId: Id });
export type ProjectsDelete = z.infer<typeof ProjectsDelete>;

export const ProjectsReindex = z.strictObject({ type: z.literal("projects.reindex"), id: Id, projectId: Id });
export type ProjectsReindex = z.infer<typeof ProjectsReindex>;

/** Links a conversation to a project (its active project), or unlinks it with null. */
export const ConversationsSetProject = z.strictObject({
  type: z.literal("conversations.setProject"),
  id: Id,
  conversationId: Id,
  projectId: Id.nullable(),
});
export type ConversationsSetProject = z.infer<typeof ConversationsSetProject>;

export type ProjectsMessage = ProjectsList | ProjectsCreate | ProjectsUpdate | ProjectsDelete | ProjectsReindex | ConversationsSetProject;

/** Push-to-talk key pressed/released (Phase 2). Pressing while Jarvis speaks interrupts it (barge-in). */
export const VoicePtt = z.strictObject({
  type: z.literal("voice.ptt"),
  id: Id,
  pressed: z.boolean(),
  conversationId: Id.optional(),
});
export type VoicePtt = z.infer<typeof VoicePtt>;

export const VoiceStatusGet = z.strictObject({ type: z.literal("voice.status.get"), id: Id });
export type VoiceStatusGet = z.infer<typeof VoiceStatusGet>;

// Phase 4 (ADR-018): the owner answers a permission.request. Only the desktop main process (native
// dialog) and the CLI send this; the renderer, which shows model output, never can.
export const PermissionRespond = z.strictObject({
  type: z.literal("permission.respond"),
  id: Id,
  requestId: Id,
  approved: z.boolean(),
  /** Explicit approvals the owner gave (destructive actions need 2). */
  confirmations: z.number().int().min(0).max(2),
});
export type PermissionRespond = z.infer<typeof PermissionRespond>;

export const AuditList = z.strictObject({
  type: z.literal("audit.list"),
  id: Id,
  limit: z.number().int().min(1).max(200).optional(),
  beforeId: z.number().int().positive().optional(),
});
export type AuditList = z.infer<typeof AuditList>;

/** Writes the whole audit log as JSONL inside the Jarvis folder (exports/). */
export const AuditExport = z.strictObject({ type: z.literal("audit.export"), id: Id });
export type AuditExport = z.infer<typeof AuditExport>;

export type AuditMessage = AuditList | AuditExport;

export const ClientMessage = z.discriminatedUnion("type", [
  PermissionRespond,
  AuditList,
  AuditExport,
  VoicePtt,
  VoiceStatusGet,
  AuthHello,
  CorePing,
  CoreShutdown,
  ChatSend,
  ChatCancel,
  ConversationsList,
  ConversationsGet,
  BudgetGet,
  ProjectsList,
  ProjectsCreate,
  ProjectsUpdate,
  ProjectsDelete,
  ProjectsReindex,
  ConversationsSetProject,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ------------------------------------------------------------------ core -> client

export const ErrorCode = z.enum([
  "invalid_json",
  "invalid_message",
  "unauthenticated",
  "incompatible_version",
  "budget_exceeded",
  "upstream_error",
  "cancelled",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const Usage = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

export const AuthOk = z.strictObject({ type: z.literal("auth.ok"), id: Id, coreVersion: z.string() });
export type AuthOk = z.infer<typeof AuthOk>;

export const CorePong = z.strictObject({ type: z.literal("core.pong"), id: Id });
export type CorePong = z.infer<typeof CorePong>;

export const CoreError = z.strictObject({
  type: z.literal("error"),
  id: Id.optional(),
  code: ErrorCode,
  message: z.string().max(2_000),
});
export type CoreError = z.infer<typeof CoreError>;

export const ChatStarted = z.strictObject({
  type: z.literal("chat.started"),
  id: Id,
  turnId: Id,
  conversationId: Id,
});
export type ChatStarted = z.infer<typeof ChatStarted>;

export const ChatDelta = z.strictObject({ type: z.literal("chat.delta"), turnId: Id, text: z.string() });
export type ChatDelta = z.infer<typeof ChatDelta>;

/** Jarvis used a tool during a turn (Phase 3): what it did, in words, for the UI. Never the result. */
export const ChatTool = z.strictObject({
  type: z.literal("chat.tool"),
  turnId: Id,
  tool: z.string().min(1).max(128),
  summary: z.string().max(300),
  /** waiting: Jarvis is waiting for the owner to confirm (Phase 4). */
  status: z.enum(["started", "waiting", "done", "error", "denied"]),
});
export type ChatTool = z.infer<typeof ChatTool>;

export const ChatDone = z.strictObject({
  type: z.literal("chat.done"),
  turnId: Id,
  stopReason: z.string().max(64),
  usage: Usage,
  costUsd: z.number().nonnegative(),
});
export type ChatDone = z.infer<typeof ChatDone>;

export const ConversationSummary = z.strictObject({ id: Id, title: z.string(), updatedAt: z.string(), projectId: Id.optional() });
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const ConversationsListResult = z.strictObject({
  type: z.literal("conversations.list.result"),
  id: Id,
  conversations: z.array(ConversationSummary).max(500),
});
export type ConversationsListResult = z.infer<typeof ConversationsListResult>;

export const HistoryMessage = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  interrupted: z.boolean(),
  createdAt: z.string(),
});
export type HistoryMessage = z.infer<typeof HistoryMessage>;

export const ConversationHistory = z.strictObject({
  type: z.literal("conversations.history"),
  id: Id,
  conversationId: Id,
  title: z.string(),
  projectId: Id.optional(),
  messages: z.array(HistoryMessage),
});
export type ConversationHistory = z.infer<typeof ConversationHistory>;

export const ProjectInfo = z.strictObject({
  id: Id,
  name: z.string(),
  description: z.string(),
  goals: z.string(),
  root: z.string(),
  indexedAt: z.string().nullable(),
  files: z.number().int().nonnegative(),
  indexing: z.boolean(),
});
export type ProjectInfo = z.infer<typeof ProjectInfo>;

/** Reply to projects.* (with the request id) and broadcast to every client when projects change. */
export const ProjectsListResult = z.strictObject({
  type: z.literal("projects.list.result"),
  id: Id.optional(),
  projects: z.array(ProjectInfo).max(500),
});
export type ProjectsListResult = z.infer<typeof ProjectsListResult>;

export const BudgetStatus = z.strictObject({
  type: z.literal("budget.status"),
  id: Id,
  spentTodayUsd: z.number().nonnegative(),
  dailyBudgetUsd: z.number().positive(),
});
export type BudgetStatus = z.infer<typeof BudgetStatus>;

/** Overlay states (VOICE_PIPELINE §3). `micOpen` drives the mandatory microphone indicator. */
export const VoiceStateName = z.enum(["unavailable", "idle", "listening", "transcribing", "thinking", "speaking"]);
export type VoiceStateName = z.infer<typeof VoiceStateName>;

export const VoiceStateMessage = z.strictObject({
  type: z.literal("voice.state"),
  id: Id.optional(),
  state: VoiceStateName,
  micOpen: z.boolean(),
  conversationId: Id.optional(),
  detail: z.string().max(500).optional(),
});
export type VoiceStateMessage = z.infer<typeof VoiceStateMessage>;

/** What Jarvis understood, before answering. */
export const VoiceTranscript = z.strictObject({
  type: z.literal("voice.transcript"),
  utteranceId: Id,
  text: z.string().max(8_000),
});
export type VoiceTranscript = z.infer<typeof VoiceTranscript>;

export const RiskName = z.enum(["read", "prepare", "confirm", "destructive", "forbidden"]);
export type RiskName = z.infer<typeof RiskName>;

/**
 * Jarvis needs the owner's OK before a tool runs (Phase 4, ADR-018). `title` and `detail` are
 * written by the Core from validated arguments (detail may contain a diff of model-written text:
 * show it as plain text). Sent to the desktop and CLI clients; the first answer wins.
 */
export const PermissionRequest = z.strictObject({
  type: z.literal("permission.request"),
  requestId: Id,
  turnId: Id.optional(),
  server: z.string().max(64),
  tool: z.string().max(128),
  risk: RiskName,
  title: z.string().max(300),
  detail: z.string().max(6_000),
  confirmations: z.union([z.literal(1), z.literal(2)]),
  expiresAt: z.string(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

/** A request was answered (here or in another window), expired or was cancelled with its turn. */
export const PermissionResolved = z.strictObject({
  type: z.literal("permission.resolved"),
  requestId: Id,
  approved: z.boolean(),
  reason: z.string().max(200).optional(),
});
export type PermissionResolved = z.infer<typeof PermissionResolved>;

export const AuditEntryInfo = z.strictObject({
  id: z.number().int().positive(),
  ts: z.string(),
  turnId: z.string().optional(),
  server: z.string(),
  tool: z.string(),
  /** Redacted JSON of the arguments, at most 2000 characters. */
  args: z.string().max(2_100),
  risk: RiskName,
  decision: z.enum(["allow", "deny"]),
  approvedBy: z.string().optional(),
  reason: z.string().optional(),
  ok: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type AuditEntryInfo = z.infer<typeof AuditEntryInfo>;

export const AuditListResult = z.strictObject({
  type: z.literal("audit.list.result"),
  id: Id,
  entries: z.array(AuditEntryInfo).max(200),
});
export type AuditListResult = z.infer<typeof AuditListResult>;

export const AuditExported = z.strictObject({
  type: z.literal("audit.exported"),
  id: Id,
  path: z.string(),
  count: z.number().int().nonnegative(),
});
export type AuditExported = z.infer<typeof AuditExported>;

export const CoreMessage = z.discriminatedUnion("type", [
  PermissionRequest,
  PermissionResolved,
  AuditListResult,
  AuditExported,
  VoiceStateMessage,
  VoiceTranscript,
  AuthOk,
  CorePong,
  CoreError,
  ChatStarted,
  ChatDelta,
  ChatTool,
  ChatDone,
  ConversationsListResult,
  ConversationHistory,
  BudgetStatus,
  ProjectsListResult,
]);
export type CoreMessage = z.infer<typeof CoreMessage>;

// ------------------------------------------------------------------ helpers

export type ParseResult<T> = { ok: true; message: T } | { ok: false; code: "invalid_json" | "invalid_message"; message: string };

export function parseWith<T>(schema: z.ZodType<T>, line: string): ParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, code: "invalid_json", message: "line is not valid JSON" };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, message: result.data };
  // Only paths and messages: never echo input values (they may carry the session token).
  const detail = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, code: "invalid_message", message: detail };
}

export const parseClientMessage = (line: string): ParseResult<ClientMessage> => parseWith(ClientMessage, line);
export const parseCoreMessage = (line: string): ParseResult<CoreMessage> => parseWith(CoreMessage, line);

export function isCompatibleVersion(peer: string, ours: string = PROTOCOL_VERSION): boolean {
  const major = (v: string) => /^(\d+)\.\d+$/.exec(v)?.[1];
  const a = major(peer);
  return a !== undefined && a === major(ours);
}
