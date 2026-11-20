/**
 * Voice turns (ADR-013): the Core owns the turn. Push-to-talk -> STT -> ChatService -> phrases -> TTS.
 *
 * The chat turn runs through the regular ChatService using a virtual session: everything it
 * emits is broadcast to the UI (so the reply also shows up as text) and its deltas are cut into
 * phrases for the voice service. Pressing push-to-talk while Jarvis thinks or speaks interrupts
 * it (barge-in): the Claude stream and the audio are cancelled and a new utterance starts.
 * With `vadBargeIn` the voice service also watches the mic while Jarvis speaks (ADR-016): talking
 * over him (vad.speech) interrupts him the same way, and the VAD ends that utterance on silence.
 */
import { randomUUID } from "node:crypto";
import type {
  ChatCancel,
  ChatSend,
  CoreMessage,
  FromVoiceMessage,
  ToVoiceMessage,
  VoicePtt,
  VoiceStateName,
  VoiceStatusGet,
} from "@jarvis/shared";
import { type Logger, silentLogger } from "../log.js";
import type { Session } from "../server.js";
import type { VoiceMetricsStore, VoiceOutcome } from "./metrics.js";
import { PhraseSegmenter } from "./segmenter.js";
import type { VoiceState } from "./supervisor.js";

export const VOICE_SESSION_ID = "voice";

/** Pre-synthesized by the voice service (tts/cache.py ACKNOWLEDGEMENTS): keep in sync. */
export const PHRASES = {
  lookup: "Dale, ya lo miro.",
  notHeard: "No te escuché bien, ¿me lo repetís?",
  budget: "Llegué al tope de gasto de hoy. Seguimos mañana o subí el tope.",
  upstream: "No pude hablar con Claude. Te dejé el detalle en pantalla.",
  generic: "Algo falló. Te dejé el detalle en pantalla.",
  confirm: "Necesito que me lo confirmes en pantalla.",
} as const;

export interface VoiceLink {
  send(message: ToVoiceMessage): boolean;
}

export interface ChatLike {
  chatSend(session: Session, message: ChatSend, mode: "voice"): Promise<void>;
  chatCancel(session: Session, message: ChatCancel): void;
}

export interface VoiceTurnsOptions {
  voice: VoiceLink;
  chat: ChatLike;
  broadcast: (message: CoreMessage) => void;
  metrics?: VoiceMetricsStore;
  markInterrupted?: (chatTurnId: string) => void;
  logger?: Logger;
  now?: () => number;
  /** A new utterance without conversationId continues the last voice conversation within this window. */
  continueWithinMs?: number;
  /** Barge-in by voice: watch the mic (VAD) while Jarvis speaks. Off = only push-to-talk interrupts. */
  vadBargeIn?: boolean;
}

interface Utterance {
  id: string;
  conversationId?: string | undefined;
  releasedAt?: number;
}

interface Turn {
  id: string; // TTS turn id
  chatMsgId?: string;
  chatTurnId?: string;
  conversationId?: string | undefined;
  seq: number;
  segmenter: PhraseSegmenter;
  chatDone: boolean;
  ended: boolean;
  outcome?: VoiceOutcome;
  releasedAt?: number | undefined;
  audioMs?: number;
  sttMs?: number;
  chatSentAt?: number;
  firstTokenAt?: number;
  firstAudioAt?: number;
  engine?: string;
  bargeInAt?: number;
}

export class VoiceTurns {
  private phase: VoiceStateName = "unavailable";
  private micOpen = false;
  private utterance: Utterance | undefined;
  private current: Turn | undefined;
  private readonly turns = new Map<string, Turn>();
  private lastConversation: { id: string; at: number } | undefined;
  /** VAD watch while a turn is spoken: `id` becomes the utterance if the owner talks over Jarvis. */
  private armed: { id: string; turnId: string } | undefined;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly opts: VoiceTurnsOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  get state(): VoiceStateName {
    return this.phase;
  }

  // ------------------------------------------------------------ inputs

  supervisorState(state: VoiceState, detail?: string): void {
    if (state === "ready") {
      if (this.phase === "unavailable") this.setPhase("idle");
      return;
    }
    this.utterance = undefined;
    this.current = undefined;
    this.armed = undefined;
    this.turns.clear();
    this.micOpen = false;
    this.setPhase("unavailable", state === "degraded" ? (detail ?? "la voz no está disponible") : undefined);
  }

  statusGet(session: Session, msg: VoiceStatusGet): void {
    session.send(this.stateMessage(msg.id));
  }

  ptt(session: Session, msg: VoicePtt): void {
    if (this.phase === "unavailable") {
      session.send(this.stateMessage(msg.id, "la voz no está disponible"));
      return;
    }
    if (msg.pressed) this.pressed(msg.conversationId);
    else this.released();
  }

  onVoiceMessage(msg: FromVoiceMessage): void {
    switch (msg.type) {
      case "stt.listening": {
        this.micOpen = msg.open;
        const u = this.utterance;
        if (!msg.open && u?.id === msg.id && u.releasedAt === undefined) {
          // The VAD closed the utterance on silence: same as releasing push-to-talk.
          u.releasedAt = this.now();
          this.setPhase("transcribing");
          return;
        }
        this.broadcastState();
        return;
      }
      case "vad.speech":
        this.vadSpeech(msg.id);
        return;
      case "stt.final":
        this.sttFinal(msg.id, msg.text, msg.audioMs, msg.sttMs);
        return;
      case "tts.started": {
        const turn = this.turns.get(msg.turnId);
        if (!turn) return;
        if (turn.firstAudioAt === undefined) {
          turn.firstAudioAt = this.now();
          turn.engine = msg.engine;
        }
        if (turn === this.current) {
          this.setPhase("speaking");
          this.arm(turn);
        }
        return;
      }
      case "tts.finished":
        this.finished(msg.turnId, msg.interrupted);
        return;
      case "voice.error":
        if (msg.id && msg.id === this.utterance?.id) {
          this.utterance = undefined;
          this.setPhase(this.current ? this.phase : "idle", msg.message);
        }
        this.logger.log("warn", "voice.error", { code: msg.code, detail: msg.message });
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------ push-to-talk

  private pressed(conversationId: string | undefined): void {
    if (this.utterance && this.utterance.releasedAt === undefined) return; // key repeat
    this.disarm();
    if (this.current) this.bargeIn(this.current);
    this.utterance = { id: randomUUID(), conversationId };
    this.voice({ type: "stt.start", id: this.utterance.id });
    this.setPhase("listening");
  }

  private released(): void {
    const u = this.utterance;
    if (!u || u.releasedAt !== undefined) return;
    u.releasedAt = this.now();
    this.voice({ type: "stt.stop", id: u.id });
    this.setPhase("transcribing");
  }

  private arm(turn: Turn): void {
    if (!this.opts.vadBargeIn || this.armed || this.utterance) return;
    this.armed = { id: randomUUID(), turnId: turn.id };
    this.voice({ type: "vad.arm", id: this.armed.id });
  }

  private disarm(): void {
    if (!this.armed) return;
    this.voice({ type: "vad.disarm", id: this.armed.id });
    this.armed = undefined;
  }

  /** The owner talked over Jarvis: interrupt him and let the VAD capture the new utterance. */
  private vadSpeech(id: string): void {
    if (this.armed?.id !== id || this.utterance) {
      this.voice({ type: "stt.cancel", id }); // stale watch (the turn already ended): drop it
      return;
    }
    const turn = this.turns.get(this.armed.turnId);
    this.armed = undefined;
    if (turn && turn === this.current) this.bargeIn(turn);
    this.utterance = { id, conversationId: turn?.conversationId };
    this.setPhase("listening");
    this.logger.log("info", "voice.vad_barge_in", { turnId: turn?.id });
  }

  private bargeIn(turn: Turn): void {
    turn.bargeInAt = this.now();
    turn.outcome = "interrupted";
    if (turn.chatTurnId) {
      if (turn.chatDone) this.opts.markInterrupted?.(turn.chatTurnId);
      else this.opts.chat.chatCancel(this.session(turn), { type: "chat.cancel", id: randomUUID(), turnId: turn.chatTurnId });
    }
    this.voice({ type: "tts.cancel", id: randomUUID(), turnId: turn.id });
    this.current = undefined;
    this.logger.log("info", "voice.barge_in", { turnId: turn.id });
  }

  private sttFinal(id: string, text: string, audioMs: number, sttMs: number): void {
    const u = this.utterance;
    if (!u || u.id !== id) return;
    this.utterance = undefined;
    const turn = this.newTurn(u);
    turn.audioMs = audioMs;
    turn.sttMs = sttMs;
    if (!text.trim()) {
      turn.outcome = "empty";
      this.speakOnly(turn, PHRASES.notHeard);
      return;
    }
    this.opts.broadcast({ type: "voice.transcript", utteranceId: id, text });
    this.startChat(turn, text);
  }

  // ------------------------------------------------------------ turns

  private newTurn(u: Utterance): Turn {
    const recent = this.lastConversation && this.now() - this.lastConversation.at < (this.opts.continueWithinMs ?? 10 * 60_000);
    const turn: Turn = {
      id: randomUUID(),
      conversationId: u.conversationId ?? (recent ? this.lastConversation?.id : undefined),
      seq: 0,
      segmenter: new PhraseSegmenter(),
      chatDone: false,
      ended: false,
      releasedAt: u.releasedAt,
    };
    this.turns.set(turn.id, turn);
    this.current = turn;
    return turn;
  }

  private speakOnly(turn: Turn, text: string): void {
    turn.chatDone = true;
    this.speak(turn, text);
    this.end(turn);
    this.setPhase("speaking");
  }

  private startChat(turn: Turn, text: string): void {
    turn.chatMsgId = randomUUID();
    turn.chatSentAt = this.now();
    this.setPhase("thinking");
    const msg: ChatSend = {
      type: "chat.send",
      id: turn.chatMsgId,
      text,
      ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
    };
    this.opts.chat.chatSend(this.session(turn), msg, "voice").catch((err: unknown) => {
      this.logger.log("error", "voice.chat_failed", { error: err instanceof Error ? err.message : String(err) });
      this.chatEvent(turn, { type: "error", id: msg.id, code: "internal", message: "internal error" });
    });
  }

  /** The ChatService's view of a voice turn: what it emits goes to the UI and to the TTS. */
  private session(turn: Turn): Session {
    return { id: VOICE_SESSION_ID, client: "voice", send: (m) => this.chatEvent(turn, m), close: () => {} };
  }

  private chatEvent(turn: Turn, m: CoreMessage): void {
    this.opts.broadcast(m);
    const live = turn.outcome !== "interrupted";
    switch (m.type) {
      case "chat.started":
        turn.chatTurnId = m.turnId;
        turn.conversationId = m.conversationId;
        this.lastConversation = { id: m.conversationId, at: this.now() };
        return;
      case "chat.tool":
        // Tools take a while: an instant cached acknowledgement beats silence (VOICE_PIPELINE §2).
        if (live && m.status === "started" && turn.seq === 0) this.speak(turn, PHRASES.lookup);
        // Confirmations are always on screen (ADR-018): say so instead of waiting in silence.
        if (live && m.status === "waiting") this.speak(turn, PHRASES.confirm);
        return;
      case "chat.delta":
        turn.firstTokenAt ??= this.now();
        if (live) for (const p of turn.segmenter.push(m.text)) this.speak(turn, p);
        return;
      case "chat.done":
        turn.chatDone = true;
        if (live) {
          for (const p of turn.segmenter.flush()) this.speak(turn, p);
          turn.outcome ??= "done";
          this.end(turn);
        }
        return;
      case "error":
        if (m.id !== turn.chatMsgId || m.code === "cancelled") return;
        turn.chatDone = true;
        if (live) {
          turn.outcome = "error";
          const phrase = m.code === "budget_exceeded" ? PHRASES.budget : m.code === "upstream_error" ? PHRASES.upstream : PHRASES.generic;
          this.speak(turn, phrase);
          this.end(turn);
        }
        return;
      default:
        return;
    }
  }

  private speak(turn: Turn, text: string): void {
    this.voice({ type: "tts.speak", id: randomUUID(), turnId: turn.id, seq: turn.seq++, text: text.slice(0, 2_000), final: false });
  }

  private end(turn: Turn): void {
    if (turn.ended) return;
    turn.ended = true;
    this.voice({ type: "tts.end", id: randomUUID(), turnId: turn.id });
  }

  private finished(turnId: string, interrupted: boolean): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    if (this.armed?.turnId === turnId) this.disarm();
    const at = this.now();
    if (interrupted) turn.outcome = "interrupted";
    const diff = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined ? Math.max(0, a - b) : undefined);
    const metrics = {
      id: turn.id,
      conversationId: turn.conversationId,
      chatTurnId: turn.chatTurnId,
      outcome: turn.outcome ?? "done",
      audioMs: turn.audioMs,
      sttMs: turn.sttMs,
      ttftMs: diff(turn.firstTokenAt, turn.chatSentAt),
      firstAudioMs: diff(turn.firstAudioAt, turn.releasedAt),
      bargeInMs: diff(at, turn.bargeInAt),
      ttsEngine: turn.engine,
    };
    try {
      this.opts.metrics?.record(metrics);
    } catch (err) {
      this.logger.log("error", "voice.metrics_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    this.logger.log("info", "voice.turn_done", { ...metrics });
    if (turn === this.current) {
      this.current = undefined;
      this.setPhase(this.utterance ? this.phase : "idle");
    }
  }

  // ------------------------------------------------------------ helpers

  private voice(message: ToVoiceMessage): void {
    if (!this.opts.voice.send(message)) this.logger.log("warn", "voice.send_dropped", { type: message.type });
  }

  private stateMessage(id?: string, detail?: string): CoreMessage {
    return {
      type: "voice.state",
      ...(id ? { id } : {}),
      state: this.phase,
      micOpen: this.micOpen,
      ...(this.current?.conversationId ? { conversationId: this.current.conversationId } : {}),
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
    };
  }

  private setPhase(phase: VoiceStateName, detail?: string): void {
    this.phase = phase;
    this.broadcastState(detail);
  }

  private broadcastState(detail?: string): void {
    this.opts.broadcast(this.stateMessage(undefined, detail));
  }
}
