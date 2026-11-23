# Roadmap

Cada fase cierra con **exit criteria medibles**. No se empieza una fase sin cerrar la anterior (excepto spikes de investigación). Sprints de 2 semanas; estimaciones para 1 persona part-time con Claude Code.

| Fase | Nivel | Objetivo | Duración est. |
|------|-------|----------|---------------|
| 0 | — | Diagnóstico y decisiones | 1 semana |
| 1 | L0 | Core + chat de texto | 2 semanas |
| 2 | L1 | Voz push-to-talk | 2–3 semanas |
| 3 | L2 | Proyectos y contexto | 2 semanas |
| 4 | L3 | Herramientas MCP, permisos, wake word | 3 semanas |
| 5 | L4a | Builder | 2–3 semanas |
| 6 | L4b | Memoria que aprende | 2–3 semanas |
| 7 | L5 | Proactividad + evolución + multi-dispositivo | continuo |

---

## Fase 0 — Diagnóstico (en curso)
- [x] Inventario de runtimes y hardware (ver `ENVIRONMENT_AUDIT.md`)
- [x] Prueba de micrófono y salida de audio (nivel, ruido, latencia) — SNR 40 dB, ver `ENVIRONMENT_AUDIT.md`
- [x] Benchmark STT con 20 frases propias → **Parakeet TDT v3 en Vulkan** (WER 15.3%, p50 184 ms). Ver ADR-010
- [x] Comparativa TTS en español (2 nube + 2 local) → **Google Neural2** (calidad 4.8/5 a ciegas, primer audio p50 1.2 s, ~US$ 5/mes); fallback offline Piper. Ver ADR-011. ⚠️ El tramo TTS no cumple los 300 ms (red): mitigaciones en Fase 2
- [ ] Cuenta Anthropic API + tope de gasto mensual configurado en la consola
- [x] Aprobar ADR-001…006 (2026-11-12) + ADR-007 y ADR-008 complementarios
- [x] Costo estimado por día → típico ~US$ 2,2/día solo Opus (~US$ 1,5 con router); supera el objetivo de US$ 1. Ver `CLAUDE_API.md` §4.1

**Exit:** ADRs aprobados; motor STT y TTS elegidos con datos; costo estimado por día documentado.

## Fase 1 — L0: Core + chat (implementada, en validación)
- [x] Monorepo pnpm + TypeScript + lint + test + CI (ADR-012)
- [x] Core daemon con IPC autenticado (named pipe + token, instancia única)
- [x] Adaptador Claude con streaming, cancelación, timeouts, reintentos y fallbacks del lado del servidor
- [x] API key en Windows Credential Manager (`set-secret`)
- [x] UI de chat (Electron + React) con historial persistente (SQLite); el Core corre sobre el Node de Electron
- [x] Medidor de costo por conversación + tope diario (alerta al 80%)
- [x] 15 evals de conversación + runner con juez
- [ ] Validación con la API real: correr las evals (≥ 80%) y usarlo una semana (requiere la cuenta de Anthropic)

**Exit:** uso diario por texto durante 1 semana; evals ≥ 80%; la clave no aparece en ningún log ni archivo.

## Fase 2 — L1: Voz (en curso)
- [x] Voice Service (Python 3.12 / uv) como proceso hijo del Core: protocolo por stdio, supervisor con backoff y estado degradado (ADR-013)
- [x] TTS por frases: segmentador en el Core, Neural2 con timeout de 2.5 s y reintento, fallback a Piper, caché de acuses, síntesis superpuesta y corte con fade de 30 ms (ADR-011)
- [x] Push-to-talk: atajo global `Ctrl+Shift+Space` (interruptor) y botón «Mantené para hablar»; overlay siempre visible con el micrófono abierto
- [ ] Validación: 20 conversaciones reales y p50 voz→primer audio < 2.0 s con `voice-stats` (requiere la key de Anthropic)
- [x] STT local: Parakeet en proceso vía `parakeet.dll` (~100 ms), micrófono abierto solo durante el push-to-talk, corrección post-STT (ADR-014)
- [x] Turno de voz orquestado por el Core (push-to-talk → STT → Claude → frases → TTS), barge-in al volver a apretar el atajo, métricas por turno en SQLite y `voice-stats` (ADR-013)
- [x] Modo voz del prompt (`prompts/voice.md`) y 4 evals de voz (ADR-015); falta correrlas con la API real
- [x] Barge-in por voz: Silero VAD mientras Jarvis habla, sin AEC porque el owner usa auriculares (ADR-016)

**Exit:** p50 voz→primer audio < 2.0 s; barge-in < 300 ms; 20 conversaciones reales sin fallos bloqueantes.

## Fase 3 — L2: Proyectos y contexto (en curso, ADR-017)
- [x] Registro de proyectos y carpetas autorizadas (solo el owner; guardia de rutas y denylist de secretos)
- [x] Indexado FTS5 sin copia del contenido + watcher de cambios + exclusiones (280 archivos en 79 ms)
- [x] Tools de solo lectura (servidor MCP `projects` en proceso): listar, buscar, leer, listar carpetas y estado git. Resumir lo hace Claude. Pasan por el Permission Engine v0 y el audit log append-only
- [x] Armado de contexto por proyecto activo (tarjeta del proyecto en el `system`, proyecto por conversación) + panel de Proyectos en la app

- [x] 10 evals de salida sobre la documentación de este repo (`project: jarvis-docs`)
- [ ] Validación: 10/10 con la API real y probarlo con un proyecto propio del owner (requiere la key de Anthropic)

**Exit:** responde correctamente 10/10 preguntas sobre documentación de un proyecto real.

## Fase 4 — L3: Manos
- MCP Client Hub + servidores: filesystem acotado, git, (opcional) calendario/mail
  - [x] Servidores MCP de terceros registrados por el owner, en proceso propio y con confirmación por defecto (ADR-020)
  - [x] Escritura acotada en proyectos y git (diff, commit sin hooks ni push) con vista previa y huella (ADR-019)
- Permission Engine + UI de confirmación + audit log consultable
  - [x] Permission Engine v1, reglas del owner, confirmación en diálogo nativo, panel Actividad, export JSONL y `recent_activity` (ADR-018)
- Wake word local configurable
  - [x] «Hey Jarvis» local, umbral configurable, indicador y métrica de falsas activaciones (ADR-021)
  - [ ] Validación: calibrar con la voz del owner y < 1 falsa activación/día en uso real
- Defensa contra prompt injection (tests adversariales en evals)
  - [x] 50 evals con 10 ataques de injection en archivos reales de un proyecto descartable y conteo de acciones sin confirmación (ADR-022)
  - [ ] Validación: corrida real con 0 acciones sin confirmación y ≥ 80 % (requiere la key de Anthropic)

**Exit:** 0 acciones sensibles sin confirmación en 50 pruebas, incluyendo 10 ataques de injection; < 1 falsa activación/día.

## Fase 5 — L4a: Builder
- Integración Claude Agent SDK en workspaces autorizados
- Siempre en rama git; diff y resumen antes de merge
- Hooks: bloqueo de comandos fuera de allowlist, límite de presupuesto por tarea

**Exit:** construye 5 tareas reales pequeñas (scripts/utilidades) con aprobación de diff, sin tocar nada fuera del workspace.

## Fase 6 — L4b: Memoria que aprende
- Memoria episódica/semántica/procedural
- Job de reflexión diaria con propuestas aprobables
- UI de memoria (ver/editar/borrar/desactivar)
- Idea Vault + modos de pensamiento

**Exit:** en 2 semanas de uso, ≥ 70% de recuerdos propuestos son aceptados; recuperación correcta en evals de memoria.

## Fase 7 — L5: Socio (continuo)
- Proactividad con reglas (briefing, recordatorios, horarios silenciosos)
- Ciclo de evolución: skills propuestas por Jarvis, gated por evals + aprobación
- Clientes adicionales (Telegram/móvil vía túnel seguro)
- Mejora continua de latencia y voz
