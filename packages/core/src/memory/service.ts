/**
 * memory.* IPC handlers (Phase 6, ADR-024): the Memory panel. The owner lists, searches, edits,
 * disables and deletes memories, forgets a time range and turns memory off. Clients cannot create
 * memories: those come from Jarvis' tools (native confirmation) or accepted proposals.
 */
import type { MemoryInfo, MemoryMessage } from "@jarvis/shared";
import type { ProjectStore } from "../projects/store.js";
import type { Session } from "../server.js";
import { sensitiveReason } from "./retrieve.js";
import type { Memory, MemoryStore } from "./store.js";

export function memoryInfo(m: Memory, projects: ProjectStore): MemoryInfo {
  const project = m.projectId ? projects.get(m.projectId)?.name : undefined;
  return {
    id: m.id,
    kind: m.kind,
    text: m.text,
    ...(project ? { project } : {}),
    source: m.source,
    status: m.status,
    ...(m.ideaStatus ? { ideaStatus: m.ideaStatus } : {}),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
    ...(m.lastUsedAt ? { lastUsedAt: m.lastUsedAt } : {}),
    useCount: m.useCount,
  };
}

export class MemoryService {
  private lastList: { query?: string | undefined; kind?: Memory["kind"] | undefined } = {};

  constructor(
    private readonly memories: MemoryStore,
    private readonly projects: ProjectStore,
  ) {}

  handle(session: Session, m: MemoryMessage): void {
    let removed: number | undefined;
    switch (m.type) {
      case "memory.list":
        this.lastList = { query: m.query, kind: m.kind };
        break;
      case "memory.update": {
        if (m.text !== undefined) {
          const why = sensitiveReason(m.text);
          if (why) {
            session.send({ type: "error", id: m.id, code: "invalid_message", message: `No guardo eso: ${why}.` });
            return;
          }
        }
        if (!this.memories.update(m.memoryId, { text: m.text, status: m.status, ideaStatus: m.ideaStatus })) {
          session.send({ type: "error", id: m.id, code: "invalid_message", message: "ese recuerdo no existe" });
          return;
        }
        break;
      }
      case "memory.delete":
        removed = this.memories.delete(m.memoryIds);
        break;
      case "memory.forget":
        removed = this.memories.forgetRange(m.since, m.until);
        break;
      case "memory.settings":
        if (m.enabled !== undefined) this.memories.setSetting("memory.enabled", m.enabled ? "1" : "0");
        break;
    }
    const list = this.memories.list({ ...this.lastList, includeDisabled: true, limit: 300 });
    session.send({
      type: "memory.list.result",
      id: m.id,
      enabled: this.memories.enabled(),
      memories: list.map((x) => memoryInfo(x, this.projects)),
      ...(removed !== undefined ? { removed } : {}),
    });
  }
}
