/**
 * WhatsApp through Baileys (ADR-029), adapted from the owner's CRM (`apps/api/src/whatsapp/`).
 * Unofficial client: WhatsApp may restrict the number; the owner accepted that risk. Differences
 * with the CRM: one account (the owner's), text only (no media download), a logger that never
 * writes message data, and a send guard that only reaches the self-chat.
 */
import makeWASocket, {
  type AuthenticationCreds,
  Browsers,
  BufferJSON,
  type CacheStore,
  DisconnectReason,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type MessageUpsertType,
  proto,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type WAMessage,
} from "baileys";
import { type Logger, redact } from "../log.js";
import { isSelfChat } from "./filter.js";
import { bareJid, type WaAuthState, type WaConnection, type WaEvents, type WaIncoming, type WaMediaKind, type WaProvider, type WaSelf } from "./provider.js";

/** The real content of an ephemeral, view-once or captioned-document message. */
const innerOf = (message: proto.IMessage): proto.IMessage =>
  message.ephemeralMessage?.message ??
  message.viewOnceMessage?.message ??
  message.viewOnceMessageV2?.message ??
  message.documentWithCaptionMessage?.message ??
  message.ephemeralMessage?.message?.documentWithCaptionMessage?.message ??
  message;

/** Plain text of a message (text or caption), or null. Used for the message and for quotes. */
export function textOf(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;
  const inner = innerOf(message);
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    null
  );
}

function mediaOf(inner: proto.IMessage): WaMediaKind | undefined {
  if (inner.conversation || inner.extendedTextMessage) return undefined;
  if (inner.imageMessage) return "image";
  if (inner.videoMessage) return "video";
  if (inner.audioMessage) return "audio";
  if (inner.documentMessage) return "document";
  if (inner.stickerMessage) return "sticker";
  return "other";
}

function contextOf(inner: proto.IMessage): proto.IContextInfo | null | undefined {
  return (
    inner.extendedTextMessage?.contextInfo ??
    inner.imageMessage?.contextInfo ??
    inner.videoMessage?.contextInfo ??
    inner.documentMessage?.contextInfo ??
    inner.audioMessage?.contextInfo
  );
}

/** Baileys message → channel message; null for groups, broadcasts, statuses and protocol messages. */
export function toIncoming(m: WAMessage, type: MessageUpsertType): WaIncoming | null {
  const remoteJid = m.key.remoteJid;
  const id = m.key.id;
  if (!remoteJid || !id || !m.message) return null;
  if (!remoteJid.endsWith("@s.whatsapp.net") && !remoteJid.endsWith("@lid")) return null;
  const inner = innerOf(m.message);
  // Reactions, edits, deletions, key distribution: not something the owner wrote.
  if (inner.protocolMessage || inner.reactionMessage || inner.senderKeyDistributionMessage) return null;
  const ctx = contextOf(inner);
  const seconds = Number(m.messageTimestamp ?? 0);
  const quoted = textOf(ctx?.quotedMessage);
  return {
    id,
    remoteJid,
    fromMe: m.key.fromMe === true,
    kind: type === "notify" ? "notify" : "history",
    at: seconds > 0 ? new Date(seconds * 1000) : new Date(),
    text: textOf(m.message),
    media: mediaOf(inner),
    forwarded: ctx?.isForwarded === true,
    ...(quoted ? { quoted } : {}),
  };
}

/** Why the socket closed, from Baileys' status code. `registered`: the session was already linked. */
export function closeReason(code: number | undefined, registered: boolean): { reason: "logged_out" | "qr_timeout" | "error"; detail: string } {
  if (code === DisconnectReason.loggedOut) return { reason: "logged_out", detail: "WhatsApp desvinculó a Jarvis" };
  if (code === DisconnectReason.timedOut && !registered) return { reason: "qr_timeout", detail: "El QR venció sin escanearse" };
  if (code === DisconnectReason.restartRequired) return { reason: "error", detail: "Reiniciando la conexión después de vincular" };
  if (code === DisconnectReason.connectionReplaced) return { reason: "error", detail: "Otra conexión abrió esta sesión" };
  return { reason: "error", detail: `Se cortó la conexión con WhatsApp${code ? ` (${code})` : ""}` };
}

/**
 * How the linked device presents itself. "Chrome" registers as WhatsApp Web; the CRM found that
 * Business numbers in coexistence with the Cloud API don't encrypt messages for "Desktop".
 */
export const LINKED_BROWSER = Browsers.ubuntu("Chrome");

/** In-memory cache with expiry, reused across reconnections (Baileys' caches). */
export class TtlCache implements CacheStore {
  private readonly data = new Map<string, { value: unknown; until: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string): T | undefined {
    const hit = this.data.get(key);
    if (!hit) return undefined;
    if (hit.until <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return hit.value as T;
  }
  set<T>(key: string, value: T): void {
    if (this.data.size >= this.max && !this.data.has(key)) {
      const oldest = this.data.keys().next().value;
      if (oldest !== undefined) this.data.delete(oldest);
    }
    this.data.set(key, { value, until: this.now() + this.ttlMs });
  }
  del(key: string): void {
    this.data.delete(key);
  }
  flushAll(): void {
    this.data.clear();
  }
}

/** Signal keys over the sealed store (JSON with Baileys' Buffers). */
export function signalKeys(auth: WaAuthState): SignalKeyStore {
  return {
    get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const [id, json] of Object.entries(auth.readKeys(type, ids))) {
        let value: unknown = JSON.parse(json, BufferJSON.reviver);
        if (type === "app-state-sync-key") value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
        out[id] = value as SignalDataTypeMap[T];
      }
      return Promise.resolve(out);
    },
    set: (data: SignalDataSet) => {
      const plain: Record<string, Record<string, string | null>> = {};
      for (const [type, entries] of Object.entries(data)) {
        const row: Record<string, string | null> = {};
        for (const [id, value] of Object.entries(entries ?? {})) row[id] = value ? JSON.stringify(value, BufferJSON.replacer) : null;
        plain[type] = row;
      }
      auth.writeKeys(plain);
      return Promise.resolve();
    },
  };
}

interface BaileysLogger {
  level: string;
  child(obj: Record<string, unknown>): BaileysLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Baileys logs frames and message payloads at debug/trace level. Only warnings and errors pass,
 * and only their text plus an error message: never the object, which may carry message data.
 */
export function baileysLogger(logger: Logger): BaileysLogger {
  const out = (level: "warn" | "error") => (obj: unknown, msg?: string) => {
    const err = (obj as { err?: unknown } | undefined)?.err;
    const error = err instanceof Error ? redact(err.message).slice(0, 200) : undefined;
    logger.log(level, "whatsapp.baileys", { text: typeof msg === "string" ? redact(msg).slice(0, 200) : typeof obj === "string" ? redact(obj).slice(0, 200) : undefined, error });
  };
  const self: BaileysLogger = {
    level: "warn",
    child: () => self,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: out("warn"),
    error: out("error"),
  };
  return self;
}

/** The linked account from the socket's user, falling back to the saved credentials. */
export function selfOf(
  user: { id?: string | null; lid?: string | null } | undefined,
  me: { id?: string | null; lid?: string | null } | undefined,
): WaSelf | undefined {
  const jid = bareJid(user?.id ?? me?.id);
  if (!jid) return undefined;
  return { jid, lid: bareJid(user?.lid ?? me?.lid) };
}

const MINUTE = 60_000;

export class BaileysProvider implements WaProvider {
  private readonly caches = {
    msgRetry: new TtlCache(60 * MINUTE),
    userDevices: new TtlCache(5 * MINUTE),
    callOffer: new TtlCache(5 * MINUTE),
    placeholderResend: new TtlCache(60 * MINUTE),
    signal: new TtlCache(5 * MINUTE),
  };
  /** What Jarvis sent, for WhatsApp's re-send requests (a recipient device that failed to decrypt). */
  private readonly sent = new TtlCache(60 * MINUTE, 500);

  constructor(private readonly logger: Logger) {}

  start(auth: WaAuthState, events: WaEvents): Promise<WaConnection> {
    const saved = auth.readCreds();
    const creds: AuthenticationCreds = saved ? (JSON.parse(saved, BufferJSON.reviver) as AuthenticationCreds) : initAuthCreds();
    const logger = baileysLogger(this.logger);
    let self: WaSelf | undefined;
    const sock = makeWASocket({
      auth: { creds, keys: makeCacheableSignalKeyStore(signalKeys(auth), logger, this.caches.signal) },
      logger,
      browser: LINKED_BROWSER,
      // The owner must not show "online" because of Jarvis.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      printQRInTerminal: false,
      emitOwnEvents: false,
      // No link previews, no media: nothing is fetched on the owner's behalf.
      generateHighQualityLinkPreview: false,
      // Other chats' history is never needed: skip the sync entirely.
      shouldSyncHistoryMessage: () => false,
      msgRetryCounterCache: this.caches.msgRetry,
      userDevicesCache: this.caches.userDevices,
      callOfferCache: this.caches.callOffer,
      placeholderResendCache: this.caches.placeholderResend,
      getMessage: (key) => {
        const text = key.id ? this.sent.get<string>(key.id) : undefined;
        return Promise.resolve(text === undefined ? undefined : proto.Message.fromObject({ conversation: text }));
      },
    });
    const guard = (what: string, run: () => void) => {
      try {
        run();
      } catch (err) {
        this.logger.log("error", "whatsapp.event_failed", { what, error: err instanceof Error ? redact(err.message).slice(0, 200) : String(err) });
      }
    };
    // Right after linking, WhatsApp may report the account's LID after the socket opened. The
    // self-chat often arrives by LID, so the identity is refreshed whenever it changes.
    const refreshSelf = () => {
      if (!self) return;
      const next = selfOf(sock.user, creds.me);
      if (next && (next.jid !== self.jid || next.lid !== self.lid)) {
        self = next;
        const linked = self;
        guard("identity", () => events.connected(linked));
      }
    };
    // Baileys updates `creds` in place: the whole object is saved.
    sock.ev.on("creds.update", () => {
      guard("creds", () => auth.writeCreds(JSON.stringify(creds, BufferJSON.replacer)));
      refreshSelf();
    });
    sock.ev.on("connection.update", (u) => {
      if (u.qr) {
        const qr = u.qr;
        guard("qr", () => events.qr(qr));
      }
      if (u.connection === "open") {
        const found = selfOf(sock.user, creds.me);
        if (!found) return guard("open", () => events.closed("error", "WhatsApp no informó el número vinculado"));
        self = found;
        guard("open", () => events.connected(found));
      }
      if (u.connection === "close") {
        const error = u.lastDisconnect?.error as (Error & { output?: { statusCode?: number } }) | undefined;
        const { reason, detail } = closeReason(error?.output?.statusCode, Boolean(creds.me));
        guard("close", () => events.closed(reason, detail));
      }
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      refreshSelf();
      for (const m of messages) {
        const incoming = toIncoming(m, type);
        if (incoming) guard("message", () => events.message(incoming));
      }
    });
    return Promise.resolve({
      sendText: async (jid, text) => {
        // Second barrier after the channel's: nothing ever goes to a contact (ADR-029).
        if (!self || !isSelfChat(jid, self)) throw new Error("WhatsApp: solo se envía al chat propio del owner");
        const sent = await sock.sendMessage(self.jid, { text });
        const id = sent?.key.id ?? "";
        if (id) this.sent.set(id, text);
        return { id };
      },
      stop: () => {
        sock.end(undefined);
        return Promise.resolve();
      },
      logout: async () => {
        try {
          await sock.logout();
        } finally {
          sock.end(undefined);
        }
      },
    });
  }
}
