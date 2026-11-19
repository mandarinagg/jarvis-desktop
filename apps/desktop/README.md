# apps/desktop

UI de escritorio en Electron + React + TypeScript. Es un **cliente delgado** del Core: muestra el chat, el historial de conversaciones y el gasto del día contra el tope.

## Uso
```powershell
pnpm build
pnpm --filter @jarvis/desktop start
```
Si el Core no está corriendo, la app lo arranca con el runtime de Electron (`ELECTRON_RUN_AS_NODE=1`), desacoplado (ADR-008). Cerrar la ventana no apaga el Core.

## Voz (Fase 2)
- **Atajo global** `Ctrl+Shift+Space` (si está ocupado, `Ctrl+Alt+J`; se cambia con `JARVIS_PTT_SHORTCUT`). Electron solo avisa cuando se aprieta una tecla, no cuando se suelta, así que el atajo funciona como **interruptor**: la primera vez empieza a escuchar y la segunda termina. Apretarlo mientras Jarvis piensa o habla lo interrumpe (barge-in).
- **«Mantené para hablar»** en la ventana: se habla mientras está apretado, como un walkie-talkie.
- **Overlay:** una píldora chica, siempre visible, que no toma el foco ni los clics, abajo al centro de la pantalla. Muestra el estado (escuchando, transcribiendo, pensando, hablando). **El proceso principal decide cuándo se ve**: mientras el micrófono está abierto se muestra siempre, y nada en un renderer puede ocultarlo.
- Los turnos de voz aparecen en la conversación como mensajes normales: lo que se entendió y la respuesta en streaming.

## Seguridad (ADR-002 / PRIVACY_AND_SECURITY)
- `contextIsolation`, `sandbox` y sin `nodeIntegration`.
- CSP estricta: solo recursos propios, sin conexiones de red desde el renderer.
- El preload expone solo `send`, `onMessage`, `onStatus` y `onHotkey`.
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
