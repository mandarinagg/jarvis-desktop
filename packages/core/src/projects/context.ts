/**
 * Active-project context (ADR-017): a short card appended to the system prompt for conversations
 * linked to a project. It holds what the owner wrote about the project plus the names at the top of
 * its folder. No file content: that only enters through the tools, as data.
 */
import { readdir } from "node:fs/promises";
import { EXCLUDED_DIRS, isSecretName } from "./guard.js";
import type { Project } from "./store.js";

const MAX_ENTRIES = 40;

export async function projectCard(p: Project): Promise<string> {
  const entries = await readdir(p.root, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((e) => !e.isSymbolicLink() && !isSecretName(e.name) && !(e.isDirectory() && EXCLUDED_DIRS.has(e.name)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  const shown = names.slice(0, MAX_ENTRIES).join(", ") + (names.length > MAX_ENTRIES ? `, … (${names.length - MAX_ENTRIES} más)` : "");
  return [
    `Proyecto activo de esta conversación: «${p.name}». Cuando el owner hable de «el proyecto» o no aclare cuál, es este: pasá project="${p.name}" a las herramientas.`,
    p.description ? `Descripción (escrita por el owner): ${p.description}` : "",
    p.goals ? `Objetivos (escritos por el owner): ${p.goals}` : "",
    shown ? `Primer nivel de la carpeta: ${shown}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
