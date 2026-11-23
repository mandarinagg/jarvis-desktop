/**
 * The linked-device session (ADR-029), sealed in the local DB: credentials in `whatsapp_session`,
 * each Signal key in `whatsapp_keys`. AES-256-GCM with a 32-byte key that lives only in Credential
 * Manager (`whatsapp-session-key`); the context (AAD) binds a value to its row, so a value copied
 * elsewhere does not open. No session folder on disk.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SecretStore } from "../secrets.js";
import type { WaAuthState } from "./provider.js";

const KEY_NAME = "whatsapp-session-key";
const CREDS_CONTEXT = "whatsapp:creds";
const keyContext = (type: string, id: string) => `whatsapp:key:${type}:${id}`;

/** The session key, created on first use. */
export function sessionKey(secrets: SecretStore): Buffer {
  let b64 = secrets.get(KEY_NAME);
  if (!b64) {
    b64 = randomBytes(32).toString("base64");
    secrets.set(KEY_NAME, b64);
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("whatsapp-session-key tiene que ser de 32 bytes en base64");
  return key;
}

/** `v1:iv:tag:data`, each part base64. */
export function seal(plain: string, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function open(sealed: string, key: Buffer, context: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("secreto con formato desconocido");
  const ivBytes = Buffer.from(iv, "base64");
  const tagBytes = Buffer.from(tag, "base64");
  // Fixed lengths: Node would accept truncated GCM tags (easier to forge).
  if (ivBytes.length !== 12 || tagBytes.length !== 16) throw new Error("secreto alterado");
  const decipher = createDecipheriv("aes-256-gcm", key, ivBytes, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export class WhatsAppAuthStore implements WaAuthState {
  /** A stale connection (unlinked or replaced) no longer writes the session. */
  private revoked = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly key: () => Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A fresh handle for a new connection; the previous one is revoked by the caller. */
  fork(): WhatsAppAuthStore {
    return new WhatsAppAuthStore(this.db, this.key, this.now);
  }

  revoke(): void {
    this.revoked = true;
  }

  linked(): boolean {
    const row = this.db.prepare("SELECT creds FROM whatsapp_session WHERE id = 1").get() as { creds: string | null } | undefined;
    return Boolean(row?.creds);
  }

  phone(): string | undefined {
    const row = this.db.prepare("SELECT phone FROM whatsapp_session WHERE id = 1").get() as { phone: string | null } | undefined;
    return row?.phone ?? undefined;
  }

  setPhone(phone: string): void {
    if (this.revoked) return;
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO whatsapp_session (id, phone, linked_at, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET phone = excluded.phone, linked_at = COALESCE(whatsapp_session.linked_at, excluded.linked_at), updated_at = excluded.updated_at`,
      )
      .run(phone, now, now);
  }

  readCreds(): string | null {
    const row = this.db.prepare("SELECT creds FROM whatsapp_session WHERE id = 1").get() as { creds: string | null } | undefined;
    return row?.creds ? open(row.creds, this.key(), CREDS_CONTEXT) : null;
  }

  writeCreds(json: string): void {
    if (this.revoked) return;
    const sealed = seal(json, this.key(), CREDS_CONTEXT);
    this.db
      .prepare(
        `INSERT INTO whatsapp_session (id, creds, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET creds = excluded.creds, updated_at = excluded.updated_at`,
      )
      .run(sealed, this.now().toISOString());
  }

  readKeys(type: string, ids: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const get = this.db.prepare("SELECT value FROM whatsapp_keys WHERE type = ? AND key_id = ?");
    for (const id of ids) {
      const row = get.get(type, id) as { value: string } | undefined;
      if (row) out[id] = open(row.value, this.key(), keyContext(type, id));
    }
    return out;
  }

  /** Writes (or deletes, with null) several keys in one transaction. */
  writeKeys(data: Record<string, Record<string, string | null>>): void {
    if (this.revoked) return;
    const key = this.key();
    const del = this.db.prepare("DELETE FROM whatsapp_keys WHERE type = ? AND key_id = ?");
    const put = this.db.prepare(
      "INSERT INTO whatsapp_keys (type, key_id, value) VALUES (?, ?, ?) ON CONFLICT(type, key_id) DO UPDATE SET value = excluded.value",
    );
    this.db.exec("BEGIN");
    try {
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) del.run(type, id);
          else put.run(type, id, seal(value, key, keyContext(type, id)));
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Unlinked: the whole session goes; linking again needs a new QR. */
  clear(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM whatsapp_keys");
      this.db.exec("DELETE FROM whatsapp_session");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
