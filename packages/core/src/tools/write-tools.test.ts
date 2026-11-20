import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CoreMessage, PermissionRequest } from "@jarvis/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { PathDeniedError, resolveForWrite, validateRoot } from "../projects/guard.js";
import { ProjectIndex } from "../projects/indexer.js";
import { ProjectStore } from "../projects/store.js";
import type { Session } from "../server.js";
import { ConfirmationBroker } from "./confirm.js";
import { unifiedDiff } from "./diff.js";
import { ToolHub } from "./hub.js";
import { AuditLog, PermissionEngine, type PermissionRule } from "./permissions.js";
import { PROJECTS_SERVER, PROJECTS_TOOLS, createProjectsServer, projectsPreviews } from "./projects-server.js";

let tmp: string;
let root: string;
let trash: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "jarvis-write-"));
  root = path.join(tmp, "notas");
  trash = path.join(tmp, "home", "trash");
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "plan.md"), "# Plan\r\nuno\r\ndos\r\ntres\r\n");
  writeFileSync(path.join(root, "README.md"), "hola\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

type Answer = "approve" | "reject" | ((r: PermissionRequest) => { approved: boolean; confirmations: number });

async function setup(answer: Answer = "approve", rules: PermissionRule[] = []) {
  const db = openDatabase(":memory:");
  const projects = new ProjectStore(db);
  const index = new ProjectIndex(db, projects);
  const project = projects.create({ name: "Notas", root: validateRoot(root, path.join(tmp, "home"), {}) });
  const audit = new AuditLog(db);
  const requests: PermissionRequest[] = [];
  const desktop: Session = { id: "d", client: "desktop", close: () => {}, send: (m: CoreMessage) => {
    if (m.type !== "permission.request") return;
    requests.push(m);
    queueMicrotask(() => {
      const a = typeof answer === "function" ? answer(m) : { approved: answer === "approve", confirmations: answer === "approve" ? m.confirmations : 0 };
      broker.respond(desktop, { type: "permission.respond", id: "x", requestId: m.requestId, ...a });
    });
  } };
  const broker = new ConfirmationBroker({ sessions: () => [desktop] });
  const hub = new ToolHub(new PermissionEngine(rules), audit, undefined, broker);
  const deps = { projects, index, trashDir: trash };
  await hub.addInProcess(PROJECTS_SERVER, createProjectsServer(deps), PROJECTS_TOOLS, projectsPreviews(deps));
  return { hub, audit, requests, project, deps };
}

describe("unifiedDiff", () => {
  it("shows changed lines with context", () => {
    expect(unifiedDiff("a\nb\nc\nd\ne\nf\n", "a\nb\nC\nd\ne\nf\n")).toBe("@@ -1,5 +1,5 @@\n a\n b\n-c\n+C\n d\n e");
    expect(unifiedDiff("", "x\ny")).toBe("@@ -1,0 +1,2 @@\n+x\n+y");
    expect(unifiedDiff("same", "same")).toBe("");
  });
});

describe("resolveForWrite", () => {
  it("allows new files in new folders, nothing outside, in .git, secret or binary", async () => {
    const canon = realpathSync.native(root); // roots are always canonical (validateRoot): 8.3 names on CI
    const r = await resolveForWrite(canon, "nuevo/dir/idea.md");
    expect(r).toMatchObject({ rel: "nuevo/dir/idea.md", exists: false });
    for (const [p, re] of [
      ["../afuera.md", /sale del proyecto/],
      [".git/hooks/pre-commit", /excluida/],
      ["config/.env.local", /secretos/],
      ["tool.exe", /texto/],
      ["C:\\x.md", /relativas/],
      ["docs", /archivos de texto|no es un archivo/],
    ] as const) {
      await expect(resolveForWrite(canon, p)).rejects.toThrow(re);
    }
    await expect(resolveForWrite(canon, "")).rejects.toBeInstanceOf(PathDeniedError);
  });
});

describe("write tools through the hub", () => {
  it("creates a file only after the owner approves the exact content", async () => {
    const { hub, requests, audit } = await setup();
    const r = await hub.call("projects__write_file", { project: "notas", path: "ideas/nueva.md", content: "# Idea\nalgo\n" }, {});
    expect(r).toMatchObject({ isError: false, content: "Creé Notas/ideas/nueva.md (+2 / -0 líneas)." });
    expect(readFileSync(path.join(root, "ideas", "nueva.md"), "utf8")).toBe("# Idea\nalgo\n");
    expect(requests[0]).toMatchObject({ title: "Crear Notas/ideas/nueva.md", risk: "confirm", confirmations: 1 });
    expect(requests[0]?.detail).toContain("+# Idea");
    expect(audit.recent(1)[0]).toMatchObject({ tool: "write_file", approvedBy: "owner:desktop", ok: true });
  });

  it("edits a unique fragment keeping CRLF; ambiguous or missing fragments fail before asking", async () => {
    const { hub, requests } = await setup();
    const ok = await hub.call("projects__edit_file", { project: "Notas", path: "docs/plan.md", old_text: "dos", new_text: "DOS\ndos y medio" }, {});
    expect(ok.content).toBe("Edité Notas/docs/plan.md (+2 / -1 líneas).");
    expect(readFileSync(path.join(root, "docs", "plan.md"), "utf8")).toBe("# Plan\r\nuno\r\nDOS\r\ndos y medio\r\ntres\r\n");
    expect(requests[0]?.detail).toContain("-dos\n+DOS\n+dos y medio");

    const before = requests.length;
    const missing = await hub.call("projects__edit_file", { project: "Notas", path: "docs/plan.md", old_text: "cuatro", new_text: "x" }, {});
    expect(missing).toMatchObject({ isError: true, content: expect.stringMatching(/no encontré old_text/) });
    writeFileSync(path.join(root, "rep.md"), "x\nx\n");
    const twice = await hub.call("projects__edit_file", { project: "Notas", path: "rep.md", old_text: "x", new_text: "y" }, {});
    expect(twice.content).toMatch(/aparece 2 veces/);
    expect(requests.length).toBe(before); // nothing to confirm: the owner was never asked
  });

  it("writes nothing when the owner rejects", async () => {
    const { hub, audit } = await setup("reject");
    const r = await hub.call("projects__write_file", { project: "Notas", path: "README.md", content: "pisado" }, {});
    expect(r.content).toMatch(/^Permiso denegado: el owner lo rechazó/);
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("hola\n");
    expect(audit.recent(1)[0]).toMatchObject({ decision: "deny" });
  });

  it("refuses to write if the file changed after the preview was approved", async () => {
    const { hub } = await setup((m) => {
      writeFileSync(path.join(root, "README.md"), "cambiado por el owner\n"); // changes while the dialog is open
      return { approved: true, confirmations: m.confirmations };
    });
    const r = await hub.call("projects__write_file", { project: "Notas", path: "README.md", content: "nuevo" }, {});
    expect(r).toMatchObject({ isError: true, content: expect.stringMatching(/cambió desde que lo aprobaste/) });
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("cambiado por el owner\n");
  });

  it("deletes into Jarvis' trash only with two confirmations", async () => {
    const once = await setup((m) => ({ approved: true, confirmations: 1 + 0 * m.confirmations }));
    const r1 = await once.hub.call("projects__delete_file", { project: "Notas", path: "README.md" }, {});
    expect(r1.content).toMatch(/faltó la segunda confirmación/);
    expect(existsSync(path.join(root, "README.md"))).toBe(true);

    const { hub, requests } = await setup();
    const r = await hub.call("projects__delete_file", { project: "Notas", path: "README.md" }, {});
    expect(r.content).toMatch(/^Borré Notas\/README\.md \(quedó en la papelera de Jarvis/);
    expect(requests[0]).toMatchObject({ risk: "destructive", confirmations: 2, title: "Borrar Notas/README.md" });
    expect(existsSync(path.join(root, "README.md"))).toBe(false);
    expect(readdirSync(trash)).toHaveLength(1);
  });

  it("a rule can let writes run without asking, but they are still planned and audited", async () => {
    const { hub, requests, audit } = await setup("reject", [{ server: "projects", tool: "write_file", project: "notas", decision: "allow" }]);
    const r = await hub.call("projects__write_file", { project: "Notas", path: "log.md", content: "ok" }, {});
    expect(r.isError).toBe(false);
    expect(requests).toHaveLength(0);
    expect(audit.recent(1)[0]).toMatchObject({ approvedBy: "rule", ok: true });
  });

  it("the server itself refuses writes that do not carry an approved fingerprint", async () => {
    const { deps } = await setup();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createProjectsServer(deps).connect(b);
    const client = new Client({ name: "rogue", version: "0" });
    await client.connect(a);
    const r = await client.callTool({ name: "write_file", arguments: { project: "Notas", path: "x.md", content: "x" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/falta la aprobación/);
    expect(existsSync(path.join(root, "x.md"))).toBe(false);
    await client.close();
  });
});

describe("git tools", () => {
  const initRepo = () => {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  };

  it("commits only the chosen files, never secrets, without hooks or push", async () => {
    initRepo();
    writeFileSync(path.join(root, "README.md"), "hola\nchau\n");
    writeFileSync(path.join(root, ".env"), "API_KEY=sk-ant-abcdefghijklmnop\n");
    writeFileSync(path.join(root, "docs", "otro.md"), "fuera de la selección\n");
    const marker = path.join(tmp, "hook-ran");
    writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, "/")}"\n`);
    const { hub, requests } = await setup();

    const diff = await hub.call("projects__git_diff", { project: "Notas" }, {});
    expect(diff.content).toContain("+chau");
    expect(diff.content).not.toContain("sk-ant");

    const r = await hub.call("projects__git_commit", { project: "Notas", message: "docs: despedida", paths: ["README.md", ".env"] }, {});
    expect(r.content).toMatch(/^Commit [0-9a-f]+ en Notas: docs: despedida \(1 archivos\)\. No hice push\./);
    expect(requests[0]?.detail).toContain("modificado: README.md");
    expect(requests[0]?.detail).toContain("No se incluyen (posibles secretos o carpetas excluidas): .env");
    expect(git("log", "-1", "--name-only", "--pretty=format:%s").trim().split("\n")).toEqual(["docs: despedida", "README.md"]);
    expect(git("status", "--porcelain")).toContain("?? .env");
    expect(git("status", "--porcelain")).toContain("?? docs/otro.md");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses commits with nothing to commit before asking", async () => {
    initRepo();
    const { hub, requests } = await setup();
    const r = await hub.call("projects__git_commit", { project: "Notas", message: "nada", paths: ["."] }, {});
    expect(r).toMatchObject({ isError: true, content: expect.stringMatching(/no hay cambios/) });
    expect(requests).toHaveLength(0);
  });
});
