"""Wake word detection (Phase 4, ADR-021): openWakeWord's "hey jarvis" on onnxruntime, on the CPU.

The openWakeWord pipeline, reimplemented without the package (it pulls tflite and extra wheels
that Smart App Control may block, ADR-009):

1. every 80 ms (1280 samples at 16 kHz) a log-mel spectrogram of that chunk plus 480 samples of
   context -> 8 frames x 32 bins, scaled as openWakeWord does (x / 10 + 2);
2. a speech embedding (96 values) of the last 76 mel frames;
3. the wake word model scores the last 16 embeddings (1.28 s): a probability.

Privacy (VOICE_PIPELINE §5): only these features are kept, in memory, for ~1.3 s. Raw audio before
the activation is never stored or sent anywhere; after a detection the buffers are cleared.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Protocol

import numpy as np

SAMPLE_RATE = 16_000
CHUNK = 1_280  # 80 ms
_CONTEXT = 480  # 3 hops of 160: the mel model needs them to give 8 frames per chunk
_MEL_WINDOW = 76
_EMB_WINDOW = 16
_MEL_KEEP = 120


class Session(Protocol):
    def run(self, output_names: list[str] | None, input_feed: dict[str, np.ndarray]) -> list[np.ndarray]: ...


class WakeWordDetector:
    def __init__(
        self,
        mel: Session,
        embedding: Session,
        wake: Session,
        threshold: float = 0.5,
        cooldown_s: float = 2.0,
    ) -> None:
        self._mel, self._emb, self._wake = mel, embedding, wake
        self.threshold = threshold
        self._cooldown_chunks = round(cooldown_s * SAMPLE_RATE / CHUNK)
        self._mel_in = _input_name(mel, "input")
        self._emb_in = _input_name(embedding, "input_1")
        self._wake_in = _input_name(wake, "x.1")
        self.reset()

    @classmethod
    def from_dir(cls, models: Path, name: str = "hey_jarvis_v0.1", threshold: float = 0.5) -> WakeWordDetector:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1

        def load(f: str) -> Session:
            return ort.InferenceSession(str(models / f), sess_options=opts, providers=["CPUExecutionProvider"])

        return cls(load("melspectrogram.onnx"), load("embedding_model.onnx"), load(f"{name}.onnx"), threshold=threshold)

    def reset(self) -> None:
        self._pending = np.zeros(0, dtype=np.float32)
        self._context = np.zeros(_CONTEXT, dtype=np.float32)
        self._mels = np.ones((_MEL_WINDOW, 32), dtype=np.float32)  # openWakeWord starts from ones too
        self._embeddings: deque[np.ndarray] = deque(maxlen=_EMB_WINDOW)
        self._cooldown = 0
        self.last_score = 0.0  # latest model output, for calibration (diagnostics/wake_check.py)

    def push(self, audio: np.ndarray) -> float | None:
        """Feeds float32 audio in [-1, 1]. Returns the score when it crosses the threshold, else None."""
        # openWakeWord's models take int16-range samples.
        self._pending = np.concatenate([self._pending, audio.astype(np.float32, copy=False) * 32_767.0])
        hit: float | None = None
        while len(self._pending) >= CHUNK:
            chunk, self._pending = self._pending[:CHUNK], self._pending[CHUNK:]
            score = self._step(chunk)
            self.last_score = score or 0.0
            if self._cooldown > 0:
                self._cooldown -= 1
            elif score is not None and score >= self.threshold and hit is None:
                hit = score
        if hit is not None:
            self._embeddings.clear()  # the same "hey jarvis" must not fire twice
            self._cooldown = self._cooldown_chunks
        return hit

    def _step(self, chunk: np.ndarray) -> float | None:
        x = np.concatenate([self._context, chunk])[None, :]
        self._context = chunk[-_CONTEXT:].copy()
        mel = np.squeeze(self._mel.run(None, {self._mel_in: x})[0]) / 10.0 + 2.0
        self._mels = np.concatenate([self._mels, mel.reshape(-1, 32)])[-_MEL_KEEP:]
        window = self._mels[-_MEL_WINDOW:][None, :, :, None].astype(np.float32)
        emb = np.squeeze(self._emb.run(None, {self._emb_in: window})[0]).reshape(96)
        self._embeddings.append(emb.astype(np.float32))
        if len(self._embeddings) < _EMB_WINDOW:
            return None  # needs 1.28 s of real audio before it can score
        feats = np.stack(self._embeddings)[None, :, :]
        return float(np.squeeze(self._wake.run(None, {self._wake_in: feats})[0]))


def _input_name(session: Session, default: str) -> str:
    get_inputs = getattr(session, "get_inputs", None)
    return get_inputs()[0].name if callable(get_inputs) else default
