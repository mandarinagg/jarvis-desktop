import io
import json

from jarvis_voice import __version__
from jarvis_voice.protocol import MAX_LINE_BYTES
from jarvis_voice.service import serve


def run(*lines: bytes) -> tuple[int, list[dict]]:
    out = io.BytesIO()
    code = serve(io.BytesIO(b"".join(lines)), out)
    return code, [json.loads(ln) for ln in out.getvalue().splitlines()]


def line(msg: dict) -> bytes:
    return (json.dumps(msg) + "\n").encode()


def test_configure_replies_ready():
    code, out = run(line({"type": "voice.configure", "id": "c1", "protocolVersion": "1.0"}))
    assert code == 0
    assert out == [{"type": "voice.ready", "id": "c1", "protocolVersion": "1.2", "serviceVersion": __version__}]


def test_incompatible_version_errors_and_stops():
    code, out = run(
        line({"type": "voice.configure", "id": "c1", "protocolVersion": "2.0"}),
        line({"type": "voice.ping", "id": "p1"}),
    )
    assert code == 0
    assert out == [{"type": "voice.error", "id": "c1", "code": "incompatible_version", "message": "voice protocol 1.2 required"}]


def test_ping_pong_and_shutdown_stops_reading():
    _, out = run(
        line({"type": "voice.ping", "id": "p1"}),
        line({"type": "voice.shutdown", "id": "s1"}),
        line({"type": "voice.ping", "id": "p2"}),
    )
    assert out == [{"type": "voice.pong", "id": "p1"}]


def test_bad_lines_are_reported_without_dying():
    _, out = run(b"{nope\n", b"\r\n", line({"type": "voice.ping"}), line({"type": "voice.ping", "id": "p1"}))
    assert [m.get("code") for m in out] == ["invalid_json", "invalid_message", None]
    assert out[-1] == {"type": "voice.pong", "id": "p1"}


def test_oversized_frame_is_skipped():
    big = b'{"type":"voice.ping","id":"' + b"x" * (MAX_LINE_BYTES + 10) + b'"}\n'
    _, out = run(big, line({"type": "voice.ping", "id": "p1"}))
    assert out[0]["code"] == "invalid_message"
    assert out[1] == {"type": "voice.pong", "id": "p1"}


def test_stdin_eof_exits_cleanly():
    assert run() == (0, [])


class FakeTts:
    def __init__(self):
        self.spoken, self.cancelled, self.closed = [], [], False

    def speak(self, msg):
        self.spoken.append(msg["text"])

    def cancel(self, turn_id):
        self.cancelled.append(turn_id)

    def close(self):
        self.closed = True


def test_tts_messages_need_tts_configured():
    _, out = run(
        line({"type": "voice.configure", "id": "c1", "protocolVersion": "1.0"}),
        line({"type": "tts.speak", "id": "s1", "turnId": "t", "seq": 0, "text": "Hola.", "final": True}),
    )
    assert out[1] == {"type": "voice.error", "id": "s1", "code": "not_configured", "message": "TTS is not configured"}


def test_tts_messages_are_routed_to_the_pipeline():
    from jarvis_voice.service import VoiceService

    fake, configs, sent = FakeTts(), [], []

    def factory(cfg, send):
        configs.append(cfg)
        return fake

    svc = VoiceService(sent.append, tts_factory=factory)
    tts = {"engine": "google", "voice": "es-US-Neural2-B", "googleApiKey": "k"}
    svc.handle({"type": "voice.configure", "id": "c1", "protocolVersion": "1.0", "tts": tts})
    svc.handle({"type": "tts.speak", "id": "s1", "turnId": "t", "seq": 0, "text": "Hola.", "final": False})
    svc.handle({"type": "tts.cancel", "id": "x1", "turnId": "t"})
    svc.close()
    assert configs == [tts]
    assert fake.spoken == ["Hola."] and fake.cancelled == ["t"] and fake.closed
    assert sent[0]["type"] == "voice.ready"


def test_tts_factory_failure_keeps_the_service_up():
    from jarvis_voice.service import VoiceService

    def factory(cfg, send):
        raise FileNotFoundError("no model")

    sent = []
    svc = VoiceService(sent.append, tts_factory=factory)
    svc.handle({"type": "voice.configure", "id": "c1", "protocolVersion": "1.0", "tts": {"engine": "piper", "voice": "v"}})
    assert [m["type"] for m in sent] == ["voice.error", "voice.ready"]
    assert sent[0]["code"] == "tts_failed" and svc.tts is None


class FakeStt:
    def __init__(self):
        self.calls, self.closed = [], False

    def start(self, i):
        self.calls.append(("start", i))

    def stop(self, i):
        self.calls.append(("stop", i))

    def cancel(self, i):
        self.calls.append(("cancel", i))

    def close(self):
        self.closed = True


def test_stt_messages_are_routed_and_need_configuration():
    from jarvis_voice.service import VoiceService

    fake, sent = FakeStt(), []
    svc = VoiceService(sent.append, stt_factory=lambda cfg, send: fake)
    svc.handle({"type": "stt.start", "id": "u0"})
    assert sent[0]["code"] == "not_configured"
    svc.handle({"type": "voice.configure", "id": "c1", "protocolVersion": "1.0", "stt": {"engine": "parakeet"}})
    for kind in ("stt.start", "stt.stop", "stt.cancel"):
        svc.handle({"type": kind, "id": "u1"})
    svc.close()
    assert fake.calls == [("start", "u1"), ("stop", "u1"), ("cancel", "u1")] and fake.closed
