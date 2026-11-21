-- Phase 7 (ADR-027): skills Jarvis proposes. A skill is a reusable procedure (when to use it +
-- steps) over the tools Jarvis already has; it never adds tools or permissions. It becomes active
-- only after its own evals passed on the exact text and the owner approved it in a native dialog.

CREATE TABLE skill_proposals (
  id                      INTEGER PRIMARY KEY,
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL,
  body                    TEXT NOT NULL,
  cases                   TEXT NOT NULL,           -- JSON [{prompt, rubric[]}]
  reason                  TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  eval                    TEXT,                    -- JSON of the last evaluation
  eval_sha                TEXT,                    -- sha of the text that evaluation ran on
  source_conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  decided_at              TEXT
);
CREATE INDEX skill_proposals_by_status ON skill_proposals (status, created_at);

CREATE TABLE skills (
  name          TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  body          TEXT NOT NULL,
  sha           TEXT NOT NULL,
  version       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  proposal_id   INTEGER REFERENCES skill_proposals(id) ON DELETE SET NULL,
  approved_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT
);

-- What each skill evaluation cost (counts in the daily cap).
CREATE TABLE skill_evals (
  id           INTEGER PRIMARY KEY,
  proposal_id  INTEGER REFERENCES skill_proposals(id) ON DELETE SET NULL,
  day          TEXT NOT NULL,
  ran_at       TEXT NOT NULL,
  passed       INTEGER NOT NULL,
  total        INTEGER NOT NULL,
  cost_usd     REAL NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX skill_evals_by_day ON skill_evals (day);
