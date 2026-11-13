# Registro de decisiones (ADR)

Cada decisión técnica relevante se documenta como ADR en `docs/adr/NNN-titulo.md` usando `docs/adr/000-template.md`.
Estados: **Propuesta** → **Aceptada** / **Rechazada** → (**Reemplazada por ADR-XXX**).

| ADR | Título | Estado |
|-----|--------|--------|
| [001](adr/001-core-daemon-y-clientes.md) | Arquitectura Core daemon + clientes | Propuesta |
| [002](adr/002-electron-y-node-core.md) | Electron + Node/TS en vez de Tauri + Rust | Propuesta |
| [003](adr/003-mcp-como-protocolo-de-herramientas.md) | MCP como protocolo de herramientas | Propuesta |
| [004](adr/004-voz-local-first.md) | Pipeline de voz local-first (openWakeWord + Silero + whisper.cpp Vulkan) | Propuesta |
| [005](adr/005-router-de-modelos-y-costos.md) | Router de modelos y control de costos | Propuesta |
| [006](adr/006-evolucion-controlada.md) | Evolución controlada: evals + aprobación + git | Propuesta |
| [009](adr/009-binarios-nativos-y-smart-app-control.md) | Binarios nativos de voz bajo Smart App Control (whisper.cpp + ggml-vulkan.dll fijados) | Aceptada |
| [010](adr/010-motor-stt-parakeet.md) | Motor de STT: Parakeet TDT 0.6B v3 (Vulkan); whisper turbo contexto completo como alternativo | Aceptada |
