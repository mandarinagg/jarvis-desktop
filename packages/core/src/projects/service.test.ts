import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CoreMessage, ProjectsListResult } from "@jarvis/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../chat.js";
import type { ChatModel } from "../claude/model.js";
import { openDatabase } from "../db.js";
import type { Session } from "../server.js";
import { ConversationStore } from "../store.js";
import { ProjectIndex } from "./indexer.js";
import { ProjectsService } from "./service.js";
import { ProjectStore } from "./store.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "jarvis-psvc-"));
  mkdirSync(path.join(tmp, "app"));
  writeFileSync(path.join(tmp, "app", "README.md"), "# App de pagos\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function setup() {
  const db = openDatabase(":memory:");
  const projects = new ProjectStore(db);
  const index = new ProjectIndex(db, projects);
  const broadcasts: CoreMessage[] = [];
  const conversations = new ConversationStore(db);
  const model: ChatModel = { model: "m", complete: async () => ({ text: "ok", stopReason: "end_turn", model: "claude-opus-5-5", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }) };
  const chat = new ChatService({ store: conversations, model: () => model, systemPrompt: "S", dailyBudgetUsd: 3, projects });
  const svc = new ProjectsService({
    projects,
    index,
    jarvisHome: path.join(tmp, "home"),
    broadcast: (m) => broadcasts.push(m),
    conversationsChanged: (s, id) => chat.conversationsList(s, { type: "conversations.list", id }),
    env: {},
  });
  const sent: CoreMessage[] = [];
  const session: Session = { id: "s", client: "desktop", send: (m) => sent.push(m), close() {} };
  return { svc, sent, session, broadcasts, chat, index, projects };
}

const lastList = (msgs: CoreMessage[]) => msgs.filter((m): m is ProjectsListResult => m.type === "projects.list.result").at(-1);

describe("ProjectsService", () => {
  it("registers a folder, indexes it in the background and broadcasts the list", async () => {
    const t = setup();
    t.svc.handle(t.session, { type: "projects.create", id: "c1", name: "Pagos", root: path.join(tmp, "app"), description: "app de pagos" });
    expect(lastList(t.sent)).toMatchObject({ id: "c1", projects: [{ name: "Pagos", description: "app de pagos" }] });
    for (let i = 0; i < 50 && lastList(t.broadcasts)?.projects[0]?.indexing !== false; i++) await new Promise((r) => setTimeout(r, 10));
    expect(lastList(t.broadcasts)?.projects[0]).toMatchObject({ indexing: false, files: 1 });
    t.index.close();
  });

  it("rejects bad folders and duplicate names with readable errors", () => {
    const t = setup();
    t.svc.handle(t.session, { type: "projects.create", id: "c1", name: "A", root: path.join(tmp, "nope") });
    t.svc.handle(t.session, { type: "projects.create", id: "c2", name: "A", root: path.join(tmp, "app") });
    t.svc.handle(t.session, { type: "projects.create", id: "c3", name: "a", root: path.join(tmp, "app") });
    t.svc.handle(t.session, { type: "projects.create", id: "c4", name: "Home", root: path.join(tmp, "home", "..") });
    const errors = t.sent.filter((m) => m.type === "error").map((m) => [(m as { id: string }).id, (m as { message: string }).message]);
    expect(errors).toEqual([
      ["c1", "la carpeta no existe"],
      ["c3", "ya existe un proyecto llamado «a»"],
      ["c4", "no se puede autorizar la carpeta de datos de Jarvis"],
    ]);
    t.index.close();
  });

  it("new conversations take the chosen project; setProject and delete keep them consistent", async () => {
    const t = setup();
    t.svc.handle(t.session, { type: "projects.create", id: "c1", name: "Pagos", root: path.join(tmp, "app") });
    const projectId = lastList(t.sent)?.projects[0]?.id ?? "";
    await t.chat.chatSend(t.session, { type: "chat.send", id: "m1", text: "hola", projectId });
    const conversationId = (t.sent.find((m) => m.type === "chat.started") as { conversationId: string }).conversationId;
    expect(t.projects.conversationProject(conversationId)?.id).toBe(projectId);

    t.svc.handle(t.session, { type: "conversations.setProject", id: "p1", conversationId, projectId: null });
    expect(t.sent.at(-1)).toMatchObject({ type: "conversations.list.result", id: "p1", conversations: [{ id: conversationId }] });
    expect((t.sent.at(-1) as { conversations: object[] }).conversations[0]).not.toHaveProperty("projectId");

    t.svc.handle(t.session, { type: "conversations.setProject", id: "p2", conversationId, projectId });
    expect(t.sent.at(-1)).toMatchObject({ conversations: [{ id: conversationId, projectId }] });
    t.svc.handle(t.session, { type: "projects.delete", id: "d1", projectId });
    expect(lastList(t.sent)).toMatchObject({ id: "d1", projects: [] });
    expect(t.projects.conversationProject(conversationId)).toBeUndefined();
    t.svc.handle(t.session, { type: "conversations.setProject", id: "p3", conversationId, projectId });
    expect(t.sent.at(-1)).toMatchObject({ type: "error", id: "p3", message: "el proyecto no existe" });
    t.index.close();
  });
});
