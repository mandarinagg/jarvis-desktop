# services/voice

Servicio de voz en Python 3.12 (gestionado con `uv`): AEC, wake word (openWakeWord), VAD (Silero), STT (whisper.cpp Vulkan), TTS intercambiable y barge-in.

El servicio se implementa en la **Fase 2** (ver `docs/VOICE_PIPELINE.md`). Por ahora solo contiene diagnósticos de la Fase 0 (audio, STT y TTS).

## Requisitos
- `uv` y **Python 3.12 oficial** (`py install 3.12`). El intérprete que descarga `uv` no está firmado y Smart App Control lo bloquea (ver `docs/TROUBLESHOOTING.md`).

## Diagnóstico de audio (Fase 0)
```powershell
cd services/voice
uv sync
uv run jarvis-audio-check --list          # ver dispositivos
uv run jarvis-audio-check                 # prueba guiada (~1 min), en una terminal propia
uv run jarvis-audio-check --input 15 --output 12 --skip-latency
```
Mide: que la salida suene, el ruido de fondo, el nivel de voz, la saturación, la relación señal/ruido, la latencia del driver y la latencia acústica ida y vuelta (parlante → micrófono).
**No guarda audio**: solo escribe un reporte JSON en `%APPDATA%\Jarvis\diagnostics\`.

## Benchmark de STT (Fase 0)
```powershell
uv run jarvis-stt-bench setup     # baja binarios y modelos fijados (~1.5 GB, verificados por SHA-256)
uv run jarvis-stt-bench record    # grabás las 20 frases de benchmarks/stt_phrases_es.txt (~5 min)
uv run jarvis-stt-bench run       # compara motores: WER, CER, latencia p50/p95
```
Motores: whisper `large-v3-turbo` (GPU: greedy, beam 5 y contexto completo; también CPU), whisper `small` (GPU) y Parakeet v3 (GPU). La GPU usa Vulkan con el `ggml-vulkan.dll` de llama.cpp (ADR-009).
Las grabaciones son tu voz: quedan en `%APPDATA%\Jarvis\benchmarks\stt\` y nunca se suben al repo.

## Comparativa de TTS (Fase 0)
```powershell
uv sync --group tts-bench                                               # Google + Piper + Kokoro (opcionales)
$tts = "uv run --group tts-bench python -m jarvis_voice.diagnostics.tts_bench"
iex "$tts setup"     # baja las voces locales fijadas (~550 MB, verificadas por SHA-256)
iex "$tts voices"    # lista las voces de Google en español (necesita credenciales)
iex "$tts run"       # sintetiza las 14 frases con cada motor: primer audio, RTF, costo
iex "$tts rate"      # escucha a ciegas: puntuás 1-5 sin saber qué motor es (terminal propia)
```
Se usa `python -m` en lugar de `uv run jarvis-tts-bench` porque Smart App Control bloquea el lanzador `.exe` recién generado (ver `docs/TROUBLESHOOTING.md`).

**Credenciales de Google** (nunca se commitean): API key restringida a la *Cloud Text-to-Speech API* en la variable `JARVIS_GOOGLE_TTS_API_KEY`, o `gcloud auth application-default login`. Opciones: `--engines`, `--chirp-voice`, `--neural2-voice`, `--chars-per-day`.
Los audios generados y los puntajes quedan en `%APPDATA%\Jarvis\benchmarks\tts\`.

## Tests
```powershell
uv run pytest
```
