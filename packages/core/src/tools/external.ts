/**
 * Third-party MCP servers (Phase 4, ADR-020). The owner lists them in mcp-servers.json inside the
 * Jarvis folder; the model can never add one. Each runs as its own process over stdio with:
 *  - a minimal environment (the SDK's safe list) plus only the variables the owner configured,
 *    secrets taken from the Credential Manager by reference ("keyring:<name>"), never Jarvis' own;
 *  - its own empty working folder under %APPDATA%/Jarvis/mcp/<name>;
 *  - every tool in the "confirm" class unless the owner classified it (read, destructive,
 *    forbidden). Annotations such as readOnlyHint are the author's claim and are ignored.
 * Descriptions and results are data for the model, never instructions.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { type Logger, silentLogger } from "../log.js";
import type { ToolHub } from "./hub.js";
import type { Risk } from "./permissions.js";

const RiskClass = z.enum(["read", "confirm", "destructive", "forbidden"]);

export const ExternalServer = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "minúsculas, números y guiones, hasta 32"),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(2_000)).max(50).default([]),
  /** Literal values, or "keyring:<secret-name>" to read one from the Credential Manager. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4_000)).default({}),
  enabled: z.boolean().default(true),
  /** Risk class per tool name; "*" sets the default for the rest (default: confirm). */
  tools: z.record(z.string().max(128), RiskClass).default({}),
});
export type ExternalServer = z.infer<typeof ExternalServer>;

export const ExternalServers = z.strictObject({ servers: z.array(ExternalServer).max(20) });

/** Names Jarvis uses for its own servers: a third party can never take them. */
const RESERVED = new Set(["projects", "jarvis"]);

/** Variables a third-party server never gets, even if the owner configured them by mistake. */
const NEVER_FORWARD = /^(ANTHROPIC_|JARVIS_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i;

export function loadExternalServers(file: string, logger: Logger = silentLogger): ExternalServer[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const servers = ExternalServers.parse(JSON.parse(raw)).servers;
    const seen = new Set<string>();
    return servers.filter((s) => {
      const ok = s.enabled && !RESERVED.has(s.name) && !seen.has(s.name);
      seen.add(s.name);
      if (!ok && s.enabled) logger.log("warn", "mcp.server_skipped", { server: s.name, reason: "nombre reservado o repetido" });
      return ok;
    });
  } catch (err) {
    logger.log("warn", "mcp.config_invalid", { error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    return [];
  }
}

export function classifier(server: ExternalServer): (tool: string) => Risk {
  return (tool) => server.tools[tool] ?? server.tools["*"] ?? "confirm";
}

/** Jarvis' own credentials: never handed to a third party, whatever the config says. */
const JARVIS_SECRETS = new Set(["anthropic-api-key", "google-tts-api-key"]);

/** Resolves the configured environment; a missing keyring secret makes the server unusable. */
export function serverEnv(server: ExternalServer, secret: (name: string) => string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env)) {
    if (NEVER_FORWARD.test(key)) throw new Error(`la variable ${key} no se le pasa a servidores de terceros`);
    if (value.startsWith("keyring:")) {
      const name = value.slice("keyring:".length);
      if (JARVIS_SECRETS.has(name)) throw new Error(`el secreto «${name}» es de Jarvis y no se comparte`);
      const v = secret(name);
      if (!v) throw new Error(`falta el secreto «${name}» en el Credential Manager`);
      env[key] = v;
    } else {
      env[key] = value;
    }
  }
  return env;
}

export interface ConnectOptions {
  hub: ToolHub;
  /** %APPDATA%/Jarvis/mcp: each server gets its own empty working folder inside it. */
  workDir: string;
  secret: (name: string) => string | undefined;
  logger?: Logger;
  timeoutMs?: number;
}

/** Starts and registers every configured server; one that fails is logged and skipped. */
export async function connectExternalServers(servers: ExternalServer[], opts: ConnectOptions): Promise<string[]> {
  const logger = opts.logger ?? silentLogger;
  const connected: string[] = [];
  for (const server of servers) {
    let client: Client | undefined;
    try {
      const cwd = path.join(opts.workDir, server.name);
      mkdirSync(cwd, { recursive: true });
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: serverEnv(server, opts.secret),
        cwd,
        stderr: "ignore", // may echo secrets or file contents; never logged
      });
      client = new Client({ name: "jarvis-core", version: "0.1.0" });
      await withTimeout(client.connect(transport), opts.timeoutMs ?? 15_000);
      const count = await opts.hub.addClient(server.name, client, classifier(server), { thirdParty: true });
      logger.log("info", "mcp.server_connected", { server: server.name, tools: count });
      connected.push(server.name);
    } catch (err) {
      await client?.close().catch(() => {});
      logger.log("warn", "mcp.server_failed", { server: server.name, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  }
  return connected;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no respondió en ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
