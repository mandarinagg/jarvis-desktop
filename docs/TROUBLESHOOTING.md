# Solución de problemas

Se completa a medida que aparecen problemas reales. Formato: **Síntoma → Causa → Solución**.

## Audio
- **Jarvis no escucha / entrada distorsionada** → Voicemod o Nahimic interceptando el micrófono → Elegir explícitamente el dispositivo físico en Ajustes, o desactivar el efecto.

## Voz / STT
- **Falla la instalación de dependencias de Python** → Python 3.15 sin wheels → Usar `uv` con Python 3.12 oficial (`py install 3.12`).
- **`uv` falla con "Una directiva de Control de aplicaciones bloqueó este archivo" (os error 4551)** → Smart App Control bloquea los intérpretes sin firmar que descarga `uv` → Instalar el Python 3.12 firmado de la PSF (`py install 3.12`) y borrar `.venv`; `services/voice/pyproject.toml` ya fija `python-preference = "only-system"`.
- **`uv run jarvis-tts-bench` falla con os error 4551** → Smart App Control bloquea el lanzador `.exe` que `uv` acaba de generar para el script (cada uno es un binario distinto, sin reputación) → Correrlo con el intérprete firmado: `uv run --group tts-bench python -m jarvis_voice.diagnostics.tts_bench …`.
- **STT lento** → whisper.cpp corriendo en CPU (no aparece `ggml_vulkan: Found 1 Vulkan devices`) → Verificar que `ggml-vulkan.dll` esté junto a `whisper-cli.exe` (`jarvis-stt-bench setup`) y los drivers AMD.
- **El fallback de Piper falla con `AttributeError: 'Wave_write' object has no attribute '_file'`** → `python -m piper -f -` reabre por nombre un `NamedTemporaryFile`, y Windows no lo permite → Usar `--output-raw` (PCM16 crudo) y tomar la frecuencia de muestreo del `.onnx.json` del modelo. Así lo hace `PiperEngine`.
- **Piper habla solo por los parlantes en vez de devolver audio** → Sin `-f` ni `--output-raw`, la CLI de Piper reproduce el audio ella misma → Pasar siempre `--output-raw`.
- **La voz queda `degradado` al arrancar el Core** → No se encontró `uv`, o el servicio se cayó 5 veces en 10 minutos → Ver los eventos `voice.*` en el log del Core. Para probar el servicio a mano: `uv run --project services/voice --locked python -m jarvis_voice.service`. `JARVIS_VOICE=0` deja solo el texto.
- **`GGML_ASSERT(device) failed` al cargar `parakeet.dll`** → No hay backends de ggml registrados → Llamar a `ggml_backend_load_all_from_path(<bin>)` de `ggml.dll` antes de crear el contexto (ADR-014).
- **El STT en proceso tarda ~700 ms y el log dice `use gpu = 112` / `no GPU found`** → `parakeet_context_params` se pasó como puntero: es un struct de 8 bytes que viaja por valor → Declararlo como `ctypes.Structure` (ADR-014).
- **Jarvis se interrumpe solo apenas empieza a hablar** → Se usan parlantes: el micrófono capta su voz y el VAD la toma como barge-in (ADR-016) → Usar auriculares o arrancar el Core con `JARVIS_BARGE_IN=0`, que deja solo el barge-in por atajo, hasta que haya AEC.
- **El barge-in por voz no hace nada y el log dice `stt.vad_failed`** → Falta `%APPDATA%\Jarvis\models\vad\silero_vad.onnx` → Correr `uv run python -m jarvis_voice.diagnostics.stt_bench setup`.
- **Whisper repite la misma frase 2–4 veces** → `audio_ctx` demasiado chico (≤ 384) → Usar un piso de 512 (ADR-009).

## API
- **401** → API key inválida o ausente en Credential Manager.
- **429** → Rate limit: el Core reintenta con backoff; revisar el tope diario.
