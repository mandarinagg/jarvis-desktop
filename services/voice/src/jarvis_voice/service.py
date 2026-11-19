"""Voice Service entry point: a child process of the Core speaking JSON Lines over stdio (ADR-008).

stdout carries protocol frames only; everything else (logs, stray prints from libraries) goes
to stderr, which the Core forwards to its own redacted log. When stdin closes the Core is gone,
so the service exits instead of lingering as an orphan.

Run with ``uv run python -m jarvis_voice.service`` (Smart App Control blocks the uv launchers).
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections.abc import Callable
from typing import Any, BinaryIO

from . import __version__
from .protocol import MAX_LINE_BYTES, VOICE_PROTOCOL_VERSION, ProtocolError, encode, is_compatible_version, parse_to_voice

Writer = Callable[[dict[str, Any]], None]


def log(level: str, msg: str, **fields: Any) -> None:
    line = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "level": level, "msg": msg, **fields}
    print(json.dumps(line, ensure_ascii=False), file=sys.stderr, flush=True)


class VoiceService:
    """Message handling, independent of the transport so it can be tested in-process."""

    def __init__(self, send: Writer) -> None:
        self._send = send
        self.configured = False
        self.running = True

    def error(self, code: str, message: str, id_: str | None = None) -> None:
        msg: dict[str, Any] = {"type": "voice.error", "code": code, "message": message[:2000]}
        if id_ is not None:
            msg["id"] = id_
        self._send(msg)

    def handle_line(self, line: bytes) -> None:
        try:
            msg = parse_to_voice(line)
        except ProtocolError as exc:
            log("warn", "voice.invalid_message", code=exc.code, detail=str(exc))
            self.error(exc.code, str(exc))
            return
        self.handle(msg)

    def handle(self, msg: dict[str, Any]) -> None:
        kind, id_ = msg["type"], msg["id"]
        if kind == "voice.ping":
            self._send({"type": "voice.pong", "id": id_})
        elif kind == "voice.shutdown":
            log("info", "voice.shutdown")
            self.running = False
        elif kind == "voice.configure":
            if not is_compatible_version(msg["protocolVersion"]):
                self.error("incompatible_version", f"voice protocol {VOICE_PROTOCOL_VERSION} required", id_)
                self.running = False
                return
            self.configured = True
            self._send(
                {"type": "voice.ready", "id": id_, "protocolVersion": VOICE_PROTOCOL_VERSION, "serviceVersion": __version__}
            )


def read_lines(stream: BinaryIO):
    """Yield complete lines; an over-long line is skipped up to its newline (memory guard)."""
    while True:
        line = stream.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES and not line.endswith(b"\n"):
            while (rest := stream.readline(MAX_LINE_BYTES)) and not rest.endswith(b"\n"):
                pass
            yield None
            continue
        stripped = line.strip()
        if stripped:
            yield stripped


def serve(stdin: BinaryIO, stdout: BinaryIO) -> int:
    def send(message: dict[str, Any]) -> None:
        stdout.write(encode(message))
        stdout.flush()

    service = VoiceService(send)
    log("info", "voice.started", version=__version__, pid=os.getpid())
    for line in read_lines(stdin):
        if line is None:
            service.error("invalid_message", f"frame larger than {MAX_LINE_BYTES} bytes")
            continue
        try:
            service.handle_line(line)
        except Exception as exc:  # never die on one bad message; the Core supervises real crashes
            log("error", "voice.handler_failed", error=repr(exc))
            service.error("internal", "unexpected error handling message")
        if not service.running:
            break
    log("info", "voice.stopped")
    return 0


def main() -> int:
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    # Anything printed by libraries must not corrupt the protocol channel.
    sys.stdout = sys.stderr
    return serve(stdin, stdout)


if __name__ == "__main__":
    raise SystemExit(main())
