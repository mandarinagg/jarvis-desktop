# Herramientas y permisos

> Decisión base: ADR-003 (MCP). Principio: **el modelo solo puede pedir; el Permission Engine decide.**

## 1. Clases de herramientas

| Clase | Ejemplos | Política por defecto |
|-------|----------|----------------------|
| **Lectura** | buscar/leer archivos autorizados, listar proyectos/tareas, estado git, info de sistema no sensible | Permitido, auditado |
| **Preparación** | crear borradores, proponer cambios de código, preparar comandos | Permitido en zona de borradores, auditado |
| **Con confirmación** | escribir/modificar archivos, ejecutar comandos de allowlist, instalar dependencias, cambiar config, enviar mails/mensajes, publicar, operaciones externas | Confirmación del owner por acción |
| **Destructiva** | eliminar archivos, force push, borrar datos | Confirmación **doble** con vista exacta de lo que pasará |
| **Prohibida** | shell genérico irrestricto, acceso fuera de carpetas autorizadas, leer el almacén de credenciales | Bloqueado siempre |

### Herramientas actuales (servidor `projects`, ADR-017 y ADR-019)

| Herramienta | Clase |
|---|---|
| `list_projects`, `search`, `read_file`, `list_dir`, `git_status`, `git_diff` | lectura |
| `write_file`, `edit_file`, `git_commit` | con confirmación |
| `delete_file` (mueve a la papelera de Jarvis) | destructiva |
| `jarvis__recent_activity` | lectura |

Jarvis no tiene shell, push, instalación de dependencias ni mensajería.

### Memoria (servidor `memory`, ADR-024)
| Herramienta | Clase |
|---|---|
| `search`, `explain` | lectura |
| `set_thinking_mode` | preparación |
| `remember`, `save_idea`, `update_idea`, `forget` (texto exacto en el diálogo) | con confirmación |

Antes de pedir el OK se rechaza todo lo que parezca un secreto. La confirmación es la defensa contra el envenenamiento de memoria: una injection no puede guardar nada sin que el owner lo vea.

### Builder (servidor `builder`, ADR-023)
| Herramienta | Clase |
|---|---|
| `task_status` | lectura |
| `cancel_task` | preparación (solo detiene) |
| `start_task` (tarea, presupuesto y comandos exactos), `merge_task` (diff completo), `discard_task` | con confirmación |

- El agente trabaja en un git worktree propio, fuera del proyecto, con un hook que permite o rechaza cada herramienta: archivos solo dentro del worktree (nunca `.git` ni secretos) y Bash solo para comandos simples de la allowlist.
- Por defecto la allowlist trae solo git de lectura. Los comandos que corren código (tests) los habilita el owner por proyecto en `%APPDATA%/Jarvis/builder.json`:
  ```json
  { "budgetUsd": 1, "projects": { "Recetario": { "commands": ["node --test", "npm test"] } } }
  ```
- Cada llamada del agente queda en el audit log (server `builder`) con rutas y comandos, nunca contenidos.

### Servidores de terceros (ADR-020)
Se registran en `%APPDATA%/Jarvis/mcp-servers.json` (solo el owner).
- Cada herramienta pide confirmación salvo que el owner la clasifique: `"tools": { "list_issues": "read", "*": "confirm" }`.
- Las anotaciones del servidor se ignoran.
- Cada servidor corre en su propio proceso, con un entorno mínimo y su propia carpeta de trabajo, sin las claves de Jarvis.
- Sus credenciales se guardan con `node packages/core/dist/set-secret.js mcp:<nombre>` y se referencian como `"keyring:<nombre>"`.

## 2. Permission Engine

> **Estado (Fase 4, ADR-018):** versión 1. `evaluate` devuelve `allow`, `ask` o `deny`. Las clases con confirmación piden el OK del owner en un **diálogo nativo** del proceso principal de la app de escritorio o en la CLI; el renderer nunca puede aprobar. Las destructivas piden dos confirmaciones y ninguna regla las baja. Sin respuesta en 2 minutos, o con el turno cancelado, se deniega. Por voz, Jarvis avisa que la confirmación está en pantalla: todavía no hay confirmación hablada (ADR-018).
>
> **Antes (Fase 3, ADR-017):** la versión 0 está en `packages/core/src/tools/`. La clase de riesgo de cada herramienta la registra el Core, no se toma de las anotaciones MCP. La clase lectura se permite y se audita, y el resto se rechaza hasta que exista el flujo de confirmación de la Fase 4. Las rutas pasan la guardia de `projects/guard.ts` (`realpath` y denylist de secretos). El audit log (`audit_log`, migración 004) es append-only por triggers y nunca guarda el contenido devuelto, solo su tamaño.

Para cada tool call evalúa en orden:
1. ¿El servidor MCP y la tool están habilitados?
2. ¿Los argumentos validan contra el esquema? (Zod)
3. ¿Las rutas están dentro de las carpetas autorizadas? (normalizar, resolver symlinks, bloquear `..`)
4. ¿Qué clase de riesgo tiene esta llamada concreta?
5. ¿Hay una regla del owner que la permita ("siempre permitir leer en proyecto X")?
6. Si requiere confirmación → `permission.request` a la UI/voz con resumen legible y diff si aplica.
7. Registrar decisión y resultado en el Audit Log.

### Confirmación por voz
Para acciones de riesgo medio: "¿Confirmás que cree `notas.md` en Proyecto X?" → "sí, confirmo". Para destructivas o externas: **siempre** confirmación en pantalla.

## 3. Reglas del owner

Viven en `%APPDATA%/Jarvis/permissions.json`. Se aplican sin reiniciar y ninguna herramienta puede editarlas (ADR-018).

```jsonc
{
  "rules": [
    // escribir en el proyecto «notas» sin preguntar (queda auditado como "rule")
    { "server": "projects", "tool": "write_file", "project": "notas", "decision": "allow" },
    // pedir confirmación incluso para leer el proyecto «banco»
    { "tool": "*", "project": "banco", "decision": "confirm" },
    // nunca usar un servidor de terceros
    { "server": "mail", "decision": "deny" }
  ]
}
```

- `server` y `tool` aceptan `*` (es el valor por defecto). `project` limita la regla a las llamadas con ese proyecto.
- Si coinciden varias reglas, gana la más segura: `deny` > `confirm` > `allow`.
- `allow` solo sirve para la clase con confirmación. Ninguna regla habilita una destructiva sin la doble confirmación ni una prohibida.

## 4. Audit Log

Append-only. Cada entrada registra:
- timestamp, turno, servidor y tool;
- argumentos, con secretos redactados;
- decisión y quién aprobó (`policy`, `rule` u `owner:<cliente>`);
- resultado y duración.

Se consulta en la app (panel **Actividad**) y por voz o texto con la herramienta `jarvis__recent_activity` («¿qué hiciste hoy?»). La exportación a JSONL la escribe el Core en `%APPDATA%/Jarvis/exports/`.

## 5. Regla de honestidad

Jarvis **nunca** dice que hizo algo sin un resultado exitoso de la herramienta. Si falla, lo dice.
