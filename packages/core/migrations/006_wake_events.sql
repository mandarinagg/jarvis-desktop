-- Phase 4 (ADR-021): wake word activations, to measure the exit criterion (< 1 false activation a day).
-- Only the score and what followed: never audio or text.

CREATE TABLE wake_events (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  score       REAL NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('command', 'empty', 'timeout', 'ignored'))
);
CREATE INDEX wake_events_by_ts ON wake_events (ts);
