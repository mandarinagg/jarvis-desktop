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

## Uso
```powershell
pnpm build
node packages/core/dist/main.js          # JARVIS_DATA_DIR y JARVIS_PIPE se pueden sobrescribir para dev
```

## Riesgo residual: ACL del pipe
Node (libuv) no permite fijar la ACL del named pipe. Windows le aplica la ACL por defecto: control total para el usuario creador, SYSTEM y los administradores, y **lectura para Everyone**. La protección efectiva es el **token de sesión**: sin él no se puede enviar nada útil, y un cliente sin autenticar no recibe datos. Si en algún momento hace falta una ACL explícita, va a requerir un binding nativo (se evalúa en la Fase 7).
