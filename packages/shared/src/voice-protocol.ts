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

export const VOICE_PROTOCOL_VERSION = "1.2"; // 1.1: vad.* (barge-in); 1.2: wake.* (wake word)

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
  stt: z.strictObject({ engine: z.literal("parakeet") }).optional(),
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

/** Push-to-talk pressed: open the microphone and record. `id` names the utterance. */
export const SttStart = z.strictObject({ type: z.literal("stt.start"), id: Id });
export type SttStart = z.infer<typeof SttStart>;

/** Push-to-talk released: close the microphone and transcribe. */
export const SttStop = z.strictObject({ type: z.literal("stt.stop"), id: Id });
export type SttStop = z.infer<typeof SttStop>;

/** Discard the utterance being recorded (no transcription). */
export const SttCancel = z.strictObject({ type: z.literal("stt.cancel"), id: Id });
export type SttCancel = z.infer<typeof SttCancel>;

/**
 * Barge-in by voice (ADR-016): while Jarvis speaks, open the mic and watch for the owner talking.
 * `id` names the utterance the VAD will record if it hears speech (reported with `vad.speech`).
 */
export const VadArm = z.strictObject({ type: z.literal("vad.arm"), id: Id });
export type VadArm = z.infer<typeof VadArm>;

/** Stop watching (Jarvis finished, or push-to-talk took over). An utterance already started finishes. */
export const VadDisarm = z.strictObject({ type: z.literal("vad.disarm"), id: Id });
export type VadDisarm = z.infer<typeof VadDisarm>;

/**
 * Wake word (Phase 4, ADR-021): keep the mic open between captures and feed it only to the local
 * detector. `threshold` (0-1) overrides the detector's default. Answered with wake.listening.
 */
export const WakeEnable = z.strictObject({ type: z.literal("wake.enable"), id: Id, threshold: z.number().min(0).max(1).optional() });
export type WakeEnable = z.infer<typeof WakeEnable>;

export const WakeDisable = z.strictObject({ type: z.literal("wake.disable"), id: Id });
export type WakeDisable = z.infer<typeof WakeDisable>;

/** No more phrases for this turn: tts.finished fires once everything queued has played. */
export const TtsEnd = z.strictObject({ type: z.literal("tts.end"), id: Id, turnId: Id });
export type TtsEnd = z.infer<typeof TtsEnd>;

export const ToVoiceMessage = z.discriminatedUnion("type", [
  TtsEnd,
  VoiceConfigure,
  VoicePing,
  VoiceShutdown,
  TtsSpeak,
  TtsCancel,
  SttStart,
  SttStop,
  SttCancel,
  VadArm,
  VadDisarm,
  WakeEnable,
  WakeDisable,
]);
export type ToVoiceMessage = z.infer<typeof ToVoiceMessage>;

// ------------------------------------------------------------------ voice -> core

export const VoiceErrorCode = z.enum([
  "invalid_json",
  "invalid_message",
  "incompatible_version",
  "not_configured",
  "tts_failed",
  "stt_failed",
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

/** The microphone is open (or closed again): the UI shows the mandatory mic indicator. */
export const SttListening = z.strictObject({ type: z.literal("stt.listening"), id: Id, open: z.boolean() });
export type SttListening = z.infer<typeof SttListening>;

/**
 * The owner started talking over Jarvis (>= 250 ms of speech). The voice service keeps recording
 * utterance `id` until 700 ms of silence, then closes the mic (`stt.listening`) and sends `stt.final`.
 */
export const VadSpeech = z.strictObject({ type: z.literal("vad.speech"), id: Id });
export type VadSpeech = z.infer<typeof VadSpeech>;

/** The wake word detector is listening (open) or stopped. The UI shows its own indicator. */
export const WakeListening = z.strictObject({ type: z.literal("wake.listening"), id: Id, open: z.boolean() });
export type WakeListening = z.infer<typeof WakeListening>;

/** "Hey Jarvis" heard (score >= threshold). Nothing said before it is kept or sent. */
export const WakeDetected = z.strictObject({ type: z.literal("wake.detected"), id: Id, score: z.number().min(0).max(1) });
export type WakeDetected = z.infer<typeof WakeDetected>;

/** Final transcription of an utterance. Empty text means nothing intelligible was said. */
export const SttFinal = z.strictObject({
  type: z.literal("stt.final"),
  id: Id,
  text: z.string().max(8_000),
  audioMs: z.number().nonnegative(),
  sttMs: z.number().nonnegative(),
});
export type SttFinal = z.infer<typeof SttFinal>;

export const FromVoiceMessage = z.discriminatedUnion("type", [
  VoiceReady,
  VoicePong,
  VoiceError,
  TtsStarted,
  TtsFinished,
  SttListening,
  SttFinal,
  VadSpeech,
  WakeListening,
  WakeDetected,
]);
export type FromVoiceMessage = z.infer<typeof FromVoiceMessage>;

// ------------------------------------------------------------------ helpers

export const parseToVoiceMessage = (line: string): ParseResult<ToVoiceMessage> => parseWith(ToVoiceMessage, line);
export const parseFromVoiceMessage = (line: string): ParseResult<FromVoiceMessage> => parseWith(FromVoiceMessage, line);
