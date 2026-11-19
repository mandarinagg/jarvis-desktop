/**
 * Core <-> Voice Service contract (ADR-008, ADR-013): JSON Lines over the child's stdio.
 * Audio never crosses this channel; only control messages and text do.
 *
 * The Python side (services/voice/src/jarvis_voice/protocol.py) mirrors these schemas.
 * Both are checked against the same fixtures (packages/shared/fixtures/voice-protocol.json),
 * so a change here without its Python counterpart fails the test suites.
 */
import { z } from "zod";
import { type ParseResult, parseWith } from "./protocol.js";

export const VOICE_PROTOCOL_VERSION = "1.0";

const Id = z.string().min(1).max(64);

// ------------------------------------------------------------------ core -> voice

export const VoiceConfigure = z.strictObject({
  type: z.literal("voice.configure"),
  id: Id,
  protocolVersion: z.string().max(16),
});
export type VoiceConfigure = z.infer<typeof VoiceConfigure>;

export const VoicePing = z.strictObject({ type: z.literal("voice.ping"), id: Id });
export type VoicePing = z.infer<typeof VoicePing>;

export const VoiceShutdown = z.strictObject({ type: z.literal("voice.shutdown"), id: Id });
export type VoiceShutdown = z.infer<typeof VoiceShutdown>;

export const ToVoiceMessage = z.discriminatedUnion("type", [VoiceConfigure, VoicePing, VoiceShutdown]);
export type ToVoiceMessage = z.infer<typeof ToVoiceMessage>;

// ------------------------------------------------------------------ voice -> core

export const VoiceErrorCode = z.enum(["invalid_json", "invalid_message", "incompatible_version", "not_configured", "internal"]);
export type VoiceErrorCode = z.infer<typeof VoiceErrorCode>;

export const VoiceReady = z.strictObject({
  type: z.literal("voice.ready"),
  id: Id,
  protocolVersion: z.string().max(16),
  serviceVersion: z.string().max(32),
});
export type VoiceReady = z.infer<typeof VoiceReady>;

export const VoicePong = z.strictObject({ type: z.literal("voice.pong"), id: Id });
export type VoicePong = z.infer<typeof VoicePong>;

export const VoiceError = z.strictObject({
  type: z.literal("voice.error"),
  id: Id.optional(),
  code: VoiceErrorCode,
  message: z.string().max(2_000),
});
export type VoiceError = z.infer<typeof VoiceError>;

export const FromVoiceMessage = z.discriminatedUnion("type", [VoiceReady, VoicePong, VoiceError]);
export type FromVoiceMessage = z.infer<typeof FromVoiceMessage>;

// ------------------------------------------------------------------ helpers

export const parseToVoiceMessage = (line: string): ParseResult<ToVoiceMessage> => parseWith(ToVoiceMessage, line);
export const parseFromVoiceMessage = (line: string): ParseResult<FromVoiceMessage> => parseWith(FromVoiceMessage, line);
