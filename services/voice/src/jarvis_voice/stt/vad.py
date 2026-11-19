"""Voice activity detection for barge-in (VOICE_PIPELINE §4, ADR-016).

`SileroVad` runs Silero VAD v5 (MIT) on onnxruntime, on the CPU: ~0.1 ms per 32 ms frame.
`SpeechGate` turns per-frame speech probabilities into "speech started" / "speech ended" events
with hysteresis, so coughs and clicks shorter than `start_ms` never interrupt Jarvis.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import numpy as np

SAMPLE_RATE = 16_000
FRAME = 512  # samples per Silero v5 frame at 16 kHz (32 ms)
FRAME_MS = FRAME * 1000 / SAMPLE_RATE
_CONTEXT = 64  # v5 expects the last 64 samples of the previous frame in front of each frame


class SileroVad:
    def __init__(self, model: Path) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self._session = ort.InferenceSession(str(model), sess_options=opts, providers=["CPUExecutionProvider"])
        self._sr = np.array(SAMPLE_RATE, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros(_CONTEXT, dtype=np.float32)

    def prob(self, frame: np.ndarray) -> float:
        """Speech probability of one FRAME-sample float32 frame."""
        if len(frame) != FRAME:
            raise ValueError(f"expected {FRAME} samples, got {len(frame)}")
        x = np.concatenate([self._context, frame.astype(np.float32, copy=False)])[None, :]
        out, self._state = self._session.run(None, {"input": x, "state": self._state, "sr": self._sr})
        self._context = frame[-_CONTEXT:].astype(np.float32, copy=True)
        return float(out[0][0])


Event = Literal["start", "end"] | None


class SpeechGate:
    """Hysteresis over speech probabilities: `start` after `start_ms` of speech, `end` after
    `end_ms` of silence once speech started. Thresholds follow Silero's defaults (0.5 / 0.35)."""

    def __init__(self, start_ms: float = 250, end_ms: float = 700, threshold: float = 0.5, neg_threshold: float = 0.35) -> None:
        self.start_ms, self.end_ms = start_ms, end_ms
        self.threshold, self.neg_threshold = threshold, neg_threshold
        self.speaking = False
        self._run_ms = 0.0

    def push(self, prob: float, frame_ms: float = FRAME_MS) -> Event:
        if not self.speaking:
            self._run_ms = self._run_ms + frame_ms if prob >= self.threshold else 0.0
            if self._run_ms >= self.start_ms:
                self.speaking, self._run_ms = True, 0.0
                return "start"
            return None
        self._run_ms = self._run_ms + frame_ms if prob < self.neg_threshold else 0.0
        if self._run_ms >= self.end_ms:
            self.speaking, self._run_ms = False, 0.0
            return "end"
        return None
