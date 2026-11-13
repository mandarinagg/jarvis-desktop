# ADR-010: Motor de STT: Parakeet TDT 0.6B v3 (Vulkan)

- **Estado:** Aceptada (2026-11-13). Se revisa con más datos en la Fase 2.
- **Fecha:** 2026-11-13

## Contexto
ADR-004 dejó el modelo de STT "a decidir en benchmark". Se corrió `jarvis-stt-bench` con **20 frases grabadas por el owner** (89 s; español rioplatense con voseo, nombres propios, números y anglicismos técnicos) en la RX 6600 XT por Vulkan (ADR-009). La latencia mide solo la inferencia, porque el servicio carga el modelo una sola vez.

| Motor | WER | WER sin tildes | CER | p50 | p95 |
|-------|-----|----------------|-----|-----|-----|
| whisper large-v3-turbo, contexto completo + prompt de vocabulario | 14.0% | 8.8% | 7.0% | 743 ms | 789 ms |
| whisper large-v3-turbo, contexto completo | 14.5% | 8.3% | 6.9% | 733 ms | 744 ms |
| **Parakeet TDT 0.6B v3 q8_0** | **15.3%** | 9.7% | **4.8%** | **184 ms** | **193 ms** |
| whisper large-v3-turbo, beam 5, `audio_ctx` reducido | 18.4% | 12.3% | 11.8% | 331 ms | 418 ms |
| whisper large-v3-turbo, CPU | 26.3% | 19.7% | 16.9% | 4719 ms | 5110 ms |
| whisper small q5_1 | 28.9% | 22.8% | 15.2% | 172 ms | 196 ms |
| whisper large-v3-turbo, greedy, `audio_ctx` reducido | 30.7% | 24.1% | 21.7% | 249 ms | 328 ms |

Observaciones:
- **Reducir el `audio_ctx` de Whisper es dañino con voz real**: aun con el piso de 512 alucina frases repetidas (3 de 20). Solo es aceptable con contexto completo, y ahí cuesta ~730 ms.
- **Parakeet respeta mejor el voseo** ("Mandale", "Corré", "Recordame"); Whisper tiende a pasarlo a la forma con tú.
- **Errores típicos de Parakeet:** nombres propios y siglas ("Jardis", "piel de Claudio" por "API de Claude", "M Cp").
- Con 20 frases, la diferencia de WER entre Parakeet y Whisper con contexto completo **no es significativa**. La de latencia sí (4×).

## Decisión
- **STT por defecto: Parakeet TDT 0.6B v3 q8_0** con `parakeet-cli`/`parakeet.dll` de whisper.cpp + Vulkan (ADR-009).
- **Alternativo:** whisper large-v3-turbo con **contexto completo**, greedy y prompt de vocabulario, para dictados largos o si Parakeet falla. **Nunca** con `audio_ctx` reducido.
- **Fase 2:** capa de corrección post-STT con un diccionario de términos del owner (Jarvis, Claude, API, MCP, nombres de proyectos) con matching difuso, medida con el mismo benchmark.

## Consecuencias
- (+) Al STT le quedan ~100 ms de margen dentro del presupuesto de latencia (meta: 300 ms).
- (+) Un solo runtime (ggml de whisper.cpp) para ambos motores; cambiar de motor es cambiar de modelo y CLI.
- (−) Parakeet no acepta prompt de vocabulario: los nombres propios dependen de la corrección posterior.
- (−) Muestra chica (1 hablante, 20 frases). Se re-evalúa en la Fase 2 con transcripciones reales (opt-in).
