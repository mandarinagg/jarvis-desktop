"""Core <-> Voice Service contract (ADR-008, ADR-013): JSON Lines over this process's stdio.

Mirror of ``packages/shared/src/voice-protocol.ts``. Both sides are tested against the same
fixtures (``packages/shared/fixtures/voice-protocol.json``). Messages are strict: unknown or
missing fields are rejected, exactly like ``z.strictObject``.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

VOICE_PROTOCOL_VERSION = "1.3"
MAX_LINE_BYTES = 1024 * 1024

Check = Callable[[Any], bool]


def _str(min_len: int = 0, max_len: int | None = None) -> Check:
    return lambda v: isinstance(v, str) and len(v) >= min_len and (max_len is None or len(v) <= max_len)


def _enum(*values: str) -> Check:
    return lambda v: isinstance(v, str) and v in values


def _int(min_v: int, max_v: int) -> Check:
    # bool is a subclass of int in Python; JSON true must not pass as 1.
    return lambda v: isinstance(v, int) and not isinstance(v, bool) and min_v <= v <= max_v


def _bool(v: Any) -> bool:
    return isinstance(v, bool)


def _nonneg_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0


_ID = _str(1, 64)
_SEQ = _int(0, 10_000)


MAX_NOTE_BYTES = 600 * 1024  # ADR-030: largest voice note, before base64
MAX_RENDER_CHARS = 4_000
_B64 = re.compile(r"[A-Za-z0-9+/]+={0,2}")


def _note_audio(v: Any) -> bool:
    return isinstance(v, str) and 4 <= len(v) <= -(-MAX_NOTE_BYTES // 3) * 4 and _B64.fullmatch(v) is not None


def _unit(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1


@dataclass(frozen=True)
class Schema:
    required: dict[str, Check]
    optional: dict[str, Check]


def _object(schema: Schema) -> Check:
    def check(v: Any) -> bool:
        try:
            _check_fields(v, schema)
        except ProtocolError:
            return False
        return True

    return check


TTS_CONFIG = Schema(
    {"engine": _enum("google", "piper"), "voice": _str(1, 64)},
    {"googleApiKey": _str(1, 256)},
)

STT_CONFIG = Schema({"engine": _enum("parakeet")}, {})

TO_VOICE: dict[str, Schema] = {
    "voice.configure": Schema(
        {"id": _ID, "protocolVersion": _str(0, 16)},
        {"tts": _object(TTS_CONFIG), "stt": _object(STT_CONFIG)},
    ),
    "voice.ping": Schema({"id": _ID}, {}),
    "voice.shutdown": Schema({"id": _ID}, {}),
    "tts.speak": Schema({"id": _ID, "turnId": _ID, "seq": _SEQ, "text": _str(1, 2000), "final": _bool}, {}),
    "tts.cancel": Schema({"id": _ID, "turnId": _ID}, {}),
    "tts.end": Schema({"id": _ID, "turnId": _ID}, {}),
    "stt.start": Schema({"id": _ID}, {}),
    "stt.stop": Schema({"id": _ID}, {}),
    "stt.cancel": Schema({"id": _ID}, {}),
    "vad.arm": Schema({"id": _ID}, {}),
    "vad.disarm": Schema({"id": _ID}, {}),
    "wake.enable": Schema({"id": _ID}, {"threshold": _unit}),
    "wake.disable": Schema({"id": _ID}, {}),
    "stt.transcribe": Schema({"id": _ID, "audio": _note_audio}, {}),
    "tts.render": Schema({"id": _ID, "text": _str(1, MAX_RENDER_CHARS)}, {}),
}

ERROR_CODES = ("invalid_json", "invalid_message", "incompatible_version", "not_configured", "tts_failed", "stt_failed", "internal")

FROM_VOICE: dict[str, Schema] = {
    "voice.ready": Schema({"id": _ID, "protocolVersion": _str(0, 16), "serviceVersion": _str(0, 32)}, {}),
    "voice.pong": Schema({"id": _ID}, {}),
    "tts.rendered": Schema(
        {"id": _ID, "audio": _note_audio, "durationMs": _nonneg_number, "engine": _enum("google", "piper")}, {}
    ),
    "voice.error": Schema({"code": _enum(*ERROR_CODES), "message": _str(0, 2000)}, {"id": _ID}),
    "tts.started": Schema(
        {"turnId": _ID, "seq": _SEQ, "engine": _enum("google", "piper", "cache"), "latencyMs": _nonneg_number}, {}
    ),
    "tts.finished": Schema({"turnId": _ID, "interrupted": _bool}, {}),
    "stt.listening": Schema({"id": _ID, "open": _bool}, {}),
    "vad.speech": Schema({"id": _ID}, {}),
    "wake.listening": Schema({"id": _ID, "open": _bool}, {}),
    "wake.detected": Schema({"id": _ID, "score": _unit}, {}),
    "stt.final": Schema({"id": _ID, "text": _str(0, 8000), "audioMs": _nonneg_number, "sttMs": _nonneg_number}, {}),
}


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def validate(raw: Any, schemas: dict[str, Schema]) -> dict[str, Any]:
    """Return the message if it matches its schema, else raise ProtocolError("invalid_message")."""
    if not isinstance(raw, dict):
        raise ProtocolError("invalid_message", "(root): expected object")
    kind = raw.get("type")
    schema = schemas.get(kind) if isinstance(kind, str) else None
    if schema is None:
        raise ProtocolError("invalid_message", "type: unknown message type")
    _check_fields(raw, schema, extra_allowed={"type"})
    return raw


def _check_fields(raw: Any, schema: Schema, extra_allowed: set[str] | frozenset[str] = frozenset()) -> None:
    if not isinstance(raw, dict):
        raise ProtocolError("invalid_message", "(root): expected object")
    allowed = {*extra_allowed, *schema.required, *schema.optional}
    extra = sorted(set(raw) - allowed)
    if extra:
        raise ProtocolError("invalid_message", f"(root): unrecognized keys {extra}")
    for name, check in schema.required.items():
        if name not in raw or not check(raw[name]):
            raise ProtocolError("invalid_message", f"{name}: invalid or missing")
    for name, check in schema.optional.items():
        if name in raw and not check(raw[name]):
            raise ProtocolError("invalid_message", f"{name}: invalid")


def parse_line(line: str | bytes, schemas: dict[str, Schema]) -> dict[str, Any]:
    try:
        raw = json.loads(line)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ProtocolError("invalid_json", "line is not valid JSON") from exc
    return validate(raw, schemas)


def parse_to_voice(line: str | bytes) -> dict[str, Any]:
    return parse_line(line, TO_VOICE)


def parse_from_voice(line: str | bytes) -> dict[str, Any]:
    return parse_line(line, FROM_VOICE)


def encode(message: dict[str, Any]) -> bytes:
    """Validate an outgoing message and frame it as one UTF-8 JSON line."""
    validate(message, FROM_VOICE)
    data = (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(data) > MAX_LINE_BYTES:
        raise ProtocolError("internal", f"frame too large: {len(data)} bytes")
    return data


_MAJOR = re.compile(r"^(\d+)\.\d+$")


def is_compatible_version(peer: str, ours: str = VOICE_PROTOCOL_VERSION) -> bool:
    a, b = _MAJOR.match(peer), _MAJOR.match(ours)
    return bool(a and b and a.group(1) == b.group(1))
