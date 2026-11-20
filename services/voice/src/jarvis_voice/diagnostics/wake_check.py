"""Calibrate the wake word threshold (ADR-021) with your own voice and room.

    uv run python -m jarvis_voice.diagnostics.wake_check [--seconds 30] [--threshold 0.5]

Listens to the default microphone and prints, once per second, the highest "hey jarvis" score.
Say "Hey Jarvis" a few times, then talk normally: pick a threshold between the scores of your
wake word and the highest score of normal talk, and set it with JARVIS_WAKE_THRESHOLD.
Nothing is recorded or written to disk: only scores are printed.
"""

from __future__ import annotations

import argparse
import queue
import time

import numpy as np

from ..paths import wake_models
from ..stt.controller import SAMPLE_RATE, SoundDeviceMicrophone
from ..stt.wake import WakeWordDetector


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args(argv)

    models = wake_models()
    if not (models / "hey_jarvis_v0.1.onnx").exists():
        print(f"Faltan los modelos en {models}: corré `uv run jarvis-stt-bench setup`.")
        return 1
    det = WakeWordDetector.from_dir(models, threshold=2.0)  # never "fires": we want raw scores
    audio: queue.Queue[np.ndarray] = queue.Queue()
    mic = SoundDeviceMicrophone()
    mic.open(audio.put)
    print(f"Escuchando {args.seconds:.0f} s. Decí «Hey Jarvis» varias veces y después hablá normal.")
    peaks: list[float] = []
    try:
        end = time.monotonic() + args.seconds
        second = np.zeros(0, dtype=np.float32)
        while time.monotonic() < end:
            second = np.concatenate([second, audio.get(timeout=2)])
            if len(second) < SAMPLE_RATE:
                continue
            best = 0.0
            for i in range(0, len(second), 1_280):
                det.push(second[i : i + 1_280])
                best = max(best, det.last_score)
            second = np.zeros(0, dtype=np.float32)
            peaks.append(best)
            bar = "#" * round(best * 40)
            mark = "  <- activaría" if best >= args.threshold else ""
            print(f"{len(peaks):3d}s  {best:0.3f}  {bar}{mark}")
    finally:
        mic.close()
    hits = sum(p >= args.threshold for p in peaks)
    print(f"\nSegundos por encima de {args.threshold}: {hits}. Máximo: {max(peaks, default=0):.3f}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
