"""WhatsApp voice notes (ADR-030): Ogg Opus in and out, in memory only.

Decoding and encoding go through ``soundfile`` (libsndfile ships inside the wheel, no ffmpeg).
Nothing here touches the disk: notes arrive and leave as bytes over the protocol channel.
"""

from __future__ import annotations

import io
import re

import numpy as np

STT_RATE = 16_000
MAX_NOTE_SECONDS = 120.0
# Opus only encodes these rates; anything else is resampled to 24 kHz (Neural2's own rate).
OPUS_RATES = (8_000, 12_000, 16_000, 24_000, 48_000)
# Google's request limit is 5000 bytes; phrases are kept well under it.
MAX_PHRASE_BYTES = 4_500


class NoteError(ValueError):
    """The note can't be used: not Ogg Opus, empty, or longer than allowed."""


def resample(samples: np.ndarray, src: int, dst: int) -> np.ndarray:
    """Mono float32. Integer down-factors average blocks (a crude low-pass); otherwise linear."""
    if src == dst or len(samples) == 0:
        return samples.astype(np.float32, copy=False)
    if src > dst and src % dst == 0:
        factor = src // dst
        usable = len(samples) - len(samples) % factor
        return samples[:usable].reshape(-1, factor).mean(axis=1).astype(np.float32)
    n = max(1, round(len(samples) * dst / src))
    positions = np.linspace(0, len(samples) - 1, n)
    return np.interp(positions, np.arange(len(samples)), samples).astype(np.float32)


def decode_note(data: bytes, max_seconds: float = MAX_NOTE_SECONDS) -> np.ndarray:
    """Ogg Opus (or any format libsndfile reads) -> float32 mono at 16 kHz for Parakeet."""
    import soundfile as sf

    try:
        info = sf.info(io.BytesIO(data))
        if info.duration > max_seconds:
            raise NoteError(f"note too long: {info.duration:.0f} s")
        samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except NoteError:
        raise
    except Exception as exc:  # sf.LibsndfileError, RuntimeError on garbage
        raise NoteError(f"unreadable note: {type(exc).__name__}") from exc
    if samples.size == 0:
        raise NoteError("empty note")
    mono = samples.mean(axis=1) if samples.shape[1] > 1 else samples[:, 0]
    return resample(mono, int(rate), STT_RATE)


def encode_note(samples: np.ndarray, rate: int) -> bytes:
    """float32 mono -> Ogg Opus bytes, as WhatsApp plays voice notes."""
    import soundfile as sf

    if rate not in OPUS_RATES:
        samples, rate = resample(samples, rate, 24_000), 24_000
    buf = io.BytesIO()
    sf.write(buf, np.clip(samples, -1.0, 1.0).astype(np.float32), rate, format="OGG", subtype="OPUS")
    return buf.getvalue()


_SENTENCE_END = re.compile(r"(?<=[.!?…:;])\s+|\n+")


def split_phrases(text: str, max_bytes: int = MAX_PHRASE_BYTES) -> list[str]:
    """Sentence-sized pieces, each under the engine's request limit (UTF-8 bytes)."""
    pieces: list[str] = []
    current = ""
    for sentence in (s.strip() for s in _SENTENCE_END.split(text)):
        if not sentence:
            continue
        candidate = f"{current} {sentence}".strip()
        if len(candidate.encode("utf-8")) <= max_bytes:
            current = candidate
            continue
        if current:
            pieces.append(current)
        # A single sentence over the limit is cut on words.
        while len(sentence.encode("utf-8")) > max_bytes:
            cut = sentence.rfind(" ", 0, max_bytes // 4)
            cut = cut if cut > 0 else max_bytes // 4
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        current = sentence
    if current:
        pieces.append(current)
    return pieces
