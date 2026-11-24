import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { ToolRuntime } from "../tools/hub.js";
import { AnthropicChatModel, MAX_TOOL_ROUNDS, type ToolEvent, TurnCancelledError } from "./model.js";

type Block = Record<string, unknown> & { type: string };
interface Scripted {
  text?: string[];
  content: Block[];
  stop: string;
}

/** Stand-in for client.beta.messages.stream: replays scripted rounds and records each request. */
function fakeClient(rounds: Scripted[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>, opts: { signal?: AbortSignal }) {
          requests.push(structuredClone(params));
          const round = rounds.shift();
          if (!round) throw new Error("no more scripted rounds");
          const listeners: ((d: string) => void)[] = [];
          return {
            on(_event: "text", fn: (d: string) => void) {
              listeners.push(fn);
              return this;
            },
            async finalMessage() {
              for (const d of round.text ?? []) for (const l of listeners) l(d);
              if (opts.signal?.aborted) throw new Error("aborted");
              return {
                model: "claude-opus-5-5",
                stop_reason: round.stop,
                content: round.content,
                usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
              };
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

function runtime(results: Record<string, { content: string; isError: boolean }> = {}) {
  const calls: { name: string; input: unknown; turnId?: string | undefined }[] = [];
  const rt: ToolRuntime = {
    definitions: () => [{ name: "projects__search", description: "buscar", input_schema: { type: "object" } }],
    describe: (name) => `hago ${name}`,
    async call(name, input, ctx) {
      calls.push({ name, input, turnId: ctx.turnId });
      return results[name] ?? { content: "resultado", isError: false };
    },
  };
  return { rt, calls };
}

describe("AnthropicChatModel tool loop", () => {
  it("runs tools, sends the assistant turn back unchanged and streams all text", async () => {
    const { client, requests } = fakeClient([
      { text: ["Busco"], content: [thinking, { type: "text", text: "Busco" }, use("u1", "projects__search", { query: "pagos" })], stop: "tool_use" },
      { text: ["Está en docs/a.md."], content: [{ type: "text", text: "Está en docs/a.md." }], stop: "end_turn" },
    ]);
    const { rt, calls } = runtime();
    const events: ToolEvent[] = [];
    let streamed = "";
    const model = new AnthropicChatModel({ apiKey: "k", client });
    const r = await model.complete({
      system: "SYS",
      systemSuffix: "Proyecto activo",
      messages: [{ role: "user", content: "¿dónde está?" }],
      signal: new AbortController().signal,
      onText: (d) => (streamed += d),
      tools: rt,
      turnId: "t1",
      onTool: (e) => events.push(e),
    });
    expect(r.text).toBe("Busco\n\nEstá en docs/a.md.");
    expect(streamed).toBe(r.text);
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 0 });
    expect(calls).toEqual([{ name: "projects__search", input: { query: "pagos" }, turnId: "t1" }]);
    expect(events.map((e) => e.status)).toEqual(["started", "done"]);

    // Same system and tools in every round; history is append-only with the thinking block intact.
    expect(requests[1]?.system).toEqual(requests[0]?.system);
    expect(requests[1]?.tools).toEqual(requests[0]?.tools);
    const msgs = requests[1]?.messages as { role: string; content: unknown }[];
    expect(msgs).toHaveLength(3);
    expect((msgs[1]?.content as Block[])[0]).toEqual(thinking);
    expect(msgs[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "resultado" }] });
    expect(requests[0]?.system).toEqual([
      { type: "text", text: "SYS", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Proyecto activo" },
    ]);
  });

  it("forces an answer after MAX_TOOL_ROUNDS without changing the tool list", async () => {
    const rounds: Scripted[] = Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => ({
      content: [use(`u${i}`, "projects__search", { query: String(i) })],
      stop: "tool_use",
    }));
    rounds.push({ text: ["Con lo que encontré: …"], content: [{ type: "text", text: "Con lo que encontré: …" }], stop: "end_turn" });
    const { client, requests } = fakeClient(rounds);
    const { rt, calls } = runtime();
    const model = new AnthropicChatModel({ apiKey: "k", client });
    const r = await model.complete({ system: "S", messages: [{ role: "user", content: "x" }], signal: new AbortController().signal, onText: () => {}, tools: rt });
    expect(calls).toHaveLength(MAX_TOOL_ROUNDS);
    expect(requests.at(-1)?.tool_choice).toEqual({ type: "none" });
    expect(requests[0]?.tool_choice).toBeUndefined();
    expect(requests.at(-1)?.tools).toEqual(requests[0]?.tools);
    expect(r.text).toBe("Con lo que encontré: …");
  });

  it("marks tool errors and denials", async () => {
    const { client, requests } = fakeClient([
      { content: [use("a", "projects__search", {}), use("b", "projects__write", {})], stop: "tool_use" },
      { content: [{ type: "text", text: "No pude." }], stop: "end_turn" },
    ]);
    const { rt } = runtime({
      projects__search: { content: "Ruta no permitida.", isError: true },
      projects__write: { content: "Permiso denegado: herramienta no registrada.", isError: true },
    });
    const events: ToolEvent[] = [];
    const model = new AnthropicChatModel({ apiKey: "k", client });
    await model.complete({ system: "S", messages: [{ role: "user", content: "x" }], signal: new AbortController().signal, onText: () => {}, tools: rt, onTool: (e) => events.push(e) });
    expect(events.map((e) => e.status)).toEqual(["started", "error", "started", "denied"]);
    const results = (requests[1]?.messages as { content: Block[] }[])[2]?.content;
    expect(results?.every((b) => b.is_error === true)).toBe(true);
  });

  it("does not send tools when there is no runtime, and cancellation keeps the partial text", async () => {
    const { client, requests } = fakeClient([{ text: ["Hola, "], content: [], stop: "end_turn" }]);
    const ac = new AbortController();
    ac.abort();
    const model = new AnthropicChatModel({ apiKey: "k", client });
    const p = model.complete({ system: "S", messages: [{ role: "user", content: "x" }], signal: ac.signal, onText: () => {} });
    await expect(p).rejects.toBeInstanceOf(TurnCancelledError);
    await expect(p).rejects.toMatchObject({ partialText: "Hola, " });
    expect(requests[0]?.tools).toBeUndefined();
  });
});

describe("toUpstreamError", () => {
  it("an empty credit balance (400) is a billing error with a clear message", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { toUpstreamError } = await import("./model.js");
    const body = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } };
    const err = toUpstreamError(Anthropic.APIError.generate(400, body, undefined, new Headers()));
    expect(err).toMatchObject({ status: 400, kind: "billing" });
    expect(err.message).toMatch(/crédito/);
    const other = toUpstreamError(Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "messages: bad" } }, undefined, new Headers()));
    expect(other.kind).toBeUndefined();
  });
});
