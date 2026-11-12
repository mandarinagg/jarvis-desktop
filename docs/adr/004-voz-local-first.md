# ADR-004: Pipeline de voz local-first

- **Estado:** Propuesta (se confirma con benchmarks de Fase 0)
- **Fecha:** 2026-11-12

## Contexto
Hardware: Ryzen 5 3600, 16 GB RAM, **AMD RX 6600 XT (sin CUDA)**. Python del sistema 3.15 (las wheels de onnxruntime/torch pueden no existir aún). Requisitos: wake word sin nube, latencia baja, barge-in.

## Decisión
- **Servicio de voz en Python 3.12 aislado con `uv`** (no usa el Python del sistema).
- **Wake word:** openWakeWord (Apache-2.0), modelo "jarvis" entrenable/configurable, 100% local.
- **VAD:** Silero VAD (MIT).
- **STT:** whisper.cpp con backend **Vulkan** (soporta GPU AMD); modelo a decidir en benchmark (`large-v3-turbo` vs `small`/`medium` cuantizados). Adaptador alternativo de STT en nube para comparar.
- **TTS:** adaptador intercambiable. Evaluar 2 en nube (voces neuronales en español latino o voz diseñada original) y 2 locales (p. ej. Piper, Kokoro u otros con español). Elegir por calidad + latencia + licencia.
- **AEC/barge-in:** cancelación de eco (WebRTC APM) para detectar voz mientras Jarvis habla.

## Alternativas consideradas
- **Porcupine** para wake word: excelente, pero requiere access key y licencia comercial.
- **faster-whisper:** óptimo con CUDA; en AMD/Windows corre en CPU → más lento.
- **Todo en nube:** menor latencia posible, pero rompe local-first y sube costos.

## Consecuencias
- (+) Funciona offline; privacidad fuerte; costo marginal cero en STT.
- (−) Más piezas nativas que empaquetar; hay que medir latencia real en este equipo.
