import type { CoreMessage } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { ChatService } from "./chat.js";
import { type ChatModel, type ChatTurnRequest, TurnCancelledError, UpstreamError } from "./claude/model.js";
import { costOf } from "./claude/pricing.js";
import { localDay, openDatabase } from "./db.js";
import type { Session } from "./server.js";
import { ConversationStore } from "./store.js";

const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 100 };

class FakeModel implements ChatModel {
  readonly model = "claude-opus-5-5";
  requests: ChatTurnRequest[] = [];
  constructor(private readonly behaviour: (req: ChatTurnRequest) => Promise<string> = async (req) => {
    req.onText("Ho");
    req.onText("la");
    return "Hola";
  }) {}
  async complete(req: ChatTurnRequest) {
    this.requests.push(req);
    const text = await this.behaviour(req);
    return { text, stopReason: "end_turn", model: this.model, usage };
  }
}

function fakeSession() {
  const sent: CoreMessage[] = [];
  const session: Session = { id: "s1", client: "cli", send: (m) => sent.push(m), close() {} };
  return { session, sent };
}

function setup(model: ChatModel | null = new FakeModel(), budget = 3) {
  const store = new ConversationStore(openDatabase(":memory:"));
  const service = new ChatService({ store, model: () => model ?? undefined, systemPrompt: "SYS", dailyBudgetUsd: budget });
  return { store, service };
}

describe("ChatService.chatSend", () => {
  it("streams deltas, persists both messages and records the cost", async () => {
    const { store, service } = setup();
    const { session, sent } = fakeSession();
    await service.chatSend(session, { type: "chat.send", id: "m1", text: "hola Jarvis" });

    expect(sent.map((m) => m.type)).toEqual(["chat.started", "chat.delta", "chat.delta", "chat.done"]);
    const started = sent[0] as Extract<CoreMessage, { type: "chat.started" }>;
    const done = sent.at(-1) as Extract<CoreMessage, { type: "chat.done" }>;
    expect(done.costUsd).toBeCloseTo(costOf("claude-opus-5-5", usage));
    expect(store.messages(started.conversationId).map((m) => [m.role, m.content])).toEqual([
      ["user", "hola Jarvis"],
      ["assistant", "Hola"],
    ]);
    expect(store.spentOn(localDay(new Date()))).toBeCloseTo(done.costUsd);
  });

  it("sends the whole conversation history and the system prompt", async () => {
    const model = new FakeModel();
    const { service } = setup(model);
    const { session, sent } = fakeSession();
    await service.chatSend(session, { type: "chat.send", id: "m1", text: "uno" });
    const conversationId = (sent[0] as Extract<CoreMessage, { type: "chat.started" }>).conversationId;
    await service.chatSend(session, { type: "chat.send", id: "m2", conversationId, text: "dos" });
    expect(model.requests[1]?.system).toBe("SYS");
    expect(model.requests[1]?.messages).toEqual([
      { role: "user", content: "uno" },
      { role: "assistant", content: "Hola" },
      { role: "user", content: "dos" },
    ]);
  });

  it("refuses when the daily budget is exhausted, before calling Claude", async () => {
    const model = new FakeModel();
    const { store, service } = setup(model, 0.5);
    const c = store.createConversation("x");
    store.recordUsage({ turnId: "old", conversationId: c.id, model: "claude-opus-5-5", usage, costUsd: 0.5 });
    const { session, sent } = fakeSession();
    await service.chatSend(session, { type: "chat.send", id: "m1", text: "hola" });
    expect(sent).toEqual([expect.objectContaining({ type: "error", id: "m1", code: "budget_exceeded" })]);
    expect(model.requests).toHaveLength(0);
  });

  it("explains how to set the key when none is configured", async () => {
    const { service } = setup(null);
    const { session, sent } = fakeSession();
    await service.chatSend(session, { type: "chat.send", id: "m1", text: "hola" });
    expect(sent[0]).toMatchObject({ type: "error", code: "upstream_error" });
    expect((sent[0] as { message: string }).message).toContain("set-secret");
  });

  it("rejects unknown conversations", async () => {
    const { service } = setup();
    const { session, sent } = fakeSession();
    await service.chatSend(session, { type: "chat.send", id: "m1", conversationId: "nope", text: "hola" });
    expect(sent[0]).toMatchObject({ type: "error", code: "invalid_message" });
  });

  it("maps upstream failures to a safe error and keeps the user message", async () => {
    const model = new FakeModel(async () => {
      throw new UpstreamError("No hay conexión con la API de Anthropic.", undefined, true);
    });
    const { store, service } = setup(model);
    const { session, sent } = fakeSession();
    await service.chatSend(session, { type: "chat.send", id: "m1", text: "hola" });
    expect(sent.at(-1)).toMatchObject({ type: "error", id: "m1", code: "upstream_error", message: "No hay conexión con la API de Anthropic." });
    const conversationId = (sent[0] as Extract<CoreMessage, { type: "chat.started" }>).conversationId;
    expect(store.messages(conversationId).map((m) => m.role)).toEqual(["user"]);
  });
});

describe("ChatService cancellation", () => {
  it("chat.cancel aborts the turn and stores the partial reply as interrupted", async () => {
    let release!: () => void;
    const model = new FakeModel(
      (req) =>
        new Promise((_, reject) => {
          req.onText("Te cuento que");
          req.signal.addEventListener("abort", () => reject(new TurnCancelledError("Te cuento que")));
          release = () => {};
        }),
    );
    const { store, service } = setup(model);
    const { session, sent } = fakeSession();
    const turn = service.chatSend(session, { type: "chat.send", id: "m1", text: "contame algo largo" });
    await expect.poll(() => sent.some((m) => m.type === "chat.delta")).toBe(true);
    const started = sent[0] as Extract<CoreMessage, { type: "chat.started" }>;
    await service.chatCancel(session, { type: "chat.cancel", id: "c1", turnId: started.turnId });
    await turn;
    release();
    expect(sent.at(-1)).toMatchObject({ type: "error", id: "m1", code: "cancelled" });
    expect(store.messages(started.conversationId).at(-1)).toMatchObject({ role: "assistant", content: "Te cuento que", interrupted: true });
  });

  it("disconnecting a client cancels its turns", async () => {
    let aborted = false;
    const model = new FakeModel(
      (req) =>
        new Promise((_, reject) =>
          req.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new TurnCancelledError(""));
          }),
        ),
    );
    const { service } = setup(model);
    const { session } = fakeSession();
    const turn = service.chatSend(session, { type: "chat.send", id: "m1", text: "hola" });
    await expect.poll(() => model.requests.length).toBe(1);
    service.disconnected(session);
    await turn;
    expect(aborted).toBe(true);
  });

  it("allows only one turn at a time per conversation", async () => {
    let finish!: () => void;
    const model = new FakeModel(() => new Promise((resolve) => (finish = () => resolve("ok"))));
    const { service } = setup(model);
    const { session, sent } = fakeSession();
    const first = service.chatSend(session, { type: "chat.send", id: "m1", text: "uno" });
    await expect.poll(() => model.requests.length).toBe(1);
    const conversationId = (sent[0] as Extract<CoreMessage, { type: "chat.started" }>).conversationId;
    await service.chatSend(session, { type: "chat.send", id: "m2", conversationId, text: "dos" });
    expect(sent.at(-1)).toMatchObject({ type: "error", id: "m2", code: "invalid_message" });
    finish();
    await first;
  });
});
