/**
 * SQLite via the built-in `node:sqlite` (ADR-007): no native modules, WAL, versioned SQL migrations
 * applied in a transaction at startup. Only the Core opens the database.
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// Works from src/ (tests) and dist/ (runtime): both sit one level below the package root.
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export function openDatabase(file: string, migrationsDir: string = MIGRATIONS_DIR): DatabaseSync {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  migrate(db, migrationsDir);
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
  return Number(row?.v ?? 0);
}

function migrate(db: DatabaseSync, dir: string): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = schemaVersion(db);
  const pending = readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .map((f) => ({ file: f, version: Number(f.slice(0, 3)) }))
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(path.join(dir, m.file), "utf8"));
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(m.version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.file} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
}

/** Local calendar day (YYYY-MM-DD): the daily budget resets at the owner's midnight, not UTC's. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
