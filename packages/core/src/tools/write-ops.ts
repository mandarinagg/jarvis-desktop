/**
 * Write operations on authorized projects (Phase 4, ADR-019). Each one is planned twice: once to
 * build the preview the owner approves (exact diff), and again right before running. Both plans
 * carry a fingerprint of what is on disk; if it changed in between, nothing is written and the
 * model has to ask again. Paths go through the same guard as reads (realpath, denylist, .git).
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PathDeniedError, deniedReason, isInside, resolveForWrite, resolveInside } from "../projects/guard.js";
import type { Project } from "../projects/store.js";
import { diffStats, splitLines, unifiedDiff } from "./diff.js";
import { type GitRunner, runGit } from "./git.js";
import type { Preview } from "./hub.js";

export const MAX_WRITE_BYTES = 200_000;
const MAX_EDITABLE_BYTES = 2_000_000;
const MAX_COMMIT_FILES = 100;

/** A problem with the request itself: reported to the model as is. */
export class WriteError extends Error {}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 32);
const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);

interface TextFile {
  raw: Buffer;
  text: string; // \n line endings, no BOM
  eol: "\n" | "\r\n";
  bom: boolean;
}

async function readText(abs: string): Promise<TextFile> {
  const st = await stat(abs);
  if (st.size > MAX_EDITABLE_BYTES) throw new WriteError(`el archivo es demasiado grande para editarlo (${kb(st.size)})`);
  const raw = await readFile(abs);
  if (raw.subarray(0, 8_192).includes(0)) throw new WriteError("no es un archivo de texto");
  let text = raw.toString("utf8");
  const bom = text.startsWith("﻿");
  if (bom) text = text.slice(1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { raw, text: text.replace(/\r\n/g, "\n"), eol, bom };
}

const encode = (text: string, f: Pick<TextFile, "eol" | "bom">) => (f.bom ? "﻿" : "") + (f.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);

export interface FilePlan {
  kind: "create" | "replace" | "edit" | "delete";
  project: Project;
  abs: string;
  rel: string;
  before: string;
  /** Bytes to write (create/replace/edit). */
  data?: string;
  after: string;
  fingerprint: string;
}

export async function planWrite(project: Project, requested: string, content: string): Promise<FilePlan> {
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new WriteError(`el contenido supera ${kb(MAX_WRITE_BYTES)}`);
  const { abs, rel, exists } = await resolveForWrite(project.root, requested);
  const after = content.replace(/\r\n/g, "\n");
  if (!exists) return { kind: "create", project, abs, rel, before: "", after, data: after, fingerprint: sha(`new:${rel}`) };
  const f = await readText(abs);
  return { kind: "replace", project, abs, rel, before: f.text, after, data: encode(after, f), fingerprint: sha(f.raw) };
}

export async function planEdit(project: Project, requested: string, oldText: string, newText: string): Promise<FilePlan> {
  const { abs, rel, exists } = await resolveForWrite(project.root, requested);
  if (!exists) throw new WriteError(`«${rel}» no existe: para crearlo usá write_file`);
  const f = await readText(abs);
  const needle = oldText.replace(/\r\n/g, "\n");
  if (!needle) throw new WriteError("old_text no puede estar vacío");
  const count = f.text.split(needle).length - 1;
  if (count === 0) throw new WriteError(`no encontré old_text en «${rel}»: leé el archivo y copiá el fragmento exacto`);
  if (count > 1) throw new WriteError(`old_text aparece ${count} veces en «${rel}»: agregá contexto para que sea único`);
  const after = f.text.replace(needle, () => newText.replace(/\r\n/g, "\n"));
  if (Buffer.byteLength(after) > MAX_EDITABLE_BYTES) throw new WriteError("el archivo quedaría demasiado grande");
  return { kind: "edit", project, abs, rel, before: f.text, after, data: encode(after, f), fingerprint: sha(f.raw) };
}

export async function planDelete(project: Project, requested: string): Promise<FilePlan> {
  const { abs, rel } = await resolveInside(project.root, requested);
  const st = await stat(abs);
  if (!st.isFile()) throw new WriteError(`«${rel}» no es un archivo: solo se borran archivos de a uno`);
  const raw = await readFile(abs);
  const binary = raw.subarray(0, 8_192).includes(0);
  const before = binary ? "" : raw.toString("utf8").replace(/\r\n/g, "\n");
  return { kind: "delete", project, abs, rel, before, after: "", fingerprint: sha(raw) };
}

const TITLES = { create: "Crear", replace: "Reemplazar", edit: "Editar", delete: "Borrar" } as const;

export function filePreview(plan: FilePlan): Preview {
  const where = `${plan.project.name}/${plan.rel}`;
  const title = `${TITLES[plan.kind]} ${where}`;
  if (plan.kind === "delete") {
    const lines = splitLines(plan.before);
    const head = lines.slice(0, 15).map((l) => `- ${l}`);
    return {
      title,
      fingerprint: plan.fingerprint,
      detail: [
        `Se mueve a la papelera de Jarvis (%APPDATA%\\Jarvis\\trash), no a la del sistema.`,
        `${lines.length} líneas.`,
        "",
        ...head,
        ...(lines.length > 15 ? [`… y ${lines.length - 15} líneas más`] : []),
      ].join("\n"),
    };
  }
  const { added, removed } = diffStats(plan.before, plan.after);
  const summary = plan.kind === "create" ? `Archivo nuevo, ${added} líneas.` : `+${added} / -${removed} líneas.`;
  return { title, fingerprint: plan.fingerprint, detail: `${summary}\n\n${unifiedDiff(plan.before, plan.after) || "(sin cambios)"}` };
}

/** Runs a plan only if the file still matches what the owner approved. */
export async function applyFilePlan(plan: FilePlan, approved: string | undefined, trashDir: string, now = new Date()): Promise<string> {
  if (!approved || approved !== plan.fingerprint) {
    throw new WriteError("el archivo cambió desde que lo aprobaste (o falta la aprobación): no toqué nada, pedilo de nuevo");
  }
  const where = `${plan.project.name}/${plan.rel}`;
  if (plan.kind === "delete") {
    await mkdir(trashDir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const dest = path.join(trashDir, `${stamp}-${plan.project.name.replace(/[^\w.-]+/g, "_")}-${path.basename(plan.abs)}`);
    try {
      await rename(plan.abs, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await copyFile(plan.abs, dest); // another drive: copy, then remove
      await unlink(plan.abs);
    }
    return `Borré ${where} (quedó en la papelera de Jarvis: ${path.basename(dest)}).`;
  }
  await mkdir(path.dirname(plan.abs), { recursive: true });
  const tmp = `${plan.abs}.jarvis-${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, plan.data ?? "", { encoding: "utf8", flag: "wx" });
  await rename(tmp, plan.abs);
  const { added, removed } = diffStats(plan.before, plan.after);
  return `${plan.kind === "create" ? "Creé" : plan.kind === "edit" ? "Edité" : "Reemplacé"} ${where} (+${added} / -${removed} líneas).`;
}

// ------------------------------------------------------------------ git

export interface CommitPlan {
  project: Project;
  message: string;
  files: { path: string; status: string }[];
  excluded: string[];
  stat: string;
  fingerprint: string;
}

/** `git status -z`: XY<space>path, renames add the original path as the next entry. */
export async function changedFiles(root: string, run: GitRunner): Promise<{ path: string; status: string }[]> {
  const out = await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  const parts = out.split("\0");
  const files: { path: string; status: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.push({ path: entry.slice(3), status: xy === "??" ? "nuevo" : xy.includes("D") ? "borrado" : xy.includes("R") ? "renombrado" : xy.includes("A") ? "agregado" : "modificado" });
    if (xy.includes("R") || xy.includes("C")) i++; // skip the original path
  }
  return files;
}

export async function planCommit(project: Project, message: string, paths: string[], run: GitRunner = runGit): Promise<CommitPlan> {
  const subject = message.trim();
  if (!subject) throw new WriteError("el mensaje del commit no puede estar vacío");
  const wanted = paths.map((p) => {
    const cleaned = p.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || ".";
    if (/^[a-zA-Z]:/.test(cleaned) || !isInside(project.root, path.resolve(project.root, cleaned))) throw new PathDeniedError("la ruta sale del proyecto");
    return path.posix.normalize(cleaned);
  });
  let changes: { path: string; status: string }[];
  try {
    changes = await changedFiles(project.root, run);
  } catch {
    throw new WriteError(`${project.name} no es un repositorio git`);
  }
  const selected = changes.filter((c) => wanted.some((w) => w === "." || c.path === w || c.path.startsWith(`${w}/`)));
  const excluded = selected.filter((c) => deniedReason(c.path)).map((c) => c.path);
  const files = selected.filter((c) => !deniedReason(c.path)).slice(0, MAX_COMMIT_FILES);
  if (!files.length) throw new WriteError("no hay cambios para commitear en esas rutas");
  let head = "";
  try {
    head = (await run(["rev-parse", "HEAD"], project.root)).trim();
  } catch {
    // first commit
  }
  let statText = "";
  try {
    statText = head ? await run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat=100", "HEAD", "--", ...files.map((f) => f.path)], project.root) : "";
  } catch {
    // stat is informative only
  }
  const hashes = await Promise.all(
    files.map(async (f) => {
      try {
        return `${f.path}:${sha(await readFile(path.join(project.root, f.path)))}`;
      } catch {
        return `${f.path}:gone`;
      }
    }),
  );
  return { project, message: subject, files, excluded, stat: statText.trim(), fingerprint: sha([head, subject, ...hashes].join("\n")) };
}

export function commitPreview(plan: CommitPlan): Preview {
  return {
    title: `Commit en ${plan.project.name}: ${plan.message.split("\n")[0]?.slice(0, 120) ?? ""}`,
    fingerprint: plan.fingerprint,
    detail: [
      `Mensaje:\n${plan.message}`,
      "",
      `Archivos (${plan.files.length}):`,
      ...plan.files.map((f) => `  ${f.status}: ${f.path}`),
      ...(plan.excluded.length ? ["", `No se incluyen (posibles secretos o carpetas excluidas): ${plan.excluded.join(", ")}`] : []),
      ...(plan.stat ? ["", plan.stat] : []),
      "",
      "Se commitean solo estos archivos, sin hooks y sin push.",
    ].join("\n"),
  };
}

export async function applyCommit(plan: CommitPlan, approved: string | undefined, run: GitRunner = runGit): Promise<string> {
  if (!approved || approved !== plan.fingerprint) {
    throw new WriteError("los archivos cambiaron desde que lo aprobaste (o falta la aprobación): no commiteé nada, pedilo de nuevo");
  }
  const files = plan.files.map((f) => f.path);
  const root = plan.project.root;
  await run(["add", "-A", "--", ...files], root);
  // Hooks can run arbitrary code from the repository: an approved commit never runs them.
  await run(["-c", `core.hooksPath=${os.devNull}`, "commit", "--no-verify", "--only", "-m", plan.message, "--", ...files], root, { timeoutMs: 30_000 });
  const hash = (await run(["rev-parse", "--short", "HEAD"], root)).trim();
  return `Commit ${hash} en ${plan.project.name}: ${plan.message.split("\n")[0]} (${files.length} archivos). No hice push.`;
}

export async function gitDiff(project: Project, file: string | undefined, run: GitRunner = runGit): Promise<string> {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--"];
  if (file) {
    const { rel } = await resolveInside(project.root, file).catch(async () => {
      const cleaned = file.replace(/\\/g, "/");
      if (deniedReason(cleaned) || !isInside(project.root, path.resolve(project.root, cleaned))) throw new PathDeniedError("ruta no permitida");
      return { rel: cleaned };
    });
    args.push(rel);
  }
  let out: string;
  try {
    out = await run(args, project.root);
  } catch {
    try {
      out = await run(args.filter((a) => a !== "HEAD"), project.root); // no commits yet
    } catch {
      throw new WriteError(`${project.name} no es un repositorio git`);
    }
  }
  // Never show the content of secret-looking files, even if they are tracked.
  const blocks = out.split(/^(?=diff --git )/m).filter((b) => {
    const m = /^diff --git a\/(.+?) b\//.exec(b);
    return !m?.[1] || !deniedReason(m[1]);
  });
  const untracked = (await changedFiles(project.root, run).catch(() => [])).filter((c) => c.status === "nuevo" && !deniedReason(c.path));
  const text = blocks.join("").trim();
  return [
    text || "Sin cambios en archivos versionados.",
    ...(untracked.length ? ["", `Archivos nuevos sin versionar: ${untracked.map((u) => u.path).join(", ")}`] : []),
  ].join("\n");
}
