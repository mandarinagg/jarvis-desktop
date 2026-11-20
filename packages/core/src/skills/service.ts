/**
 * The evolution cycle for skills (ADR-027, EVOLUTION.md): Jarvis proposes, the skill's own evals
 * run on the exact text, the owner approves in a native dialog, and the active skills are mirrored
 * to a local git repository (%APPDATA%/Jarvis/skills) so every change has history and a one-step
 * rollback (disable or delete in the Skills panel).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CoreMessage, SkillsListResult, SkillsMessage } from "@jarvis/shared";
import { localDay } from "../db.js";
import { type Logger, silentLogger } from "../log.js";
import type { Session } from "../server.js";
import type { Confirmer } from "../tools/confirm.js";
import { type GitRunner, runGit } from "../tools/git.js";
import type { AuditLog } from "../tools/permissions.js";
import { type SkillEvalModel, evalPassed, evaluateSkill } from "./evaluate.js";
import { skillMarkdown, skillProblem } from "./lint.js";
import { type SkillProposal, type SkillStore, skillSha } from "./store.js";

export interface SkillsServiceOptions {
  store: SkillStore;
  confirmer: Confirmer;
  audit: AuditLog;
  model: () => SkillEvalModel | undefined;
  systemPrompt: string;
  clock: (now: Date) => string;
  spentToday: () => number;
  dailyBudgetUsd: number;
  /** Local git repository with one SKILL.md per active skill. */
  mirrorDir: string;
  broadcast: (m: CoreMessage) => void;
  git?: GitRunner;
  logger?: Logger;
  now?: () => Date;
}

const GIT_ID = ["-c", "user.name=Jarvis", "-c", "user.email=jarvis@localhost", "-c", "commit.gpgsign=false"];

export class SkillsService {
  private readonly evaluating = new Set<number>();
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly git: GitRunner;

  constructor(private readonly o: SkillsServiceOptions) {
    this.logger = o.logger ?? silentLogger;
    this.now = o.now ?? (() => new Date());
    this.git = o.git ?? runGit;
  }

  result(id: string, notice?: string): SkillsListResult {
    const { store } = this.o;
    return {
      type: "skills.list.result",
      id,
      skills: store.list().map((s) => ({
        name: s.name,
        description: s.description,
        body: s.body,
        version: s.version,
        status: s.status,
        approvedAt: s.approvedAt,
        useCount: s.useCount,
        ...(s.lastUsedAt ? { lastUsedAt: s.lastUsedAt } : {}),
      })),
      proposals: store.pendingProposals().map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        body: p.body,
        cases: p.cases,
        reason: p.reason,
        createdAt: p.createdAt,
        updates: store.skill(p.name) !== undefined,
        ...(p.eval ? { eval: { ...p.eval, current: p.evalCurrent, passed: p.eval.passed } } : {}),
        canApprove: p.evalCurrent && evalPassed(p.eval),
      })),
      ...(notice ? { notice } : {}),
    };
  }

  async handle(session: Session, m: SkillsMessage): Promise<void> {
    const reply = (notice?: string) => {
      session.send(this.result(m.id, notice));
      if (m.type !== "skills.list") this.o.broadcast(this.result("skills"));
    };
    switch (m.type) {
      case "skills.list":
        return reply();
      case "skills.evaluate":
        return reply(await this.evaluate(m.proposalId));
      case "skills.approve":
        return reply(await this.approve(m.proposalId));
      case "skills.reject": {
        const p = this.pending(m.proposalId);
        if (!p) return reply("Esa propuesta ya no está pendiente.");
        this.o.store.decide(p.id, "rejected");
        this.o.audit.record({ server: "skills", tool: "reject", args: { name: p.name }, risk: "prepare", decision: "allow", approvedBy: `owner:${session.client}`, ok: true });
        return reply(`Descarté la propuesta «${p.name}».`);
      }
      case "skills.setEnabled": {
        if (!this.o.store.setStatus(m.name, m.enabled ? "active" : "disabled")) return reply(`No hay una skill «${m.name}».`);
        await this.mirror(`skill: ${m.enabled ? "enable" : "disable"} ${m.name}`);
        return reply(m.enabled ? `Activé «${m.name}».` : `Desactivé «${m.name}»: Jarvis deja de usarla desde el próximo mensaje.`);
      }
      case "skills.delete": {
        if (!this.o.store.delete(m.name)) return reply(`No hay una skill «${m.name}».`);
        await this.mirror(`skill: delete ${m.name}`);
        return reply(`Borré «${m.name}». Su historial queda en la carpeta de skills (git).`);
      }
    }
  }

  private pending(id: number): SkillProposal | undefined {
    const p = this.o.store.proposal(id);
    return p?.status === "pending" ? p : undefined;
  }

  /** Runs the proposal's evals (spends a few cents, inside the daily cap). Returns a notice. */
  async evaluate(proposalId: number): Promise<string> {
    const p = this.pending(proposalId);
    if (!p) return "Esa propuesta ya no está pendiente.";
    const problem = skillProblem(p);
    if (problem) return `No la evalúo: ${problem}.`;
    const model = this.o.model();
    if (!model) return "Falta la API key de Anthropic para correr las evals.";
    if (this.o.spentToday() >= this.o.dailyBudgetUsd) return "Se alcanzó el tope diario: las evals quedan para mañana.";
    if (this.evaluating.has(p.id)) return "Ya estoy evaluando esa skill.";
    this.evaluating.add(p.id);
    try {
      const now = this.now();
      const e = await evaluateSkill(p, { model, systemPrompt: this.o.systemPrompt, clock: this.o.clock(now), now });
      this.o.store.recordEval(p.id, skillSha(p), e, localDay(now));
      this.logger.log(e.error ? "warn" : "info", "skills.evaluated", { proposal: p.id, passed: e.passed, total: e.total, costUsd: Number(e.costUsd.toFixed(4)), error: e.error });
      if (e.error) return `Las evals fallaron: ${e.error}`;
      return evalPassed(e)
        ? `«${p.name}» pasó ${e.passed} de ${e.total} casos (US$ ${e.costUsd.toFixed(2)}). Ya la podés aprobar.`
        : `«${p.name}» pasó ${e.passed} de ${e.total} casos (US$ ${e.costUsd.toFixed(2)}): no se puede aprobar así.`;
    } finally {
      this.evaluating.delete(p.id);
    }
  }

  /** Native confirmation with the full text; only when the evals passed on this exact text. */
  async approve(proposalId: number): Promise<string> {
    const p = this.pending(proposalId);
    if (!p) return "Esa propuesta ya no está pendiente.";
    const problem = skillProblem(p);
    if (problem) return `No se puede aprobar: ${problem}.`;
    if (!p.evalCurrent || !evalPassed(p.eval)) return "Primero tienen que pasar sus evals (todas).";
    const prev = this.o.store.skill(p.name);
    const outcome = await this.o.confirmer.confirm({
      server: "skills",
      tool: "approve",
      risk: "confirm",
      title: prev ? `Actualizar la skill «${p.name}» a la versión ${prev.version + 1}` : `Activar la skill «${p.name}»`,
      detail: `${skillMarkdown(p)}\nEvals: ${p.eval?.passed} de ${p.eval?.total} casos.\nJarvis la va a usar cuando el pedido encaje con la descripción. No le da permisos nuevos: cada acción sigue pidiendo tu OK.`,
      confirmations: 1,
    });
    const args = { name: p.name, version: (prev?.version ?? 0) + 1 };
    if (!outcome.approved) {
      this.o.audit.record({ server: "skills", tool: "approve", args, risk: "confirm", decision: "deny", reason: outcome.reason ?? "rechazada por el owner" });
      return `No activé «${p.name}»${outcome.reason ? `: ${outcome.reason}` : ""}.`;
    }
    // The text could not change while the dialog was open: proposals are immutable, but check anyway.
    const again = this.pending(proposalId);
    if (!again || skillSha(again) !== skillSha(p)) return "La propuesta cambió mientras la mirabas: no la activé.";
    const s = this.o.store.activate(p);
    this.o.store.decide(p.id, "approved");
    this.o.audit.record({ server: "skills", tool: "approve", args, risk: "confirm", decision: "allow", approvedBy: outcome.by, ok: true });
    await this.mirror(`skill: ${prev ? "update" : "add"} ${s.name} v${s.version}`);
    return prev ? `Actualicé «${s.name}» a la versión ${s.version}.` : `Activé «${s.name}».`;
  }

  /** Writes one SKILL.md per active skill and commits. Failures are logged, never fatal. */
  async mirror(message: string): Promise<void> {
    const dir = this.o.mirrorDir;
    try {
      mkdirSync(dir, { recursive: true });
      const active = new Map(this.o.store.list(true).map((s) => [s.name, s]));
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== ".git" && !active.has(entry.name)) rmSync(path.join(dir, entry.name), { recursive: true, force: true });
      }
      for (const s of active.values()) {
        mkdirSync(path.join(dir, s.name), { recursive: true });
        writeFileSync(path.join(dir, s.name, "SKILL.md"), skillMarkdown(s), "utf8");
      }
      await this.git(["init", "-q"], dir);
      await this.git(["add", "-A"], dir);
      if (!(await this.git(["status", "--porcelain"], dir)).trim()) return;
      await this.git([...GIT_ID, "commit", "-q", "-m", message], dir, { timeoutMs: 15_000 });
    } catch (err) {
      this.logger.log("warn", "skills.mirror_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
