# Memoria y contexto

> Objetivo: que Jarvis **aprenda** de verdad, sin volverse una caja negra.

## 1. Capas

| Capa | Qué guarda | Ejemplo | Persistencia |
|------|-----------|---------|--------------|
| **Contexto de trabajo** | Turno y sesión actual | "Estamos hablando del Proyecto X" | Sesión |
| **Episódica** | Qué pasó, resumido | "12/11: definimos arquitectura Core+clientes" | Persistente, con TTL opcional |
| **Semántica** | Hechos y preferencias | "Prefiere respuestas cortas por voz" | Persistente, aprobada |
| **Procedural** | Cómo hacer cosas | Skill "preparar informe semanal" | Versionada en git (ver `EVOLUTION.md`) |
| **Proyectos** | Datos de proyectos registrados | objetivos, tareas, decisiones | Persistente |
| **Índice de archivos** | FTS5 + embeddings | — | Reconstruible |
| **Idea Vault** | Ideas del owner y de Jarvis | "App para X — riesgos: …" | Persistente |

## 2. Ciclo de aprendizaje

```
Conversaciones ─▶ Episodios (resumen automático por sesión)
                      │
            Reflexión diaria (job, modelo profundo)
                      │
       ┌──────────────┼───────────────────┐
  Hechos candidatos   Patrones repetidos   Ideas a revisitar
       │              │                   │
  Propuesta al owner  Propuesta de skill   Recordatorio opcional
       │              │
  Aprobado → Semántica   Aprobado + evals → Procedural
```

- Nada pasa a memoria semántica o procedural sin aprobación (configurable a "auto-aprobar baja sensibilidad" más adelante).
- Cada recuerdo tiene: fuente (episodio/turno), fecha, confianza, sensibilidad, última vez usado.

## 3. Recuperación

- Por turno, se seleccionan recuerdos relevantes (FTS + embeddings + recencia + proyecto activo) con un presupuesto de tokens.
- Se inyectan como **datos** en el prompt, nunca como instrucciones del sistema.
- "Jarvis, ¿por qué dijiste eso?" → muestra qué recuerdos usó.

## 4. Control del owner

- Ver, buscar, editar, desactivar y borrar cualquier recuerdo.
- Excluir carpetas; reconstruir índices; borrar todo ("olvidá todo lo de esta semana").
- Nunca guardar contraseñas, API keys ni datos sensibles innecesarios (filtro previo).
