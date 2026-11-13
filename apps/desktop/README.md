# apps/desktop

UI de escritorio en Electron + React + TypeScript. Es un **cliente delgado** del Core: muestra el chat, el historial de conversaciones y el gasto del día contra el tope.

## Uso
```powershell
pnpm build
pnpm --filter @jarvis/desktop start
```
Si el Core no está corriendo, la app lo arranca con el runtime de Electron (`ELECTRON_RUN_AS_NODE=1`), desacoplado (ADR-008). Cerrar la ventana no apaga el Core.

## Seguridad (ADR-002 / PRIVACY_AND_SECURITY)
- `contextIsolation`, `sandbox` y sin `nodeIntegration`.
- CSP estricta: solo recursos propios, sin conexiones de red desde el renderer.
- El preload expone solo `send`, `onMessage` y `onStatus`.
- El proceso principal **vuelve a validar** cada mensaje del renderer contra una lista permitida (`bridge.ts`). El renderer nunca puede mandar `auth.hello` ni `core.shutdown`.
- Sin navegación ni ventanas nuevas. Los links `https` se abren en el navegador del sistema.
- El token de sesión vive solo en el proceso principal.

## Diseño
Un panel de instrumentos sobrio:
- **Paleta:** pizarra azulada, verde salvia como acento de "señal" y ámbar solo para alertas de gasto.
- **Tipografía:** Bahnschrift para títulos y datos, Segoe UI Variable para el texto. Las dos vienen con Windows, así que no hace falta red.
- **Transcripción:** lo que dice Jarvis va con una línea vertical de canal; tus mensajes van más chicos, indentados.
- **Medidor de gasto:** pasa a ámbar al 80% del tope (ADR-005). Al 100% se bloquea el envío.

## Prueba de humo (desarrollo)
```powershell
electron apps/desktop --smoke-screenshot=C:\ruta\captura.png --smoke-open-first
```
Abre la app, carga los datos, abre la primera conversación, saca una captura y sale.
