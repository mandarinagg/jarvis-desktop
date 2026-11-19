"""On-disk phrase cache (ADR-011, mitigation 1): short phrases, mostly acknowledgements, play in ~0 ms.

Lives in %APPDATA%/Jarvis/cache/tts/<engine-voice>/<sha256>.wav. It holds only Jarvis's own
replies, never the user's audio. Short phrases only, so the cache stays small.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from .engines import Audio, SynthesisError, audio_to_wav, wav_to_audio

MAX_CACHED_CHARS = 80

# Pre-synthesized when the service is configured: the replies that most often open a turn.
ACKNOWLEDGEMENTS = (
    "Dale.",
    "Dale, ya lo miro.",
    "Listo.",
    "Entendido.",
    "Un segundo.",
    "Perfecto.",
    "Hecho.",
    # Spoken by the Core's VoiceTurns (packages/core/src/voice/turns.ts, PHRASES): keep in sync.
    "No te escuché bien, ¿me lo repetís?",
    "Llegué al tope de gasto de hoy. Seguimos mañana o subí el tope.",
    "No pude hablar con Claude. Te dejé el detalle en pantalla.",
    "Algo falló. Te dejé el detalle en pantalla.",
)

_SPACES = re.compile(r"\s+")


def normalize(text: str) -> str:
    return _SPACES.sub(" ", text).strip()


class PhraseCache:
    def __init__(self, root: Path, cache_id: str) -> None:
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", cache_id)
        self.dir = root / safe

    def _path(self, text: str) -> Path:
        return self.dir / (hashlib.sha256(normalize(text).encode("utf-8")).hexdigest() + ".wav")

    @staticmethod
    def cacheable(text: str) -> bool:
        return 0 < len(normalize(text)) <= MAX_CACHED_CHARS

    def get(self, text: str) -> Audio | None:
        if not self.cacheable(text):
            return None
        path = self._path(text)
        try:
            return wav_to_audio(path.read_bytes())
        except FileNotFoundError:
            return None
        except (OSError, SynthesisError, EOFError):
            path.unlink(missing_ok=True)  # corrupt entry: synthesize again
            return None

    def put(self, text: str, audio: Audio) -> None:
        if not self.cacheable(text):
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self._path(text)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_bytes(audio_to_wav(audio))
        os.replace(tmp, path)  # atomic: a reader never sees half a file
