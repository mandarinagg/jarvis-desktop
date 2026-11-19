"""Post-STT correction of proper nouns and technical terms (ADR-010).

Parakeet takes no vocabulary prompt, so names come out wrong ("Jardis", "piel de Claudio").
Two layers, both conservative:
1. Phrase rules: exact, case-insensitive, word-bounded replacements ("m cp" -> "MCP").
2. Fuzzy vocabulary: a single word close to a known term (same first letter, >= 5 letters,
   similarity >= 0.83) takes the term's spelling ("Jardis" -> "Jarvis").

The owner can extend both in %APPDATA%/Jarvis/stt/vocabulary.txt: a line "wrong => right" adds a
rule, any other line adds a term. That file is data, never instructions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

DEFAULT_RULES: dict[str, str] = {
    "piel de claudio": "API de Claude",
    "a pie de claude": "API de Claude",
    "m cp": "MCP",
    "eme ce pe": "MCP",
    "name pipe": "named pipe",
    "web socket": "websocket",
    "redme": "README",
    "idea bolt": "Idea Vault",
}

DEFAULT_TERMS = (
    "Jarvis",
    "Claude",
    "Anthropic",
    "Electron",
    "Tauri",
    "Vulkan",
    "Radeon",
    "GitHub",
    "Python",
    "TypeScript",
    "Parakeet",
    "Whisper",
)

MIN_FUZZY_LEN = 5
FUZZY_RATIO = 0.83
_WORD = re.compile(r"\w+", re.UNICODE)


@dataclass
class Corrector:
    rules: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_RULES))
    terms: list[str] = field(default_factory=lambda: list(DEFAULT_TERMS))

    def __post_init__(self) -> None:
        self._compile()

    def _compile(self) -> None:
        # Longest first so "piel de claudio" wins over any shorter overlapping rule.
        ordered = sorted(self.rules.items(), key=lambda kv: -len(kv[0]))
        self._rules = [(re.compile(rf"(?<!\w){re.escape(k)}(?!\w)", re.IGNORECASE), v) for k, v in ordered]
        self._terms = {t.lower(): t for t in self.terms}

    @classmethod
    def from_file(cls, path: Path) -> Corrector:
        c = cls()
        if path.exists():
            for raw in path.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=>" in line:
                    wrong, right = (s.strip() for s in line.split("=>", 1))
                    if wrong and right:
                        c.rules[wrong.lower()] = right
                else:
                    c.terms.append(line)
            c._compile()
        return c

    def _fuzzy(self, match: re.Match[str]) -> str:
        word = match.group(0)
        low = word.lower()
        if low in self._terms:
            return self._terms[low]
        if len(word) < MIN_FUZZY_LEN or word.isdigit():
            return word
        best, score = None, 0.0
        for key, term in self._terms.items():
            if key[0] != low[0] or abs(len(key) - len(low)) > 2:
                continue
            ratio = SequenceMatcher(None, low, key).ratio()
            if ratio > score:
                best, score = term, ratio
        return best if best is not None and score >= FUZZY_RATIO else word

    def correct(self, text: str) -> str:
        for pattern, replacement in self._rules:
            text = pattern.sub(replacement, text)
        return _WORD.sub(self._fuzzy, text)
