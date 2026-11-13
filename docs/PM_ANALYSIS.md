# Análisis de Project Management — JARVIS

> Autor: revisión PM sobre `docs/archive/00_SPEC_ORIGINAL.md` · Fecha: 2026-11-12
> Estado: **propuesta** — las decisiones marcadas como *Propuesta* requieren aprobación del owner (ver `docs/DECISIONS.md`).

---

## 1. Resumen ejecutivo

El spec original es **sólido en seguridad, privacidad y control** (mejor que el 90% de los proyectos "Jarvis" open source), pero está escrito como un **MVP de chat con voz**, mientras que la visión real del owner es mucho más ambiciosa:

> *"Un Jarvis real, que maneje todo lo que hago, que se active por voz, mantenga conversaciones complejas, me dé ideas, mejore las mías, aprenda, construya lo que le pido y evolucione siempre."*

Hay una **brecha de visión**: el spec no menciona aprendizaje, evolución, capacidad de construir software, proactividad ni multi-dispositivo. Si se construye tal cual, el resultado sería un buen chat de escritorio que habría que re-arquitecturar a los 3 meses.

**Recomendación central:** mantener los principios de seguridad del spec original al 100%, pero **re-arquitecturar alrededor de un "Core" agente persistente** (daemon local) en vez de una app de escritorio, y planificar el roadmap por **niveles de capacidad** (L0→L5) en vez de solo por features.

## 2. Fortalezas del spec original (conservar)

| # | Fortaleza | Por qué importa |
|---|-----------|-----------------|
| 1 | Permisos explícitos, confirmación humana, auditoría | Un agente que "maneja todo" sin esto es un riesgo real |
| 2 | Documentos tratados como datos no confiables (prompt injection) | Crítico cuando el agente lee mails, webs y archivos |
| 3 | Componentes desacoplados (voz, IA, memoria, tools, UI) | Permite cambiar proveedores sin reescribir |
| 4 | Voz original, no clonada | Evita problemas legales |
| 5 | Push-to-talk primero, wake word después | Orden correcto de riesgo |
| 6 | API oficial, nada de scraping de claude.ai | Sostenible y legal |
| 7 | Lista de documentación a mantener | Buena base de gobernanza |

## 3. Brechas detectadas

### 3.1 Brechas de visión (las más importantes)

| Brecha | Spec original | Visión del owner | Propuesta |
|--------|---------------|------------------|-----------|
| **Aprendizaje** | "Memoria aprobada" estática | Que aprenda | Memoria en 3 capas (episódica, semántica, procedural) + ciclo de reflexión nocturna. Ver `MEMORY_AND_CONTEXT.md` |
| **Evolución** | No existe | Que evolucione siempre | "Skills" que Jarvis escribe y propone, versionadas en git, con evals de regresión. Ver `EVOLUTION.md` |
| **Construir cosas** | "Proponer cambios de código" | Que construya lo que pido | Subsistema **Builder** basado en Claude Agent SDK, en workspaces aislados con git |
| **Ideas / pensamiento** | Solo Q&A sobre proyectos | Que dé ideas y mejore las mías | Modos de conversación: *sparring*, *brainstorm*, *abogado del diablo*; memoria de ideas |
| **Manejar todo** | Solo carpetas locales | Todo lo que hago | Integraciones vía **MCP** (calendario, mail, GitHub, Notion, etc.) opt-in por servidor |
| **Proactividad** | "Solo autorizada" (sin diseño) | Implícita | Briefings, recordatorios, detección de pendientes — con reglas explícitas y silenciables |
| **Multi-dispositivo** | Solo Windows desktop | Implícita ("todo") | Core como daemon; la UI desktop es *un cliente más* (luego móvil/Telegram/CLI) |

### 3.2 Brechas de ingeniería

| Brecha | Riesgo | Propuesta |
|--------|--------|-----------|
| Sin **presupuesto de latencia** | Una voz que tarda 4 s se siente rota | Objetivo: voz→primer audio < 1.5 s p50, < 2.5 s p95. Streaming en todo el pipeline |
| Sin **evals** | No se puede "evolucionar" sin medir; cada cambio puede romper algo | `evals/` con conversaciones doradas desde la Fase 1 |
| Sin **estrategia de costos** concreta | Un agente always-on puede gastar mucho | Router de modelos, prompt caching, tope diario, panel de costo |
| **Tool registry propio** | Reinventar la rueda | Usar **MCP** como protocolo de herramientas (estándar, ecosistema enorme) |
| Sin **barge-in** detallado | Interrumpir es la feature que hace sentir "real" | AEC + VAD durante TTS; cancelar stream de Claude y TTS en < 200 ms |
| Sin métricas de producto | No sabés si mejora | KPIs en §6 |
| Stack "Tauri + Rust" | No hay Rust instalado; el ecosistema de agentes es Node/TS | Ver ADR-002 (Electron/Node core) |
| GPU AMD | faster-whisper/CUDA no aplica | whisper.cpp con backend **Vulkan** (funciona en RX 6600 XT) |
| Python 3.15 | Muchas wheels (onnxruntime, torch) aún no publican para 3.15 | Sidecar de voz con **uv + Python 3.12** aislado |

### 3.3 Brechas de gestión

- **Sin owner de decisiones / proceso**: se agrega ADRs (`docs/adr/`), Definition of Done, y tablero.
- **Sin criterios de salida por fase**: cada fase ahora tiene "exit criteria" medibles (ver `ROADMAP.md`).
- **Sin registro de riesgos**: agregado en §5.
- **Nombre "JARVIS"**: es marca de Marvel/Disney. Para uso personal no hay problema; para un repo público conviene que el **nombre del producto sea configurable** y el nombre del repo neutral-ish. Se mantiene "JARVIS" como nombre de trabajo y wake word por defecto (configurable).

## 4. Propuestas principales (priorizadas)

### P1 — Arquitectura "Core + Clientes" *(alto impacto, hacer ya)*
Un proceso **Jarvis Core** (Node/TypeScript) corre en segundo plano y contiene orquestador, memoria, permisos, auditoría y conexión a Claude. La app de escritorio, el overlay de voz y (a futuro) móvil/Telegram/CLI son **clientes** que hablan con el Core por IPC autenticado. Esto habilita "manejar todo" sin re-arquitecturar.

### P2 — MCP como sistema de herramientas *(alto impacto)*
En lugar de un Tool Registry propio, el Core es un **cliente MCP**. Cada integración (filesystem acotado, git, calendario, mail, GitHub, Notion…) es un servidor MCP con su política de permisos. El Permission Engine intercepta *todas* las llamadas. Ganás cientos de integraciones existentes.

### P3 — Builder con Claude Agent SDK *(diferencial)*
Para "construí lo que te pido": el Core delega a un **Builder** basado en el Claude Agent SDK, que trabaja **solo dentro de workspaces autorizados**, siempre en una rama git, con hooks de permisos y diff final para aprobar. Jarvis conversa; el Builder ejecuta.

### P4 — Memoria que aprende *(diferencial)*
Tres capas: **episódica** (qué pasó), **semántica** (hechos y preferencias), **procedural** (cómo hacer cosas → skills). Un job de **reflexión** diario resume, extrae hechos candidatos y los propone para aprobación. Todo visible y borrable.

### P5 — Ciclo de evolución controlada *(diferencial)*
Jarvis puede **proponer** nuevas skills, prompts o herramientas. Se aplican solo si: (1) pasan los evals, (2) el owner aprueba, (3) quedan versionadas en git con rollback. "Evoluciona siempre" pero nunca se auto-modifica sin control.

### P6 — Voz con presupuesto de latencia y barge-in *(experiencia)*
Pipeline streaming: wake word local → VAD → STT streaming → Claude streaming → TTS por frases → audio. Interrupción por voz con cancelación inmediata. Ver `VOICE_PIPELINE.md`.

### P7 — Costos bajo control *(sostenibilidad)*
Router de modelos (rápido/barato para intención y charla corta, potente para razonamiento y construcción), prompt caching, tope diario configurable, costo visible por conversación.

### P8 — Evals desde el día 1 *(calidad)*
Conjunto de conversaciones y tareas doradas en `evals/`. Cada PR que toca prompts/orquestación corre evals. Sin esto, "evolucionar" = "romper".

### P9 — Modos de pensamiento *(valor para el owner)*
Modos explícitos por voz: *"Jarvis, modo brainstorm"*, *"hacé de abogado del diablo"*, *"mejorá esta idea"*. Con un **Idea Vault** (ideas guardadas, relacionadas, revisitables).

### P10 — Proactividad con reglas *(fase tardía)*
Briefing matutino, recordatorios de pendientes, alertas de proyectos. Siempre con horarios silenciosos, límite de interrupciones, y un "callate por hoy".

## 5. Registro de riesgos

| ID | Riesgo | Prob. | Impacto | Mitigación |
|----|--------|-------|---------|------------|
| R1 | Scope creep ("que haga todo") | Alta | Alto | Niveles L0–L5 con exit criteria; nada de L(n+1) sin cerrar L(n) |
| R2 | Latencia de voz alta → experiencia "rota" | Media | Alto | Presupuesto de latencia, streaming, medición desde Fase 2 |
| R3 | Costos de API descontrolados | Media | Alto | Router, caching, tope diario duro, alertas |
| R4 | Prompt injection vía mails/docs/web | Alta | Crítico | Datos ≠ instrucciones, permisos por tool, confirmación en acciones externas |
| R5 | Acción destructiva por error del agente | Media | Crítico | Builder en ramas git, sin shell genérico, dry-run + confirmación doble |
| R6 | Falsos positivos de wake word / escucha no deseada | Media | Medio | Wake word 100% local, indicador visible, umbral ajustable, mute físico |
| R7 | Dependencias de voz incompatibles (AMD, Python 3.15) | Alta | Medio | whisper.cpp Vulkan; uv + Python 3.12; adaptadores intercambiables |
| R8 | Memoria acumula basura o datos sensibles | Media | Medio | Reflexión con aprobación, TTL, filtros de secretos, UI de memoria |
| R9 | Proyecto personal se abandona por falta de "wins" | Media | Alto | Entregas usables cada 2 semanas; dogfooding diario desde Fase 1 |
| R10 | Secretos o datos personales filtrados en repo público | Media | Alto | `.gitignore`, `.env.example`, datos fuera del repo (`%APPDATA%`), secret scanning de GitHub |
| R11 | Marca "JARVIS" | Baja | Bajo | Nombre y wake word configurables |

## 6. Métricas de éxito (KPIs)

| Métrica | Objetivo MVP | Objetivo L3+ |
|---------|--------------|--------------|
| Latencia voz→primer audio (p50) | < 2.0 s | < 1.2 s |
| Tiempo de barge-in (cancelación) | < 300 ms | < 150 ms |
| Precisión STT en español (WER, frases propias) | < 12% | < 7% |
| Falsas activaciones de wake word | — | < 1 por día |
| Tasa de éxito en evals de tareas | ≥ 80% | ≥ 95% |
| Costo diario promedio | < USD 1 | definido por owner. Estimación de Fase 0: ~USD 2,2/día con uso típico (ver `CLAUDE_API.md` §4.1); revisar con datos de Fase 1 |
| Uso real (dogfooding) | ≥ 5 interacciones/día | ≥ 30/día |
| Acciones ejecutadas sin confirmación requerida | 0 | 0 |

## 7. Proceso de trabajo propuesto

- **Cadencia:** sprints de 2 semanas, cada uno termina en algo usable.
- **Tablero:** GitHub Issues + Milestones por fase + labels (`fase:*`, `area:*`, `tipo:*`, `prioridad:*`).
- **Decisiones:** ADR por cada decisión técnica relevante (`docs/adr/`), índice en `DECISIONS.md`.
- **Definition of Done:** código + tests + evals verdes (si aplica) + docs actualizadas + entrada en audit si toca permisos.
- **Branching:** `main` protegida; ramas `feat/*`, `fix/*`, `docs/*`; PR con checklist.
- **Construcción con Claude Code:** `CLAUDE.md` del repo define reglas para que Claude Code trabaje alineado al spec.

## 8. Próximos pasos inmediatos

1. Owner revisa y aprueba/ajusta ADRs propuestos (ADR-001 a ADR-006).
2. Cerrar **Fase 0** (diagnóstico): prueba de micrófono, benchmark whisper.cpp Vulkan, comparativa TTS en español, cuenta API + tope de gasto.
3. Arrancar **Fase 1**: Core + chat de texto con Claude + clave segura + historial + primer set de evals.
