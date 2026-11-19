/**
 * Path guard for authorized project folders (ADR-017). Every path the model sends is untrusted:
 * it is resolved against the project root, canonicalized with realpath (symlinks, junctions) and
 * must stay inside the root. Secret-looking files are never read or indexed, even inside a root.
 */
import { realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class PathDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathDeniedError";
  }
}

/** Directory names never walked or read (version control internals, dependencies, build output). */
export const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  "target",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".idea",
  ".vs",
]);

const SECRET_PATTERNS = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|pfx|p12|kdbx|keystore|jks|sqlite|sqlite3|db)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /^credentials.*\.json$/i,
  /^secrets?\..*/i,
  /^service[-_]?account.*\.json$/i,
];

/** Text files worth indexing and reading; files without an extension are matched by name. */
const TEXT_EXTENSIONS = new Set(
  (
    "md markdown mdx txt rst adoc org csv tsv log " +
    "ts tsx js jsx mjs cjs json jsonc json5 yml yaml toml ini cfg conf xml html htm css scss less svg " +
    "py pyi ipynb rb php java kt kts scala go rs c h cc cpp hpp cs fs vb swift m sql graphql gql proto " +
    "sh bash zsh ps1 psm1 bat cmd lua r jl dart ex exs erl hs clj vue svelte astro tf hcl gradle properties"
  ).split(" "),
);
const TEXT_NAMES = new Set([
  "readme",
  "license",
  "licence",
  "changelog",
  "contributing",
  "authors",
  "notice",
  "makefile",
  "dockerfile",
  "procfile",
  "gemfile",
  "rakefile",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".dockerignore",
]);

export const MAX_INDEX_BYTES = 1_000_000;

export function isSecretName(name: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(name));
}

export function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  const ext = path.extname(lower).slice(1);
  if (ext) return TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(lower);
  return TEXT_NAMES.has(lower);
}

/** Any segment of a relative path that is excluded or secret makes the whole path off-limits. */
export function deniedReason(rel: string): string | undefined {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (part.includes(":")) return "ruta inválida"; // drive letters and NTFS alternate data streams
    if (EXCLUDED_DIRS.has(part)) return `carpeta excluida (${part})`;
    if (isSecretName(part)) return "archivo con posibles secretos";
  }
  return undefined;
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(norm(root), norm(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/**
 * Resolves a model-supplied path inside a project root. Returns the canonical absolute path and the
 * normalized relative path, or throws PathDeniedError. The root must already be canonical.
 */
export async function resolveInside(root: string, requested: string): Promise<{ abs: string; rel: string }> {
  const cleaned = requested.trim().replace(/^[\\/]+/, "") || ".";
  if (/^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith("\\\\")) throw new PathDeniedError("solo rutas relativas al proyecto");
  const lexical = path.resolve(root, cleaned);
  if (!isInside(root, lexical)) throw new PathDeniedError("la ruta sale del proyecto");
  const lexicalReason = deniedReason(toRel(root, lexical));
  if (lexicalReason) throw new PathDeniedError(lexicalReason);
  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    throw new PathDeniedError("no existe");
  }
  if (!isInside(root, real)) throw new PathDeniedError("la ruta sale del proyecto (enlace simbólico)");
  const rel = toRel(root, real);
  const reason = deniedReason(rel);
  if (reason) throw new PathDeniedError(reason);
  return { abs: real, rel: rel || "." };
}

/**
 * Validates a folder the owner wants to authorize. Returns its canonical path. Rejects drive roots,
 * system folders, the whole user profile and Jarvis' own data folder.
 */
export function validateRoot(folder: string, jarvisHome: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!path.isAbsolute(folder)) throw new PathDeniedError("la carpeta tiene que ser una ruta absoluta");
  let real: string;
  try {
    real = realpathSync.native(folder);
  } catch {
    throw new PathDeniedError("la carpeta no existe");
  }
  if (!statSync(real).isDirectory()) throw new PathDeniedError("no es una carpeta");
  if (path.parse(real).root === real || path.dirname(real) === real) throw new PathDeniedError("no se puede autorizar una unidad entera");
  const forbidden = [
    env.WINDIR ?? env.SystemRoot,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramData,
    os.homedir(),
    env.APPDATA,
    env.LOCALAPPDATA,
  ].filter((p): p is string => Boolean(p));
  for (const f of forbidden) {
    if (norm(path.resolve(f)) === norm(real)) throw new PathDeniedError("no se puede autorizar una carpeta del sistema o el perfil entero");
  }
  for (const f of [env.WINDIR ?? env.SystemRoot, env.ProgramFiles, env["ProgramFiles(x86)"]].filter((p): p is string => Boolean(p))) {
    if (isInside(path.resolve(f), real)) throw new PathDeniedError("no se puede autorizar una carpeta del sistema");
  }
  const home = path.resolve(jarvisHome);
  if (isInside(real, home) || isInside(home, real)) throw new PathDeniedError("no se puede autorizar la carpeta de datos de Jarvis");
  return real;
}
