# Handoff: estado del proyecto

> Última actualización: **2026-11-19**. Actualizar al cerrar cada sesión de trabajo. Lo de largo plazo está en `ROADMAP.md`; este archivo cuenta **dónde estamos y qué sigue**.

## Dónde estamos
- **Fase 0 (Diagnóstico):** completa, salvo la cuenta de la API de Anthropic, que la tiene que crear el owner.
- **Fase 1 (L0: Core + chat):** implementada y en `main`. Falta validarla con la API real.
- **Fase 3 (L2: Proyectos y contexto):** **implementada** en los PRs #34–#37 (apilados sobre #32–#33, ADR-017). Incluye el registro de proyectos (la carpeta se elige solo desde el diálogo nativo), el índice FTS5 sin copia del texto con watcher, las herramientas de lectura como servidor MCP propio, el Permission Engine v0, el audit log y el panel de Proyectos. Falta validarla: 10/10 en las evals de proyectos con la API real.
- **Fase 2 (L1: Voz):** **implementada y en `main`** (PRs #27–#31, y el modo voz del prompt y el barge-in por voz en #32–#33, ADR-013 a ADR-016). Se probó de punta a punta con micrófono, Parakeet y Neural2 reales. Falta validarla con la API real: 20 conversaciones y p50 voz→primer audio menor a 2.0 s.

## Lo que funciona hoy
| Pieza | Dónde | Notas |
|---|---|---|
| Contratos IPC (Zod, JSON Lines) | `packages/shared` | Clientes: protocolo 1.2 (`voice.*`, `projects.*`, `chat.tool`). Voz: protocolo propio 1.1 (`vad.*`), con fixtures compartidos con Python |
| Core daemon | `packages/core` | Named pipe + token, instancia única, logs con redacción, `broadcast` a todos los clientes |
| Persistencia | `packages/core/src/store.ts` | `node:sqlite`. Migraciones: 002 `voice_turns` (solo tiempos), 003 proyectos e índice FTS5, 004 `audit_log` (append-only) |
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
| Herramientas | `packages/core/src/tools/` | Servidor MCP `projects` en proceso (listar, buscar, leer, listar carpetas, git), ToolHub, Permission Engine v0 y audit log. Loop de hasta 8 rondas en el adaptador |
| Evals | `evals/` | 29 conversaciones: 4 de voz y 10 de proyectos sobre `docs/` (`src/workspace.ts`). Juez Opus 5.5, umbral del 80% |

## Pendiente del owner (bloquea el cierre de las Fases 1, 2 y 3)
1. Crear la cuenta de la API de Anthropic con **tope mensual de US$60** en la consola.
2. Guardar la clave: `pnpm build` y después `node packages/core/dist/set-secret.js anthropic-api-key`.
3. Correr las evals: `pnpm --filter @jarvis/evals eval` (~US$1,20, 29 casos; tienen que dar ≥ 80%, y los 10 de proyectos, 10/10).
4. Usar Jarvis por texto y por voz: `pnpm --filter @jarvis/desktop start`, con `Ctrl+Shift+Space` o el botón «Mantené para hablar».
5. Después de unas 20 conversaciones por voz: `node packages/core/dist/voice-stats.js`. Tiene que decir `OK: p50 … < 2000 ms`.

## Próximos pasos (para quien retome)
1. **Mergear en orden:** #32 → #33 → #34 → #35 → #36 → #37. Están apilados: GitHub reubica cada base cuando se mergea la anterior.
2. Con la key guardada:
   - correr las evals completas y ajustar `packages/core/prompts/system.md` y `voice.md`;
   - en proyectos, revisar sobre todo que cite el archivo y que no conteste de memoria;
   - registrar un proyecto real del owner y hacerle preguntas.
3. Medir la voz real con `voice-stats`. Si el p50 no baja de 2.0 s, revisar primero el TTS (ADR-011). Probar también el barge-in por voz con auriculares.
4. **Fase 4 (Manos):** el flujo de confirmación del Permission Engine, servidores MCP de terceros aislados, la wake word y herramientas de escritura. Arrancar solo con pedido explícito del owner.

## Decisiones abiertas
- **Costo:** el uso típico estimado (~US$2,2/día) supera el objetivo de US$1. Se decide con datos reales.
- **Latencia del TTS:** Neural2 tarda ~1.2 s hasta el primer audio, y los acuses en caché salen en ~0 ms. El primer e2e (una frase de error, sin Claude) dio 1367 ms de voz a primer audio.
- **Atajo como interruptor:** Electron no informa cuándo se suelta la tecla. Para mantener apretado en todo el sistema haría falta un hook de teclado nativo, que tiene problemas con Smart App Control. Por ahora alcanza con el interruptor más el botón dentro de la ventana.
- **Fallbacks del lado del servidor** de Claude: activados por defecto. El owner puede desactivarlos.
- **Pendientes de ADR-007:** cifrado AES-GCM de campos (Fase 3) y backups `VACUUM INTO`.

## Trampas conocidas
- **Smart App Control:** bloquea los `.exe` nuevos que genera `uv`. Usar siempre `uv run python -m …`.
- **Git Bash convierte `\\.\pipe\…`** en las variables de entorno. Las pruebas con named pipes van desde PowerShell.
- **`Start-Process -Wait` no vuelve** cuando la app arranca el Core, porque espera también a los descendientes y el Core queda desacoplado. Usar `-PassThru` y `WaitForExit()`.
- **`parakeet-cli.exe` recarga el modelo en cada llamada (4.7 s).** El servicio usa la DLL en proceso, y los detalles del ABI están en ADR-014. Si se cambian los binarios de whisper.cpp, hay que correr `test_real_parakeet_in_process` en local.
- **Piper:** `-f -` está roto en Windows y, sin flags, reproduce por los parlantes. Usar `--output-raw`.
- **Barge-in por voz con parlantes:** Jarvis se interrumpe a sí mismo porque no hay AEC. Usar auriculares o `JARVIS_BARGE_IN=0`.
- **`Ctrl+Alt+Space` está tomado** por otra app en la PC del owner. El atajo por defecto es `Ctrl+Shift+Space`.
- **Smoke con voz:** usar un `JARVIS_DATA_DIR` temporal con junctions a `models`, `bin` y `cache` del `%APPDATA%\Jarvis` real.
- **`tsc` emite aunque haya errores:** revisá la salida del build antes de probar.
- **SDK 1.x** autentica con `Authorization: Bearer`.
- **pnpm 10:** los argumentos se pasan sin `--`.

## Cómo verificar el estado
```powershell
pnpm install --frozen-lockfile
pnpm lint; pnpm build; pnpm typecheck; pnpm test     # 234 tests
cd services/voice; uv run pytest -q                   # 188 tests (en local incluye Parakeet y Silero reales)
```
