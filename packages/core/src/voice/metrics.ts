/** Voice turn timings (migration 002). Only numbers: never the transcript or the reply. */
import type { DatabaseSync } from "node:sqlite";

export type VoiceOutcome = "done" | "interrupted" | "empty" | "error";

export interface VoiceTurnMetrics {
  id: string;
  conversationId?: string | undefined;
  chatTurnId?: string | undefined;
  outcome: VoiceOutcome;
  audioMs?: number | undefined;
  sttMs?: number | undefined;
  ttftMs?: number | undefined;
  firstAudioMs?: number | undefined;
  bargeInMs?: number | undefined;
  ttsEngine?: string | undefined;
}

export interface LatencySummary {
  turns: number;
  p50: number | undefined;
  p95: number | undefined;
}

export interface VoiceStats {
  firstAudio: LatencySummary;
  stt: LatencySummary;
  ttft: LatencySummary;
  bargeIn: LatencySummary;
  outcomes: Record<VoiceOutcome, number>;
}

export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const k = ((s.length - 1) * p) / 100;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  const a = s[lo] ?? 0;
  const b = s[hi] ?? a;
  return a + (b - a) * (k - lo);
}

const summary = (values: number[]): LatencySummary => ({ turns: values.length, p50: percentile(values, 50), p95: percentile(values, 95) });

export class VoiceMetricsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(m: VoiceTurnMetrics): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO voice_turns
         (id, conversation_id, chat_turn_id, outcome, audio_ms, stt_ms, ttft_ms, first_audio_ms, barge_in_ms, tts_engine, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.conversationId ?? null,
        m.chatTurnId ?? null,
        m.outcome,
        m.audioMs ?? null,
        m.sttMs ?? null,
        m.ttftMs ?? null,
        m.firstAudioMs ?? null,
        m.bargeInMs ?? null,
        m.ttsEngine ?? null,
        this.now().toISOString(),
      );
  }

  /** Stats over the last `limit` voice turns. */
  stats(limit = 200): VoiceStats {
    const rows = this.db
      .prepare(
        `SELECT outcome, stt_ms AS stt, ttft_ms AS ttft, first_audio_ms AS firstAudio, barge_in_ms AS bargeIn
         FROM voice_turns ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as { outcome: VoiceOutcome; stt: number | null; ttft: number | null; firstAudio: number | null; bargeIn: number | null }[];
    const pick = (k: "stt" | "ttft" | "firstAudio" | "bargeIn") => rows.map((r) => r[k]).filter((v): v is number => v !== null);
    const outcomes: Record<VoiceOutcome, number> = { done: 0, interrupted: 0, empty: 0, error: 0 };
    for (const r of rows) outcomes[r.outcome] += 1;
    return { firstAudio: summary(pick("firstAudio")), stt: summary(pick("stt")), ttft: summary(pick("ttft")), bargeIn: summary(pick("bargeIn")), outcomes };
  }
}
