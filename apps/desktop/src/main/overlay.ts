import type { VoiceStateMessage } from "@jarvis/shared";

const ACTIVE = new Set(["listening", "transcribing", "thinking", "speaking"]);

/** The overlay shows during a voice turn, and always while the microphone is open (mandatory). */
export function overlayVisible(m: Pick<VoiceStateMessage, "state" | "micOpen">): boolean {
  return m.micOpen || ACTIVE.has(m.state);
}
