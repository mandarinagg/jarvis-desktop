# Evolución controlada

> Decisión base: ADR-006. "Que evolucione siempre" sin perder el control.

## 1. Qué puede evolucionar

| Artefacto | Ubicación | Quién propone |
|-----------|-----------|---------------|
| Skills (procedimientos reutilizables: prompt + tools + pasos) | `skills/<nombre>/SKILL.md` | Jarvis u owner |
| Prompts de sistema y de modos | `packages/core/prompts/` | Jarvis u owner |
| Servidores MCP propios | `packages/mcp-*` | Builder |
| Reglas de permisos | config local del owner | Owner (Jarvis sugiere) |
| Perfiles del router | config | Jarvis sugiere con datos de costo/latencia |

## 2. Ciclo

```
Detectar oportunidad ─▶ Proponer (rama git + descripción + por qué)
        ▲                               │
        │                       Correr evals (sin regresiones)
        │                               │
   Telemetría local              Owner aprueba / rechaza
   (errores, repeticiones,              │
    costo, latencia, feedback)    Merge + changelog + rollback disponible
```

Fuentes de oportunidad:
- El owner repite el mismo pedido ≥ 3 veces → proponer skill.
- Un tipo de turno falla o es lento → proponer ajuste.
- Feedback explícito ("eso estuvo mal", "así no") → caso nuevo para evals.

## 3. Evals

- `evals/conversations/` — conversaciones doradas con criterios de evaluación.
- `evals/tasks/` — tareas con resultado verificable (búsqueda, resumen, tool calls correctas).
- `evals/adversarial/` — prompt injection y pedidos peligrosos (deben fallar de forma segura).
- Runner en CI para PRs que tocan prompts, orquestación, router o skills.
- Cada error real del uso diario se convierte en un caso de eval (con datos sintéticos si es personal).

## 4. Límites duros

- Jarvis no puede modificar el Permission Engine, el Audit Log ni estas reglas.
- Ningún cambio se aplica sin aprobación explícita.
- Todo cambio es reversible en un paso.
