/**
 * Read-only git status for a project root (ADR-017). Runs the git executable directly (no shell)
 * with fixed arguments, and disables what a repository's own config could use to run code
 * (fsmonitor, pager, credential prompts). Optional locks are off so Jarvis never blocks the owner.
 */
import { execFile } from "node:child_process";

export interface GitStatus {
  repo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  changes: { status: string; path: string }[];
  changesTruncated: boolean;
  commits: { hash: string; date: string; subject: string }[];
}

export type GitRunner = (args: string[], cwd: string, opts?: { timeoutMs?: number }) => Promise<string>;

const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.pager=cat", "--no-optional-locks"];

export const runGit: GitRunner = (args, cwd, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...SAFE, ...args],
      {
        cwd,
        timeout: opts?.timeoutMs ?? 5_000,
        maxBuffer: 4_000_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GCM_INTERACTIVE: "never" },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

const MAX_CHANGES = 50;

export async function gitStatus(root: string, run: GitRunner = runGit): Promise<GitStatus> {
  let inside: string;
  try {
    inside = (await run(["rev-parse", "--is-inside-work-tree"], root)).trim();
  } catch {
    return { repo: false, changes: [], changesTruncated: false, commits: [] };
  }
  if (inside !== "true") return { repo: false, changes: [], changesTruncated: false, commits: [] };

  const status = await run(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], root);
  const result: GitStatus = { repo: true, changes: [], changesTruncated: false, commits: [] };
  for (const line of status.split("\n")) {
    if (line.startsWith("# branch.head ")) result.branch = line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) result.upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [result.ahead, result.behind] = [Number(m[1]), Number(m[2])];
    } else if (/^[12u?] /.test(line)) {
      if (result.changes.length >= MAX_CHANGES) {
        result.changesTruncated = true;
        continue;
      }
      const kind = line[0];
      if (kind === "?") result.changes.push({ status: "nuevo", path: line.slice(2) });
      else {
        const parts = line.split(" ");
        const xy = parts[1] ?? "..";
        // ordinary: 8 fields before the path; rename/copy: 9 (path<TAB>original)
        const path = (kind === "2" ? parts.slice(9).join(" ").split("\t")[0] : parts.slice(kind === "u" ? 10 : 8).join(" ")) ?? "";
        result.changes.push({ status: describe(xy, kind ?? "1"), path });
      }
    }
  }
  try {
    const log = await run(["log", "-5", "--date=short", "--pretty=format:%h%x09%ad%x09%s"], root);
    result.commits = log
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash = "", date = "", ...subject] = l.split("\t");
        return { hash, date, subject: subject.join("\t").slice(0, 200) };
      });
  } catch {
    // a repository without commits yet
  }
  return result;
}

function describe(xy: string, kind: string): string {
  if (kind === "u") return "en conflicto";
  if (kind === "2") return "renombrado";
  const c = xy.replace(/\./g, "");
  if (c.includes("D")) return "borrado";
  if (c.includes("A")) return "agregado";
  return xy[0] !== "." ? "modificado (en stage)" : "modificado";
}
