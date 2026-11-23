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

## 2.1 TTS implementado (Fase 2)

| Pieza | Dónde | Detalle |
|-------|-------|---------|
| Segmentador | `packages/core/src/voice/segmenter.ts` | Corta en fin de oración y en saltos de línea. La primera frase puede cortarse en `, ; :` después de 30 caracteres, para que el primer audio salga antes. Ninguna frase pasa de 250 caracteres. Limpia el markdown y no lee los bloques de código |
| Motores | `services/voice/src/jarvis_voice/tts/engines.py` | Neural2 por gRPC con deadline de 2.5 s. Piper como proceso aparte (`python -m piper --output-raw`), por la licencia GPL |
| Pipeline | `tts/pipeline.py` | Caché → motor principal (un reintento) → fallback. Un hilo sintetiza en orden mientras suena la frase anterior |
| Caché | `tts/cache.py` | `%APPDATA%/Jarvis/cache/tts/<motor-voz>/`, frases de hasta 80 caracteres. Al configurar se presintetizan 8 acuses |
| Reproductor | `tts/player.py` | Stream de 24 kHz siempre abierto, en bloques de 20 ms. `tts.cancel` corta con un fade de 30 ms |

Primera medición real (2026-11-19, en frío, con el prewarm compitiendo por el canal): la primera frase arrancó a los 1.8 s y la segunda empalmó sin hueco. Piper genera 2.5 s de audio en 1.7 s, carga del modelo incluida.

## 2.2 STT implementado (Fase 2, ADR-014)

| Pieza | Dónde | Detalle |
|-------|-------|---------|
| Motor | `services/voice/src/jarvis_voice/stt/parakeet.py` | `parakeet.dll` por ctypes, con el modelo cargado una vez en la GPU y warm-up al arrancar. 93–110 ms por frase de ~5 s (la CLI tardaba 4.7 s) |
| Captura | `stt/controller.py` | Push-to-talk: `stt.start` abre el micrófono y `stt.stop` lo cierra y transcribe. Cada apertura y cierre se avisa con `stt.listening`. Tope de 60 s; lo que dura menos de 250 ms devuelve texto vacío |
| Corrección | `stt/corrections.py` | Reglas por frase y vocabulario difuso conservador. Se amplía en `%APPDATA%/Jarvis/stt/vocabulary.txt` (`mal => bien` o un término por línea) |

Los logs registran la duración y la latencia de cada frase, pero **nunca el texto transcripto**.

## 2.3 Turno de voz (Fase 2, ADR-013)

`packages/core/src/voice/turns.ts` orquesta el turno así:
1. `voice.ptt` presionado → `stt.start`.
2. `voice.ptt` suelto → `stt.stop`.
3. `stt.final` → `voice.transcript` y `chat.send`, por una sesión virtual del `ChatService`.
4. Cada `chat.delta` pasa por el segmentador y sale como `tts.speak`. `chat.done` → `tts.end`.
5. `tts.finished` cierra el turno y registra las métricas.

- El stream de Claude también llega a la UI como texto, por broadcast.
- Sin conversación indicada, un turno nuevo sigue la última conversación de voz si pasaron menos de 10 minutos.
- **Barge-in:** hablarle encima mientras habla (VAD, §4) o apretar el atajo mientras piensa o habla cancela el stream de Claude y manda `tts.cancel`. Si el texto ya se había guardado entero, la respuesta queda marcada como interrumpida.
- **Modo voz (ADR-015):** los turnos hablados agregan `prompts/voice.md` después del system prompt: respuestas de una a tres oraciones, sin markdown, con números y horas como se dicen, y el código en un bloque que queda en pantalla.
- **Errores hablados:** frases cortas y presintetizadas (tope de gasto, falla de Claude). El detalle queda en pantalla.
- **Métricas:** tabla `voice_turns` (migración 002), solo con tiempos y nunca con texto. Reporte: `node packages/core/dist/voice-stats.js`.

Primera medición de punta a punta (2026-11-19, sin key de Anthropic, así que la respuesta fue la frase de error): STT 78 ms y **voz → primer audio en 1367 ms**.

## 2.4 Escritorio (Fase 2)
- Atajo global `Ctrl+Shift+Space`, que funciona como interruptor porque Electron no informa cuándo se suelta la tecla. `Ctrl+Alt+Space` ya estaba tomado por otra app en la PC del owner. En la ventana, el botón «Mantené para hablar» funciona apretando y soltando.
- Overlay en `apps/desktop`: lo muestra u oculta el proceso principal según `voice.state`, y con `micOpen` se ve siempre.

## 3. Estados (visibles en overlay)

`inactivo` → `escuchando` → `transcribiendo` → `pensando` → `hablando` → `inactivo`, más `muteado` y `error`.
El indicador de micrófono abierto es **obligatorio y no se puede ocultar**.

## 4. Barge-in

Implementado en la Fase 2 (ADR-016), sin AEC porque el owner usa auriculares:
1. Cuando un turno empieza a sonar, el Core manda `vad.arm`. El servicio abre el micrófono (el indicador lo muestra: «Hablando · te escucho») y corre Silero VAD sobre frames de 32 ms.
2. Si detecta voz del owner durante ≥ 250 ms, manda `vad.speech` (~250 ms desde que empieza la voz, medido con una grabación real).
3. El Core cancela el stream de Claude (AbortController) y manda `tts.cancel`.
4. El reproductor corta en < 100 ms, con fade de 30 ms.
5. El servicio sigue grabando esa frase, con 0,5 s de pre-roll, hasta 700 ms de silencio. Después cierra el micrófono y transcribe. Se pasa a `escuchando` → `transcribiendo`, y lo que Jarvis dijo hasta el corte queda en el historial marcado como interrumpido.

- Si termina el turno sin que el owner hable, `vad.disarm` cierra el micrófono.
- El atajo siempre gana: desarma el VAD o termina antes la frase que se está grabando.
- `JARVIS_BARGE_IN=0` deja solo el barge-in por atajo, que es lo que conviene con parlantes hasta que haya AEC.

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
