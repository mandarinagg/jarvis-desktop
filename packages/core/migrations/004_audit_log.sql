-- Phase 3 (ADR-017, TOOLS_AND_PERMISSIONS §4): append-only audit log of every tool call.
-- Arguments are redacted and truncated; tool results (file contents) are never stored, only their size.

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL,
  turn_id       TEXT,
  server        TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args          TEXT NOT NULL,                 -- redacted JSON, at most 2000 chars
  risk          TEXT NOT NULL,                 -- read | prepare | confirm | destructive | forbidden
  decision      TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason        TEXT,
  ok            INTEGER CHECK (ok IN (0, 1)),  -- null when denied (never ran)
  error         TEXT,
  duration_ms   REAL,
  result_chars  INTEGER
);
CREATE INDEX audit_by_ts ON audit_log (ts);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
