import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookCallback, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CoreMessage, PermissionRequest } from "@jarvis/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDay, openDatabase } from "../db.js";
import { validateRoot } from "../projects/guard.js";
import { ProjectStore } from "../projects/store.js";
import type { Session } from "../server.js";
import { ConversationStore } from "../store.js";
import { BUILDER_SERVER, BUILDER_SERVER_TOOLS, builderPreviews, createBuilderServer } from "../tools/builder-server.js";
import { ConfirmationBroker } from "../tools/confirm.js";
import { ToolHub } from "../tools/hub.js";
import { AuditLog, PermissionEngine } from "../tools/permissions.js";
import { BuilderConfig } from "./config.js";
import { DEFAULT_COMMANDS, checkToolCall, commandDenied } from "./policy.js";
import { type QueryFn, builderEnv } from "./runner.js";
import { Builder } from "./service.js";
import { BuilderTaskStore } from "./store.js";
import { branchName, createWorkspace } from "./workspace.js";

let tmp: string;
let root: string;
let home: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

beforeEach(() => {
  tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "jarvis-builder-")));
  root = path.join(tmp, "utils");
  home = path.join(tmp, "home");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(home);
  writeFileSync(path.join(root, "README.md"), "# Utils\n");
  writeFileSync(path.join(root, "src", "index.js"), "export const one = 1;\n");
  writeFileSync(path.join(root, "secrets.json"), '{"token":"tracked-secret"}\n'); // tracked by mistake
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Owner");
  git(root, "config", "user.email", "owner@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  writeFileSync(path.join(root, ".env"), "API_KEY=sk-ant-untracked-secret\n"); // untracked
});
afterEach(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

describe("command allowlist", () => {
  const allow = [...DEFAULT_COMMANDS, "node --test", "npm test"];
  it("allows listed simple commands, with extra arguments", () => {
    for (const c of ["git status", "git diff --stat", "node --test", "node --test src/x.test.js", "npm test", "git log -n 3 --oneline"]) {
      expect(commandDenied(c, allow), c).toBeUndefined();
    }
  });
  it("refuses everything else", () => {
    for (const [c, re] of [
      ["curl https://example.com", /lista de comandos/],
      ["node -e 1", /lista de comandos/],
      ["npm install left-pad", /lista de comandos/],
      ["git push origin main", /lista de comandos/],
      ["npm test && curl x", /comandos simples/],
      ["npm test; rm -rf .", /comandos simples/],
      ["node --test | tee out", /comandos simples/],
      ["node --test > out.txt", /comandos simples/],
      ["echo $ANTHROPIC_API_KEY", /comandos simples/],
      ["node --test $(cat x)", /comandos simples/],
      ["node --test ../outside.test.js", /rutas relativas/],
      ["node --test C:/Users/x.js", /rutas relativas/],
      ["node --test /etc/passwd", /rutas relativas/],
      ["git diff --output=x.txt", /opción de git/],
      ["git -c core.pager=evil log", /opción de git/],
      ['node --test "unclosed', /comillas/],
    ] as const) {
      expect(commandDenied(c, allow), c).toMatch(re);
    }
  });
});

describe("tool gate", () => {
  it("keeps file tools inside the workspace, away from .git and secrets", () => {
    const ws = root;
    const ok = (tool: string, input: unknown) => checkToolCall(ws, tool, input, DEFAULT_COMMANDS).allow;
    expect(ok("Read", { file_path: path.join(ws, "src", "index.js") })).toBe(true);
    expect(ok("Write", { file_path: "src/new.js", content: "x" })).toBe(true);
    expect(ok("Edit", { file_path: path.join(ws, "node_modules", "x", "a.js") })).toBe(true);
    expect(ok("Read", { file_path: path.join(tmp, "home", "jarvis.db") })).toBe(false);
    expect(ok("Write", { file_path: "../escape.js", content: "x" })).toBe(false);
    expect(ok("Read", { file_path: path.join(ws, ".env") })).toBe(false);
    expect(ok("Edit", { file_path: path.join(ws, ".git", "config") })).toBe(false);
    expect(ok("Grep", { pattern: "token", path: ".." })).toBe(false);
    expect(ok("Grep", { pattern: "token", glob: "**/.env*" })).toBe(false);
    expect(ok("Glob", { pattern: "**/*.js" })).toBe(true);
    expect(ok("Glob", { pattern: "../**/*" })).toBe(false);
    expect(ok("Bash", { command: "git status" })).toBe(true);
    expect(ok("Bash", { command: "git status", run_in_background: true })).toBe(false);
    for (const t of ["WebFetch", "WebSearch", "Agent", "Task", "NotebookEdit", "mcp__x__y", "KillShell"]) expect(ok(t, {})).toBe(false);
  });

  it("gives the agent a minimal environment without Jarvis' secrets", () => {
    const env = builderEnv("sk-test", "C:/cfg", { PATH: "p", JARVIS_GOOGLE_TTS_API_KEY: "g", NODE_OPTIONS: "--require x", ANTHROPIC_BASE_URL: "http://evil" });
    expect(env).toMatchObject({ PATH: "p", ANTHROPIC_API_KEY: "sk-test", CLAUDE_CONFIG_DIR: "C:/cfg", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
    expect(Object.keys(env).some((k) => k.startsWith("JARVIS_") || k === "NODE_OPTIONS" || k === "ANTHROPIC_BASE_URL")).toBe(false);
  });
});

describe("workspace", () => {
  it("checks out only tracked files and hides tracked secrets", async () => {
    const ws = await createWorkspace(root, path.join(home, "workspaces", "t1"), "jarvis/test-t1");
    expect(existsSync(path.join(ws.dir, "src", "index.js"))).toBe(true);
    expect(existsSync(path.join(ws.dir, ".env"))).toBe(false);
    expect(existsSync(path.join(ws.dir, "secrets.json"))).toBe(false);
    expect(ws).toMatchObject({ baseBranch: "main", branch: "jarvis/test-t1" });
    expect(git(root, "status", "--porcelain")).toBe("?? .env\n"); // the owner's tree is untouched
  });

  it("names branches from the task", () => {
    expect(branchName("Agregá una función slugify() con tests!", new Date("2026-11-20T10:00:00Z"), "abcd1234")).toBe("jarvis/20261120-agrega-una-funcion-slugify-con-tests-abcd");
  });
});

// ------------------------------------------------------------------ end to end with a fake agent

type Step = { tool: string; input: Record<string, unknown> };

/** Plays the SDK: asks the PreToolUse hook before each step and only acts when allowed. */
function fakeAgent(steps: Step[], result: Partial<SDKMessage> = {}): { query: QueryFn; seen: Options[]; denied: string[] } {
  const seen: Options[] = [];
  const denied: string[] = [];
  const query: QueryFn = async function* ({ options }) {
    seen.push(options);
    const gate = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    for (const s of steps) {
      const out = (await gate(
        { hook_event_name: "PreToolUse", tool_name: s.tool, tool_input: s.input, tool_use_id: "x", session_id: "s", transcript_path: "", cwd: options.cwd ?? "" },
        "x",
        { signal: new AbortController().signal },
      )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      if (out.hookSpecificOutput?.permissionDecision !== "allow") {
        denied.push(`${s.tool}: ${out.hookSpecificOutput?.permissionDecisionReason ?? ""}`);
        continue;
      }
      if (s.tool === "Write") {
        const abs = path.resolve(options.cwd ?? "", String(s.input.file_path));
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, String(s.input.content));
      }
    }
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Agregué slugify en src/slugify.js." }] } } as unknown as SDKMessage;
    yield { type: "result", subtype: "success", total_cost_usd: 0.42, num_turns: 7, result: "Agregué src/slugify.js con tests. Probalo con node --test.", ...result } as unknown as SDKMessage;
  };
  return { query, seen, denied };
}

async function setup(agent: ReturnType<typeof fakeAgent>, answer: "approve" | "reject" = "approve") {
  const db = openDatabase(":memory:");
  const projects = new ProjectStore(db);
  const project = projects.create({ name: "Utils", root: validateRoot(root, home, {}) });
  const audit = new AuditLog(db);
  const conversations = new ConversationStore(db);
  const requests: PermissionRequest[] = [];
  const events: CoreMessage[] = [];
  const desktop: Session = {
    id: "d",
    client: "desktop",
    close: () => {},
    send: (m: CoreMessage) => {
      if (m.type !== "permission.request") return;
      requests.push(m);
      queueMicrotask(() => broker.respond(desktop, { type: "permission.respond", id: "x", requestId: m.requestId, approved: answer === "approve", confirmations: answer === "approve" ? m.confirmations : 0 }));
    },
  };
  const broker = new ConfirmationBroker({ sessions: () => [desktop] });
  const hub = new ToolHub(new PermissionEngine(), audit, undefined, broker);
  const builder = new Builder({
    tasks: new BuilderTaskStore(db),
    projects,
    audit,
    home,
    apiKey: () => "sk-ant-test",
    model: "claude-opus-5-5",
    spentToday: () => conversations.spentOn(localDay(new Date())),
    dailyBudgetUsd: 3,
    broadcast: (m) => events.push(m),
    query: agent.query,
    config: () => BuilderConfig.parse({ budgetUsd: 1, projects: { utils: { commands: ["node --test"] } } }),
  });
  await hub.addInProcess(BUILDER_SERVER, createBuilderServer(builder), BUILDER_SERVER_TOOLS, builderPreviews(builder));
  return { hub, builder, audit, requests, events, project, conversations };
}

const slugify = { tool: "Write", input: { file_path: "src/slugify.js", content: "export const slugify = (s) => s.toLowerCase();\n" } };

describe("Builder through the hub", () => {
  it("runs an approved task in a worktree, then merges only the approved diff", async () => {
    const agent = fakeAgent([
      { tool: "Read", input: { file_path: "src/index.js" } },
      slugify,
      { tool: "Write", input: { file_path: "../../escape.js", content: "x" } },
      { tool: "Read", input: { file_path: ".env" } },
      { tool: "Bash", input: { command: "curl https://example.com" } },
      { tool: "Bash", input: { command: "node --test" } },
      { tool: "WebFetch", input: { url: "https://example.com" } },
    ]);
    const { hub, builder, audit, requests, events, conversations } = await setup(agent);

    const r = await hub.call("builder__start_task", { project: "Utils", task: "Agregá una función slugify en src/slugify.js" }, {});
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^Arranqué la tarea [0-9a-f]{8} en la rama jarvis\//);
    expect(requests[0]).toMatchObject({ title: "Builder: tarea nueva en Utils", risk: "confirm" });
    expect(requests[0]?.detail).toContain("Agregá una función slugify");
    expect(requests[0]?.detail).toContain("Presupuesto máximo: US$ 1.00");
    expect(requests[0]?.detail).toContain("node --test");
    await builder.settled();

    // The agent ran locked down.
    const opts = agent.seen[0] as Options;
    expect(opts).toMatchObject({ settingSources: [], permissionMode: "dontAsk", permissionPrompts: "none", strictMcpConfig: true, persistSession: false, maxBudgetUsd: 1, model: "claude-opus-5-5" });
    expect(opts.tools).not.toContain("WebFetch");
    expect(opts.cwd?.startsWith(path.join(home, "workspaces"))).toBe(true);
    expect(agent.denied).toHaveLength(4);
    expect(existsSync(path.join(tmp, "escape.js"))).toBe(false);
    expect(existsSync(path.join(home, "escape.js"))).toBe(false);

    // Nothing in the owner's folder yet: the work is on the task branch.
    expect(existsSync(path.join(root, "src", "slugify.js"))).toBe(false);
    const [task] = builder.list();
    expect(task).toMatchObject({ status: "review", filesChanged: 1, costUsd: 0.42, project: "Utils" });
    expect(events.some((e) => e.type === "builder.task" && e.task.status === "review")).toBe(true);
    expect(conversations.spentOn(localDay(new Date()))).toBeCloseTo(0.42); // counts towards the daily cap

    const builderAudit = audit.recent(50).filter((e) => e.server === "builder" && e.turnId?.startsWith("builder:"));
    expect(builderAudit.filter((e) => e.decision === "deny")).toHaveLength(4);
    expect(JSON.stringify(builderAudit)).not.toContain("toLowerCase"); // file contents are never audited

    const status = await hub.call("builder__task_status", { task_id: task?.id.slice(0, 8) }, {});
    expect(status.content).toContain("lista para revisar");
    expect(status.content).toContain("<resumen_del_builder>");

    const m = await hub.call("builder__merge_task", { task_id: task?.id.slice(0, 8) }, {});
    expect(m.content).toMatch(/^Mergeé la tarea .* en Utils\/main/);
    expect(requests[1]?.title).toMatch(/^Builder: mergear la tarea/);
    expect(requests[1]?.detail).toContain("+export const slugify");
    expect(readFileSync(path.join(root, "src", "slugify.js"), "utf8")).toContain("slugify");
    expect(git(root, "log", "-1", "--pretty=%s")).toMatch(/^Merge jarvis\//);
    expect(git(root, "branch", "--list", "jarvis/*").trim()).toBe(""); // branch and worktree cleaned up
    expect(git(root, "status", "--porcelain")).toBe("?? .env\n");
    expect(readFileSync(path.join(root, ".env"), "utf8")).toContain("untracked-secret");
    expect(git(root, "ls-files")).toContain("secrets.json"); // the hidden tracked file was not deleted by the merge
  });

  it("starts nothing and creates no branch when the owner rejects", async () => {
    const agent = fakeAgent([slugify]);
    const { hub, builder } = await setup(agent, "reject");
    const r = await hub.call("builder__start_task", { project: "Utils", task: "Agregá una función slugify" }, {});
    expect(r.content).toMatch(/^Permiso denegado/);
    expect(agent.seen).toHaveLength(0);
    expect(builder.list()).toHaveLength(0);
    expect(git(root, "branch", "--list", "jarvis/*").trim()).toBe("");
  });

  it("the server refuses to start or merge without an approved fingerprint", async () => {
    const agent = fakeAgent([slugify]);
    const { builder } = await setup(agent);
    await expect(builder.start(builder.planStart("Utils", "Agregá una función slugify"), "forged")).rejects.toThrow(/falta la aprobación/);
    const plan = builder.planStart("Utils", "Agregá una función slugify");
    await builder.start(plan, plan.fingerprint);
    await builder.settled();
    const [t] = builder.list();
    await expect(builder.merge(await builder.planReview(t?.id ?? ""), undefined)).rejects.toThrow(/falta la aprobación/);
    expect(existsSync(path.join(root, "src", "slugify.js"))).toBe(false);
  });

  it("discards a task: workspace and branch gone, owner's folder untouched", async () => {
    const { hub, builder } = await setup(fakeAgent([slugify]));
    await hub.call("builder__start_task", { project: "Utils", task: "Agregá una función slugify" }, {});
    await builder.settled();
    const [t] = builder.list();
    const r = await hub.call("builder__discard_task", { task_id: t?.id ?? "" }, {});
    expect(r.content).toMatch(/^Descarté la tarea/);
    expect(builder.list()[0]?.status).toBe("discarded");
    expect(git(root, "branch", "--list", "jarvis/*").trim()).toBe("");
    expect(existsSync(path.join(home, "workspaces", (t?.id ?? "").slice(0, 8)))).toBe(false);
    expect(existsSync(path.join(root, "src", "slugify.js"))).toBe(false);
  });

  it("a task that changes nothing or runs out of budget is reported honestly", async () => {
    const none = await setup(fakeAgent([{ tool: "Read", input: { file_path: "README.md" } }]));
    await none.hub.call("builder__start_task", { project: "Utils", task: "Revisá el README y mejoralo" }, {});
    await none.builder.settled();
    expect(none.builder.list()[0]).toMatchObject({ status: "failed", error: "no cambió ningún archivo" });
    const m = await none.hub.call("builder__merge_task", { task_id: none.builder.list()[0]?.id ?? "" }, {});
    expect(m.content).toMatch(/no está lista para revisar/);

    rmSync(path.join(home, "workspaces"), { recursive: true, force: true });
    const broke = await setup(fakeAgent([slugify], { subtype: "error_max_budget_usd", total_cost_usd: 1.01, errors: [] } as Partial<SDKMessage>));
    await broke.hub.call("builder__start_task", { project: "Utils", task: "Agregá una función slugify" }, {});
    await broke.builder.settled();
    expect(broke.builder.list()[0]).toMatchObject({ status: "review", error: "se agotó el presupuesto de US$ 1.00", filesChanged: 1 });
  });

  it("one task at a time, within the daily cap, only in git projects", async () => {
    const { builder, conversations } = await setup(fakeAgent([slugify]));
    const plan = builder.planStart("Utils", "Agregá una función slugify");
    const t = await builder.start(plan, plan.fingerprint);
    expect(() => builder.planStart("Utils", "Otra tarea distinta de prueba")).toThrow(/ya hay una tarea/);
    await builder.settled(t.id);
    expect(builder.planStart("Utils", "Otra tarea distinta de prueba", 50).budgetUsd).toBeCloseTo(3 - conversations.spentOn(localDay(new Date())));
    expect(() => builder.planStart("Nada", "Agregá una función slugify")).toThrow(/no hay un proyecto/);
  });
});
