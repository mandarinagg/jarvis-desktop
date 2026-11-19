/**
 * Tools for eval runs (Phase 3): the same MCP server, Permission Engine and audit log as production,
 * over a throwaway in-memory database. Cases with `project: "jarvis-docs"` get this repository's
 * docs/ folder registered and indexed (public, synthetic-safe data). Only docs/: the eval cases
 * themselves live outside it, so the model can never read the rubric.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuditLog,
  PROJECTS_SERVER,
  PROJECTS_TOOLS,
  PermissionEngine,
  ProjectIndex,
  ProjectStore,
  type ToolRuntime,
  ToolHub,
  createProjectsServer,
  openDatabase,
  projectCard,
  validateRoot,
} from "@jarvis/core";
import type { EvalCase } from "./cases.js";

export const DOCS_ROOT = fileURLToPath(new URL("../../docs/", import.meta.url));

export interface Workspace {
  tools: ToolRuntime;
  /** Active-project card when the case runs inside a project conversation. */
  card?: string;
  close(): Promise<void>;
}

export async function createWorkspace(c: EvalCase): Promise<Workspace> {
  const db = openDatabase(":memory:");
  const projects = new ProjectStore(db);
  const index = new ProjectIndex(db, projects);
  let card: string | undefined;
  if (c.project === "jarvis-docs") {
    const root = validateRoot(path.resolve(DOCS_ROOT), path.join(DOCS_ROOT, "..", ".no-jarvis-home"));
    const p = projects.create({
      name: "Jarvis",
      root,
      description: "Documentación de JARVIS Desktop, el asistente personal de voz y texto sobre la API de Claude",
      goals: "Cerrar la Fase 3 (proyectos y contexto)",
    });
    await index.scan(p);
    card = await projectCard(p);
  }
  const hub = new ToolHub(new PermissionEngine(), new AuditLog(db));
  await hub.addInProcess(PROJECTS_SERVER, createProjectsServer({ projects, index }), PROJECTS_TOOLS);
  return {
    tools: hub,
    ...(card ? { card } : {}),
    async close() {
      await hub.close();
      index.close();
      db.close();
    },
  };
}
