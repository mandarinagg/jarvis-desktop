import { describe, expect, it } from "vitest";
import { parseRendererMessage } from "./bridge.js";

describe("parseRendererMessage", () => {
  it("lets chat and read-only queries through", () => {
    expect(parseRendererMessage({ type: "chat.send", id: "1", text: "hola" })).toBeDefined();
    expect(parseRendererMessage({ type: "chat.cancel", id: "1", turnId: "t" })).toBeDefined();
    expect(parseRendererMessage({ type: "conversations.list", id: "1" })).toBeDefined();
    expect(parseRendererMessage({ type: "budget.get", id: "1" })).toBeDefined();
  });

  it("blocks auth and shutdown even when well formed", () => {
    expect(parseRendererMessage({ type: "core.shutdown", id: "1" })).toBeUndefined();
    expect(
      parseRendererMessage({ type: "auth.hello", id: "1", token: "a".repeat(64), protocolVersion: "1.0", client: "desktop" }),
    ).toBeUndefined();
  });

  it("blocks malformed payloads", () => {
    expect(parseRendererMessage({ type: "chat.send", id: "1", text: "" })).toBeUndefined();
    expect(parseRendererMessage("chat.send")).toBeUndefined();
    expect(parseRendererMessage({ type: "chat.send", id: "1", text: "x", extra: 1 })).toBeUndefined();
  });
});

describe("voice from the renderer", () => {
  it("allows push-to-talk and status queries", () => {
    expect(parseRendererMessage({ type: "voice.ptt", id: "1", pressed: true, conversationId: "c" })).toBeDefined();
    expect(parseRendererMessage({ type: "voice.status.get", id: "1" })).toBeDefined();
    expect(parseRendererMessage({ type: "voice.ptt", id: "1", pressed: "yes" })).toBeUndefined();
  });
});

describe("overlayVisible", () => {
  it("is shown during a voice turn and always while the mic is open", async () => {
    const { overlayVisible } = await import("./overlay.js");
    expect(overlayVisible({ state: "idle", micOpen: false })).toBe(false);
    expect(overlayVisible({ state: "unavailable", micOpen: false })).toBe(false);
    expect(overlayVisible({ state: "speaking", micOpen: false })).toBe(true);
    expect(overlayVisible({ state: "idle", micOpen: true })).toBe(true);
  });
});
