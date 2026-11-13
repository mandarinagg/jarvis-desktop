-- Phase 1: conversations, messages and per-turn usage (cost meter + daily cap).

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id          TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  interrupted      INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0, 1)),
  seq              INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX messages_by_conversation ON messages (conversation_id, seq);

CREATE TABLE usage (
  turn_id             TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL,
  output_tokens       INTEGER NOT NULL,
  cache_read_tokens   INTEGER NOT NULL,
  cache_write_tokens  INTEGER NOT NULL,
  cost_usd            REAL NOT NULL,
  day                 TEXT NOT NULL, -- local calendar day (YYYY-MM-DD) for the daily cap
  created_at          TEXT NOT NULL
);
CREATE INDEX usage_by_day ON usage (day);
