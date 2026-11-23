/**
 * Builder tool gate (ADR-023). Every tool call the Agent SDK wants to make passes here first (a
 * PreToolUse hook that blocks on failure). The answer is allow or deny, never "ask": the owner
 * reviews the whole result as a diff at merge time, not each step.
 *
 * - File tools only inside the task's worktree, never `.git` nor secret-looking files.
 * - Bash only for commands in the allowlist, one simple command at a time: no shell operators,
 *   redirections, substitutions, absolute paths or `..`. Read-only git is allowed by default; any
 *   command that runs project code (tests, scripts) must be listed by the owner in builder.json.
 * - Anything else (web, subagents, MCP, notebooks...) is denied.
 */
import path from "node:path";
import type { Risk } from "../tools/permissions.js";
import { canonical, deniedReason, isInside, toRel } from "../projects/guard.js";

/** Built-in tools the Builder gets (the SDK's `tools` option). Bash only with an allowlist. */
export const BUILDER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "TodoWrite"] as const;

/** Read-only git subcommands every task may run. */
export const DEFAULT_COMMANDS = ["git status", "git diff", "git log", "git show"];

/** Audit risk: effects stay inside the task's worktree until the owner approves the merge. */
export const BUILDER_RISK: Record<string, Risk> = {
  Read: "read",
  Glob: "read",
  Grep: "read",
  TodoWrite: "read",
  Write: "prepare",
  Edit: "prepare",
  Bash: "prepare",
};

export type Verdict = { allow: true; summary: string } | { allow: false; reason: string; summary: string };

const SHELL_META = /[;&|<>`$(){}\r\n\\%^!]/;
const GIT_UNSAFE = /^--?(output|exec|upload-pack|receive-pack|ext-diff|textconv|config|git-dir|work-tree|namespace)\b|^-c$|^-C$|^-o$/;

/** Splits a simple command into words; quotes group words but give no extra powers. */
export function splitCommand(cmd: string): string[] | undefined {
  const words: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === " " || ch === "\t") {
      if (cur || has) words.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (quote) return undefined;
  if (cur || has) words.push(cur);
  return words;
}

/** Why a Bash command is refused, or undefined if it is allowed. */
export function commandDenied(command: string, allowlist: readonly string[]): string | undefined {
  if (command.length > 500) return "comando demasiado largo";
  if (SHELL_META.test(command)) return "solo comandos simples: sin ;, &, |, redirecciones, variables ni subcomandos";
  const words = splitCommand(command);
  if (!words?.length) return "comando vacío o con comillas sin cerrar";
  for (const w of words) {
    if (/^[a-zA-Z]:/.test(w) || w.startsWith("/") || w.startsWith("~") || /(^|[\\/=])\.\.([\\/]|$)/.test(w) || /=[a-zA-Z]:|=\//.test(w)) {
      return "solo rutas relativas dentro del workspace";
    }
  }
  if (words[0] === "git" && words.slice(1).some((w) => GIT_UNSAFE.test(w))) return "opción de git no permitida";
  const allowed = allowlist.some((entry) => {
    const prefix = splitCommand(entry) ?? [];
    return prefix.length > 0 && prefix.every((p, i) => words[i] === p);
  });
  return allowed ? undefined : `«${words.slice(0, 3).join(" ")}» no está en la lista de comandos permitidos`;
}

/** Path check for file tools; `workspace` must be canonical. */
function pathDenied(workspace: string, requested: string): string | undefined {
  if (requested.startsWith("\\\\")) return "rutas de red no permitidas";
  const abs = canonical(path.resolve(workspace, requested));
  if (!isInside(workspace, abs)) return "la ruta sale del workspace";
  const rel = toRel(workspace, abs);
  if (!rel) return undefined;
  if (rel.split("/").includes(".git")) return "no se toca .git";
  const reason = deniedReason(rel);
  // Excluded folders (node_modules, dist...) are fine in a workspace; secrets and .git are not.
  if (reason && !reason.startsWith("carpeta excluida")) return reason;
  return undefined;
}

function patternDenied(pattern: string): string | undefined {
  if (path.isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.split(/[\\/]/).includes("..")) return "patrón fuera del workspace";
  if (/(^|[\\/])\.git([\\/]|$)/.test(pattern) || /\.env\b/i.test(pattern)) return "patrón sobre archivos protegidos";
  return undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Decides one tool call. `input` is untrusted (written by the model). */
export function checkToolCall(workspace: string, tool: string, input: unknown, allowlist: readonly string[]): Verdict {
  const a = (input ?? {}) as Record<string, unknown>;
  const deny = (reason: string, summary: string): Verdict => ({ allow: false, reason, summary });
  const rel = (p: string) => {
    const abs = canonical(path.resolve(workspace, p));
    return isInside(workspace, abs) ? toRel(workspace, abs) || "." : p;
  };
  switch (tool) {
    case "Read":
    case "Write":
    case "Edit": {
      const p = str(a.file_path);
      const verb = tool === "Read" ? "Leer" : tool === "Write" ? "Escribir" : "Editar";
      if (!p) return deny("falta file_path", verb);
      const why = pathDenied(workspace, p);
      return why ? deny(why, `${verb} ${p.slice(0, 120)}`) : { allow: true, summary: `${verb} ${rel(p)}` };
    }
    case "Glob":
    case "Grep": {
      const verb = tool === "Glob" ? "Buscar archivos" : "Buscar texto";
      const where = str(a.path);
      const why =
        (where ? pathDenied(workspace, where) : undefined) ??
        (tool === "Glob" ? patternDenied(str(a.pattern) ?? "") : str(a.glob) ? patternDenied(str(a.glob) ?? "") : undefined);
      const summary = `${verb} «${(str(a.pattern) ?? "").slice(0, 60)}»`;
      return why ? deny(why, summary) : { allow: true, summary };
    }
    case "Bash": {
      const command = str(a.command) ?? "";
      if (a.run_in_background === true) return deny("sin procesos en segundo plano", `Ejecutar ${command.slice(0, 80)}`);
      const why = commandDenied(command, allowlist);
      return why ? deny(why, `Ejecutar ${command.slice(0, 80)}`) : { allow: true, summary: `Ejecutar ${command.slice(0, 80)}` };
    }
    case "TodoWrite":
      return { allow: true, summary: "Planificar" };
    default:
      return deny(`la herramienta ${tool.slice(0, 40)} no está disponible para el Builder`, tool.slice(0, 40));
  }
}

/** What the audit keeps of a call: paths and commands, never file contents. */
export function auditArgs(tool: string, input: unknown): Record<string, unknown> {
  const a = (input ?? {}) as Record<string, unknown>;
  const keep = ["file_path", "path", "pattern", "glob", "command"];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (typeof a[k] === "string") out[k] = String(a[k]).slice(0, 300);
  if (tool === "Write" && typeof a.content === "string") out.bytes = a.content.length;
  return out;
}
