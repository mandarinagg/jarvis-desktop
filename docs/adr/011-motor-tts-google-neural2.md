# ADR-011: Motor de TTS: Google Cloud Neural2 con fallback local

- **Estado:** Aceptada (2026-11-13). Se revisa con la latencia de punta a punta medida en la Fase 2.
- **Fecha:** 2026-11-13
- **Decisores:** owner

## Contexto
ADR-004 dejó el TTS como un adaptador intercambiable, a elegir con una comparativa de 2 motores en la nube y 2 locales. El owner ya tenía cuenta de Google Cloud, así que la nube se evaluó con dos familias de voces de Google. Se corrió `jarvis-tts-bench` con 14 frases típicas de Jarvis, sintetizadas una por una como lo hará el pipeline. Los motores locales corrieron en un Ryzen 5 3600 (CPU). La calidad salió de una **escucha a ciegas del owner**: 5 frases por motor, en orden aleatorio, con puntaje de 1 a 5.

| Motor | Calidad (1–5, a ciegas) | Primer audio p50 / p95 | Costo (10k car./día) | Licencia |
|-------|-------------------------|------------------------|----------------------|----------|
| **Google Neural2 `es-US-Neural2-B`** | **4.8** | 1172 / 1962 ms | US$ 4,80/mes (US$16/M) | propietaria |
| Google Chirp 3 HD `es-US-Chirp3-HD-Charon`, sin streaming | 4.2* | 1926 / 2680 ms | US$ 9/mes (US$30/M) | propietaria |
| Google Chirp 3 HD, streaming | 4.2 | 2894 / 5496 ms | US$ 9/mes | propietaria |
| Kokoro `em_alex` | 2.0 | 1339 / 1595 ms | gratis | modelo Apache-2.0 · espeak-ng GPL-3.0 |
| Piper `es_AR-daniela-high` | 1.4 | 584 / 795 ms | gratis | piper-tts GPL-3.0 · voz CC BY-SA 4.0 |
| Kokoro `ef_dora` | 1.4 | 1279 / 1618 ms | gratis | modelo Apache-2.0 · espeak-ng GPL-3.0 |
| Piper `es_MX-claude-high` | 1.0 | **166 / 218 ms** | gratis | piper-tts GPL-3.0 · voz Apache-2.0 |

\* La misma voz que la versión en streaming: el audio es el mismo y solo cambia la forma de entregarlo.

Observaciones sobre la latencia de la nube:
- **Ninguna variante entra en los 300 ms del presupuesto.** Se probaron el endpoint global, el regional `us-` y gRPC contra REST, y las diferencias quedan dentro del ruido.
- La demora la domina **la red, no la síntesis**. `list_voices`, que no sintetiza nada, tarda entre 314 y 1200 ms. Neural2 con "Hola" tarda 331 ms en el mejor caso, que es el piso de la red, con unos 160 ms de RTT a Google. El largo del texto casi no influye: una frase de 17 caracteres y una de 160 tardan parecido, con picos de 2 a 4 s.
- El **streaming de Chirp 3 HD empeora las cosas**: la mediana es más alta, la variación enorme (de 0.4 a 20 s) y agrega 200 ms de silencio inicial.
- Los motores locales que entran en presupuesto (Piper) suenan mal: el owner los puntuó entre 1 y 1.4.

## Decisión
- **TTS por defecto: Google Cloud Text-to-Speech, voz `es-US-Neural2-B`,** por request/response (gRPC). Gana en calidad, es la más rápida y estable de la nube, y la más barata de las dos.
- **Alternativa en la nube: Chirp 3 HD `es-US-Chirp3-HD-Charon`, sin streaming,** por si Google retira Neural2, que ya marca como *legacy*. Cambiarla es configurar el adaptador, sin tocar código.
- **Fallback offline: Piper `es_AR-daniela-high`,** solo cuando no hay red. En la UI se indica "voz offline". Corre como **proceso separado**, porque `piper-tts` y espeak-ng son GPL-3.0 y el repo es MIT.
- **Mitigaciones de latencia** (se implementan en la Fase 2):
  1. **Caché local de frases fijas** (acuses como "Dale, ya lo miro.", "Listo.", "Entendido."), presintetizadas con la misma voz y guardadas en `%APPDATA%/Jarvis/cache/tts/`. Así el primer audio de muchos turnos sale en unos 0 ms.
  2. **Síntesis superpuesta:** mientras suena la frase *n* se sintetiza la *n+1*. Una frase dura entre 4 y 5 s y su síntesis tarda entre 1 y 2 s, así que después de la primera no quedan huecos.
  3. **Canal gRPC siempre abierto,** con keepalive y precalentado al arrancar.
  4. **Timeout de 2.5 s** sin primer audio: se reintenta una vez y después se cae al fallback offline.
- **Privacidad:** a Google solo viaja el **texto de las respuestas de Jarvis**, nunca el audio del usuario. La UI indica el motor activo y que usa la nube (PRODUCT_SPEC §8).
- **Credencial:** una API key restringida a la *Cloud Text-to-Speech API*. En el benchmark se toma de la variable de usuario `JARVIS_GOOGLE_TTS_API_KEY`. En el producto se guardará en el Credential Manager de Windows (Fase 2). Nunca va en el repo.

## Alternativas consideradas
- **Piper local como motor por defecto:** latencia excelente (166 ms), gratis y offline, pero la calidad es inaceptable para el owner (1.0–1.4).
- **Kokoro local:** calidad baja en español (1.4–2.0) y 1.3 s por frase en CPU. No da streaming dentro de una frase. Probarlo con `onnxruntime-directml` en la RX 6600 XT queda como opción, pero no se espera que mejore la calidad.
- **Chirp 3 HD en streaming:** en teoría es la mejor latencia, pero en la práctica fue la peor y la más inestable, y además puntuó peor que Neural2.
- **Otros proveedores (ElevenLabs Flash, Azure, OpenAI):** no se evaluaron porque requieren cuentas nuevas. Si la latencia de punta a punta de la Fase 2 no alcanza la meta, el primer candidato es un proveedor con servidores más cerca o con streaming real, medido con el mismo benchmark.

## Consecuencias
- (+) La mejor voz disponible según el owner, por unos US$ 5 al mes. El plan gratis de Google podría cubrirlo: hay que verificarlo en la consola.
- (+) El adaptador permite cambiar de voz o de proveedor sin tocar el pipeline. El benchmark queda para repetir la comparación.
- (−) **El tramo de TTS no cumple el presupuesto:** p50 de unos 1.2 s contra 300 ms. Sin mitigaciones, la latencia estimada de punta a punta es de unos 2.2 s, por encima de la meta del MVP (2.0 s). Las mitigaciones 1 y 2 apuntan a recuperar el primer audio percibido. Se mide en la Fase 2 y, si no alcanza, se reabre este ADR.
- (−) La voz depende de la red y de un proveedor externo. Sin red, la voz cae al fallback, que tiene calidad baja.
- (−) Este ADR **reemplaza la parte de TTS de ADR-004** (local-first): el TTS es nube-first. STT, VAD y wake word siguen siendo locales.
- (−) Neural2 está marcada como *legacy*. Hay que vigilar los anuncios de Google, y la alternativa Chirp 3 HD ya está medida.
