import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { ConversationStore } from "../store.js";
import { PathDeniedError, deniedReason, isTextFile, resolveInside, validateRoot } from "./guard.js";
import { ProjectIndex, matchExpression, queryTerms } from "./indexer.js";
import { ProjectConflictError, ProjectStore } from "./store.js";

let tmp: string;
let root: string;

function write(rel: string, body: string | Buffer) {
  const abs = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "jarvis-proj-"));
  root = path.join(tmp, "liquidaciones");
  mkdirSync(root);
  write("README.md", "# Liquidaciones\nApp para calcular liquidaciones de sueldo por quincena.\n");
  write("docs/decisiones.md", "Decidimos usar PostgreSQL.\nLa liquidación final se exporta a PDF.\nOtra línea.\n");
  write("src/calc.ts", "export function liquidar(quincena: number) { return quincena * 2; }\n");
  write(".env", "API_KEY=sk-ant-secret");
  write("config/id_rsa", "PRIVATE");
  write("node_modules/dep/index.js", "liquidaciones en dependencias");
  write("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  write("data/blob.txt", Buffer.from("texto\0binario"));
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function setup() {
  const db = openDatabase(":memory:");
  const projects = new ProjectStore(db);
  const index = new ProjectIndex(db, projects);
  const canonical = validateRoot(root, path.join(tmp, "jarvis-home"), {});
  const project = projects.create({ name: "Liquidaciones", root: canonical, description: "app de sueldos" });
  return { db, projects, index, project };
}

describe("path guard", () => {
  it("keeps model paths inside the root and away from secrets and excluded folders", async () => {
    const real = validateRoot(root, path.join(tmp, "home"), {});
    await expect(resolveInside(real, "docs/decisiones.md")).resolves.toMatchObject({ rel: "docs/decisiones.md" });
    await expect(resolveInside(real, "/docs\\decisiones.md")).resolves.toMatchObject({ rel: "docs/decisiones.md" });
    for (const bad of ["../outside.txt", "docs/../../x", "C:\\Windows\\win.ini", "\\\\server\\share", ".env", "config/id_rsa", "node_modules/dep/index.js", "README.md:stream", "nope.md"]) {
      await expect(resolveInside(real, bad), bad).rejects.toBeInstanceOf(PathDeniedError);
    }
  });

  it("does not follow links out of the root", async () => {
    const outside = path.join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "afuera.md"), "fuera");
    try {
      symlinkSync(outside, path.join(root, "link"), "junction");
    } catch {
      return; // no permission to create links on this machine
    }
    const real = validateRoot(root, path.join(tmp, "home"), {});
    await expect(resolveInside(real, "link/afuera.md")).rejects.toThrow(/sale del proyecto/);
  });

  it("classifies files", () => {
    expect(isTextFile("README")).toBe(true);
    expect(isTextFile("notes.md")).toBe(true);
    expect(isTextFile("logo.png")).toBe(false);
    expect(deniedReason("a/.env.local")).toMatch(/secretos/);
    expect(deniedReason("certs/server.pem")).toMatch(/secretos/);
    expect(deniedReason("x/node_modules/y")).toMatch(/excluida/);
    expect(deniedReason("docs/a.md")).toBeUndefined();
  });

  it("refuses roots that are too broad or Jarvis' own data", () => {
    const home = path.join(tmp, "jarvis-home");
    mkdirSync(home);
    expect(() => validateRoot("relative/path", home, {})).toThrow(/absoluta/);
    expect(() => validateRoot(path.join(tmp, "missing"), home, {})).toThrow(/no existe/);
    expect(() => validateRoot(path.parse(tmp).root, home, {})).toThrow(/unidad/);
    expect(() => validateRoot(tmp, home, {})).toThrow(/datos de Jarvis/);
    expect(() => validateRoot(home, home, {})).toThrow(/datos de Jarvis/);
    expect(() => validateRoot(tmp, path.join(os.tmpdir(), "elsewhere"), { WINDIR: tmp })).toThrow(/sistema/);
    expect(() => validateRoot(os.homedir(), home, {})).toThrow(/perfil/);
  });
});

describe("ProjectStore", () => {
  it("registers projects with unique names and roots and links conversations", () => {
    const { db, projects, project } = setup();
    expect(projects.find("liquidaciones")?.id).toBe(project.id);
    expect(projects.find(project.id)?.name).toBe("Liquidaciones");
    expect(() => projects.create({ name: "LIQUIDACIONES", root: path.join(tmp, "other") })).toThrow(ProjectConflictError);
    expect(() => projects.create({ name: "Otro", root: project.root.toUpperCase() })).toThrow(ProjectConflictError);

    const conversations = new ConversationStore(db);
    const c = conversations.createConversation("hola");
    expect(projects.setConversationProject(c.id, project.id)).toBe(true);
    expect(projects.conversationProject(c.id)?.id).toBe(project.id);
    expect(projects.update(project.id, { goals: "lanzar en marzo" })?.goals).toBe("lanzar en marzo");
    expect(projects.delete(project.id)).toBe(true);
    expect(projects.conversationProject(c.id)).toBeUndefined(); // ON DELETE SET NULL
  });
});

describe("ProjectIndex", () => {
  it("indexes text files only, never secrets, dependencies or binaries", async () => {
    const { index, project, db } = setup();
    const r = await index.scan(project);
    expect(r).toMatchObject({ files: 4, indexed: 3, removed: 0, truncated: false }); // blob.txt is read but binary
    const paths = (db.prepare("SELECT rel_path AS p FROM files ORDER BY p").all() as { p: string }[]).map((x) => x.p);
    expect(paths).toEqual(["README.md", "docs/decisiones.md", "src/calc.ts"]);
    expect(await index.search("API_KEY sk-ant-secret")).toEqual([]);
  });

  it("finds documents ignoring accents and inflections, with snippets read from disk", async () => {
    const { index, project } = setup();
    await index.scan(project);
    const hits = await index.search("¿Cómo se exporta la liquidación?");
    expect(hits[0]).toMatchObject({ project: "Liquidaciones", path: "docs/decisiones.md" });
    expect(hits[0]?.snippets).toEqual([{ line: 2, text: "La liquidación final se exporta a PDF." }]);
    expect((await index.search("liquidaciones")).map((h) => h.path)).toContain("README.md");
    expect(await index.search("postgresql", { projectId: "other" })).toEqual([]);
    expect(await index.search("¿qué es?")).toEqual([]); // only stop words
  });

  it("rescans incrementally: changed, new and deleted files", async () => {
    const { index, project } = setup();
    await index.scan(project);
    write("docs/decisiones.md", "Cambiamos a SQLite.\n");
    const future = new Date(Date.now() + 5_000);
    utimesSync(path.join(root, "docs", "decisiones.md"), future, future);
    write("docs/nuevo.md", "Roadmap del trimestre\n");
    rmSync(path.join(root, "src", "calc.ts"));
    const r = await index.scan(project);
    expect(r).toMatchObject({ indexed: 2, removed: 1 });
    expect(await index.search("postgresql")).toEqual([]);
    expect((await index.search("sqlite")).map((h) => h.path)).toEqual(["docs/decisiones.md"]);
    expect((await index.search("trimestre")).map((h) => h.path)).toEqual(["docs/nuevo.md"]);
    expect(await index.search("liquidar")).toEqual([]);
  });

  it("deleting a project drops its index", async () => {
    const { index, project, projects, db } = setup();
    await index.scan(project);
    projects.delete(project.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM files").get()).toMatchObject({ n: 0 });
    expect(await index.search("liquidaciones")).toEqual([]);
  });

  it("watcher picks up new files", async () => {
    const { index, project } = setup();
    await index.scan(project);
    index.watch(project);
    write("docs/watch.md", "Nota sobre facturacion electronica\n");
    let hits: unknown[] = [];
    for (let i = 0; i < 40 && !hits.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      hits = await index.search("facturación");
    }
    index.close();
    expect(hits).toHaveLength(1);
  });

  it("builds safe match expressions", () => {
    expect(queryTerms('Liquidación "final" OR NEAR(x)')).toEqual(["liquidacion", "final", "near", "x"].filter((t) => t.length >= 2));
    expect(matchExpression(["liquidacion", "pdf"])).toBe('"liquidacion"* OR "pdf"');
  });
});
