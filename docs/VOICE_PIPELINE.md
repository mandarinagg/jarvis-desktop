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
| STT | Parakeet TDT 0.6B v3 sobre whisper.cpp/ggml (Vulkan) | ✅ | Elegido por benchmark (ADR-010); alternativo: whisper turbo con contexto completo |
| TTS | Google Cloud Neural2 `es-US-Neural2-B`; fallback offline Piper `es_AR-daniela-high` | nube (fallback local) | Elegido por comparativa a ciegas (ADR-011). Solo viaja el texto de Jarvis |

## 2. Presupuesto de latencia (meta p50 < 1.5 s)

| Tramo | Meta |
|-------|------|
| Fin de habla → VAD dispara | 400 ms |
| STT final | 300 ms |
| Core arma contexto + envía | 50 ms |
| Claude primer token (TTFT) | 400 ms |
| Primera frase completa + TTS primer audio | 300 ms (medido: ~1.2 s p50 con Google → mitigar con caché de acuses y síntesis superpuesta, ADR-011) |
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

## 6. Comparativa TTS (Fase 0)

Herramienta: `jarvis-tts-bench` (ver `services/voice/README.md`). Son 14 frases típicas de Jarvis (`services/voice/benchmarks/tts_phrases_es.txt`), sintetizadas **una por una**, como lo hará el pipeline. Cada motor se carga y se precalienta antes de medir.

- **Primer audio:** espera hasta el primer fragmento de audio. Es lo que compite contra los 300 ms del presupuesto.
- **Percibido:** primer audio más el silencio inicial de ese fragmento.
- **Calidad:** escucha a ciegas del owner (`rate`), con puntaje de 1 a 5. Recién al final se revela qué motor era cada versión.

Mediciones del 2026-11-13. Los motores locales corrieron en un Ryzen 5 3600 (solo CPU). La nube se midió con el endpoint global por gRPC, la mejor de tres variantes. La calidad es la escucha a ciegas del owner, 5 frases por motor.

| Motor | Tipo | Calidad ES (1–5) | Primer audio p50 / p95 (ms) | Costo (10k car./día) | Licencia |
|-------|------|------------------|-----------------------------|----------------------|----------|
| **Google Neural2 `es-US-Neural2-B`** | nube | **4.8** | 1172 / 1962 | US$ 4,80/mes (US$16/M car.) | propietaria |
| Google Chirp 3 HD `Charon` (sin streaming) | nube | 4.2 | 1926 / 2680 | US$ 9/mes (US$30/M car.) | propietaria |
| Google Chirp 3 HD `Charon` (streaming) | nube | 4.2 | 2894 / 5496 | US$ 9/mes | propietaria |
| Kokoro `em_alex` | local | 2.0 | 1339 / 1595 | gratis | modelo Apache-2.0 · espeak-ng GPL-3.0 |
| Piper `es_AR-daniela-high` | local | 1.4 | 584 / 795 | gratis | piper-tts GPL-3.0 · voz CC BY-SA 4.0 |
| Kokoro `ef_dora` | local | 1.4 | 1279 / 1618 | gratis | modelo Apache-2.0 · espeak-ng GPL-3.0 |
| Piper `es_MX-claude-high` | local | 1.0 | 166 / 218 | gratis | piper-tts GPL-3.0 · voz Apache-2.0 |

Conclusiones (detalle en ADR-011):
- **La calidad decide a favor de la nube.** Las voces locales que entran en el presupuesto suenan mal.
- **La latencia de la nube la domina la red**, con un piso de unos 320 ms y picos de más de 1 s incluso sin síntesis. Ni el endpoint regional ni REST mejoran. El streaming de Chirp es el peor.
- **Mitigaciones para la Fase 2:**
  - caché local de acuses presintetizados;
  - síntesis de la frase *n+1* mientras suena la *n*;
  - canal gRPC precalentado;
  - timeout de 2.5 s con fallback a Piper.
- **Licencias:** `piper-tts` y espeak-ng son GPL-3.0, así que corren como proceso separado.

Requisito de voz: original, español latinoamericano, cálida, sobria y tecnológica. Sin clonar voces protegidas.

## 7. Benchmark de STT (Fase 0)

Herramienta: `services/voice` → `uv run jarvis-stt-bench setup | record | run` (ver el README del servicio). Binarios y Vulkan: ADR-009. Decisión: **ADR-010**.

**Resultado (2026-11-13): 20 frases del owner, 89 s, RX 6600 XT por Vulkan, solo inferencia.**

| Motor | WER | CER | p50 | p95 |
|-------|-----|-----|-----|-----|
| **Parakeet TDT 0.6B v3** (elegido) | 15.3% | **4.8%** | **184 ms** | **193 ms** |
| whisper turbo, contexto completo (+ vocabulario) | 14.0–14.5% | 6.9–7.0% | ~735 ms | ~790 ms |
| whisper turbo, beam 5, `audio_ctx` reducido | 18.4% | 11.8% | 331 ms | 418 ms |
| whisper small | 28.9% | 15.2% | 172 ms | 196 ms |
| whisper turbo, greedy, `audio_ctx` reducido | 30.7% | 21.7% | 249 ms | 328 ms |
| whisper turbo, CPU | 26.3% | 16.9% | 4.7 s | 5.1 s |

Hallazgos:
- `audio_ctx` reducido en Whisper **alucina frases repetidas** con voz real (aun con piso de 512). No usarlo.
- Parakeet respeta el voseo; falla en nombres propios y siglas → corrección por diccionario en la Fase 2.
