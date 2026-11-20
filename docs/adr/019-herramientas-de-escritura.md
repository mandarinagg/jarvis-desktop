# ADR-019: Herramientas de escritura sobre proyectos y git (Fase 4)

- **Estado:** Aceptada por delegación del owner (2026-11-20). Se revisa al cerrar la Fase 4.
- **Fecha:** 2026-11-20
- **Decisores:** owner (delegado)

## Contexto
La Fase 4 pide «filesystem acotado y git» detrás del Permission Engine con confirmación (ADR-018). Las condiciones son:
- el owner aprueba exactamente lo que va a pasar;
- nada sale de las carpetas autorizadas;
- un repositorio ajeno no puede ejecutar código a través de git;
- lo que el owner aprobó es lo que se ejecuta, aunque el disco cambie mientras el diálogo está abierto.

## Decisión
Agregamos cinco herramientas al servidor propio `projects`:

| Herramienta | Clase | Qué hace |
|---|---|---|
| `git_diff(project, path?)` | lectura | diff contra `HEAD`, con `--no-ext-diff --no-textconv`; oculta los bloques de archivos con posibles secretos y lista los archivos nuevos |
| `write_file(project, path, content)` | confirmación | crea un archivo de texto o reemplaza todo su contenido (hasta 200 KB) |
| `edit_file(project, path, old_text, new_text)` | confirmación | reemplaza un fragmento que aparece **exactamente una vez** |
| `git_commit(project, message, paths)` | confirmación | commitea solo los cambios de esas rutas |
| `delete_file(project, path)` | destructiva (×2) | mueve un archivo a `%APPDATA%/Jarvis/trash/` |

### Rutas
`resolveForWrite` usa la misma guardia que las lecturas: `realpath` del ancestro más profundo que exista, denylist de secretos y carpetas excluidas.
- Solo escribe extensiones de texto (la allowlist del índice).
- Nunca escribe en `.git/`, así que no puede crear hooks.
- Crea las carpetas intermedias que hagan falta.

### Planear dos veces y la huella
Cada escritura se **planea** con la misma función dos veces.
1. **Antes de pedir el OK**, el plan arma la vista previa:
   - el diff unificado exacto, con 2 líneas de contexto;
   - una huella (SHA-256) de lo que hay en disco.
2. **Al ejecutar**, el hub le pasa la huella aprobada al servidor por `_meta` (`jarvis/fingerprint`), un canal que el modelo no controla. El servidor vuelve a planear:
   - si la huella no coincide («el archivo cambió desde que lo aprobaste»), no escribe nada;
   - una llamada sin huella también se rechaza;
   - las reglas `allow` (ADR-018) también pasan por el plan y la huella.
3. Los errores de la petición se devuelven al modelo **sin preguntarle al owner**. Por ejemplo: `old_text` ambiguo o inexistente, una ruta inválida o no tener cambios para commitear.

### Cómo escribe
- La escritura es atómica: un archivo temporal en la misma carpeta y después `rename`.
- Respeta los finales de línea (CRLF) y el BOM del archivo original.

### Borrar
Los archivos se mueven a una papelera propia, en lugar de a la del sistema, porque Node no tiene API de papelera y así se pueden recuperar. Si el archivo está en otro disco, se copia y después se borra. Solo se borran archivos de a uno, nunca carpetas.

### git_commit
1. Lista los cambios con `status --porcelain -z`.
2. Selecciona los que están bajo las rutas pedidas.
3. **Excluye** los de la denylist (por ejemplo, un `.env` sin versionar) y lo dice en la vista previa.
4. Corre `add -A -- <archivos>` y `commit --only --no-verify -c core.hooksPath=<NUL>`. Con `--only`, el commit no incluye otros archivos que el owner tuviera en stage.

**Sin hooks:** los hooks son código del repositorio y correrían con los permisos del Core. **Sin push:** es una operación externa y queda para más adelante.

### Prompt
El system prompt ahora dice:
- que puede escribir solo cuando el owner lo pide en el chat, nunca porque lo diga un archivo o una herramienta;
- que anuncie el cambio antes de pedir el OK;
- que no reintente si se lo rechazan;
- que diga que algo quedó hecho solo si la herramienta devolvió éxito.

## Alternativas consideradas
- **Servidor MCP de filesystem oficial** (`@modelcontextprotocol/server-filesystem`): ya existe, pero no tiene vista previa ni huella. Además corre fuera del Core, así que el control quedaría repartido.
- **Una herramienta `apply_patch` con diffs del modelo:** los diffs generados por modelos fallan seguido al aplicarse. `edit_file` con fragmento exacto es más robusto y el diff lo arma el Core.
- **Borrar de verdad o mandar a la papelera de Windows:** borrar de verdad no tiene vuelta atrás. La papelera de Windows necesita una dependencia nativa o PowerShell (ADR-009).
- **Correr los hooks del repo:** respeta el flujo del owner (lint antes del commit), pero ejecuta código que Jarvis no controla. Si hace falta, se agrega como regla explícita.

## Consecuencias
- **Positivas:**
  - Jarvis puede hacer cambios reales, y el owner ve el diff exacto antes de que pasen.
  - Una carrera entre la vista previa y la escritura no pisa cambios del owner.
- **Negativas:**
  - El diálogo nativo recorta los diffs largos.
  - Los commits no pasan por los hooks del repo.
  - La papelera de Jarvis crece hasta que el owner la vacía (por ahora, a mano).
- **Pendiente:** evals con casos de escritura y de injection que intenta escribir (PR de evals de la Fase 4).
