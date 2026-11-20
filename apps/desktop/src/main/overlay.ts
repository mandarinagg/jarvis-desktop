import type { VoiceStateMessage } from "@jarvis/shared";

const ACTIVE = new Set(["listening", "transcribing", "thinking", "speaking"]);

/**
 * The overlay shows during a voice turn, and always while the microphone is open (mandatory).
 * Waiting for the wake word does not show it (it would never go away): that state has its own
 * indicator, a badge on the taskbar button plus the chip in the window (wakeBadge, ADR-021).
 */
export function overlayVisible(m: Pick<VoiceStateMessage, "state" | "micOpen">): boolean {
  return m.micOpen || ACTIVE.has(m.state);
}

/** 16x16 BGRA dot for the taskbar overlay icon while the mic waits for the wake word. */
export function wakeBadgeBitmap(size = 16): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      if (d <= c) {
        const ring = d > c - 2;
        buf[i] = ring ? 255 : 80; // B
        buf[i + 1] = ring ? 255 : 200; // G
        buf[i + 2] = ring ? 255 : 120; // R
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}
