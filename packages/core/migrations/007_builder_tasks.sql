-- Phase 5 (ADR-023): Builder tasks. Each runs in its own git worktree and branch; the owner
-- reviews the diff and merges (or discards) it. Stores no transcript: only the task as approved,
-- the final summary and the bookkeeping needed to review, merge and count the cost.

CREATE TABLE builder_tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task          TEXT NOT NULL,
  branch        TEXT NOT NULL,
  base_branch   TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  head_sha      TEXT,
  worktree      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running', 'review', 'merged', 'discarded', 'failed', 'cancelled')),
  budget_usd    REAL NOT NULL,
  cost_usd      REAL NOT NULL DEFAULT 0,
  turns         INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  summary       TEXT,
  error         TEXT,
  day           TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX builder_tasks_by_created ON builder_tasks (created_at);
CREATE INDEX builder_tasks_by_day ON builder_tasks (day);
