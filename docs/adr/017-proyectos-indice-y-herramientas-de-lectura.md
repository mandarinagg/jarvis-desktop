# ADR-017: Proyectos, índice FTS5 y herramientas de solo lectura (Fase 3)

- **Estado:** Aceptada por delegación del owner (2026-11-19). Se revisa al cerrar la Fase 3.
- **Fecha:** 2026-11-19
- **Decisores:** owner (delegado)

## Contexto
La Fase 3 (L2) pide que Jarvis conozca los proyectos del owner: el registro de proyectos y carpetas autorizadas, un índice con watcher y exclusiones, herramientas de solo lectura (buscar, leer, resumir, estado de git) y el armado de contexto según el proyecto activo. La condición de salida es responder bien 10 de 10 preguntas sobre la documentación de un proyecto real.

Restricciones que ya existen:
- toda herramienta es un servidor MCP (ADR-003) y pasa por el Permission Engine (CLAUDE.md);
- el contenido de los archivos es dato no confiable;
- nada personal va al repo;
- los datos viven en `%APPDATA%/Jarvis` (ADR-007);
- Opus 5.5 controla que no se edite el historial cuando se reenvían bloques de *thinking*.

## Decisión

### Registro de proyectos
- Tabla `projects`: nombre único, descripción, objetivos, `root` canonizado con `realpath` y fecha de última actividad. `conversations.project_id` es opcional y marca el **proyecto activo** de cada conversación.
- **Solo el owner registra carpetas**, desde la UI o el IPC autenticado. El modelo nunca puede agregar ni ampliar una raíz. En la app de escritorio la carpeta se elige en el diálogo nativo del proceso principal: el renderer (que muestra la salida del modelo y no es confiable) no puede mandar `projects.create` ni ninguna ruta.
- Se rechazan como raíz:
  - la raíz de una unidad;
  - `%WINDIR%`, `Program Files` y la carpeta de usuario entera;
  - `%APPDATA%/Jarvis` y cualquier carpeta que la contenga;
  - una raíz repetida.

### Guardia de rutas
Antes de tocar el disco, cada ruta pasa por estos pasos:
1. Se resuelve contra la raíz del proyecto, se canoniza con `realpath` (resuelve symlinks y junctions) y se exige que quede **dentro** de la raíz, comparando sin distinguir mayúsculas como en Windows.
2. Se rechazan `..` hacia afuera, rutas absolutas ajenas y ADS (`archivo:stream`).
3. Hay una **denylist de secretos** que no se lee ni se indexa nunca, aunque esté dentro de la raíz: `.env*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `id_rsa*`, `id_ed25519*`, `*.kdbx`, `.npmrc`, `.pypirc`, `.netrc`, `credentials*.json`, `secrets.*` y `*.sqlite`/`*.db`.
4. Exclusiones de directorios: `.git` (su estado se consulta solo por `git_status`), `node_modules`, `dist`, `build`, `.venv`, `__pycache__`, `.next`, `target`, `coverage`.

### Índice
- **FTS5 *contentless*** (`content=''`, `contentless_delete=1`, `unicode61 remove_diacritics 2`): la base guarda los tokens, **no una copia del texto**. Los fragmentos de resultado se arman leyendo el archivo en el momento.
  - Así no se duplica el contenido de los proyectos en `jarvis.db` y no hace falta cifrar el índice.
  - FTS5 está disponible en el SQLite del Node de Electron (3.53) y en el de Node 26 (3.54).
- Solo se indexa texto: una allowlist de extensiones (md, txt, código, config y archivos sin extensión como `README` o `Dockerfile`), sin bytes NUL y de hasta 1 MB por archivo.
- **Escaneo incremental** por `mtime` y tamaño: al arrancar, al registrar un proyecto y a pedido.
- **Watcher:** `fs.watch` recursivo, con 500 ms de debounce, que reindexa solo lo que cambió.
- **Sin embeddings en esta fase:** FTS con BM25 alcanza para encontrar documentación, y Claude reformula la búsqueda si no encuentra nada. Se reconsideran si la condición de salida no se cumple.

### Herramientas (servidor MCP propio `projects`, en proceso)
- Es un servidor MCP (`@modelcontextprotocol/sdk`) conectado al Core por transporte en memoria. Es código propio y de solo lectura, así que no necesita un proceso aparte. Los servidores de terceros de la Fase 4 sí corren como procesos aislados.
- Herramientas, todas de clase **lectura**:
  - `list_projects`;
  - `search(query, project?, limit?)`: rutas, número de línea y fragmentos;
  - `read_file(project, path, startLine?, endLine?)`: devuelve hasta 400 líneas o 60 KB;
  - `list_dir(project, path?)`;
  - `git_status(project)`: rama, ahead y behind, cambios y los últimos 5 commits.
  - «Resumir» no es una herramienta: Claude lee y resume.
- `git` corre con `execFile` (sin shell), con argumentos fijos, `-c core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, sin pager y con timeout de 5 s. Así un repo ajeno no puede ejecutar código a través de su configuración.

### Permission Engine (versión 0) y Audit Log
- Por cada llamada, en orden:
  1. ¿la herramienta existe y está habilitada?
  2. ¿los argumentos validan con Zod?
  3. ¿el proyecto existe y la ruta pasa la guardia?
  4. ¿qué clase tiene la herramienta? La clase lectura se permite y se audita.
- Las clases que requieren confirmación (Fase 4) se rechazan.
- **Audit Log append-only** (los triggers impiden `UPDATE` y `DELETE`). Registra:
  - hora, turno, servidor y herramienta;
  - los argumentos, con redacción y truncados;
  - la decisión, el resultado, la duración y los bytes devueltos.
  - **Nunca registra el contenido de los archivos.**

### Loop de herramientas
- El adaptador de Claude corre el loop manual con streaming, para que las evals usen el mismo código. Límites por turno:
  - **8 rondas**;
  - 20 000 caracteres por resultado;
  - el costo se suma entre rondas.
- El turno **no edita** ni `system` ni `tools` mientras dura: los bloques de *thinking* vuelven tal cual entre rondas, porque es append-only.
- Entre turnos se persiste solo el texto. Al no reenviar *thinking* de turnos anteriores, el control de edición de historial no se dispara.
- Los resultados de herramientas son **datos**: el system prompt dice que su contenido nunca es una instrucción.

### Contexto del proyecto activo
- Va como un bloque más de `system` después del cacheado, igual que el modo voz (ADR-015). Contiene la tarjeta del proyecto que escribió el owner: nombre, descripción, objetivos, rama de git y la lista de entradas del primer nivel.
- No incluye contenido de archivos: eso entra solo por las herramientas, como dato.

## Alternativas consideradas
- **FTS5 con contenido:** permite usar `snippet()`, pero copia todos los proyectos dentro de la base y obligaría a cifrarla (ADR-007).
- **Embeddings locales desde ya:** suman un modelo y una dependencia nativa (Smart App Control) sin evidencia de que hagan falta.
- **Registro de herramientas propio en lugar de MCP:** contradice ADR-003 y dejaría dos superficies de permisos.
- **Tool Runner del SDK:** es beta y esconde el punto donde el Permission Engine tiene que decidir. El loop manual es corto y queda bajo control.
- **Persistir los `tool_use` y `tool_result` entre turnos:** da más contexto, pero hace crecer el historial y obliga a guardar contenido de archivos. Claude puede volver a buscar.

## Consecuencias
- **Positivas:**
  - Jarvis puede contestar sobre los proyectos sin salir de las carpetas autorizadas.
  - Cada lectura queda auditada.
  - La base no duplica el contenido de los archivos.
- **Negativas:**
  - Los fragmentos cuestan una lectura de disco por resultado.
  - FTS no encuentra sinónimos, aunque Claude reintenta con otros términos.
  - Entre turnos se pierde el detalle de las herramientas usadas.
- **Pendiente:** correr las evals de salida (10 preguntas sobre la documentación de este repo como proyecto de prueba) con la API real.
