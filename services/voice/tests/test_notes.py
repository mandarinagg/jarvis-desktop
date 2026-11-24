"""WhatsApp voice notes (ADR-030): Ogg Opus decode/encode, rendering and routing."""

import base64
import io

import numpy as np
import pytest
import soundfile as sf

from jarvis_voice.notes import MAX_PHRASE_BYTES, NoteError, decode_note, encode_note, resample, split_phrases
from jarvis_voice.stt.controller import SttController
from jarvis_voice.tts.engines import Audio, SynthesisError
from jarvis_voice.tts.render import NoteRenderer


def opus(seconds: float, rate: int = 48_000, channels: int = 1) -> bytes:
    t = np.arange(int(seconds * rate)) / rate
    wave = (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    data = np.stack([wave] * channels, axis=1) if channels > 1 else wave
    buf = io.BytesIO()
    sf.write(buf, data, rate, format="OGG", subtype="OPUS")
    return buf.getvalue()


# ------------------------------------------------------------ decode / encode


def test_decode_note_gives_16k_mono():
    samples = decode_note(opus(2.0, channels=2))
    assert samples.dtype == np.float32
    assert abs(len(samples) - 32_000) < 1_000


def test_decode_rejects_long_notes_before_decoding_them():
    with pytest.raises(NoteError, match="too long"):
        decode_note(opus(3.0), max_seconds=2.0)


@pytest.mark.parametrize("data", [b"", b"OggS not really", b"\x00" * 200])
def test_decode_rejects_garbage(data):
    with pytest.raises(NoteError):
        decode_note(data)


def test_encode_note_is_ogg_opus_and_resamples_odd_rates():
    data = encode_note(np.zeros(22_050, dtype=np.float32), 22_050)  # Piper's rate
    info = sf.info(io.BytesIO(data))
    assert data[:4] == b"OggS" and info.subtype == "OPUS" and info.channels == 1
    assert abs(info.duration - 1.0) < 0.05


def test_resample_integer_factor_and_linear():
    assert len(resample(np.ones(48_000, dtype=np.float32), 48_000, 16_000)) == 16_000
    assert len(resample(np.ones(22_050, dtype=np.float32), 22_050, 16_000)) == 16_000
    same = np.ones(10, dtype=np.float32)
    assert resample(same, 16_000, 16_000) is same


def test_split_phrases_packs_sentences_under_the_limit():
    assert split_phrases("Hola. ¿Cómo andás?\n\nListo.") == ["Hola. ¿Cómo andás? Listo."]
    long = " ".join(["Esta es una frase bastante larga para probar el corte."] * 200)
    pieces = split_phrases(long)
    assert len(pieces) > 1
    assert all(len(p.encode("utf-8")) <= MAX_PHRASE_BYTES for p in pieces)
    assert " ".join(pieces).split() == long.split()
    assert split_phrases("   \n ") == []


def test_split_phrases_cuts_a_single_huge_sentence_on_words():
    pieces = split_phrases("palabra " * 2_000)
    assert all(len(p.encode("utf-8")) <= MAX_PHRASE_BYTES for p in pieces)
    assert sum(len(p.split()) for p in pieces) == 2_000


# ------------------------------------------------------------ rendering


class FakeEngine:
    def __init__(self, name="google", fail=0, rate=24_000):
        self.name, self.cache_id, self.fail, self.rate, self.calls = name, name, fail, rate, []

    def synthesize(self, text, timeout):
        self.calls.append(text)
        if self.fail:
            self.fail -= 1
            raise SynthesisError("offline")
        return Audio(np.full(self.rate // 2, 0.1, dtype=np.float32), self.rate)


def render(engine, fallback=None, text="Listo. Quedó agendado."):
    sent = []
    r = NoteRenderer(engine, sent.append, fallback=fallback)
    r.render("r1", text)
    r.wait_idle()
    r.close()
    return sent


def test_render_sends_a_playable_voice_note():
    [msg] = render(FakeEngine())
    assert msg["type"] == "tts.rendered" and msg["id"] == "r1" and msg["engine"] == "google"
    data = base64.b64decode(msg["audio"])
    assert sf.info(io.BytesIO(data)).subtype == "OPUS"
    assert msg["durationMs"] == 500.0


def test_render_joins_phrases_with_a_pause():
    engine = FakeEngine()
    [msg] = render(engine, text=" ".join(["Una frase de relleno para pasar el límite."] * 150))
    assert len(engine.calls) > 1
    assert msg["durationMs"] == pytest.approx(500 * len(engine.calls) + 250 * (len(engine.calls) - 1))


def test_render_retries_then_falls_back_to_piper():
    primary, piper = FakeEngine(fail=2), FakeEngine("piper", rate=22_050)
    [msg] = render(primary, fallback=piper)
    assert msg["type"] == "tts.rendered" and msg["engine"] == "piper"
    assert len(primary.calls) == 2


def test_render_reports_failure_with_the_request_id():
    [msg] = render(FakeEngine(fail=5), fallback=FakeEngine("piper", fail=5))
    assert msg == {"type": "voice.error", "id": "r1", "code": "tts_failed", "message": "no se pudo generar la nota de voz"}


# ------------------------------------------------------------ transcription


class FakeStt:
    def __init__(self):
        self.calls, self.closed = [], False

    def transcribe(self, samples):
        self.calls.append(len(samples))
        return "Jardis, recordame comprar pan"

    def close(self):
        self.closed = True


class NoMic:
    def open(self, on_audio):
        raise AssertionError("a voice note must never open the microphone")

    def close(self):
        pass


def test_voice_note_is_transcribed_without_the_microphone():
    engine, sent = FakeStt(), []
    stt = SttController(lambda: engine, NoMic(), sent.append)
    stt.transcribe_note("n1", opus(1.5))
    stt.wait_idle()
    stt.close()
    [final] = sent
    assert final["type"] == "stt.final" and final["id"] == "n1"
    assert final["text"] == "Jarvis, recordame comprar pan"  # same post-STT corrections
    assert abs(final["audioMs"] - 1500) < 60


def test_unreadable_voice_note_is_reported():
    sent = []
    stt = SttController(FakeStt, NoMic(), sent.append)
    stt.transcribe_note("n1", b"not audio")
    stt.wait_idle()
    stt.close()
    assert sent[0]["type"] == "voice.error" and sent[0]["id"] == "n1" and sent[0]["code"] == "stt_failed"


# ------------------------------------------------------------ service routing


class FakeTts:
    def __init__(self):
        self.rendered = []

    def render(self, id_, text):
        self.rendered.append((id_, text))

    def close(self):
        pass


class FakeController:
    def __init__(self):
        self.notes = []

    def transcribe_note(self, id_, data):
        self.notes.append((id_, data))

    def close(self):
        pass


def test_service_routes_voice_note_messages():
    from jarvis_voice.service import VoiceService

    tts, stt, sent = FakeTts(), FakeController(), []
    svc = VoiceService(sent.append, tts_factory=lambda c, s: tts, stt_factory=lambda c, s: stt)
    svc.handle({"type": "tts.render", "id": "r0", "text": "Hola"})
    svc.handle({"type": "stt.transcribe", "id": "n0", "audio": "T2dnUw=="})
    assert [m["code"] for m in sent] == ["not_configured", "not_configured"]
    sent.clear()
    svc.handle({
        "type": "voice.configure", "id": "c1", "protocolVersion": "1.3",
        "tts": {"engine": "piper", "voice": "v"}, "stt": {"engine": "parakeet"},
    })
    svc.handle({"type": "tts.render", "id": "r1", "text": "Hola"})
    svc.handle({"type": "stt.transcribe", "id": "n1", "audio": "T2dnUw=="})
    assert tts.rendered == [("r1", "Hola")]
    assert stt.notes == [("n1", b"OggS")]
