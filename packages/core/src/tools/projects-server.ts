/**
 * The `projects` MCP server (ADR-003, ADR-017, ADR-019): tools over the folders the owner
 * authorized. Reads run freely; writes (write_file, edit_file, git_commit) need the owner's OK and
 * delete_file needs it twice. It runs in the Core's process (own code) and is reached through the
 * MCP client like any other server, so every call passes the Permission Engine and the Audit Log.
 * Write tools only act on the fingerprint the hub passes in `_meta` (what the owner approved).
 * Everything returned is file content or metadata: data for the model, never instructions.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PathDeniedError, isSecretName, resolveInside } from "../projects/guard.js";
import { EXCLUDED_DIRS } from "../projects/guard.js";
import type { ProjectIndex } from "../projects/indexer.js";
import type { Project, ProjectStore } from "../projects/store.js";
import { type GitRunner, gitStatus, runGit } from "./git.js";
import { FINGERPRINT_META, PreviewError, type Previewer } from "./hub.js";
import type { Risk } from "./permissions.js";
import {
  WriteError,
  applyCommit,
  applyFilePlan,
  commitPreview,
  filePreview,
  gitDiff,
  planCommit,
  planDelete,
  planEdit,
  planWrite,
} from "./write-ops.js";

export const PROJECTS_SERVER = "projects";
export const MAX_READ_LINES = 400;
export const MAX_READ_BYTES = 60_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_DIR_ENTRIES = 200;

/** Risk class of each tool, registered in the Permission Engine (not taken from MCP annotations). */
export const PROJECTS_TOOLS: Record<string, Risk> = {
  list_projects: "read",
  search: "read",
  read_file: "read",
  list_dir: "read",
  git_status: "read",
  git_diff: "read",
  write_file: "confirm",
  edit_file: "confirm",
  git_commit: "confirm",
  delete_file: "destructive",
};

export interface ProjectsServerDeps {
  projects: ProjectStore;
  index: ProjectIndex;
  git?: GitRunner;
  /** Where delete_file moves files (inside the Jarvis folder, unreachable by tools). */
  trashDir?: string;
}

const ProjectName = z.string().min(1).max(100);
const RelPath = z.string().min(1).max(500).describe("Ruta relativa a la raíz del proyecto");
export const WriteArgs = z.object({
  project: ProjectName,
  path: RelPath,
  content: z.string().max(200_000).describe("Contenido completo del archivo"),
});
export const EditArgs = z.object({
  project: ProjectName,
  path: RelPath,
  old_text: z.string().min(1).max(50_000).describe("Fragmento exacto a reemplazar; tiene que aparecer una sola vez"),
  new_text: z.string().max(100_000).describe("Texto que lo reemplaza"),
});
export const DeleteArgs = z.object({ project: ProjectName, path: RelPath });
export const CommitArgs = z.object({
  project: ProjectName,
  message: z.string().min(1).max(2_000).describe("Mensaje del commit"),
  paths: z.array(z.string().min(1).max(500)).min(1).max(50).describe('Archivos o carpetas a incluir; "." = todos los cambios'),
});

class ToolError extends Error {}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

export function createProjectsServer(deps: ProjectsServerDeps): McpServer {
  const server = new McpServer({ name: PROJECTS_SERVER, version: "0.1.0" });
  const git = deps.git ?? runGit;

  const project = (name: string): Project => {
    const p = deps.projects.find(name);
    if (!p) {
      const known = deps.projects.list().map((x) => x.name);
      throw new ToolError(`No hay un proyecto «${name}». Proyectos registrados: ${known.join(", ") || "ninguno"}.`);
    }
    return p;
  };

  const guarded =
    <A>(fn: (args: A) => Promise<string>) =>
    async (args: A) => {
      try {
        return text(await fn(args));
      } catch (err) {
        if (err instanceof ToolError) return fail(err.message);
        if (err instanceof PathDeniedError) return fail(`Ruta no permitida: ${err.message}.`);
        return fail("No se pudo completar la lectura.");
      }
    };

  const ro = { readOnlyHint: true, openWorldHint: false };
  const trashDir = deps.trashDir ?? path.join(process.cwd(), ".jarvis-trash");
  const approvedOf = (extra: { _meta?: unknown }) => {
    const v = (extra._meta as Record<string, unknown> | undefined)?.[FINGERPRINT_META];
    return typeof v === "string" ? v : undefined;
  };
  const writing =
    <A>(fn: (args: A, approved: string | undefined) => Promise<string>) =>
    async (args: A, extra: { _meta?: unknown }) => {
      try {
        return text(await fn(args, approvedOf(extra)));
      } catch (err) {
        if (err instanceof ToolError || err instanceof WriteError) return fail(`No lo hice: ${err.message}.`);
        if (err instanceof PathDeniedError) return fail(`Ruta no permitida: ${err.message}.`);
        return fail("No se pudo completar la escritura.");
      }
    };

  server.registerTool(
    "list_projects",
    {
      description: "Lista los proyectos que el owner registró: nombre, descripción, objetivos y cuántos archivos hay indexados.",
      inputSchema: {},
      annotations: ro,
    },
    guarded(async () => {
      const all = deps.projects.list();
      if (!all.length) return "No hay proyectos registrados. El owner los agrega desde la app (Proyectos).";
      return all
        .map((p) =>
          [
            `- ${p.name}${p.description ? `: ${p.description}` : ""}`,
            p.goals ? `  objetivos: ${p.goals}` : "",
            `  archivos indexados: ${deps.index.fileCount(p.id)}${p.indexedAt ? ` (índice del ${p.indexedAt.slice(0, 16).replace("T", " ")})` : ""}`,
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n");
    }),
  );

  server.registerTool(
    "search",
    {
      description:
        "Búsqueda de texto completo en los archivos de los proyectos (documentación, código, notas). Devuelve rutas y las líneas que coinciden. " +
        "Usá palabras clave concretas; si no encontrás nada, probá sinónimos o términos más generales. Después leé el archivo con read_file.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Palabras clave a buscar"),
        project: z.string().max(100).optional().describe("Nombre del proyecto; sin él busca en todos"),
        limit: z.number().int().min(1).max(20).optional().describe("Cantidad de archivos (por defecto 8)"),
      },
      annotations: ro,
    },
    guarded(async ({ query, project: name, limit }: { query: string; project?: string | undefined; limit?: number | undefined }) => {
      const p = name ? project(name) : undefined;
      const hits = await deps.index.search(query, { projectId: p?.id, limit: limit ?? 8 });
      if (!hits.length) return `Sin resultados para «${query}»${p ? ` en ${p.name}` : ""}.`;
      return hits
        .map((h) => [`${h.project}/${h.path}`, ...h.snippets.map((s) => `  L${s.line}: ${s.text}`)].join("\n"))
        .join("\n");
    }),
  );

  server.registerTool(
    "read_file",
    {
      description: `Lee un archivo de texto de un proyecto, con números de línea. Devuelve hasta ${MAX_READ_LINES} líneas por llamada: para archivos largos pedí rangos con startLine/endLine.`,
      inputSchema: {
        project: z.string().min(1).max(100),
        path: z.string().min(1).max(500).describe("Ruta relativa a la raíz del proyecto"),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
      },
      annotations: ro,
    },
    guarded(
      async (a: { project: string; path: string; startLine?: number | undefined; endLine?: number | undefined }) => {
        const p = project(a.project);
        const { abs, rel } = await resolveInside(p.root, a.path);
        const st = await stat(abs);
        if (st.isDirectory()) throw new ToolError(`«${rel}» es una carpeta: usá list_dir.`);
        if (st.size > MAX_FILE_BYTES) throw new ToolError(`«${rel}» es demasiado grande para leerlo (${Math.round(st.size / 1024)} KB).`);
        const buf = await readFile(abs);
        if (buf.subarray(0, 8_192).includes(0)) throw new ToolError(`«${rel}» no es un archivo de texto.`);
        const lines = buf.toString("utf8").split(/\r?\n/);
        const start = Math.min(a.startLine ?? 1, Math.max(lines.length, 1));
        const end = Math.min(a.endLine ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1, lines.length);
        let out = "";
        let last = start - 1;
        for (let i = start; i <= end; i++) {
          const line = `${i}| ${lines[i - 1] ?? ""}\n`;
          if (out.length + line.length > MAX_READ_BYTES) break;
          out += line;
          last = i;
        }
        const more = last < lines.length ? ` Hay más: seguí con startLine=${last + 1}.` : "";
        return `${p.name}/${rel} (líneas ${start}-${last} de ${lines.length}).${more}\n${out}`;
      },
    ),
  );

  server.registerTool(
    "list_dir",
    {
      description: "Lista el contenido de una carpeta de un proyecto (sin carpetas excluidas como node_modules ni archivos con secretos).",
      inputSchema: {
        project: z.string().min(1).max(100),
        path: z.string().max(500).optional().describe("Carpeta relativa a la raíz; vacía = raíz"),
      },
      annotations: ro,
    },
    guarded(async (a: { project: string; path?: string | undefined }) => {
      const p = project(a.project);
      const { abs, rel } = await resolveInside(p.root, a.path ?? ".");
      if (!(await stat(abs)).isDirectory()) throw new ToolError(`«${rel}» no es una carpeta: usá read_file.`);
      const entries = (await readdir(abs, { withFileTypes: true }))
        .filter((e) => !e.isSymbolicLink() && !isSecretName(e.name) && !(e.isDirectory() && EXCLUDED_DIRS.has(e.name)))
        .sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
      const shown = await Promise.all(
        entries.slice(0, MAX_DIR_ENTRIES).map(async (e) => {
          if (e.isDirectory()) return `${e.name}/`;
          const size = (await stat(path.join(abs, e.name)).catch(() => undefined))?.size;
          return size === undefined ? e.name : `${e.name} (${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`})`;
        }),
      );
      const more = entries.length > MAX_DIR_ENTRIES ? `\n… y ${entries.length - MAX_DIR_ENTRIES} más.` : "";
      return `${p.name}/${rel === "." ? "" : rel}\n${shown.join("\n") || "(vacía)"}${more}`;
    }),
  );

  server.registerTool(
    "git_status",
    {
      description: "Estado de git de un proyecto: rama, commits sin subir o sin bajar, archivos cambiados y los últimos 5 commits.",
      inputSchema: { project: z.string().min(1).max(100) },
      annotations: ro,
    },
    guarded(async (a: { project: string }) => {
      const p = project(a.project);
      const s = await gitStatus(p.root, git);
      if (!s.repo) return `${p.name} no es un repositorio git.`;
      const lines = [
        `${p.name}: rama ${s.branch ?? "?"}${s.upstream ? ` (sigue a ${s.upstream}, +${s.ahead ?? 0} / -${s.behind ?? 0})` : " (sin upstream)"}`,
        s.changes.length ? `Cambios sin commitear (${s.changes.length}${s.changesTruncated ? "+" : ""}):` : "Sin cambios sin commitear.",
        ...s.changes.map((c) => `  ${c.status}: ${c.path}`),
        s.commits.length ? "Últimos commits:" : "Todavía no hay commits.",
        ...s.commits.map((c) => `  ${c.hash} ${c.date} ${c.subject}`),
      ];
      return lines.join("\n");
    }),
  );

  server.registerTool(
    "git_diff",
    {
      description: "Muestra los cambios sin commitear de un proyecto (diff contra el último commit), opcionalmente de un solo archivo.",
      inputSchema: { project: ProjectName, path: z.string().max(500).optional().describe("Archivo; sin él, todo el proyecto") },
      annotations: ro,
    },
    guarded(async (a: { project: string; path?: string | undefined }) => {
      const p = project(a.project);
      try {
        return await gitDiff(p, a.path, git);
      } catch (err) {
        if (err instanceof WriteError) throw new ToolError(err.message);
        throw err;
      }
    }),
  );

  server.registerTool(
    "write_file",
    {
      description:
        "Crea un archivo de texto o reemplaza todo su contenido. El owner ve el diff y tiene que aprobarlo antes de que se escriba. " +
        "Para cambios chicos en un archivo existente preferí edit_file.",
      inputSchema: WriteArgs.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    writing(async (a: z.infer<typeof WriteArgs>, approved) => applyFilePlan(await planWrite(project(a.project), a.path, a.content), approved, trashDir)),
  );

  server.registerTool(
    "edit_file",
    {
      description:
        "Reemplaza un fragmento exacto (old_text, que tiene que aparecer una sola vez) por new_text en un archivo existente. " +
        "Leé el archivo antes para copiar el fragmento tal cual. El owner aprueba el diff antes de que se escriba.",
      inputSchema: EditArgs.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    writing(async (a: z.infer<typeof EditArgs>, approved) =>
      applyFilePlan(await planEdit(project(a.project), a.path, a.old_text, a.new_text), approved, trashDir),
    ),
  );

  server.registerTool(
    "delete_file",
    {
      description: "Borra un archivo (lo mueve a la papelera de Jarvis). Es destructivo: el owner lo confirma dos veces.",
      inputSchema: DeleteArgs.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    writing(async (a: z.infer<typeof DeleteArgs>, approved) => applyFilePlan(await planDelete(project(a.project), a.path), approved, trashDir)),
  );

  server.registerTool(
    "git_commit",
    {
      description:
        "Commitea los cambios de las rutas indicadas con un mensaje. No hace push y no corre hooks. Excluye archivos con posibles secretos. " +
        "Mirá antes git_status o git_diff. El owner aprueba la lista de archivos y el mensaje.",
      inputSchema: CommitArgs.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    writing(async (a: z.infer<typeof CommitArgs>, approved) => applyCommit(await planCommit(project(a.project), a.message, a.paths, git), approved, git)),
  );

  return server;
}

/**
 * Previews the hub shows the owner before a write runs. They validate the raw model input with the
 * same schemas as the tools, and plan the change exactly like the tool will.
 */
export function projectsPreviews(deps: ProjectsServerDeps): Record<string, Previewer> {
  const git = deps.git ?? runGit;
  const find = (name: string) => {
    const p = deps.projects.find(name);
    if (!p) throw new PreviewError(`No hay un proyecto «${name}».`);
    return p;
  };
  const wrap =
    <S extends z.ZodType>(schema: S, fn: (a: z.infer<S>) => Promise<import("./hub.js").Preview>): Previewer =>
    async (raw) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new PreviewError(`Argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      try {
        return await fn(parsed.data);
      } catch (err) {
        if (err instanceof PreviewError) throw err;
        if (err instanceof WriteError) throw new PreviewError(`No lo hice: ${err.message}.`);
        if (err instanceof PathDeniedError) throw new PreviewError(`Ruta no permitida: ${err.message}.`);
        throw new PreviewError("No pude preparar el cambio.");
      }
    };
  return {
    write_file: wrap(WriteArgs, async (a) => filePreview(await planWrite(find(a.project), a.path, a.content))),
    edit_file: wrap(EditArgs, async (a) => filePreview(await planEdit(find(a.project), a.path, a.old_text, a.new_text))),
    delete_file: wrap(DeleteArgs, async (a) => filePreview(await planDelete(find(a.project), a.path))),
    git_commit: wrap(CommitArgs, async (a) => commitPreview(await planCommit(find(a.project), a.message, a.paths, git))),
  };
}
