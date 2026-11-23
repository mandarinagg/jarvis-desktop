-- Phase 7 (ADR-029): WhatsApp client on the owner's own number.
-- Which channel a tool call came from (text, voice, whatsapp); null for older rows.
ALTER TABLE audit_log ADD COLUMN channel TEXT;

-- The linked-device session. Credentials and Signal keys are AES-256-GCM sealed with a key that
-- lives in Credential Manager (whatsapp-session-key); the context (AAD) binds each value to its row.
CREATE TABLE whatsapp_session (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  creds       TEXT,           -- sealed JSON, null = not linked
  phone       TEXT,           -- linked number (digits), shown in the app
  linked_at   TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE whatsapp_keys (
  type    TEXT NOT NULL,
  key_id  TEXT NOT NULL,
  value   TEXT NOT NULL,      -- sealed JSON
  PRIMARY KEY (type, key_id)
);
