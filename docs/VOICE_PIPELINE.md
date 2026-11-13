# Pipeline de voz

> Decisión base: ADR-004. Benchmarks pendientes en Fase 0.

## 1. Etapas

```
Mic ─▶ AEC ─▶ [Wake word | Push-to-talk] ─▶ VAD ─▶ STT streaming ─▶ Core
                                                                    │
Altavoz ◀─ Reproductor ◀─ TTS por frase ◀─ Segmentador de frases ◀──┘ (stream de Claude)
        ▲
        └── Barge-in: VAD detecta voz del usuario mientras Jarvis habla → cancelar todo
```

| Etapa | Motor propuesto | Local | Notas |
|-------|-----------------|-------|-------|
| AEC | WebRTC APM | ✅ | Necesario para barge-in con parlantes. Setup del owner: auriculares → AEC opcional (se implementa después, no bloquea la Fase 2) |
| Wake word | openWakeWord | ✅ | Umbral ajustable; nunca envía audio previo a la activación |
| VAD | Silero VAD | ✅ | Detecta fin de frase (~500–700 ms de silencio, configurable) |
| STT | whisper.cpp (Vulkan) | ✅ | Benchmark: `large-v3-turbo` vs `medium`/`small` Q5 |
| TTS | Adaptador | nube/local | Ver comparativa en Fase 0 |

## 2. Presupuesto de latencia (meta p50 < 1.5 s)

| Tramo | Meta |
|-------|------|
| Fin de habla → VAD dispara | 400 ms |
| STT final | 300 ms |
| Core arma contexto + envía | 50 ms |
| Claude primer token (TTFT) | 400 ms |
| Primera frase completa + TTS primer audio | 300 ms |
| **Total** | **~1.45 s** |

Técnicas: STT parcial mientras habla, prompt caching, TTS por frase (no esperar respuesta completa), pre-calentar conexiones, frases de acuse breves ("Dale, miro…") cuando un turno va a tardar.

## 3. Estados (visibles en overlay)

`inactivo` → `escuchando` → `transcribiendo` → `pensando` → `hablando` → `inactivo`, más `muteado` y `error`.
El indicador de micrófono abierto es **obligatorio y no se puede ocultar**.

## 4. Barge-in

1. Mientras `hablando`, VAD sigue activo sobre audio con AEC.
2. Si detecta voz del usuario > 250 ms → `voice.barge_in`.
3. Core cancela el stream de Claude (AbortController) y envía `tts.cancel`.
4. El reproductor corta en < 100 ms con fade de 30 ms.
5. Se vuelve a `escuchando`. Lo dicho por Jarvis hasta el corte queda en el historial marcado como interrumpido.

## 5. Privacidad

- Audio crudo **no** se persiste por defecto.
- Transcripciones persistentes solo si el owner lo activa.
- Hotkey de mute global + ícono en bandeja.

## 6. Comparativa TTS (completar en Fase 0)

| Motor | Tipo | Calidad ES (1–5) | Primer audio (ms) | Costo | Licencia | Notas |
|-------|------|------------------|-------------------|-------|----------|-------|
| _Nube A_ | nube | | | | | |
| _Nube B_ | nube | | | | | |
| Piper | local | | | gratis | MIT | |
| Kokoro | local | | | gratis | Apache-2.0 | verificar voces en español |

Requisito de voz: original, español latinoamericano, cálida, sobria y tecnológica. Sin clonar voces protegidas.

## 7. Benchmark de STT (Fase 0)

Herramienta: `services/voice` → `uv run jarvis-stt-bench setup | record | run` (ver README del servicio). Binarios y Vulkan: ADR-009.

**Preliminar (2026-11-13), voz sintética de Windows (Sabina, es-ES), 3 frases.** Solo indica velocidad; el WER se infla porque la voz sintética lee el voseo y los anglicismos como en España.

| Motor | Inferencia p50 | Notas |
|-------|----------------|-------|
| whisper `large-v3-turbo` q5_0, Vulkan, greedy, `ac` dinámico ≥ 512 | **~225 ms** | Candidato principal |
| ídem, beam 5 | ~300 ms | Misma precisión en esta muestra |
| ídem, contexto completo (1500) | ~720 ms | |
| whisper `small` q5_1, Vulkan | ~155 ms | Más errores |
| Parakeet TDT 0.6B v3 q8_0, Vulkan | ~180 ms | Confunde anglicismos ("commit") |
| whisper `large-v3-turbo`, CPU | ~2.9 s | Descartado |

Hallazgo: con `audio_ctx` ≤ 384, turbo **alucina repeticiones** → piso de 512.

**Pendiente:** correr con las 20 frases grabadas por el owner (`benchmarks/stt_phrases_es.txt`) y elegir el motor por WER + p95.
