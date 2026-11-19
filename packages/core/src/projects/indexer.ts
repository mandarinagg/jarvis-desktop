/**
 * Project file index (ADR-017): contentless FTS5 over authorized text files, kept fresh by an
 * incremental scan (size + mtime) and a debounced recursive watcher. The database stores tokens,
 * never the text: search snippets are read from disk at query time.
 */
import { type FSWatcher, watch } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Logger, silentLogger } from "../log.js";
import { EXCLUDED_DIRS, MAX_INDEX_BYTES, deniedReason, isSecretName, isTextFile, toRel } from "./guard.js";
import type { Project, ProjectStore } from "./store.js";

export const MAX_FILES_PER_PROJECT = 20_000;
const BATCH = 200;
const WATCH_DEBOUNCE_MS = 500;

export interface SearchHit {
  project: string; // project name
  path: string; // relative, forward slashes
  score: number; // bm25: lower is better
  snippets: { line: number; text: string }[];
}

export interface ScanResult {
  files: number;
  indexed: number;
  removed: number;
  skipped: number;
  truncated: boolean;
}

const STOP_WORDS = new Set(
  (
    "a al algo ante como con cual cuales cuando de del desde donde el ella en entre es esa ese esta este esto fue ha hay la las le les lo los mas me mi " +
    "muy ni no nos o para pero por que quien se sea ser si sin sobre su sus tambien te tiene tu un una uno unos unas y ya yo vos " +
    "the and or of to in is are for on with what how which"
  ).split(" "),
);

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** Free text -> search terms (normalized, no stop words, deduplicated). */
export function queryTerms(query: string): string[] {
  const words = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= 2 && !STOP_WORDS.has(w)))].slice(0, 12);
}

/** FTS5 MATCH expression: any term, prefix match for longer words ("liquidacion" finds "liquidaciones"). */
export function matchExpression(terms: string[]): string {
  return terms.map((t) => (t.length >= 4 ? `"${t}"*` : `"${t}"`)).join(" OR ");
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8_192).includes(0);

export class ProjectIndex {
  private readonly watchers = new Map<string, { watcher: FSWatcher; pending: Set<string>; timer?: NodeJS.Timeout }>();
  private readonly scanning = new Map<string, Promise<ScanResult>>();
  private readonly logger: Logger;

  constructor(
    private readonly db: DatabaseSync,
    private readonly projects: ProjectStore,
    logger?: Logger,
  ) {
    this.logger = logger ?? silentLogger;
  }

  /** Incremental scan; concurrent calls for the same project share one run. */
  scan(project: Project): Promise<ScanResult> {
    const running = this.scanning.get(project.id);
    if (running) return running;
    const run = this.doScan(project).finally(() => this.scanning.delete(project.id));
    this.scanning.set(project.id, run);
    return run;
  }

  search(query: string, opts: { projectId?: string | undefined; limit?: number } = {}): Promise<SearchHit[]> {
    const terms = queryTerms(query);
    if (!terms.length) return Promise.resolve([]);
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 25);
    const rows = this.db
      .prepare(
        `SELECT p.name AS project, p.root AS root, f.rel_path AS path, bm25(file_fts, 3.0, 1.0) AS score
         FROM file_fts JOIN files f ON f.id = file_fts.rowid JOIN projects p ON p.id = f.project_id
         WHERE file_fts MATCH ? ${opts.projectId ? "AND f.project_id = ?" : ""}
         ORDER BY score LIMIT ?`,
      )
      .all(...[matchExpression(terms), ...(opts.projectId ? [opts.projectId] : []), limit]) as {
      project: string;
      root: string;
      path: string;
      score: number;
    }[];
    return Promise.all(
      rows.map(async (r) => ({
        project: r.project,
        path: r.path,
        score: Number(r.score.toFixed(3)),
        snippets: await this.snippets(path.join(r.root, ...r.path.split("/")), terms),
      })),
    );
  }

  /** Watches a project root; changes are reindexed after a short debounce. */
  watch(project: Project): void {
    if (this.watchers.has(project.id)) return;
    try {
      const entry: { watcher: FSWatcher; pending: Set<string>; timer?: NodeJS.Timeout } = {
        pending: new Set(),
        watcher: watch(project.root, { recursive: true, persistent: false }, (_event, filename) => {
          if (!filename) return;
          const rel = String(filename).split(path.sep).join("/");
          if (deniedReason(rel)) return; // node_modules churn, .git internals, secrets
          entry.pending.add(rel);
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => void this.flush(project.id), WATCH_DEBOUNCE_MS);
        }),
      };
      entry.watcher.on("error", (err) => this.logger.log("warn", "index.watch_error", { project: project.id, error: err.message }));
      this.watchers.set(project.id, entry);
    } catch (err) {
      this.logger.log("warn", "index.watch_failed", { project: project.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  unwatch(projectId: string): void {
    const w = this.watchers.get(projectId);
    if (!w) return;
    clearTimeout(w.timer);
    w.watcher.close();
    this.watchers.delete(projectId);
  }

  close(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  fileCount(projectId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM files WHERE project_id = ?").get(projectId) as { n: number }).n);
  }

  // ------------------------------------------------------------ internals

  private async flush(projectId: string): Promise<void> {
    const w = this.watchers.get(projectId);
    const project = this.projects.get(projectId);
    if (!w || !project) return;
    const changed = [...w.pending];
    w.pending.clear();
    for (const rel of changed) {
      try {
        await this.refreshFile(project, rel);
      } catch (err) {
        this.logger.log("warn", "index.refresh_failed", { project: projectId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Reindexes or forgets one path (file or directory) after a watcher event. */
  private async refreshFile(project: Project, rel: string): Promise<void> {
    const abs = path.join(project.root, ...rel.split("/"));
    const st = await lstat(abs).catch(() => undefined);
    if (!st) {
      // Deleted: the path may be a file or a whole directory.
      this.db.prepare("DELETE FROM files WHERE project_id = ? AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')").run(
        project.id,
        rel,
        `${rel.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`,
      );
      return;
    }
    if (st.isDirectory()) {
      await this.scan(project);
      return;
    }
    if (!st.isFile() || !isTextFile(path.basename(rel))) return;
    const existing = this.db.prepare("SELECT id, size, mtime_ms AS mtime FROM files WHERE project_id = ? AND rel_path = ?").get(project.id, rel) as
      | { id: number; size: number; mtime: number }
      | undefined;
    if (st.size > MAX_INDEX_BYTES) {
      if (existing) this.db.prepare("DELETE FROM files WHERE id = ?").run(existing.id);
      return;
    }
    if (existing && existing.size === st.size && existing.mtime === st.mtimeMs) return;
    const body = await readFile(abs);
    if (isBinary(body)) return;
    this.db.exec("BEGIN");
    try {
      this.upsert(project.id, rel, st.size, st.mtimeMs, body.toString("utf8"), existing?.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private upsert(projectId: string, rel: string, size: number, mtime: number, body: string, existingId?: number): void {
    let id = existingId;
    if (id === undefined) {
      id = Number(
        this.db.prepare("INSERT INTO files (project_id, rel_path, size, mtime_ms) VALUES (?, ?, ?, ?)").run(projectId, rel, size, mtime)
          .lastInsertRowid,
      );
    } else {
      this.db.prepare("DELETE FROM file_fts WHERE rowid = ?").run(id);
      this.db.prepare("UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?").run(size, mtime, id);
    }
    this.db.prepare("INSERT INTO file_fts (rowid, path, body) VALUES (?, ?, ?)").run(id, rel, body);
  }

  private async walk(root: string): Promise<{ files: { rel: string; size: number; mtime: number }[]; skipped: number; truncated: boolean }> {
    const files: { rel: string; size: number; mtime: number }[] = [];
    let skipped = 0;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop() as string;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        skipped += 1;
        continue;
      }
      for (const e of entries) {
        // Symlinks and junctions are never followed: they could point outside the root.
        if (e.isSymbolicLink()) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!EXCLUDED_DIRS.has(e.name)) stack.push(abs);
          continue;
        }
        if (!e.isFile() || isSecretName(e.name) || !isTextFile(e.name)) continue;
        const st = await stat(abs).catch(() => undefined);
        if (!st || st.size > MAX_INDEX_BYTES) {
          skipped += 1;
          continue;
        }
        if (files.length >= MAX_FILES_PER_PROJECT) return { files, skipped, truncated: true };
        files.push({ rel: toRel(root, abs), size: st.size, mtime: st.mtimeMs });
      }
    }
    return { files, skipped, truncated: false };
  }

  private async doScan(project: Project): Promise<ScanResult> {
    const t0 = Date.now();
    const { files, skipped, truncated } = await this.walk(project.root);
    const known = new Map(
      (
        this.db.prepare("SELECT id, rel_path AS rel, size, mtime_ms AS mtime FROM files WHERE project_id = ?").all(project.id) as {
          id: number;
          rel: string;
          size: number;
          mtime: number;
        }[]
      ).map((r) => [r.rel, r]),
    );
    const seen = new Set<string>();
    const changed = files.filter((f) => {
      seen.add(f.rel);
      const k = known.get(f.rel);
      return !k || k.size !== f.size || k.mtime !== f.mtime;
    });
    let indexed = 0;
    for (let i = 0; i < changed.length; i += BATCH) {
      const batch = await Promise.all(
        changed.slice(i, i + BATCH).map(async (f) => {
          const body = await readFile(path.join(project.root, ...f.rel.split("/"))).catch(() => undefined);
          return { ...f, body: body && !isBinary(body) ? body.toString("utf8") : undefined };
        }),
      );
      this.db.exec("BEGIN");
      try {
        for (const f of batch) {
          if (f.body === undefined) continue;
          this.upsert(project.id, f.rel, f.size, f.mtime, f.body, known.get(f.rel)?.id);
          indexed += 1;
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      await new Promise((r) => setImmediate(r)); // let IPC and voice events through between batches
    }
    const gone = [...known.values()].filter((k) => !seen.has(k.rel));
    if (gone.length && !truncated) {
      this.db.exec("BEGIN");
      for (const g of gone) this.db.prepare("DELETE FROM files WHERE id = ?").run(g.id);
      this.db.exec("COMMIT");
    }
    this.projects.markIndexed(project.id);
    const result = { files: files.length, indexed, removed: truncated ? 0 : gone.length, skipped, truncated };
    this.logger.log("info", "index.scanned", { project: project.id, ...result, ms: Date.now() - t0 });
    return result;
  }

  /** Up to 3 lines with the most distinct query terms, read from disk now. */
  private async snippets(abs: string, terms: string[]): Promise<{ line: number; text: string }[]> {
    const raw = await readFile(abs, "utf8").catch(() => "");
    const lines = raw.split(/\r?\n/);
    const scored: { line: number; hits: number; text: string }[] = [];
    for (const [i, text] of lines.entries()) {
      const n = normalize(text);
      const hits = terms.filter((t) => n.includes(t)).length;
      if (hits) scored.push({ line: i + 1, hits, text });
    }
    return scored
      .sort((a, b) => b.hits - a.hits || a.line - b.line)
      .slice(0, 3)
      .sort((a, b) => a.line - b.line)
      .map(({ line, text }) => ({ line, text: text.trim().slice(0, 240) }));
  }
}
