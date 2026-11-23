/** Skills and skill proposals (Phase 7, ADR-027). */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SkillCase {
  prompt: string;
  rubric: string[];
}

export interface CaseResult {
  prompt: string;
  pass: boolean;
  reason: string;
}

export interface SkillEval {
  ranAt: string;
  passed: number;
  total: number;
  costUsd: number;
  results: CaseResult[];
  error?: string | undefined;
}

export interface SkillProposal {
  id: number;
  name: string;
  description: string;
  body: string;
  cases: SkillCase[];
  reason: string;
  status: "pending" | "approved" | "rejected";
  /** Last evaluation, and whether it ran on the current text. */
  eval?: SkillEval | undefined;
  evalCurrent: boolean;
  createdAt: string;
}

export interface Skill {
  name: string;
  description: string;
  body: string;
  sha: string;
  version: number;
  status: "active" | "disabled";
  approvedAt: string;
  updatedAt: string;
  useCount: number;
  lastUsedAt?: string | undefined;
}

/** What evaluations and approvals pin: the exact name, description and steps. */
export const skillSha = (s: { name: string; description: string; body: string }) =>
  createHash("sha256").update(JSON.stringify([s.name, s.description, s.body])).digest("hex");

type ProposalRow = {
  id: number;
  name: string;
  description: string;
  body: string;
  cases: string;
  reason: string;
  status: SkillProposal["status"];
  eval: string | null;
  evalSha: string | null;
  createdAt: string;
};
type SkillRow = Omit<Skill, "lastUsedAt"> & { lastUsedAt: string | null };

const P_COLS = "id, name, description, body, cases, reason, status, eval, eval_sha AS evalSha, created_at AS createdAt";
const S_COLS = "name, description, body, sha, version, status, approved_at AS approvedAt, updated_at AS updatedAt, use_count AS useCount, last_used_at AS lastUsedAt";

function toProposal(r: ProposalRow): SkillProposal {
  const ev = r.eval ? (JSON.parse(r.eval) as SkillEval) : undefined;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    body: r.body,
    cases: JSON.parse(r.cases) as SkillCase[],
    reason: r.reason,
    status: r.status,
    ...(ev ? { eval: ev } : {}),
    evalCurrent: !!ev && r.evalSha === skillSha(r),
    createdAt: r.createdAt,
  };
}
const toSkill = (r: SkillRow): Skill => ({ ...r, ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt } : { lastUsedAt: undefined }) });

export class SkillStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  propose(p: { name: string; description: string; body: string; cases: SkillCase[]; reason: string; sourceConversationId?: string | null }): SkillProposal {
    const res = this.db
      .prepare("INSERT INTO skill_proposals (name, description, body, cases, reason, source_conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.name, p.description, p.body, JSON.stringify(p.cases), p.reason, p.sourceConversationId ?? null, this.now().toISOString());
    return this.proposal(Number(res.lastInsertRowid)) as SkillProposal;
  }

  proposal(id: number): SkillProposal | undefined {
    const r = this.db.prepare(`SELECT ${P_COLS} FROM skill_proposals WHERE id = ?`).get(id) as ProposalRow | undefined;
    return r ? toProposal(r) : undefined;
  }

  pendingProposals(): SkillProposal[] {
    return (this.db.prepare(`SELECT ${P_COLS} FROM skill_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50`).all() as ProposalRow[]).map(toProposal);
  }

  /** Names the daily reflection must not propose again: skills, pending proposals and recent decisions. */
  takenNames(sinceIso: string): string[] {
    const rows = this.db
      .prepare("SELECT name FROM skills UNION SELECT name FROM skill_proposals WHERE status = 'pending' OR created_at >= ?")
      .all(sinceIso) as { name: string }[];
    return rows.map((r) => r.name);
  }

  recordEval(proposalId: number, sha: string, e: SkillEval, day: string): void {
    this.db.prepare("UPDATE skill_proposals SET eval = ?, eval_sha = ? WHERE id = ?").run(JSON.stringify(e), sha, proposalId);
    this.db
      .prepare("INSERT INTO skill_evals (proposal_id, day, ran_at, passed, total, cost_usd, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(proposalId, day, e.ranAt, e.passed, e.total, e.costUsd, e.error ?? null);
  }

  decide(proposalId: number, status: "approved" | "rejected"): void {
    this.db.prepare("UPDATE skill_proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, this.now().toISOString(), proposalId);
  }

  /** Activates a proposal's text as a skill: a new skill, or the next version of an existing one. */
  activate(p: SkillProposal): Skill {
    const ts = this.now().toISOString();
    const prev = this.skill(p.name);
    const sha = skillSha(p);
    if (prev) {
      this.db
        .prepare("UPDATE skills SET description = ?, body = ?, sha = ?, version = version + 1, status = 'active', proposal_id = ?, approved_at = ?, updated_at = ? WHERE name = ?")
        .run(p.description, p.body, sha, p.id, ts, ts, p.name);
    } else {
      this.db
        .prepare("INSERT INTO skills (name, description, body, sha, version, proposal_id, approved_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
        .run(p.name, p.description, p.body, sha, p.id, ts, ts);
    }
    return this.skill(p.name) as Skill;
  }

  skill(name: string): Skill | undefined {
    const r = this.db.prepare(`SELECT ${S_COLS} FROM skills WHERE name = ?`).get(name) as SkillRow | undefined;
    return r ? toSkill(r) : undefined;
  }

  list(activeOnly = false): Skill[] {
    return (this.db.prepare(`SELECT ${S_COLS} FROM skills ${activeOnly ? "WHERE status = 'active'" : ""} ORDER BY name`).all() as SkillRow[]).map(toSkill);
  }

  setStatus(name: string, status: Skill["status"]): boolean {
    return Number(this.db.prepare("UPDATE skills SET status = ?, updated_at = ? WHERE name = ?").run(status, this.now().toISOString(), name).changes) > 0;
  }

  delete(name: string): boolean {
    return Number(this.db.prepare("DELETE FROM skills WHERE name = ?").run(name).changes) > 0;
  }

  recordUse(name: string): void {
    this.db.prepare("UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE name = ?").run(this.now().toISOString(), name);
  }
}
