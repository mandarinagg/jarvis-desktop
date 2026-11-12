# JARVIS DESKTOP

## Asistente personal de IA por voz y texto para proyectos y flujos de trabajo

**Tipo:** Aplicación de escritorio local-first\
**IA:** Claude mediante API oficial de Anthropic\
**Interfaz:** Voz + texto\
**Plataforma inicial:** Windows; arquitectura extensible.

## 1. Visión

Crear un asistente personal de escritorio inspirado en la experiencia de
un asistente cinematográfico: elegante, conversacional, contextual y
capaz de ayudar a gestionar proyectos, documentos y tareas desde una
interfaz unificada.

No debe ser solo un chatbot con micrófono. Debe orquestar IA, proyectos,
archivos y herramientas locales bajo permisos explícitos.

La voz será original, con tono sofisticado, sereno, claro y tecnológico.
No clonar ni reproducir exactamente la voz del personaje JARVIS ni usar
muestras de voz sin derechos.

## 2. Objetivos

-   Conversación natural en español por voz y texto.
-   Respuestas habladas y escritas.
-   Push-to-talk y atajo configurable.
-   Interrupción inmediata de respuestas.
-   Contexto de proyectos registrados.
-   Búsqueda en carpetas autorizadas.
-   Resumen de actividad, decisiones y pendientes.
-   Conexión con Claude mediante API oficial.
-   Herramientas locales con permisos.
-   Confirmación humana antes de acciones sensibles.
-   Historial y memoria administrables.
-   Costos de API visibles cuando sea posible.

## 3. Principios

1.  Local-first cuando sea viable.
2.  Transparencia sobre datos enviados a la nube.
3.  No grabar ni escuchar continuamente de forma oculta.
4.  Botón de silencio y cancelación accesibles.
5.  Claude no tiene acceso irrestricto al sistema operativo.
6.  Acciones destructivas o externas requieren confirmación.
7.  Voz, IA, memoria, herramientas e interfaz desacopladas.
8.  Auditoría de acciones y resultados.
9.  Funciones locales disponibles cuando no haya conexión.
10. No guardar claves ni secretos en el repositorio.

## 4. Experiencia de usuario

Ventana principal: - Estado: inactivo, escuchando, procesando,
respondiendo o error. - Botón de micrófono y campo de texto. - Respuesta
escrita y animación discreta. - Historial. - Acceso a proyectos, tareas
y archivos. - Panel de permisos, privacidad y conexiones. - Control para
detener escucha o cancelar acción.

El estado de escucha debe ser siempre visible. Implementar push-to-talk
primero. La palabra de activación opcional debe funcionar localmente,
ser configurable y no habilitar escucha oculta.

## 5. Voz

### Entrada

1.  Usuario pulsa botón/atajo.
2.  UI indica que escucha.
3.  Captura audio durante la sesión autorizada.
4.  STT local o proveedor configurable transcribe.
5.  Se envía a Claude solo el texto y contexto autorizado.
6.  Se procesa la respuesta.
7.  Se muestra y reproduce.
8.  Usuario puede interrumpir.

### Salida

Voz original con: - Español latinoamericano natural. - Dicción
precisa. - Ritmo moderado. - Timbre cálido y tecnológico. - Entonación
sobria. - Personalidad profesional.

Permitir proveedor TTS intercambiable y alternativa local si existe.
Informar qué motor está activo y si requiere nube. No imitar exactamente
una voz protegida.

## 6. Arquitectura conceptual

1.  Desktop Shell: ventana y controles.
2.  Voice Input: captura y STT.
3.  Conversation Orchestrator: turnos, contexto y herramientas.
4.  Claude Adapter: API Anthropic.
5.  Speech Output: TTS.
6.  Project Context: índice de proyectos autorizados.
7.  Memory Store: preferencias y hechos aprobados.
8.  Tool Registry: herramientas registradas y esquemas.
9.  Permission Engine: autorización por acción.
10. Audit Log: registro local.
11. Settings: API, voz, privacidad, carpetas y costos.

Flujo:

`Usuario -> UI -> STT/Texto -> Orchestrator -> Claude -> Permission Engine -> Tool Registry -> Resultado -> Claude -> UI/TTS`

El modelo solo puede solicitar herramientas registradas. Cada parámetro
se valida antes de ejecutar.

## 7. Stack sugerido

Decidir luego de auditar entorno: - Desktop: Tauri + React + TypeScript;
Electron solo si existe razón técnica. - Backend local: Rust o servicio
local controlado. - IA: API oficial de Anthropic. - Persistencia:
SQLite. - Búsqueda: SQLite FTS5 inicialmente; embeddings locales
opcionales. - STT/TTS: adaptadores intercambiables. - IPC seguro entre
interfaz y backend. - Instalador Windows.

No asumir que un motor de voz está instalado ni que un modelo es
gratuito. Verificar licencias, compatibilidad y costos.

## 8. Integración con Claude

-   API oficial desde backend local.
-   API key en almacén seguro del sistema operativo.
-   Nunca exponer clave en frontend, logs, repositorio o archivos
    compartidos.
-   Timeouts, cancelación y manejo de errores.
-   Mostrar cuándo se envían datos a la nube.
-   Contexto limitado a carpetas/proyectos autorizados.
-   Separar instrucciones de sistema, contenido de archivos y mensajes
    del usuario.
-   Tratar documentos como datos no confiables: nunca obedecer
    instrucciones privilegiadas encontradas en ellos.

No automatizar la interfaz web de Claude ni extraer sesiones del
navegador.

## 9. Gestión de proyectos

El usuario registra explícitamente cada proyecto: - Nombre y
descripción. - Carpeta raíz autorizada. - Objetivos. - Archivos
indexados. - Tareas. - Decisiones. - Historial de actividad. - Permisos.

Funciones: - Crear y listar proyectos. - Indexar y buscar archivos
autorizados. - Resumir documentación. - Consultar pendientes. - Preparar
tareas e informes. - Registrar decisiones. - Comparar cambios
documentales. - Mostrar última actividad conocida.

No asumir acceso a todo el disco. El usuario selecciona las carpetas.

## 10. Herramientas locales

### Solo lectura

-   Buscar archivos autorizados.
-   Leer documentos permitidos.
-   Listar proyectos y tareas.
-   Consultar estado de repositorios.
-   Consultar información de sistema no sensible.

### Preparación

-   Crear borradores.
-   Preparar documentos.
-   Proponer cambios de código.
-   Preparar comandos para revisión.

### Con confirmación

-   Escribir/modificar archivos.
-   Ejecutar comandos.
-   Instalar dependencias.
-   Cambiar configuración.
-   Enviar correos o mensajes.
-   Publicar cambios.
-   Eliminar archivos.
-   Ejecutar operaciones externas.

No crear un ejecutor genérico e irrestricto de shell. Preferir comandos
permitidos, directorios delimitados, argumentos validados y ejecución
aislada. Para acciones destructivas, mostrar exactamente qué ocurrirá y
pedir confirmación adicional.

## 11. Memoria y contexto

Separar: - Contexto temporal. - Datos de proyectos. - Preferencias
explícitas. - Memoria aprobada. - Índice de archivos.

Permitir ver, corregir, desactivar y eliminar memoria local; excluir
carpetas y reconstruir índices. No guardar contraseñas, API keys ni
información sensible innecesaria.

## 12. Personalidad

Nombre de trabajo: JARVIS, configurable.

Personalidad profesional, serena, inteligente, cortés, directa y
honesta. Proactividad solo autorizada. Nunca afirmar que completó una
acción sin confirmación de la herramienta.

Ejemplos: - "Jarvis, ¿qué proyectos tengo activos?" - "Resumime los
pendientes de ZESTIA." - "Buscá en la documentación de Delivery cómo
definimos las liquidaciones." - "Prepará un informe de los cambios de
esta semana." - "Proponé una respuesta, pero no la envíes."

## 13. Privacidad y seguridad

-   Indicador visible del micrófono.
-   Silencio inmediato.
-   No almacenar audio bruto por defecto.
-   Transcripciones persistentes solo si el usuario lo activa.
-   Cifrado de datos locales sensibles.
-   API keys en almacén seguro.
-   Permisos por carpeta y herramienta.
-   Confirmación antes de enviar datos externamente.
-   Registro de acciones.
-   Protección contra prompt injection en documentos.
-   No abrir puertos locales innecesarios.
-   Validar IPC y restringir comandos.

## 14. Roadmap

**Fase 0:** diagnóstico de Windows, hardware, micrófono, audio, opciones
STT/TTS y costos.\
**Fase 1:** ventana, chat, API Claude, clave segura e historial.\
**Fase 2:** push-to-talk, STT, TTS e interrupción.\
**Fase 3:** proyectos, carpetas autorizadas, índice y búsqueda.\
**Fase 4:** herramientas, permisos, confirmaciones y auditoría.\
**Fase 5:** flujos de trabajo e integraciones opt-in.

## 15. Criterios de aceptación del MVP

-   Funciona en el equipo objetivo.
-   Chat de texto conectado a Claude.
-   Clave protegida.
-   Push-to-talk operativo.
-   Respuesta hablada y escrita.
-   Interrupción de audio.
-   Micrófono siempre visible cuando está activo.
-   Proyectos y carpetas autorizadas.
-   Búsqueda y resumen de documentos.
-   Sin ejecución de herramientas no registradas.
-   Confirmación para acciones sensibles.
-   Historial y memoria administrables.
-   Documentación de instalación y solución de problemas.

## 16. Prompt maestro para Claude Code

Quiero que construyas JARVIS DESKTOP: un asistente personal para Windows
con conversación por voz y texto, conectado a Claude mediante API
oficial.

Leé este documento completo. Tu primera tarea es investigar y
planificar, no programar inmediatamente.

1.  Inspeccioná el entorno y herramientas disponibles.
2.  Verificá sistema operativo, runtimes y hardware necesario.
3.  Comprobá micrófono y salida de audio.
4.  Compará opciones compatibles de STT/TTS.
5.  Proponé arquitectura modular.
6.  Definí protección de API key.
7.  Diseñá permisos, confirmaciones y auditoría.
8.  Definí MVP, pruebas, riesgos y roadmap.
9.  Presentá diagnóstico y plan.

No intentes clonar la voz de JARVIS. Diseñá una voz original con estilo
tecnológico, sobrio y natural. No crees acceso ilimitado al sistema
operativo. Esperá aprobación antes de implementar.

## 17. Documentación que debe mantenerse

-   `README.md`
-   `docs/PRODUCT_SPEC.md`
-   `docs/ARCHITECTURE.md`
-   `docs/VOICE_PIPELINE.md`
-   `docs/CLAUDE_API.md`
-   `docs/TOOLS_AND_PERMISSIONS.md`
-   `docs/PRIVACY_AND_SECURITY.md`
-   `docs/MEMORY_AND_CONTEXT.md`
-   `docs/ROADMAP.md`
-   `docs/DECISIONS.md`
-   `docs/INSTALLATION.md`
-   `docs/TROUBLESHOOTING.md`

**Regla final:** JARVIS debe ser útil, transparente y controlable; nunca
un proceso opaco con acceso ilimitado al equipo.
