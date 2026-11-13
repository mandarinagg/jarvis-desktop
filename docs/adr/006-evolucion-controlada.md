# ADR-006: Evolución controlada

- **Estado:** Aceptada — aprobada por el owner el 2026-11-12
- **Fecha:** 2026-11-12

## Contexto
El owner quiere un Jarvis que "aprenda y evolucione siempre". Un agente que se auto-modifica sin control es impredecible y riesgoso.

## Decisión
Jarvis puede **proponer** cambios a sí mismo (nuevas skills, ajustes de prompts, nuevas herramientas MCP, recuerdos). Un cambio se aplica solo si:
1. Está expresado como **artefacto versionado** (archivo en `skills/` o config) en una rama git.
2. **Pasa los evals** relevantes sin regresiones.
3. El owner lo **aprueba** explícitamente (UI, o voz con confirmación).
4. Tiene **rollback** en un paso.

Ver `docs/EVOLUTION.md`.

## Consecuencias
- (+) Evolución real y auditable; nunca "se volvió raro y no sé por qué".
- (−) Requiere invertir en evals desde la Fase 1.
