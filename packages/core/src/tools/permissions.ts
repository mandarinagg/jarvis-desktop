/**
 * Permission Engine v1 and Audit Log (TOOLS_AND_PERMISSIONS.md, ADR-017, ADR-018).
 * "The model can only ask; the Permission Engine decides." Each tool's risk class is registered by
 * the Core (never taken from MCP annotations). Read is allowed and audited; confirm asks the owner
 * once; destructive asks twice and no rule can lower it; forbidden is always denied. Owner rules
 * (permissions.json in the Jarvis folder, outside every project) can deny anything, require a
 * confirmation for a read, or let a confirm-class tool run without asking.
 */
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type Logger, redact, silentLogger } from "../log.js";

export type Risk = "read" | "prepare" | "confirm" | "destructive" | "forbidden";

/** Where the owner's request came from (ADR-029): the PC (text or voice) or the WhatsApp self-chat. */
export type Channel = "text" | "voice" | "whatsapp";

/** Tools that never start from WhatsApp (ADR-029): the Builder runs code with the owner's permissions. */
const NOT_FROM_WHATSAPP = new Set(["builder/start_task"]);

export interface ToolPolicy {
  server: string;
  tool: string;
  risk: Risk;
  enabled: boolean;
}

export interface Decision {
  decision: "allow" | "deny" | "ask";
  risk: Risk;
  /** How many explicit approvals the owner must give (destructive: 2). */
  confirmations?: 1 | 2;
  /** Who allowed it without asking: the default policy or an owner rule. */
  allowedBy?: "policy" | "rule";
  reason?: string;
}

export const PermissionRule = z.strictObject({
  server: z.string().min(1).max(64).default("*"),
  tool: z.string().min(1).max(128).default("*"),
  /** Project name (case-insensitive) or "*"; omitted = any call, with or without a project. */
  project: z.string().min(1).max(80).optional(),
  decision: z.enum(["allow", "confirm", "deny"]),
});
export type PermissionRule = z.infer<typeof PermissionRule>;

export const PermissionRules = z.strictObject({ rules: z.array(PermissionRule).max(200) });

/** Reads the owner's rules; a missing file means no rules, a broken one is ignored and logged. */
export function loadRules(file: string, logger: Logger = silentLogger): PermissionRule[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    return PermissionRules.parse(JSON.parse(raw)).rules;
  } catch (err) {
    logger.log("warn", "permissions.rules_invalid", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    return [];
  }
}

const matches = (pattern: string, value: string) => pattern === "*" || pattern === value;
const SAFETY = { deny: 0, confirm: 1, allow: 2 } as const;

export class PermissionEngine {
  private readonly policies = new Map<string, ToolPolicy>();

  constructor(private rules: PermissionRule[] = []) {}

  register(policy: ToolPolicy): void {
    this.policies.set(`${policy.server}/${policy.tool}`, policy);
  }

  setRules(rules: PermissionRule[]): void {
    this.rules = rules;
  }

  risk(server: string, tool: string): Risk | undefined {
    return this.policies.get(`${server}/${tool}`)?.risk;
  }

  /**
   * `args.project` scopes rules to one project. When several rules match, the safest one wins.
   * From WhatsApp (ADR-029) an `allow` rule never skips a confirmation: the owner's PC rules assume
   * the owner is at the PC.
   */
  evaluate(server: string, tool: string, args?: unknown, channel?: Channel): Decision {
    const p = this.policies.get(`${server}/${tool}`);
    if (!p) return { decision: "deny", risk: "forbidden", reason: "herramienta no registrada" };
    if (!p.enabled) return { decision: "deny", risk: p.risk, reason: "herramienta deshabilitada" };
    if (p.risk === "forbidden") return { decision: "deny", risk: p.risk, reason: "acción prohibida" };
    if (channel === "whatsapp" && NOT_FROM_WHATSAPP.has(`${server}/${tool}`)) {
      return { decision: "deny", risk: p.risk, reason: "esto no se arranca desde WhatsApp, pedímelo en la PC" };
    }

    const project = typeof (args as { project?: unknown } | undefined)?.project === "string"
      ? String((args as { project: string }).project).toLowerCase()
      : undefined;
    const rule = this.rules
      .filter(
        (r) =>
          matches(r.server, server) &&
          matches(r.tool, tool) &&
          (r.project === undefined || r.project === "*" ? true : project !== undefined && r.project.toLowerCase() === project),
      )
      .sort((a, b) => SAFETY[a.decision] - SAFETY[b.decision])[0];

    if (rule?.decision === "deny") return { decision: "deny", risk: p.risk, reason: "una regla del owner lo bloquea" };
    switch (p.risk) {
      case "read":
      case "prepare":
        return rule?.decision === "confirm"
          ? { decision: "ask", risk: p.risk, confirmations: 1 }
          : { decision: "allow", risk: p.risk, allowedBy: "policy" };
      case "confirm":
        return rule?.decision === "allow" && channel !== "whatsapp"
          ? { decision: "allow", risk: p.risk, allowedBy: "rule" }
          : { decision: "ask", risk: p.risk, confirmations: 1 };
      case "destructive":
        return { decision: "ask", risk: p.risk, confirmations: 2 }; // no rule can lower it
    }
  }
}

export interface AuditEntry {
  turnId?: string | undefined;
  channel?: Channel | undefined;
  server: string;
  tool: string;
  args: unknown;
  risk: Risk;
  decision: "allow" | "deny";
  /** policy | rule | owner:<client> — who let it run. */
  approvedBy?: string | undefined;
  reason?: string | undefined;
  ok?: boolean | undefined;
  error?: string | undefined;
  durationMs?: number | undefined;
  resultChars?: number | undefined;
}

export interface AuditRow extends AuditEntry {
  id: number;
  ts: string;
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
        `INSERT INTO audit_log (ts, turn_id, channel, server, tool, args, risk, decision, approved_by, reason, ok, error, duration_ms, result_chars)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now().toISOString(),
        e.turnId ?? null,
        e.channel ?? null,
        e.server,
        e.tool,
        args,
        e.risk,
        e.decision,
        e.approvedBy ?? null,
        e.reason ? redact(e.reason).slice(0, 300) : null,
        e.ok === undefined ? null : e.ok ? 1 : 0,
        e.error ? redact(e.error).slice(0, 500) : null,
        e.durationMs ?? null,
        e.resultChars ?? null,
      );
  }

  /** Newest first. `beforeId` pages backwards; `since` (ISO) keeps only newer entries. */
  recent(limit = 50, opts: { beforeId?: number | undefined; since?: string | undefined } = {}): AuditRow[] {
    return this.query(limit, opts);
  }

  /** Every entry, oldest first, one JSON object per line (TOOLS_AND_PERMISSIONS §4 export). */
  *jsonl(): Generator<string> {
    let afterId = 0;
    for (;;) {
      const page = this.query(500, { afterId });
      if (!page.length) return;
      for (const row of page) yield JSON.stringify(row);
      afterId = page[page.length - 1]?.id ?? afterId;
    }
  }

  private query(limit: number, opts: { beforeId?: number | undefined; afterId?: number | undefined; since?: string | undefined }): AuditRow[] {
    type Row = Omit<AuditRow, "ok" | "args" | "approvedBy" | "channel"> & { ok: number | null; args: string; approvedBy: string | null; channel: string | null };
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.beforeId !== undefined) {
      where.push("id < ?");
      params.push(opts.beforeId);
    }
    if (opts.afterId !== undefined) {
      where.push("id > ?");
      params.push(opts.afterId);
    }
    if (opts.since !== undefined) {
      where.push("ts >= ?");
      params.push(opts.since);
    }
    const rows = this.db
      .prepare(
        `SELECT id, ts, turn_id AS turnId, channel, server, tool, args, risk, decision, approved_by AS approvedBy, reason, ok, error,
                duration_ms AS durationMs, result_chars AS resultChars
         FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id ${opts.afterId !== undefined ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(...params, limit) as unknown as Row[];
    return rows.map((r) => ({
      ...r,
      approvedBy: r.approvedBy ?? undefined,
      channel: (r.channel ?? undefined) as Channel | undefined,
      ok: r.ok === null ? undefined : Boolean(r.ok),
      args: JSON.parse(r.args) as unknown,
    }));
  }
}
