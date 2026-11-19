-- Phase 2: per-turn voice latency metrics (exit criterion: p50 voice -> first audio < 2.0 s).
-- No transcript or audio is stored here, only timings.

CREATE TABLE voice_turns (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT,
  chat_turn_id     TEXT,
  outcome          TEXT NOT NULL CHECK (outcome IN ('done', 'interrupted', 'empty', 'error')),
  audio_ms         REAL,  -- length of what the owner said
  stt_ms           REAL,  -- transcription time
  ttft_ms          REAL,  -- chat.send -> first Claude token
  first_audio_ms   REAL,  -- push-to-talk released -> first audio of the reply (the exit metric)
  barge_in_ms      REAL,  -- push-to-talk pressed while speaking -> audio cut
  tts_engine       TEXT,  -- engine of the first phrase: google | piper | cache
  created_at       TEXT NOT NULL
);
CREATE INDEX voice_turns_by_date ON voice_turns (created_at);
