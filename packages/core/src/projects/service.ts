/**
 * projects.* IPC handlers (ADR-017). Only an authenticated client (the owner's app) gets here:
 * the model has no way to register or widen a folder. Every change is broadcast so all windows
 * show the same list, and indexing runs in the background.
 */
import type { CoreMessage, ProjectInfo, ProjectsMessage } from "@jarvis/shared";
import { type Logger, silentLogger } from "../log.js";
import type { Session } from "../server.js";
import { PathDeniedError, validateRoot } from "./guard.js";
import type { ProjectIndex } from "./indexer.js";
import { ProjectConflictError, type ProjectStore } from "./store.js";

export interface ProjectsServiceOptions {
  projects: ProjectStore;
  index: ProjectIndex;
  jarvisHome: string;
  broadcast: (m: CoreMessage) => void;
  /** After conversations.setProject: the client refreshes its conversation list. */
  conversationsChanged?: (session: Session, requestId: string) => void;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

export class ProjectsService {
  private readonly indexing = new Set<string>();
  private readonly logger: Logger;

  constructor(private readonly opts: ProjectsServiceOptions) {
    this.logger = opts.logger ?? silentLogger;
  }

  info(): ProjectInfo[] {
    return this.opts.projects.list().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      goals: p.goals,
      root: p.root,
      indexedAt: p.indexedAt,
      files: this.opts.index.fileCount(p.id),
      indexing: this.indexing.has(p.id),
    }));
  }

  handle(session: Session, m: ProjectsMessage): void {
    const { projects } = this.opts;
    const fail = (message: string) => session.send({ type: "error", id: m.id, code: "invalid_message", message });
    try {
      switch (m.type) {
        case "projects.list":
          session.send({ type: "projects.list.result", id: m.id, projects: this.info() });
          return;
        case "projects.create": {
          const root = validateRoot(m.root, this.opts.jarvisHome, this.opts.env);
          const p = projects.create({ name: m.name, root, description: m.description, goals: m.goals });
          this.logger.log("info", "projects.created", { project: p.id });
          this.reindex(p.id); // first, so every list sent from now on says `indexing`
          this.reply(session, m.id);
          return;
        }
        case "projects.update":
          if (!projects.update(m.projectId, { name: m.name, description: m.description, goals: m.goals })) return fail("el proyecto no existe");
          this.reply(session, m.id);
          return;
        case "projects.delete":
          this.opts.index.unwatch(m.projectId);
          if (!projects.delete(m.projectId)) return fail("el proyecto no existe");
          this.logger.log("info", "projects.deleted", { project: m.projectId });
          this.reply(session, m.id);
          return;
        case "projects.reindex":
          if (!projects.get(m.projectId)) return fail("el proyecto no existe");
          this.reindex(m.projectId);
          this.reply(session, m.id);
          return;
        case "conversations.setProject":
          if (m.projectId && !projects.get(m.projectId)) return fail("el proyecto no existe");
          if (!projects.setConversationProject(m.conversationId, m.projectId)) return fail("la conversación no existe");
          this.opts.conversationsChanged?.(session, m.id);
          return;
      }
    } catch (err) {
      if (err instanceof PathDeniedError || err instanceof ProjectConflictError) return fail(err.message);
      throw err;
    }
  }

  /** Scans in the background, then follows changes; clients see `indexing` while it runs. */
  reindex(projectId: string): void {
    const p = this.opts.projects.get(projectId);
    if (!p || this.indexing.has(projectId)) return;
    this.indexing.add(projectId);
    this.broadcastList();
    void this.opts.index
      .scan(p)
      .then(() => this.opts.index.watch(p))
      .catch((err: unknown) => this.logger.log("warn", "projects.index_failed", { project: projectId, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        this.indexing.delete(projectId);
        this.broadcastList();
      });
  }

  private reply(session: Session, id: string): void {
    const list = { type: "projects.list.result" as const, projects: this.info() };
    session.send({ ...list, id });
    this.opts.broadcast(list);
  }

  private broadcastList(): void {
    this.opts.broadcast({ type: "projects.list.result", projects: this.info() });
  }
}
