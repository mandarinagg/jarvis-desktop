import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Level } from "../log.js";
import { type VoiceChild, type VoiceState, VoiceSupervisor, type VoiceSupervisorOptions } from "./supervisor.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly received: Record<string, unknown>[] = [];
  killed = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString("utf8").split("\n")) if (l) this.received.push(JSON.parse(l) as Record<string, unknown>);
    });
  }
  reply(msg: unknown) {
    this.stdout.write(JSON.stringify(msg) + "\n");
  }
  ready(version = "1.0") {
    const configure = this.received.find((m) => m.type === "voice.configure");
    this.reply({ type: "voice.ready", id: configure?.id, protocolVersion: version, serviceVersion: "0.1.0" });
  }
  exit(code = 1) {
    this.emit("exit", code, null);
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.exit(null as unknown as number));
    return true;
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(extra: Partial<VoiceSupervisorOptions> = {}) {
  const children: FakeChild[] = [];
  const states: VoiceState[] = [];
  const logs: { level: Level; msg: string; fields?: Record<string, unknown> }[] = [];
  let clock = 0;
  const sup = new VoiceSupervisor({
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c as unknown as VoiceChild;
    },
    onState: (s) => states.push(s),
    logger: { log: (level, msg, fields) => logs.push({ level, msg, fields }) },
    now: () => clock,
    ...extra,
  });
  const child = (i: number): FakeChild => {
    const c = children.at(i);
    if (!c) throw new Error(`no child #${i}`);
    return c;
  };
  return { sup, children, child, states, logs, advance: (ms: number) => (clock += ms) };
}

describe("VoiceSupervisor", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("configures the child and becomes ready on a matching voice.ready", async () => {
    const { sup, child, states } = setup();
    sup.start();
    await flush();
    expect(child(0).received[0]).toMatchObject({ type: "voice.configure", protocolVersion: "1.1" });
    child(0).ready();
    await flush();
    expect(sup.status).toBe("ready");
    expect(states).toEqual(["starting", "ready"]);
  });

  it("includes the TTS config, read on every launch", async () => {
    let key = "k1";
    const { sup, child } = setup({ tts: () => ({ engine: "google", voice: "es-US-Neural2-B", googleApiKey: key }) });
    sup.start();
    expect(child(0).received[0]).toMatchObject({ tts: { engine: "google", googleApiKey: "k1" } });
    key = "k2";
    child(0).exit(1);
    vi.advanceTimersByTime(1_000);
    expect(child(1).received[0]).toMatchObject({ tts: { googleApiKey: "k2" } });
  });

  it("asks for Parakeet STT when enabled", () => {
    const { sup, child } = setup({ stt: true });
    sup.start();
    expect(child(0).received[0]).toMatchObject({ stt: { engine: "parakeet" } });
  });

  it("only sends messages once ready", async () => {
    const { sup, child } = setup();
    sup.start();
    expect(sup.send({ type: "voice.ping", id: "p1" })).toBe(false);
    child(0).ready();
    await flush();
    expect(sup.send({ type: "voice.ping", id: "p2" })).toBe(true);
    await flush();
    expect(child(0).received.map((m) => m.id)).toContain("p2");
  });

  it("forwards other messages and ignores invalid ones", async () => {
    const onMessage = vi.fn();
    const { sup, child, logs } = setup({ onMessage });
    sup.start();
    child(0).ready();
    child(0).reply({ type: "voice.pong", id: "p1" });
    child(0).stdout.write("{garbage\n");
    await flush();
    expect(onMessage).toHaveBeenCalledWith({ type: "voice.pong", id: "p1" });
    expect(logs.some((l) => l.msg === "voice.invalid_message")).toBe(true);
  });

  it("restarts with exponential backoff after a crash", async () => {
    const { sup, children, child, states } = setup();
    sup.start();
    child(0).ready();
    await flush();
    child(0).exit(1);
    expect(sup.status).toBe("backoff");
    vi.advanceTimersByTime(999);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);
    child(1).exit(1); // crashed again before ready: 2 s
    vi.advanceTimersByTime(1_999);
    expect(children).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(3);
    expect(states.filter((s) => s === "backoff")).toHaveLength(2);
  });

  it("caps the backoff at maxBackoffMs", async () => {
    const { sup, children, child } = setup({ crashLimit: 100, maxBackoffMs: 4_000 });
    sup.start();
    for (let i = 0; i < 5; i++) {
      child(-1).exit(1);
      vi.advanceTimersByTime(4_000);
    }
    expect(children).toHaveLength(6);
  });

  it("goes degraded after 5 crashes within 10 minutes", async () => {
    const { sup, children, child, advance } = setup();
    sup.start();
    for (let i = 0; i < 5; i++) {
      child(-1).exit(1);
      advance(1_000);
      vi.advanceTimersByTime(30_000);
    }
    expect(sup.status).toBe("degraded");
    expect(children).toHaveLength(5);
  });

  it("forgets crashes older than the window", async () => {
    const { sup, child, advance } = setup();
    sup.start();
    for (let i = 0; i < 8; i++) {
      child(-1).exit(1);
      advance(4 * 60_000);
      vi.advanceTimersByTime(30_000);
    }
    expect(sup.status).not.toBe("degraded");
  });

  it("kills a child that never answers the handshake", async () => {
    const { sup, child } = setup({ handshakeTimeoutMs: 500 });
    sup.start();
    vi.advanceTimersByTime(500);
    expect(child(0).killed).toBe(true);
    await flush();
    expect(sup.status).toBe("backoff");
  });

  it("goes degraded on an incompatible protocol version", async () => {
    const { sup, child } = setup();
    sup.start();
    child(0).ready("2.0");
    await flush();
    expect(sup.status).toBe("degraded");
    expect(child(0).killed).toBe(true);
  });

  it("goes degraded immediately when the executable is missing", () => {
    const { sup, children, child } = setup();
    sup.start();
    const err = Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" });
    child(0).emit("error", err);
    expect(sup.status).toBe("degraded");
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });

  it("goes degraded when spawn throws", () => {
    const sup = new VoiceSupervisor({
      spawn: () => {
        throw new Error("boom");
      },
    });
    sup.start();
    expect(sup.status).toBe("degraded");
  });

  it("stops gracefully with voice.shutdown and does not restart", async () => {
    const { sup, children, child } = setup();
    sup.start();
    child(0).ready();
    await flush();
    const stopped = sup.stop();
    await flush();
    expect(child(0).received.at(-1)).toMatchObject({ type: "voice.shutdown" });
    child(0).exit(0);
    await stopped;
    expect(sup.status).toBe("stopped");
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });

  it("kills the child if it ignores shutdown", async () => {
    const { sup, child } = setup({ shutdownGraceMs: 3_000 });
    sup.start();
    child(0).ready();
    await flush();
    const stopped = sup.stop();
    vi.advanceTimersByTime(3_000);
    await stopped;
    expect(child(0).killed).toBe(true);
    expect(sup.status).toBe("stopped");
  });

  it("forwards voice stderr logs through the Core logger", async () => {
    const { sup, child, logs } = setup();
    sup.start();
    child(0).stderr.write(JSON.stringify({ ts: "x", level: "warn", msg: "voice.something", n: 1 }) + "\nplain text\n");
    await flush();
    expect(logs).toContainEqual({ level: "warn", msg: "voice.something", fields: { source: "voice", n: 1 } });
    expect(logs).toContainEqual({ level: "info", msg: "voice.stderr", fields: { source: "voice", line: "plain text" } });
  });
});
