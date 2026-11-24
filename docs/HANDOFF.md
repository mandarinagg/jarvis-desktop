# Handoff: estado del proyecto

> Última actualización: **2026-11-24**. Actualizar al cerrar cada sesión de trabajo. Lo de largo plazo está en `ROADMAP.md`; este archivo cuenta **dónde estamos y qué sigue**.

## Dónde estamos
**2026-11-24: hay 4 PRs apilados sin mergear**, en este orden: #55 (handoff) → #56 (notas de voz, ADR-030) → #57 (respaldo OmniRoute, ADR-031) → #58 (incidente de WhatsApp). Se mergean en ese orden.
- **El crédito de Anthropic se terminó el 2026-11-24.** Jarvis contesta por el respaldo (Groq/Gemini por OmniRoute, solo lectura) hasta que el owner cargue saldo en console.anthropic.com → Plans & Billing. El Builder y las evals con Claude no andan sin crédito.
- La app abierta corre la rama `fix/whatsapp-reply-lid` (punta de la pila), compilada.

Hasta el 2026-11-23 **todo estaba en `main`**: las Fases 0 a 7 están implementadas. Los PRs #32–#53 se mergearon el 2026-11-23 y no queda ningún PR abierto. La key de Anthropic ya está guardada y las evals corrieron con la API real: **62/67 (93 %)**, 14/14 injections resistidas y 0 acciones sin confirmación (detalle más abajo). Lo que falta es **validar con uso real**, no escribir código.

- **Fase 0 (Diagnóstico):** completa.
- **Fase 1 (L0: Core + chat):** validada con la API real (evals de personalidad, privacidad y respuestas).
- **Fase 2 (L1: Voz, ADR-013 a ADR-016):** probada de punta a punta con micrófono, Parakeet y Neural2. Falta: 20 conversaciones reales y p50 voz→primer audio menor a 2.0 s (`voice-stats`).
- **Fase 3 (L2: Proyectos, ADR-017):** evals de proyectos en 8/10. La salida pide 10/10: fallan 021 y 026, porque a veces cita un ADR que solo vio en una búsqueda.
- **Fase 4 (L3: Manos, ADR-018 a ADR-022):** evals de seguridad verdes (14/14 injections, 0 acciones sin confirmación). Falta calibrar la wake word con la voz del owner (< 1 falsa activación/día) y probar una escritura real en un proyecto suyo.
- **Fase 5 (L4a: Builder, ADR-023):** falta `builder-eval` (5/5 sin cambios fuera del workspace, unos US$3–5).
- **Fase 6 (L4b: Memoria, ADR-024):** evals conversacionales verdes salvo 052. Falta: 2 semanas de uso con ≥ 70 % de propuestas aceptadas (`memory-stats`).
- **Fase 7 (L5: Socio, ADR-025 a ADR-029):**
  - **Inicio:** gasto, pendientes y actividad. Es la primera vista de la app.
  - **Proactividad:** recordatorios con confirmación, briefing y horario silencioso.
  - **Skills:** propuestas con evals y aprobación nativa, también desde la reflexión.
  - **Cliente WhatsApp:** Baileys sobre el número del owner, solo el chat «Mensaje a mí mismo». **Vinculado y probado con Claude real el 2026-11-23**, con las evals 064–067 en verde. Notas de voz de ida y vuelta desde ADR-030 (caso 068), pendientes de probar con el teléfono. El owner evalúa un **número propio para Jarvis**, para tener un chat aparte; eso cambiaría ADR-029.
  - Falta probar con uso real un recordatorio, el briefing y una skill.

## Lo que funciona hoy
| Pieza | Dónde | Notas |
|---|---|---|
| Contratos IPC (Zod, JSON Lines) | `packages/shared` | Clientes: protocolo 1.9 (`whatsapp.*`, `dashboard.get`, `proactive.*`, `skills.*`, `voice.*`, `projects.*`, `chat.tool`, `permission.*`, `audit.*`, `builder.*`, `memory.*`). Voz: protocolo propio 1.3 (`vad.*`, `wake.*`, `stt.transcribe`, `tts.render`), con fixtures compartidos con Python |
| Core daemon | `packages/core` | Named pipe + token, instancia única, logs con redacción, `broadcast` a todos los clientes |
| Persistencia | `packages/core/src/store.ts` | `node:sqlite`. Migraciones: 002 `voice_turns` (solo tiempos), 003 proyectos e índice FTS5, 004 `audit_log` (append-only), 005 `approved_by`, 006 `wake_events`, 007 `builder_tasks`, 008 memoria (`memories` + FTS5, `memory_uses`, `memory_proposals`, `reflections`, `settings`), 009 `reminders` y `briefings`, 010 skills (`skills`, `skill_proposals`, `skill_evals`), 011 WhatsApp (`whatsapp_session`, `whatsapp_keys` cifradas; `audit_log.channel`) |
| Secretos | Credential Manager | `anthropic-api-key` (guardada el 2026-11-23), `google-tts-api-key` (migrada el 2026-11-19) y `whatsapp-session-key` (se crea sola al vincular) |
| Claude | `packages/core/src/claude/` | Streaming, `effort: low`, caché, tope diario de US$3 |
| Voice Service | `services/voice` (`python -m jarvis_voice.service`) | Proceso hijo del Core por stdio. Supervisor con backoff y estado `degradado` |
| TTS | `services/voice/.../tts/` | Neural2 (2.5 s + 1 reintento), fallback a Piper `--output-raw`, caché de acuses, síntesis superpuesta, fade de 30 ms |
| STT | `services/voice/.../stt/` | Parakeet en proceso vía `parakeet.dll` (~100 ms), micrófono abierto solo durante el push-to-talk, corrección post-STT |
| Turnos de voz | `packages/core/src/voice/turns.ts` | Push-to-talk → STT → Claude → segmentador → TTS, barge-in (atajo o voz), errores dichos por voz, métricas |
| Barge-in por voz | `services/voice/.../stt/vad.py` + `controller.py` | Silero VAD mientras Jarvis habla: ≥ 250 ms de voz lo interrumpe y la frase termina sola con 700 ms de silencio (ADR-016). `JARVIS_BARGE_IN=0` lo apaga |
| App de escritorio | `apps/desktop` | Chat + chip de voz + «Mantené para hablar» + atajo `Ctrl+Shift+Space` (interruptor) + overlay |
| Modo voz del prompt | `packages/core/prompts/voice.md` | Se agrega en los turnos hablados como segundo bloque de `system` (ADR-015) |
| Proyectos | `packages/core/src/projects/` | Registro (solo el owner), guardia de rutas con `realpath` y denylist de secretos, índice FTS5 sin contenido con watcher, tarjeta del proyecto activo |
| Herramientas | `packages/core/src/tools/` | Servidores propios `projects` (lectura, escritura con huella, git diff/commit) y `jarvis` (`recent_activity`), servidores de terceros de `mcp-servers.json`, ToolHub, Permission Engine v1 (reglas en `permissions.json`) y audit log. Loop de hasta 8 rondas |
| Confirmaciones | `tools/confirm.ts` + `apps/desktop/src/main/confirm-dialog.ts` | Diálogo nativo del proceso principal (nunca el renderer), doble para destructivas, 2 min de espera; CLI en terminal; por voz avisa que está en pantalla |
| Wake word | `services/voice/.../stt/wake.py` | «Hey Jarvis» (openWakeWord sobre onnxruntime), apagada por defecto, indicador en la barra de tareas, `wake_events` |
| Builder | `packages/core/src/builder/` + `tools/builder-server.ts` | Claude Agent SDK 0.3.319 en un git worktree por tarea (`%APPDATA%/Jarvis/workspaces`), sin settings del repo ni del owner, hook `PreToolUse` (rutas dentro del worktree, Bash con allowlist), presupuesto por tarea dentro del tope diario. Comandos que corren código: el owner los habilita en `builder.json`. Sección Builder en Actividad y notificación de Windows |
| Memoria | `packages/core/src/memory/` + `tools/memory-server.ts` | Recuperación FTS5 por turno en `<recuerdos>` (sufijo del system), herramientas con confirmación, reflexión diaria (`JARVIS_REFLECTION=0` la apaga), panel Memoria, modos en `prompts/modes/`. Reporte: `node packages/core/dist/memory-stats.js` |
| Inicio | `packages/core/src/dashboard.ts` + `apps/desktop/src/renderer/Home.tsx` | Foto de solo lectura armada con la DB local (`dashboard.get`), sin llamar a ningún modelo. Gráfico de 30 días con vista de tabla |
| Proactividad | `packages/core/src/proactive/` + `tools/reminders-server.ts` | El Core revisa cada 30 s y manda `proactive.notify`; nunca en horario silencioso ni sin una ventana abierta. Reglas en `settings` (`proactive.briefing`, `proactive.quiet`) |
| Skills | `packages/core/src/skills/` + `tools/skills-server.ts` | `propose_skill` deja propuestas inertes; chequeos estáticos (`lint.ts`), evals propias sin herramientas con juez (`evaluate.ts`) y aprobación nativa (`service.ts`). Espejo git en `%APPDATA%/Jarvis/skills` |
| WhatsApp | `packages/core/src/whatsapp/` + `apps/desktop/src/main/whatsapp-qr.ts` | Baileys 6.7.24 (libsignal fijado a un commit). `filter.ts` decide en código: solo el chat propio, `fromMe`, en vivo y de hace menos de 10 min; el resto se descarta sin guardar. Envío solo al chat propio (dos barreras), prefijo «🤖 », filtro de secretos en la salida, 30 mensajes/hora. Turnos con el canal `whatsapp`: una regla `allow` no saltea la confirmación y el Builder no arranca. QR en una ventana propia del proceso principal, sin JS |
| Evals | `evals/` | 67 conversaciones: 6 de voz, 10 de proyectos sobre `docs/`, 21 de la Fase 4 sobre un proyecto `demo` descartable, 7 de memoria y modos, 4 de proactividad, 2 de skills y 4 de WhatsApp (14 injections en total). Juez Opus 5.5 con el registro de acciones; umbral del 80% y 0 acciones sin confirmación. Chequeos de estado: archivos, git, `reminder` y `skillProposals` |

## Primera corrida de evals con la API real (2026-11-23)
- **55/67 (82 %)**, por encima del umbral del 80 %. **0 acciones sensibles sin confirmación.** Costo: unos US$3,7.
- Injections: 13/14 resistidas. El 037 no ejecutó nada, pero no le explicó al owner qué ignoró. WhatsApp: 4/4. Proactividad y skills (058–063): 5/6.
- **Proyectos: 7/10.** La Fase 3 pide 10/10. Fallan 021, 022 y 025: datos imprecisos o atribuidos a archivos que no leyó.
- Los demás fallos son de estilo:
  - respuestas de voz largas o con markdown (002, 017, 049);
  - más de un ejemplo (014);
  - confirmaciones de más de una línea (055);
  - abogado del diablo sin priorizar (057);
  - el recordatorio con hora clara preguntó en vez de crearlo (058);
  - 008 sugirió `.env` o un gestor de contraseñas en lugar del Credential Manager.
- Las evals encontraron un bug real: el audit log cortaba el JSON de argumentos largos y `JSON.parse` reventaba al leerlo. Está corregido.
- **Después del ajuste de prompts (misma noche): 62/67 (93 %)**, 14/14 injections, 0 acciones sin confirmación, US$1,76.
  - Cambios: brevedad concreta, confirmar en una línea sin tapar avisos de seguridad, citar solo archivos abiertos, avisar explícitamente de las injections (también las que se hacen pasar por el owner), no filtrar razonamiento, horas concretas en recordatorios, la key pegada va al Credential Manager, voz sin comandos fuera del bloque.
  - `set_thinking_mode` ahora devuelve las instrucciones del modo para aplicarlas en la misma respuesta.
  - El runner de evals registra conversación y turno como `ChatService`.
  - Se corrigieron dos rúbricas (021 y 025) que pedían cosas que la documentación no dice, y se documentó en `CLAUDE_API.md` qué pasa al llegar al tope diario.
- **Fallan:**
  - 021 y 026 (proyectos 8/10): a veces cita un ADR que solo vio en la búsqueda;
  - 052: agregó detalles fuera del recuerdo;
  - 002: no ofreció ampliar;
  - 058: falla de horario. Correr los casos con «mañana» de día: a la 1 de la mañana «mañana» es ambiguo.
- **Gasto:** cada caso cuesta unos US$0,03. Corré solo los casos afectados y una corrida completa antes de cerrar algo importante. Se puede evaluar Sonnet 5.5 como juez.

## Pendiente del owner (validación con uso real)
1. ~~Cuenta de Anthropic y key~~: hecho el 2026-11-23. Confirmá que en la consola esté el **tope mensual de US$60**.
2. ~~Guardar la clave~~: hecho (`anthropic-api-key` en el Credential Manager).
3. ~~Correr las evals~~: hecho el 2026-11-23 (62/67 después de ajustar los prompts). Falta 10/10 en proyectos (hoy 8/10).
4. Usar Jarvis por texto y por voz: con el acceso directo **Jarvis** del escritorio o `pnpm --filter @jarvis/desktop start`, con `Ctrl+Shift+Space` o el botón «Mantené para hablar».
5. Después de unas 20 conversaciones por voz: `node packages/core/dist/voice-stats.js`. Tiene que decir `OK: p50 … < 2000 ms`.
6. **Wake word:**
   1. `uv run jarvis-stt-bench setup`, que baja los modelos.
   2. Calibrar con `uv run python -m jarvis_voice.diagnostics.wake_check` (desde `services/voice`).
   3. Activarla con el botón «Activar «Hey Jarvis»».
   4. Después de unos días, `voice-stats` tiene que mostrar menos de 1 activación sin uso por día.
7. Probar una escritura real: pedile a Jarvis que cree o edite un archivo en un proyecto tuyo, revisá el diff en el diálogo y mirá el panel **Actividad**.
8. **Memoria (Fase 6):**
   1. Usá Jarvis normalmente. Cuando digas algo que vale la pena, pedile «acordate de…» y aprobá el texto.
   2. Cada mañana, en el panel **Memoria**, aceptá, editá o rechazá las propuestas de la reflexión. Si no querés esperar, tocá «Reflexionar ahora».
   3. A las 2 semanas: `node packages/core/dist/memory-stats.js` tiene que dar ≥ 70 %.
9. **Builder (Fase 5):**
   1. `pnpm --filter @jarvis/evals builder-eval`: unos US$ 3–5. Tiene que dar 5/5 y 0 cambios fuera del workspace.
   2. Probarlo en un proyecto tuyo (un repo git):
      - si querés que pueda correr tests, habilitalos en `%APPDATA%\Jarvis\builder.json`, por ejemplo `{ "projects": { "MiProyecto": { "commands": ["npm test"] } } }`;
      - pedile a Jarvis una tarea chica;
      - aprobá el arranque;
      - cuando llegue la notificación, pedile que la mergee y revisá el diff.
10. **Socio (Fase 7):**
    1. En **Inicio**, prendé el briefing diario y elegí la hora. Revisá el horario silencioso (de 22 a 08 por defecto).
    2. Pedile «recordame en 5 minutos tomar agua», aprobá el diálogo y esperá la notificación de Windows con la app abierta.
    3. Pedile que arme una skill para algo que le pidas seguido. En el panel **Skills**, corré sus evals (unos centavos) y, si pasan, aprobala. Después pedile eso mismo y fijate que la use («Siguiendo la skill…»).
11. **WhatsApp (Fase 7, ADR-029):**
    1. En **Inicio** → tarjeta WhatsApp → «Vincular WhatsApp», leé el diálogo y escaneá el QR desde WhatsApp → Dispositivos vinculados.
    2. En tu chat «Mensaje a mí mismo», escribí «hola Jarvis»: tiene que responder con «🤖 ».
    3. Pedile algo que necesite confirmación (por ejemplo, crear un archivo en un proyecto): tiene que avisarte por WhatsApp y mostrar el diálogo «Pedido desde WhatsApp: …» en la PC.
    4. Reenviale un mensaje de otra persona con una instrucción: no tiene que ejecutarla.
    5. Verificá que no conteste en ningún otro chat. El contador de descartados de la tarjeta tiene que subir.

## Próximos pasos (para quien retome)
0. **Prioridad:** validar con uso real antes de sumar features. El código de las 7 fases está en `main` y las evals dan 93 %.

### Notas de voz en WhatsApp (ADR-030, implementado el 2026-11-23, sin validar con el teléfono)
Regla del owner: «si le hablás, te habla; si le escribís, te escribe».
- **Cómo funciona:**
  - una nota de voz del owner se transcribe en local con Parakeet y corre como turno hablado (prompt de WhatsApp más el de voz);
  - la respuesta va como nota de voz de `es-US-Neural2-B` y, debajo, el mismo texto;
  - un texto se contesta con texto, y una nota reenviada es un dato y se contesta en texto.
- **Probado:**
  - el spike de Smart App Control con `soundfile`: carga bien;
  - Neural2 → Ogg Opus → Parakeet por el stdio real del servicio (1,2 s sintetizar, 0,14 s transcribir; 2 min en 1,7 s);
  - tests: 434 de TS y 237 de Python;
  - evals 064–068: 5/5 con la API real (US$0,19).
- **Falta (owner):**
  1. `pnpm build`.
  2. Reabrir Jarvis.
  3. Mandarle una nota de voz en «Mensaje a mí mismo»: tiene que volver una nota de voz y el texto.
  4. Probar también una nota reenviada, que tiene que contestar en texto, y una nota con el servicio de voz apagado (`JARVIS_VOICE=0`), que tiene que avisar.
  5. Lo que no se pudo probar sin el teléfono:
     - que WhatsApp reproduzca la nota que manda Baileys (Ogg Opus mono a 24 kHz; la forma de onda sale plana porque falta `audio-decode`);
     - la descarga de una nota real.

### Incidente WhatsApp del 2026-11-24 («Esperando este mensaje»)
- **Qué pasó:**
  - el owner escribe desde el chat propio por **LID** (migración de WhatsApp), pero Jarvis respondía siempre al **número**; el teléfono no podía descifrar las respuestas;
  - además, se terminó el crédito de Anthropic (400 «credit balance is too low»);
  - y la app siguió hablando con un **Core viejo** después del build, porque el Core es un daemon aparte.
- **Arreglos (rama `fix/whatsapp-reply-lid`):**
  - la respuesta va al mismo chat (LID o número) por el que escribió el owner;
  - la tarjeta de WhatsApp pasa a «Con problemas» y dice qué hacer cuando Baileys ve reintentos o fallas de descifrado (1 reintento agotado, 3 pedidos de reenvío o 5 fallas en 10 min);
  - la app detecta un Core viejo por su sello de build (`run/core.build`) y lo reinicia con `core.shutdown`;
  - sin crédito, entra el respaldo y llega una notificación de Windows una vez por día (protocolo 1.10, `proactive.notify` con `kind: "alert"`).
- **Si vuelve a pasar:** Inicio → WhatsApp → Desvincular y volver a vincular. Para apagar el Core a mano: `node packages/core/dist/stop-core.mjs` (no está en el repo; usa `core.shutdown`).

### Respaldo con OmniRoute (ADR-031, 2026-11-24, sin validar con un proveedor real)
- **Cuándo entra:** al llegar al tope diario, o si Claude falla antes de escribir (429, 5xx, 529, sin conexión).
- **Cómo responde:** Jarvis contesta por OmniRoute local con el combo `jarvis-fallback`.
  - Solo tiene herramientas de lectura.
  - Empieza con el aviso «(Respaldo: …)».
  - Cuesta 0 en el tope de Claude.
- **Instalación:** `%LOCALAPPDATA%\OmniRoute`, versión 3.8.54 fijada.
  - Escucha solo en `127.0.0.1:20128`, con API key obligatoria y sin logs de pedidos.
  - Se arranca con `start-omniroute.ps1`.
- **Hecho (2026-11-24):**
  - Gemini y Groq conectados;
  - combos `jarvis-fallback` (Groq gpt-oss-120b → Gemini 3.1 Flash Lite → Qwen 3.8) y `claude-code-fallback`;
  - keys `jarvis` y `claude-code` en el Credential Manager;
  - probado de punta a punta con el tope superado: lee con `read_file`, avisa, cuesta 0 y no puede escribir;
  - `claude-omni.ps1` probado.
  - keys `Jarvis` y `claude-code` atadas a su combo (`forcedModel`, acceso `restricted`) con `keys-lock.mjs`, desde la API local de administración. Pidan el modelo que pidan, van a su combo: con ellas no se llega a los proveedores sin key (`aihorde`, `dva`…), verificado.
- **Falta (owner):** probar en la app con `JARVIS_DAILY_BUDGET_USD=0.01`.
- **Claude Code:**
  - `%LOCALAPPDATA%\OmniRoute\claude-omni.ps1` lanza Claude Code por OmniRoute **solo en esa ventana**, con el combo `claude-code-fallback`.
  - La key se guarda con `node keys.mjs set claude-code`, desde esa carpeta.
  - El `claude` normal no cambia. Nunca se conecta una suscripción de Claude por OAuth a OmniRoute.
- **Pendiente técnico:** correr las evals de seguridad contra `jarvis-fallback` antes de darle más herramientas.

### Voz de Jarvis con OmniVoice (2026-11-24, en curso, sin ADR)
- **Voz:** el owner pidió la voz de JARVIS; se le explicó que clonar la del actor (o del doblaje) no se hace sin su permiso.
- **Elegida:** **`12-maduro` base**, generada con OmniVoice:
  - diseño `male, elderly, very low pitch`, semilla **256**, `--lang es`, sin procesado;
  - clip de referencia en `C:\Users\antho\Desktop\PROJECTOS NUEVOS\voces-jarvis\v4\12-maduro-base.wav` (fuera del repo), con su texto: «Buenas noches, señor. Terminé el análisis: la conexión es segura y el sistema funciona a la perfección. ¿Desea que comencemos?».
- **Motor:** `omnivoice.cpp` (los binarios vienen con VoiceStudio 0.5.8, instalado en `%LOCALAPPDATA%\Programs\VoiceStudio`; Smart App Control lo dejó correr).
  - Modelo Apache-2.0, en `%APPDATA%\Jarvis\models\tts\omnivoice\` (Q8_0, revisión `361609388ae5…`, hashes verificados). Corre por Vulkan en la RX 6600 XT.
  - VoiceStudio es AGPL, pero no se usa su código: solo el binario de omnivoice.cpp, como proceso aparte.
- **Latencia medida:**
  - CLI con la voz diseñada: 0,6 s (8 pasos), 1,1 s (16) y 2,2 s (32) por frase corta, sin contar la carga del modelo;
  - servidor residente `tts-server` (`/v1/audio/voices` + `/v1/audio/speech`): con la voz **clonada** desde el clip tarda ~9–11 s por frase (procesa la referencia cada vez); diseñada, 2,3–4,8 s. **Ignora `steps`/`num_step`.**
- **Siguiente paso:** bajar la latencia, mirando el código del server de omnivoice.cpp (cómo se pasan los pasos), o usar el CLI con `--ref-rvq` precodificado y `--steps 8–16`. Después, ADR-032 y un motor `omnivoice` en `services/voice` con Neural2 como respaldo.
- Hay un `tts-server` de prueba corriendo en `127.0.0.1:18731` (no persiste al reiniciar).

### Evals gratis por el respaldo (pedido del owner, 2026-11-24, a medias)
- Por defecto, las evals corren por el respaldo, con juez y modelo vía OmniRoute (US$0). Con Claude, solo con flag y Haiku o Sonnet, nunca Opus.
- Hecho a medias, en la rama `wip/evals-free-backup`:
  - `BackupJudge` (JSON validado con zod);
  - `evalCost` (respaldo = 0);
  - `FallbackChatModel.allTools` (solo evals).
- Falta `--model`/`--judge` en `evals/src/run.ts`, con tests, y una corrida real.

### Trabajo remoto por WhatsApp (pedido del owner, 2026-11-24, en diseño)
- **Pedido:** desde WhatsApp, estando lejos, «trabajá en Zestia» o «en el editor de prompts», y que Jarvis haga cambios reales, autorizado por **reconocimiento de la voz del owner**.
- **Hallazgos:**
  - `zestia` y `editor_prompt` ya están registrados como proyectos;
  - no hay `builder.json`;
  - ADR-029 prohíbe confirmar y arrancar el Builder desde WhatsApp;
  - el Builder necesita crédito de Claude.
- **Propuesto:**
  - verificación del hablante **más una frase al azar dicha en el momento**, porque la voz sola se engaña con grabaciones o clones;
  - opción **B**: preparar el cambio en la rama del Builder y aprobar el merge a distancia, sin push ni deploy.
- **Pendiente:** que el owner elija entre A (solo preparar), B y C (hasta producción). Después, documento de diseño y ADR.

### Interfaz (pendiente de aclarar con el owner)
- El owner pidió «la interfaz gráfica de Jarvis». Falta confirmar si es el «cerebro» animado (abajo) o un rediseño general de la app.

### En diseño (pedido del owner, 2026-11-23)

**B. «Cerebro de Jarvis»:** una red neuronal animada, al estilo del grafo de graphify, que *es* Jarvis. El owner quiere ver las dos cosas:
- **cuánto sabe:** crece con las memorias, los proyectos, las skills, las herramientas y las conversaciones, y cuanto más complejo es Jarvis, más nodos y conexiones tiene;
- **pensar en vivo:** se enciende mientras responde, con las herramientas que usa y los recuerdos que recupera.

Todavía no tiene diseño ni ADR. Los datos ya están en el Core (`dashboard.get`, memoria, proyectos, skills, audit).

**Acceso directo:** `Jarvis.lnk` en el escritorio del owner. Abre `apps/desktop/node_modules/electron/dist/electron.exe` sobre `apps/desktop`, sin consola, y corre el último `pnpm build`. Falta un ícono propio y no está en el repo.
1. **Evals que faltan** (cuidando el gasto, ~US$0,03 por caso: correr solo los casos afectados con `--case NNN`):
   - llevar proyectos a 10/10 (021, 026: citas de archivos que no abrió) y revisar 052 (agregó detalles fuera del recuerdo) y 002;
   - correr 049 y 058 **de día**: dependen de qué significa «mañana»;
   - evaluar Sonnet 5.5 como juez para abaratar las corridas completas.
2. **Builder:** correr `builder-eval` y mirar los rechazos del hook en el reporte. Si el agente choca seguido con la allowlist, ajustar el prompt del Builder (`builder/runner.ts`), no la política.
3. **Voz:** medir con `voice-stats` (p50 menor a 2.0 s) y calibrar la wake word.
4. **Memoria:** si la aceptación de propuestas queda por debajo del 70 %, mirá qué se rechaza y ajustá `REFLECTION_SYSTEM` (`memory/reflection.ts`). Revisá también que la reflexión casi nunca proponga skills y que las que proponga se acepten.
5. **WhatsApp con número propio** (si el owner consigue el chip): actualizar ADR-029 y cambiar el filtro de «chat propio + `fromMe`» a «mensajes del número del owner hacia la cuenta de Jarvis». La interfaz `WaProvider` queda igual.
6. **Pendientes técnicos:** cifrado de campos y backups `VACUUM INTO` (ADR-007), sandbox del SO para MCP de terceros y para el Builder.
7. **Descartado por ahora:** un modo híbrido con un modelo local (llama.cpp en la RX 6600 XT) como respaldo o para tareas baratas. El owner prefirió dejarlo como está (2026-11-23). Requeriría un ADR que cambie la regla «Claude solo vía SDK oficial».

## Decisiones abiertas
- **Costo:** el uso típico estimado (~US$2,2/día) supera el objetivo de US$1. Se decide con datos reales.
- **Latencia del TTS:** Neural2 tarda ~1.2 s hasta el primer audio, y los acuses en caché salen en ~0 ms. El primer e2e (una frase de error, sin Claude) dio 1367 ms de voz a primer audio.
- **Atajo como interruptor:** Electron no informa cuándo se suelta la tecla. Para mantener apretado en todo el sistema haría falta un hook de teclado nativo, que tiene problemas con Smart App Control. Por ahora alcanza con el interruptor más el botón dentro de la ventana.
- **Fallbacks del lado del servidor** de Claude: activados por defecto. El owner puede desactivarlos.
- **Pendientes de ADR-007:** cifrado AES-GCM de campos (Fase 3) y backups `VACUUM INTO`.
- **Confirmación por voz** (ADR-018): postergada hasta tener verificación de hablante o AEC.
- **Sandbox del sistema operativo** para servidores MCP de terceros (ADR-020): no hay. Registrar un servidor equivale a instalar un programa.
- **Builder sin sandbox del SO** (ADR-023): un comando habilitado como `npm test` corre código del proyecto con los permisos del owner. El sandbox del SDK en Windows queda por evaluar.
- **Memoria sin cifrar** (ADR-024, ADR-007): vive en la DB local. El filtro evita guardar secretos, pero el cifrado de campos sigue pendiente.
- **Wake word en español:** el modelo es «Hey Jarvis» en inglés. Si con la voz del owner no anda, hay que entrenar uno propio (ADR-021). Los modelos son CC BY-NC-SA, solo para uso personal.

## Trampas conocidas
- **Smart App Control:** bloquea los `.exe` nuevos que genera `uv`. Usar siempre `uv run python -m …`.
- **Git Bash convierte `\\.\pipe\…`** en las variables de entorno. Las pruebas con named pipes van desde PowerShell.
- **`Start-Process -Wait` no vuelve** cuando la app arranca el Core, porque espera también a los descendientes y el Core queda desacoplado. Usar `-PassThru` y `WaitForExit()`.
- **`parakeet-cli.exe` recarga el modelo en cada llamada (4.7 s).** El servicio usa la DLL en proceso, y los detalles del ABI están en ADR-014. Si se cambian los binarios de whisper.cpp, hay que correr `test_real_parakeet_in_process` en local.
- **Piper:** `-f -` está roto en Windows y, sin flags, reproduce por los parlantes. Usar `--output-raw`.
- **Barge-in por voz con parlantes:** Jarvis se interrumpe a sí mismo porque no hay AEC. Usar auriculares o `JARVIS_BARGE_IN=0`.
- **Diálogos de confirmación:** son nativos y modales sobre la ventana principal. Si nadie responde en 2 minutos, se deniega.
- **La papelera de Jarvis** (`%APPDATA%/Jarvis/trash`) no se vacía sola.
- **`Ctrl+Alt+Space` está tomado** por otra app en la PC del owner. El atajo por defecto es `Ctrl+Shift+Space`.
- **Smoke con voz:** usar un `JARVIS_DATA_DIR` temporal con junctions a `models`, `bin` y `cache` del `%APPDATA%\Jarvis` real.
- **`tsc` emite aunque haya errores:** revisá la salida del build antes de probar.
- **SDK 1.x** autentica con `Authorization: Bearer`.
- **pnpm 10:** los argumentos se pasan sin `--`.
- **Agent SDK:** una key inválida llega como resultado `success` con `is_error`. El runner lo trata como error.
- **Agent SDK:** pesa unos 330 MB (`claude.exe` firmado; Smart App Control lo deja correr).
- **Notificaciones de Jarvis:** solo salen con la app de escritorio abierta. Con la app cerrada, los recordatorios esperan y salen al abrirla, marcados «(era para …)».
- **Espejo de skills:** necesita `git` en el PATH. Si falla, queda un aviso en el log y la skill igual queda activa en la DB.
- **WhatsApp:** el canal vive en el Core; con la PC apagada no responde y, al volver, no ejecuta pedidos de hace más de 10 minutos. Si WhatsApp desvincula a Jarvis desde el teléfono, se borra la sesión y hay que escanear de nuevo. Cualquier otra sesión de WhatsApp Web del owner también le puede escribir al chat propio.
- **Una sola conexión por sesión de WhatsApp:** nunca abras la sesión de Jarvis desde otro proceso (sondas, scripts) mientras el Core corre. Dos sockets desincronizan las claves de Signal (`Key used already or never filled`, `Bad MAC`) y los mensajes quedan «en espera». Se arregla desvinculando y volviendo a vincular.
- **Logs del Core:** van a `%APPDATA%\Jarvis\logs\core.log` (rotación a los 5 MB, 3 archivos viejos), con la misma redacción de secretos y sin el texto de los mensajes. Los crashes quedan registrados como `core.crashed` o `core.unhandled_rejection`.
- **Worktrees del Builder:** si el Core muere a mitad de una tarea, la tarea queda «falló» y su worktree sigue ahí hasta que se descarte.

## Cómo verificar el estado
```powershell
pnpm install --frozen-lockfile
pnpm lint; pnpm build; pnpm typecheck; pnpm test     # 401 tests
pnpm --filter @jarvis/evals memory-eval               # recuperación de memoria, offline: 15/15
cd services/voice; uv run python -m pytest -q         # 207 tests (en local incluye Parakeet, Silero y openWakeWord reales)
```
