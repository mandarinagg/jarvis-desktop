/**
 * The WhatsApp channel (ADR-029): Jarvis on the owner's own number, through the self-chat only.
 * Off by default. Every message the account receives passes `screen` first; anything that is not
 * the owner writing to themselves, live and recent, is dropped there, without storing or logging
 * it. Accepted messages run as regular chat turns with the `whatsapp` channel: confirmations stay
 * on the PC and replies go only to the self-chat, after the secrets filter.
 *
 * Voice notes (ADR-030): "if you talk to him, he talks back". An accepted note is downloaded,
 * transcribed locally by the voice service and run as a spoken turn; the reply goes as a voice
 * note with the same text below it. A text message still gets text only.
 */
import { randomUUID } from "node:crypto";
import { type ChatSend, type CoreMessage, MAX_NOTE_BYTES, MAX_RENDER_CHARS } from "@jarvis/shared";
import type { ChatMode } from "../chat.js";
import { type Logger, silentLogger } from "../log.js";
import type { Session } from "../server.js";
import { VoiceNoteError, type VoiceNotesPort } from "../voice/notes.js";
import type { WhatsAppAuthStore } from "./auth-store.js";
import { TtlCache } from "./baileys-provider.js";
import { composeTurn, prepareOutgoing, screen } from "./filter.js";
import { phoneOf, type WaAudio, type WaConnection, type WaIncoming, type WaProvider, type WaSelf } from "./provider.js";

export type WhatsAppState = "off" | "connecting" | "waiting_qr" | "connected" | "degraded";

export interface WhatsAppStatus {
  state: WhatsAppState;
  /** Current QR while linking (expires in seconds). */
  qr?: string | undefined;
  phone?: string | undefined;
  detail?: string | undefined;
  /** Messages from other chats dropped since start: a count, never their content. */
  discarded: number;
}

export interface ChatPort {
  chatSend(session: Session, msg: ChatSend, mode: ChatMode, opts?: { spoken?: boolean }): Promise<void>;
}

/** Longest voice note Jarvis listens to (ADR-030). */
export const MAX_NOTE_SECONDS = 120;

export interface WhatsAppChannelOptions {
  provider: WaProvider;
  auth: WhatsAppAuthStore;
  chat: ChatPort;
  /** Voice notes in and out (ADR-030). Without it, or with the voice service down, notes get a notice. */
  voice?: VoiceNotesPort;
  /** Persisted on/off switch (settings `whatsapp.enabled`). */
  enabled: { get(): boolean; set(on: boolean): void };
  /** Status changes, for the desktop app. */
  onStatus?: (s: WhatsAppStatus) => void;
  /** Chat events of WhatsApp turns, so an open window shows them live (like voice turns). */
  broadcast?: (m: CoreMessage) => void;
  /** Is there a window on the PC that can show a confirmation (desktop or CLI)? */
  canConfirm?: () => boolean;
  /** Owner messages per rolling hour before the channel goes quiet. */
  perHour?: number;
  /** A message within this time of the last one continues the same conversation. */
  conversationIdleMs?: number;
  logger?: Logger;
  now?: () => Date;
  /** Reconnection delays (ms), the last one repeats. */
  backoffMs?: number[];
}

export const WHATSAPP_SESSION_ID = "whatsapp";

export const TEXTS = {
  confirmOnPc: "Te dejé la confirmación en la pantalla de la PC. Desde acá no se aprueba nada.",
  noScreen: "Esto pide tu confirmación, pero no hay una ventana de Jarvis abierta en la PC: lo dejo para cuando estés ahí.",
  mediaOnly: "Por ahora leo texto y escucho notas de voz, pero esto no lo puedo abrir: escribime el pedido.",
  voiceOff: "No puedo escuchar notas de voz ahora: el servicio de voz no está andando. Escribime.",
  noteTooLong: "La nota de voz es muy larga: escucho hasta 2 minutos. Mandámela más corta o escribime.",
  noteEmpty: "No entendí nada en la nota de voz. ¿Me la repetís o me escribís?",
  noteFailed: "No pude escuchar la nota de voz. Probá de nuevo o escribime.",
  voiceReplyFailed: "No pude grabar la respuesta en audio, así que va solo por escrito.",
  stale: "Ese mensaje me llegó tarde, así que no lo ejecuto: repetímelo si sigue en pie.",
  rateLimited: "Llegamos al tope de mensajes por esta hora. Sigo en un rato o en la PC.",
  sensitive: "La respuesta tiene algo que no conviene mandar por acá. Te lo muestro en la PC.",
  budget: "Llegamos al tope de gasto de hoy. Seguimos mañana o subilo en la PC.",
  upstream: "No pude hablar con Claude ahora. Probá en un rato.",
  generic: "Algo falló de mi lado. Probá de nuevo.",
} as const;

const HOUR = 3_600_000;

export class WhatsAppChannel {
  private conn: WaConnection | undefined;
  private auth: WhatsAppAuthStore | undefined;
  private self: WaSelf | undefined;
  private status: WhatsAppStatus = { state: "off", discarded: 0 };
  private readonly sentIds = new TtlCache(30 * 60_000, 1_000);
  private accepted: number[] = [];
  private rateNoticeAt = 0;
  private staleNoticeAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private failures = 0;
  private retry: NodeJS.Timeout | undefined;
  private lastConversation: { id: string; at: number } | undefined;
  private stopping = false;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly opts: WhatsAppChannelOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? (() => new Date());
  }

  get current(): WhatsAppStatus {
    return { ...this.status, phone: this.status.phone ?? this.opts.auth.phone() };
  }

  /** On Core start: reconnect only if the owner turned it on and a session exists. */
  async resume(): Promise<void> {
    if (this.opts.enabled.get() && this.opts.auth.linked()) await this.connect();
  }

  /** «Vincular WhatsApp»: turns the channel on and opens a session (a QR if not linked). */
  async link(): Promise<void> {
    this.opts.enabled.set(true);
    if (this.conn) return;
    await this.connect();
  }

  /** «Desvincular»: unlinks in WhatsApp, deletes the session and turns the channel off. */
  async unlink(): Promise<void> {
    this.opts.enabled.set(false);
    this.clearRetry();
    const conn = this.conn;
    this.drop();
    try {
      await conn?.logout();
    } catch (err) {
      this.logger.log("warn", "whatsapp.logout_failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
    this.opts.auth.clear();
    this.setStatus({ state: "off", discarded: this.status.discarded });
  }

  /** Core shutdown: closes the socket, keeps the session linked. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRetry();
    const conn = this.conn;
    this.drop();
    await conn?.stop().catch(() => undefined);
    await this.queue;
  }

  private async connect(): Promise<void> {
    this.clearRetry();
    this.auth?.revoke();
    const auth = this.opts.auth.fork();
    this.auth = auth;
    this.setStatus({ ...this.status, state: "connecting", qr: undefined, detail: undefined });
    try {
      const conn = await this.opts.provider.start(auth, {
        qr: (qr) => {
          if (this.auth !== auth) return;
          this.setStatus({ ...this.status, state: "waiting_qr", qr });
        },
        connected: (self) => {
          if (this.auth !== auth) return;
          this.self = self;
          this.failures = 0;
          auth.setPhone(phoneOf(self));
          this.setStatus({ ...this.status, state: "connected", qr: undefined, detail: undefined, phone: phoneOf(self) });
          this.logger.log("info", "whatsapp.connected");
        },
        closed: (reason, detail) => {
          if (this.auth !== auth) return;
          this.closed(reason, detail);
        },
        message: (m) => {
          if (this.auth !== auth) return;
          this.incoming(m);
        },
      });
      if (this.auth !== auth) await conn.stop(); // unlinked or replaced while opening
      else this.conn = conn;
    } catch (err) {
      if (this.auth !== auth) return;
      this.closed("error", err instanceof Error ? err.message.slice(0, 200) : String(err));
    }
  }

  private closed(reason: "logged_out" | "qr_timeout" | "error", detail: string): void {
    this.drop();
    this.logger.log("warn", "whatsapp.closed", { reason, detail });
    if (this.stopping) return;
    if (reason === "logged_out") {
      // Unlinked from the phone: same as «Desvincular» (ADR-029).
      this.opts.auth.clear();
      this.opts.enabled.set(false);
      return this.setStatus({ state: "off", detail, discarded: this.status.discarded });
    }
    if (reason === "qr_timeout") {
      // Nobody scanned: stop trying until the owner asks again.
      this.opts.enabled.set(false);
      return this.setStatus({ state: "off", detail, discarded: this.status.discarded });
    }
    const delays = this.opts.backoffMs ?? [2_000, 5_000, 15_000, 30_000, 60_000, 300_000];
    const wait = delays[Math.min(this.failures, delays.length - 1)] ?? 60_000;
    this.failures += 1;
    this.setStatus({ ...this.status, state: this.failures > 2 ? "degraded" : "connecting", qr: undefined, detail });
    this.retry = setTimeout(() => void this.connect(), wait);
    this.retry.unref?.();
  }

  private drop(): void {
    this.auth?.revoke();
    this.auth = undefined;
    this.conn = undefined;
    this.self = undefined;
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  private setStatus(s: WhatsAppStatus): void {
    this.status = s;
    this.opts.onStatus?.(this.current);
  }

  /** Every message the account receives lands here. Other chats leave no trace but a counter. */
  private incoming(m: WaIncoming): void {
    const self = this.self;
    if (!self) return;
    const verdict = screen(m, self, { now: this.now(), isOwnEcho: (id) => this.sentIds.get(id) !== undefined });
    if (!verdict.accept) {
      if (verdict.reason === "other_chat" || verdict.reason === "not_from_me") {
        this.status.discarded += 1;
        return;
      }
      if (verdict.reason === "stale") this.enqueue(() => this.staleNotice());
      return;
    }
    this.enqueue(() => this.turn(m));
  }

  /** One turn at a time, in arrival order. */
  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch((err: unknown) => {
      this.logger.log("error", "whatsapp.turn_failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    });
  }

  private async staleNotice(): Promise<void> {
    const t = this.now().getTime();
    if (t - this.staleNoticeAt < 10 * 60_000) return;
    this.staleNoticeAt = t;
    await this.reply(TEXTS.stale);
  }

  private async turn(m: WaIncoming): Promise<void> {
    const t = this.now().getTime();
    this.accepted = this.accepted.filter((x) => t - x < HOUR);
    const perHour = this.opts.perHour ?? 30;
    if (this.accepted.length >= perHour) {
      if (t - this.rateNoticeAt >= HOUR) {
        this.rateNoticeAt = t;
        await this.reply(TEXTS.rateLimited);
      }
      return;
    }
    this.accepted.push(t);

    // Voice note: heard locally first. Only the owner's own voice gets a voice reply; a forwarded
    // note was spoken by someone else, so it is data and the answer goes in text.
    let source = m;
    let spoken = false;
    if (m.audio) {
      const heard = await this.listen(m.audio);
      if (!heard.ok) return this.reply(heard.notice);
      source = { ...m, text: heard.text };
      spoken = m.audio.ptt && !m.forwarded;
    }
    const text = composeTurn(source);
    if (!text) return this.reply(m.media ? TEXTS.mediaOnly : TEXTS.generic);

    const idle = this.opts.conversationIdleMs ?? 2 * HOUR;
    const conversationId = this.lastConversation && t - this.lastConversation.at < idle ? this.lastConversation.id : undefined;
    const msg: ChatSend = { type: "chat.send", id: randomUUID(), text, ...(conversationId ? { conversationId } : {}) };
    let reply = "";
    let error: string | undefined;
    const pending: Promise<void>[] = [];
    const session: Session = {
      id: WHATSAPP_SESSION_ID,
      client: "whatsapp",
      close: () => {},
      send: (e: CoreMessage) => {
        this.opts.broadcast?.(e);
        switch (e.type) {
          case "chat.started":
            this.lastConversation = { id: e.conversationId, at: t };
            return;
          case "chat.delta":
            reply += e.text;
            return;
          case "chat.tool":
            if (e.status === "waiting") pending.push(this.reply(this.opts.canConfirm?.() === false ? TEXTS.noScreen : TEXTS.confirmOnPc));
            return;
          case "error":
            if (e.id === msg.id) error = e.code;
            return;
          default:
            return;
        }
      },
    };
    await this.opts.chat.chatSend(session, msg, "whatsapp", spoken ? { spoken } : undefined);
    await Promise.all(pending);
    if (this.lastConversation) this.lastConversation.at = this.now().getTime();
    if (error) {
      if (error === "cancelled") return;
      return this.reply(error === "budget_exceeded" ? TEXTS.budget : error === "upstream_error" ? TEXTS.upstream : TEXTS.generic);
    }
    const out = prepareOutgoing(reply);
    if (!out.ok) {
      if (out.reason !== "empty") {
        this.logger.log("info", "whatsapp.reply_withheld", { reason: out.reason });
        await this.reply(TEXTS.sensitive);
      }
      return;
    }
    // The text passed the secrets filter above, so it may also be spoken. Note first, text below.
    const voiceFailed = spoken ? !(await this.speak(reply.trim())) : false;
    for (const chunk of out.chunks) await this.send(chunk);
    if (voiceFailed) await this.reply(TEXTS.voiceReplyFailed);
  }

  /** Download and transcribe an accepted note. Never logs what was said. */
  private async listen(a: WaAudio): Promise<{ ok: true; text: string } | { ok: false; notice: string }> {
    const voice = this.opts.voice;
    if (!voice?.available()) return { ok: false, notice: TEXTS.voiceOff };
    // WhatsApp's metadata first: an oversized note is refused before anything is downloaded.
    if (a.seconds > MAX_NOTE_SECONDS || a.bytes > MAX_NOTE_BYTES) return { ok: false, notice: TEXTS.noteTooLong };
    const started = this.now().getTime();
    try {
      const data = await a.download();
      if (data.length > MAX_NOTE_BYTES) return { ok: false, notice: TEXTS.noteTooLong };
      const text = await voice.transcribe(data);
      this.logger.log("info", "whatsapp.note_heard", { seconds: a.seconds, ms: this.now().getTime() - started, chars: text.length });
      return text ? { ok: true, text } : { ok: false, notice: TEXTS.noteEmpty };
    } catch (err) {
      const reason = err instanceof VoiceNoteError ? err.reason : "download";
      this.logger.log("warn", "whatsapp.note_failed", { reason, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      return { ok: false, notice: reason === "unavailable" ? TEXTS.voiceOff : reason === "too_large" ? TEXTS.noteTooLong : TEXTS.noteFailed };
    }
  }

  /** The reply as a voice note. False when it could not be made (the text still goes). */
  private async speak(text: string): Promise<boolean> {
    const voice = this.opts.voice;
    const spoken = forSpeech(text);
    if (!voice?.available() || !spoken) return false;
    if (spoken.length > MAX_RENDER_CHARS) return true; // a long reply is read, not heard: no notice
    try {
      const note = await voice.render(spoken);
      const conn = this.conn;
      const self = this.self;
      if (!conn || !self) return false;
      const { id } = await conn.sendVoiceNote(self.jid, note.audio, note.durationMs / 1000);
      if (id) this.sentIds.set(id, true);
      return true;
    } catch (err) {
      this.logger.log("warn", "whatsapp.voice_reply_failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      return false;
    }
  }

  /** A fixed text of the channel (already safe), with the prefix. */
  private async reply(text: string): Promise<void> {
    const out = prepareOutgoing(text);
    if (out.ok) for (const chunk of out.chunks) await this.send(chunk);
  }

  /** The only way out: to the self-chat, nowhere else (ADR-029). */
  private async send(text: string): Promise<void> {
    const conn = this.conn;
    const self = this.self;
    if (!conn || !self) return;
    const { id } = await conn.sendText(self.jid, text);
    if (id) this.sentIds.set(id, true);
  }
}

/** WhatsApp formatting is for the eyes: no asterisks, underscores or list dashes read aloud. */
export function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_~`]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}
