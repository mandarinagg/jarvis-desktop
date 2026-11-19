import json
from pathlib import Path

import pytest

from jarvis_voice import protocol as p

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[3] / "packages/shared/fixtures/voice-protocol.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("msg", FIXTURES["toVoice"]["valid"])
def test_accepts_core_to_voice(msg):
    assert p.parse_to_voice(json.dumps(msg)) == msg


@pytest.mark.parametrize("msg", FIXTURES["toVoice"]["invalid"])
def test_rejects_core_to_voice(msg):
    with pytest.raises(p.ProtocolError) as exc:
        p.parse_to_voice(json.dumps(msg))
    assert exc.value.code == "invalid_message"


@pytest.mark.parametrize("msg", FIXTURES["fromVoice"]["valid"])
def test_accepts_voice_to_core(msg):
    assert p.parse_from_voice(json.dumps(msg)) == msg


@pytest.mark.parametrize("msg", FIXTURES["fromVoice"]["invalid"])
def test_rejects_voice_to_core(msg):
    with pytest.raises(p.ProtocolError):
        p.parse_from_voice(json.dumps(msg))


def test_invalid_json():
    with pytest.raises(p.ProtocolError) as exc:
        p.parse_to_voice(b"{nope")
    assert exc.value.code == "invalid_json"


def test_encode_refuses_invalid_outgoing_message():
    with pytest.raises(p.ProtocolError):
        p.encode({"type": "voice.pong"})


def test_encode_is_one_utf8_line():
    data = p.encode({"type": "voice.error", "code": "internal", "message": "acción"})
    assert data.endswith(b"\n") and data.count(b"\n") == 1
    assert "acción" in data.decode("utf-8")


@pytest.mark.parametrize(("peer", "ok"), [("1.0", True), ("1.7", True), ("2.0", False), ("1", False), ("x", False)])
def test_version_compatibility(peer, ok):
    assert p.is_compatible_version(peer) is ok
