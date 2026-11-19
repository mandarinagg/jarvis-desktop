import type { ChatCancel, ChatSend, CoreMessage, ToVoiceMessage } from "@jarvis/shared";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import type { Session } from "../server.js";
import { VoiceMetricsStore } from "./metrics.js";
import { PHRASES, VoiceTurns } from "./turns.js";

class FakeChat {
  sent: { session: Session; msg: ChatSend }[] = [];
  cancelled: ChatCancel[] = [];
  async chatSend(session: Session, msg: ChatSend) {
    this.sent.push({ session, msg });
  }
  chatCancel(_s: Session, msg: ChatCancel) {
    this.cancelled.push(msg);
  }
  /** Emit as the ChatService would, to the session it was given. */
  emit(m: CoreMessage, i = this.sent.length - 1) {
    this.sent[i]?.session.send(m);
  }
}

function setup() {
  let clock = 1_000;
  const toVoice: ToVoiceMessage[] = [];
  const broadcast: CoreMessage[] = [];
  const interrupted: string[] = [];
  const chat = new FakeChat();
  const metrics = new VoiceMetricsStore(openDatabase(":memory:"));
  const turns = new VoiceTurns({
    voice: { send: (m) => (toVoice.push(m), true) },
    chat,
    broadcast: (m) => broadcast.push(m),
    metrics,
    markInterrupted: (id) => interrupted.push(id),
    now: () => clock,
  });
  const client: Session = { id: "ui", client: "desktop", send: (m) => broadcast.push(m), close() {} };
  turns.supervisorState("ready");
  const of = <T extends ToVoiceMessage["type"]>(type: T) =>
    toVoice.filter((m): m is Extract<ToVoiceMessage, { type: T }> => m.type === type);
  const states = () => broadcast.filter((m) => m.type === "voice.state").map((m) => (m as { state: string }).state);
  const ptt = (pressed: boolean, conversationId?: string) =>
    turns.ptt(client, { type: "voice.ptt", id: "p", pressed, ...(conversationId ? { conversationId } : {}) });
  const utteranceId = () => of("stt.start").at(-1)?.id ?? "";
  return { turns, chat, metrics, toVoice, broadcast, interrupted, of, states, ptt, utteranceId, client, tick: (ms: number) => (clock += ms) };
}

/** Runs one full spoken turn up to the reply streaming. */
function talk(t: ReturnType<typeof setup>, text = "Jarvis, ¿qué tengo hoy?") {
  t.ptt(true);
  t.tick(2_000);
  t.ptt(false);
  t.tick(100);
  t.turns.onVoiceMessage({ type: "stt.final", id: t.utteranceId(), text, audioMs: 2_000, sttMs: 100 });
  t.chat.emit({ type: "chat.started", id: t.chat.sent.at(-1)?.msg.id ?? "", turnId: "chat-1", conversationId: "conv-1" });
  return t.of("tts.speak");
}

describe("VoiceTurns", () => {
  it("runs push-to-talk -> STT -> chat -> phrases -> TTS", () => {
    const t = setup();
    t.ptt(true);
    expect(t.of("stt.start")).toHaveLength(1);
    t.ptt(true); // key repeat is ignored
    expect(t.of("stt.start")).toHaveLength(1);
    t.ptt(false);
    expect(t.of("stt.stop")[0]?.id).toBe(t.utteranceId());

    t.turns.onVoiceMessage({ type: "stt.final", id: t.utteranceId(), text: "¿Qué tengo hoy?", audioMs: 1500, sttMs: 100 });
    expect(t.chat.sent[0]?.msg).toMatchObject({ type: "chat.send", text: "¿Qué tengo hoy?" });
    expect(t.broadcast).toContainEqual({ type: "voice.transcript", utteranceId: t.utteranceId(), text: "¿Qué tengo hoy?" });

    t.chat.emit({ type: "chat.started", id: t.chat.sent[0]?.msg.id ?? "", turnId: "c1", conversationId: "conv" });
    t.chat.emit({ type: "chat.delta", turnId: "c1", text: "Tenés dos reuniones. La primera" });
    t.chat.emit({ type: "chat.delta", turnId: "c1", text: " es a las diez." });
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    t.chat.emit({ type: "chat.done", turnId: "c1", stopReason: "end_turn", usage, costUsd: 0.01 });

    const speaks = t.of("tts.speak");
    expect(speaks.map((s) => [s.seq, s.text])).toEqual([
      [0, "Tenés dos reuniones."],
      [1, "La primera es a las diez."],
    ]);
    expect(new Set(speaks.map((s) => s.turnId)).size).toBe(1);
    expect(t.of("tts.end")[0]?.turnId).toBe(speaks[0]?.turnId);
    // the UI also gets the chat stream
    expect(t.broadcast.some((m) => m.type === "chat.delta")).toBe(true);
    expect(t.states()).toEqual(["idle", "listening", "transcribing", "thinking"]);
  });

  it("measures voice -> first audio and records the turn when playback ends", () => {
    const t = setup();
    const speaks = talk(t);
    t.tick(400);
    t.chat.emit({ type: "chat.delta", turnId: "chat-1", text: "Hola. " });
    t.tick(900);
    const turnId = t.of("tts.speak")[0]?.turnId ?? speaks[0]?.turnId ?? "";
    t.turns.onVoiceMessage({ type: "tts.started", turnId, seq: 0, engine: "google", latencyMs: 900 });
    expect(t.turns.state).toBe("speaking");
    t.tick(1_000);
    t.turns.onVoiceMessage({ type: "tts.finished", turnId, interrupted: false });
    expect(t.turns.state).toBe("idle");
    const stats = t.metrics.stats();
    expect(stats.firstAudio).toMatchObject({ turns: 1, p50: 1_400 }); // 100 stt + 400 ttft + 900 tts
    expect(stats.ttft.p50).toBe(400);
    expect(stats.outcomes.done).toBe(1);
  });

  it("barge-in while Claude is still streaming cancels the chat turn and the audio", () => {
    const t = setup();
    talk(t);
    t.chat.emit({ type: "chat.delta", turnId: "chat-1", text: "Una frase larga. " });
    const turnId = t.of("tts.speak")[0]?.turnId ?? "";
    t.turns.onVoiceMessage({ type: "tts.started", turnId, seq: 0, engine: "cache", latencyMs: 0 });

    t.ptt(true);
    expect(t.chat.cancelled).toEqual([expect.objectContaining({ turnId: "chat-1" })]);
    expect(t.of("tts.cancel")[0]?.turnId).toBe(turnId);
    expect(t.turns.state).toBe("listening");
    // late deltas of the interrupted turn are not spoken
    t.chat.emit({ type: "chat.delta", turnId: "chat-1", text: "Esto no se dice. " }, 0);
    expect(t.of("tts.speak")).toHaveLength(1);

    t.tick(80);
    t.turns.onVoiceMessage({ type: "tts.finished", turnId, interrupted: true });
    expect(t.turns.state).toBe("listening");
    expect(t.metrics.stats().bargeIn).toMatchObject({ turns: 1, p50: 80 });
    expect(t.metrics.stats().outcomes.interrupted).toBe(1);
  });

  it("barge-in after the text is complete marks the stored reply as interrupted", () => {
    const t = setup();
    talk(t);
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    t.chat.emit({ type: "chat.delta", turnId: "chat-1", text: "Todo listo." });
    t.chat.emit({ type: "chat.done", turnId: "chat-1", stopReason: "end_turn", usage, costUsd: 0 });
    t.ptt(true);
    expect(t.chat.cancelled).toEqual([]);
    expect(t.interrupted).toEqual(["chat-1"]);
  });

  it("asks again when nothing intelligible was said", () => {
    const t = setup();
    t.ptt(true);
    t.ptt(false);
    t.turns.onVoiceMessage({ type: "stt.final", id: t.utteranceId(), text: "  ", audioMs: 300, sttMs: 0 });
    expect(t.chat.sent).toHaveLength(0);
    expect(t.of("tts.speak").map((s) => s.text)).toEqual([PHRASES.notHeard]);
    expect(t.of("tts.end")).toHaveLength(1);
  });

  it("speaks a short error instead of the raw message", () => {
    const t = setup();
    t.ptt(true);
    t.ptt(false);
    t.turns.onVoiceMessage({ type: "stt.final", id: t.utteranceId(), text: "Hola", audioMs: 500, sttMs: 50 });
    t.chat.emit({ type: "error", id: t.chat.sent[0]?.msg.id ?? "", code: "budget_exceeded", message: "tope US$ 3" });
    expect(t.of("tts.speak").map((s) => s.text)).toEqual([PHRASES.budget]);
    const turnId = t.of("tts.speak")[0]?.turnId ?? "";
    t.turns.onVoiceMessage({ type: "tts.finished", turnId, interrupted: false });
    expect(t.metrics.stats().outcomes.error).toBe(1);
  });

  it("continues the recent voice conversation, or the one the UI asks for", () => {
    const t = setup();
    talk(t);
    const first = t.of("tts.speak");
    expect(first).toHaveLength(0);
    t.ptt(true);
    t.ptt(false);
    t.turns.onVoiceMessage({ type: "stt.final", id: t.utteranceId(), text: "¿Y mañana?", audioMs: 900, sttMs: 80 });
    expect(t.chat.sent.at(-1)?.msg.conversationId).toBe("conv-1");
    t.tick(11 * 60_000);
    t.ptt(true);
    t.ptt(false);
    t.turns.onVoiceMessage({ type: "stt.final", id: t.utteranceId(), text: "Otra cosa", audioMs: 900, sttMs: 80 });
    expect(t.chat.sent.at(-1)?.msg.conversationId).toBeUndefined();
    t.ptt(true, "conv-ui");
    t.ptt(false);
    t.turns.onVoiceMessage({ type: "stt.final", id: t.utteranceId(), text: "Acá", audioMs: 900, sttMs: 80 });
    expect(t.chat.sent.at(-1)?.msg.conversationId).toBe("conv-ui");
  });

  it("ignores stale transcriptions and reports STT errors", () => {
    const t = setup();
    t.ptt(true);
    t.ptt(false);
    t.turns.onVoiceMessage({ type: "stt.final", id: "old", text: "viejo", audioMs: 1, sttMs: 1 });
    expect(t.chat.sent).toHaveLength(0);
    t.turns.onVoiceMessage({ type: "voice.error", id: t.utteranceId(), code: "stt_failed", message: "no mic" });
    expect(t.turns.state).toBe("idle");
    expect(t.broadcast.at(-1)).toMatchObject({ type: "voice.state", state: "idle", detail: "no mic" });
  });

  it("tracks the microphone indicator", () => {
    const t = setup();
    t.ptt(true);
    t.turns.onVoiceMessage({ type: "stt.listening", id: t.utteranceId(), open: true });
    expect(t.broadcast.at(-1)).toMatchObject({ type: "voice.state", state: "listening", micOpen: true });
    t.turns.onVoiceMessage({ type: "stt.listening", id: t.utteranceId(), open: false });
    expect(t.broadcast.at(-1)).toMatchObject({ micOpen: false });
  });

  it("is unavailable while the voice service is down", () => {
    const t = setup();
    t.turns.supervisorState("degraded", "5 caídas");
    expect(t.broadcast.at(-1)).toMatchObject({ state: "unavailable", micOpen: false, detail: "5 caídas" });
    const replies: CoreMessage[] = [];
    t.turns.ptt({ id: "x", client: "desktop", send: (m) => replies.push(m), close() {} }, { type: "voice.ptt", id: "p9", pressed: true });
    expect(replies).toEqual([expect.objectContaining({ type: "voice.state", id: "p9", state: "unavailable" })]);
    expect(t.of("stt.start")).toHaveLength(0);
    t.turns.supervisorState("ready");
    expect(t.turns.state).toBe("idle");
  });

  it("answers voice.status.get", () => {
    const t = setup();
    const replies: CoreMessage[] = [];
    t.turns.statusGet({ id: "x", client: "desktop", send: (m) => replies.push(m), close() {} }, { type: "voice.status.get", id: "s1" });
    expect(replies).toEqual([{ type: "voice.state", id: "s1", state: "idle", micOpen: false }]);
  });
});

describe("VoiceMetricsStore", () => {
  it("computes percentiles over recorded turns", () => {
    const m = new VoiceMetricsStore(openDatabase(":memory:"));
    for (const [i, v] of [1000, 2000, 3000, 4000].entries()) m.record({ id: `t${i}`, outcome: "done", firstAudioMs: v });
    m.record({ id: "e", outcome: "empty" });
    const s = m.stats();
    expect(s.firstAudio).toEqual({ turns: 4, p50: 2500, p95: 3850 });
    expect(s.outcomes).toEqual({ done: 4, interrupted: 0, empty: 1, error: 0 });
    expect(m.stats().stt).toEqual({ turns: 0, p50: undefined, p95: undefined });
  });
});
