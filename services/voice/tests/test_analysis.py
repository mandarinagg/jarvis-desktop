import numpy as np
import pytest

from jarvis_voice.diagnostics import analysis as a

SR = 48_000


def sine(amplitude: float, seconds: float = 1.0, freq: float = 440.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return amplitude * np.sin(2 * np.pi * freq * t)


def test_rms_of_full_scale_sine_is_minus_3_dbfs():
    assert a.rms_dbfs(sine(1.0)) == pytest.approx(-3.01, abs=0.05)


def test_peak_and_silence():
    assert a.peak_dbfs(sine(0.5)) == pytest.approx(-6.02, abs=0.05)
    assert a.rms_dbfs(np.zeros(1000)) == a.SILENCE_DBFS
    assert a.rms_dbfs(np.array([])) == a.SILENCE_DBFS


def test_stereo_is_downmixed():
    mono = sine(0.25)
    stereo = np.stack([mono, mono], axis=1)
    assert a.rms_dbfs(stereo) == pytest.approx(a.rms_dbfs(mono))


def test_clipping_ratio():
    x = np.zeros(1000)
    x[:10] = 1.0
    assert a.clipping_ratio(x) == pytest.approx(0.01)


def test_speech_level_ignores_pauses():
    speech = np.concatenate([sine(0.1, 0.5), np.zeros(SR), sine(0.1, 0.5)])
    # Plain RMS is dragged down by the 1 s pause; the percentile-based level is not.
    assert a.speech_level_dbfs(speech, SR) == pytest.approx(a.rms_dbfs(sine(0.1)), abs=0.5)
    assert a.rms_dbfs(speech) < a.speech_level_dbfs(speech, SR) - 2


@pytest.mark.parametrize("delay_ms", [0, 37.5, 120, 410])
def test_estimate_lag_finds_delayed_chirp_in_noise(delay_ms):
    rng = np.random.default_rng(0)
    chirp = a.log_chirp(SR, 0.5, 500, 8000, amplitude=0.3)
    delay = int(SR * delay_ms / 1000)
    rec = rng.normal(0, 0.01, SR * 2)
    rec[delay : delay + chirp.size] += 0.2 * chirp  # attenuated, as through air
    est = a.estimate_lag(chirp, rec)
    assert abs(est.lag_samples - delay) <= 2
    assert est.confidence > 8


def test_estimate_lag_low_confidence_when_absent():
    rng = np.random.default_rng(1)
    chirp = a.log_chirp(SR, 0.5, 500, 8000, amplitude=0.3)
    est = a.estimate_lag(chirp, rng.normal(0, 0.01, SR * 2))
    assert est.confidence < 8


def test_chirp_has_no_click_at_edges():
    c = a.log_chirp(SR, 0.5, 500, 8000, amplitude=0.3)
    assert abs(c[0]) < 1e-3 and abs(c[-1]) < 1e-3
    assert c.dtype == np.float32


@pytest.mark.parametrize(
    ("level", "clip", "expected"),
    [(-50, 0, "muy bajo"), (-35, 0, "bajo"), (-20, 0, "bueno"), (-3, 0, "alto"), (-20, 0.01, "saturado")],
)
def test_classify_speech_level(level, clip, expected):
    assert a.classify_speech_level(level, clip).startswith(expected)


def test_classifiers_thresholds():
    assert a.classify_noise_floor(-65) == "excelente"
    assert a.classify_noise_floor(-35) == "ruidoso"
    assert a.classify_snr(35).startswith("excelente")
    assert a.classify_snr(5).startswith("malo")
