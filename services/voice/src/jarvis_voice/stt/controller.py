"""Push-to-talk STT: stt.start opens the mic, stt.stop closes it and transcribes (ADR-013).

Privacy (VOICE_PIPELINE §5): the microphone is open only between stt.start and stt.stop, every
open/close is reported (stt.listening) so the UI can show the mandatory indicator, and audio is
kept in memory only until it is transcribed. Nothing is written to disk.
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable
from typing import Any, Protocol

import numpy as np

from .corrections import Corrector

SAMPLE_RATE = 16_000
MAX_SECONDS = 60.0
MIN_SECONDS = 0.25  # shorter than this is a key bounce, not speech
LOAD_TIMEOUT_S = 60.0

Send = Callable[[dict[str, Any]], None]
Log = Callable[..., None]


class Transcriber(Protocol):
    def transcribe(self, samples: np.ndarray) -> str: ...
    def close(self) -> None: ...


class Microphone(Protocol):
    def open(self, on_audio: Callable[[np.ndarray], None]) -> None: ...
    def close(self) -> None: ...


class SoundDeviceMicrophone:
    """16 kHz mono float32. Opened per utterance so the mic is never live between turns."""

    def __init__(self, device: int | str | None = None) -> None:
        self._device = device
        self._stream = None

    def open(self, on_audio: Callable[[np.ndarray], None]) -> None:
        import sounddevice as sd

        def callback(indata, _frames, _time, _status) -> None:
            on_audio(indata[:, 0].copy())

        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=SAMPLE_RATE // 50, device=self._device, callback=callback
        )
        self._stream.start()

    def close(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


def _noop_log(*_args: Any, **_kwargs: Any) -> None:
    pass


class SttController:
    def __init__(
        self,
        load_engine: Callable[[], Transcriber],
        microphone: Microphone,
        send: Send,
        corrector: Corrector | None = None,
        log: Log = _noop_log,
        clock: Callable[[], float] = time.monotonic,
        max_seconds: float = MAX_SECONDS,
    ) -> None:
        self._mic, self._send, self._log, self._clock = microphone, send, log, clock
        self._corrector = corrector or Corrector()
        self.max_seconds = max_seconds
        self._engine: Transcriber | None = None
        self._engine_error: str | None = None
        self._loaded = threading.Event()
        self._lock = threading.Lock()
        self._active: str | None = None
        self._chunks: list[np.ndarray] = []
        self._samples = 0
        self._jobs: queue.Queue[tuple[str, np.ndarray] | None] = queue.Queue()
        threading.Thread(target=self._load, args=(load_engine,), name="stt-load", daemon=True).start()
        self._worker = threading.Thread(target=self._run, name="stt-worker", daemon=True)
        self._worker.start()

    # ------------------------------------------------------------ messages

    def start(self, utterance_id: str) -> None:
        if self._active is not None:
            self.cancel(self._active)
        with self._lock:
            self._active, self._chunks, self._samples = utterance_id, [], 0
        try:
            self._mic.open(self._on_audio)
        except Exception as exc:  # no device, exclusive mode, permissions...
            with self._lock:
                self._active = None
            self._log("error", "stt.mic_failed", error=repr(exc))
            self._send({"type": "voice.error", "id": utterance_id, "code": "stt_failed", "message": "no se pudo abrir el micrófono"})
            return
        self._send({"type": "stt.listening", "id": utterance_id, "open": True})

    def stop(self, utterance_id: str) -> None:
        audio = self._close(utterance_id)
        if audio is not None:
            self._jobs.put((utterance_id, audio))

    def cancel(self, utterance_id: str) -> None:
        self._close(utterance_id)

    def close(self) -> None:
        if self._active is not None:
            self.cancel(self._active)
        self._jobs.put(None)
        self._worker.join(timeout=5)
        if self._engine is not None:
            self._engine.close()

    def wait_idle(self, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while self._jobs.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.005)

    # ------------------------------------------------------------ internals

    def _on_audio(self, chunk: np.ndarray) -> None:
        overflow = None
        with self._lock:
            if self._active is None:
                return
            self._chunks.append(chunk)
            self._samples += len(chunk)
            if self._samples >= self.max_seconds * SAMPLE_RATE:
                overflow = self._active
        if overflow is not None:
            # Never block the audio thread: the stop (and mic close) runs elsewhere.
            threading.Thread(target=self.stop, args=(overflow,), daemon=True).start()

    def _close(self, utterance_id: str) -> np.ndarray | None:
        with self._lock:
            if self._active != utterance_id:
                return None
            self._active = None
            chunks, self._chunks = self._chunks, []
        try:
            self._mic.close()
        finally:
            self._send({"type": "stt.listening", "id": utterance_id, "open": False})
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)

    def _load(self, load_engine: Callable[[], Transcriber]) -> None:
        try:
            engine = load_engine()
            t0 = self._clock()
            engine.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))  # compiles Vulkan shaders up front
            self._engine = engine
            self._log("info", "stt.ready", warmupMs=round((self._clock() - t0) * 1000, 1))
        except Exception as exc:
            self._engine_error = f"{type(exc).__name__}: {exc}"
            self._log("error", "stt.load_failed", error=self._engine_error)
        finally:
            self._loaded.set()

    def _run(self) -> None:
        while True:
            job = self._jobs.get()
            try:
                if job is None:
                    return
                self._transcribe(*job)
            except Exception as exc:
                self._log("error", "stt.worker_failed", error=repr(exc))
            finally:
                self._jobs.task_done()

    def _transcribe(self, utterance_id: str, audio: np.ndarray) -> None:
        audio_ms = round(len(audio) / SAMPLE_RATE * 1000, 1)
        if len(audio) < MIN_SECONDS * SAMPLE_RATE:
            self._send({"type": "stt.final", "id": utterance_id, "text": "", "audioMs": audio_ms, "sttMs": 0})
            return
        self._loaded.wait(LOAD_TIMEOUT_S)
        if self._engine is None:
            self._send({"type": "voice.error", "id": utterance_id, "code": "stt_failed", "message": "el motor de STT no está disponible"})
            return
        t0 = self._clock()
        raw = self._engine.transcribe(audio)
        stt_ms = round((self._clock() - t0) * 1000, 1)
        text = self._corrector.correct(raw)[:8000]
        self._log("info", "stt.final", audioMs=audio_ms, sttMs=stt_ms, chars=len(text))  # never the text itself
        self._send({"type": "stt.final", "id": utterance_id, "text": text, "audioMs": audio_ms, "sttMs": stt_ms})
