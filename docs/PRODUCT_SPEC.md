# JARVIS — Product Spec v2

> Versión 2.0 · 2026-11-12 · Reemplaza a `archive/00_SPEC_ORIGINAL.md` (v1), conservando todos sus principios de seguridad.
> Cambios clave vs v1: visión de largo plazo, niveles de capacidad, arquitectura Core+Clientes, MCP, Builder, memoria que aprende, evolución controlada, presupuestos de latencia y costo.

## 1. Visión

**JARVIS es un asistente personal de IA que vive en tu computadora, te escucha cuando lo llamás, conversa a tu nivel, piensa con vos, recuerda lo que importa, construye lo que le pedís y mejora con el tiempo — siempre bajo tu control.**

No es un chatbot con micrófono. Es un **agente persistente** que orquesta IA, memoria, proyectos, archivos, herramientas e integraciones bajo permisos explícitos.

### North Star
> *"Le hablo a Jarvis como a un colega brillante que conoce todos mis proyectos, y las cosas pasan."*

### Lo que JARVIS **no** es
- No es un proceso opaco con acceso ilimitado al equipo.
- No escucha en secreto.
- No se modifica a sí mismo sin aprobación.
- No imita la voz del personaje de las películas.

## 2. Usuario objetivo

Owner único (uso personal), desarrollador/emprendedor que maneja múltiples proyectos en paralelo, habla español rioplatense/latinoamericano, trabaja en Windows. Diseñado para que otros puedan instalarlo (repo público), pero sin multi-usuario en el corto plazo.

## 3. Niveles de capacidad

El producto evoluciona por niveles. Cada nivel es usable por sí mismo.

| Nivel | Nombre | Qué puede hacer | Fase |
|-------|--------|-----------------|------|
| **L0** | Chat | Chat de texto con Claude, historial, clave segura | 1 |
| **L1** | Voz | Push-to-talk, STT, TTS, interrupción | 2 |
| **L2** | Contexto | Conoce tus proyectos, busca y resume documentos autorizados | 3 |
| **L3** | Manos | Ejecuta herramientas (MCP) con permisos, confirmación y auditoría; wake word | 4 |
| **L4** | Constructor + Memoria | Construye software (Builder), aprende de interacciones, memoria en 3 capas | 5–6 |
| **L5** | Socio | Proactivo con reglas, propone mejoras de sí mismo (evolución), multi-dispositivo | 7+ |

## 4. Objetivos funcionales

### 4.1 Conversación
- Conversación natural en español por voz y texto, multi-turno, con contexto largo.
- Respuestas habladas y escritas sincronizadas.
- Interrupción inmediata (barge-in) por voz o tecla.
- **Modos de pensamiento**: normal, brainstorm, sparring/abogado del diablo, mejora de ideas, planificación, explicación.
- **Idea Vault**: guardar, etiquetar, relacionar y revisitar ideas.

### 4.2 Activación
- Push-to-talk con atajo global configurable (primero).
- Wake word local y configurable ("Jarvis" por defecto), sin enviar audio a la nube antes de la activación.
- Estado de escucha **siempre visible**; mute global instantáneo.

### 4.3 Proyectos y contexto
- Registro explícito de proyectos: nombre, descripción, carpeta raíz autorizada, objetivos, tareas, decisiones, actividad.
- Indexado y búsqueda (FTS5 + embeddings opcionales).
- Resúmenes, comparación de cambios, última actividad, estado de repos git.

### 4.4 Acción (herramientas)
- Herramientas vía **MCP** con tres clases: solo lectura / preparación / con confirmación (ver `TOOLS_AND_PERMISSIONS.md`).
- Integraciones opt-in: calendario, mail, GitHub, Notion, etc.
- **Builder**: construye y modifica software en workspaces autorizados, siempre en rama git, con diff para aprobar.

### 4.5 Memoria y aprendizaje
- Memoria episódica, semántica y procedural (ver `MEMORY_AND_CONTEXT.md`).
- Reflexión periódica que propone nuevos recuerdos para aprobación.
- UI para ver, editar, desactivar y borrar memoria.

### 4.6 Evolución
- Jarvis propone nuevas skills, mejoras de prompts y herramientas.
- Se aplican solo con evals verdes + aprobación + versión en git (ver `EVOLUTION.md`).

### 4.7 Transparencia y costos
- Indicador de cuándo se envían datos a la nube y a qué proveedor.
- Costo por conversación y acumulado diario/mensual; tope duro configurable.
- Audit log consultable ("Jarvis, ¿qué hiciste hoy?").

## 5. Requisitos no funcionales

| Requisito | Objetivo |
|-----------|----------|
| Latencia voz→primer audio | p50 < 1.5 s, p95 < 2.5 s (meta final); MVP p50 < 2.0 s |
| Barge-in | Cancelación de audio + stream < 200 ms |
| Disponibilidad offline | Wake word, STT local, memoria, búsqueda, UI funcionan sin red |
| Consumo en reposo | CPU < 3%, RAM Core+voz < 600 MB |
| Seguridad | Ninguna tool no registrada; ninguna acción sensible sin confirmación |
| Privacidad | Sin audio crudo persistido por defecto; datos locales cifrados |
| Portabilidad | Windows primero; Core portable (Node) a macOS/Linux |

## 6. Principios (heredados de v1, sin cambios)

1. Local-first cuando sea viable.
2. Transparencia sobre datos enviados a la nube.
3. No grabar ni escuchar continuamente de forma oculta.
4. Botón de silencio y cancelación accesibles.
5. Claude no tiene acceso irrestricto al sistema operativo.
6. Acciones destructivas o externas requieren confirmación.
7. Voz, IA, memoria, herramientas e interfaz desacopladas.
8. Auditoría de acciones y resultados.
9. Funciones locales disponibles sin conexión.
10. No guardar claves ni secretos en el repositorio.

**Nuevos en v2:**
11. **Medir antes de evolucionar**: ningún cambio de comportamiento sin evals.
12. **El owner siempre tiene la última palabra** sobre memoria, skills y acciones.
13. **Nunca afirmar que algo se hizo** sin confirmación de la herramienta.

## 7. Personalidad

Nombre de trabajo: JARVIS (configurable). Profesional, serena, inteligente, cortés, directa, honesta, con humor seco ocasional. Habla con voseo si el owner lo usa. Cuestiona ideas cuando corresponde ("Lo veo con un riesgo: …"). Nunca servil, nunca inventa.

Ejemplos de uso:
- "Jarvis, ¿qué proyectos tengo activos?"
- "Resumime los pendientes del proyecto X."
- "Buscá en la documentación cómo definimos las liquidaciones."
- "Tengo una idea para una app… hacé de abogado del diablo."
- "Construime un script que renombre estas fotos por fecha. Mostrame el diff antes."
- "Prepará un informe de los cambios de esta semana."
- "Proponé una respuesta a este mail, pero no la envíes."
- "¿Qué aprendiste de mí esta semana?"

## 8. Voz

Voz **original**: español latinoamericano natural, dicción precisa, ritmo moderado, timbre cálido y tecnológico, entonación sobria. Proveedor TTS intercambiable; alternativa local. Indicar motor activo y si usa nube. No clonar ni imitar voces protegidas.

## 9. Criterios de aceptación del MVP (L0 + L1 + L2)

- [ ] Funciona en el equipo objetivo (Windows 11, Ryzen 5 3600, RX 6600 XT).
- [ ] Chat de texto conectado a Claude con streaming.
- [ ] API key en el almacén seguro del SO.
- [ ] Push-to-talk operativo con atajo global.
- [ ] Respuesta hablada y escrita; interrupción de audio.
- [ ] Indicador de micrófono siempre visible cuando está activo.
- [ ] Proyectos y carpetas autorizadas; búsqueda y resumen de documentos.
- [ ] Costo visible por conversación y tope diario.
- [ ] Historial y memoria administrables.
- [ ] Evals básicos corriendo en CI.
- [ ] Documentación de instalación y solución de problemas.

## 10. Fuera de alcance (por ahora)

Multi-usuario · app móvil nativa · control de domótica · automatización de UI del navegador · fine-tuning de modelos · clonación de voz.
