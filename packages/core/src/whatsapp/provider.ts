/**
 * WhatsApp client behind a small interface (ADR-029), as in the owner's CRM: the Baileys
 * implementation can be swapped for the official API without touching the channel, and tests use
 * a fake provider (never the network).
 */

/** Kind of non-text content. Jarvis reads text and listens to voice notes (ADR-029, ADR-030). */
export type WaMediaKind = "image" | "video" | "audio" | "document" | "sticker" | "other";

/** A message from a one-to-one chat, as the provider saw it. Nothing here is trusted. */
export interface WaIncoming {
  /** WhatsApp message id. */
  id: string;
  remoteJid: string;
  /** Written from the owner's own account (any of their devices). */
  fromMe: boolean;
  /** `notify`: arrived live. `history`: sync or append, never processed. */
  kind: "notify" | "history";
  at: Date;
  /** The text, or the caption of a media message; null when there is none. */
  text: string | null;
  media?: WaMediaKind | undefined;
  /** Forwarded from another chat: someone else wrote it. */
  forwarded: boolean;
  /** Text of the message it replies to, if any (may be someone else's). */
  quoted?: string | undefined;
  /**
   * An audio message (ADR-030). Metadata come with the message; the bytes are fetched from
   * WhatsApp only when the channel calls `download`, after `screen` accepted the message.
   */
  audio?: WaAudio | undefined;
}

export interface WaAudio {
  /** Recorded with the mic in WhatsApp (a voice note), not an attached audio file. */
  ptt: boolean;
  /** As WhatsApp reports them (0 when unknown). */
  seconds: number;
  bytes: number;
  mimetype?: string | undefined;
  download(): Promise<Buffer>;
}

/** The linked account: its phone JID and, when WhatsApp reports it, its LID. */
export interface WaSelf {
  /** `<digits>@s.whatsapp.net`, without the device suffix. */
  jid: string;
  /** `<id>@lid`, without the device suffix. */
  lid?: string | undefined;
}

/** Linked-device credentials and Signal keys, as JSON text (the store seals them). */
export interface WaAuthState {
  readCreds(): string | null;
  writeCreds(json: string): void;
  readKeys(type: string, ids: readonly string[]): Record<string, string>;
  writeKeys(data: Record<string, Record<string, string | null>>): void;
}

/**
 * Signs that end-to-end encryption with the owner's phone is broken: the phone asked Jarvis to
 * resend a message it couldn't decrypt, gave up on one (it stays "Esperando este mensaje"), or an
 * incoming message couldn't be decrypted. Only the kind, never the message.
 */
export type WaHealthSignal = "retry_requested" | "retry_exhausted" | "decrypt_failed";

export interface WaEvents {
  /** A new QR to link (it expires in seconds and another one arrives). */
  qr(qr: string): void;
  connected(self: WaSelf): void;
  /**
   * `logged_out`: unlinked (from the phone or here), the session is gone.
   * `qr_timeout`: nobody scanned the QR. `error`: dropped; the channel retries with backoff.
   */
  closed(reason: "logged_out" | "qr_timeout" | "error", detail: string): void;
  message(m: WaIncoming): void;
  health?(signal: WaHealthSignal): void;
}

export interface WaConnection {
  sendText(jid: string, text: string): Promise<{ id: string }>;
  /** An Ogg Opus voice note (`ptt`), same guard as `sendText`: the self-chat only. */
  sendVoiceNote(jid: string, audio: Buffer, seconds: number): Promise<{ id: string }>;
  /** Closes the socket, keeping the session linked. */
  stop(): Promise<void>;
  /** Unlinks this device in WhatsApp. */
  logout(): Promise<void>;
}

export interface WaProvider {
  start(auth: WaAuthState, events: WaEvents): Promise<WaConnection>;
}

/** `595981000000:12@s.whatsapp.net` → `595981000000@s.whatsapp.net`; same for `…@lid`. */
export function bareJid(jid: string | undefined | null): string | undefined {
  if (!jid) return undefined;
  const at = jid.indexOf("@");
  if (at <= 0) return undefined;
  const user = jid.slice(0, at).split(":")[0];
  return user ? `${user}${jid.slice(at)}` : undefined;
}

/** Digits of the linked number, for the app ("595981000000"). */
export function phoneOf(self: WaSelf): string {
  return self.jid.split("@")[0] ?? "";
}
