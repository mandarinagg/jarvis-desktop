# ADR-005: Router de modelos y control de costos

- **Estado:** Propuesta (se calibra con datos de Fases 1–2)
- **Fecha:** 2026-11-12

## Contexto
Un asistente de voz always-on tiene muchos turnos cortos (latencia crítica) y algunos profundos (razonamiento, construcción). Un único modelo potente para todo maximiza calidad pero sube costo y latencia.

## Decisión
- Modelo por defecto: **Claude Opus 5.5** (`claude-opus-5-5`), con `effort` ajustado por tipo de turno.
- Router con 3 perfiles configurables, **medidos con evals antes de activarse**:
  - **rápido** (intención, confirmaciones, charla corta): candidatos `claude-haiku-5-5` u Opus 5.5 con `effort: low`.
  - **normal** (conversación): candidatos `claude-sonnet-5-5` u Opus 5.5 con `effort: medium`.
  - **profundo** (planificación, ideas, Builder): Opus 5.5 con `effort: high`.
- Antes de una cascada multi-modelo, medir la alternativa simple (un solo modelo variando `effort`): un solo modelo comparte caché.
- **Prompt caching** del system prompt y contexto estable; streaming siempre.
- **Tope diario duro** + alerta al 80%; costo visible por conversación (campo `usage` de cada respuesta).
- Manejo de `stop_reason: "refusal"` y fallbacks del lado servidor.

## Consecuencias
- (+) Costo y latencia controlados con datos, no con intuición.
- (−) Más configuración; mitigado con perfiles por defecto sensatos.
- Detalles en `docs/CLAUDE_API.md`.
