/** Builder tasks (ADR-023, migration 007). No transcripts: the task, its outcome and its cost. */
import type { DatabaseSync } from "node:sqlite";

export type TaskStatus = "running" | "review" | "merged" | "discarded" | "failed" | "cancelled";

export interface BuilderTask {
  id: string;
  projectId: string;
  task: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  headSha: string | null;
  worktree: string;
  status: TaskStatus;
  budgetUsd: number;
  costUsd: number;
  turns: number;
  filesChanged: number;
  summary: string | null;
  error: string | null;
  day: string;
  createdAt: string;
  finishedAt: string | null;
}

const COLUMNS = `id, project_id AS projectId, task, branch, base_branch AS baseBranch, base_sha AS baseSha,
  head_sha AS headSha, worktree, status, budget_usd AS budgetUsd, cost_usd AS costUsd, turns,
  files_changed AS filesChanged, summary, error, day, created_at AS createdAt, finished_at AS finishedAt`;

const FIELDS: Record<string, string> = {
  headSha: "head_sha",
  status: "status",
  costUsd: "cost_usd",
  turns: "turns",
  filesChanged: "files_changed",
  summary: "summary",
  error: "error",
  finishedAt: "finished_at",
};

export type TaskUpdate = Partial<Pick<BuilderTask, "headSha" | "status" | "costUsd" | "turns" | "filesChanged" | "summary" | "error" | "finishedAt">>;

export class BuilderTaskStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(t: Omit<BuilderTask, "headSha" | "costUsd" | "turns" | "filesChanged" | "summary" | "error" | "finishedAt">): BuilderTask {
    this.db
      .prepare(
        `INSERT INTO builder_tasks (id, project_id, task, branch, base_branch, base_sha, worktree, status, budget_usd, day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.projectId, t.task, t.branch, t.baseBranch, t.baseSha, t.worktree, t.status, t.budgetUsd, t.day, t.createdAt);
    return this.get(t.id) as BuilderTask;
  }

  update(id: string, changes: TaskUpdate): BuilderTask | undefined {
    const entries = Object.entries(changes).filter(([k, v]) => FIELDS[k] && v !== undefined);
    if (entries.length) {
      this.db.prepare(`UPDATE builder_tasks SET ${entries.map(([k]) => `${FIELDS[k]} = ?`).join(", ")} WHERE id = ?`).run(...entries.map(([, v]) => v as string | number | null), id);
    }
    return this.get(id);
  }

  get(id: string): BuilderTask | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM builder_tasks WHERE id = ?`).get(id) as BuilderTask | undefined;
  }

  /** Short ids (first 8 chars) are what Jarvis shows and the owner says. */
  find(idOrPrefix: string): BuilderTask | undefined {
    const p = idOrPrefix.trim().replace(/^#/, "").toLowerCase();
    if (p.length < 4) return undefined;
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM builder_tasks WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2`).all(`${p}%`) as unknown as BuilderTask[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  list(limit = 20): BuilderTask[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM builder_tasks ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as BuilderTask[];
  }

  running(): BuilderTask[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM builder_tasks WHERE status = 'running'`).all() as unknown as BuilderTask[];
  }

  spentOn(day: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM builder_tasks WHERE day = ?").get(day);
    return Number(row?.total ?? 0);
  }
}
