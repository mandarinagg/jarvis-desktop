# ADR-009: Binarios nativos de voz bajo Smart App Control

- **Estado:** Aceptada — por delegación del owner (2026-11-13); revisable antes de empaquetar (Fase 2)
- **Fecha:** 2026-11-13

## Contexto
- ADR-004 eligió whisper.cpp con **Vulkan** (GPU AMD RX 6600 XT, sin CUDA).
- whisper.cpp **no publica binarios Vulkan para Windows** (solo CPU, BLAS y CUDA).
- La PC del owner tiene **Smart App Control (SAC) activo**: bloquea ejecutables y DLLs sin firma ni reputación. Ya bloqueó el Python que descarga `uv` (ver TROUBLESHOOTING). Un build propio de whisper.cpp casi seguro sería bloqueado.
- No hay Visual Studio, CMake ni Vulkan SDK instalados.
- Medición en Fase 0 (6 s de audio, solo inferencia): la mejor opción en CPU es `small` + BLAS (~1.0 s, con errores de tildes) y `large-v3-turbo` en CPU tarda ~3.9 s. **Sin GPU no se llega a la meta de ~300 ms.**

## Decisión
- Usar los **binarios oficiales de whisper.cpp** (CPU x64), que cargan los backends de ggml como DLLs dinámicas, y sumarles el **`ggml-vulkan.dll` oficial del release de llama.cpp** compilado el mismo día a partir de la misma revisión de ggml.
- Ambos se **fijan por tag y SHA-256** (`services/voice/.../stt_bench.py`, `ASSETS`): whisper.cpp `b5454` + llama.cpp `b11446`. Se actualizan **siempre juntos** y se re-verifica que Vulkan cargue (`ggml_vulkan: Found 1 Vulkan devices`).
- Binarios en `%APPDATA%/Jarvis/bin/`, modelos en `%APPDATA%/Jarvis/models/`. Nunca en el repo.
- Ambos binarios oficiales pasan SAC (verificado). **No se desactiva SAC.**
- Parámetros de inferencia derivados del benchmark: decodificación greedy y `audio_ctx` dinámico con **piso de 512**. Con ≤ 384, turbo alucina repeticiones de la frase.

## Alternativas consideradas
- **Compilar whisper.cpp con Vulkan:** requiere VS Build Tools + CMake + Vulkan SDK (varios GB), y SAC probablemente bloquearía el binario resultante.
- **Desactivar SAC:** reduce la seguridad de la PC del owner. Descartado.
- **ONNX Runtime + DirectML** (binarios firmados por Microsoft): viable como plan B si se rompe la compatibilidad de ggml; más trabajo de integración.
- **STT en la nube:** rompe local-first (ADR-004); queda como adaptador alternativo.

## Consecuencias
- (+) GPU sin compilar nada: turbo en Vulkan ≈ **210–250 ms** por frase (vs ~3.9 s en CPU).
- (−) Depende de que las ABI de ggml de los dos proyectos coincidan. Si una actualización rompe, se vuelve al par fijado anterior.
- (−) **Riesgo para el empaquetado de Jarvis:** nuestro propio instalador o ejecutable sin firmar también será bloqueado por SAC. Antes de la Fase 2 hay que decidir la firma de código (p. ej. Azure Trusted Signing) o correr en desarrollo con los binarios firmados de Node y Electron. Se abre un ADR al llegar ahí.
