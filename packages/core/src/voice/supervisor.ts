/**
 * Voice Service supervisor (ADR-008): the Core spawns the voice service as a child process,
 * talks JSON Lines over its stdio, and restarts it with exponential backoff (1 s -> 30 s).
 * After 5 crashes within 10 minutes it gives up and stays `degraded`: Jarvis keeps working by text.
 */
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  FrameTooLargeError,
  type FromVoiceMessage,
  LineDecoder,
  type ToVoiceMessage,
  type TtsConfig,
  VOICE_PROTOCOL_VERSION,
  encodeLine,
  isCompatibleVersion,
  parseFromVoiceMessage,
} from "@jarvis/shared";
import { type Level, type Logger, silentLogger } from "../log.js";

export type VoiceState = "stopped" | "starting" | "ready" | "backoff" | "degraded";

/** The subset of ChildProcess the supervisor relies on (lets tests use a fake). */
export interface VoiceChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number | undefined;
  kill(): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): this;
}

export type VoiceSpawner = () => VoiceChild;

export interface VoiceSupervisorOptions {
  spawn: VoiceSpawner;
  /** Read on every (re)start, so a key stored while the Core runs is picked up on the next launch. */
  tts?: () => TtsConfig | undefined;
  /** Push-to-talk STT with Parakeet (ADR-010); off when false. */
  stt?: boolean;
  logger?: Logger;
  onState?: (state: VoiceState, detail?: string) => void;
  onMessage?: (message: FromVoiceMessage) => void;
  handshakeTimeoutMs?: number;
  shutdownGraceMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  crashLimit?: number;
  crashWindowMs?: number;
  now?: () => number;
}

const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

export class VoiceSupervisor {
  private child: VoiceChild | undefined;
  private state: VoiceState = "stopped";
  private stopping = false;
  private crashes: number[] = [];
  private consecutive = 0;
  private timer: NodeJS.Timeout | undefined;
  private exited: Promise<void> = Promise.resolve();
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly opts: VoiceSupervisorOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  get status(): VoiceState {
    return this.state;
  }

  start(): void {
    if (this.state !== "stopped") return;
    this.stopping = false;
    this.launch();
  }

  /** Sends a message if the service is ready. Returns false when it was not delivered. */
  send(message: ToVoiceMessage): boolean {
    if (this.state !== "ready" || !this.child) return false;
    return this.write(this.child, message);
  }

  /** Graceful stop: `voice.shutdown`, wait for the grace period, then kill. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    const child = this.child;
    if (child) {
      this.write(child, { type: "voice.shutdown", id: randomUUID() });
      child.stdin.end();
      const grace = new Promise<void>((resolve) => {
        this.timer = setTimeout(() => {
          child.kill();
          resolve();
        }, this.opts.shutdownGraceMs ?? 3_000);
      });
      await Promise.race([this.exited, grace]);
      clearTimeout(this.timer);
    }
    this.setState("stopped");
  }

  private setState(state: VoiceState, detail?: string): void {
    if (state === this.state) return;
    this.state = state;
    this.logger.log(state === "degraded" ? "warn" : "info", "voice.state", { state, detail });
    this.opts.onState?.(state, detail);
  }

  private write(child: VoiceChild, message: ToVoiceMessage): boolean {
    try {
      return child.stdin.write(encodeLine(message));
    } catch (err) {
      this.logger.log("error", "voice.write_failed", { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private launch(): void {
    this.setState("starting");
    let child: VoiceChild;
    try {
      child = this.opts.spawn();
    } catch (err) {
      this.giveUp(`no se pudo lanzar el servicio de voz: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;
    let resolveExit!: () => void;
    this.exited = new Promise((r) => (resolveExit = r));

    const configureId = randomUUID();
    const handshake = setTimeout(() => {
      this.logger.log("error", "voice.handshake_timeout", { pid: child.pid });
      child.kill();
    }, this.opts.handshakeTimeoutMs ?? 30_000);

    const out = new LineDecoder();
    child.stdout.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = out.push(chunk);
      } catch (err) {
        if (err instanceof FrameTooLargeError) {
          this.logger.log("error", "voice.frame_too_large", { error: err.message });
          child.kill();
          return;
        }
        throw err;
      }
      for (const line of lines) this.receive(child, line, configureId, handshake);
    });

    const errLines = new LineDecoder();
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        for (const line of errLines.push(chunk)) this.forwardLog(line);
      } catch {
        // an oversized stderr line is dropped; it is only diagnostics
      }
    });

    child.on("error", (err) => {
      clearTimeout(handshake);
      // ENOENT/EACCES: uv or python missing (or blocked by Smart App Control). Retrying won't help.
      if (err.code === "ENOENT" || err.code === "EACCES") {
        this.giveUp(`no se encontró el ejecutable del servicio de voz (${err.code})`);
      } else {
        this.logger.log("error", "voice.process_error", { error: err.message });
      }
      resolveExit();
    });

    child.on("exit", (code, signal) => {
      clearTimeout(handshake);
      resolveExit();
      if (this.child === child) this.child = undefined;
      if (this.stopping || this.state === "degraded") return;
      this.logger.log("warn", "voice.exited", { code, signal });
      this.crashed();
    });

    const tts = this.opts.tts?.();
    this.write(child, {
      type: "voice.configure",
      id: configureId,
      protocolVersion: VOICE_PROTOCOL_VERSION,
      ...(tts ? { tts } : {}),
      ...(this.opts.stt ? { stt: { engine: "parakeet" as const } } : {}),
    });
  }

  private receive(child: VoiceChild, line: string, configureId: string, handshake: NodeJS.Timeout): void {
    const parsed = parseFromVoiceMessage(line);
    if (!parsed.ok) {
      this.logger.log("warn", "voice.invalid_message", { code: parsed.code, detail: parsed.message });
      return;
    }
    const msg = parsed.message;
    if (msg.type === "voice.ready" && msg.id === configureId) {
      clearTimeout(handshake);
      if (!isCompatibleVersion(msg.protocolVersion, VOICE_PROTOCOL_VERSION)) {
        this.giveUp(`versión de protocolo de voz incompatible: ${msg.protocolVersion}`);
        child.kill();
        return;
      }
      this.consecutive = 0;
      this.logger.log("info", "voice.ready", { pid: child.pid, serviceVersion: msg.serviceVersion });
      this.setState("ready");
      return;
    }
    if (msg.type === "voice.error" && msg.code === "incompatible_version") {
      clearTimeout(handshake);
      this.giveUp(msg.message);
      return;
    }
    this.opts.onMessage?.(msg);
  }

  /** Voice logs arrive as JSON lines on stderr; they go through the Core logger (and its redaction). */
  private forwardLog(line: string): void {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const { level, msg, ts: _ts, ...fields } = entry;
      const lvl = LEVELS.find((l) => l === level) ?? "info";
      this.logger.log(lvl, typeof msg === "string" ? msg : "voice.log", { source: "voice", ...fields });
    } catch {
      this.logger.log("info", "voice.stderr", { source: "voice", line: line.slice(0, 2_000) });
    }
  }

  private crashed(): void {
    const now = this.now();
    const window = this.opts.crashWindowMs ?? 10 * 60_000;
    this.crashes = [...this.crashes.filter((t) => now - t < window), now];
    if (this.crashes.length >= (this.opts.crashLimit ?? 5)) {
      this.giveUp(`${this.crashes.length} caídas en ${Math.round(window / 60_000)} minutos`);
      return;
    }
    const initial = this.opts.initialBackoffMs ?? 1_000;
    const delay = Math.min(initial * 2 ** this.consecutive, this.opts.maxBackoffMs ?? 30_000);
    this.consecutive += 1;
    this.setState("backoff", `reintento en ${delay} ms`);
    this.timer = setTimeout(() => {
      if (!this.stopping) this.launch();
    }, delay);
  }

  private giveUp(reason: string): void {
    clearTimeout(this.timer);
    this.setState("degraded", reason);
  }
}
