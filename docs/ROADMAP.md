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

## Fase 1 — L0: Core + chat
- Monorepo pnpm + TypeScript + lint + test + CI
- Core daemon con IPC autenticado
- Adaptador Claude con streaming, cancelación, timeouts, reintentos
- API key en Windows Credential Manager
- UI de chat (Electron + React) con historial persistente (SQLite)
- Medidor de costo por conversación + tope diario
- Primeros 15 evals de conversación

**Exit:** uso diario por texto durante 1 semana; evals ≥ 80%; la clave no aparece en ningún log ni archivo.

## Fase 2 — L1: Voz
- Voice Service (Python 3.12 / uv) con IPC al Core
- Push-to-talk con atajo global + overlay de estado
- STT streaming local; TTS por frases; barge-in
- Métricas de latencia por turno

**Exit:** p50 voz→primer audio < 2.0 s; barge-in < 300 ms; 20 conversaciones reales sin fallos bloqueantes.

## Fase 3 — L2: Proyectos y contexto
- Registro de proyectos y carpetas autorizadas
- Indexado FTS5 + watcher de cambios + exclusiones
- Tools de solo lectura: buscar, leer, resumir, estado git
- Armado de contexto por proyecto activo

**Exit:** responde correctamente 10/10 preguntas sobre documentación de un proyecto real.

## Fase 4 — L3: Manos
- MCP Client Hub + servidores: filesystem acotado, git, (opcional) calendario/mail
- Permission Engine + UI de confirmación + audit log consultable
- Wake word local configurable
- Defensa contra prompt injection (tests adversariales en evals)

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
