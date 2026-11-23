/**
 * MCP Client Hub (ADR-003): connects the Core to its MCP servers and exposes their tools to
 * Claude. Every call goes model -> Permission Engine -> MCP server -> Audit Log. The model only
 * asks; a denied call never reaches the server.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Logger, silentLogger } from "../log.js";
import type { AuditLog, PermissionEngine, Risk } from "./permissions.js";

export const MAX_RESULT_CHARS = 20_000;
const SEP = "__"; // Claude sees "<server>__<tool>"

export interface ToolCallContext {
  turnId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface ToolCallResult {
  content: string;
  isError: boolean;
}

/** What the Claude adapter needs to run a tool loop: definitions plus a gated call. */
export interface ToolRuntime {
  definitions(): Anthropic.Beta.BetaTool[];
  call(name: string, input: unknown, ctx: ToolCallContext): Promise<ToolCallResult>;
  describe(name: string, input: unknown): string;
}

interface Connected {
  name: string;
  client: Client;
  tools: Anthropic.Beta.BetaTool[];
}

export class ToolHub implements ToolRuntime {
  private readonly servers = new Map<string, Connected>();
  private defs: Anthropic.Beta.BetaTool[] = [];
  private readonly logger: Logger;

  constructor(
    private readonly permissions: PermissionEngine,
    private readonly audit: AuditLog,
    logger?: Logger,
  ) {
    this.logger = logger ?? silentLogger;
  }

  /** Connects one of the Core's own servers in-process and registers each tool's risk class. */
  async addInProcess(name: string, server: McpServer, risks: Record<string, Risk>): Promise<void> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "jarvis-core", version: "0.1.0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    const defs: Anthropic.Beta.BetaTool[] = [];
    for (const t of tools) {
      const risk = risks[t.name];
      if (!risk) {
        this.logger.log("warn", "tools.unclassified", { server: name, tool: t.name }); // never exposed
        continue;
      }
      this.permissions.register({ server: name, tool: t.name, risk, enabled: true });
      defs.push({
        name: `${name}${SEP}${t.name}`,
        description: t.description ?? t.name,
        input_schema: { ...t.inputSchema, type: "object" } as Anthropic.Beta.BetaTool.InputSchema,
      });
    }
    this.servers.set(name, { name, client, tools: defs });
    // Deterministic order keeps the tools prefix byte-identical across requests (prompt cache).
    this.defs = [...this.servers.values()].flatMap((s) => s.tools).sort((a, b) => a.name.localeCompare(b.name));
  }

  definitions(): Anthropic.Beta.BetaTool[] {
    return this.defs;
  }

  describe(name: string, input: unknown): string {
    const [, tool = name] = name.split(SEP);
    const a = (input ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof a[k] === "string" ? String(a[k]).slice(0, 80) : undefined);
    switch (tool) {
      case "list_projects":
        return "Mirando los proyectos";
      case "search":
        return `Buscando «${s("query") ?? ""}»${s("project") ? ` en ${s("project")}` : ""}`;
      case "read_file":
        return `Leyendo ${s("project") ?? ""}/${s("path") ?? ""}`;
      case "list_dir":
        return `Listando ${s("project") ?? ""}/${s("path") ?? ""}`;
      case "git_status":
        return `Viendo el estado de git de ${s("project") ?? ""}`;
      default:
        return tool;
    }
  }

  async call(name: string, input: unknown, ctx: ToolCallContext): Promise<ToolCallResult> {
    const [server = "", tool = ""] = name.split(SEP);
    const verdict = this.permissions.evaluate(server, tool);
    const base = { turnId: ctx.turnId, server, tool, args: input, risk: verdict.risk };
    if (verdict.decision === "deny" || !this.servers.has(server)) {
      const reason = verdict.reason ?? "servidor no conectado";
      this.audit.record({ ...base, decision: "deny", reason });
      return { content: `Permiso denegado: ${reason}.`, isError: true };
    }
    const t0 = performance.now();
    try {
      const res = await (this.servers.get(server) as Connected).client.callTool(
        { name: tool, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { ...(ctx.signal ? { signal: ctx.signal } : {}), timeout: 30_000 },
      );
      const parts = Array.isArray(res.content) ? (res.content as { type: string; text?: string }[]) : [];
      let content = parts.map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type}]`)).join("\n");
      if (content.length > MAX_RESULT_CHARS) content = content.slice(0, MAX_RESULT_CHARS) + "\n[resultado recortado]";
      const isError = Boolean(res.isError);
      this.audit.record({
        ...base,
        decision: "allow",
        ok: !isError,
        error: isError ? content.slice(0, 200) : undefined,
        durationMs: Math.round(performance.now() - t0),
        resultChars: content.length,
      });
      return { content, isError };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit.record({ ...base, decision: "allow", ok: false, error: message, durationMs: Math.round(performance.now() - t0) });
      if (ctx.signal?.aborted) throw err;
      return { content: "La herramienta falló.", isError: true };
    }
  }

  async close(): Promise<void> {
    for (const s of this.servers.values()) await s.client.close().catch(() => {});
    this.servers.clear();
  }
}
