import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localDay, openDatabase, schemaVersion } from "./db.js";
import { ConversationStore } from "./store.js";

const dirs: string[] = [];
function tempDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-db-"));
  dirs.push(dir);
  return path.join(dir, "jarvis.db");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 10 };

describe("openDatabase", () => {
  it("applies migrations once and uses WAL", () => {
    const file = tempDb();
    const db = openDatabase(file);
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    db.close();
    const again = openDatabase(file);
    expect(schemaVersion(again)).toBe(1);
    again.close();
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(":memory:");
    const store = new ConversationStore(db);
    expect(() => store.appendMessage({ conversationId: "missing", turnId: "t", role: "user", content: "x" })).toThrow();
    db.close();
  });
});

describe("ConversationStore", () => {
  it("creates conversations titled from the first message and keeps message order", () => {
    const store = new ConversationStore(openDatabase(":memory:"));
    const c = store.createConversation("¿Qué proyectos tengo activos esta semana y cuáles están atrasados?");
    expect(c.title.length).toBeLessThanOrEqual(60);
    store.appendMessage({ conversationId: c.id, turnId: "t1", role: "user", content: "hola" });
    store.appendMessage({ conversationId: c.id, turnId: "t1", role: "assistant", content: "¡Hola!" });
    store.appendMessage({ conversationId: c.id, turnId: "t2", role: "user", content: "chau", });
    expect(store.messages(c.id).map((m) => m.content)).toEqual(["hola", "¡Hola!", "chau"]);
  });

  it("marks interrupted assistant replies (barge-in / cancel)", () => {
    const store = new ConversationStore(openDatabase(":memory:"));
    const c = store.createConversation("x");
    store.appendMessage({ conversationId: c.id, turnId: "t1", role: "assistant", content: "Te cuen", interrupted: true });
    expect(store.messages(c.id)[0]).toMatchObject({ interrupted: true });
  });

  it("lists conversations most recent first", () => {
    let now = Date.parse("2026-11-13T10:00:00Z");
    const store = new ConversationStore(openDatabase(":memory:"), () => new Date(now));
    const a = store.createConversation("a");
    now += 1000;
    const b = store.createConversation("b");
    now += 1000;
    store.appendMessage({ conversationId: a.id, turnId: "t", role: "user", content: "bump" });
    expect(store.listConversations().map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it("sums the cost of a local day for the daily cap", () => {
    const at = new Date("2026-11-13T15:00:00");
    const store = new ConversationStore(openDatabase(":memory:"), () => at);
    const c = store.createConversation("x");
    store.recordUsage({ turnId: "t1", conversationId: c.id, model: "claude-opus-5-5", usage, costUsd: 0.25 });
    store.recordUsage({ turnId: "t2", conversationId: c.id, model: "claude-opus-5-5", usage, costUsd: 0.5 });
    expect(store.spentOn(localDay(at))).toBeCloseTo(0.75);
    expect(store.spentOn("2026-11-12")).toBe(0);
    expect(store.conversationCost(c.id)).toBeCloseTo(0.75);
  });
});

describe("localDay", () => {
  it("uses the local calendar day, not UTC", () => {
    const d = new Date(2026, 10, 13, 23, 30); // 13 Nov, 23:30 local
    expect(localDay(d)).toBe("2026-11-13");
  });
});
