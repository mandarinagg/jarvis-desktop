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
