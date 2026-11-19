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

/** TTS settings (ADR-011). The API key travels only over this private stdio channel (ADR-013). */
export const TtsConfig = z.strictObject({
  engine: z.enum(["google", "piper"]),
  voice: z.string().min(1).max(64),
  googleApiKey: z.string().min(1).max(256).optional(),
});
export type TtsConfig = z.infer<typeof TtsConfig>;

export const VoiceConfigure = z.strictObject({
  type: z.literal("voice.configure"),
  id: Id,
  protocolVersion: z.string().max(16),
  tts: TtsConfig.optional(),
});
export type VoiceConfigure = z.infer<typeof VoiceConfigure>;

export const VoicePing = z.strictObject({ type: z.literal("voice.ping"), id: Id });
export type VoicePing = z.infer<typeof VoicePing>;

export const VoiceShutdown = z.strictObject({ type: z.literal("voice.shutdown"), id: Id });
export type VoiceShutdown = z.infer<typeof VoiceShutdown>;

/** One phrase of a reply, in order (`seq` from 0). `final` marks the last phrase of the turn. */
export const TtsSpeak = z.strictObject({
  type: z.literal("tts.speak"),
  id: Id,
  turnId: Id,
  seq: z.number().int().min(0).max(10_000),
  text: z.string().min(1).max(2_000),
  final: z.boolean(),
});
export type TtsSpeak = z.infer<typeof TtsSpeak>;

/** Stop speaking a turn now: drops pending phrases and fades out what is playing. */
export const TtsCancel = z.strictObject({ type: z.literal("tts.cancel"), id: Id, turnId: Id });
export type TtsCancel = z.infer<typeof TtsCancel>;

export const ToVoiceMessage = z.discriminatedUnion("type", [VoiceConfigure, VoicePing, VoiceShutdown, TtsSpeak, TtsCancel]);
export type ToVoiceMessage = z.infer<typeof ToVoiceMessage>;

// ------------------------------------------------------------------ voice -> core

export const VoiceErrorCode = z.enum([
  "invalid_json",
  "invalid_message",
  "incompatible_version",
  "not_configured",
  "tts_failed",
  "internal",
]);
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

/** A phrase started playing. `latencyMs`: from receiving `tts.speak` to its first audio. */
export const TtsStarted = z.strictObject({
  type: z.literal("tts.started"),
  turnId: Id,
  seq: z.number().int().min(0).max(10_000),
  engine: z.enum(["google", "piper", "cache"]),
  latencyMs: z.number().nonnegative(),
});
export type TtsStarted = z.infer<typeof TtsStarted>;

/** Playback of a turn ended: after its final phrase, or cut short by `tts.cancel`. */
export const TtsFinished = z.strictObject({ type: z.literal("tts.finished"), turnId: Id, interrupted: z.boolean() });
export type TtsFinished = z.infer<typeof TtsFinished>;

export const FromVoiceMessage = z.discriminatedUnion("type", [VoiceReady, VoicePong, VoiceError, TtsStarted, TtsFinished]);
export type FromVoiceMessage = z.infer<typeof FromVoiceMessage>;

// ------------------------------------------------------------------ helpers

export const parseToVoiceMessage = (line: string): ParseResult<ToVoiceMessage> => parseWith(ToVoiceMessage, line);
export const parseFromVoiceMessage = (line: string): ParseResult<FromVoiceMessage> => parseWith(FromVoiceMessage, line);
