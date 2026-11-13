"""Transcription accuracy metrics: WER and CER with Spanish-aware normalization."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence

_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES = re.compile(r"\s+")


def strip_accents(text: str) -> str:
    """Remove diacritics but keep ñ (it is a different letter in Spanish, not an accent)."""
    text = text.replace("ñ", "\x00").replace("Ñ", "\x01")
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return unicodedata.normalize("NFC", stripped).replace("\x00", "ñ").replace("\x01", "Ñ")


def normalize(text: str, *, keep_accents: bool = True) -> str:
    """Lowercase, drop punctuation (¿?¡!.,), collapse whitespace."""
    t = unicodedata.normalize("NFC", text).lower()
    if not keep_accents:
        t = strip_accents(t)
    t = _PUNCT.sub(" ", t).replace("_", " ")
    return _SPACES.sub(" ", t).strip()


def edit_distance(ref: Sequence[str], hyp: Sequence[str]) -> int:
    """Levenshtein distance between two token sequences."""
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1]


def wer(reference: str, hypothesis: str, *, keep_accents: bool = True) -> float:
    ref = normalize(reference, keep_accents=keep_accents).split()
    hyp = normalize(hypothesis, keep_accents=keep_accents).split()
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def cer(reference: str, hypothesis: str, *, keep_accents: bool = True) -> float:
    ref = normalize(reference, keep_accents=keep_accents).replace(" ", "")
    hyp = normalize(hypothesis, keep_accents=keep_accents).replace(" ", "")
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def corpus_wer(pairs: Sequence[tuple[str, str]], *, keep_accents: bool = True) -> float:
    """Word error rate over a whole corpus (total edits / total reference words)."""
    edits = words = 0
    for ref, hyp in pairs:
        r = normalize(ref, keep_accents=keep_accents).split()
        h = normalize(hyp, keep_accents=keep_accents).split()
        edits += edit_distance(r, h)
        words += len(r)
    return edits / words if words else 0.0
