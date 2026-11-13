# packages/core

Jarvis Core: un daemon en Node/TS. Cuando esté completo va a tener el orquestador, el router de modelos, el adaptador de Claude, el Permission Engine, el MCP Client Hub, la memoria, el índice, la auditoría y el medidor de costos (ver `docs/ARCHITECTURE.md`).

## Estado (Fase 1)
- **IPC (ADR-008):**
  - `CoreServer` escucha en el named pipe `\.\pipe\jarvis-core-<usuario>`.
  - Los mensajes van en JSON Lines y cada uno se valida con `@jarvis/shared`.
  - El primer mensaje tiene que ser `auth.hello`, dentro de un timeout de 5 s. El token se compara en tiempo constante y se chequea la versión mayor del protocolo.
  - Acepta como máximo 8 clientes.
- **Instancia única:** si el pipe ya existe, el Core sale con código 1. El token se escribe recién después de tomar el pipe.
- **Token de sesión:** 256 bits, nuevo en cada arranque, guardado en `%APPDATA%/Jarvis/run/session.token`. Se borra al apagar.
- **`CoreClient`:** el cliente que van a usar la UI, la CLI y los tests.
- **Logs:** JSON por stderr. `redact()` elimina antes de escribir las claves `sk-ant-…`, `AIza…`, los `Bearer …` y los tokens de 64 caracteres hex.

- **Persistencia (ADR-007):**
  - `node:sqlite` en modo WAL, en `%APPDATA%/Jarvis/jarvis.db`, con foreign keys activas.
  - Migraciones SQL versionadas en `migrations/`, aplicadas al arrancar dentro de una transacción.
  - `ConversationStore` guarda las conversaciones, los mensajes (con una marca de "interrumpido") y el uso por turno.
  - El uso por turno queda asociado al **día calendario local**, para el tope diario.
- **Secretos (ADR-007):** `KeyringSecretStore` usa el Windows Credential Manager, con servicio `Jarvis` y cuentas `anthropic-api-key` y `google-tts-api-key`.
- **Pendiente de ADR-007:** el cifrado AES-GCM de campos sensibles (llega con la memoria, en la Fase 3) y los backups `VACUUM INTO`.

- **Chat (L0):**
  - `ChatService` chequea el tope diario, guarda el mensaje, transmite la respuesta de Claude y después guarda la respuesta y el costo.
  - Permite un solo turno a la vez por conversación.
  - `chat.cancel`, o que el cliente se desconecte, cortan la respuesta. Lo dicho hasta ahí se guarda marcado como interrumpido.
- **Adaptador de Claude** (`claude/model.ts`):
  - usa el SDK oficial `@anthropic-ai/sdk` 1.8, siempre con streaming (`beta.messages.stream`);
  - cancela con `AbortSignal`, reintenta 2 veces ante 408/409/429/5xx y corta a los 120 s;
  - cachea el system prompt y el historial, y fija `effort: low` por defecto (configurable);
  - tiene **fallbacks del lado del servidor** activados (`fallbacks: "default"`): si Opus 5.5 rechaza un pedido, la API lo reintenta en el modelo recomendado.
  - Los errores se traducen a mensajes seguros, sin la clave.
- **Costo** (`claude/pricing.ts`): sale de los precios de lista (`CLAUDE_API.md` §4.1) y del modelo que realmente respondió. Un modelo desconocido se cobra al precio más caro, para que el tope nunca quede por debajo.
- **Prompt:** `prompts/system.md`. Es estable, sin fechas ni datos variables, para no romper la caché.

## Configuración (variables de entorno, opcionales)
| Variable | Default | Uso |
|---|---|---|
| `JARVIS_DAILY_BUDGET_USD` | `3` | Tope duro diario (día local) |
| `JARVIS_DEFAULT_MODEL` | `claude-opus-5-5` | Modelo |
| `JARVIS_EFFORT` | `low` | `low`…`max` (ADR-005: se calibra con evals) |
| `ANTHROPIC_API_KEY` | — | **Solo para desarrollo**: el Credential Manager tiene prioridad |
| `JARVIS_DATA_DIR` / `JARVIS_PIPE` | `%APPDATA%/Jarvis` / pipe del usuario | Para dev y tests |

## Chat por terminal
```powershell
node packages/core/dist/main.js          # en una terminal (el Core)
node packages/core/dist/chat-cli.js      # en otra: /nueva, /salir, Ctrl+C corta la respuesta
```

## Guardar la API key
```powershell
pnpm build
node packages/core/dist/set-secret.js anthropic-api-key                     # la pide sin mostrarla
Get-Clipboard | node packages/core/dist/set-secret.js anthropic-api-key     # o desde el portapapeles
```
La clave nunca pasa por argumentos, por el historial de la terminal ni por los logs.

## Uso
```powershell
pnpm build
node packages/core/dist/main.js          # JARVIS_DATA_DIR y JARVIS_PIPE se pueden sobrescribir para dev
```

## Riesgo residual: ACL del pipe
Node (libuv) no permite fijar la ACL del named pipe. Windows le aplica la ACL por defecto: control total para el usuario creador, SYSTEM y los administradores, y **lectura para Everyone**. La protección efectiva es el **token de sesión**: sin él no se puede enviar nada útil, y un cliente sin autenticar no recibe datos. Si en algún momento hace falta una ACL explícita, va a requerir un binding nativo (se evalúa en la Fase 7).
