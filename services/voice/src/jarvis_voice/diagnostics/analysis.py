"""Pure signal-analysis helpers (no audio I/O, fully unit-testable)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SILENCE_DBFS = -120.0
CLIP_THRESHOLD = 0.999


def to_mono(signal: np.ndarray) -> np.ndarray:
    """Return a float64 mono view of a (frames,) or (frames, channels) signal."""
    x = np.asarray(signal, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    return x


def dbfs(value: float) -> float:
    """Convert a linear amplitude (1.0 = full scale) to dBFS."""
    if value <= 0:
        return SILENCE_DBFS
    return max(SILENCE_DBFS, 20.0 * float(np.log10(value)))


def rms_dbfs(signal: np.ndarray) -> float:
    x = to_mono(signal)
    if x.size == 0:
        return SILENCE_DBFS
    return dbfs(float(np.sqrt(np.mean(x**2))))


def peak_dbfs(signal: np.ndarray) -> float:
    x = np.asarray(signal, dtype=np.float64)
    if x.size == 0:
        return SILENCE_DBFS
    return dbfs(float(np.max(np.abs(x))))


def clipping_ratio(signal: np.ndarray, threshold: float = CLIP_THRESHOLD) -> float:
    """Fraction of samples (any channel) at or above the clipping threshold."""
    x = np.asarray(signal, dtype=np.float64)
    if x.size == 0:
        return 0.0
    return float(np.mean(np.abs(x) >= threshold))


def frame_rms_dbfs(signal: np.ndarray, sample_rate: int, frame_ms: float = 20.0) -> np.ndarray:
    """RMS level in dBFS for consecutive non-overlapping frames."""
    x = to_mono(signal)
    n = max(1, int(sample_rate * frame_ms / 1000))
    usable = (x.size // n) * n
    if usable == 0:
        return np.array([rms_dbfs(x)])
    frames = x[:usable].reshape(-1, n)
    rms = np.sqrt(np.mean(frames**2, axis=1))
    with np.errstate(divide="ignore"):
        levels = 20.0 * np.log10(rms)
    return np.maximum(levels, SILENCE_DBFS)


def speech_level_dbfs(signal: np.ndarray, sample_rate: int) -> float:
    """Level of the loud part of a recording (90th percentile of 20 ms frames).

    Robust to the pauses people naturally leave while reading a sentence.
    """
    return float(np.percentile(frame_rms_dbfs(signal, sample_rate), 90))


def log_chirp(sample_rate: int, duration_s: float, f0: float, f1: float, amplitude: float) -> np.ndarray:
    """Exponential sine sweep, with 5 ms fades to avoid clicks."""
    t = np.arange(int(sample_rate * duration_s)) / sample_rate
    k = np.log(f1 / f0)
    phase = 2 * np.pi * f0 * duration_s / k * (np.exp(t * k / duration_s) - 1)
    sweep = amplitude * np.sin(phase)
    fade = min(sweep.size // 2, int(sample_rate * 0.005))
    if fade:
        ramp = np.linspace(0.0, 1.0, fade)
        sweep[:fade] *= ramp
        sweep[-fade:] *= ramp[::-1]
    return sweep.astype(np.float32)


@dataclass(frozen=True)
class LagEstimate:
    lag_samples: int
    confidence: float  # correlation peak / median absolute correlation


def estimate_lag(reference: np.ndarray, recording: np.ndarray) -> LagEstimate:
    """Find where `reference` starts inside `recording` via FFT cross-correlation."""
    ref = to_mono(reference)
    rec = to_mono(recording)
    n = ref.size + rec.size - 1
    size = 1 << (n - 1).bit_length()
    corr = np.fft.irfft(np.fft.rfft(rec, size) * np.conj(np.fft.rfft(ref, size)), size)
    corr = np.abs(corr[: rec.size])  # only non-negative lags make physical sense
    lag = int(np.argmax(corr))
    floor = float(np.median(corr)) or 1e-12
    return LagEstimate(lag_samples=lag, confidence=float(corr[lag] / floor))


def classify_noise_floor(level_dbfs: float) -> str:
    if level_dbfs <= -60:
        return "excelente"
    if level_dbfs <= -50:
        return "bueno"
    if level_dbfs <= -40:
        return "aceptable"
    return "ruidoso"


def classify_speech_level(level_dbfs: float, clip_ratio: float) -> str:
    if clip_ratio > 0.001:
        return "saturado: bajá la ganancia del micrófono"
    if level_dbfs < -40:
        return "muy bajo: subí la ganancia o acercate al micrófono"
    if level_dbfs < -30:
        return "bajo"
    if level_dbfs <= -6:
        return "bueno"
    return "alto: riesgo de saturación"


def classify_snr(snr_db: float) -> str:
    if snr_db >= 30:
        return "excelente para STT"
    if snr_db >= 20:
        return "bueno para STT"
    if snr_db >= 10:
        return "justo: el STT va a cometer errores"
    return "malo: STT poco confiable"
