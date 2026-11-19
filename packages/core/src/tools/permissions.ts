/**
 * Permission Engine v0 and Audit Log (TOOLS_AND_PERMISSIONS.md, ADR-017).
 * "The model can only ask; the Permission Engine decides." Phase 3 only has read tools: they are
 * allowed and audited. Anything riskier is denied until the confirmation flow exists (Phase 4).
 */
import type { DatabaseSync } from "node:sqlite";
import { redact } from "../log.js";

export type Risk = "read" | "prepare" | "confirm" | "destructive" | "forbidden";

export interface ToolPolicy {
  server: string;
  tool: string;
  risk: Risk;
  enabled: boolean;
}

export interface Decision {
  decision: "allow" | "deny";
  risk: Risk;
  reason?: string;
}

export class PermissionEngine {
  private readonly policies = new Map<string, ToolPolicy>();

  register(policy: ToolPolicy): void {
    this.policies.set(`${policy.server}/${policy.tool}`, policy);
  }

  evaluate(server: string, tool: string): Decision {
    const p = this.policies.get(`${server}/${tool}`);
    if (!p) return { decision: "deny", risk: "forbidden", reason: "herramienta no registrada" };
    if (!p.enabled) return { decision: "deny", risk: p.risk, reason: "herramienta deshabilitada" };
    if (p.risk === "read") return { decision: "allow", risk: p.risk };
    return { decision: "deny", risk: p.risk, reason: "requiere confirmación del owner (todavía no disponible)" };
  }
}

export interface AuditEntry {
  turnId?: string | undefined;
  server: string;
  tool: string;
  args: unknown;
  risk: Risk;
  decision: "allow" | "deny";
  reason?: string | undefined;
  ok?: boolean | undefined;
  error?: string | undefined;
  durationMs?: number | undefined;
  resultChars?: number | undefined;
}

const MAX_ARGS = 2_000;

export class AuditLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(e: AuditEntry): void {
    let args = redact(JSON.stringify(e.args ?? {}));
    if (args.length > MAX_ARGS) args = args.slice(0, MAX_ARGS - 1) + "…";
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, turn_id, server, tool, args, risk, decision, reason, ok, error, duration_ms, result_chars)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now().toISOString(),
        e.turnId ?? null,
        e.server,
        e.tool,
        args,
        e.risk,
        e.decision,
        e.reason ?? null,
        e.ok === undefined ? null : e.ok ? 1 : 0,
        e.error ? redact(e.error).slice(0, 500) : null,
        e.durationMs ?? null,
        e.resultChars ?? null,
      );
  }

  recent(limit = 50): (AuditEntry & { ts: string })[] {
    type Row = Omit<AuditEntry, "ok" | "args"> & { ts: string; ok: number | null; args: string };
    const rows = this.db
      .prepare(
        `SELECT ts, turn_id AS turnId, server, tool, args, risk, decision, reason, ok, error, duration_ms AS durationMs, result_chars AS resultChars
         FROM audit_log ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as unknown as Row[];
    return rows.map((r) => ({ ...r, ok: r.ok === null ? undefined : Boolean(r.ok), args: JSON.parse(r.args) as unknown }));
  }
}
