import numpy as np
import pytest

from jarvis_voice.paths import wake_models
from jarvis_voice.stt.controller import SAMPLE_RATE, SttController
from jarvis_voice.stt.wake import CHUNK, WakeWordDetector
from test_stt import FakeEngine, FakeMic
from test_vad import FakeVad, feed

# ---------------------------------------------------------------- detector pipeline


class FakeSession:
    """Stands in for an onnxruntime session; records the shapes it was fed."""

    def __init__(self, fn):
        self.fn, self.shapes = fn, []

    def run(self, _outputs, feed):
        (x,) = feed.values()
        self.shapes.append(x.shape)
        return [self.fn(x)]


def fake_detector(score_of_embeddings, threshold=0.5, cooldown_s=2.0):
    mel = FakeSession(lambda x: np.full((1, 1, 8, 32), float(np.abs(x).mean()), dtype=np.float32))
    emb = FakeSession(lambda w: np.full((1, 1, 1, 96), float(w[0, -1, 0, 0]), dtype=np.float32))
    wake = FakeSession(lambda f: np.array([[score_of_embeddings(f)]], dtype=np.float32))
    return WakeWordDetector(mel, emb, wake, threshold=threshold, cooldown_s=cooldown_s), (mel, emb, wake)


def loud(seconds, level=0.5):
    return np.full(int(seconds * SAMPLE_RATE), level, dtype=np.float32)


def test_pipeline_shapes_and_warmup():
    det, (mel, emb, wake) = fake_detector(lambda f: 0.0)
    det.push(loud(CHUNK * 15 / SAMPLE_RATE))
    assert wake.shapes == []  # 15 embeddings: not enough to score yet (needs 16 = 1.28 s)
    det.push(loud(CHUNK / SAMPLE_RATE))
    assert mel.shapes[0] == (1, CHUNK + 480)
    assert emb.shapes[0] == (1, 76, 32, 1)
    assert wake.shapes == [(1, 16, 96)]


def test_fires_once_then_cools_down_and_clears():
    # score = how loud the last embedding was: loud audio "says hey jarvis"
    det, _ = fake_detector(lambda f: 0.9 if f[0, -1, 0] > 2.0 else 0.0, cooldown_s=1.0)
    assert det.push(loud(2.0, 0.0)) is None
    hit = det.push(loud(0.4))
    assert hit == pytest.approx(0.9)
    assert det.push(loud(0.4)) is None  # same utterance: cooldown + cleared features
    assert det.push(loud(2.0, 0.0)) is None


def test_int16_scale_reaches_the_models():
    det, (mel, _, _) = fake_detector(lambda f: 0.0)
    seen = []
    mel.fn = lambda x: (seen.append(float(np.abs(x).max())), np.zeros((1, 1, 8, 32), np.float32))[1]
    det.push(loud(CHUNK / SAMPLE_RATE, 1.0))
    assert seen[0] == pytest.approx(32_767.0)


@pytest.mark.skipif(not (wake_models() / "hey_jarvis_v0.1.onnx").exists(), reason="openWakeWord models not installed")
def test_real_models_stay_quiet_on_silence_and_noise():
    det = WakeWordDetector.from_dir(wake_models())
    rng = np.random.default_rng(1)
    assert det.push(np.zeros(SAMPLE_RATE * 3, dtype=np.float32)) is None
    assert det.push((rng.standard_normal(SAMPLE_RATE * 3) * 0.05).astype(np.float32)) is None


# ---------------------------------------------------------------- controller


class FakeWake:
    """Fires when it hears loud audio; records resets so tests see when buffers are cleared."""

    def __init__(self):
        self.threshold, self.resets, self.heard, self.fired = 0.5, 0, 0, False

    def reset(self):
        self.resets += 1
        self.fired = False

    def push(self, audio):
        self.heard += len(audio)
        if self.fired or float(np.abs(audio).mean()) <= 0.3:
            return None
        self.fired = True  # like the real detector's cooldown
        return 0.8


def make(wake=None, mic=None):
    sent = []
    mic = mic or FakeMic()
    detector = wake or FakeWake()
    stt = SttController(lambda: FakeEngine("qué hora es"), mic, sent.append, load_vad=FakeVad, load_wake=lambda: detector)
    return stt, mic, detector, sent


def test_wake_keeps_mic_open_reports_detection_and_resumes_after_capture():
    stt, mic, det, sent = make()
    stt.wake_enable("w1", 0.6)
    assert det.threshold == 0.6
    assert sent == [{"type": "wake.listening", "id": "w1", "open": True}]
    feed(mic, 0.5, 0.0)
    feed(mic, 0.1, 0.5)  # "hey jarvis"
    stt.wait_idle()
    assert sent[-1] == {"type": "wake.detected", "id": "w1", "score": 0.8}

    # The Core arms the VAD to record the command: same open mic, no second open.
    stt.arm("u1")
    feed(mic, 0.6, 0.2)
    feed(mic, 1.0, 0.0)
    stt.wait_idle()
    assert [m["type"] for m in sent[2:]] == ["stt.listening", "vad.speech", "stt.listening", "stt.final"]
    assert mic.opens == 1 and mic.closes == 0  # still listening for the wake word
    heard_before = det.heard
    feed(mic, 0.2, 0.0)
    stt.wait_idle()
    assert det.heard > heard_before  # back to the detector
    assert det.resets >= 2  # cleared on enable and after the capture

    stt.wake_disable("w2")
    assert mic.closes == 1
    assert sent[-1] == {"type": "wake.listening", "id": "w2", "open": False}
    stt.close()


def test_capture_audio_never_reaches_the_detector():
    stt, mic, det, sent = make()
    stt.wake_enable("w1")
    stt.start("u1")
    heard = det.heard
    mic.speak(0.5)
    stt.stop("u1")
    stt.wait_idle()
    assert det.heard == heard
    assert not any(m["type"] == "wake.detected" for m in sent)
    stt.close()


def test_without_models_wake_is_not_configured():
    sent = []
    stt = SttController(lambda: FakeEngine(""), FakeMic(), sent.append, load_wake=lambda: (_ for _ in ()).throw(FileNotFoundError("x")))
    stt.wake_enable("w1")
    assert sent == [{"type": "voice.error", "id": "w1", "code": "not_configured", "message": "la palabra de activación no está disponible"}]
    stt.close()


def test_mic_failure_turns_wake_off():
    sent = []
    stt = SttController(lambda: FakeEngine(""), FakeMic(fail=True), sent.append, load_wake=FakeWake)
    stt.wake_enable("w1")
    assert sent[-1]["code"] == "stt_failed"
    stt.close()
