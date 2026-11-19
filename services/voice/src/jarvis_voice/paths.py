"""Runtime data lives outside the repo, in %APPDATA%/Jarvis (same rule as the Core's paths.ts)."""

from __future__ import annotations

import os
from pathlib import Path


def jarvis_home() -> Path:
    if override := os.environ.get("JARVIS_DATA_DIR"):
        return Path(override).resolve()
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    return Path(base) / "Jarvis"


def piper_model(name: str = "es_AR-daniela-high") -> Path:
    return jarvis_home() / "models" / "tts" / "piper" / f"{name}.onnx"


def stt_bin_dir() -> Path:
    from .diagnostics.stt_bench import LLAMA_TAG, WHISPER_TAG  # pinned binaries (ADR-009)

    return jarvis_home() / "bin" / f"stt-whisper-{WHISPER_TAG}-vk-{LLAMA_TAG}"


def parakeet_model() -> Path:
    return jarvis_home() / "models" / "parakeet" / "ggml-parakeet-tdt-0.6b-v3-q8_0.bin"


def vad_model() -> Path:
    """Silero VAD v5 (MIT), from snakers4/silero-vad v5.1.2 (sha256 2623a2953f6f...788f)."""
    return jarvis_home() / "models" / "vad" / "silero_vad.onnx"


def stt_vocabulary() -> Path:
    return jarvis_home() / "stt" / "vocabulary.txt"


def tts_cache_dir() -> Path:
    return jarvis_home() / "cache" / "tts"
