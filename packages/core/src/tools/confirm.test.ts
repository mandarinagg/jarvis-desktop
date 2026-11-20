import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CoreMessage, PermissionRequest } from "@jarvis/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openDatabase } from "../db.js";
import type { Session } from "../server.js";
import { AuditService } from "./audit-service.js";
import { ConfirmationBroker } from "./confirm.js";
import { PreviewError, ToolHub } from "./hub.js";
import { createJarvisServer } from "./jarvis-server.js";
import { AuditLog, PermissionEngine, loadRules } from "./permissions.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "jarvis-confirm-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

function session(client: string, id = client): Session & { sent: CoreMessage[] } {
  const sent: CoreMessage[] = [];
  return { id, client, sent, send: (m) => sent.push(m), close: () => {} };
}
const requestOf = (s: { sent: CoreMessage[] }) => s.sent.find((m): m is PermissionRequest => m.type === "permission.request");

describe("PermissionEngine v1", () => {
  const engine = (rules = [] as Parameters<PermissionEngine["setRules"]>[0]) => {
    const pe = new PermissionEngine(rules);
    pe.register({ server: "fs", tool: "read", risk: "read", enabled: true });
    pe.register({ server: "fs", tool: "write", risk: "confirm", enabled: true });
    pe.register({ server: "fs", tool: "delete", risk: "destructive", enabled: true });
    pe.register({ server: "fs", tool: "shell", risk: "forbidden", enabled: true });
    pe.register({ server: "fs", tool: "off", risk: "read", enabled: false });
    return pe;
  };

  it("reads run, confirm asks once, destructive asks twice, forbidden never runs", () => {
    const pe = engine();
    expect(pe.evaluate("fs", "read")).toMatchObject({ decision: "allow", allowedBy: "policy" });
    expect(pe.evaluate("fs", "write")).toMatchObject({ decision: "ask", confirmations: 1 });
    expect(pe.evaluate("fs", "delete")).toMatchObject({ decision: "ask", confirmations: 2 });
    expect(pe.evaluate("fs", "shell")).toMatchObject({ decision: "deny" });
    expect(pe.evaluate("fs", "off")).toMatchObject({ decision: "deny", reason: "herramienta deshabilitada" });
    expect(pe.evaluate("x", "y")).toMatchObject({ decision: "deny", risk: "forbidden" });
  });

  it("owner rules: allow skips the prompt only for confirm-class tools, deny always wins", () => {
    const pe = engine([
      { server: "fs", tool: "write", project: "notas", decision: "allow" },
      { server: "fs", tool: "delete", decision: "allow" }, // cannot lower destructive
      { server: "fs", tool: "shell", decision: "allow" }, // cannot unlock forbidden
      { server: "fs", tool: "read", project: "privado", decision: "deny" },
      { server: "*", tool: "read", project: "banco", decision: "confirm" },
      { server: "fs", tool: "write", project: "*", decision: "deny" },
    ]);
    expect(pe.evaluate("fs", "write", { project: "Notas" })).toMatchObject({ decision: "deny" }); // project:* deny is safer
    expect(pe.evaluate("fs", "delete", { project: "x" })).toMatchObject({ decision: "ask", confirmations: 2 });
    expect(pe.evaluate("fs", "shell")).toMatchObject({ decision: "deny" });
    expect(pe.evaluate("fs", "read", { project: "PRIVADO" })).toMatchObject({ decision: "deny", reason: expect.stringMatching(/regla/) });
    expect(pe.evaluate("fs", "read", { project: "banco" })).toMatchObject({ decision: "ask", confirmations: 1 });
    expect(pe.evaluate("fs", "read", { project: "otro" })).toMatchObject({ decision: "allow" });

    const scoped = engine([{ server: "fs", tool: "write", project: "notas", decision: "allow" }]);
    expect(scoped.evaluate("fs", "write", { project: "notas" })).toMatchObject({ decision: "allow", allowedBy: "rule" });
    expect(scoped.evaluate("fs", "write", { project: "app" })).toMatchObject({ decision: "ask" });
    expect(scoped.evaluate("fs", "write")).toMatchObject({ decision: "ask" }); // a project rule never matches calls without one
  });

  it("loads rules from permissions.json and ignores a broken file", () => {
    const file = path.join(tmp, "permissions.json");
    expect(loadRules(file)).toEqual([]);
    writeFileSync(file, JSON.stringify({ rules: [{ tool: "write_file", project: "notas", decision: "allow" }] }));
    expect(loadRules(file)).toEqual([{ server: "*", tool: "write_file", project: "notas", decision: "allow" }]);
    writeFileSync(file, JSON.stringify({ rules: [{ tool: "x", decision: "maybe" }] }));
    const warn = vi.fn();
    expect(loadRules(file, { log: warn })).toEqual([]);
    expect(warn).toHaveBeenCalledWith("warn", "permissions.rules_invalid", expect.anything());
  });
});

describe("ConfirmationBroker", () => {
  const req = { server: "fs", tool: "write", risk: "confirm" as const, title: "Escribir notas.md", detail: "+ hola", confirmations: 1 as const };

  it("asks only trustworthy clients and resolves with the first answer", async () => {
    const desktop = session("desktop");
    const cli = session("cli");
    const voice = session("voice");
    const broker = new ConfirmationBroker({ sessions: () => [desktop, cli, voice] });
    const p = broker.confirm({ ...req, turnId: "t1" });
    const r = requestOf(desktop);
    expect(r).toMatchObject({ turnId: "t1", title: "Escribir notas.md", confirmations: 1 });
    expect(requestOf(cli)?.requestId).toBe(r?.requestId);
    expect(voice.sent).toEqual([]);
    broker.respond(cli, { type: "permission.respond", id: "1", requestId: r?.requestId ?? "", approved: true, confirmations: 1 });
    await expect(p).resolves.toEqual({ approved: true, by: "owner:cli" });
    expect(desktop.sent.at(-1)).toEqual({ type: "permission.resolved", requestId: r?.requestId, approved: true });
    expect(broker.pendingCount).toBe(0);
  });

  it("denies without a screen, on rejection, on a missing second approval, from a stranger", async () => {
    await expect(new ConfirmationBroker({ sessions: () => [session("voice")] }).confirm(req)).resolves.toMatchObject({ approved: false });

    const desktop = session("desktop");
    const stranger = session("desktop", "other");
    let all = [desktop];
    const broker = new ConfirmationBroker({ sessions: () => all });
    const rejected = broker.confirm(req);
    const id1 = requestOf(desktop)?.requestId ?? "";
    broker.respond(desktop, { type: "permission.respond", id: "1", requestId: id1, approved: false, confirmations: 0 });
    await expect(rejected).resolves.toMatchObject({ approved: false, reason: "el owner lo rechazó" });

    desktop.sent.length = 0;
    const destructive = broker.confirm({ ...req, risk: "destructive", confirmations: 2 });
    const id2 = requestOf(desktop)?.requestId ?? "";
    all = [desktop, stranger]; // connected after the request: it was never asked
    broker.respond(stranger, { type: "permission.respond", id: "2", requestId: id2, approved: true, confirmations: 2 });
    expect(stranger.sent.at(-1)).toMatchObject({ type: "error", code: "invalid_message" });
    broker.respond(desktop, { type: "permission.respond", id: "3", requestId: id2, approved: true, confirmations: 1 });
    await expect(destructive).resolves.toMatchObject({ approved: false, reason: "faltó la segunda confirmación" });
  });

  it("times out, follows the turn's cancellation and the window closing", async () => {
    vi.useFakeTimers();
    const desktop = session("desktop");
    const broker = new ConfirmationBroker({ sessions: () => [desktop], timeoutMs: 1_000 });
    const late = broker.confirm(req);
    vi.advanceTimersByTime(1_001);
    await expect(late).resolves.toMatchObject({ approved: false, reason: "sin respuesta del owner" });

    const ac = new AbortController();
    const cancelled = broker.confirm(req, ac.signal);
    ac.abort();
    await expect(cancelled).resolves.toMatchObject({ approved: false, reason: "turno cancelado" });

    const closed = broker.confirm(req);
    broker.disconnected(desktop);
    await expect(closed).resolves.toMatchObject({ approved: false });
    expect(broker.pendingCount).toBe(0);
  });
});

/** A fake MCP server with one tool per risk class; `ran` counts real executions. */
function fakeServer() {
  const ran: string[] = [];
  const server = new McpServer({ name: "fs", version: "0" });
  for (const tool of ["read", "write", "delete"]) {
    server.registerTool(tool, { description: tool, inputSchema: { project: z.string().optional(), path: z.string() } }, async (a: { path: string }) => {
      ran.push(`${tool}:${a.path}`);
      return { content: [{ type: "text" as const, text: `${tool} ok` }] };
    });
  }
  return { server, ran };
}

async function hubWith(answer: (r: PermissionRequest, s: Session, b: ConfirmationBroker) => void) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const desktop = session("desktop");
  const broker = new ConfirmationBroker({ sessions: () => [desktop] });
  desktop.send = (m) => {
    desktop.sent.push(m);
    if (m.type === "permission.request") queueMicrotask(() => answer(m, desktop, broker));
  };
  const hub = new ToolHub(new PermissionEngine(), audit, undefined, broker);
  const { server, ran } = fakeServer();
  await hub.addInProcess("fs", server, { read: "read", write: "confirm", delete: "destructive" }, {
    write: async (a) => {
      const p = (a as { path: string }).path;
      if (p.includes("..")) throw new PreviewError("Ruta no permitida.");
      return { title: `Escribir ${p}`, detail: "+ hola" };
    },
  });
  return { hub, audit, ran, desktop, broker, db };
}

describe("ToolHub with confirmations", () => {
  it("runs a confirmed call once, after the owner approves the Core-built preview", async () => {
    const { hub, audit, ran, desktop } = await hubWith((r, s, b) =>
      b.respond(s, { type: "permission.respond", id: "a", requestId: r.requestId, approved: true, confirmations: 1 }),
    );
    const waiting = vi.fn();
    const r = await hub.call("fs__write", { path: "notas.md" }, { turnId: "t1", onWaiting: waiting });
    expect(r).toEqual({ content: "write ok", isError: false });
    expect(waiting).toHaveBeenCalledOnce();
    expect(requestOf(desktop)).toMatchObject({ title: "Escribir notas.md", detail: "+ hola", risk: "confirm" });
    expect(ran).toEqual(["write:notas.md"]);
    expect(audit.recent(1)[0]).toMatchObject({ tool: "write", decision: "allow", approvedBy: "owner:desktop", ok: true });
  });

  it("never runs what the owner rejects, nor what fails its preview", async () => {
    const { hub, audit, ran } = await hubWith((r, s, b) =>
      b.respond(s, { type: "permission.respond", id: "a", requestId: r.requestId, approved: false, confirmations: 0 }),
    );
    const r = await hub.call("fs__delete", { path: "todo" }, {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Permiso denegado: el owner lo rechazó\. No lo reintentes/);
    const bad = await hub.call("fs__write", { path: "../afuera" }, {});
    expect(bad).toEqual({ content: "Ruta no permitida.", isError: true });
    expect(ran).toEqual([]);
    expect(audit.recent(1)[0]).toMatchObject({ tool: "delete", risk: "destructive", decision: "deny", reason: "el owner lo rechazó" });
  });

  it("reads never ask; without a confirmer anything that asks is denied", async () => {
    const db = openDatabase(":memory:");
    const hub = new ToolHub(new PermissionEngine(), new AuditLog(db));
    const { server, ran } = fakeServer();
    await hub.addInProcess("fs", server, { read: "read", write: "confirm" });
    expect((await hub.call("fs__read", { path: "a" }, {})).isError).toBe(false);
    expect((await hub.call("fs__write", { path: "a" }, {})).content).toMatch(/no hay cómo pedirla/);
    expect(ran).toEqual(["read:a"]);
  });

  it("uses the exact arguments as preview when the server has no custom one", async () => {
    const { hub, desktop } = await hubWith((r, s, b) =>
      b.respond(s, { type: "permission.respond", id: "a", requestId: r.requestId, approved: true, confirmations: 2 }),
    );
    await hub.call("fs__delete", { path: "viejo/" }, {});
    expect(requestOf(desktop)).toMatchObject({ title: "Jarvis quiere usar fs → delete", confirmations: 2 });
    expect(requestOf(desktop)?.detail).toContain('"path": "viejo/"');
  });
});

describe("audit log: listing, export and recent_activity", () => {
  it("lists newest first with paging, exports JSONL oldest first", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db);
    for (let i = 1; i <= 3; i++) audit.record({ server: "fs", tool: `t${i}`, args: { i }, risk: "read", decision: "allow", approvedBy: "policy", ok: true });
    const s = session("desktop");
    const svc = new AuditService(audit, path.join(tmp, "exports"), () => new Date("2026-11-20T10:00:00Z"));
    await svc.handle(s, { type: "audit.list", id: "l", limit: 2 });
    const list = s.sent[0];
    expect(list).toMatchObject({ type: "audit.list.result", entries: [{ tool: "t3", args: '{"i":3}', approvedBy: "policy" }, { tool: "t2" }] });
    await svc.handle(s, { type: "audit.list", id: "l2", beforeId: 2 });
    expect(s.sent[1]).toMatchObject({ entries: [{ tool: "t1" }] });
    await svc.handle(s, { type: "audit.export", id: "e" });
    const exported = s.sent[2] as Extract<CoreMessage, { type: "audit.exported" }>;
    expect(exported).toMatchObject({ type: "audit.exported", count: 3 });
    expect(path.basename(exported.path)).toBe("audit-20261120-100000.jsonl");
    const lines = readFileSync(exported.path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tool: string });
    expect(lines.map((l) => l.tool)).toEqual(["t1", "t2", "t3"]);
  });

  it("answers ¿qué hiciste hoy? from the audit log, without listing itself", async () => {
    const db = openDatabase(":memory:");
    const now = new Date("2026-11-20T12:00:00Z");
    const audit = new AuditLog(db, () => now);
    audit.record({ server: "projects", tool: "write_file", args: { project: "notas", path: "a.md" }, risk: "confirm", decision: "allow", approvedBy: "owner:desktop", ok: true });
    audit.record({ server: "projects", tool: "delete_file", args: { project: "notas", path: "b.md" }, risk: "destructive", decision: "deny", reason: "el owner lo rechazó" });
    const hub = new ToolHub(new PermissionEngine(), audit);
    await hub.addInProcess("jarvis", createJarvisServer({ audit, now: () => now }), { recent_activity: "read" });
    await hub.call("jarvis__recent_activity", {}, {});
    const r = await hub.call("jarvis__recent_activity", { hours: 2 }, {});
    expect(r.content).toContain("projects/write_file [con confirmación]");
    expect(r.content).toContain("aprobada por el owner, ok");
    expect(r.content).toContain("denegada (el owner lo rechazó)");
    expect(r.content).not.toContain("recent_activity");
  });
});
