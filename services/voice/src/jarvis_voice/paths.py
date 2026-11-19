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


def tts_cache_dir() -> Path:
    return jarvis_home() / "cache" / "tts"
