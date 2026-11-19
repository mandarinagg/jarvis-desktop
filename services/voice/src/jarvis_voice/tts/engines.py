"""TTS engines (ADR-011): Google Neural2 by default, Piper as the offline fallback.

Every engine returns a whole phrase (Neural2 has no streaming). Overlapping synthesis of the
next phrase with playback of the current one happens in the pipeline, not here.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
import wave
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

GOOGLE_SAMPLE_RATE = 24_000


class SynthesisError(RuntimeError):
    """The engine could not produce audio (network, quota, timeout, bad credentials...)."""


@dataclass(frozen=True)
class Audio:
    samples: np.ndarray  # float32 mono in [-1, 1]
    sample_rate: int

    @property
    def duration_s(self) -> float:
        return len(self.samples) / self.sample_rate


class TtsEngine(Protocol):
    name: str  # "google" | "piper": reported in tts.started
    cache_id: str  # engine + voice: two voices never share a cache entry

    def synthesize(self, text: str, timeout: float) -> Audio: ...


def pcm16_to_float(data: bytes) -> np.ndarray:
    return (np.frombuffer(data, dtype="<i2").astype("float32") / 32768.0).astype("float32")


def wav_to_audio(data: bytes) -> Audio:
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise SynthesisError(f"unsupported WAV: {w.getnchannels()} ch, {8 * w.getsampwidth()} bit")
        return Audio(pcm16_to_float(w.readframes(w.getnframes())), w.getframerate())


def audio_to_wav(audio: Audio) -> bytes:
    pcm = (np.clip(audio.samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(audio.sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def language_of(voice_name: str) -> str:
    return "-".join(voice_name.split("-")[:2])


class GoogleEngine:
    """Cloud Text-to-Speech over gRPC, request/response. The client keeps its channel open."""

    name = "google"

    def __init__(self, api_key: str, voice: str = "es-US-Neural2-B", client: Any | None = None) -> None:
        from google.cloud import texttospeech as tts

        self._tts = tts
        self.voice = voice
        self.cache_id = f"google-{voice}"
        self._client = client or tts.TextToSpeechClient(client_options={"api_key": api_key})

    def synthesize(self, text: str, timeout: float) -> Audio:
        tts = self._tts
        try:
            response = self._client.synthesize_speech(
                input=tts.SynthesisInput(text=text),
                voice=tts.VoiceSelectionParams(name=self.voice, language_code=language_of(self.voice)),
                audio_config=tts.AudioConfig(
                    audio_encoding=tts.AudioEncoding.LINEAR16, sample_rate_hertz=GOOGLE_SAMPLE_RATE
                ),
                timeout=timeout,
            )
        except Exception as exc:  # google.api_core exceptions, grpc errors, DNS...
            raise SynthesisError(f"google: {type(exc).__name__}") from exc
        return wav_to_audio(response.audio_content)


Runner = Callable[..., subprocess.CompletedProcess[bytes]]


class PiperEngine:
    """Offline fallback. piper-tts is GPL-3.0, so it runs as a separate process (ADR-011)."""

    name = "piper"

    def __init__(self, model: Path, runner: Runner = subprocess.run) -> None:
        config = model.with_name(model.name + ".json")
        if not model.exists() or not config.exists():
            raise FileNotFoundError(f"Piper model or its .json config not found: {model}")
        self.model = model
        self.sample_rate = int(json.loads(config.read_text(encoding="utf-8"))["audio"]["sample_rate"])
        self.cache_id = f"piper-{model.stem}"
        self._run = runner

    def synthesize(self, text: str, timeout: float) -> Audio:
        # Raw PCM16 on stdout: piper's `-f -` (WAV to stdout) breaks on Windows (temp file reopened by name).
        cmd = [sys.executable, "-m", "piper", "-m", str(self.model), "--output-raw"]
        try:
            proc = self._run(cmd, input=text.encode("utf-8"), capture_output=True, timeout=timeout, check=False)
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise SynthesisError(f"piper: {type(exc).__name__}") from exc
        if proc.returncode != 0 or not proc.stdout:
            tail = proc.stderr.decode("utf-8", "replace")[-300:]
            raise SynthesisError(f"piper exited {proc.returncode}: {tail}")
        return Audio(pcm16_to_float(proc.stdout[: len(proc.stdout) // 2 * 2]), self.sample_rate)
