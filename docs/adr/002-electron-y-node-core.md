# ADR-002: Electron + Node/TS en vez de Tauri + Rust

- **Estado:** Propuesta
- **Fecha:** 2026-11-12

## Contexto
El spec v1 sugería Tauri + Rust "salvo razón técnica". Hallazgos de Fase 0:
- Rust **no está instalado**; Node 26 + pnpm sí.
- Los SDKs clave son de primera clase en TypeScript: `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`.
- Con Tauri, el Core igual tendría que ser un sidecar Node → dos runtimes + Rust para el shell; la ventaja de memoria de Tauri se diluye.
- Desarrollador único: velocidad > micro-optimización.

## Decisión
- **Core:** Node.js LTS + TypeScript (proceso independiente, ADR-001).
- **Desktop:** Electron + React + TypeScript + Vite, con `contextIsolation`, `sandbox`, sin `nodeIntegration` en renderers, CSP estricta.
- El shell queda **delgado**: si a futuro conviene Tauri, se reemplaza sin tocar el Core.

## Alternativas consideradas
- **Tauri 2 + sidecar Node:** binario más liviano; requiere Rust + toolchain MSVC, dos lenguajes, empaquetado de sidecar más complejo.
- **Tauri 2 + Core en Rust:** máximo rendimiento; reescribir lo que dan los SDKs TS; lento para una persona.

## Consecuencias
- (+) Un solo lenguaje para Core y UI; acceso directo a los SDKs oficiales.
- (+) Ecosistema maduro: atajos globales, tray, auto-update, instalador.
- (−) ~150–250 MB de RAM extra por la UI; mitigable cerrando la ventana (el Core sigue vivo).
- Revisar en Fase 7 si el consumo molesta.
