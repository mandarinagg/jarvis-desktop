-- Phase 6 (ADR-024): memory that learns. Semantic memories (facts, preferences, procedures) and
-- ideas exist only once the owner approved them; episodes are automatic summaries with a TTL.
-- Everything is local, editable and deletable by the owner. Secrets are filtered before storing.

CREATE TABLE memories (
  id                      INTEGER PRIMARY KEY,
  kind                    TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'procedure', 'idea', 'episode')),
  text                    TEXT NOT NULL,
  project_id              TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source                  TEXT NOT NULL CHECK (source IN ('owner', 'reflection')),
  source_conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  idea_status             TEXT CHECK (idea_status IN ('nueva', 'en_curso', 'hecha', 'descartada')),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  expires_at              TEXT,
  last_used_at            TEXT,
  use_count               INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memories_by_kind ON memories (kind, status);
CREATE INDEX memories_by_created ON memories (created_at);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  text,
  content = 'memories', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memory_fts (rowid, text) VALUES (new.id, new.text);
END;

-- Which memories were put in front of the model on each turn ("¿por qué dijiste eso?").
CREATE TABLE memory_uses (
  turn_id          TEXT NOT NULL,
  memory_id        INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL,
  ts               TEXT NOT NULL,
  PRIMARY KEY (turn_id, memory_id)
);
CREATE INDEX memory_uses_by_conversation ON memory_uses (conversation_id, ts);

-- Candidate memories from the daily reflection, waiting for the owner (exit metric: >= 70% accepted).
CREATE TABLE memory_proposals (
  id                      INTEGER PRIMARY KEY,
  kind                    TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'procedure', 'idea')),
  text                    TEXT NOT NULL,
  reason                  TEXT NOT NULL DEFAULT '',
  project_id              TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source_conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  edited                  INTEGER NOT NULL DEFAULT 0,
  memory_id               INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  decided_at              TEXT
);
CREATE INDEX memory_proposals_by_status ON memory_proposals (status, created_at);

CREATE TABLE reflections (
  id             INTEGER PRIMARY KEY,
  day            TEXT NOT NULL,
  ran_at         TEXT NOT NULL,
  conversations  INTEGER NOT NULL DEFAULT 0,
  episodes       INTEGER NOT NULL DEFAULT 0,
  proposals      INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  error          TEXT
);
CREATE INDEX reflections_by_day ON reflections (day);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Thinking mode of a conversation (Phase 6): null = normal.
ALTER TABLE conversations ADD COLUMN thinking_mode TEXT CHECK (thinking_mode IN ('sparring', 'brainstorm', 'abogado')) ;
