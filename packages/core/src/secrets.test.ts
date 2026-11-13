import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KeyringSecretStore, MemorySecretStore } from "./secrets.js";

describe("KeyringSecretStore (real Windows Credential Manager)", () => {
  it.runIf(process.platform === "win32")("round-trips and deletes under an isolated service name", () => {
    const store = new KeyringSecretStore(`Jarvis-test-${randomUUID()}`);
    expect(store.get("anthropic-api-key")).toBeUndefined();
    store.set("anthropic-api-key", "  sk-ant-test-value  ");
    expect(store.get("anthropic-api-key")).toBe("sk-ant-test-value");
    expect(store.delete("anthropic-api-key")).toBe(true);
    expect(store.get("anthropic-api-key")).toBeUndefined();
  });

  it("refuses empty secrets", () => {
    expect(() => new KeyringSecretStore(`Jarvis-test-${randomUUID()}`).set("anthropic-api-key", "   ")).toThrow();
  });
});

describe("MemorySecretStore", () => {
  it("behaves like a store", () => {
    const s = new MemorySecretStore();
    s.set("google-tts-api-key", "AIza-x");
    expect(s.get("google-tts-api-key")).toBe("AIza-x");
    expect(s.delete("google-tts-api-key")).toBe(true);
  });
});
