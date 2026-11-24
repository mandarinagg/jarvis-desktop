import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { ToolRuntime } from "../tools/hub.js";
import type { Risk } from "../tools/permissions.js";
import { FallbackChatModel, fallbackWorthy, isLoopbackUrl, readOnlyTools } from "./fallback.js";
import { UpstreamError } from "./model.js";

type Block = Record<string, unknown> & { type: string };

/** Stand-in for client.messages.stream (the plain API, no betas): replays rounds, records requests. */
function fakeClient(rounds: { text?: string[]; content: Block[]; stop: string }[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    messages: {
      stream(params: Record<string, unknown>) {
        requests.push(structuredClone(params));
        const round = rounds.shift();
        if (!round) throw new Error("no more scripted rounds");
        const listeners: ((d: string) => void)[] = [];
        return {
          on(_e: "text", fn: (d: string) => void) {
            listeners.push(fn);
            return this;
          },
          async finalMessage() {
            for (const d of round.text ?? []) for (const l of listeners) l(d);
            return { model: "gemini-2.5-flash", stop_reason: round.stop, content: round.content, usage: { input_tokens: 10, output_tokens: 5 } };
          },
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const RISKS: Record<string, Risk> = { projects__read_file: "read", projects__write_file: "confirm", builder__start_task: "confirm", memory__forget: "destructive" };
const riskOf = (name: string) => RISKS[name];

function runtime() {
  const calls: string[] = [];
  const rt: ToolRuntime = {
    definitions: () => Object.keys(RISKS).map((name) => ({ name, description: name, input_schema: { type: "object" as const } })),
    describe: (name) => `hago ${name}`,
    call(name) {
      calls.push(name);
      return Promise.resolve({ content: "ok", isError: false });
    },
  };
  return { rt, calls };
}

const req = (over: Record<string, unknown> = {}) => ({
  system: "SYS",
  systemSuffix: "SUF",
  messages: [{ role: "user" as const, content: "hola" }],
  signal: new AbortController().signal,
  onText: () => {},
  ...over,
});

describe("OmniRoute backup (ADR-031)", () => {
  it("only accepts loopback URLs", () => {
    expect(isLoopbackUrl("http://127.0.0.1:20128")).toBe(true);
    expect(isLoopbackUrl("http://localhost:20128")).toBe(true);
    expect(isLoopbackUrl("http://192.168.0.10:20128")).toBe(false);
    expect(isLoopbackUrl("https://omniroute.example.com")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackUrl("garbage")).toBe(false);
    expect(() => new FallbackChatModel({ apiKey: "k", baseURL: "http://10.0.0.2:20128", riskOf })).toThrow(/localhost/);
  });

  it("read tools only: the rest is hidden and refused even if the model asks for it", async () => {
    const { rt, calls } = runtime();
    const ro = readOnlyTools(rt, riskOf);
    expect(ro.definitions().map((t) => t.name)).toEqual(["projects__read_file"]);
    const denied = await ro.call("projects__write_file", {}, { turnId: "t" });
    expect(denied).toMatchObject({ isError: true });
    expect(denied.content).toMatch(/^Permiso denegado/);
    await ro.call("projects__read_file", {}, { turnId: "t" });
    expect(calls).toEqual(["projects__read_file"]);
  });

  it("sends a plain Messages request (no betas, effort or cache_control) with system + suffix", async () => {
    const { client, requests } = fakeClient([{ text: ["Ho", "la"], content: [{ type: "text", text: "Hola" }], stop: "end_turn" }]);
    const m = new FallbackChatModel({ apiKey: "k", client, riskOf });
    const deltas: string[] = [];
    const r = await m.complete(req({ onText: (d: string) => deltas.push(d) }));
    expect(r).toMatchObject({ text: "Hola", model: "omniroute:gemini-2.5-flash", stopReason: "end_turn" });
    expect(deltas).toEqual(["Ho", "la"]);
    const sent = requests[0] ?? {};
    expect(sent).toMatchObject({ model: "jarvis-fallback", system: "SYS\n\nSUF" });
    for (const k of ["betas", "output_config", "cache_control", "fallbacks"]) expect(sent).not.toHaveProperty(k);
  });

  it("a write the backup model asks for is refused without reaching the tool", async () => {
    const { rt, calls } = runtime();
    const { client, requests } = fakeClient([
      { content: [{ type: "tool_use", id: "u1", name: "projects__write_file", input: {} }], stop: "tool_use" },
      { text: ["No puedo."], content: [{ type: "text", text: "No puedo." }], stop: "end_turn" },
    ]);
    const m = new FallbackChatModel({ apiKey: "k", client, riskOf });
    const events: string[] = [];
    await m.complete(req({ tools: rt, onTool: (e: { status: string }) => events.push(e.status) }));
    expect(calls).toEqual([]);
    expect(events).toEqual(["started", "denied"]);
    expect((requests[0]?.tools as { name: string }[]).map((t) => t.name)).toEqual(["projects__read_file"]);
  });

  it("which Claude failures the backup covers", () => {
    expect(fallbackWorthy(new UpstreamError("rate", 429, true))).toBe(true);
    expect(fallbackWorthy(new UpstreamError("down", undefined, true))).toBe(true);
    expect(fallbackWorthy(new UpstreamError("overloaded", 529))).toBe(true);
    expect(fallbackWorthy(new UpstreamError("bad key", 401))).toBe(false);
    expect(fallbackWorthy(new UpstreamError("bad request", 400))).toBe(false);
    expect(fallbackWorthy(new Error("x"))).toBe(false);
  });
});
