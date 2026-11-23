-- Phase 7 (ADR-026): proactivity with rules. Reminders exist only once the owner approved their
-- exact text and time; the daily briefing is composed locally (no model call) from Jarvis' own data.

CREATE TABLE reminders (
  id                      INTEGER PRIMARY KEY,
  text                    TEXT NOT NULL,
  due_at                  TEXT NOT NULL,  -- UTC ISO
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'cancelled')),
  source_conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  fired_at                TEXT
);
CREATE INDEX reminders_by_due ON reminders (status, due_at);

CREATE TABLE briefings (
  day         TEXT PRIMARY KEY,  -- local day
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
