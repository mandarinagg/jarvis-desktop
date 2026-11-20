# ADR-018: Confirmaciones del owner, reglas y auditoría consultable (Fase 4)

- **Estado:** Aceptada por delegación del owner (2026-11-20). Se revisa al cerrar la Fase 4.
- **Fecha:** 2026-11-20
- **Decisores:** owner (delegado)

## Contexto
La Fase 4 (L3: Manos) suma acciones con efectos: escribir archivos, commitear, usar servidores MCP de terceros. Hasta ahora el Permission Engine v0 (ADR-017) dejaba pasar solo lecturas y rechazaba todo lo demás. Falta lo que pide `TOOLS_AND_PERMISSIONS.md`:
- confirmación del owner por acción;
- confirmación doble para lo destructivo;
- reglas del owner;
- un audit log que se pueda consultar desde la UI y por voz, y exportar como JSONL.

La condición de salida es 0 acciones sensibles sin confirmación en 50 pruebas, 10 de ellas ataques de prompt injection.

El riesgo central es que quien aprueba no puede ser algo que el modelo controle. El renderer de la app muestra la salida del modelo, así que no es confiable (mismo criterio que `projects.create` en ADR-017).

## Decisión

### Permission Engine v1
`evaluate(server, tool, args)` devuelve `allow`, `ask` (con 1 o 2 confirmaciones) o `deny`.

| Clase | Sin reglas | Qué pueden cambiar las reglas |
|---|---|---|
| lectura / preparación | `allow` | `deny` o pedir confirmación (`confirm`) |
| con confirmación | `ask` ×1 | `deny`, o `allow` (corre sin preguntar, auditado como `rule`) |
| destructiva | `ask` ×2 | solo `deny`: **ninguna regla la baja** |
| prohibida | `deny` | nada |

- La clase de riesgo la registra el Core por herramienta. Nunca se toma de las anotaciones MCP (`readOnlyHint`), que escribe el servidor.
- Las reglas viven en `%APPDATA%/Jarvis/permissions.json`: `{ "rules": [{ "server", "tool", "project"?, "decision" }] }`.
  - `server` y `tool` aceptan `*`.
  - `project` (sin distinguir mayúsculas) limita la regla a las llamadas con ese proyecto. Una regla con proyecto no aplica a llamadas sin proyecto.
  - Si coinciden varias reglas, **gana la más segura** (deny > confirm > allow). Así una regla amplia de `deny` no la abre una más específica.
  - El archivo se vigila (cada 2 s) y los cambios aplican sin reiniciar. Si está roto, se ignora y queda un warning en el log.
- La carpeta de Jarvis no puede ser raíz de un proyecto (ADR-017). Por eso ninguna herramienta puede editar las reglas.

### Flujo de confirmación
1. El hub arma una **vista previa** con los argumentos ya validados: un título y un detalle, que en la Fase 4 es el diff exacto para las escrituras. La escribe el Core, no es texto libre del modelo. Si la vista previa falla (ruta inválida, etc.), la llamada se rechaza sin preguntar.
2. El `ConfirmationBroker` manda `permission.request` (protocolo 1.3) a las sesiones `desktop` y `cli`, nunca a `voice`. La primera respuesta gana y las demás reciben `permission.resolved`, que cierra sus diálogos.
3. **Se deniega si:**
   - no hay respuesta en 2 minutos;
   - el turno se cancela (barge-in, `chat.cancel`);
   - se cierran todas las pantallas a las que se preguntó;
   - responde una sesión a la que no se le preguntó;
   - una destructiva llega con menos de 2 confirmaciones.
4. **En el escritorio el diálogo es nativo** (`dialog.showMessageBox` del proceso principal):
   - el botón por defecto es «Rechazar», así un Enter nunca aprueba;
   - las destructivas tienen un segundo diálogo, «¿Seguro?».
   - `permission.respond` **no está** en el allowlist del renderer, así que la salida del modelo que se renderiza ahí no puede aprobar nada.
5. **En la CLI** se pregunta en la terminal. Las destructivas piden escribir `BORRAR`.
6. **Por voz** Jarvis dice «Necesito que me lo confirmes en pantalla.» y espera. No hay confirmación hablada en esta versión: la transcripción podría venir de un audio reproducido con el texto «sí, confirmo».
7. El renderer solo muestra el estado: `chat.tool` con `status: "waiting"` → «esperando tu confirmación».
8. Si el owner rechaza, el resultado que ve el modelo es «Permiso denegado: … No lo reintentes salvo que el owner te lo pida de nuevo.».

### Audit log consultable
- La migración 005 agrega `approved_by` con uno de estos valores: `policy`, `rule` u `owner:<cliente>`. La tabla sigue siendo append-only (ADR-017).
- En la UI, el panel **Actividad** muestra las últimas 100 entradas (`audit.list`, con paginación por `beforeId`).
- La **exportación** (`audit.export`) la escribe el Core como JSONL en `%APPDATA%/Jarvis/exports/`, así ningún cliente elige dónde va a parar un archivo. El escritorio abre la carpeta solo si la ruta está dentro de `exports/`.
- **Por voz o texto**, el servidor propio `jarvis` expone `recent_activity`, de clase lectura: «¿qué hiciste hoy?». Lee el audit log, que ya tiene los argumentos redactados, y se omite a sí mismo.

## Alternativas consideradas
- **Confirmar desde el renderer (un modal en React):** es más lindo y deja mostrar diffs largos, pero un XSS o una salida del modelo mal escapada podría aprobar sola. El diálogo nativo es feo y seguro. Si hace falta mostrar diffs largos, el paso siguiente es una ventana dedicada sin contenido del renderer principal.
- **Confirmación por voz para el riesgo medio** (como sugiere `TOOLS_AND_PERMISSIONS`): se posterga. La transcripción no autentica al hablante y sin AEC Jarvis podría oírse a sí mismo. Se reconsidera con la wake word y la verificación de hablante.
- **Reglas en la base de datos editadas desde la UI:** el archivo es más simple de auditar y versionar. La UI de reglas puede venir después.
- **Dejar que la regla más específica gane:** es más expresivo, pero una regla puntual podría abrir algo que una general cerraba. Gana la más segura.

## Consecuencias
- **Positivas:**
  - Ninguna acción con efectos corre sin una decisión explícita: del owner, o de una regla que escribió el owner.
  - Las destructivas siempre piden dos confirmaciones.
  - Todo queda auditado con quién lo aprobó.
- **Negativas:**
  - Sin una pantalla abierta (solo voz), las acciones con confirmación se deniegan.
  - El diálogo nativo recorta los diffs a unas 40 líneas.
- **Pendiente:**
  - las herramientas de escritura que usan este flujo;
  - los servidores de terceros;
  - las evals de injection (siguientes PRs de la Fase 4).
