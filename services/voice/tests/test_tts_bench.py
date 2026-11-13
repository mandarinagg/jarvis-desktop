import io
import random
import wave

import numpy as np
import pytest

from jarvis_voice.diagnostics import tts_bench as tb


def test_leading_silence_counts_samples_until_first_audible_one():
    sr = 1000
    audio = np.concatenate([np.zeros(250, dtype="float32"), np.full(100, 0.5, dtype="float32")])
    assert tb.leading_silence_ms(audio, sr) == pytest.approx(250.0)


def test_leading_silence_of_all_silent_or_empty_audio_is_its_full_length():
    assert tb.leading_silence_ms(np.zeros(500, dtype="float32"), 1000) == pytest.approx(500.0)
    assert tb.leading_silence_ms(np.zeros(0, dtype="float32"), 1000) == 0.0


def test_pcm16_bytes_to_float_roundtrip():
    pcm = np.array([0, 16384, -32768, 32767], dtype="<i2").tobytes()
    out = tb.pcm16_to_float(pcm)
    assert out.dtype == np.float32
    assert out.tolist() == pytest.approx([0.0, 0.5, -1.0, 32767 / 32768])


def test_wav_bytes_to_float_strips_the_header():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(np.array([16384, -16384], dtype="<i2").tobytes())
    samples, sr = tb.wav_to_float(buf.getvalue())
    assert sr == 24000
    assert samples.tolist() == pytest.approx([0.5, -0.5])


def sample(ttfa, total, audio_s, silence=0.0, chars=10):
    return tb.PhraseResult(
        index=1, text="x" * chars, ttfa_ms=ttfa, total_ms=total, audio_s=audio_s, leading_silence_ms=silence
    )


def test_summarize_engine_computes_percentiles_rtf_and_perceived_latency():
    spec = tb.EngineSpec("e", "local", "MIT", usd_per_million_chars=0.0)
    results = [sample(100, 200, 2.0, silence=50), sample(300, 400, 4.0, silence=50), sample(200, 300, 3.0, silence=50)]
    s = tb.summarize_engine(spec, results, failures=1)
    assert s.ttfa_p50_ms == pytest.approx(200)
    assert s.perceived_p50_ms == pytest.approx(250)  # first chunk + its leading silence
    assert s.total_p50_ms == pytest.approx(300)
    assert s.rtf_p50 == pytest.approx(0.1)
    assert s.failures == 1 and s.phrases == 4


def test_summarize_engine_without_successes_has_no_metrics():
    spec = tb.EngineSpec("e", "nube", "x", usd_per_million_chars=30.0)
    s = tb.summarize_engine(spec, [], failures=3)
    assert s.ttfa_p50_ms is None and s.phrases == 3


def test_monthly_cost_is_linear_in_chars_and_zero_for_local_engines():
    cloud = tb.EngineSpec("c", "nube", "x", usd_per_million_chars=30.0)
    local = tb.EngineSpec("l", "local", "MIT", usd_per_million_chars=0.0)
    assert tb.monthly_cost_usd(cloud, chars_per_day=10_000) == pytest.approx(9.0)  # 300k chars * $30/M
    assert tb.monthly_cost_usd(local, chars_per_day=10_000) == 0.0


def test_blind_plan_shuffles_engines_per_phrase_and_hides_names():
    plan = tb.blind_plan(["a", "b", "c"], phrase_indices=[1, 2], rng=random.Random(7))
    assert [p.phrase_index for p in plan] == [1, 1, 1, 2, 2, 2]
    for idx in (1, 2):
        rows = [p for p in plan if p.phrase_index == idx]
        assert sorted(r.engine for r in rows) == ["a", "b", "c"]
        assert [r.label for r in rows] == ["A", "B", "C"]


def test_blind_plan_is_not_always_in_the_given_order():
    orders = {
        tuple(p.engine for p in tb.blind_plan(["a", "b", "c", "d"], [1], random.Random(seed))) for seed in range(20)
    }
    assert len(orders) > 1


def test_summarize_ratings_averages_per_engine_and_sorts_best_first():
    ratings = [
        {"engine": "a", "score": 3},
        {"engine": "b", "score": 5},
        {"engine": "a", "score": 4},
        {"engine": "b", "score": 4},
    ]
    assert tb.summarize_ratings(ratings) == [("b", 4.5, 2), ("a", 3.5, 2)]


def test_every_registered_engine_has_license_kind_and_cost():
    for spec in tb.ENGINES.values():
        assert spec.kind in {"nube", "local"}
        assert spec.license
        assert spec.usd_per_million_chars >= 0
        assert (spec.kind == "local") == (spec.usd_per_million_chars == 0)


def test_markdown_table_lists_each_engine_with_cost():
    spec = tb.ENGINES["piper-daniela-ar"]
    s = tb.summarize_engine(spec, [sample(100, 200, 2.0)], failures=0)
    table = tb.markdown_table([s], chars_per_day=10_000)
    assert "piper-daniela-ar" in table
    assert "gratis" in table
