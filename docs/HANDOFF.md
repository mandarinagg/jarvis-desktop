# Handoff: estado del proyecto

> Última actualización: **2026-11-20**. Actualizar al cerrar cada sesión de trabajo. Lo de largo plazo está en `ROADMAP.md`; este archivo cuenta **dónde estamos y qué sigue**.

## Dónde estamos
- **Fase 0 (Diagnóstico):** completa, salvo la cuenta de la API de Anthropic, que la tiene que crear el owner.
- **Fase 1 (L0: Core + chat):** implementada y en `main`. Falta validarla con la API real.
- **Fase 6 (L4b: Memoria que aprende):** **implementada** en los PRs #45–#46 (apilados sobre #44, ADR-024):
  - memoria de datos, preferencias, procedimientos, ideas y episodios que se recupera en cada turno como datos;
  - guardar siempre pide confirmación nativa, con filtro de secretos;
  - `explain` muestra qué recuerdos usó;
  - reflexión diaria con propuestas aprobables;
  - panel Memoria;
  - modos sparring, brainstorm y abogado del diablo;
  - evals de recuperación (15/15 offline) y 7 casos conversacionales.
  Falta validarla: 2 semanas de uso con ≥ 70 % de propuestas aceptadas (`memory-stats`) y los casos 051–057 con la API real.
- **Fase 5 (L4a: Builder):** **implementada** en los PRs #43–#44 (apilados sobre #42, ADR-023):
  - Jarvis le pasa tareas de software a un agente del Claude Agent SDK;
  - el agente trabaja en un git worktree por tarea, fuera de la carpeta del proyecto, con hook de permisos, allowlist de comandos y presupuesto;
  - el owner aprueba el arranque y el diff completo antes del merge;
  - hay 5 tareas reales de salida con tests de aceptación ocultos.
  Falta validarla con la API real: `builder-eval` tiene que dar 5/5 sin cambios fuera del workspace.
- **Fase 4 (L3: Manos):** **implementada** en los PRs #38–#42 (apilados sobre #37, ADR-018 a ADR-022):
  - confirmaciones del owner en un diálogo nativo, con reglas y audit log consultable;
  - escritura y git con vista previa exacta y huella;
  - servidores MCP de terceros;
  - wake word «Hey Jarvis»;
  - 50 evals con 10 ataques de injection.
  Falta validarla con la API real (0 acciones sin confirmación) y calibrar la wake word con la voz del owner (< 1 falsa activación/día).
- **Fase 3 (L2: Proyectos y contexto):** **implementada** en los PRs #34–#37 (apilados sobre #32–#33, ADR-017). Incluye el registro de proyectos (la carpeta se elige solo desde el diálogo nativo), el índice FTS5 sin copia del texto con watcher, las herramientas de lectura como servidor MCP propio, el Permission Engine v0, el audit log y el panel de Proyectos. Falta validarla: 10/10 en las evals de proyectos con la API real.
- **Fase 2 (L1: Voz):** **implementada y en `main`** (PRs #27–#31, y el modo voz del prompt y el barge-in por voz en #32–#33, ADR-013 a ADR-016). Se probó de punta a punta con micrófono, Parakeet y Neural2 reales. Falta validarla con la API real: 20 conversaciones y p50 voz→primer audio menor a 2.0 s.

## Lo que funciona hoy
| Pieza | Dónde | Notas |
|---|---|---|
| Contratos IPC (Zod, JSON Lines) | `packages/shared` | Clientes: protocolo 1.5 (`voice.*`, `projects.*`, `chat.tool`, `permission.*`, `audit.*`, `builder.*`, `memory.*`). Voz: protocolo propio 1.2 (`vad.*`, `wake.*`), con fixtures compartidos con Python |
| Core daemon | `packages/core` | Named pipe + token, instancia única, logs con redacción, `broadcast` a todos los clientes |
| Persistencia | `packages/core/src/store.ts` | `node:sqlite`. Migraciones: 002 `voice_turns` (solo tiempos), 003 proyectos e índice FTS5, 004 `audit_log` (append-only), 005 `approved_by`, 006 `wake_events`, 007 `builder_tasks`, 008 memoria (`memories` + FTS5, `memory_uses`, `memory_proposals`, `reflections`, `settings`) |
| Secretos | Credential Manager | `anthropic-api-key` (falta) y `google-tts-api-key` (migrada el 2026-11-19) |
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
| Evals | `evals/` | 50 conversaciones: 6 de voz, 10 de proyectos sobre `docs/` y 21 de la Fase 4 sobre un proyecto `demo` descartable (10 injections en total). Juez Opus 5.5 con el registro de acciones; umbral del 80% y 0 acciones sin confirmación |

## Pendiente del owner (bloquea el cierre de las Fases 1 a 4)
1. Crear la cuenta de la API de Anthropic con **tope mensual de US$60** en la consola.
2. Guardar la clave: `pnpm build` y después `node packages/core/dist/set-secret.js anthropic-api-key`.
3. Correr las evals: `pnpm --filter @jarvis/evals eval` (~US$3, 50 casos). Tienen que dar ≥ 80%, los 10 de proyectos 10/10 y **0 acciones sensibles sin confirmación**.
4. Usar Jarvis por texto y por voz: `pnpm --filter @jarvis/desktop start`, con `Ctrl+Shift+Space` o el botón «Mantené para hablar».
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

## Próximos pasos (para quien retome)
1. **Mergear en orden:** #32 → #33 → … → #37 → #38 → … → #42 → #43 → #44 → #45 → #46. Están apilados: GitHub reubica cada base cuando se mergea la anterior.
2. Con la key guardada:
   - correr las evals completas y ajustar `packages/core/prompts/system.md` y `voice.md`;
   - en la Fase 4, revisar sobre todo que una injection nunca genere un pedido de permiso, que anuncie el cambio antes de pedir el OK y que no reintente un rechazo.
3. Medir la voz real con `voice-stats` (p50 menor a 2.0 s) y calibrar la wake word.
4. Con la key, correr `builder-eval` y mirar los rechazos del hook en el reporte. Si el agente choca seguido con la allowlist, ajustar el prompt del Builder (`builder/runner.ts`), no la política.
5. Si la aceptación de propuestas queda por debajo del 70 %, mirá qué se rechaza y ajustá `REFLECTION_SYSTEM` (`memory/reflection.ts`). Si `memory-eval` empieza a fallar con recuerdos reales, evaluá embeddings locales (ADR-024).
6. **Fase 7 (Socio):** proactividad con reglas, skills propuestas por Jarvis con evals, clientes móviles. Arrancar solo con pedido explícito del owner.

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
- **Worktrees del Builder:** si el Core muere a mitad de una tarea, la tarea queda «falló» y su worktree sigue ahí hasta que se descarte.

## Cómo verificar el estado
```powershell
pnpm install --frozen-lockfile
pnpm lint; pnpm build; pnpm typecheck; pnpm test     # 322 tests
pnpm --filter @jarvis/evals memory-eval               # recuperación de memoria, offline: 15/15
cd services/voice; uv run python -m pytest -q         # 207 tests (en local incluye Parakeet, Silero y openWakeWord reales)
```
