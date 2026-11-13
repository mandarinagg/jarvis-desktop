/**
 * IPC contracts between the Core and its clients (ADR-008). Single source of truth:
 * every message is validated with these schemas when it enters a process.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = "1.0";

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
  text: z.string().min(1).max(32_000),
});
export type ChatSend = z.infer<typeof ChatSend>;

export const ChatCancel = z.strictObject({ type: z.literal("chat.cancel"), id: Id, turnId: Id });
export type ChatCancel = z.infer<typeof ChatCancel>;

export const ClientMessage = z.discriminatedUnion("type", [AuthHello, CorePing, CoreShutdown, ChatSend, ChatCancel]);
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

export const ChatDone = z.strictObject({
  type: z.literal("chat.done"),
  turnId: Id,
  stopReason: z.string().max(64),
  usage: Usage,
  costUsd: z.number().nonnegative(),
});
export type ChatDone = z.infer<typeof ChatDone>;

export const CoreMessage = z.discriminatedUnion("type", [AuthOk, CorePong, CoreError, ChatStarted, ChatDelta, ChatDone]);
export type CoreMessage = z.infer<typeof CoreMessage>;

// ------------------------------------------------------------------ helpers

export type ParseResult<T> = { ok: true; message: T } | { ok: false; code: "invalid_json" | "invalid_message"; message: string };

function parseWith<T>(schema: z.ZodType<T>, line: string): ParseResult<T> {
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
