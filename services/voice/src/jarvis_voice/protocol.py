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

VOICE_PROTOCOL_VERSION = "1.0"
MAX_LINE_BYTES = 1024 * 1024

Check = Callable[[Any], bool]


def _str(min_len: int = 0, max_len: int | None = None) -> Check:
    return lambda v: isinstance(v, str) and len(v) >= min_len and (max_len is None or len(v) <= max_len)


def _enum(*values: str) -> Check:
    return lambda v: isinstance(v, str) and v in values


_ID = _str(1, 64)


@dataclass(frozen=True)
class Schema:
    required: dict[str, Check]
    optional: dict[str, Check]


TO_VOICE: dict[str, Schema] = {
    "voice.configure": Schema({"id": _ID, "protocolVersion": _str(0, 16)}, {}),
    "voice.ping": Schema({"id": _ID}, {}),
    "voice.shutdown": Schema({"id": _ID}, {}),
}

ERROR_CODES = ("invalid_json", "invalid_message", "incompatible_version", "not_configured", "internal")

FROM_VOICE: dict[str, Schema] = {
    "voice.ready": Schema({"id": _ID, "protocolVersion": _str(0, 16), "serviceVersion": _str(0, 32)}, {}),
    "voice.pong": Schema({"id": _ID}, {}),
    "voice.error": Schema({"code": _enum(*ERROR_CODES), "message": _str(0, 2000)}, {"id": _ID}),
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
    allowed = {"type", *schema.required, *schema.optional}
    extra = sorted(set(raw) - allowed)
    if extra:
        raise ProtocolError("invalid_message", f"(root): unrecognized keys {extra}")
    for name, check in schema.required.items():
        if name not in raw or not check(raw[name]):
            raise ProtocolError("invalid_message", f"{name}: invalid or missing")
    for name, check in schema.optional.items():
        if name in raw and not check(raw[name]):
            raise ProtocolError("invalid_message", f"{name}: invalid")
    return raw


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
