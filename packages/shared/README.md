# packages/shared

Tipos y esquemas Zod de los contratos IPC (Core ↔ UI ↔ Voice). Es la **única fuente de verdad** de los mensajes (ADR-008).

- `framing.ts`: JSON Lines (un mensaje por línea, máximo 1 MB). `LineDecoder` trabaja sobre bytes, así que un carácter UTF-8 partido entre dos chunks llega entero. Además corta a tiempo si el peer manda más de 1 MB sin salto de línea.
- `protocol.ts`: mensajes con versión `PROTOCOL_VERSION`. Los objetos son estrictos: rechazan campos extra. Los errores de validación nunca repiten los valores de entrada, porque pueden traer el token de sesión.

| Dirección | Mensajes |
|-----------|----------|
| Cliente → Core | `auth.hello`, `core.ping`, `core.shutdown`, `chat.send`, `chat.cancel` |
| Core → Cliente | `auth.ok`, `core.pong`, `error`, `chat.started`, `chat.delta`, `chat.done` |

Después de conectarse, el primer mensaje tiene que ser `auth.hello`. Si no coincide la versión mayor del protocolo, el Core rechaza la conexión.
