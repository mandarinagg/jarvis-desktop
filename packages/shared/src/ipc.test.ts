import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  CoreMessage,
  LineDecoder,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  encodeLine,
  isCompatibleVersion,
  parseClientMessage,
} from "./index.js";

const token = "a".repeat(64);

describe("encodeLine / LineDecoder", () => {
  it("round-trips messages split across arbitrary chunks", () => {
    const wire = encodeLine({ type: "core.ping", id: "1" }) + encodeLine({ type: "core.ping", id: "2" });
    const decoder = new LineDecoder();
    const lines = [...decoder.push(wire.slice(0, 7)), ...decoder.push(wire.slice(7, 30)), ...decoder.push(wire.slice(30))];
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(["1", "2"]);
  });

  it("keeps multi-byte characters intact across chunk boundaries", () => {
    const bytes = Buffer.from(encodeLine({ type: "chat.send", id: "1", text: "¿Qué tal? ñandú 🚀" }));
    const decoder = new LineDecoder();
    const lines = [...decoder.push(bytes.subarray(0, 40)), ...decoder.push(bytes.subarray(40))];
    expect(JSON.parse(lines[0] ?? "").text).toBe("¿Qué tal? ñandú 🚀");
  });

  it("ignores blank lines and tolerates CRLF", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('\r\n{"a":1}\r\n\n')).toEqual(['{"a":1}']);
  });

  it("rejects a line larger than the limit, even before its newline arrives", () => {
    const decoder = new LineDecoder();
    expect(() => decoder.push("x".repeat(MAX_LINE_BYTES + 1))).toThrow(/too large/);
  });

  it("encodeLine refuses oversized messages instead of sending them", () => {
    expect(() => encodeLine({ type: "chat.send", id: "1", text: "x".repeat(MAX_LINE_BYTES) })).toThrow(/too large/);
  });
});

describe("parseClientMessage", () => {
  it("accepts a valid hello", () => {
    const r = parseClientMessage(
      JSON.stringify({ type: "auth.hello", id: "h", token, protocolVersion: PROTOCOL_VERSION, client: "desktop" }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects malformed JSON without throwing", () => {
    const r = parseClientMessage("{nope");
    expect(r).toMatchObject({ ok: false, code: "invalid_json" });
  });

  it("rejects unknown message types and extra fields", () => {
    expect(parseClientMessage(JSON.stringify({ type: "fs.delete", id: "1" }))).toMatchObject({
      ok: false,
      code: "invalid_message",
    });
    expect(parseClientMessage(JSON.stringify({ type: "core.ping", id: "1", evil: true }))).toMatchObject({
      ok: false,
      code: "invalid_message",
    });
  });

  it("rejects tokens that are not 256-bit hex", () => {
    const r = parseClientMessage(
      JSON.stringify({ type: "auth.hello", id: "h", token: "short", protocolVersion: PROTOCOL_VERSION, client: "cli" }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects empty chat text", () => {
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", id: "1", text: "" })).ok).toBe(false);
  });

  it("never echoes the token in validation errors", () => {
    const bad = { type: "auth.hello", id: "h", token: "z".repeat(64), protocolVersion: PROTOCOL_VERSION, client: "x" };
    const r = parseClientMessage(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain("z".repeat(64));
  });
});

describe("schemas", () => {
  it("core messages validate their payloads", () => {
    expect(CoreMessage.safeParse({ type: "chat.delta", turnId: "t1", text: "Ho" }).success).toBe(true);
    expect(
      CoreMessage.safeParse({
        type: "chat.done",
        turnId: "t1",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.001,
      }).success,
    ).toBe(true);
    expect(CoreMessage.safeParse({ type: "error", code: "bogus", message: "x" }).success).toBe(false);
  });

  it("client messages are a closed set", () => {
    const types = ClientMessage.options.map((o) => o.shape.type.value).sort();
    expect(types).toEqual(["auth.hello", "chat.cancel", "chat.send", "core.ping", "core.shutdown"]);
  });
});

describe("isCompatibleVersion", () => {
  it("compares major versions only", () => {
    expect(isCompatibleVersion("1.0", "1.3")).toBe(true);
    expect(isCompatibleVersion("2.0", "1.0")).toBe(false);
    expect(isCompatibleVersion("garbage", "1.0")).toBe(false);
  });
});
