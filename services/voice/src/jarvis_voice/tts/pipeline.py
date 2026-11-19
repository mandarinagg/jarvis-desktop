"""Phrase-by-phrase TTS (ADR-011): cache -> primary engine (2.5 s, one retry) -> offline fallback.

One worker thread synthesizes phrases in order while the player is still playing the previous
one, so after the first phrase there are no gaps (mitigation 2). Cancelling a turn drops its
pending phrases and fades out the audio in < 100 ms.
"""

from __future__ import annotations

import queue
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol

from .cache import PhraseCache
from .engines import Audio, SynthesisError, TtsEngine

Send = Callable[[dict[str, Any]], None]
Log = Callable[..., None]

PRIMARY_TIMEOUT_S = 2.5
FALLBACK_TIMEOUT_S = 15.0
PREWARM_TIMEOUT_S = 10.0
MAX_TRACKED_TURNS = 64


class AudioOut(Protocol):
    def play(self, audio: Audio, on_start: Callable[[], None] | None = None) -> None: ...
    def mark(self, on_reached: Callable[[], None]) -> None: ...
    def cancel(self) -> None: ...
    def close(self) -> None: ...


@dataclass(frozen=True)
class Job:
    id: str
    turn_id: str
    seq: int
    text: str
    final: bool
    received: float


@dataclass
class TurnState:
    cancelled: bool = False
    finished: bool = False


def _noop_log(*_args: Any, **_kwargs: Any) -> None:
    pass


class TtsPipeline:
    def __init__(
        self,
        engine: TtsEngine,
        player: AudioOut,
        send: Send,
        cache: PhraseCache | None = None,
        fallback: TtsEngine | None = None,
        clock: Callable[[], float] = time.monotonic,
        log: Log = _noop_log,
        primary_timeout: float = PRIMARY_TIMEOUT_S,
        fallback_timeout: float = FALLBACK_TIMEOUT_S,
    ) -> None:
        self.engine, self.fallback, self.cache = engine, fallback, cache
        self.player, self._send, self._clock, self._log = player, send, clock, log
        self.primary_timeout, self.fallback_timeout = primary_timeout, fallback_timeout
        self._turns: OrderedDict[str, TurnState] = OrderedDict()
        self._lock = threading.Lock()
        self._jobs: queue.Queue[Job | None] = queue.Queue()
        self._worker = threading.Thread(target=self._run, name="tts-synth", daemon=True)
        self._worker.start()

    # ------------------------------------------------------------ public API (service thread)

    def speak(self, msg: dict[str, Any]) -> None:
        job = Job(msg["id"], msg["turnId"], msg["seq"], msg["text"], msg["final"], self._clock())
        if self._turn(job.turn_id).cancelled:
            return
        self._jobs.put(job)

    def cancel(self, turn_id: str) -> None:
        state = self._turn(turn_id)
        with self._lock:
            already = state.cancelled
            state.cancelled = True
        if not already:
            self.player.cancel()
            self._finish(turn_id, interrupted=True)

    def prewarm(self, phrases: Iterable[str]) -> threading.Thread:
        """Fill the cache with acknowledgements in the background. Also opens the gRPC channel."""

        def run() -> None:
            for text in phrases:
                if self.cache is None or self.cache.get(text) is not None:
                    continue
                try:
                    self.cache.put(text, self.engine.synthesize(text, PREWARM_TIMEOUT_S))
                except SynthesisError as exc:
                    self._log("warn", "tts.prewarm_failed", error=str(exc))
                    return  # offline or bad key: do not hammer the API

        t = threading.Thread(target=run, name="tts-prewarm", daemon=True)
        t.start()
        return t

    def close(self) -> None:
        self.player.cancel()
        self._jobs.put(None)
        self._worker.join(timeout=5)
        self.player.close()

    def wait_idle(self, timeout: float = 5.0) -> None:
        """Test helper: wait until every queued phrase went through synthesis."""
        deadline = time.monotonic() + timeout
        while self._jobs.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.005)

    # ------------------------------------------------------------ internals

    def _turn(self, turn_id: str) -> TurnState:
        with self._lock:
            state = self._turns.get(turn_id)
            if state is None:
                state = self._turns[turn_id] = TurnState()
                while len(self._turns) > MAX_TRACKED_TURNS:
                    self._turns.popitem(last=False)
            return state

    def _finish(self, turn_id: str, interrupted: bool) -> None:
        state = self._turn(turn_id)
        with self._lock:
            if state.finished:
                return
            state.finished = True
        self._send({"type": "tts.finished", "turnId": turn_id, "interrupted": interrupted})

    def _run(self) -> None:
        while True:
            job = self._jobs.get()
            try:
                if job is None:
                    return
                self._process(job)
            except Exception as exc:  # keep the worker alive whatever happens
                self._log("error", "tts.worker_failed", error=repr(exc))
            finally:
                self._jobs.task_done()

    def _process(self, job: Job) -> None:
        state = self._turn(job.turn_id)
        if state.cancelled:
            return
        result = self._synthesize(job)
        if state.cancelled:
            return
        if result is not None:
            audio, engine = result

            def started() -> None:
                if not state.cancelled:
                    latency = round((self._clock() - job.received) * 1000, 1)
                    self._send(
                        {"type": "tts.started", "turnId": job.turn_id, "seq": job.seq, "engine": engine, "latencyMs": latency}
                    )

            self.player.play(audio, on_start=started)
        if job.final:
            self.player.mark(lambda: self._finish(job.turn_id, interrupted=False))

    def _synthesize(self, job: Job) -> tuple[Audio, str] | None:
        if self.cache is not None and (hit := self.cache.get(job.text)) is not None:
            return hit, "cache"
        for attempt in (1, 2):
            try:
                audio = self.engine.synthesize(job.text, self.primary_timeout)
            except SynthesisError as exc:
                self._log("warn", "tts.primary_failed", attempt=attempt, error=str(exc))
                continue
            if self.cache is not None:
                self.cache.put(job.text, audio)
            return audio, self.engine.name
        if self.fallback is not None:
            try:
                return self.fallback.synthesize(job.text, self.fallback_timeout), self.fallback.name
            except SynthesisError as exc:
                self._log("error", "tts.fallback_failed", error=str(exc))
        self._send({"type": "voice.error", "id": job.id, "code": "tts_failed", "message": "no se pudo sintetizar la frase"})
        return None
