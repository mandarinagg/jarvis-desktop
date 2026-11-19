import wave

import numpy as np
import pytest

from jarvis_voice.stt.controller import SAMPLE_RATE, SttController
from jarvis_voice.stt.vad import FRAME, FRAME_MS, SpeechGate
from test_stt import FakeEngine, FakeMic

# ---------------------------------------------------------------- gate


def run_gate(gate, probs):
    return [e for p in probs if (e := gate.push(p))]


def test_gate_needs_sustained_speech_to_start():
    gate = SpeechGate(start_ms=250)
    frames = int(250 // FRAME_MS)  # 7 frames = 224 ms: not enough
    assert run_gate(gate, [0.9] * frames + [0.1]) == []
    assert run_gate(gate, [0.9] * (frames + 1)) == ["start"]


def test_gate_ends_after_silence_and_ignores_short_pauses():
    gate = SpeechGate(start_ms=64, end_ms=700)
    assert run_gate(gate, [0.9, 0.9]) == ["start"]
    assert run_gate(gate, [0.1] * 10 + [0.9]) == []  # 320 ms pause: still talking
    assert run_gate(gate, [0.1] * 21 + [0.1]) == ["end"]
    assert not gate.speaking


def test_gate_hysteresis_between_thresholds_keeps_talking():
    gate = SpeechGate(start_ms=32, end_ms=96)
    assert run_gate(gate, [0.9]) == ["start"]
    assert run_gate(gate, [0.4] * 20) == []  # between 0.35 and 0.5: not silence


# ---------------------------------------------------------------- controller


class FakeVad:
    """Speech when the frame is loud: lets tests drive the VAD with the mic's amplitude."""

    def __init__(self):
        self.resets = 0

    def reset(self):
        self.resets += 1

    def prob(self, frame):
        assert len(frame) == FRAME
        return 0.95 if float(np.abs(frame).mean()) > 0.05 else 0.0


def feed(mic, seconds, level):
    for _ in range(int(seconds * 50)):
        cb = mic.on_audio
        if cb is None:
            return
        cb(np.full(SAMPLE_RATE // 50, level, dtype=np.float32))


def make(vad=None, **kw):
    sent = []
    engine, mic = FakeEngine("che, pará"), FakeMic()
    stt = SttController(lambda: engine, mic, sent.append, load_vad=(lambda: vad or FakeVad()), **kw)
    return stt, mic, engine, sent


def test_armed_vad_reports_speech_records_it_and_transcribes_after_silence():
    stt, mic, engine, sent = make()
    stt.arm("b1")
    assert sent == [{"type": "stt.listening", "id": "b1", "open": True}]
    feed(mic, 1.0, 0.0)  # Jarvis talking in the headphones, owner silent
    feed(mic, 1.0, 0.2)  # owner talks over him
    feed(mic, 1.0, 0.0)  # and stops
    stt.wait_idle()
    types = [m["type"] for m in sent]
    assert types == ["stt.listening", "vad.speech", "stt.listening", "stt.final"]
    assert sent[2] == {"type": "stt.listening", "id": "b1", "open": False}
    assert sent[3]["id"] == "b1" and sent[3]["text"] == "che, pará"
    # pre-roll (~0.5 s) + speech (1 s) + trailing silence until the gate closed (~0.7 s)
    audio = engine.calls[-1] / SAMPLE_RATE
    assert 1.8 <= audio <= 2.4
    assert mic.on_audio is None and mic.closes == 1
    stt.close()


def test_disarm_while_watching_closes_the_mic_without_transcribing():
    stt, mic, engine, sent = make()
    stt.arm("b1")
    feed(mic, 0.5, 0.0)
    stt.disarm("b1")
    stt.wait_idle()
    assert [m["type"] for m in sent] == ["stt.listening", "stt.listening"]
    assert engine.calls == [SAMPLE_RATE] and mic.on_audio is None  # warm-up only


def test_disarm_after_speech_started_lets_the_utterance_finish():
    stt, mic, _, sent = make()
    stt.arm("b1")
    feed(mic, 0.5, 0.2)
    stt.wait_idle()  # the VAD has seen the speech
    stt.disarm("b1")  # e.g. Jarvis finished his phrase just as the owner started talking
    feed(mic, 1.0, 0.0)
    stt.wait_idle()
    assert [m["type"] for m in sent] == ["stt.listening", "vad.speech", "stt.listening", "stt.final"]


def test_short_noise_does_not_trigger():
    stt, mic, _, sent = make()
    stt.arm("b1")
    for _ in range(5):
        feed(mic, 0.1, 0.2)  # 100 ms clicks
        feed(mic, 0.2, 0.0)
    stt.wait_idle()
    assert [m["type"] for m in sent] == ["stt.listening"]
    stt.disarm("b1")


def test_push_to_talk_stop_ends_a_vad_utterance_early():
    stt, mic, _, sent = make()
    stt.arm("b1")
    feed(mic, 0.5, 0.2)
    stt.wait_idle()
    stt.stop("b1")
    stt.wait_idle()
    assert [m["type"] for m in sent] == ["stt.listening", "vad.speech", "stt.listening", "stt.final"]


def test_arm_is_ignored_during_push_to_talk_and_start_replaces_watching():
    stt, mic, _, sent = make()
    stt.start("u1")
    stt.arm("b1")
    assert [m["id"] for m in sent] == ["u1"]
    stt.cancel("u1")
    stt.arm("b2")
    stt.start("u2")  # push-to-talk wins over the VAD
    feed(mic, 0.5, 0.2)
    stt.stop("u2")
    stt.wait_idle()
    assert [(m["type"], m["id"]) for m in sent][-3:] == [("stt.listening", "u2"), ("stt.listening", "u2"), ("stt.final", "u2")]
    assert not any(m["type"] == "vad.speech" for m in sent)


def test_missing_vad_model_is_reported_once_per_arm():
    sent = []

    def broken():
        raise FileNotFoundError("silero_vad.onnx")

    stt = SttController(lambda: FakeEngine(), FakeMic(), sent.append, load_vad=broken)
    stt.arm("b1")
    stt.arm("b2")
    assert [(m["type"], m["code"]) for m in sent] == [("voice.error", "not_configured")] * 2


# ---------------------------------------------------------------- real Silero (local only)


def _real():
    from jarvis_voice.paths import jarvis_home, vad_model

    session = sorted((jarvis_home() / "benchmarks" / "stt").glob("session-*"))
    return vad_model(), (session[-1] / "01.wav") if session else None


@pytest.mark.skipif(not all(p is not None and p.exists() for p in _real()), reason="needs silero_vad.onnx and a bench recording")
def test_real_silero_tells_speech_from_silence():
    from jarvis_voice.stt.vad import SileroVad

    model, wav = _real()
    with wave.open(str(wav)) as w:
        assert w.getframerate() == SAMPLE_RATE
        pcm = np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768
    vad = SileroVad(model)
    gate = SpeechGate()
    events = [e for i in range(0, len(pcm) - FRAME, FRAME) if (e := gate.push(vad.prob(pcm[i : i + FRAME])))]
    assert events and events[0] == "start"
    vad.reset()
    assert max(vad.prob(np.zeros(FRAME, dtype=np.float32)) for _ in range(30)) < 0.2
