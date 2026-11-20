# Registro de decisiones (ADR)

Cada decisión técnica relevante se documenta como ADR en `docs/adr/NNN-titulo.md` usando `docs/adr/000-template.md`.
Estados: **Propuesta** → **Aceptada** / **Rechazada** → (**Reemplazada por ADR-XXX**).

| ADR | Título | Estado |
|-----|--------|--------|
| [001](adr/001-core-daemon-y-clientes.md) | Arquitectura Core daemon + clientes | Aceptada |
| [002](adr/002-electron-y-node-core.md) | Electron + Node/TS en vez de Tauri + Rust | Aceptada |
| [003](adr/003-mcp-como-protocolo-de-herramientas.md) | MCP como protocolo de herramientas | Aceptada |
| [004](adr/004-voz-local-first.md) | Pipeline de voz local-first (openWakeWord + Silero + whisper.cpp Vulkan) | Aceptada; la parte de TTS la reemplaza ADR-011 |
| [005](adr/005-router-de-modelos-y-costos.md) | Router de modelos y control de costos | Aceptada |
| [006](adr/006-evolucion-controlada.md) | Evolución controlada: evals + aprobación + git | Aceptada |
| [007](adr/007-persistencia-y-secretos.md) | Persistencia (`node:sqlite`) y secretos (`@napi-rs/keyring`) | Aceptada |
| [008](adr/008-ciclo-de-vida-e-ipc.md) | Ciclo de vida de procesos y transporte IPC | Aceptada |
| [009](adr/009-binarios-nativos-y-smart-app-control.md) | Binarios nativos de voz bajo Smart App Control (whisper.cpp + ggml-vulkan.dll fijados) | Aceptada |
| [010](adr/010-motor-stt-parakeet.md) | Motor de STT: Parakeet TDT 0.6B v3 (Vulkan); whisper turbo contexto completo como alternativo | Aceptada |
| [011](adr/011-motor-tts-google-neural2.md) | Motor de TTS: Google Neural2 (nube) + Piper daniela como fallback offline; reemplaza la parte TTS de ADR-004 | Aceptada |
| [012](adr/012-toolchain-del-monorepo.md) | Toolchain: TypeScript 6 estricto, ESLint 10 flat, Vitest 5, CI en windows-latest | Aceptada |
| [013](adr/013-protocolo-de-voz-y-orquestacion.md) | Protocolo Core↔Voz (fixtures compartidos TS/Python), el Core orquesta el turno, secretos por stdio, push-to-talk primero | Aceptada |
| [014](adr/014-stt-en-proceso-con-parakeet-dll.md) | STT en proceso con `parakeet.dll` vía ctypes (~100 ms, la CLI tardaba 4.7 s), push-to-talk y corrección post-STT | Aceptada |
| [015](adr/015-modo-voz-del-prompt.md) | Modo voz del prompt: `prompts/voice.md` como segundo bloque de `system` sin caché en los turnos hablados; evals con `mode: voice` | Aceptada |
| [016](adr/016-barge-in-por-voz-con-silero.md) | Barge-in por voz: Silero VAD (onnxruntime) mientras Jarvis habla, protocolo de voz 1.1 (`vad.*`), sin AEC por los auriculares; `JARVIS_BARGE_IN=0` lo apaga | Aceptada |
| [017](adr/017-proyectos-indice-y-herramientas-de-lectura.md) | Fase 3: proyectos registrados por el owner, guardia de rutas, FTS5 sin copia del contenido, herramientas de lectura como servidor MCP propio, Permission Engine v0 y audit log | Aceptada |
| [018](adr/018-confirmaciones-y-reglas-del-owner.md) | Fase 4: Permission Engine v1 (allow/ask/deny, destructivas ×2), reglas del owner en `permissions.json` (gana la más segura), confirmación en diálogo nativo del proceso principal (nunca el renderer), audit log consultable y exportable, `recent_activity` | Aceptada |
| [019](adr/019-herramientas-de-escritura.md) | Fase 4: `write_file`, `edit_file`, `delete_file` (papelera de Jarvis), `git_diff` y `git_commit` (sin hooks, sin push, sin secretos); vista previa con diff exacto y huella que el servidor verifica antes de escribir | Aceptada |
| [020](adr/020-servidores-mcp-de-terceros.md) | Fase 4: servidores MCP de terceros en `mcp-servers.json` (solo el owner), un proceso por servidor con entorno mínimo y secretos aparte (`Jarvis MCP`), toda herramienta con confirmación salvo clasificación del owner, anotaciones ignoradas; sin sandbox del SO | Aceptada |
| [021](adr/021-wake-word-hey-jarvis.md) | Fase 4: wake word «Hey Jarvis» con los modelos de openWakeWord sobre onnxruntime (sin el paquete), apagada por defecto, micrófono abierto solo hacia el detector, indicador en la barra de tareas, `wake_events` para medir falsas activaciones; modelos CC BY-NC-SA (uso personal) | Aceptada |
| [022](adr/022-evals-de-seguridad-fase-4.md) | Fase 4: 50 evals (10 de injection) con un proyecto `demo` descartable (repo git, `.env` falso, archivos con instrucciones inyectadas), owner simulado que aprueba o rechaza, chequeos de archivos y git, juez con el registro real de acciones; la corrida falla si alguna acción sensible corrió sin confirmación | Aceptada |
