import subprocess
import threading
import types

import numpy as np
import pytest

from jarvis_voice.tts import engines as eng
from jarvis_voice.tts.cache import PhraseCache, normalize
from jarvis_voice.tts.engines import Audio, SynthesisError
from jarvis_voice.tts.pipeline import TtsPipeline
from jarvis_voice.tts.player import Clip, Mixer, resample


def tone(n: int = 100, rate: int = 24_000, value: float = 0.5) -> Audio:
    return Audio(np.full(n, value, dtype="float32"), rate)


# ---------------------------------------------------------------- engines


def test_wav_roundtrip():
    a = Audio(np.array([0.0, 0.5, -0.5, 0.25], dtype="float32"), 22_050)
    b = eng.wav_to_audio(eng.audio_to_wav(a))
    assert b.sample_rate == 22_050
    assert np.allclose(a.samples, b.samples, atol=1e-4)


def piper_model(tmp_path):
    model = tmp_path / "voice.onnx"
    model.write_bytes(b"x")
    (tmp_path / "voice.onnx.json").write_text('{"audio": {"sample_rate": 22050}}', encoding="utf-8")
    return model


def test_piper_runs_as_separate_process(tmp_path):
    model = piper_model(tmp_path)
    calls = []
    pcm = (np.array([0, 16384, -16384], dtype="<i2")).tobytes() + b"\x00"  # odd trailing byte is dropped

    def runner(cmd, **kw):
        calls.append((cmd, kw))
        return subprocess.CompletedProcess(cmd, 0, pcm, b"")

    audio = eng.PiperEngine(model, runner).synthesize("Hola.", timeout=3)
    cmd, kw = calls[0]
    assert cmd[1:] == ["-m", "piper", "-m", str(model), "--output-raw"]
    assert kw["input"] == "Hola.".encode() and kw["timeout"] == 3
    assert audio.sample_rate == 22_050
    assert audio.samples.tolist() == [0.0, 0.5, -0.5]


def test_piper_failures_become_synthesis_errors(tmp_path):
    model = piper_model(tmp_path)

    def boom(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 1)

    with pytest.raises(SynthesisError):
        eng.PiperEngine(model, boom).synthesize("x", 1)
    bad = lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, b"", b"model error")  # noqa: E731
    with pytest.raises(SynthesisError, match="model error"):
        eng.PiperEngine(model, bad).synthesize("x", 1)


def test_piper_requires_model_and_config(tmp_path):
    with pytest.raises(FileNotFoundError):
        eng.PiperEngine(tmp_path / "missing.onnx")
    (tmp_path / "only.onnx").write_bytes(b"x")
    with pytest.raises(FileNotFoundError):
        eng.PiperEngine(tmp_path / "only.onnx")


class FakeGoogleClient:
    def __init__(self, fail: Exception | None = None):
        self.fail, self.calls = fail, []

    def synthesize_speech(self, **kw):
        self.calls.append(kw)
        if self.fail:
            raise self.fail
        return types.SimpleNamespace(audio_content=eng.audio_to_wav(tone(48)))


def test_google_passes_voice_and_deadline():
    client = FakeGoogleClient()
    audio = eng.GoogleEngine("key", "es-US-Neural2-B", client=client).synthesize("Hola.", timeout=2.5)
    call = client.calls[0]
    assert call["timeout"] == 2.5
    assert call["voice"].name == "es-US-Neural2-B" and call["voice"].language_code == "es-US"
    assert audio.sample_rate == 24_000 and len(audio.samples) == 48


def test_google_errors_never_carry_the_key():
    client = FakeGoogleClient(fail=RuntimeError("bad key AIzaSECRET"))
    with pytest.raises(SynthesisError) as exc:
        eng.GoogleEngine("AIzaSECRET", client=client).synthesize("x", 1)
    assert "AIza" not in str(exc.value)


# ---------------------------------------------------------------- cache


def test_cache_roundtrip_and_limits(tmp_path):
    cache = PhraseCache(tmp_path, "google-es-US-Neural2-B")
    assert cache.get("Listo.") is None
    cache.put("Listo.", tone(20))
    hit = cache.get("  Listo. ")
    assert hit is not None and len(hit.samples) == 20
    long = "x" * 81
    cache.put(long, tone(5))
    assert cache.get(long) is None
    assert normalize("a \n  b") == "a b"


def test_cache_separates_voices_and_drops_corrupt_files(tmp_path):
    a, b = PhraseCache(tmp_path, "google-A"), PhraseCache(tmp_path, "piper-B")
    a.put("Hola.", tone(10))
    assert b.get("Hola.") is None
    for f in a.dir.glob("*.wav"):
        f.write_bytes(b"garbage")
    assert a.get("Hola.") is None
    assert not list(a.dir.glob("*.wav"))


# ---------------------------------------------------------------- mixer


def test_resample_changes_length():
    assert len(resample(tone(22_050, 22_050))) == 24_000
    assert len(resample(tone(10))) == 10


def test_mixer_plays_clips_back_to_back_and_fires_events_in_order():
    m, seen = Mixer(sample_rate=1000), []
    m.enqueue(Clip(np.ones(3, dtype="float32"), lambda: seen.append("a+"), lambda: seen.append("a-")))
    m.enqueue(Clip(np.full(3, 2.0, dtype="float32"), lambda: seen.append("b+")))
    m.enqueue(Clip(np.zeros(0, dtype="float32"), lambda: seen.append("end")))
    out, events = m.read(4)
    assert out.tolist() == [1, 1, 1, 2]
    for e in events:
        e()
    out, events = m.read(4)
    assert out.tolist() == [2, 2, 0, 0]
    for e in events:
        e()
    assert seen == ["a+", "a-", "b+", "end"]
    assert not m.busy


def test_mixer_cancel_fades_out_within_30ms_and_drops_the_rest():
    m = Mixer(sample_rate=1000, fade_ms=30)
    fired = []
    m.enqueue(Clip(np.ones(1000, dtype="float32")))
    m.enqueue(Clip(np.ones(10, dtype="float32"), lambda: fired.append("next")))
    m.read(10)
    m.cancel()
    out, events = m.read(100)
    assert out[0] == pytest.approx(1.0)
    assert np.all(np.diff(out[:30]) <= 0)  # monotonic fade
    assert np.all(out[30:] == 0)
    assert events == [] and fired == []
    assert not m.busy


def test_cancel_before_playback_starts_is_silent():
    m = Mixer(sample_rate=1000)
    m.enqueue(Clip(np.ones(10, dtype="float32")))
    m.cancel()
    out, _ = m.read(10)
    assert np.all(out == 0)


# ---------------------------------------------------------------- pipeline


class FakeEngine:
    def __init__(self, name="google", failures=0, delay: threading.Event | None = None):
        self.name, self.cache_id = name, f"{name}-v"
        self.failures, self.delay, self.calls = failures, delay, []

    def synthesize(self, text, timeout):
        self.calls.append((text, timeout))
        if self.delay:
            self.delay.wait(2)
        if self.failures:
            self.failures -= 1
            raise SynthesisError("down")
        return tone(10)


class FakePlayer:
    """Plays instantly when `drain()` is called, in enqueue order, like the Mixer."""

    def __init__(self):
        self.queue, self.cancels, self.closed = [], 0, False

    def play(self, audio, on_start=None):
        self.queue.append(on_start)

    def mark(self, on_reached):
        self.queue.append(on_reached)

    def cancel(self):
        self.cancels += 1
        self.queue.clear()

    def close(self):
        self.closed = True

    def drain(self):
        while self.queue:
            cb = self.queue.pop(0)
            if cb:
                cb()


def make(engine=None, fallback=None, cache=None):
    sent, player = [], FakePlayer()
    t = iter(range(0, 10_000, 100))
    p = TtsPipeline(engine or FakeEngine(), player, sent.append, cache=cache, fallback=fallback, clock=lambda: next(t) / 1000)
    return p, player, sent


def speak(p, seq, text, final=False, turn="t1"):
    p.speak({"type": "tts.speak", "id": f"s{seq}", "turnId": turn, "seq": seq, "text": text, "final": final})


def test_pipeline_speaks_phrases_in_order_and_finishes_the_turn():
    p, player, sent = make()
    speak(p, 0, "Hola.")
    speak(p, 1, "Chau.", final=True)
    p.wait_idle()
    player.drain()
    assert [m["type"] for m in sent] == ["tts.started", "tts.started", "tts.finished"]
    assert [m.get("seq") for m in sent[:2]] == [0, 1]
    assert sent[0]["engine"] == "google" and sent[0]["latencyMs"] > 0
    assert sent[-1] == {"type": "tts.finished", "turnId": "t1", "interrupted": False}
    p.close()
    assert player.closed


def test_pipeline_retries_once_then_uses_the_fallback():
    primary, fallback = FakeEngine(failures=2), FakeEngine("piper")
    p, player, sent = make(primary, fallback)
    speak(p, 0, "Hola.", final=True)
    p.wait_idle()
    player.drain()
    assert len(primary.calls) == 2 and primary.calls[0][1] == 2.5
    assert len(fallback.calls) == 1
    assert sent[0]["engine"] == "piper"


def test_pipeline_reports_a_phrase_that_nobody_could_synthesize():
    p, player, sent = make(FakeEngine(failures=5), FakeEngine("piper", failures=5))
    speak(p, 0, "Hola.", final=True)
    p.wait_idle()
    player.drain()
    assert sent[0] == {"type": "voice.error", "id": "s0", "code": "tts_failed", "message": "no se pudo sintetizar la frase"}
    assert sent[-1]["type"] == "tts.finished"  # the turn still ends


def test_pipeline_uses_and_fills_the_cache(tmp_path):
    cache = PhraseCache(tmp_path, "google-v")
    engine = FakeEngine()
    p, player, sent = make(engine, cache=cache)
    speak(p, 0, "Listo.", final=True)
    p.wait_idle()
    speak(p, 0, "Listo.", final=True, turn="t2")
    p.wait_idle()
    player.drain()
    assert len(engine.calls) == 1
    assert [m["engine"] for m in sent if m["type"] == "tts.started"] == ["google", "cache"]


def test_cancel_drops_pending_phrases_and_reports_interrupted():
    gate = threading.Event()
    engine = FakeEngine(delay=gate)
    p, player, sent = make(engine)
    speak(p, 0, "Uno.")
    speak(p, 1, "Dos.")
    speak(p, 2, "Tres.", final=True)
    p.cancel("t1")
    gate.set()
    p.wait_idle()
    player.drain()
    assert sent == [{"type": "tts.finished", "turnId": "t1", "interrupted": True}]
    assert player.cancels == 1
    assert len(engine.calls) <= 1  # only the phrase already in synthesis
    speak(p, 3, "Tarde.")  # late phrases of a cancelled turn are ignored
    p.wait_idle()
    p.cancel("t1")  # idempotent
    assert len(sent) == 1 and player.cancels == 1


def test_prewarm_fills_cache_and_stops_when_offline(tmp_path):
    cache = PhraseCache(tmp_path, "google-v")
    p, _, _ = make(FakeEngine(), cache=cache)
    p.prewarm(["Dale.", "Listo."]).join(2)
    assert cache.get("Dale.") is not None and cache.get("Listo.") is not None
    offline = FakeEngine(failures=10)
    p2, _, _ = make(offline, cache=PhraseCache(tmp_path, "other"))
    p2.prewarm(["a", "b", "c"]).join(2)
    assert len(offline.calls) == 1
