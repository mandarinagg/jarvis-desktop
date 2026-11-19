-- Phase 3 (ADR-017): registered projects, the active project of each conversation and the file index.
-- The index is contentless FTS5: it stores tokens, never a copy of the files' text.

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description  TEXT NOT NULL DEFAULT '',
  goals        TEXT NOT NULL DEFAULT '',
  root         TEXT NOT NULL UNIQUE COLLATE NOCASE, -- canonical (realpath) authorized folder
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  indexed_at   TEXT                                  -- last completed scan
);

ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

CREATE TABLE files (
  id          INTEGER PRIMARY KEY,                   -- rowid of file_fts
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,                         -- forward slashes, relative to the root
  size        INTEGER NOT NULL,
  mtime_ms    REAL NOT NULL,
  UNIQUE (project_id, rel_path)
);

CREATE VIRTUAL TABLE file_fts USING fts5(
  path, body,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Keep the index in step with files (also on project deletion, through the cascade).
CREATE TRIGGER files_fts_delete AFTER DELETE ON files BEGIN
  DELETE FROM file_fts WHERE rowid = old.id;
END;
