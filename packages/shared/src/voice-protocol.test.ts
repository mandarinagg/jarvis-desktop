import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFromVoiceMessage, parseToVoiceMessage } from "./voice-protocol.js";

interface Fixtures {
  toVoice: { valid: unknown[]; invalid: unknown[] };
  fromVoice: { valid: unknown[]; invalid: unknown[] };
}
const fixtures = JSON.parse(readFileSync(new URL("../fixtures/voice-protocol.json", import.meta.url), "utf8")) as Fixtures;

describe("voice protocol (shared fixtures with the Python service)", () => {
  it.each(fixtures.toVoice.valid)("accepts core->voice %j", (m) => {
    expect(parseToVoiceMessage(JSON.stringify(m)).ok).toBe(true);
  });
  it.each(fixtures.toVoice.invalid)("rejects core->voice %j", (m) => {
    expect(parseToVoiceMessage(JSON.stringify(m))).toMatchObject({ ok: false, code: "invalid_message" });
  });
  it.each(fixtures.fromVoice.valid)("accepts voice->core %j", (m) => {
    expect(parseFromVoiceMessage(JSON.stringify(m)).ok).toBe(true);
  });
  it.each(fixtures.fromVoice.invalid)("rejects voice->core %j", (m) => {
    expect(parseFromVoiceMessage(JSON.stringify(m))).toMatchObject({ ok: false, code: "invalid_message" });
  });
  it("flags non-JSON lines", () => {
    expect(parseFromVoiceMessage("{nope")).toMatchObject({ ok: false, code: "invalid_json" });
  });
});
