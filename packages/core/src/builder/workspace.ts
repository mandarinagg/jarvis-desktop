/**
 * Builder workspaces (ADR-023): one git worktree per task, outside the project folder, on its own
 * branch `jarvis/<date>-<slug>` from the project's HEAD. The owner's working tree is never touched
 * until they approve the merge. Only tracked files are checked out, so untracked secrets (.env)
 * never reach the workspace; tracked secret-looking files are hidden (skip-worktree) as well.
 * Git runs without hooks: a repository's hooks could run arbitrary code.
 */
import { mkdirSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonical, deniedReason, isSecretName } from "../projects/guard.js";
import { type GitRunner, runGit } from "../tools/git.js";

const NO_HOOKS = ["-c", `core.hooksPath=${os.devNull}`];
const IDENTITY = ["-c", "user.name=Jarvis Builder", "-c", "user.email=jarvis-builder@localhost.invalid"];
export const MAX_DIFF_CHARS = 30_000;

export class WorkspaceError extends Error {}

export interface Workspace {
  dir: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
}

export function branchName(task: string, now: Date, id: string): string {
  const slug =
    task
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "tarea";
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `jarvis/${day}-${slug}-${id.slice(0, 4)}`;
}

/** Creates the worktree for a task. The project must be a git repo with at least one commit, on a branch. */
export async function createWorkspace(root: string, dir: string, branch: string, run: GitRunner = runGit): Promise<Workspace> {
  let baseSha: string;
  let baseBranch: string;
  try {
    baseSha = (await run(["rev-parse", "--verify", "HEAD"], root)).trim();
  } catch {
    throw new WorkspaceError("el proyecto tiene que ser un repositorio git con al menos un commit");
  }
  try {
    baseBranch = (await run(["symbolic-ref", "--short", "HEAD"], root)).trim();
  } catch {
    throw new WorkspaceError("el proyecto no está en una rama (HEAD separado)");
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  await run([...NO_HOOKS, "worktree", "add", "--quiet", "-b", branch, dir, baseSha], root, { timeoutMs: 120_000 });
  const canon = canonical(dir);
  // Tracked secret-looking files: hidden from the agent and kept out of the task's commit.
  const tracked = (await run(["ls-files", "-z"], canon, { timeoutMs: 30_000 })).split("\0").filter(Boolean);
  const secrets = tracked.filter((f) => f.split("/").some((part) => isSecretName(part)));
  if (secrets.length) {
    await run(["update-index", "--skip-worktree", "--", ...secrets], canon);
    for (const f of secrets) await unlink(path.join(canon, f)).catch(() => {});
  }
  return { dir: canon, branch, baseBranch, baseSha };
}

/** Commits whatever the agent changed (minus secrets) on the task branch. Returns the head and file count. */
export async function commitWorkspace(ws: Workspace, message: string, run: GitRunner = runGit): Promise<{ headSha: string; files: number }> {
  await run(["add", "-A"], ws.dir, { timeoutMs: 60_000 });
  const staged = (await run(["diff", "--cached", "--name-only", "-z"], ws.dir)).split("\0").filter(Boolean);
  const unsafe = staged.filter((f) => {
    const why = deniedReason(f);
    return why !== undefined && !why.startsWith("carpeta excluida");
  });
  if (unsafe.length) await run(["reset", "-q", "--", ...unsafe], ws.dir);
  const files = staged.length - unsafe.length;
  if (files > 0) {
    await run([...NO_HOOKS, ...IDENTITY, "commit", "--no-verify", "-q", "-m", message], ws.dir, { timeoutMs: 60_000 });
  }
  const headSha = (await run(["rev-parse", "HEAD"], ws.dir)).trim();
  return { headSha, files: headSha === ws.baseSha ? 0 : (await diffFiles(ws.dir, ws.baseSha, headSha, run)).length };
}

async function diffFiles(cwd: string, base: string, head: string, run: GitRunner): Promise<string[]> {
  return (await run(["diff", "--name-only", "-z", `${base}..${head}`], cwd)).split("\0").filter(Boolean);
}

/** Stat and full diff of the task branch against its base (secret-looking files never shown). */
export async function branchDiff(cwd: string, base: string, head: string, run: GitRunner = runGit): Promise<{ stat: string; diff: string; files: string[] }> {
  const files = await diffFiles(cwd, base, head, run);
  const stat = (await run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat=100", `${base}..${head}`], cwd)).trim();
  const raw = await run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", `${base}..${head}`], cwd, { timeoutMs: 30_000 });
  let diff = raw
    .split(/^(?=diff --git )/m)
    .filter((b) => {
      const m = /^diff --git a\/(.+?) b\//.exec(b);
      return !m?.[1] || !m[1].split("/").some((p) => isSecretName(p));
    })
    .join("")
    .trim();
  if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff recortado: ${files.length} archivos en total]`;
  return { stat, diff, files };
}

/**
 * Merges the task branch into the project's working tree. Only on the branch the task started
 * from, without hooks, `--no-ff` so the task stays visible in history. Conflicts abort the merge:
 * nothing is left half-done.
 */
export async function mergeBranch(root: string, ws: { branch: string; baseBranch: string }, message: string, run: GitRunner = runGit): Promise<string> {
  let current: string;
  try {
    current = (await run(["symbolic-ref", "--short", "HEAD"], root)).trim();
  } catch {
    throw new WorkspaceError("el proyecto no está en una rama");
  }
  if (current !== ws.baseBranch) throw new WorkspaceError(`el proyecto está en «${current}» y la tarea salió de «${ws.baseBranch}»: cambiá de rama o mergeala vos`);
  try {
    await run([...NO_HOOKS, ...(await ownerIdentity(root, run)), "merge", "--no-ff", "--no-verify", "-q", "-m", message, ws.branch], root, { timeoutMs: 120_000 });
  } catch (err) {
    await run(["merge", "--abort"], root).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    if (/would be overwritten|uncommitted|local changes/i.test(msg)) {
      throw new WorkspaceError("tenés cambios sin commitear en los mismos archivos: commitealos o guardalos y probá de nuevo");
    }
    throw new WorkspaceError(`no se pudo mergear sin conflictos; la rama ${ws.branch} sigue disponible para que la mergees vos`);
  }
  return (await run(["rev-parse", "--short", "HEAD"], root)).trim();
}

/** The owner's git identity when configured (merge commits are theirs); Jarvis' otherwise. */
async function ownerIdentity(root: string, run: GitRunner): Promise<string[]> {
  const email = await run(["config", "user.email"], root).catch(() => "");
  return email.trim() ? [] : IDENTITY;
}

/** Removes the worktree and, optionally, the branch. Best effort: a leftover folder is removed too. */
export async function removeWorkspace(root: string, ws: { dir: string; branch: string }, opts: { deleteBranch: boolean }, run: GitRunner = runGit): Promise<void> {
  await run(["worktree", "remove", "--force", ws.dir], root, { timeoutMs: 60_000 }).catch(() => {});
  rmSync(ws.dir, { recursive: true, force: true });
  await run(["worktree", "prune"], root).catch(() => {});
  if (opts.deleteBranch) await run(["branch", "-D", ws.branch], root).catch(() => {});
}
