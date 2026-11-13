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

### 4.1 Costo diario estimado (Fase 0, 2026-11-13)

Es un **modelo con supuestos, no una medición**. Se recalibra con el `usage` real desde la Fase 1.

**Precios de la API de Anthropic** (US$ por millón de tokens; verificar en la consola antes de usarlos):

| Modelo | Entrada | Salida | Lectura de caché |
|---|---|---|---|
| Claude Opus 5.5 | 4 | 20 | 0,20 |
| Claude Sonnet 5.5 | 2 | 10 | 0,10 |
| Claude Haiku 5.5 | 0,10 | 0,50 | — |

Escribir en la caché de 5 minutos cuesta 1.25 veces la tarifa de entrada.

**Supuestos por turno** (la salida incluye el thinking; los perfiles son los de ADR-005):

| Perfil | Lectura de caché | Escritura de caché | Salida | Caracteres hablados | Costo con Opus |
|---|---|---|---|---|---|
| rápido | 12k | 1k | 300 | 60 | US$ 0,013 |
| normal | 16k | 2k | 900 | 300 | US$ 0,031 |
| profundo | 30k | 5k | 4k | 600 | US$ 0,111 |

Además, cada conversación vuelve a escribir en la caché el prefijo estable (system + tools, ~8k tokens): **US$ 0,04 por conversación con Opus**, porque la caché de 5 minutos expira entre una conversación y otra. El TTS cuesta US$16 por millón de caracteres (Google Neural2, ADR-011).

| Escenario por día | Conv. | Rápido / normal / profundo | Solo Opus | Router (Haiku / Sonnet / Opus) |
|---|---|---|---|---|
| Liviano | 5 | 20 / 10 / 1 | **US$ 0,97** (~US$ 29/mes) | US$ 0,66 (~US$ 20/mes) |
| Típico | 10 | 40 / 25 / 3 | **US$ 2,24** (~US$ 67/mes) | US$ 1,54 (~US$ 46/mes) |
| Intenso | 20 | 80 / 60 / 10 | **US$ 5,31** (~US$ 159/mes) | US$ 3,76 (~US$ 113/mes) |

El TTS representa US$ 0,08–0,46 por día del total. El Builder (Claude Agent SDK) no está incluido: tendrá un presupuesto propio por tarea (Fase 5).

**Conclusiones:**
- **Con uso típico se supera el objetivo de menos de US$1 por día** (`PM_ANALYSIS.md`), incluso con el router. El costo lo domina la **salida** (thinking + respuesta) de los turnos normal y profundo.
- **Palancas, en orden** (ADR-005 / CLAUDE_API §4):
  1. `effort: low` en los turnos rápido y normal, medido con evals;
  2. respuestas de voz breves por prompt;
  3. caché de 1 h para el prefijo si las conversaciones están separadas por menos de una hora;
  4. el router, solo si las evals sostienen la calidad.
- **Topes iniciales sugeridos:**
  - **tope duro diario en el Core: US$ 3**, con alerta al 80%;
  - **tope mensual en la consola de Anthropic: US$ 60**.
  - El owner puede ajustarlos. Si se mantiene el objetivo de US$1, se revisa con datos reales en la Fase 1.

## 5. Builder

El Builder usa el **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — es un producto distinto del SDK de la API. Se configura con:
- `cwd` restringido al workspace autorizado.
- Hooks de permisos que consultan al Permission Engine del Core.
- Allowlist de comandos; presupuesto por tarea; rama git dedicada.

Documentación: https://code.claude.com/docs/en/agent-sdk
