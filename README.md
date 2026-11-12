# JARVIS Desktop

**Asistente personal de IA por voz y texto, local-first, construido sobre Claude.**
Te escucha cuando lo llamás, conversa a tu nivel, piensa con vos, recuerda lo que importa, construye lo que le pedís y mejora con el tiempo — siempre bajo tu control.

> 🚧 **Estado: Fase 0 — Diagnóstico y diseño.** Todavía no hay app ejecutable. Ver [Roadmap](docs/ROADMAP.md).

## Qué va a hacer

| Nivel | Capacidad |
|-------|-----------|
| L0 | Chat de texto con Claude, historial, clave segura |
| L1 | Voz: push-to-talk, STT local, TTS, interrupción natural |
| L2 | Conoce tus proyectos: busca y resume documentación autorizada |
| L3 | Actúa con herramientas (MCP) bajo permisos, confirmación y auditoría; wake word "Jarvis" |
| L4 | Construye software (Claude Agent SDK) y aprende de tus interacciones |
| L5 | Socio proactivo que propone mejoras de sí mismo, siempre con tu aprobación |

## Principios

- **Local-first** y transparente sobre lo que va a la nube.
- **Nunca escucha en secreto.** Indicador de micrófono siempre visible.
- **Sin acceso irrestricto al sistema.** Toda acción pasa por un motor de permisos y queda auditada.
- **Evoluciona con control:** ningún cambio de comportamiento sin evals y aprobación.
- **Voz original** — no clona la voz de ningún personaje.

## Arquitectura (resumen)

```
Clientes (Desktop / Overlay / CLI) ──IPC──▶ Jarvis Core (Node/TS) ──▶ Claude API
                                              │  ├─ Permission Engine ─▶ MCP servers
                                              │  ├─ Builder (Claude Agent SDK)
                                              │  └─ Memoria · Índice · Auditoría · Costos
Voice Service (Python: wake word, VAD, whisper.cpp, TTS) ──IPC──┘
```

Detalle en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentación

| Documento | Contenido |
|-----------|-----------|
| [PM_ANALYSIS](docs/PM_ANALYSIS.md) | Análisis, brechas, propuestas, riesgos y KPIs |
| [PRODUCT_SPEC](docs/PRODUCT_SPEC.md) | Spec v2 del producto |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Componentes, flujos, IPC |
| [ROADMAP](docs/ROADMAP.md) | Fases con criterios de salida |
| [DECISIONS](docs/DECISIONS.md) | Índice de ADRs |
| [VOICE_PIPELINE](docs/VOICE_PIPELINE.md) | Voz, latencia, barge-in |
| [CLAUDE_API](docs/CLAUDE_API.md) | Integración con Claude |
| [TOOLS_AND_PERMISSIONS](docs/TOOLS_AND_PERMISSIONS.md) | Herramientas, permisos, auditoría |
| [MEMORY_AND_CONTEXT](docs/MEMORY_AND_CONTEXT.md) | Memoria en capas y aprendizaje |
| [EVOLUTION](docs/EVOLUTION.md) | Cómo evoluciona de forma segura |
| [PRIVACY_AND_SECURITY](docs/PRIVACY_AND_SECURITY.md) | Amenazas y controles |
| [ENVIRONMENT_AUDIT](docs/ENVIRONMENT_AUDIT.md) | Diagnóstico del equipo objetivo |
| [INSTALLATION](docs/INSTALLATION.md) · [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) | Guías |
| [Spec original v1](docs/archive/00_SPEC_ORIGINAL.md) | Documento fundacional |

## Estructura

```
apps/desktop/      UI Electron + React
packages/core/     Jarvis Core
packages/shared/   Tipos y contratos IPC
services/voice/    Servicio de voz (Python)
evals/             Evaluaciones de calidad y seguridad
docs/              Documentación y ADRs
```

## Contribuir

Ver [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilidades: [SECURITY.md](SECURITY.md).

## Licencia

[MIT](LICENSE). "JARVIS" es un nombre de trabajo; el nombre y la palabra de activación son configurables. Proyecto independiente, sin afiliación con Marvel/Disney ni con Anthropic.
