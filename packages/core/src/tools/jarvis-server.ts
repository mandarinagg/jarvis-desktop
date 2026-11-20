/**
 * The `jarvis` MCP server: what Jarvis knows about itself. `recent_activity` lets the owner ask
 * "¿qué hiciste hoy?" by voice or text (TOOLS_AND_PERMISSIONS §4). It reads the audit log, whose
 * arguments are already redacted, and never returns tool results (there are none stored).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "./permissions.js";
import type { Risk } from "./permissions.js";

export const JARVIS_SERVER = "jarvis";
export const JARVIS_TOOLS: Record<string, Risk> = { recent_activity: "read" };

const RISK_WORD: Record<string, string> = {
  read: "lectura",
  prepare: "preparación",
  confirm: "con confirmación",
  destructive: "destructiva",
  forbidden: "prohibida",
};

export function createJarvisServer(deps: { audit: AuditLog; now?: () => Date }): McpServer {
  const server = new McpServer({ name: JARVIS_SERVER, version: "0.1.0" });
  const now = deps.now ?? (() => new Date());
  server.registerTool(
    "recent_activity",
    {
      description:
        "Lo que Jarvis hizo con sus herramientas (registro de auditoría): qué herramienta, cuándo, si se permitió, quién lo aprobó y si salió bien. " +
        "Usalo cuando el owner pregunte qué hiciste, qué tocaste o qué cambiaste.",
      inputSchema: {
        hours: z.number().min(1).max(24 * 30).optional().describe("Ventana hacia atrás en horas (por defecto 24)"),
        limit: z.number().int().min(1).max(100).optional().describe("Máximo de acciones (por defecto 40)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hours, limit }: { hours?: number | undefined; limit?: number | undefined }) => {
      const since = new Date(now().getTime() - (hours ?? 24) * 3_600_000).toISOString();
      const rows = deps.audit.recent(limit ?? 40, { since }).filter((r) => !(r.server === JARVIS_SERVER && r.tool === "recent_activity"));
      if (!rows.length) return { content: [{ type: "text" as const, text: `Sin acciones registradas en las últimas ${hours ?? 24} h.` }] };
      const lines = rows.reverse().map((r) => {
        const when = new Date(r.ts).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
        const args = JSON.stringify(r.args ?? {});
        const verdict =
          r.decision === "deny"
            ? `denegada (${r.reason ?? "sin motivo"})`
            : `${r.approvedBy?.startsWith("owner") ? "aprobada por el owner" : r.approvedBy === "rule" ? "permitida por una regla" : "permitida"}, ${r.ok === false ? "falló" : "ok"}`;
        return `- ${when} ${r.server}/${r.tool} [${RISK_WORD[r.risk] ?? r.risk}] ${args.length > 160 ? args.slice(0, 159) + "…" : args}: ${verdict}`;
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
  return server;
}
