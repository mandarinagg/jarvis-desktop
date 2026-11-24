"""Voice Service entry point: a child process of the Core speaking JSON Lines over stdio (ADR-008).

stdout carries protocol frames only; everything else (logs, stray prints from libraries) goes
to stderr, which the Core forwards to its own redacted log. When stdin closes the Core is gone,
so the service exits instead of lingering as an orphan.

Run with ``uv run python -m jarvis_voice.service`` (Smart App Control blocks the uv launchers).
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import sys
import threading
import time
from collections.abc import Callable
from typing import Any, BinaryIO

from . import __version__
from .protocol import MAX_LINE_BYTES, VOICE_PROTOCOL_VERSION, ProtocolError, encode, is_compatible_version, parse_to_voice
from .stt.controller import SttController
from .tts.pipeline import TtsPipeline

Writer = Callable[[dict[str, Any]], None]
TtsFactory = Callable[[dict[str, Any], Writer], TtsPipeline]
SttFactory = Callable[[dict[str, Any], Writer], SttController]


def log(level: str, msg: str, **fields: Any) -> None:
    line = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "level": level, "msg": msg, **fields}
    print(json.dumps(line, ensure_ascii=False), file=sys.stderr, flush=True)


class VoiceService:
    """Message handling, independent of the transport so it can be tested in-process."""

    def __init__(self, send: Writer, tts_factory: TtsFactory | None = None, stt_factory: SttFactory | None = None) -> None:
        self._send = send
        self._tts_factory = tts_factory or build_tts
        self._stt_factory = stt_factory or build_stt
        self.tts: TtsPipeline | None = None
        self.stt: SttController | None = None
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
        elif kind in ("tts.speak", "tts.cancel", "tts.end", "tts.render"):
            if self.tts is None:
                self.error("not_configured", "TTS is not configured", id_)
            elif kind == "tts.render":
                self.tts.render(id_, msg["text"])
            elif kind == "tts.speak":
                self.tts.speak(msg)
            elif kind == "tts.end":
                self.tts.end(msg["turnId"])
            else:
                self.tts.cancel(msg["turnId"])
        elif kind in ("stt.start", "stt.stop", "stt.cancel", "vad.arm", "vad.disarm", "wake.enable", "wake.disable", "stt.transcribe"):
            if self.stt is None:
                self.error("not_configured", "STT is not configured", id_)
            elif kind == "stt.transcribe":
                try:
                    data = base64.b64decode(msg["audio"], validate=True)
                except (binascii.Error, ValueError):
                    self.error("invalid_message", "audio: invalid base64", id_)
                    return
                self.stt.transcribe_note(id_, data)
            elif kind == "stt.start":
                self.stt.start(id_)
            elif kind == "vad.arm":
                self.stt.arm(id_)
            elif kind == "vad.disarm":
                self.stt.disarm(id_)
            elif kind == "wake.enable":
                self.stt.wake_enable(id_, msg.get("threshold"))
            elif kind == "wake.disable":
                self.stt.wake_disable(id_)
            elif kind == "stt.stop":
                self.stt.stop(id_)
            else:
                self.stt.cancel(id_)
        elif kind == "voice.configure":
            if not is_compatible_version(msg["protocolVersion"]):
                self.error("incompatible_version", f"voice protocol {VOICE_PROTOCOL_VERSION} required", id_)
                self.running = False
                return
            self.close()
            if "stt" in msg:
                try:
                    self.stt = self._stt_factory(msg["stt"], self._send)
                except Exception as exc:
                    log("error", "voice.stt_unavailable", error=repr(exc))
                    self.error("stt_failed", f"STT unavailable: {type(exc).__name__}", id_)
            if "tts" in msg:
                try:
                    self.tts = self._tts_factory(msg["tts"], self._send)
                except Exception as exc:  # missing model, bad audio device: voice stays text-less
                    log("error", "voice.tts_unavailable", error=repr(exc))
                    self.error("tts_failed", f"TTS unavailable: {type(exc).__name__}", id_)
            self.configured = True
            self._send(
                {"type": "voice.ready", "id": id_, "protocolVersion": VOICE_PROTOCOL_VERSION, "serviceVersion": __version__}
            )


    def close(self) -> None:
        if self.stt is not None:
            self.stt.close()
            self.stt = None
        if self.tts is not None:
            self.tts.close()
            self.tts = None


def build_stt(_config: dict[str, Any], send: Writer) -> SttController:
    """Parakeet loads in the background (~1 s with Vulkan); stt.start works meanwhile."""
    from .paths import parakeet_model, stt_bin_dir, stt_vocabulary, vad_model, wake_models
    from .stt.controller import SoundDeviceMicrophone
    from .stt.corrections import Corrector
    from .stt.parakeet import ParakeetEngine
    from .stt.vad import SileroVad
    from .stt.wake import WakeWordDetector

    bin_dir, model = stt_bin_dir(), parakeet_model()
    if not (bin_dir / "parakeet.dll").exists() or not model.exists():
        raise FileNotFoundError("parakeet.dll or the Parakeet model is missing: run jarvis-stt-bench setup")
    return SttController(
        lambda: ParakeetEngine(bin_dir, model),
        SoundDeviceMicrophone(),
        send,
        corrector=Corrector.from_file(stt_vocabulary()),
        log=log,
        load_vad=lambda: SileroVad(vad_model()),  # loaded on the first vad.arm; no model = no barge-in by voice
        load_wake=lambda: WakeWordDetector.from_dir(wake_models()),  # on the first wake.enable; no models = no wake word
    )


def build_tts(config: dict[str, Any], send: Writer) -> TtsPipeline:
    """Real engines: Google Neural2 when there is a key, Piper as fallback (or as primary offline)."""
    from .paths import piper_model, tts_cache_dir
    from .tts.cache import ACKNOWLEDGEMENTS, PhraseCache
    from .tts.engines import GoogleEngine, PiperEngine
    from .tts.player import Player

    model = piper_model()
    piper = PiperEngine(model) if model.exists() else None
    key = config.get("googleApiKey")
    if config["engine"] == "google" and key:
        primary = GoogleEngine(key, config["voice"])
        fallback = piper
    else:
        if piper is None:
            raise FileNotFoundError(f"Piper model not found: {model}")
        primary, fallback = piper, None
    pipeline = TtsPipeline(
        primary,
        Player(),
        send,
        cache=PhraseCache(tts_cache_dir(), primary.cache_id),
        fallback=fallback,
        log=log,
    )
    pipeline.prewarm(ACKNOWLEDGEMENTS)
    log("info", "voice.tts_ready", engine=primary.name, voice=config["voice"], fallback=bool(fallback))
    return pipeline


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
    lock = threading.Lock()  # TTS threads send events too

    def send(message: dict[str, Any]) -> None:
        data = encode(message)
        with lock:
            stdout.write(data)
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
    service.close()
    log("info", "voice.stopped")
    return 0


def main() -> int:
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    # Anything printed by libraries must not corrupt the protocol channel.
    sys.stdout = sys.stderr
    return serve(stdin, stdout)


if __name__ == "__main__":
    raise SystemExit(main())
