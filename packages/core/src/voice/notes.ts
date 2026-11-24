/**
 * WhatsApp voice notes over the voice service (ADR-030). The Core never decodes or encodes audio:
 * it hands the note's bytes to the service (`stt.transcribe`) and gets text back, or hands text
 * (`tts.render`) and gets a ready Ogg Opus note. The bytes live only in memory, in these promises.
 */
import { randomUUID } from "node:crypto";
import { type FromVoiceMessage, MAX_NOTE_BYTES, MAX_RENDER_CHARS, type ToVoiceMessage } from "@jarvis/shared";

export type VoiceNoteFailure = "unavailable" | "too_large" | "failed" | "timeout";

export class VoiceNoteError extends Error {
  constructor(
    readonly reason: VoiceNoteFailure,
    detail: string,
  ) {
    super(detail);
    this.name = "VoiceNoteError";
  }
}

export interface RenderedNote {
  audio: Buffer;
  durationMs: number;
  engine: "google" | "piper";
}

/** What the WhatsApp channel needs; the fake in tests implements just this. */
export interface VoiceNotesPort {
  /** Is the voice service up (ready), so a note can be heard or spoken now? */
  available(): boolean;
  transcribe(audio: Buffer): Promise<string>;
  render(text: string): Promise<RenderedNote>;
}

export interface VoiceNotesOptions {
  /** `VoiceSupervisor.send`: false when the service is not ready. */
  send: (m: ToVoiceMessage) => boolean;
  available: () => boolean;
  transcribeTimeoutMs?: number;
  renderTimeoutMs?: number;
}

type Pending =
  | { kind: "stt"; resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  | { kind: "tts"; resolve: (n: RenderedNote) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class VoiceNotes implements VoiceNotesPort {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: VoiceNotesOptions) {}

  available(): boolean {
    return this.opts.available();
  }

  transcribe(audio: Buffer): Promise<string> {
    if (audio.length > MAX_NOTE_BYTES) return Promise.reject(new VoiceNoteError("too_large", `${audio.length} bytes`));
    if (audio.length === 0) return Promise.reject(new VoiceNoteError("failed", "empty note"));
    const id = `note-${randomUUID()}`;
    return new Promise<string>((resolve, reject) => {
      const timer = this.timer(id, this.opts.transcribeTimeoutMs ?? 60_000);
      this.pending.set(id, { kind: "stt", resolve, reject, timer });
      this.dispatch(id, { type: "stt.transcribe", id, audio: audio.toString("base64") });
    });
  }

  render(text: string): Promise<RenderedNote> {
    const clean = text.trim();
    if (!clean || clean.length > MAX_RENDER_CHARS) return Promise.reject(new VoiceNoteError("too_large", `${clean.length} chars`));
    const id = `render-${randomUUID()}`;
    return new Promise<RenderedNote>((resolve, reject) => {
      const timer = this.timer(id, this.opts.renderTimeoutMs ?? 45_000);
      this.pending.set(id, { kind: "tts", resolve, reject, timer });
      this.dispatch(id, { type: "tts.render", id, text: clean });
    });
  }

  /**
   * Called with every message from the voice service before the voice turns see it. Returns true
   * when the message answered one of our requests (and must not reach the turns).
   */
  handle(msg: FromVoiceMessage): boolean {
    const id = "id" in msg ? msg.id : undefined;
    const p = id ? this.pending.get(id) : undefined;
    if (!id || !p) return false;
    if (msg.type === "voice.error") {
      this.settle(id)?.reject(new VoiceNoteError("failed", msg.message));
    } else if (msg.type === "stt.final" && p.kind === "stt") {
      this.settle(id);
      p.resolve(msg.text.trim());
    } else if (msg.type === "tts.rendered" && p.kind === "tts") {
      this.settle(id);
      p.resolve({ audio: Buffer.from(msg.audio, "base64"), durationMs: msg.durationMs, engine: msg.engine });
    } else {
      return false;
    }
    return true;
  }

  /** The voice service went down: nothing in flight will be answered. */
  failAll(detail: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new VoiceNoteError("unavailable", detail));
  }

  private dispatch(id: string, m: ToVoiceMessage): void {
    if (!this.opts.available() || !this.opts.send(m)) this.settle(id)?.reject(new VoiceNoteError("unavailable", "voice service not ready"));
  }

  private timer(id: string, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => this.settle(id)?.reject(new VoiceNoteError("timeout", `no answer in ${ms} ms`)), ms);
    t.unref?.();
    return t;
  }

  private settle(id: string): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(id);
    return p;
  }
}
