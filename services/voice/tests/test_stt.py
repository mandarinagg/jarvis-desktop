import threading
import wave

import numpy as np
import pytest

from jarvis_voice.diagnostics import text_metrics as tm
from jarvis_voice.stt.controller import SAMPLE_RATE, SttController
from jarvis_voice.stt.corrections import Corrector

# ---------------------------------------------------------------- corrections

# Real Parakeet errors from the Phase 0 benchmark (synthetic phrases, owner's voice not stored).
BENCH = [
    ("Jarvis, ¿qué tengo en la agenda para hoy?", "Jardis, ¿qué tengo en la agenda para hoy?"),
    ("¿Cuánto gasté en la API de Claude esta semana?", "¿Cuánto gasté en la piel de Claudio esta semana?"),
    ("Explicame en dos minutos qué es el protocolo MCP.", "Explícame en dos minutos que es el protocolo M Cp."),
    ("¿Cuál es la diferencia entre un named pipe y un websocket?", "¿Cuál es la diferencia entre un name pipe y un web socket pipe?"),
    ("Leé el archivo README del repositorio jarvis desktop.", "Lee el archivo Redme del repositorio Jarvis Desktop."),
    ("Anotá en el idea vault: probar whisper con Vulkan en la Radeon.", "Anotaba en el Idea Bolt probar whisper con Vulcan en la Radion."),
    ("Mandale un mensaje a Martín diciéndole que llego quince minutos tarde.", "Mandale un mensaje a Martín diciéndole que llevo quince minutos tarde."),
    ("Bajá el volumen un poco y hablá más despacio, por favor.", "Baja el volumen un poco y habla más despacio, por favor."),
]


@pytest.mark.parametrize(
    ("raw", "fixed"),
    [
        ("Jardis, ¿qué tengo hoy?", "Jarvis, ¿qué tengo hoy?"),
        ("gasté en la piel de Claudio", "gasté en la API de Claude"),
        ("el protocolo M Cp.", "el protocolo MCP."),
        ("con Vulcan en la Radion", "con Vulkan en la Radeon"),
        ("abrí el Redme", "abrí el README"),
    ],
)
def test_known_errors_are_fixed(raw, fixed):
    assert Corrector().correct(raw) == fixed


@pytest.mark.parametrize(
    "text",
    [
        "Mandale un mensaje a Martín.",
        "Llamá a Claudia mañana.",  # a real name close to "Claude" must survive
        "Tengo una idea para una app de paseadores.",
        "El jueves a las siete y media.",
        "Pedí doscientos cincuenta pesos.",
    ],
)
def test_normal_speech_is_left_alone(text):
    assert Corrector().correct(text) == text


def test_corrections_lower_corpus_wer_on_the_benchmark():
    before = tm.corpus_wer(BENCH, keep_accents=False)
    after = tm.corpus_wer([(ref, Corrector().correct(hyp)) for ref, hyp in BENCH], keep_accents=False)
    assert after < before * 0.75


def test_vocabulary_file_adds_rules_and_terms(tmp_path):
    f = tmp_path / "vocabulary.txt"
    f.write_text("# mis términos\nidea bault => Idea Vault\nMarmolejo\n", encoding="utf-8")
    c = Corrector.from_file(f)
    assert c.correct("en el idea bault") == "en el Idea Vault"
    assert c.correct("señor Marmolejos") == "señor Marmolejo"
    assert Corrector.from_file(tmp_path / "missing.txt").correct("Jardis") == "Jarvis"


# ---------------------------------------------------------------- controller


class FakeMic:
    def __init__(self, fail=False):
        self.fail, self.on_audio, self.opens, self.closes = fail, None, 0, 0

    def open(self, on_audio):
        if self.fail:
            raise OSError("no device")
        self.opens += 1
        self.on_audio = on_audio

    def close(self):
        self.closes += 1
        self.on_audio = None

    def speak(self, seconds):
        for _ in range(int(seconds * 50)):
            cb = self.on_audio
            if cb is None:  # closed meanwhile (e.g. the 60 s cap)
                return
            cb(np.full(SAMPLE_RATE // 50, 0.1, dtype=np.float32))


class FakeEngine:
    def __init__(self, text="Jardis, ¿qué tengo hoy?"):
        self.text, self.calls, self.closed = text, [], False

    def transcribe(self, samples):
        self.calls.append(len(samples))
        return self.text

    def close(self):
        self.closed = True


def make(engine=None, mic=None, load_gate=None, **kw):
    sent = []
    engine = engine or FakeEngine()

    def load():
        if load_gate:
            load_gate.wait(2)
        return engine

    mic = mic or FakeMic()
    return SttController(load, mic, sent.append, **kw), mic, engine, sent


def test_push_to_talk_round_trip():
    stt, mic, engine, sent = make()
    stt.start("u1")
    mic.speak(1.0)
    stt.stop("u1")
    stt.wait_idle()
    assert sent[0] == {"type": "stt.listening", "id": "u1", "open": True}
    assert sent[1] == {"type": "stt.listening", "id": "u1", "open": False}
    final = sent[2]
    assert final["type"] == "stt.final" and final["text"] == "Jarvis, ¿qué tengo hoy?"
    assert final["audioMs"] == 1000.0 and final["sttMs"] >= 0
    assert engine.calls == [SAMPLE_RATE, SAMPLE_RATE] and mic.closes == 1  # warm-up + utterance
    stt.close()
    assert engine.closed


def test_mic_is_closed_between_utterances_and_cancel_discards():
    stt, mic, engine, sent = make()
    stt.start("u1")
    mic.speak(1.0)
    stt.cancel("u1")
    stt.wait_idle()
    assert [m["type"] for m in sent] == ["stt.listening", "stt.listening"]
    assert engine.calls == [SAMPLE_RATE] and mic.on_audio is None  # warm-up only


def test_new_start_cancels_the_previous_utterance():
    stt, mic, engine, sent = make()
    stt.start("u1")
    mic.speak(0.5)
    stt.start("u2")
    mic.speak(0.5)
    stt.stop("u2")
    stt.wait_idle()
    assert [(m["type"], m["id"]) for m in sent] == [
        ("stt.listening", "u1"),
        ("stt.listening", "u1"),
        ("stt.listening", "u2"),
        ("stt.listening", "u2"),
        ("stt.final", "u2"),
    ]
    assert engine.calls[1:] == [SAMPLE_RATE // 2]


def test_stop_for_another_id_is_ignored():
    stt, mic, _, sent = make()
    stt.start("u1")
    stt.stop("other")
    assert mic.on_audio is not None and len(sent) == 1


def test_key_bounce_yields_empty_text_without_running_the_model():
    stt, mic, engine, sent = make()
    stt.start("u1")
    mic.speak(0.1)
    stt.stop("u1")
    stt.wait_idle()
    assert sent[-1]["text"] == "" and engine.calls == [SAMPLE_RATE]


def test_recording_is_capped():
    stt, mic, engine, sent = make(max_seconds=1.0)
    stt.start("u1")
    mic.speak(1.5)
    for _ in range(200):  # the cap stops on a helper thread
        if any(m["type"] == "stt.final" for m in sent):
            break
        threading.Event().wait(0.01)
    stt.wait_idle()
    assert sent[-1]["type"] == "stt.final"
    assert engine.calls[-1] <= int(1.02 * SAMPLE_RATE)


def test_transcription_waits_for_the_model_to_load():
    gate = threading.Event()
    stt, mic, engine, sent = make(load_gate=gate)
    stt.start("u1")
    mic.speak(0.5)
    stt.stop("u1")
    assert all(m["type"] != "stt.final" for m in sent)
    gate.set()
    stt.wait_idle()
    assert sent[-1]["type"] == "stt.final"


def test_mic_failure_is_reported():
    stt, _, _, sent = make(mic=FakeMic(fail=True))
    stt.start("u1")
    assert sent == [{"type": "voice.error", "id": "u1", "code": "stt_failed", "message": "no se pudo abrir el micrófono"}]


def test_engine_load_failure_is_reported_per_utterance():
    sent = []

    def broken():
        raise FileNotFoundError("no dll")

    mic = FakeMic()
    stt = SttController(broken, mic, sent.append)
    stt.start("u1")
    mic.speak(0.5)
    stt.stop("u1")
    stt.wait_idle()
    assert sent[-1]["code"] == "stt_failed"


# ---------------------------------------------------------------- real engine (local only)


def _real_paths():
    from jarvis_voice.paths import jarvis_home, parakeet_model, stt_bin_dir

    session = sorted((jarvis_home() / "benchmarks" / "stt").glob("session-*"))
    return stt_bin_dir(), parakeet_model(), (session[-1] / "01.wav") if session else None


@pytest.mark.skipif(
    not all(p is not None and p.exists() for p in _real_paths()), reason="needs parakeet.dll, the model and a bench recording"
)
def test_real_parakeet_in_process():
    from jarvis_voice.stt.parakeet import ParakeetEngine

    bin_dir, model, wav = _real_paths()
    with wave.open(str(wav)) as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768
    engine = ParakeetEngine(bin_dir, model)
    try:
        text = engine.transcribe(pcm)
        assert len(text) > 5
        assert engine.transcribe(np.zeros(0, dtype=np.float32)) == ""
    finally:
        engine.close()
