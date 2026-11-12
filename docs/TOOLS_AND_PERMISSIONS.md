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

## 3. Reglas del owner (ejemplo)

```jsonc
{
  "rules": [
    { "server": "fs", "tool": "read", "scope": "project:*", "decision": "allow" },
    { "server": "fs", "tool": "write", "scope": "project:notas", "decision": "allow_with_audit" },
    { "server": "mail", "tool": "send", "decision": "always_confirm" }
  ]
}
```

## 4. Audit Log

Append-only. Cada entrada: timestamp, turno, servidor/tool, argumentos (con secretos redactados), decisión, quién aprobó, resultado, duración, costo asociado. Consultable por UI y por voz ("¿qué hiciste hoy?"). Export JSONL.

## 5. Regla de honestidad

Jarvis **nunca** dice que hizo algo sin un resultado exitoso de la herramienta. Si falla, lo dice.
