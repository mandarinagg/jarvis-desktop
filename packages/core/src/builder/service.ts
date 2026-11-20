/**
 * The Builder (Phase 5, ADR-023): "construí lo que te pido". Jarvis converses; the Builder runs.
 *
 * start (owner approves the task, budget and allowed commands)
 *   -> git worktree + branch outside the project -> Agent SDK in the worktree (gated tools)
 *   -> Jarvis commits the result on the task branch -> review: the owner sees summary + diff
 * merge (owner approves the exact diff, fingerprinted) -> `git merge --no-ff` in the project
 * discard (owner approves) -> worktree and branch removed
 *
 * One task at a time. Each task has a hard budget, also bounded by what is left of the daily cap.
 * Every tool call of the agent is audited (server "builder"); effects stay in the worktree.
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { BuilderTaskInfo, CoreMessage } from "@jarvis/shared";
import { localDay } from "../db.js";
import { type Logger, redact, silentLogger } from "../log.js";
import type { Project, ProjectStore } from "../projects/store.js";
import { type GitRunner, runGit } from "../tools/git.js";
import type { Preview } from "../tools/hub.js";
import type { AuditLog } from "../tools/permissions.js";
import { type BuilderConfig, loadBuilderConfig, projectCommands } from "./config.js";
import { BUILDER_RISK, DEFAULT_COMMANDS, auditArgs } from "./policy.js";
import { type AgentRun, type QueryFn, runAgent } from "./runner.js";
import type { BuilderTask, BuilderTaskStore } from "./store.js";
import { WorkspaceError, branchDiff, branchName, commitWorkspace, createWorkspace, mergeBranch, removeWorkspace } from "./workspace.js";

export const BUILDER_AUDIT_SERVER = "builder";
export const MAX_TASK_CHARS = 4_000;

export class BuilderError extends Error {}

export interface BuilderDeps {
  tasks: BuilderTaskStore;
  projects: ProjectStore;
  audit: AuditLog;
  /** Jarvis folder: workspaces/, builder/claude (agent config) and builder.json live here. */
  home: string;
  apiKey: () => string | undefined;
  model: string;
  /** Spent today by chat and Builder, and the daily cap (CLAUDE_API.md §4). */
  spentToday: () => number;
  dailyBudgetUsd: number;
  broadcast?: ((m: CoreMessage) => void) | undefined;
  logger?: Logger | undefined;
  now?: (() => Date) | undefined;
  git?: GitRunner | undefined;
  query?: QueryFn | undefined;
  config?: (() => BuilderConfig) | undefined;
}

export interface StartPlan {
  project: Project;
  task: string;
  budgetUsd: number;
  commands: string[];
  maxTurns: number;
  fingerprint: string;
}

export interface ReviewPlan {
  task: BuilderTask;
  project: Project;
  stat: string;
  diff: string;
  files: string[];
  fingerprint: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const shortId = (id: string) => id.slice(0, 8);
const usd = (n: number) => `US$ ${n.toFixed(2)}`;

export class Builder {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly git: GitRunner;
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void>; lastAction?: string | undefined }>();

  constructor(private readonly deps: BuilderDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.git = deps.git ?? runGit;
  }

  private config(): BuilderConfig {
    return this.deps.config?.() ?? loadBuilderConfig(path.join(this.deps.home, "builder.json"), this.logger);
  }

  private project(name: string): Project {
    const p = this.deps.projects.find(name);
    if (!p) throw new BuilderError(`no hay un proyecto «${name}»`);
    return p;
  }

  private task(id: string): BuilderTask {
    const t = this.deps.tasks.find(id);
    if (!t) throw new BuilderError(`no encontré la tarea «${id.slice(0, 12)}»`);
    return t;
  }

  /** Validates a start request and fixes everything the owner approves (fingerprinted). */
  planStart(projectName: string, task: string, budgetUsd?: number): StartPlan {
    const project = this.project(projectName);
    const text = task.trim();
    if (text.length < 10) throw new BuilderError("describí la tarea con un poco más de detalle");
    if (text.length > MAX_TASK_CHARS) throw new BuilderError(`la tarea es demasiado larga (máximo ${MAX_TASK_CHARS} caracteres)`);
    if (this.running.size || this.deps.tasks.running().length) throw new BuilderError("ya hay una tarea del Builder en curso: esperá a que termine o cancelala");
    if (!this.deps.apiKey()) throw new BuilderError("falta la API key de Anthropic");
    const cfg = this.config();
    const left = this.deps.dailyBudgetUsd - this.deps.spentToday();
    if (left < 0.05) throw new BuilderError(`se alcanzó el tope diario de ${usd(this.deps.dailyBudgetUsd)}`);
    const budget = Math.round(Math.min(budgetUsd ?? cfg.budgetUsd, cfg.budgetUsd * 5, 10, left) * 100) / 100;
    const commands = [...DEFAULT_COMMANDS, ...projectCommands(cfg, project.name)];
    return {
      project,
      task: text,
      budgetUsd: budget,
      commands,
      maxTurns: cfg.maxTurns,
      fingerprint: sha(JSON.stringify([project.id, project.root, text, budget, commands, cfg.maxTurns])),
    };
  }

  startPreview(plan: StartPlan): Preview {
    return {
      title: `Builder: tarea nueva en ${plan.project.name}`,
      fingerprint: plan.fingerprint,
      detail: [
        "Tarea:",
        plan.task,
        "",
        `Presupuesto máximo: ${usd(plan.budgetUsd)} (${plan.maxTurns} turnos como máximo).`,
        `Comandos que puede ejecutar: ${plan.commands.join(", ")}.`,
        "",
        "Trabaja en una copia aislada (git worktree) en una rama nueva: tu carpeta no se toca.",
        "Cuando termine vas a ver el resumen y el diff, y vos decidís si se mergea.",
      ].join("\n"),
    };
  }

  /** Creates the workspace and runs the agent in the background. */
  async start(plan: StartPlan, approved: string | undefined): Promise<BuilderTask> {
    if (!approved || approved !== plan.fingerprint) throw new BuilderError("la tarea cambió desde que la aprobaste (o falta la aprobación)");
    const apiKey = this.deps.apiKey();
    if (!apiKey) throw new BuilderError("falta la API key de Anthropic");
    const id = randomUUID();
    const now = this.now();
    const branch = branchName(plan.task, now, id);
    let ws;
    try {
      ws = await createWorkspace(plan.project.root, path.join(this.deps.home, "workspaces", shortId(id)), branch, this.git);
    } catch (err) {
      if (err instanceof WorkspaceError) throw new BuilderError(err.message);
      throw new BuilderError("no pude crear el workspace (git worktree)");
    }
    const task = this.deps.tasks.insert({
      id,
      projectId: plan.project.id,
      task: plan.task,
      branch: ws.branch,
      baseBranch: ws.baseBranch,
      baseSha: ws.baseSha,
      worktree: ws.dir,
      status: "running",
      budgetUsd: plan.budgetUsd,
      day: localDay(now),
      createdAt: now.toISOString(),
    });
    const abort = new AbortController();
    const entry: { abort: AbortController; done: Promise<void>; lastAction?: string | undefined } = { abort, done: Promise.resolve() };
    this.running.set(id, entry);
    this.emit(task);
    this.logger.log("info", "builder.started", { task: shortId(id), project: plan.project.name, budgetUsd: plan.budgetUsd });
    entry.done = this.execute(task, plan, apiKey, abort.signal, entry).finally(() => this.running.delete(id));
    return task;
  }

  private async execute(task: BuilderTask, plan: StartPlan, apiKey: string, signal: AbortSignal, entry: { lastAction?: string | undefined }): Promise<void> {
    let lastEmit = 0;
    let run: AgentRun;
    try {
      run = await runAgent({
        workspace: task.worktree,
        projectName: plan.project.name,
        branch: task.branch,
        task: task.task,
        commands: plan.commands,
        budgetUsd: plan.budgetUsd,
        maxTurns: plan.maxTurns,
        apiKey,
        model: this.deps.model,
        configDir: path.join(this.deps.home, "builder", "claude"),
        signal,
        query: this.deps.query,
        onTool: (tool, input, verdict) => {
          this.deps.audit.record({
            turnId: `builder:${task.id}`,
            server: BUILDER_AUDIT_SERVER,
            tool,
            args: auditArgs(tool, input),
            risk: BUILDER_RISK[tool] ?? "forbidden",
            decision: verdict.allow ? "allow" : "deny",
            approvedBy: verdict.allow ? "policy" : undefined,
            reason: verdict.allow ? undefined : verdict.reason,
          });
          entry.lastAction = verdict.allow ? verdict.summary : `Rechazado: ${verdict.summary}`;
          const t = this.now().getTime();
          if (t - lastEmit > 1_000) {
            lastEmit = t;
            this.emit(this.deps.tasks.get(task.id) ?? task);
          }
        },
      });
    } catch (err) {
      run = { outcome: "error", costUsd: 0, turns: 0, summary: "", error: err instanceof Error ? err.message : String(err) };
    }
    entry.lastAction = undefined;

    let headSha: string | null = null;
    let files = 0;
    let commitError: string | undefined;
    if (run.outcome !== "cancelled") {
      try {
        ({ headSha, files } = await commitWorkspace(
          { dir: task.worktree, branch: task.branch, baseBranch: task.baseBranch, baseSha: task.baseSha },
          `jarvis: ${task.task.split("\n")[0]?.slice(0, 72) ?? "tarea"}\n\nBuilder task ${shortId(task.id)}`,
          this.git,
        ));
      } catch (err) {
        commitError = `no pude commitear el resultado: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
      }
    }
    const status = run.outcome === "cancelled" ? "cancelled" : commitError || files === 0 ? "failed" : "review";
    const error =
      commitError ??
      (run.outcome === "budget"
        ? `se agotó el presupuesto de ${usd(task.budgetUsd)}`
        : run.outcome === "turns"
          ? "llegó al límite de turnos"
          : run.outcome === "error"
            ? redact(run.error ?? "error del agente")
            : files === 0 && run.outcome === "success"
              ? "no cambió ningún archivo"
              : undefined);
    const updated = this.deps.tasks.update(task.id, {
      status,
      headSha,
      filesChanged: files,
      costUsd: run.costUsd,
      turns: run.turns,
      summary: run.summary || null,
      error: error ?? null,
      finishedAt: this.now().toISOString(),
    });
    this.logger.log("info", "builder.finished", { task: shortId(task.id), status, outcome: run.outcome, costUsd: run.costUsd, turns: run.turns, files });
    if (updated) this.emit(updated);
  }

  /** Stops a running task; its workspace stays until discarded. */
  cancel(id: string): string {
    const t = this.task(id);
    const r = this.running.get(t.id);
    if (!r) return `La tarea ${shortId(t.id)} no está corriendo (estado: ${t.status}).`;
    r.abort.abort();
    return `Cancelando la tarea ${shortId(t.id)}.`;
  }

  /** Waits for a running task (tests, shutdown). */
  async settled(id?: string): Promise<void> {
    await Promise.all([...this.running.entries()].filter(([k]) => !id || k === id).map(([, r]) => r.done));
  }

  async planReview(id: string): Promise<ReviewPlan> {
    const task = this.task(id);
    const project = this.deps.projects.get(task.projectId);
    if (!project) throw new BuilderError("el proyecto de la tarea ya no existe");
    if (task.status !== "review" || !task.headSha) throw new BuilderError(`la tarea ${shortId(task.id)} no está lista para revisar (estado: ${task.status})`);
    const { stat, diff, files } = await branchDiff(project.root, task.baseSha, task.headSha, this.git);
    return { task, project, stat, diff, files, fingerprint: sha(JSON.stringify([task.id, task.headSha, project.root, task.baseBranch])) };
  }

  mergePreview(plan: ReviewPlan): Preview {
    const t = plan.task;
    return {
      title: `Builder: mergear la tarea ${shortId(t.id)} en ${plan.project.name}`,
      fingerprint: plan.fingerprint,
      detail: [
        `Tarea: ${t.task.slice(0, 300)}`,
        `Rama ${t.branch} → ${t.baseBranch} (merge --no-ff, sin hooks, sin push). Costo: ${usd(t.costUsd)}.`,
        "",
        "Resumen del Builder (escrito por el modelo):",
        (t.summary ?? "(sin resumen)").slice(0, 1_500),
        "",
        plan.stat,
        "",
        plan.diff,
      ].join("\n"),
    };
  }

  async merge(plan: ReviewPlan, approved: string | undefined): Promise<string> {
    if (!approved || approved !== plan.fingerprint) throw new BuilderError("la tarea cambió desde que la aprobaste (o falta la aprobación)");
    const t = plan.task;
    let hash: string;
    try {
      hash = await mergeBranch(plan.project.root, t, `Merge ${t.branch}: ${t.task.split("\n")[0]?.slice(0, 60) ?? ""}`, this.git);
    } catch (err) {
      if (err instanceof WorkspaceError) throw new BuilderError(err.message);
      throw err;
    }
    await removeWorkspace(plan.project.root, { dir: t.worktree, branch: t.branch }, { deleteBranch: true }, this.git);
    const updated = this.deps.tasks.update(t.id, { status: "merged" });
    if (updated) this.emit(updated);
    return `Mergeé la tarea ${shortId(t.id)} en ${plan.project.name}/${t.baseBranch} (${hash}, ${plan.files.length} archivos). No hice push.`;
  }

  async planDiscard(id: string): Promise<{ task: BuilderTask; project: Project; fingerprint: string }> {
    const task = this.task(id);
    const project = this.deps.projects.get(task.projectId);
    if (!project) throw new BuilderError("el proyecto de la tarea ya no existe");
    if (task.status === "running") throw new BuilderError("la tarea está corriendo: cancelala primero");
    if (task.status === "merged" || task.status === "discarded") throw new BuilderError(`la tarea ya está ${task.status === "merged" ? "mergeada" : "descartada"}`);
    return { task, project, fingerprint: sha(JSON.stringify([task.id, task.status, task.headSha])) };
  }

  discardPreview(p: { task: BuilderTask; project: Project; fingerprint: string }): Preview {
    return {
      title: `Builder: descartar la tarea ${shortId(p.task.id)}`,
      fingerprint: p.fingerprint,
      detail: [
        `Tarea: ${p.task.task.slice(0, 300)}`,
        `Se borran el workspace y la rama ${p.task.branch}${p.task.filesChanged ? ` (${p.task.filesChanged} archivos cambiados)` : ""}. Tu carpeta no se toca.`,
      ].join("\n"),
    };
  }

  async discard(p: { task: BuilderTask; project: Project; fingerprint: string }, approved: string | undefined): Promise<string> {
    if (!approved || approved !== p.fingerprint) throw new BuilderError("la tarea cambió desde que la aprobaste (o falta la aprobación)");
    await removeWorkspace(p.project.root, { dir: p.task.worktree, branch: p.task.branch }, { deleteBranch: true }, this.git);
    const updated = this.deps.tasks.update(p.task.id, { status: "discarded" });
    if (updated) this.emit(updated);
    return `Descarté la tarea ${shortId(p.task.id)}: borré su workspace y la rama ${p.task.branch}.`;
  }

  /** Text for the model: one task in detail, or the latest ones. */
  describe(id?: string): string {
    if (id) {
      const t = this.task(id);
      const p = this.deps.projects.get(t.projectId);
      return [
        `Tarea ${shortId(t.id)} en ${p?.name ?? "?"} — ${STATUS_WORD[t.status]}`,
        `Pedido: ${t.task}`,
        `Rama: ${t.branch} (desde ${t.baseBranch}). Costo: ${usd(t.costUsd)} de ${usd(t.budgetUsd)}. Turnos: ${t.turns}. Archivos cambiados: ${t.filesChanged}.`,
        ...(this.running.get(t.id)?.lastAction ? [`Ahora: ${this.running.get(t.id)?.lastAction}`] : []),
        ...(t.error ? [`Problema: ${t.error}`] : []),
        ...(t.summary ? ["", "<resumen_del_builder>", t.summary, "</resumen_del_builder>"] : []),
      ].join("\n");
    }
    const rows = this.deps.tasks.list(10);
    if (!rows.length) return "Todavía no hay tareas del Builder.";
    return rows
      .map((t) => `- ${shortId(t.id)} [${STATUS_WORD[t.status]}] ${this.deps.projects.get(t.projectId)?.name ?? "?"}: ${t.task.split("\n")[0]?.slice(0, 100)} (${usd(t.costUsd)})`)
      .join("\n");
  }

  info(t: BuilderTask): BuilderTaskInfo {
    const lastAction = this.running.get(t.id)?.lastAction;
    return {
      id: t.id,
      project: this.deps.projects.get(t.projectId)?.name ?? "?",
      task: t.task.slice(0, 4_000),
      branch: t.branch,
      status: t.status,
      budgetUsd: t.budgetUsd,
      costUsd: t.costUsd,
      filesChanged: t.filesChanged,
      ...(lastAction ? { lastAction: lastAction.slice(0, 200) } : {}),
      ...(t.summary ? { summary: t.summary.slice(0, 4_000) } : {}),
      ...(t.error ? { error: t.error.slice(0, 500) } : {}),
      createdAt: t.createdAt,
      ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
    };
  }

  list(): BuilderTaskInfo[] {
    return this.deps.tasks.list(50).map((t) => this.info(t));
  }

  /** At startup: tasks left "running" by a previous Core were interrupted. */
  recoverInterrupted(): void {
    for (const t of this.deps.tasks.running()) {
      if (this.running.has(t.id)) continue;
      this.deps.tasks.update(t.id, { status: "failed", error: "se interrumpió (Jarvis se cerró mientras corría)", finishedAt: this.now().toISOString() });
    }
  }

  async close(): Promise<void> {
    for (const r of this.running.values()) r.abort.abort();
    await this.settled();
  }

  private emit(t: BuilderTask): void {
    this.deps.broadcast?.({ type: "builder.task", task: this.info(t) });
  }
}

const STATUS_WORD: Record<BuilderTask["status"], string> = {
  running: "corriendo",
  review: "lista para revisar",
  merged: "mergeada",
  discarded: "descartada",
  failed: "falló",
  cancelled: "cancelada",
};
