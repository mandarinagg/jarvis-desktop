"""Whole replies as WhatsApp voice notes (ADR-030), next to the live pipeline but never through it.

Its own worker thread, so rendering a note never delays what the PC is saying. Same engines and
order as live speech (primary with one retry, then the offline fallback), no phrase cache: a reply
is not an acknowledgement. The result is Ogg Opus bytes, sent as base64 and never written to disk.
"""

from __future__ import annotations

import base64
import queue
import threading
import time
from collections.abc import Callable
from typing import Any

import numpy as np

from ..notes import encode_note, split_phrases
from .engines import Audio, SynthesisError, TtsEngine

Send = Callable[[dict[str, Any]], None]
Log = Callable[..., None]

RENDER_TIMEOUT_S = 15.0  # per phrase; the Core gives up on the whole note at 45 s
PAUSE_S = 0.25  # between phrases synthesized separately


def _noop_log(*_args: Any, **_kwargs: Any) -> None:
    pass


class NoteRenderer:
    def __init__(
        self,
        engine: TtsEngine,
        send: Send,
        fallback: TtsEngine | None = None,
        log: Log = _noop_log,
        timeout: float = RENDER_TIMEOUT_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.engine, self.fallback, self._send, self._log = engine, fallback, send, log
        self.timeout, self._clock = timeout, clock
        self._jobs: queue.Queue[tuple[str, str] | None] = queue.Queue()
        self._worker = threading.Thread(target=self._run, name="tts-render", daemon=True)
        self._worker.start()

    def render(self, request_id: str, text: str) -> None:
        self._jobs.put((request_id, text))

    def close(self) -> None:
        self._jobs.put(None)
        self._worker.join(timeout=5)

    def wait_idle(self, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while self._jobs.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.005)

    def _run(self) -> None:
        while True:
            job = self._jobs.get()
            try:
                if job is None:
                    return
                self._render(*job)
            except Exception as exc:
                self._log("error", "tts.render_failed", error=repr(exc))
                self._send({"type": "voice.error", "id": job[0], "code": "tts_failed", "message": "no se pudo generar la nota de voz"})
            finally:
                self._jobs.task_done()

    def _synthesize(self, engine: TtsEngine, phrases: list[str]) -> Audio:
        parts: list[np.ndarray] = []
        rate = 0
        for text in phrases:
            audio = engine.synthesize(text, self.timeout)
            if rate and audio.sample_rate != rate:
                raise SynthesisError("engine changed its sample rate mid-note")
            rate = audio.sample_rate
            if parts:
                parts.append(np.zeros(int(rate * PAUSE_S), dtype=np.float32))
            parts.append(audio.samples.astype(np.float32, copy=False))
        return Audio(np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32), rate or 24_000)

    def _render(self, request_id: str, text: str) -> None:
        t0 = self._clock()
        phrases = split_phrases(text)
        if not phrases:
            self._send({"type": "voice.error", "id": request_id, "code": "tts_failed", "message": "no hay texto para la nota de voz"})
            return
        audio: Audio | None = None
        name = self.engine.name
        for attempt in (1, 2):
            try:
                audio = self._synthesize(self.engine, phrases)
                break
            except SynthesisError as exc:
                self._log("warn", "tts.render_primary_failed", attempt=attempt, error=str(exc))
        if audio is None and self.fallback is not None:
            try:
                audio, name = self._synthesize(self.fallback, phrases), self.fallback.name
            except SynthesisError as exc:
                self._log("error", "tts.render_fallback_failed", error=str(exc))
        if audio is None or len(audio.samples) == 0:
            self._send({"type": "voice.error", "id": request_id, "code": "tts_failed", "message": "no se pudo generar la nota de voz"})
            return
        data = encode_note(audio.samples, audio.sample_rate)
        duration_ms = round(audio.duration_s * 1000, 1)
        self._log(
            "info", "tts.rendered", engine=name, chars=len(text), durationMs=duration_ms, bytes=len(data),
            ms=round((self._clock() - t0) * 1000, 1),
        )  # never the text
        self._send({
            "type": "tts.rendered",
            "id": request_id,
            "audio": base64.b64encode(data).decode("ascii"),
            "durationMs": duration_ms,
            "engine": name,
        })
