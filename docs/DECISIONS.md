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
