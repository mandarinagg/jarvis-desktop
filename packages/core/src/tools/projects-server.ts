/**
 * The `projects` MCP server (ADR-003, ADR-017): read-only tools over the folders the owner
 * authorized. It runs in the Core's process (own, read-only code) and is reached through the MCP
 * client like any other server, so every call passes the Permission Engine and the Audit Log.
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
import type { Risk } from "./permissions.js";

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
};

export interface ProjectsServerDeps {
  projects: ProjectStore;
  index: ProjectIndex;
  git?: GitRunner;
}

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

  return server;
}
