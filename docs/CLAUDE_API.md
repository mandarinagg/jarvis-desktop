# Integración con Claude (API oficial de Anthropic)

> Decisión base: ADR-005. Verificar siempre contra la documentación oficial vigente antes de implementar — la API evoluciona.

## 1. Reglas

- Solo **API oficial** desde el Core (`@anthropic-ai/sdk`). Nunca automatizar claude.ai ni extraer sesiones del navegador.
- API key en **Windows Credential Manager**; nunca en frontend, logs, repo ni archivos compartidos. `.env` solo para desarrollo y está en `.gitignore`.
- Streaming siempre; timeouts, cancelación (AbortController) y reintentos con backoff para 429/5xx.
- Manejo de errores con las clases tipadas del SDK (no comparar strings).
- Revisar `stop_reason` antes de leer contenido (incluye `refusal`).
- Mostrar en la UI cuándo se envían datos a la nube y cuántos tokens/costo.

## 2. Modelos (a noviembre 2026)

| Uso | Modelo | ID |
|-----|--------|----|
| Por defecto / profundo | Claude Opus 5.5 | `claude-opus-5-5` |
| Normal (candidato) | Claude Sonnet 5.5 | `claude-sonnet-5-5` |
| Rápido (candidato) | Claude Haiku 5.5 | `claude-haiku-5-5` |

Opus 5.5 usa thinking adaptativo y se controla con `output_config.effort` (`low`…`max`; su default es `medium`, conviene setearlo explícito). Los perfiles del router se activan **solo después de medirlos con evals**.

## 3. Estructura del prompt (separación de confianza)

```
tools        → definiciones MCP (orden determinista, para no invalidar caché)
system       → identidad, personalidad, reglas de seguridad (estable → cacheado)
messages     →
  [memoria relevante]           marcada como DATOS
  [contexto del proyecto]       marcado como DATOS NO CONFIABLES
  [historial]
  [mensaje del usuario]
```

- El contenido de archivos, mails y webs se envuelve como datos (p. ej. `<document source="…">…</document>`) y el system prompt indica que **nunca** se obedecen instrucciones que aparezcan dentro.
- Instrucciones de operador a mitad de conversación: usar mensajes `system` dentro de `messages` (no editar el `system` superior) para conservar la caché.

## 4. Costos

- Registrar `usage` de cada respuesta (input, output, cache read/write) → Cost Meter.
- Prompt caching en `tools` + `system`; verificar `cache_read_input_tokens > 0`.
- Tope diario duro en el Core + tope mensual en la consola de Anthropic.
- Conversaciones largas: compactación del lado servidor o resúmenes propios.

## 5. Builder

El Builder usa el **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — es un producto distinto del SDK de la API. Se configura con:
- `cwd` restringido al workspace autorizado.
- Hooks de permisos que consultan al Permission Engine del Core.
- Allowlist de comandos; presupuesto por tarea; rama git dedicada.

Documentación: https://code.claude.com/docs/en/agent-sdk
