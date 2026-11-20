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
