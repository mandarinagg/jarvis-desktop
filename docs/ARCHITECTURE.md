# Arquitectura

> Estado: **Propuesta** (ver ADR-001, ADR-002, ADR-003). Se valida al cerrar la Fase 0.

## 1. Vista general: Core + Clientes

```
                ┌──────────────────────────── Clientes ────────────────────────────┐
                │  Desktop UI (Electron/React)   Overlay de voz   CLI   (futuro: móvil/Telegram) │
                └───────────────┬───────────────────────────────────────────────────┘
                                │ IPC local autenticado (named pipe + token por sesión)
┌───────────────────────────────▼──────────────────────────────────────────────────┐
│                               JARVIS CORE (Node/TS, daemon)                      │
│                                                                                  │
│  ┌──────────────┐   ┌───────────────────────┐   ┌──────────────────────────┐     │
│  │ Session/Turn │──▶│ Conversation          │──▶│ Model Router             │──▶ Claude API
│  │ Manager      │   │ Orchestrator          │   │ (rápido / normal / deep) │     │
│  └──────────────┘   │ - modos de pensamiento│   └──────────────────────────┘     │
│                     │ - armado de contexto  │                                    │
│                     └──────────┬────────────┘                                    │
│                                │ tool calls                                      │
│                     ┌──────────▼────────────┐   ┌──────────────────────────┐     │
│                     │ Permission Engine     │──▶│ MCP Client Hub           │──▶ Servidores MCP
│                     │ (políticas, confirm.) │   │ (fs acotado, git, cal…)  │     (locales/remotos)
│                     └──────────┬────────────┘   └──────────────────────────┘     │
│                                │                ┌──────────────────────────┐     │
│                                └───────────────▶│ Builder (Claude Agent SDK)│──▶ Workspaces + git
│                                                 └──────────────────────────┘     │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ ┌───────────┐ ┌──────────┐  │
│  │ Memory Store │ │ Project Index│ │ Reflection Job│ │ Audit Log │ │ Cost Mtr │  │
│  │ (SQLite)     │ │ (FTS5+embed) │ │ (scheduler)   │ │ (append)  │ │          │  │
│  └──────────────┘ └──────────────┘ └───────────────┘ └───────────┘ └──────────┘  │
└───────────────────────────────▲──────────────────────────────────────────────────┘
                                │ IPC local (stdio / websocket loopback con token)
┌───────────────────────────────┴──────────────────────────────────────────────────┐
│                     VOICE SERVICE (Python 3.12 + binarios nativos)               │
│   Mic → AEC → Wake word (openWakeWord) → VAD (Silero) → STT (whisper.cpp Vulkan) │
│   Texto → TTS (adaptador: nube / local) → Altavoz          + barge-in            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Componentes

| Componente | Responsabilidad | Tecnología propuesta |
|------------|-----------------|----------------------|
| **Desktop UI** | Ventana, chat, estados, paneles de proyectos/memoria/permisos/costos, confirmaciones | Electron + React + TypeScript + Vite |
| **Overlay de voz** | Indicador siempre visible (escuchando/pensando/hablando), mute | Ventana Electron transparente |
| **Core** | Orquestación, estado, memoria, permisos, auditoría | Node.js LTS + TypeScript, proceso independiente |
| **Model Router** | Elegir modelo/esfuerzo por tipo de turno | `@anthropic-ai/sdk` |
| **MCP Client Hub** | Conectar y gestionar servidores MCP | `@modelcontextprotocol/sdk` |
| **Permission Engine** | Evaluar cada tool call contra políticas; pedir confirmación | Módulo propio en Core |
| **Builder** | Tareas de construcción de software | `@anthropic-ai/claude-agent-sdk` con hooks de permisos |
| **Memory Store** | Memoria episódica/semántica/procedural | SQLite (better-sqlite3) + cifrado de campos sensibles |
| **Project Index** | Índice y búsqueda de archivos autorizados | SQLite FTS5; embeddings locales opcionales |
| **Reflection Job** | Consolidar memoria, proponer aprendizajes | Scheduler en Core |
| **Audit Log** | Registro append-only de acciones | SQLite tabla append-only + export JSONL |
| **Voice Service** | Captura, wake word, VAD, STT, TTS, barge-in | Python 3.12 (uv) + whisper.cpp |
| **Secrets** | API keys | Windows Credential Manager (`keytar` / DPAPI) |

## 3. Flujo de un turno de voz

```
1. Wake word / push-to-talk  ──▶ Voice Service emite `listening_started` (UI muestra indicador)
2. VAD detecta fin de frase  ──▶ STT final (parciales en streaming a la UI)
3. Core recibe texto         ──▶ arma contexto: system + memoria relevante + proyecto activo + historial
4. Router elige modelo       ──▶ stream a Claude
5. Tokens llegan             ──▶ se cortan por frase ──▶ TTS por frase ──▶ audio (primer audio < 1.5 s)
6. Si Claude pide tool       ──▶ Permission Engine ──▶ (confirmación) ──▶ MCP ──▶ resultado ──▶ Claude
7. Usuario interrumpe        ──▶ Voice Service `barge_in` ──▶ Core cancela stream + TTS (< 200 ms)
8. Fin de turno              ──▶ Audit Log + memoria episódica + costo
```

## 4. Contratos de IPC (borrador)

Mensajes JSON con `type`, `id`, `ts`. Ejemplos:

```jsonc
// Voice → Core
{ "type": "stt.final", "id": "u_123", "text": "jarvis qué proyectos tengo activos", "lang": "es", "confidence": 0.93 }
{ "type": "voice.barge_in", "id": "u_124" }
// Core → Voice
{ "type": "tts.speak", "id": "a_77", "text": "Tenés tres proyectos activos.", "final": false }
{ "type": "tts.cancel", "id": "a_77" }
// Core → UI
{ "type": "permission.request", "id": "p_9", "tool": "fs.write", "summary": "Crear notas.md en /proyecto-x", "risk": "medium" }
```

El esquema formal se define con Zod en `packages/shared` y es la única fuente de verdad.

## 5. Datos y almacenamiento

- Todo lo personal vive **fuera del repo**: `%APPDATA%/Jarvis/` (db, índices, logs, config).
- Config de usuario: `%APPDATA%/Jarvis/config.json` (sin secretos).
- Secretos: Windows Credential Manager.
- El repo contiene solo código, docs, evals sintéticos y ejemplos.

## 6. Estructura del monorepo

```
apps/desktop/        UI Electron + React
packages/core/       Jarvis Core (orquestador, memoria, permisos, router, MCP hub)
packages/shared/     Tipos, esquemas Zod de IPC, utilidades
services/voice/      Voice Service (Python + whisper.cpp)
evals/               Conversaciones y tareas doradas + runner
docs/                Especificaciones, ADRs, guías
```

## 7. Decisiones abiertas

- Electron vs Tauri → ADR-002 (propuesta: Electron).
- ~~TTS por defecto (nube vs local)~~ → Google Neural2 con fallback local Piper (ADR-011).
- Embeddings locales: sí/no y cuál → Fase 3.
