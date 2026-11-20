/**
 * memory.* IPC handlers (Phase 6, ADR-024): the Memory panel. The owner lists, searches, edits,
 * disables and deletes memories, forgets a time range, turns memory off, decides the daily
 * reflection's proposals and can run the reflection now. Clients cannot write memories of their
 * own: new ones come from Jarvis' tools (native confirmation) or from proposals the owner accepts.
 */
import type { MemoryInfo, MemoryMessage, ProposalInfo } from "@jarvis/shared";
import type { ProjectStore } from "../projects/store.js";
import type { Session } from "../server.js";
import type { Reflector } from "./reflection.js";
import { sensitiveReason } from "./retrieve.js";
import type { Memory, MemoryStore, Proposal } from "./store.js";

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

function proposalInfo(p: Proposal, projects: ProjectStore): ProposalInfo {
  const project = p.projectId ? projects.get(p.projectId)?.name : undefined;
  return { id: p.id, kind: p.kind, text: p.text, reason: p.reason, ...(project ? { project } : {}), createdAt: p.createdAt };
}

export class MemoryService {
  private lastList: { query?: string | undefined; kind?: Memory["kind"] | undefined } = {};

  constructor(
    private readonly memories: MemoryStore,
    private readonly projects: ProjectStore,
    private readonly reflector?: Reflector,
  ) {}

  async handle(session: Session, m: MemoryMessage): Promise<void> {
    let removed: number | undefined;
    let reflection: string | undefined;
    const reject = (message: string) => session.send({ type: "error", id: m.id, code: "invalid_message", message });
    switch (m.type) {
      case "memory.list":
        this.lastList = { query: m.query, kind: m.kind };
        break;
      case "memory.update": {
        const why = m.text !== undefined ? sensitiveReason(m.text) : undefined;
        if (why) return reject(`No guardo eso: ${why}.`);
        if (!this.memories.update(m.memoryId, { text: m.text, status: m.status, ideaStatus: m.ideaStatus })) return reject("ese recuerdo no existe");
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
      case "memory.decide": {
        const why = m.accept && m.text !== undefined ? sensitiveReason(m.text) : undefined;
        if (why) return reject(`No guardo eso: ${why}.`);
        if (!this.memories.decideProposal(m.proposalId, m.accept, m.text)) return reject("esa propuesta ya no está pendiente");
        break;
      }
      case "memory.reflect": {
        if (!this.reflector) return reject("la reflexión no está disponible");
        const r = await this.reflector.run();
        reflection = r.error
          ? `La reflexión falló: ${r.error}`
          : r.skipped
            ? `No reflexioné: ${r.skipped}.`
            : `Reflexioné sobre ${r.conversations} conversaciones: ${r.episodes} episodios y ${r.proposals} propuestas (US$ ${r.costUsd.toFixed(3)}).`;
        break;
      }
    }
    const list = this.memories.list({ ...this.lastList, includeDisabled: true, limit: 300 });
    const stats = this.memories.proposalStats();
    const decided = stats.accepted + stats.rejected + stats.expired;
    session.send({
      type: "memory.list.result",
      id: m.id,
      enabled: this.memories.enabled(),
      memories: list.map((x) => memoryInfo(x, this.projects)),
      proposals: this.memories.pendingProposals().map((p) => proposalInfo(p, this.projects)),
      acceptance: { accepted: stats.accepted, decided, ...(stats.rate !== undefined ? { rate: stats.rate } : {}) },
      ...(removed !== undefined ? { removed } : {}),
      ...(reflection ? { reflection: reflection.slice(0, 300) } : {}),
    });
  }
}
