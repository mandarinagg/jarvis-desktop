# ADR-008: Ciclo de vida de procesos y transporte IPC

- **Estado:** Aceptada — por delegación del owner (2026-11-12); revisable al cerrar Fase 2
- **Fecha:** 2026-11-12

## Contexto
ADR-001 define Core + clientes con named pipe, pero el diagrama de `ARCHITECTURE.md` usaba "stdio / websocket loopback" para la voz, y nadie definía quién arranca, supervisa y reinicia cada proceso.

## Decisión
**Procesos**
- El **Core** es el proceso raíz. Arranca al iniciar sesión en Windows (entrada en el inicio del usuario; opt-in, desactivable) o lo lanza la UI si no está corriendo.
- **Instancia única:** al arrancar, el Core intenta crear el pipe; si ya existe, sale.
- El **Voice Service** es un **proceso hijo del Core** y lo supervisa el Core: reinicio con backoff exponencial (1 s → 30 s) y, tras 5 caídas en 10 minutos, queda en estado `degradado` (Jarvis sigue por texto y avisa).
- La **UI** es un cliente más: abrirla o cerrarla no afecta al Core.

**Transporte**
- **Clientes ↔ Core:** named pipe `\\.\pipe\jarvis-core-<usuario>` con ACL restringida al usuario actual + token de sesión de 256 bits en `%APPDATA%/Jarvis/run/session.token` (renovado en cada arranque). Primer mensaje obligatorio: `auth.hello` con el token.
- **Voice Service ↔ Core:** **stdio** del proceso hijo, en JSON Lines. No hay puertos ni pipes adicionales: solo el Core puede hablar con la voz.
- **Audio:** nunca cruza el IPC. El micrófono y el parlante viven dentro del Voice Service; por IPC solo viajan eventos y texto.
- **Framing:** JSON Lines (un mensaje por línea, máximo 1 MB). Cada mensaje se valida con Zod (`packages/shared`) al entrar; los inválidos se descartan y se registran.
- **Versionado:** `auth.hello` incluye `protocolVersion`; si no coincide la versión mayor, se rechaza con un error claro.

**Apagado**
- `core.shutdown` → cancela turnos en curso → `tts.cancel` → espera 3 s a que la voz termine → cierra la DB (checkpoint WAL).

**Empaquetado (validado el 2026-11-13: el Node 24.22 de Electron 45 trae `node:sqlite` con FTS5 y carga `@napi-rs/keyring`; la UI arranca el Core así)**
- Opción preferida: correr el Core con el runtime de Electron (`ELECTRON_RUN_AS_NODE=1`) para no distribuir un segundo Node. Es válida solo si la versión de Node incluida en Electron trae `node:sqlite` (ADR-007); si no, se distribuye Node LTS junto al Core.

## Alternativas consideradas
- **WebSocket en loopback:** sencillo y multiplataforma, pero abre un puerto TCP local que cualquier proceso puede sondear.
- **Voice Service como proceso independiente con su propio pipe:** más desacoplado, pero suma superficie de ataque y otra pieza que supervisar.

## Consecuencias
- (+) Sin puertos de red abiertos; superficie IPC mínima y autenticada.
- (+) Comportamiento claro ante caídas; la voz nunca tumba al Core.
- (−) Los clientes remotos (móvil/Telegram, Fase 7) necesitarán un gateway aparte (ADR futuro).
