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
    assert out == [{"type": "voice.ready", "id": "c1", "protocolVersion": "1.0", "serviceVersion": __version__}]


def test_incompatible_version_errors_and_stops():
    code, out = run(
        line({"type": "voice.configure", "id": "c1", "protocolVersion": "2.0"}),
        line({"type": "voice.ping", "id": "p1"}),
    )
    assert code == 0
    assert out == [{"type": "voice.error", "id": "c1", "code": "incompatible_version", "message": "voice protocol 1.0 required"}]


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
