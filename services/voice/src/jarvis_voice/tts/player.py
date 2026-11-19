"""Audio output: a queue of clips played back to back, cut in < 100 ms with a 30 ms fade (barge-in).

`Mixer` is pure logic (testable without a sound card); `Player` drives it from a sounddevice
callback. Clip callbacks never run on the audio thread: they go to a dispatcher thread.
"""

from __future__ import annotations

import queue
import threading
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from .engines import Audio

OUTPUT_RATE = 24_000
FADE_MS = 30

Callback = Callable[[], None]


def resample(audio: Audio, rate: int = OUTPUT_RATE) -> np.ndarray:
    """Linear resampling: good enough for speech (Piper 22.05 kHz -> 24 kHz)."""
    if audio.sample_rate == rate or len(audio.samples) == 0:
        return audio.samples.astype("float32", copy=False)
    n = round(len(audio.samples) * rate / audio.sample_rate)
    x_new = np.linspace(0, len(audio.samples) - 1, n)
    return np.interp(x_new, np.arange(len(audio.samples)), audio.samples).astype("float32")


@dataclass
class Clip:
    samples: np.ndarray
    on_start: Callback | None = None
    on_end: Callback | None = None
    pos: int = field(default=0, init=False)


class Mixer:
    def __init__(self, sample_rate: int = OUTPUT_RATE, fade_ms: int = FADE_MS) -> None:
        self.sample_rate = sample_rate
        self.fade_len = max(1, sample_rate * fade_ms // 1000)
        self._clips: deque[Clip] = deque()
        self._fade = np.zeros(0, dtype="float32")
        self._lock = threading.Lock()

    def enqueue(self, clip: Clip) -> None:
        with self._lock:
            self._clips.append(clip)

    @property
    def busy(self) -> bool:
        with self._lock:
            return bool(self._clips) or len(self._fade) > 0

    def cancel(self) -> None:
        """Drop everything queued and fade out the clip that is playing. Dropped clips fire nothing."""
        with self._lock:
            if self._clips and self._clips[0].pos > 0:
                cur = self._clips[0]
                tail = cur.samples[cur.pos : cur.pos + self.fade_len]
                ramp = np.linspace(1.0, 0.0, len(tail), endpoint=False, dtype="float32")
                self._fade = (tail * ramp).astype("float32")
            self._clips.clear()

    def read(self, frames: int) -> tuple[np.ndarray, list[Callback]]:
        out = np.zeros(frames, dtype="float32")
        events: list[Callback] = []
        with self._lock:
            filled = 0
            if len(self._fade):
                n = min(frames, len(self._fade))
                out[:n] = self._fade[:n]
                self._fade = self._fade[n:]
                filled = n
            while filled < frames and self._clips:
                clip = self._clips[0]
                if clip.pos == 0 and clip.on_start:
                    events.append(clip.on_start)
                    clip.on_start = None
                n = min(frames - filled, len(clip.samples) - clip.pos)
                out[filled : filled + n] = clip.samples[clip.pos : clip.pos + n]
                clip.pos += n
                filled += n
                if clip.pos >= len(clip.samples):
                    self._clips.popleft()
                    if clip.on_end:
                        events.append(clip.on_end)
        return out, events


class Player:
    """Keeps one low-latency output stream open; the device stays warm between phrases."""

    def __init__(self, device: int | str | None = None, mixer: Mixer | None = None) -> None:
        self.mixer = mixer or Mixer()
        self._device = device
        self._stream = None
        self._events: queue.SimpleQueue[Callback | None] = queue.SimpleQueue()
        self._dispatcher = threading.Thread(target=self._dispatch, name="tts-events", daemon=True)
        self._dispatcher.start()

    def _dispatch(self) -> None:
        while (cb := self._events.get()) is not None:
            try:
                cb()
            except Exception:  # a bad callback must not kill playback events
                pass

    def _callback(self, outdata, frames, _time, _status) -> None:
        buf, events = self.mixer.read(frames)
        outdata[:, 0] = buf
        for cb in events:
            self._events.put(cb)

    def _ensure_stream(self) -> None:
        if self._stream is None:
            import sounddevice as sd

            self._stream = sd.OutputStream(
                samplerate=self.mixer.sample_rate,
                channels=1,
                dtype="float32",
                blocksize=self.mixer.sample_rate // 50,  # 20 ms
                latency="low",
                device=self._device,
                callback=self._callback,
            )
            self._stream.start()

    def play(self, audio: Audio, on_start: Callback | None = None, on_end: Callback | None = None) -> None:
        self._ensure_stream()
        self.mixer.enqueue(Clip(resample(audio, self.mixer.sample_rate), on_start, on_end))

    def mark(self, on_reached: Callback) -> None:
        """Fires once everything enqueued before it has played (end of turn)."""
        self._ensure_stream()
        self.mixer.enqueue(Clip(np.zeros(0, dtype="float32"), on_start=on_reached))

    def cancel(self) -> None:
        self.mixer.cancel()

    def close(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        self._events.put(None)
