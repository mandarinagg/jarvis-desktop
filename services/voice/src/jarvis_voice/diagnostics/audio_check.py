"""Phase 0 microphone / speaker diagnostic.

Measures: output works, noise floor, speech level, clipping, SNR and acoustic
round-trip latency (speaker -> mic). Never persists audio; only writes a JSON
report to %APPDATA%/Jarvis/diagnostics/.

Usage:
    uv run jarvis-audio-check --list
    uv run jarvis-audio-check [--input N] [--output N] [--host-api NAME] [--skip-latency]
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import sounddevice as sd

from . import analysis as a

SAMPLE_RATE = 48_000
NOISE_SECONDS = 5.0
SPEECH_SECONDS = 7.0
LATENCY_RUNS = 3
CHIRP_LEAD_S = 0.3
CHIRP_SECONDS = 0.5
MIN_LAG_CONFIDENCE = 8.0
VIRTUAL_HINTS = ("voicemod", "nahimic", "virtual", "cable", "stereo mix", "mezcla estéreo", "vb-audio")
PREFERRED_HOST_API = "Windows WASAPI"
TEST_SENTENCE = "Jarvis, abrí el proyecto de la tienda y decime qué tareas quedaron pendientes desde el martes."


@dataclass
class Report:
    timestamp: str
    platform: str
    host_api: str
    input_device: str
    output_device: str
    sample_rate: int
    input_is_virtual: bool
    reported_input_latency_ms: float | None = None
    reported_output_latency_ms: float | None = None
    output_heard: bool | None = None
    noise_floor_dbfs: float | None = None
    noise_verdict: str | None = None
    speech_level_dbfs: float | None = None
    speech_peak_dbfs: float | None = None
    speech_clipping_ratio: float | None = None
    speech_verdict: str | None = None
    snr_db: float | None = None
    snr_verdict: str | None = None
    roundtrip_latency_ms: list[float] = field(default_factory=list)
    roundtrip_latency_median_ms: float | None = None
    notes: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- devices


def is_virtual(name: str) -> bool:
    lower = name.lower()
    return any(h in lower for h in VIRTUAL_HINTS)


def host_api_index(name: str) -> int | None:
    for i, api in enumerate(sd.query_hostapis()):
        if api["name"].lower() == name.lower():
            return i
    return None


def list_devices() -> None:
    apis = sd.query_hostapis()
    for ai, api in enumerate(apis):
        print(f"\n== {api['name']} ==")
        for idx in api["devices"]:
            d = sd.query_devices(idx)
            kind = []
            if d["max_input_channels"] > 0:
                kind.append("IN" + ("*" if idx == api["default_input_device"] else ""))
            if d["max_output_channels"] > 0:
                kind.append("OUT" + ("*" if idx == api["default_output_device"] else ""))
            flag = "  [virtual]" if is_virtual(d["name"]) else ""
            print(f"  [{idx:>3}] {'/'.join(kind):<8} {d['name']}{flag}")
    print("\n* = predeterminado de ese host API. Usá --input N / --output N para elegir.")


def resolve_devices(args: argparse.Namespace) -> tuple[int, int, str]:
    api_name = args.host_api or PREFERRED_HOST_API
    ai = host_api_index(api_name)
    if ai is None:
        ai = sd.default.hostapi if isinstance(sd.default.hostapi, int) else 0
    api = sd.query_hostapis(ai)
    inp = args.input if args.input is not None else api["default_input_device"]
    out = args.output if args.output is not None else api["default_output_device"]
    if inp is None or inp < 0 or out is None or out < 0:
        raise SystemExit("No encontré dispositivos de entrada/salida. Probá con --list.")
    # Devices passed explicitly may belong to another host API.
    host = sd.query_hostapis(sd.query_devices(inp)["hostapi"])["name"]
    return int(inp), int(out), host


def extra_settings(host: str) -> Any:
    # WASAPI shared mode rejects sample rates != device mix format unless auto-convert is on.
    if host == PREFERRED_HOST_API:
        return sd.WasapiSettings(auto_convert=True)
    return None


# ---------------------------------------------------------------- steps


def ask_yes_no(prompt: str) -> bool:
    while True:
        ans = input(f"{prompt} [s/n]: ").strip().lower()
        if ans in ("s", "si", "sí", "y", "yes"):
            return True
        if ans in ("n", "no"):
            return False


def wait_enter(prompt: str) -> None:
    input(f"\n{prompt}\n  → Enter para empezar...")


def record(seconds: float, device: int, host: str) -> np.ndarray:
    data = sd.rec(
        int(seconds * SAMPLE_RATE),
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        device=device,
        extra_settings=extra_settings(host),
    )
    sd.wait()
    return data


def step_output(rep: Report, out: int, host: str) -> None:
    wait_enter("[1/4] Prueba de salida: vas a escuchar un tono de 1 segundo.")
    t = np.arange(SAMPLE_RATE) / SAMPLE_RATE
    tone = (0.125 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)  # ≈ -18 dBFS
    sd.play(tone, SAMPLE_RATE, device=out, extra_settings=extra_settings(host))
    sd.wait()
    rep.output_heard = ask_yes_no("¿Escuchaste el tono?")


def step_noise(rep: Report, inp: int, host: str) -> np.ndarray:
    wait_enter(f"[2/4] Ruido de fondo: quedate en SILENCIO {NOISE_SECONDS:.0f} s (dejá el ambiente como siempre).")
    print("  ● grabando...")
    data = record(NOISE_SECONDS, inp, host)
    rep.noise_floor_dbfs = round(a.rms_dbfs(data), 1)
    rep.noise_verdict = a.classify_noise_floor(rep.noise_floor_dbfs)
    print(f"  Ruido de fondo: {rep.noise_floor_dbfs} dBFS → {rep.noise_verdict}")
    return data


def step_speech(rep: Report, inp: int, host: str) -> None:
    wait_enter(
        f"[3/4] Nivel de voz: en {SPEECH_SECONDS:.0f} s leé en voz alta, a tu distancia y volumen normales:\n"
        f'     "{TEST_SENTENCE}"'
    )
    print("  ● grabando... hablá ahora")
    data = record(SPEECH_SECONDS, inp, host)
    rep.speech_level_dbfs = round(a.speech_level_dbfs(data, SAMPLE_RATE), 1)
    rep.speech_peak_dbfs = round(a.peak_dbfs(data), 1)
    rep.speech_clipping_ratio = round(a.clipping_ratio(data), 5)
    rep.speech_verdict = a.classify_speech_level(rep.speech_level_dbfs, rep.speech_clipping_ratio)
    print(f"  Voz: {rep.speech_level_dbfs} dBFS (pico {rep.speech_peak_dbfs}) → {rep.speech_verdict}")
    if rep.noise_floor_dbfs is not None:
        rep.snr_db = round(rep.speech_level_dbfs - rep.noise_floor_dbfs, 1)
        rep.snr_verdict = a.classify_snr(rep.snr_db)
        print(f"  Relación señal/ruido: {rep.snr_db} dB → {rep.snr_verdict}")


def step_latency(rep: Report, inp: int, out: int, host: str) -> None:
    wait_enter(
        "[4/4] Latencia ida y vuelta (parlante → micrófono): se escuchan 3 barridos cortos.\n"
        "     Usá PARLANTES a volumen medio (con auriculares el micrófono no los capta). Silencio durante la prueba."
    )
    chirp = a.log_chirp(SAMPLE_RATE, CHIRP_SECONDS, 500, 8000, amplitude=0.3)
    lead = int(CHIRP_LEAD_S * SAMPLE_RATE)
    play = np.zeros(lead + chirp.size + SAMPLE_RATE, dtype=np.float32)  # 1 s tail to catch late arrivals
    play[lead : lead + chirp.size] = chirp
    es = extra_settings(host)
    for i in range(LATENCY_RUNS):
        rec = sd.playrec(
            play,
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            device=(inp, out),
            extra_settings=(es, es) if es else None,
        )
        sd.wait()
        est = a.estimate_lag(chirp, rec)
        ms = round((est.lag_samples - lead) / SAMPLE_RATE * 1000, 1)
        ok = est.confidence >= MIN_LAG_CONFIDENCE and ms >= 0
        print(f"  Intento {i + 1}: {ms if ok else '—'} ms (confianza {est.confidence:.1f})")
        if ok:
            rep.roundtrip_latency_ms.append(ms)
    if rep.roundtrip_latency_ms:
        rep.roundtrip_latency_median_ms = float(np.median(rep.roundtrip_latency_ms))
        print(f"  Latencia mediana: {rep.roundtrip_latency_median_ms} ms")
    else:
        rep.notes.append("Latencia no detectada: el micrófono no captó el barrido (¿auriculares o volumen bajo?).")
        print("  No se detectó el barrido. ¿Estás con auriculares o el volumen está muy bajo?")


def reported_latency(rep: Report, inp: int, out: int, host: str) -> None:
    es = extra_settings(host)
    try:
        with sd.InputStream(device=inp, samplerate=SAMPLE_RATE, channels=1, extra_settings=es) as s:
            rep.reported_input_latency_ms = round(s.latency * 1000, 1)
        with sd.OutputStream(device=out, samplerate=SAMPLE_RATE, channels=1, extra_settings=es) as s:
            rep.reported_output_latency_ms = round(s.latency * 1000, 1)
    except sd.PortAudioError as e:
        rep.notes.append(f"No se pudo consultar la latencia del driver: {e}")


# ---------------------------------------------------------------- report


def report_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    path = Path(base) / "Jarvis" / "diagnostics"
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_report(rep: Report) -> Path:
    path = report_dir() / f"audio-check-{datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps(asdict(rep), ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Diagnóstico de micrófono y parlantes para JARVIS (Fase 0).")
    p.add_argument("--list", action="store_true", help="listar dispositivos y salir")
    p.add_argument("--input", type=int, help="índice del dispositivo de entrada")
    p.add_argument("--output", type=int, help="índice del dispositivo de salida")
    p.add_argument("--host-api", help=f"host API (por defecto: {PREFERRED_HOST_API})")
    p.add_argument("--skip-latency", action="store_true", help="omitir la prueba de latencia acústica")
    args = p.parse_args(argv)

    if args.list:
        list_devices()
        return 0

    inp, out, host = resolve_devices(args)
    in_name = sd.query_devices(inp)["name"]
    out_name = sd.query_devices(out)["name"]
    rep = Report(
        timestamp=datetime.now().isoformat(timespec="seconds"),
        platform=platform.platform(),
        host_api=host,
        input_device=in_name,
        output_device=out_name,
        sample_rate=SAMPLE_RATE,
        input_is_virtual=is_virtual(in_name),
    )
    print(f"Host API: {host}\nEntrada:  [{inp}] {in_name}\nSalida:   [{out}] {out_name}")
    if rep.input_is_virtual:
        msg = "La entrada parece un dispositivo virtual (Voicemod/Nahimic/etc.): puede alterar la voz y sumar latencia."
        rep.notes.append(msg)
        print(f"⚠  {msg}")
    print("No se guarda audio: solo un reporte JSON con las métricas.")

    try:
        reported_latency(rep, inp, out, host)
        step_output(rep, out, host)
        step_noise(rep, inp, host)
        step_speech(rep, inp, host)
        if not args.skip_latency:
            step_latency(rep, inp, out, host)
    except KeyboardInterrupt:
        rep.notes.append("Interrumpido por el usuario.")
        print("\nInterrumpido.")
    except sd.PortAudioError as e:
        rep.notes.append(f"Error de audio: {e}")
        print(f"\nError de audio: {e}\nProbá con --host-api MME o elegí otros dispositivos (--list).", file=sys.stderr)

    path = save_report(rep)
    print(f"\nReporte guardado en: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
