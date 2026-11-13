"""Phase 0 TTS comparison: Google Cloud (Chirp 3 HD streaming, Neural2) vs local Piper and Kokoro.

    $CLI = uv run --group tts-bench python -m jarvis_voice.diagnostics.tts_bench
    $CLI setup             # download pinned local voices (SHA-256 verified)
    $CLI voices            # list Google's Spanish voices (needs credentials)
    $CLI run               # synthesize every phrase with every engine, report latency/cost
    $CLI rate              # blind listening test: score 1-5 without knowing the engine

Latency: the pipeline synthesizes sentence by sentence, so each phrase is one request.
- ttfa   = time to the first audio chunk (what the user waits for before Jarvis starts talking)
- perceived = ttfa + leading silence inside that chunk
Models are loaded and cloud connections are warmed up before measuring, like the real service.

Google credentials (never committed): env var JARVIS_GOOGLE_TTS_API_KEY (an API key restricted
to the Text-to-Speech API) or Application Default Credentials (`gcloud auth application-default login`).

License note: piper-tts is GPL-3.0 and both local engines phonemize with espeak-ng (GPL-3.0).
Fine for a local benchmark; how the product may ship them is decided in the TTS ADR.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import random
import statistics
import sys
import time
import wave
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np

from .stt_bench import Asset, fetch, jarvis_home, load_phrases, percentile, write_wav

SILENCE_THRESHOLD = 0.01  # ~-40 dBFS: below this a sample counts as silence
GOOGLE_SAMPLE_RATE = 24_000
GOOGLE_KEY_ENV = "JARVIS_GOOGLE_TTS_API_KEY"
# Smart App Control blocks the freshly generated uv launcher (.exe) for this script; `python -m`
# goes through the PSF-signed interpreter instead.
CLI = "uv run --group tts-bench python -m jarvis_voice.diagnostics.tts_bench"

PIPER_VOICES = "https://huggingface.co/rhasspy/piper-voices/resolve/main/es"
KOKORO_FILES = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

ASSETS = [
    Asset(
        "Piper es_AR daniela (high)",
        f"{PIPER_VOICES}/es_AR/daniela/high/es_AR-daniela-high.onnx",
        "7ceb1fc0dab349418c5b54a639ae9ee595212d7c9ea422220d8419163d5cc985",
        "models/tts/piper/es_AR-daniela-high.onnx",
    ),
    Asset(
        "Piper es_AR daniela (config)",
        f"{PIPER_VOICES}/es_AR/daniela/high/es_AR-daniela-high.onnx.json",
        "aedbf69647e1d754c62ecf8e0366ca5f16af3e768e3c6b5329af6eb6bde3852b",
        "models/tts/piper/es_AR-daniela-high.onnx.json",
    ),
    Asset(
        "Piper es_MX claude (high)",
        f"{PIPER_VOICES}/es_MX/claude/high/es_MX-claude-high.onnx",
        "3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0",
        "models/tts/piper/es_MX-claude-high.onnx",
    ),
    Asset(
        "Piper es_MX claude (config)",
        f"{PIPER_VOICES}/es_MX/claude/high/es_MX-claude-high.onnx.json",
        "1afc81f703c0e4cb3b4d7c0dca096b8b54a98806807f0170cf5eb5557723c12d",
        "models/tts/piper/es_MX-claude-high.onnx.json",
    ),
    Asset(
        "Kokoro v1.0 (fp32)",
        f"{KOKORO_FILES}/kokoro-v1.0.onnx",
        "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
        "models/tts/kokoro/kokoro-v1.0.onnx",
    ),
    Asset(
        "Kokoro voices v1.0",
        f"{KOKORO_FILES}/voices-v1.0.bin",
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
        "models/tts/kokoro/voices-v1.0.bin",
    ),
]


# ---------------------------------------------------------------- engines


@dataclass(frozen=True)
class EngineSpec:
    name: str
    kind: str  # "nube" | "local"
    license: str
    usd_per_million_chars: float
    notes: str = ""
    factory: Callable[[argparse.Namespace], Engine] | None = field(default=None, compare=False, repr=False)


class Engine:
    sample_rate: int

    def stream(self, text: str) -> Iterator[np.ndarray]:
        """Yield float32 mono chunks as soon as the engine produces them."""
        raise NotImplementedError


class PiperEngine(Engine):
    def __init__(self, model: str) -> None:
        from piper import PiperVoice

        self.voice = PiperVoice.load(jarvis_home() / model)
        self.sample_rate = self.voice.config.sample_rate

    def stream(self, text: str) -> Iterator[np.ndarray]:
        for chunk in self.voice.synthesize(text):
            yield chunk.audio_float_array.astype("float32")


class KokoroEngine(Engine):
    sample_rate = 24_000

    def __init__(self, voice: str) -> None:
        from kokoro_onnx import Kokoro

        home = jarvis_home() / "models/tts/kokoro"
        self.kokoro = Kokoro(str(home / "kokoro-v1.0.onnx"), str(home / "voices-v1.0.bin"))
        self.voice = voice
        self.loop = asyncio.new_event_loop()

    def stream(self, text: str) -> Iterator[np.ndarray]:
        agen = self.kokoro.create_stream(text, voice=self.voice, lang="es")
        while True:
            try:
                samples, _sr = self.loop.run_until_complete(agen.__anext__())
            except StopAsyncIteration:
                return
            yield np.asarray(samples, dtype="float32")


def google_client(endpoint: str | None = None, transport: str = "grpc"):
    """endpoint: None = global, or a regional host like 'us-texttospeech.googleapis.com'.

    Bidirectional streaming only exists over gRPC; REST applies to request/response synthesis.
    """
    from google.cloud import texttospeech as tts

    options: dict[str, str] = {}
    if key := os.environ.get(GOOGLE_KEY_ENV):
        options["api_key"] = key
    if endpoint:
        options["api_endpoint"] = endpoint
    try:
        return tts.TextToSpeechClient(client_options=options or None, transport=transport)
    except Exception as e:  # google.auth.exceptions.DefaultCredentialsError and friends
        raise SystemExit(
            f"Sin credenciales de Google ({type(e).__name__}). Definí {GOOGLE_KEY_ENV} con una API key "
            "restringida a Text-to-Speech, o corré `gcloud auth application-default login`."
        ) from e


def language_of(voice_name: str) -> str:
    return "-".join(voice_name.split("-")[:2])


class GoogleStreamingEngine(Engine):
    """Chirp 3 HD over bidirectional streaming: audio starts before the whole phrase is rendered."""

    sample_rate = GOOGLE_SAMPLE_RATE

    def __init__(self, voice_name: str, endpoint: str | None = None) -> None:
        from google.cloud import texttospeech as tts

        self.tts = tts
        self.client = google_client(endpoint, "grpc")
        self.voice_name = voice_name

    def stream(self, text: str) -> Iterator[np.ndarray]:
        tts = self.tts
        config = tts.StreamingSynthesizeConfig(
            voice=tts.VoiceSelectionParams(name=self.voice_name, language_code=language_of(self.voice_name)),
            streaming_audio_config=tts.StreamingAudioConfig(
                audio_encoding=tts.AudioEncoding.PCM, sample_rate_hertz=GOOGLE_SAMPLE_RATE
            ),
        )
        requests = iter(
            [
                tts.StreamingSynthesizeRequest(streaming_config=config),
                tts.StreamingSynthesizeRequest(input=tts.StreamingSynthesisInput(text=text)),
            ]
        )
        for response in self.client.streaming_synthesize(requests):
            if response.audio_content:
                yield pcm16_to_float(response.audio_content)


class GoogleBatchEngine(Engine):
    """Classic request/response synthesis: the first audio is the whole phrase."""

    sample_rate = GOOGLE_SAMPLE_RATE

    def __init__(self, voice_name: str, endpoint: str | None = None, transport: str = "grpc") -> None:
        from google.cloud import texttospeech as tts

        self.tts = tts
        self.client = google_client(endpoint, transport)
        self.voice_name = voice_name

    def stream(self, text: str) -> Iterator[np.ndarray]:
        tts = self.tts
        response = self.client.synthesize_speech(
            input=tts.SynthesisInput(text=text),
            voice=tts.VoiceSelectionParams(name=self.voice_name, language_code=language_of(self.voice_name)),
            audio_config=tts.AudioConfig(
                audio_encoding=tts.AudioEncoding.LINEAR16, sample_rate_hertz=GOOGLE_SAMPLE_RATE
            ),
        )
        samples, _ = wav_to_float(response.audio_content)
        yield samples


ENGINES = {
    e.name: e
    for e in [
        EngineSpec(
            "google-chirp3hd",
            "nube",
            "propietaria (Google Cloud)",
            30.0,
            "streaming bidireccional",
            lambda a: GoogleStreamingEngine(a.chirp_voice, a.google_endpoint),
        ),
        EngineSpec(
            "google-chirp3hd-batch",
            "nube",
            "propietaria (Google Cloud)",
            30.0,
            "misma voz, sin streaming",
            lambda a: GoogleBatchEngine(a.chirp_voice, a.google_endpoint, a.google_transport),
        ),
        EngineSpec(
            "google-neural2",
            "nube",
            "propietaria (Google Cloud)",
            16.0,
            "sin streaming; Google la marca como legacy",
            lambda a: GoogleBatchEngine(a.neural2_voice, a.google_endpoint, a.google_transport),
        ),
        EngineSpec(
            "piper-daniela-ar",
            "local",
            "piper-tts GPL-3.0; voz CC BY-SA 4.0",
            0.0,
            "es_AR, CPU",
            lambda a: PiperEngine("models/tts/piper/es_AR-daniela-high.onnx"),
        ),
        EngineSpec(
            "piper-claude-mx",
            "local",
            "piper-tts GPL-3.0; voz Apache-2.0",
            0.0,
            "es_MX, CPU",
            lambda a: PiperEngine("models/tts/piper/es_MX-claude-high.onnx"),
        ),
        EngineSpec(
            "kokoro-alex",
            "local",
            "Apache-2.0 (modelo); espeak-ng GPL-3.0",
            0.0,
            "voz masculina es, CPU",
            lambda a: KokoroEngine("em_alex"),
        ),
        EngineSpec(
            "kokoro-dora",
            "local",
            "Apache-2.0 (modelo); espeak-ng GPL-3.0",
            0.0,
            "voz femenina es, CPU",
            lambda a: KokoroEngine("ef_dora"),
        ),
    ]
}


# ---------------------------------------------------------------- audio helpers


def pcm16_to_float(data: bytes) -> np.ndarray:
    return (np.frombuffer(data, dtype="<i2").astype("float32") / 32768.0).astype("float32")


def wav_to_float(data: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(data), "rb") as w:
        return pcm16_to_float(w.readframes(w.getnframes())), w.getframerate()


def leading_silence_ms(audio: np.ndarray, sample_rate: int) -> float:
    loud = np.flatnonzero(np.abs(audio) > SILENCE_THRESHOLD)
    first = int(loud[0]) if loud.size else len(audio)
    return first * 1000.0 / sample_rate


# ---------------------------------------------------------------- metrics


@dataclass
class PhraseResult:
    index: int
    text: str
    ttfa_ms: float
    total_ms: float
    audio_s: float
    leading_silence_ms: float

    @property
    def perceived_ms(self) -> float:
        return self.ttfa_ms + self.leading_silence_ms


@dataclass
class EngineSummary:
    engine: str
    kind: str
    license: str
    usd_per_million_chars: float
    notes: str
    phrases: int
    failures: int
    ttfa_p50_ms: float | None = None
    ttfa_p95_ms: float | None = None
    perceived_p50_ms: float | None = None
    total_p50_ms: float | None = None
    rtf_p50: float | None = None
    samples: list[dict] = field(default_factory=list)


def summarize_engine(spec: EngineSpec, results: list[PhraseResult], failures: int) -> EngineSummary:
    s = EngineSummary(
        spec.name,
        spec.kind,
        spec.license,
        spec.usd_per_million_chars,
        spec.notes,
        phrases=len(results) + failures,
        failures=failures,
    )
    if results:
        s.ttfa_p50_ms = round(percentile([r.ttfa_ms for r in results], 50), 1)
        s.ttfa_p95_ms = round(percentile([r.ttfa_ms for r in results], 95), 1)
        s.perceived_p50_ms = round(percentile([r.perceived_ms for r in results], 50), 1)
        s.total_p50_ms = round(percentile([r.total_ms for r in results], 50), 1)
        s.rtf_p50 = round(percentile([r.total_ms / 1000 / r.audio_s for r in results if r.audio_s > 0], 50), 3)
        s.samples = [{**asdict(r), "perceived_ms": round(r.perceived_ms, 1)} for r in results]
    return s


def monthly_cost_usd(spec: EngineSpec, chars_per_day: int) -> float:
    return spec.usd_per_million_chars * chars_per_day * 30 / 1_000_000


def markdown_table(summaries: list[EngineSummary], chars_per_day: int) -> str:
    def ms(v: float | None) -> str:
        return "—" if v is None else f"{v:.0f}"

    rows = [
        f"| Motor | Tipo | Primer audio p50 | p95 | Percibido p50 | Frase completa p50 | RTF p50 "
        f"| Costo/mes ({chars_per_day // 1000}k car./día) | Licencia | Fallos |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for s in sorted(summaries, key=lambda s: (s.perceived_p50_ms is None, s.perceived_p50_ms or 0)):
        spec = ENGINES.get(s.engine) or EngineSpec(s.engine, s.kind, s.license, s.usd_per_million_chars)
        cost = monthly_cost_usd(spec, chars_per_day)
        rows.append(
            f"| {s.engine} | {s.kind} | {ms(s.ttfa_p50_ms)} | {ms(s.ttfa_p95_ms)} | {ms(s.perceived_p50_ms)} | "
            f"{ms(s.total_p50_ms)} | {s.rtf_p50 if s.rtf_p50 is not None else '—'} | "
            f"{'gratis' if cost == 0 else f'US$ {cost:.2f}'} | {s.license} | {s.failures}/{s.phrases} |"
        )
    return "\n".join(rows)


# ---------------------------------------------------------------- run


def bench_root() -> Path:
    return jarvis_home() / "benchmarks" / "tts"


def phrases_file() -> Path:
    return Path(__file__).resolve().parents[3] / "benchmarks" / "tts_phrases_es.txt"


def measure(engine: Engine, text: str) -> tuple[PhraseResult, np.ndarray]:
    t0 = time.perf_counter()
    ttfa = None
    chunks = []
    for chunk in engine.stream(text):
        if ttfa is None and chunk.size:
            ttfa = (time.perf_counter() - t0) * 1000
        chunks.append(chunk)
    total = (time.perf_counter() - t0) * 1000
    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype="float32")
    if ttfa is None or audio.size == 0:
        raise RuntimeError("el motor no devolvió audio")
    first = chunks[next(i for i, c in enumerate(chunks) if c.size)]
    result = PhraseResult(
        index=0,
        text=text,
        ttfa_ms=round(ttfa, 1),
        total_ms=round(total, 1),
        audio_s=round(audio.size / engine.sample_rate, 3),
        leading_silence_ms=round(leading_silence_ms(first, engine.sample_rate), 1),
    )
    return result, audio


def run_engine(spec: EngineSpec, args: argparse.Namespace, phrases: list[str], out: Path) -> EngineSummary:
    t0 = time.perf_counter()
    engine = spec.factory(args)
    print(f"  cargado en {time.perf_counter() - t0:.1f} s")
    measure(engine, "Hola, esto es una prueba.")  # warm-up: model caches / TLS + gRPC connection
    (out / spec.name).mkdir(parents=True, exist_ok=True)
    results, failures = [], 0
    for i, text in enumerate(phrases, 1):
        try:
            r, audio = measure(engine, text)
        except Exception as e:  # report and keep going: one bad phrase must not sink the run
            failures += 1
            print(f"    {i:02d}  ✗ {type(e).__name__}: {str(e)[:200]}")
            continue
        r.index = i
        write_wav(out / spec.name / f"{i:02d}.wav", audio, engine.sample_rate)
        results.append(r)
        print(f"    {i:02d}  primer audio {r.ttfa_ms:6.0f} ms  completa {r.total_ms:6.0f} ms  ({r.audio_s:.1f} s)")
    return summarize_engine(spec, results, failures)


def selected_engines(arg: str | None) -> list[EngineSpec]:
    names = arg.split(",") if arg else list(ENGINES)
    unknown = [n for n in names if n not in ENGINES]
    if unknown:
        raise SystemExit(f"Motores desconocidos: {unknown}. Disponibles: {list(ENGINES)}")
    return [ENGINES[n] for n in names]


def cmd_run(args: argparse.Namespace) -> int:
    phrases = load_phrases(Path(args.phrases))
    specs = selected_engines(args.engines)
    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    out = bench_root() / f"run-{stamp}"
    out.mkdir(parents=True)
    print(f"{len(phrases)} frases, {sum(map(len, phrases))} caracteres → {out}")
    summaries = []
    for spec in specs:
        print(f"\n▶ {spec.name} ({spec.kind})")
        try:
            summaries.append(run_engine(spec, args, phrases, out))
        except (Exception, SystemExit) as e:  # missing credentials/models: skip the engine, keep the rest
            print(f"  ✗ no se pudo usar: {e}")
            summaries.append(summarize_engine(spec, [], failures=len(phrases)))
    meta = {
        "timestamp": stamp,
        "phrases": phrases,
        "chars": sum(map(len, phrases)),
        "chars_per_day": args.chars_per_day,
        "google_voices": {"chirp3hd": args.chirp_voice, "neural2": args.neural2_voice},
        "google_endpoint": args.google_endpoint or "global",
        "google_transport": args.google_transport,
    }
    (out / "report.json").write_text(
        json.dumps({**meta, "results": [asdict(s) for s in summaries]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    table = markdown_table(summaries, args.chars_per_day)
    (out / "report.md").write_text(table + "\n", encoding="utf-8")
    print("\nPrimer audio = espera hasta el primer fragmento; Percibido = + silencio inicial de ese fragmento.\n")
    print(table)
    print(f"\nAudios y reporte en {out}\nSiguiente paso: {CLI} rate")
    return 0


# ---------------------------------------------------------------- voices


def cmd_voices(args: argparse.Namespace) -> int:
    client = google_client()
    voices = client.list_voices(language_code=args.language).voices
    for v in sorted(voices, key=lambda v: v.name):
        print(f"{v.name:40s} {','.join(v.language_codes):12s} {v.ssml_gender.name}")
    print(f"\n{len(voices)} voces. Usalas con --chirp-voice / --neural2-voice en `run`.")
    return 0


# ---------------------------------------------------------------- blind rating


@dataclass(frozen=True)
class BlindItem:
    phrase_index: int
    label: str
    engine: str


def blind_plan(engines: list[str], phrase_indices: list[int], rng: random.Random) -> list[BlindItem]:
    plan = []
    for idx in phrase_indices:
        order = engines[:]
        rng.shuffle(order)
        plan += [BlindItem(idx, chr(ord("A") + k), e) for k, e in enumerate(order)]
    return plan


def summarize_ratings(ratings: list[dict]) -> list[tuple[str, float, int]]:
    by_engine: dict[str, list[int]] = {}
    for r in ratings:
        by_engine.setdefault(r["engine"], []).append(r["score"])
    rows = [(e, round(statistics.mean(s), 2), len(s)) for e, s in by_engine.items()]
    return sorted(rows, key=lambda row: -row[1])


def latest_run() -> Path:
    runs = sorted(p for p in bench_root().glob("run-*") if (p / "report.json").exists())
    if not runs:
        raise SystemExit(f"No hay corridas. Corré primero: {CLI} run")
    return runs[-1]


def play(path: Path, device: int | None) -> None:
    import sounddevice as sd

    with wave.open(str(path), "rb") as w:
        audio = pcm16_to_float(w.readframes(w.getnframes()))
        sd.play(audio, w.getframerate(), device=device, blocking=True)


def ask_score(prompt: str, replay: Callable[[], None]) -> int:
    while True:
        answer = input(prompt).strip().lower()
        if answer == "r":
            replay()
        elif answer in {"1", "2", "3", "4", "5"}:
            return int(answer)
        else:
            print("  1 a 5, o r para repetir.")


def cmd_rate(args: argparse.Namespace) -> int:
    from .audio_check import NON_INTERACTIVE_MSG

    if not sys.stdin.isatty():
        print(NON_INTERACTIVE_MSG.replace("uv run jarvis-audio-check", f"{CLI} rate"), file=sys.stderr)
        return 2
    run = Path(args.run) if args.run else latest_run()
    report = json.loads((run / "report.json").read_text(encoding="utf-8"))
    phrases = report["phrases"]
    engines = [r["engine"] for r in report["results"] if r["samples"]]
    if not engines:
        raise SystemExit(f"La corrida {run} no tiene audios.")
    rng = random.Random()
    indices = sorted(rng.sample(range(1, len(phrases) + 1), min(args.phrases, len(phrases))))
    plan = blind_plan(engines, indices, rng)
    print(f"Escucha a ciegas: {len(indices)} frases × {len(engines)} motores, en orden aleatorio.")
    print("Puntuá cada versión de 1 (mala) a 5 (excelente) pensando en la voz de Jarvis:")
    print("natural, cálida, sobria, clara. r = repetir.\n")
    ratings = []
    try:
        for item in plan:
            if item.label == "A":
                print(f"\nFrase {item.phrase_index}: «{phrases[item.phrase_index - 1]}»")
            wav = run / item.engine / f"{item.phrase_index:02d}.wav"
            if not wav.exists():
                continue

            def replay(wav: Path = wav) -> None:
                play(wav, args.output)

            replay()
            score = ask_score(f"  Versión {item.label} [1-5, r]: ", replay)
            ratings.append({**asdict(item), "score": score})
    except (KeyboardInterrupt, EOFError):
        print("\nInterrumpido: se guardan los puntajes hasta ahora.")
    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    (run / f"ratings-{stamp}.json").write_text(json.dumps(ratings, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\nResultado (recién ahora se revela qué motor era cada versión):")
    for engine, mean, n in summarize_ratings(ratings):
        print(f"  {engine:20s} {mean:.2f} / 5  ({n} puntajes)")
    print(f"\nPuntajes en {run / f'ratings-{stamp}.json'}")
    return 0


# ---------------------------------------------------------------- setup / main


def cmd_setup(_: argparse.Namespace) -> int:
    print("Descargando voces locales fijadas (verificadas por SHA-256)...")
    for asset in ASSETS:
        fetch(asset)
    print(f"Listo en {jarvis_home() / 'models' / 'tts'}")
    if not (os.environ.get(GOOGLE_KEY_ENV) or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")):
        print(f"Para Google: definí {GOOGLE_KEY_ENV} o usá `gcloud auth application-default login`.")
    return 0


def main(argv: list[str] | None = None) -> int:
    from .audio_check import force_utf8_console

    force_utf8_console()
    p = argparse.ArgumentParser(description="Comparativa de TTS de la Fase 0 para JARVIS.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup", help="descargar voces locales fijadas").set_defaults(func=cmd_setup)
    v = sub.add_parser("voices", help="listar voces de Google")
    v.add_argument("--language", default="es-US")
    v.set_defaults(func=cmd_voices)
    run = sub.add_parser("run", help="sintetizar las frases con cada motor y reportar")
    run.add_argument("--engines", help=f"lista separada por comas (por defecto todos: {','.join(ENGINES)})")
    run.add_argument("--phrases", default=str(phrases_file()))
    run.add_argument("--chirp-voice", default="es-US-Chirp3-HD-Charon")
    run.add_argument("--neural2-voice", default="es-US-Neural2-B")
    run.add_argument("--google-endpoint", help="host regional, p. ej. us-texttospeech.googleapis.com (por defecto global)")
    run.add_argument(
        "--google-transport", choices=["grpc", "rest"], default="grpc", help="solo motores sin streaming"
    )
    run.add_argument("--chars-per-day", type=int, default=10_000, help="uso estimado para el costo mensual")
    run.set_defaults(func=cmd_run)
    rate = sub.add_parser("rate", help="escucha a ciegas y puntaje 1-5")
    rate.add_argument("--run", help="carpeta de la corrida (por defecto, la última)")
    rate.add_argument("--phrases", type=int, default=5, help="cuántas frases escuchar (por defecto 5)")
    rate.add_argument("--output", type=int, help="índice del dispositivo de salida (ver jarvis-audio-check --list)")
    rate.set_defaults(func=cmd_rate)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
