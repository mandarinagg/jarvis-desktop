/**
 * Owner confirmations (ADR-018, TOOLS_AND_PERMISSIONS §2 step 6). When the Permission Engine says
 * `ask`, the hub calls the broker: it sends permission.request to the clients that can show a
 * trustworthy prompt (the desktop main process with a native dialog, the CLI) and waits for the
 * first answer. No answer in time, no client connected, or the turn cancelled = denied.
 */
import { randomUUID } from "node:crypto";
import type { PermissionRequest, PermissionRespond, RiskName } from "@jarvis/shared";
import { type Logger, silentLogger } from "../log.js";
import type { Session } from "../server.js";

export interface ConfirmationRequest {
  turnId?: string | undefined;
  server: string;
  tool: string;
  risk: RiskName;
  title: string;
  detail: string;
  confirmations: 1 | 2;
}

export interface ConfirmationOutcome {
  approved: boolean;
  /** owner:<client> when approved. */
  by?: string;
  reason?: string;
}

export interface Confirmer {
  confirm(req: ConfirmationRequest, signal?: AbortSignal): Promise<ConfirmationOutcome>;
}

/** Clients whose prompt the model cannot reach: the renderer never answers (bridge allowlist). */
export const CONFIRMING_CLIENTS = new Set(["desktop", "cli"]);

export const CONFIRM_TIMEOUT_MS = 120_000;
const MAX_TITLE = 300;
const MAX_DETAIL = 6_000;

interface Pending {
  targets: Set<Session>;
  confirmations: 1 | 2;
  settle: (o: ConfirmationOutcome) => void;
}

export interface ConfirmationBrokerOptions {
  /** Authenticated sessions right now (CoreServer.sessionList). */
  sessions: () => Iterable<Session>;
  timeoutMs?: number;
  logger?: Logger;
  now?: () => Date;
}

export class ConfirmationBroker implements Confirmer {
  private readonly pending = new Map<string, Pending>();
  private readonly logger: Logger;

  constructor(private readonly opts: ConfirmationBrokerOptions) {
    this.logger = opts.logger ?? silentLogger;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  confirm(req: ConfirmationRequest, signal?: AbortSignal): Promise<ConfirmationOutcome> {
    const targets = new Set([...this.opts.sessions()].filter((s) => CONFIRMING_CLIENTS.has(s.client)));
    if (!targets.size) return Promise.resolve({ approved: false, reason: "no hay una pantalla abierta para confirmarlo" });
    if (signal?.aborted) return Promise.resolve({ approved: false, reason: "turno cancelado" });

    const requestId = randomUUID();
    const timeoutMs = this.opts.timeoutMs ?? CONFIRM_TIMEOUT_MS;
    const now = this.opts.now?.() ?? new Date();
    const message: PermissionRequest = {
      type: "permission.request",
      requestId,
      ...(req.turnId ? { turnId: req.turnId } : {}),
      server: req.server.slice(0, 64),
      tool: req.tool.slice(0, 128),
      risk: req.risk,
      title: req.title.slice(0, MAX_TITLE),
      detail: req.detail.length > MAX_DETAIL ? req.detail.slice(0, MAX_DETAIL - 30) + "\n[… vista recortada]" : req.detail,
      confirmations: req.confirmations,
      expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
    };

    return new Promise<ConfirmationOutcome>((resolve) => {
      const onAbort = () => settle({ approved: false, reason: "turno cancelado" });
      const timer = setTimeout(() => settle({ approved: false, reason: "sin respuesta del owner" }), timeoutMs);
      const settle = (o: ConfirmationOutcome) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        for (const s of targets) {
          s.send({ type: "permission.resolved", requestId, approved: o.approved, ...(o.reason ? { reason: o.reason } : {}) });
        }
        this.logger.log("info", "permission.resolved", { requestId, server: req.server, tool: req.tool, approved: o.approved, by: o.by });
        resolve(o);
      };
      this.pending.set(requestId, { targets, confirmations: req.confirmations, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.logger.log("info", "permission.requested", { requestId, server: req.server, tool: req.tool, risk: req.risk });
      for (const s of targets) s.send(message);
    });
  }

  /** permission.respond from a client. Only a session the request was sent to may answer it. */
  respond(session: Session, m: PermissionRespond): void {
    const p = this.pending.get(m.requestId);
    if (!p || !p.targets.has(session)) {
      session.send({ type: "error", id: m.id, code: "invalid_message", message: "no hay un pedido de permiso pendiente con ese id" });
      return;
    }
    if (!m.approved) return p.settle({ approved: false, reason: "el owner lo rechazó" });
    if (m.confirmations < p.confirmations) return p.settle({ approved: false, reason: "faltó la segunda confirmación" });
    p.settle({ approved: true, by: `owner:${session.client}` });
  }

  /** A window closed: requests nobody else can answer are denied. */
  disconnected(session: Session): void {
    for (const p of [...this.pending.values()]) {
      p.targets.delete(session);
      if (!p.targets.size) p.settle({ approved: false, reason: "se cerró la pantalla de confirmación" });
    }
  }

  cancelAll(): void {
    for (const p of [...this.pending.values()]) p.settle({ approved: false, reason: "Jarvis se está cerrando" });
  }
}
