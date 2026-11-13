"""Phase 0 STT benchmark: whisper.cpp (Vulkan/CPU) vs Parakeet on the owner's own voice.

    uv run jarvis-stt-bench setup              # download pinned binaries + models (SHA-256 verified)
    uv run jarvis-stt-bench record             # record the 20 reference phrases (interactive)
    uv run jarvis-stt-bench run                # transcribe with every engine and report

Everything lives under %APPDATA%/Jarvis (outside the repo). Recordings are the
owner's voice: they stay local and are never committed.

Vulkan note: whisper.cpp does not ship a Windows Vulkan build, but its release
loads ggml backends dynamically, so we drop in the official ggml-vulkan.dll from
the llama.cpp release built from the same ggml revision (same day). Both are
pinned by SHA-256; bump them together.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from . import text_metrics as tm

WHISPER_TAG = "b5454"
LLAMA_TAG = "b11446"
SAMPLE_RATE = 16_000  # whisper.cpp / parakeet expect 16 kHz mono


@dataclass(frozen=True)
class Asset:
    name: str
    url: str
    sha256: str
    dest: str  # relative to jarvis_home()


ASSETS = [
    Asset(
        "whisper.cpp CPU binaries",
        f"https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_TAG}/whisper-bin-x64.zip",
        "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb",
        f"downloads/whisper-bin-x64-{WHISPER_TAG}.zip",
    ),
    Asset(
        "llama.cpp Vulkan build (for ggml-vulkan.dll)",
        f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/llama-{LLAMA_TAG}-bin-win-vulkan-x64.zip",
        "a27c90495e4816380a1882eb850080d03806ceaf9e979460743411822672ff76",
        f"downloads/llama-{LLAMA_TAG}-bin-win-vulkan-x64.zip",
    ),
    Asset(
        "whisper large-v3-turbo q5_0",
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
        "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        "models/whisper/ggml-large-v3-turbo-q5_0.bin",
    ),
    Asset(
        "whisper small q5_1",
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
        "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        "models/whisper/ggml-small-q5_1.bin",
    ),
    Asset(
        "parakeet tdt 0.6b v3 q8_0",
        "https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q8_0.bin",
        "4d64e9e96c2792186d072fde0034df0ad670cf680a2f53069052ead827fd600e",
        "models/parakeet/ggml-parakeet-tdt-0.6b-v3-q8_0.bin",
    ),
]


@dataclass(frozen=True)
class Engine:
    name: str
    cli: str  # whisper-cli.exe | parakeet-cli.exe
    model: str  # relative to jarvis_home()
    gpu: bool = True
    beam: bool = False
    auto_audio_ctx: bool = True


TURBO = "models/whisper/ggml-large-v3-turbo-q5_0.bin"
SMALL = "models/whisper/ggml-small-q5_1.bin"
PARAKEET = "models/parakeet/ggml-parakeet-tdt-0.6b-v3-q8_0.bin"

ENGINES = {
    e.name: e
    for e in [
        Engine("whisper-turbo-gpu", "whisper-cli.exe", TURBO),
        Engine("whisper-turbo-gpu-fullctx", "whisper-cli.exe", TURBO, auto_audio_ctx=False),
        Engine("whisper-turbo-gpu-beam5", "whisper-cli.exe", TURBO, beam=True),
        Engine("whisper-small-gpu", "whisper-cli.exe", SMALL),
        Engine("parakeet-v3-gpu", "parakeet-cli.exe", PARAKEET, auto_audio_ctx=False),
        Engine("whisper-turbo-cpu", "whisper-cli.exe", TURBO, gpu=False),
    ]
}


# ---------------------------------------------------------------- paths


def jarvis_home() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    return Path(base) / "Jarvis"


def bin_dir() -> Path:
    return jarvis_home() / "bin" / f"stt-whisper-{WHISPER_TAG}-vk-{LLAMA_TAG}"


def bench_root() -> Path:
    return jarvis_home() / "benchmarks" / "stt"


def phrases_file() -> Path:
    return Path(__file__).resolve().parents[3] / "benchmarks" / "stt_phrases_es.txt"


def load_phrases(path: Path) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.lstrip().startswith("#")]


# ---------------------------------------------------------------- setup


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(asset: Asset) -> Path:
    dest = jarvis_home() / asset.dest
    if dest.exists() and sha256_of(dest) == asset.sha256:
        print(f"  ✓ {asset.name} (ya descargado)")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  ↓ {asset.name}")
    with urllib.request.urlopen(asset.url) as r, tmp.open("wb") as f:  # noqa: S310 (pinned https URLs)
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r    {done * 100 // total:3d}%", end="", flush=True)
    print()
    got = sha256_of(tmp)
    if got != asset.sha256:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"SHA-256 inválido para {asset.name}: {got}. Abortado.")
    tmp.replace(dest)
    return dest


def extract_flat(zip_path: Path, target: Path, only: set[str] | None = None) -> None:
    """Extract files by basename only (no directories, so no zip-slip)."""
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = Path(info.filename).name
            if info.is_dir() or not name or (only and name not in only):
                continue
            with z.open(info) as src, (target / name).open("wb") as dst:
                shutil.copyfileobj(src, dst)


def cmd_setup(_: argparse.Namespace) -> int:
    print("Descargando binarios y modelos fijados (verificados por SHA-256)...")
    paths = {a.dest: fetch(a) for a in ASSETS}
    out = bin_dir()
    out.mkdir(parents=True, exist_ok=True)
    extract_flat(paths[ASSETS[0].dest], out)
    extract_flat(paths[ASSETS[1].dest], out, only={"ggml-vulkan.dll"})
    print(f"Binarios listos en {out}")
    probe = subprocess.run([str(out / "whisper-cli.exe"), "--help"], capture_output=True, text=True, errors="replace")
    if probe.returncode != 0 and "usage" not in (probe.stdout + probe.stderr):
        print("⚠ whisper-cli no arrancó (¿Smart App Control?). Ver docs/TROUBLESHOOTING.md", file=sys.stderr)
        return 1
    return 0


# ---------------------------------------------------------------- record


def write_wav(path: Path, samples, sample_rate: int = SAMPLE_RATE) -> None:
    import numpy as np

    pcm = (np.clip(samples.reshape(-1), -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


def record_until_enter(device: int | None):
    import numpy as np
    import sounddevice as sd

    from .audio_check import extra_settings

    host = sd.query_hostapis(sd.query_devices(device if device is not None else sd.default.device[0])["hostapi"])["name"]
    chunks: list[np.ndarray] = []
    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        device=device,
        extra_settings=extra_settings(host),
        callback=lambda data, *_: chunks.append(data.copy()),
    ):
        input("  ● grabando... Enter para terminar")
    time.sleep(0.05)
    return np.concatenate(chunks) if chunks else np.zeros((0, 1), dtype="float32")


def cmd_record(args: argparse.Namespace) -> int:
    import sounddevice as sd

    from .audio_check import NON_INTERACTIVE_MSG, PREFERRED_HOST_API, host_api_index

    if not sys.stdin.isatty():
        print(NON_INTERACTIVE_MSG.replace("jarvis-audio-check", "jarvis-stt-bench record"), file=sys.stderr)
        return 2
    device = args.input
    if device is None:
        ai = host_api_index(PREFERRED_HOST_API)
        device = sd.query_hostapis(ai)["default_input_device"] if ai is not None else None
    phrases = load_phrases(Path(args.phrases))
    session = bench_root() / f"session-{datetime.now():%Y%m%d-%H%M%S}"
    session.mkdir(parents=True)
    print(f"Micrófono: {sd.query_devices(device)['name'] if device is not None else 'predeterminado'}")
    print(f"{len(phrases)} frases. Leé cada una con tu voz y ritmo normales, como si le hablaras a Jarvis.")
    print("Enter para empezar a grabar, Enter para terminar. Después: Enter = siguiente, r = repetir.\n")
    items = []
    try:
        for i, phrase in enumerate(phrases, 1):
            while True:
                input(f"[{i:02d}/{len(phrases)}] «{phrase}»\n  → Enter para grabar")
                audio = record_until_enter(device)
                dur = len(audio) / SAMPLE_RATE
                if dur < 0.5:
                    print("  Demasiado corto, repetimos.")
                    continue
                again = input(f"  {dur:.1f} s grabados. [Enter = siguiente / r = repetir]: ").strip().lower()
                if again != "r":
                    break
            wav = session / f"{i:02d}.wav"
            write_wav(wav, audio)
            items.append({"file": wav.name, "reference": phrase, "duration_s": round(dur, 2)})
    except (KeyboardInterrupt, EOFError):
        print("\nInterrumpido: se guardan las frases grabadas hasta ahora.")
    (session / "manifest.json").write_text(json.dumps({"items": items}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(items)} grabaciones en {session}\nSiguiente paso: uv run jarvis-stt-bench run")
    return 0


# ---------------------------------------------------------------- run


_TIMING = re.compile(r"_print_timings:\s+(load|total) time =\s*([\d.]+) ms")
_SEGMENT = re.compile(r"^\[\d\d:\d\d:\d\d\.\d+ --> [^\]]+\]\s*(.*)$", re.M)


MIN_AUDIO_CTX = 512  # below this whisper large-v3-turbo hallucinates repeated phrases on short clips


def audio_ctx_for(duration_s: float) -> int:
    """Whisper encodes a fixed 30 s window (1500 frames, 20 ms each); shrink it to the clip + 2 s margin.

    Floor of 512 (~10 s): measured in Phase 0, ac <= 384 made turbo repeat the sentence 2-4 times.
    """
    return min(1500, max(MIN_AUDIO_CTX, math.ceil(duration_s * 50) + 100))


def build_command(engine: Engine, wav: Path, duration_s: float, threads: int) -> list[str]:
    home = jarvis_home()
    cmd = [str(bin_dir() / engine.cli), "-m", str(home / engine.model), "-f", str(wav), "-t", str(threads)]
    if engine.cli.startswith("whisper"):
        cmd += ["-l", "es"]
        cmd += ["-bs", "5", "-bo", "5"] if engine.beam else ["-bs", "1", "-bo", "1"]
        if engine.auto_audio_ctx:
            cmd += ["-ac", str(audio_ctx_for(duration_s))]
    if not engine.gpu:
        cmd.append("-ng")
    return cmd


def parse_output(cli: str, stdout: str, stderr: str) -> tuple[str, float | None, float | None]:
    """Return (text, load_ms, total_ms)."""
    timings = {k: float(v) for k, v in _TIMING.findall(stdout + stderr)}
    if cli.startswith("whisper"):
        text = " ".join(s.strip() for s in _SEGMENT.findall(stdout))
    else:
        text = " ".join(ln.strip() for ln in stdout.splitlines() if ln.strip())
    return text.strip(), timings.get("load"), timings.get("total")


@dataclass
class EngineResult:
    engine: str
    files: int = 0
    failures: int = 0
    wer: float | None = None
    wer_no_accents: float | None = None
    cer: float | None = None
    latency_p50_ms: float | None = None
    latency_p95_ms: float | None = None
    rtf_p50: float | None = None
    samples: list[dict] = field(default_factory=list)


def percentile(values: list[float], p: float) -> float:
    s = sorted(values)
    k = (len(s) - 1) * p / 100
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def run_engine(engine: Engine, session: Path, items: list[dict], threads: int) -> EngineResult:
    res = EngineResult(engine.name)
    # Warm-up (Vulkan shader compilation, file cache) is excluded from the stats.
    first = items[0]
    subprocess.run(build_command(engine, session / first["file"], first["duration_s"], threads), capture_output=True)
    pairs, latencies, rtfs = [], [], []
    for it in items:
        wav = session / it["file"]
        p = subprocess.run(
            build_command(engine, wav, it["duration_s"], threads),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        text, load_ms, total_ms = parse_output(engine.cli, p.stdout, p.stderr)
        res.files += 1
        if p.returncode != 0 or total_ms is None:
            res.failures += 1
            res.samples.append({"file": it["file"], "error": (p.stderr or p.stdout)[-400:]})
            continue
        infer_ms = total_ms - (load_ms or 0.0)  # the real service loads the model once
        latencies.append(infer_ms)
        rtfs.append(infer_ms / 1000 / it["duration_s"])
        pairs.append((it["reference"], text))
        res.samples.append(
            {
                "file": it["file"],
                "reference": it["reference"],
                "hypothesis": text,
                "wer": round(tm.wer(it["reference"], text), 3),
                "inference_ms": round(infer_ms, 1),
            }
        )
        print(f"    {it['file']}  {infer_ms:7.0f} ms  {text}")
    if pairs:
        res.wer = round(tm.corpus_wer(pairs), 4)
        res.wer_no_accents = round(tm.corpus_wer(pairs, keep_accents=False), 4)
        res.cer = round(statistics.mean(tm.cer(r, h) for r, h in pairs), 4)
        res.latency_p50_ms = round(percentile(latencies, 50), 1)
        res.latency_p95_ms = round(percentile(latencies, 95), 1)
        res.rtf_p50 = round(percentile(rtfs, 50), 3)
    return res


def markdown_table(results: list[EngineResult]) -> str:
    def pct(v: float | None) -> str:
        return "—" if v is None else f"{v * 100:.1f}%"

    def ms(v: float | None) -> str:
        return "—" if v is None else f"{v:.0f}"

    rows = [
        "| Motor | WER | WER sin tildes | CER | p50 ms | p95 ms | RTF p50 | Fallos |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in sorted(results, key=lambda r: (r.wer is None, r.wer or 0, r.latency_p50_ms or 0)):
        rows.append(
            f"| {r.engine} | {pct(r.wer)} | {pct(r.wer_no_accents)} | {pct(r.cer)} | {ms(r.latency_p50_ms)} | "
            f"{ms(r.latency_p95_ms)} | {r.rtf_p50 if r.rtf_p50 is not None else '—'} | {r.failures}/{r.files} |"
        )
    return "\n".join(rows)


def latest_session() -> Path:
    sessions = sorted(p for p in bench_root().glob("session-*") if (p / "manifest.json").exists())
    if not sessions:
        raise SystemExit("No hay grabaciones. Corré primero: uv run jarvis-stt-bench record")
    return sessions[-1]


def cmd_run(args: argparse.Namespace) -> int:
    if not (bin_dir() / "whisper-cli.exe").exists():
        raise SystemExit("Faltan binarios. Corré primero: uv run jarvis-stt-bench setup")
    session = Path(args.session) if args.session else latest_session()
    items = json.loads((session / "manifest.json").read_text(encoding="utf-8"))["items"]
    if not items:
        raise SystemExit(f"La sesión {session} no tiene grabaciones.")
    names = args.engines.split(",") if args.engines else list(ENGINES)
    unknown = [n for n in names if n not in ENGINES]
    if unknown:
        raise SystemExit(f"Motores desconocidos: {unknown}. Disponibles: {list(ENGINES)}")
    print(f"Sesión: {session} ({len(items)} frases, {sum(i['duration_s'] for i in items):.0f} s de audio)")
    results = []
    for n in names:
        print(f"\n▶ {n}")
        results.append(run_engine(ENGINES[n], session, items, args.threads))
    table = markdown_table(results)
    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    meta = {
        "timestamp": stamp,
        "session": session.name,
        "whisper_tag": WHISPER_TAG,
        "llama_vulkan_tag": LLAMA_TAG,
        "threads": args.threads,
        "phrases": len(items),
        "audio_seconds": round(sum(i["duration_s"] for i in items), 1),
    }
    (session / f"report-{stamp}.json").write_text(
        json.dumps({**meta, "results": [asdict(r) for r in results]}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (session / f"report-{stamp}.md").write_text(table + "\n", encoding="utf-8")
    print("\nLatencia = solo inferencia (sin cargar el modelo, que el servicio hace una vez).\n")
    print(table)
    print(f"\nReporte: {session / f'report-{stamp}.json'}")
    return 0


# ---------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    from .audio_check import force_utf8_console

    force_utf8_console()
    p = argparse.ArgumentParser(description="Benchmark de STT de la Fase 0 para JARVIS.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup", help="descargar binarios y modelos fijados").set_defaults(func=cmd_setup)
    r = sub.add_parser("record", help="grabar las frases de referencia")
    r.add_argument("--input", type=int, help="índice del micrófono (ver jarvis-audio-check --list)")
    r.add_argument("--phrases", default=str(phrases_file()))
    r.set_defaults(func=cmd_record)
    run = sub.add_parser("run", help="transcribir con cada motor y reportar")
    run.add_argument("--session", help="carpeta de sesión (por defecto, la última)")
    run.add_argument("--engines", help=f"lista separada por comas (por defecto todos: {','.join(ENGINES)})")
    run.add_argument("--threads", type=int, default=6, help="hilos de CPU (por defecto 6 = núcleos físicos)")
    run.set_defaults(func=cmd_run)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
