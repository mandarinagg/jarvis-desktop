import type { ToVoiceMessage } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { VoiceNoteError, VoiceNotes } from "./notes.js";

function make(over: { up?: boolean; accept?: boolean; transcribeTimeoutMs?: number } = {}) {
  const sent: ToVoiceMessage[] = [];
  const state = { up: over.up ?? true };
  const notes = new VoiceNotes({
    send: (m) => {
      sent.push(m);
      return over.accept ?? true;
    },
    available: () => state.up,
    ...(over.transcribeTimeoutMs ? { transcribeTimeoutMs: over.transcribeTimeoutMs } : {}),
  });
  return { notes, sent, state };
}

const idOf = (m: ToVoiceMessage | undefined) => (m as { id: string }).id;

describe("voice notes over the voice service (ADR-030)", () => {
  it("transcribe sends the note as base64 and resolves with stt.final of the same id", async () => {
    const { notes, sent } = make();
    const p = notes.transcribe(Buffer.from("OggS-audio"));
    expect(sent[0]).toMatchObject({ type: "stt.transcribe", audio: Buffer.from("OggS-audio").toString("base64") });
    const id = idOf(sent[0]);
    expect(notes.handle({ type: "stt.final", id: "someone-else", text: "x", audioMs: 1, sttMs: 1 })).toBe(false);
    expect(notes.handle({ type: "stt.final", id, text: "  hola Jarvis ", audioMs: 1200, sttMs: 90 })).toBe(true);
    await expect(p).resolves.toBe("hola Jarvis");
    expect(notes.handle({ type: "stt.final", id, text: "again", audioMs: 1, sttMs: 1 })).toBe(false); // settled once
  });

  it("render resolves with the decoded note", async () => {
    const { notes, sent } = make();
    const p = notes.render(" Listo. ");
    expect(sent[0]).toMatchObject({ type: "tts.render", text: "Listo." });
    notes.handle({ type: "tts.rendered", id: idOf(sent[0]), audio: Buffer.from("OggS").toString("base64"), durationMs: 800, engine: "google" });
    const r = await p;
    expect(r.audio.toString()).toBe("OggS");
    expect(r).toMatchObject({ durationMs: 800, engine: "google" });
  });

  it("voice.error with the id rejects; other ids pass through to the voice turns", async () => {
    const { notes, sent } = make();
    const p = notes.render("Hola");
    expect(notes.handle({ type: "voice.error", id: "u1", code: "stt_failed", message: "mic" })).toBe(false);
    expect(notes.handle({ type: "voice.error", id: idOf(sent[0]), code: "tts_failed", message: "no se pudo" })).toBe(true);
    await expect(p).rejects.toMatchObject({ reason: "failed" });
  });

  it("refuses when the service is down, too big, or never answers", async () => {
    await expect(make({ up: false }).notes.transcribe(Buffer.from("x"))).rejects.toMatchObject({ reason: "unavailable" });
    await expect(make({ accept: false }).notes.render("hola")).rejects.toMatchObject({ reason: "unavailable" });
    await expect(make().notes.transcribe(Buffer.alloc(601 * 1024))).rejects.toMatchObject({ reason: "too_large" });
    await expect(make().notes.render("a".repeat(4_001))).rejects.toBeInstanceOf(VoiceNoteError);
    await expect(make({ transcribeTimeoutMs: 5 }).notes.transcribe(Buffer.from("x"))).rejects.toMatchObject({ reason: "timeout" });
  });

  it("failAll rejects everything in flight when the service goes down", async () => {
    const { notes } = make();
    const a = notes.transcribe(Buffer.from("x"));
    const b = notes.render("hola");
    notes.failAll("voice service backoff");
    await expect(a).rejects.toMatchObject({ reason: "unavailable" });
    await expect(b).rejects.toMatchObject({ reason: "unavailable" });
  });
});
