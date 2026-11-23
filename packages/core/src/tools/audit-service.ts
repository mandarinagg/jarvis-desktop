/**
 * audit.* IPC handlers (TOOLS_AND_PERMISSIONS §4, ADR-018): the owner browses the audit log in the
 * app and exports it as JSONL. The export is written by the Core inside the Jarvis folder, so no
 * client ever chooses where a file goes.
 */
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import type { AuditEntryInfo, AuditMessage } from "@jarvis/shared";
import type { Session } from "../server.js";
import type { AuditLog, AuditRow } from "./permissions.js";

export function toInfo(r: AuditRow): AuditEntryInfo {
  const args = JSON.stringify(r.args ?? {});
  return {
    id: r.id,
    ts: r.ts,
    ...(r.turnId ? { turnId: r.turnId } : {}),
    server: r.server,
    tool: r.tool,
    args: args.length > 2_000 ? args.slice(0, 1_999) + "…" : args,
    risk: r.risk,
    decision: r.decision,
    ...(r.approvedBy ? { approvedBy: r.approvedBy } : {}),
    ...(r.channel ? { channel: r.channel } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.ok !== undefined ? { ok: r.ok } : {}),
    ...(r.durationMs != null ? { durationMs: r.durationMs } : {}),
  };
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export class AuditService {
  constructor(
    private readonly audit: AuditLog,
    private readonly exportDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async handle(session: Session, m: AuditMessage): Promise<void> {
    if (m.type === "audit.list") {
      const entries = this.audit.recent(m.limit ?? 100, { beforeId: m.beforeId }).map(toInfo);
      session.send({ type: "audit.list.result", id: m.id, entries });
      return;
    }
    await mkdir(this.exportDir, { recursive: true });
    const file = path.join(this.exportDir, `audit-${stamp(this.now())}.jsonl`);
    const out = createWriteStream(file, { encoding: "utf8", flags: "wx" });
    let count = 0;
    for (const line of this.audit.jsonl()) {
      if (!out.write(line + "\n")) await once(out, "drain");
      count++;
    }
    out.end();
    await once(out, "finish");
    session.send({ type: "audit.exported", id: m.id, path: file, count });
  }
}
