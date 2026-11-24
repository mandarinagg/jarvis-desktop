"""Push-to-talk STT: stt.start opens the mic, stt.stop closes it and transcribes (ADR-013).

Barge-in by voice (ADR-016): vad.arm opens the mic while Jarvis speaks and only runs voice
activity detection. When the owner talks for >= 250 ms it reports vad.speech and records that
utterance (with 0.5 s of pre-roll) until 700 ms of silence, then transcribes it like stt.stop.

Wake word (ADR-021): wake.enable keeps the mic open between captures and feeds it only to the
wake word detector, which keeps ~1.3 s of features (never raw audio) and reports wake.detected.
The Core then arms the VAD (vad.arm) to record the command, exactly like a barge-in.

Privacy (VOICE_PIPELINE §5): without the wake word the microphone is open only between stt.start
and stt.stop (or vad.arm and the end of that capture); every open/close is reported
(stt.listening, wake.listening) so the UI can show the mandatory indicator, and audio is kept in
memory only until it is transcribed. Nothing is written to disk.

WhatsApp voice notes (ADR-030): stt.transcribe hands over a whole note as bytes. It is decoded and
transcribed in the same worker as push-to-talk, so the two never compete for the GPU.
"""

from __future__ import annotations

import queue
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any, Protocol

import numpy as np

from ..notes import NoteError, decode_note
from .corrections import Corrector
from .vad import FRAME, SpeechGate

SAMPLE_RATE = 16_000
MAX_SECONDS = 60.0
MIN_SECONDS = 0.25  # shorter than this is a key bounce, not speech
LOAD_TIMEOUT_S = 60.0
PREROLL_SECONDS = 0.5  # audio kept from before the VAD fired, so the first syllable is not lost

Send = Callable[[dict[str, Any]], None]
Log = Callable[..., None]


class Transcriber(Protocol):
    def transcribe(self, samples: np.ndarray) -> str: ...
    def close(self) -> None: ...


class Vad(Protocol):
    def reset(self) -> None: ...
    def prob(self, frame: np.ndarray) -> float: ...


class WakeDetector(Protocol):
    threshold: float

    def reset(self) -> None: ...
    def push(self, audio: np.ndarray) -> float | None: ...


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
        load_vad: Callable[[], Vad] | None = None,
        gate: Callable[[], SpeechGate] = SpeechGate,
        load_wake: Callable[[], WakeDetector] | None = None,
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
        self._jobs: queue.Queue[tuple[str, np.ndarray | bytes] | None] = queue.Queue()
        # Barge-in by voice: _vad_on while the capture is VAD-driven; _watching until speech starts.
        self._load_vad, self._new_gate = load_vad, gate
        self._gate = gate()
        self._vad: Vad | None = None
        self._vad_error: str | None = None
        self._vad_lock = threading.Lock()
        self._vad_on = False
        self._watching = False
        self._preroll: deque[np.ndarray] = deque()
        self._vad_jobs: queue.Queue[tuple[str, np.ndarray] | None] = queue.Queue()
        threading.Thread(target=self._vad_run, name="stt-vad", daemon=True).start()
        # Wake word: the mic stays open between captures while _wake_on, feeding only the detector.
        self._mic_open = False
        self._load_wake = load_wake
        self._wake: WakeDetector | None = None
        self._wake_error: str | None = None
        self._wake_on = False
        self._wake_id: str | None = None
        self._wake_jobs: queue.Queue[np.ndarray | str | None] = queue.Queue()
        threading.Thread(target=self._wake_run, name="stt-wake", daemon=True).start()
        threading.Thread(target=self._load, args=(load_engine,), name="stt-load", daemon=True).start()
        self._worker = threading.Thread(target=self._run, name="stt-worker", daemon=True)
        self._worker.start()

    # ------------------------------------------------------------ messages

    def start(self, utterance_id: str) -> None:
        if self._active is not None:
            self.cancel(self._active)
        with self._lock:
            self._active, self._chunks, self._samples = utterance_id, [], 0
            self._vad_on = self._watching = False
        try:
            self._open_mic()
        except Exception as exc:  # no device, exclusive mode, permissions...
            with self._lock:
                self._active = None
            self._log("error", "stt.mic_failed", error=repr(exc))
            self._send({"type": "voice.error", "id": utterance_id, "code": "stt_failed", "message": "no se pudo abrir el micrófono"})
            return
        self._send({"type": "stt.listening", "id": utterance_id, "open": True})

    def arm(self, utterance_id: str) -> None:
        """Listen for the owner talking over Jarvis. Ignored while a push-to-talk capture runs."""
        if self._active is not None:
            return
        vad = self._get_vad()
        if vad is None:
            self._send({"type": "voice.error", "id": utterance_id, "code": "not_configured", "message": "la detección de voz no está disponible"})
            return
        vad.reset()
        with self._lock:
            self._active, self._chunks, self._samples = utterance_id, [], 0
            self._vad_on = self._watching = True
            self._preroll.clear()
            self._gate = self._new_gate()
        try:
            self._open_mic()
        except Exception as exc:
            with self._lock:
                self._active, self._vad_on, self._watching = None, False, False
            self._log("error", "stt.mic_failed", error=repr(exc))
            self._send({"type": "voice.error", "id": utterance_id, "code": "stt_failed", "message": "no se pudo abrir el micrófono"})
            return
        self._send({"type": "stt.listening", "id": utterance_id, "open": True})

    def disarm(self, utterance_id: str) -> None:
        """Stop watching. An utterance the VAD already started is left to finish on its own."""
        with self._lock:
            watching = self._active == utterance_id and self._watching
        if watching:
            self.cancel(utterance_id)

    def wake_enable(self, request_id: str, threshold: float | None = None) -> None:
        """Keep listening for the wake word between captures."""
        detector = self._get_wake()
        if detector is None:
            self._send({"type": "voice.error", "id": request_id, "code": "not_configured", "message": "la palabra de activación no está disponible"})
            return
        if threshold is not None:
            detector.threshold = threshold
        with self._lock:
            self._wake_on, self._wake_id = True, request_id
            idle = self._active is None
        self._wake_jobs.put("reset")
        if idle:
            try:
                self._open_mic()
            except Exception as exc:
                with self._lock:
                    self._wake_on = False
                self._log("error", "stt.mic_failed", error=repr(exc))
                self._send({"type": "voice.error", "id": request_id, "code": "stt_failed", "message": "no se pudo abrir el micrófono"})
                return
        self._log("info", "stt.wake_on", threshold=detector.threshold)
        self._send({"type": "wake.listening", "id": request_id, "open": True})

    def wake_disable(self, request_id: str) -> None:
        with self._lock:
            was_on, self._wake_on = self._wake_on, False
            idle = self._active is None
        if idle:
            self._close_mic()
        if was_on:
            self._log("info", "stt.wake_off")
        self._send({"type": "wake.listening", "id": request_id, "open": False})

    def stop(self, utterance_id: str) -> None:
        audio = self._close(utterance_id)
        if audio is not None:
            self._jobs.put((utterance_id, audio))

    def cancel(self, utterance_id: str) -> None:
        self._close(utterance_id)

    def transcribe_note(self, request_id: str, data: bytes) -> None:
        """A WhatsApp voice note (Ogg Opus bytes): answered with stt.final, like push-to-talk."""
        self._jobs.put((request_id, data))

    def close(self) -> None:
        if self._active is not None:
            self.cancel(self._active)
        with self._lock:
            self._wake_on = False
        self._close_mic()
        self._wake_jobs.put(None)
        self._vad_jobs.put(None)
        self._jobs.put(None)
        self._worker.join(timeout=5)
        if self._engine is not None:
            self._engine.close()

    def wait_idle(self, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while (self._jobs.unfinished_tasks or self._vad_jobs.unfinished_tasks or self._wake_jobs.unfinished_tasks) and time.monotonic() < deadline:
            time.sleep(0.005)

    # ------------------------------------------------------------ internals

    def _open_mic(self) -> None:
        if not self._mic_open:
            self._mic.open(self._on_audio)
            self._mic_open = True

    def _close_mic(self) -> None:
        if self._mic_open:
            self._mic_open = False
            self._mic.close()

    def _on_audio(self, chunk: np.ndarray) -> None:
        overflow = None
        with self._lock:
            if self._active is None:
                if self._wake_on:
                    self._wake_jobs.put(chunk)
                return
            if self._vad_on:  # the VAD thread decides what to keep
                self._vad_jobs.put((self._active, chunk))
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
            self._vad_on = self._watching = False
            self._preroll.clear()
            chunks, self._chunks = self._chunks, []
            keep_open = self._wake_on
        try:
            if keep_open:
                self._wake_jobs.put("reset")  # the capture's audio never reaches the detector
            else:
                self._close_mic()
        finally:
            self._send({"type": "stt.listening", "id": utterance_id, "open": False})
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)

    def _get_vad(self) -> Vad | None:
        with self._vad_lock:  # preloaded by _load; vad.arm may get here first
            if self._vad is None and self._vad_error is None and self._load_vad is not None:
                try:
                    self._vad = self._load_vad()
                    self._log("info", "stt.vad_ready")
                except Exception as exc:
                    self._vad_error = f"{type(exc).__name__}: {exc}"
                    self._log("error", "stt.vad_failed", error=self._vad_error)
            return self._vad

    def _get_wake(self) -> WakeDetector | None:
        with self._vad_lock:
            if self._wake is None and self._wake_error is None and self._load_wake is not None:
                try:
                    self._wake = self._load_wake()
                    self._log("info", "stt.wake_ready")
                except Exception as exc:
                    self._wake_error = f"{type(exc).__name__}: {exc}"
                    self._log("error", "stt.wake_failed", error=self._wake_error)
            return self._wake

    def _wake_run(self) -> None:
        """Scores mic audio for the wake word, off the audio thread."""
        while True:
            job = self._wake_jobs.get()
            try:
                if job is None:
                    return
                detector = self._wake
                if detector is None:
                    continue
                if isinstance(job, str):
                    detector.reset()
                    continue
                with self._lock:
                    listening = self._wake_on and self._active is None
                    wake_id = self._wake_id
                if not listening:
                    continue
                score = detector.push(job)
                if score is not None and wake_id is not None:
                    with self._lock:
                        still = self._wake_on and self._active is None
                    if still:
                        self._log("info", "stt.wake_detected", score=round(score, 3))
                        self._send({"type": "wake.detected", "id": wake_id, "score": round(score, 4)})
            except Exception as exc:
                self._log("error", "stt.wake_worker_failed", error=repr(exc))
            finally:
                self._wake_jobs.task_done()

    def _vad_run(self) -> None:
        """Feeds 32 ms frames to the VAD. Runs off the audio thread so inference never drops audio."""
        pending = np.zeros(0, dtype=np.float32)
        current: str | None = None
        while True:
            job = self._vad_jobs.get()
            try:
                if job is None:
                    return
                utterance_id, chunk = job
                if utterance_id != current:
                    current, pending = utterance_id, np.zeros(0, dtype=np.float32)
                pending = self._vad_chunk(utterance_id, chunk, pending)
            except Exception as exc:
                self._log("error", "stt.vad_worker_failed", error=repr(exc))
            finally:
                self._vad_jobs.task_done()

    def _vad_chunk(self, utterance_id: str, chunk: np.ndarray, pending: np.ndarray) -> np.ndarray:
        with self._lock:
            if self._active != utterance_id or not self._vad_on:
                return pending  # stale audio from a capture that already ended
            if self._watching:
                self._preroll.append(chunk)
                while sum(len(c) for c in self._preroll) - len(self._preroll[0]) >= PREROLL_SECONDS * SAMPLE_RATE:
                    self._preroll.popleft()
            else:
                self._chunks.append(chunk)
                self._samples += len(chunk)
            gate, overflow = self._gate, self._samples >= self.max_seconds * SAMPLE_RATE
        if overflow:
            self.stop(utterance_id)
            return pending
        vad = self._vad
        pending = np.concatenate([pending, chunk])
        while vad is not None and len(pending) >= FRAME:
            frame, pending = pending[:FRAME], pending[FRAME:]
            event = gate.push(vad.prob(frame))
            if event == "start":
                with self._lock:
                    if self._active != utterance_id or not self._watching:
                        return pending
                    self._watching = False
                    self._chunks = list(self._preroll)
                    self._samples = sum(len(c) for c in self._chunks)
                    self._preroll.clear()
                self._log("info", "stt.vad_speech")
                self._send({"type": "vad.speech", "id": utterance_id})
            elif event == "end":
                self.stop(utterance_id)
                return np.zeros(0, dtype=np.float32)
        return pending

    def _load(self, load_engine: Callable[[], Transcriber]) -> None:
        self._get_vad()  # ~200 ms: better here than on the first barge-in watch
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
                request_id, audio = job
                if isinstance(audio, bytes):
                    try:
                        audio = decode_note(audio)
                    except NoteError as exc:
                        self._log("warn", "stt.note_rejected", error=str(exc))
                        self._send({"type": "voice.error", "id": request_id, "code": "stt_failed", "message": str(exc)[:200]})
                        continue
                self._transcribe(request_id, audio)
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
