# ADR-013: Protocolo Core↔Voz y reparto de responsabilidades del turno de voz

- **Estado:** Aceptada por delegación del owner (2026-11-19). Se revisa al cerrar la Fase 2.
- **Fecha:** 2026-11-19
- **Decisores:** owner (delegado)

## Contexto
ADR-008 fija el transporte: el Voice Service es un proceso hijo del Core y se comunica en JSON Lines por stdio. Faltaba definir cuatro cosas antes de escribir código en la Fase 2:
- quién maneja el estado del turno de voz;
- cómo se mantiene sincronizado el contrato entre TypeScript (Zod) y Python;
- cómo le llegan los secretos al servicio de voz;
- cómo se lanza el proceso bajo Smart App Control.

`ARCHITECTURE.md` §4 tenía un borrador de mensajes, pero sin esquema formal.

## Decisión

**Responsabilidades**
- **El Core orquesta el turno:** maneja la máquina de estados del turno, la conversación, el tope de gasto y la cancelación. También corta el stream de Claude en frases y manda cada una a sintetizar (`tts.speak`). Toda la lógica del turno está en un solo lugar, y si se cae la voz no se pierde la conversación.
- **El Voice Service hace solo entrada y salida de audio:** micrófono, STT, síntesis y reproducción. Emite eventos (transcripción final, inicio y fin de reproducción, barge-in) y no decide nada del turno.

**Contrato**
- El protocolo de voz tiene su propia versión (`VOICE_PROTOCOL_VERSION`, hoy `1.0`), separada de la del protocolo de clientes. Se negocia en `voice.configure` y `voice.ready`. Si la versión mayor no coincide, el servicio queda `degradado`.
- Los esquemas en Zod (`packages/shared/src/voice-protocol.ts`) son la fuente de verdad. El espejo en Python (`services/voice/src/jarvis_voice/protocol.py`) se escribe a mano y es igual de estricto: rechaza campos desconocidos o faltantes.
- **Contrato verificado con fixtures compartidos:** `packages/shared/fixtures/voice-protocol.json` lista mensajes válidos e inválidos en las dos direcciones, y las suites de Vitest y pytest validan contra el mismo archivo. Si un lado cambia sin el otro, falla CI.
- **stdout lleva solo frames del protocolo.** Los logs del servicio salen por stderr en JSON, y el Core los reenvía a su propio logger, que redacta los secretos. Python redirige `sys.stdout` a stderr para que ninguna biblioteca ensucie el canal.

**Secretos**
- Solo el Core lee el Credential Manager. Los secretos que necesite la voz (por ejemplo, la API key de Google TTS) viajan en `voice.configure` por stdio, un canal privado entre padre e hijo.
- El entorno del proceso hijo se limpia: no hereda `ANTHROPIC_API_KEY`, `JARVIS_GOOGLE_TTS_API_KEY` ni `ELECTRON_RUN_AS_NODE`.

**Lanzamiento**
- Comando: `uv run --project services/voice --locked python -m jarvis_voice.service`. Nunca se usan los `.exe` que genera `uv`, porque Smart App Control los bloquea (ADR-009).
- Handshake: 30 s de timeout, que alcanza para el primer `uv run`, que sincroniza el entorno. Si no se encuentra el ejecutable (`ENOENT`/`EACCES`), el servicio pasa directo a `degradado`, porque reintentar no lo arregla.
- Si se cierra stdin, el Core murió: el servicio sale solo y no queda huérfano.
- `JARVIS_VOICE=0` deja al Core solo con texto. `JARVIS_VOICE_DIR` y `JARVIS_UV` permiten cambiar las rutas.

**Interacción (orden de implementación)**
- Primero **push-to-talk**: la UI registra el atajo global y le avisa al Core, y el Core se lo pasa a la voz. El primer barge-in es volver a apretar el atajo mientras Jarvis habla: es determinista y no depende del AEC.
- Después, el **barge-in por VAD** con Silero, que con los auriculares del owner no necesita AEC. La wake word queda para más adelante.

## Alternativas consideradas
- **Orquestar el turno dentro del Voice Service:** tendría menos mensajes, pero duplica la lógica de conversación y de presupuesto en Python, y una caída de la voz se llevaría el turno.
- **Generar JSON Schema desde Zod y validar en Python con `jsonschema` o pydantic:** evita mantener el espejo a mano, pero suma dependencias y un paso de build entre los dos lenguajes. Con un protocolo chico, los fixtures compartidos dan la misma garantía con menos piezas.
- **Que Python lea el Credential Manager con `keyring`:** el formato del *target* que usa `@napi-rs/keyring` no es el mismo que usa `keyring` de Python, así que habría que mantener dos formatos. Además, ampliaría la superficie con acceso a secretos.
- **Pasar la key por variable de entorno al hijo:** es más simple, pero el entorno de un proceso es visible para otros procesos del mismo usuario y se filtra fácil en volcados de diagnóstico.

## Consecuencias
- (+) El estado del turno vive en un solo proceso, y una caída de la voz no corta el texto.
- (+) El contrato está verificado en CI de los dos lados.
- (−) Hay que mantener el espejo de Python a mano. Mientras el protocolo sea chico, el costo es bajo.
- (−) Cada frase a sintetizar cruza el IPC. Son unos pocos cientos de bytes, así que es despreciable frente a la latencia de red del TTS.
