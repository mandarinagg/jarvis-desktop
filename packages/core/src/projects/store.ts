/** Registered projects (ADR-017). Only the owner registers folders: the model can never add one. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Project {
  id: string;
  name: string;
  description: string;
  goals: string;
  root: string;
  createdAt: string;
  updatedAt: string;
  indexedAt: string | null;
}

export interface ProjectInput {
  name: string;
  root: string; // already validated and canonical (guard.validateRoot)
  description?: string | undefined;
  goals?: string | undefined;
}

export class ProjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConflictError";
  }
}

const COLUMNS = "id, name, description, goals, root, created_at AS createdAt, updated_at AS updatedAt, indexed_at AS indexedAt";

export class ProjectStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: ProjectInput): Project {
    this.assertFree(input.name, input.root);
    const ts = this.now().toISOString();
    const p: Project = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      goals: input.goals?.trim() ?? "",
      root: input.root,
      createdAt: ts,
      updatedAt: ts,
      indexedAt: null,
    };
    this.db
      .prepare("INSERT INTO projects (id, name, description, goals, root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, p.name, p.description, p.goals, p.root, p.createdAt, p.updatedAt);
    return p;
  }

  update(id: string, changes: { name?: string | undefined; description?: string | undefined; goals?: string | undefined }): Project | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = {
      name: changes.name?.trim() || current.name,
      description: changes.description?.trim() ?? current.description,
      goals: changes.goals?.trim() ?? current.goals,
    };
    if (next.name.toLowerCase() !== current.name.toLowerCase()) this.assertFree(next.name);
    this.db
      .prepare("UPDATE projects SET name = ?, description = ?, goals = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.description, next.goals, this.now().toISOString(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes) > 0;
  }

  get(id: string): Project | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id) as Project | undefined;
  }

  /** Case-insensitive, also accepting the id: what the model passes as `project`. */
  find(nameOrId: string): Project | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ? OR name = ? COLLATE NOCASE`).get(nameOrId, nameOrId.trim()) as
      | Project
      | undefined;
  }

  list(): Project[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM projects ORDER BY name COLLATE NOCASE`).all() as unknown as Project[];
  }

  markIndexed(id: string): void {
    this.db.prepare("UPDATE projects SET indexed_at = ? WHERE id = ?").run(this.now().toISOString(), id);
  }

  setConversationProject(conversationId: string, projectId: string | null): boolean {
    return Number(this.db.prepare("UPDATE conversations SET project_id = ? WHERE id = ?").run(projectId, conversationId).changes) > 0;
  }

  conversationProject(conversationId: string): Project | undefined {
    const row = this.db.prepare("SELECT project_id AS id FROM conversations WHERE id = ?").get(conversationId) as { id: string | null } | undefined;
    return row?.id ? this.get(row.id) : undefined;
  }

  private assertFree(name: string, root?: string): void {
    if (this.db.prepare("SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE").get(name.trim())) {
      throw new ProjectConflictError(`ya existe un proyecto llamado «${name.trim()}»`);
    }
    if (root && this.db.prepare("SELECT 1 FROM projects WHERE root = ? COLLATE NOCASE").get(root)) {
      throw new ProjectConflictError("esa carpeta ya está registrada como otro proyecto");
    }
  }
}
