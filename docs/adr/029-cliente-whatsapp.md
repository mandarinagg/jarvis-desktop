# ADR-029: Cliente móvil por WhatsApp con el número del owner (Fase 7)

- **Estado:** Aceptada por el owner (2026-11-22).
- **Fecha:** 2026-11-22
- **Decisores:** owner

## Contexto
La Fase 7 pide un cliente móvil. El owner eligió WhatsApp en lugar de Telegram (2026-11-22) y pidió basarlo en su CRM (`ZESTIA_PROJECT/CRM_ECCOMERCE`), que ya conecta con WhatsApp mediante **Baileys**. Baileys es un cliente no oficial que se vincula como «WhatsApp Web» escaneando un QR.

El owner también decidió vincular **su propio número** (2026-11-22): le habla a Jarvis en el chat «Mensaje a mí mismo». La alternativa era un número dedicado para Jarvis, que se descartó. Esto tiene dos consecuencias que no existían en el CRM:
- **Jarvis ve todo lo que entra a la cuenta.** Un dispositivo vinculado recibe, ya descifrados, los mensajes de todos los chats del owner: familia, trabajo, grupos. Jarvis tiene que descartarlos sin mirarlos.
- **El riesgo de restricción cae sobre la cuenta personal.** Usar un cliente no oficial va contra los términos de WhatsApp, y si Meta lo detecta puede restringir el número del owner, no uno descartable.

Además, es la primera vez que Jarvis recibe pedidos desde fuera de la PC. Quien tenga el teléfono del owner desbloqueado, o una sesión de WhatsApp Web abierta en otra máquina, puede escribirle.

## Revisión del CRM (2026-11-22, solo lectura)
**Se reutiliza, adaptado:**
- la interfaz `WhatsAppProvider` (`start`, `sendText`, `stop`, `logout`), que permite tests sin red con un proveedor falso;
- de `baileys-provider.ts`:
  - `toIncoming`, que extrae el texto, desenvuelve los temporales y los de una sola vista e ignora grupos y estados;
  - `closeReason`, que traduce los códigos de cierre (`loggedOut`, `restartRequired`, `connectionReplaced`, el QR vencido);
  - `TtlCache` y `signalKeys`, el almacén de claves de Signal con `BufferJSON`;
  - `LINKED_BROWSER = Browsers.ubuntu('Chrome')`, porque los números Business en coexistencia no le cifran mensajes a «Desktop»;
  - el logger de Baileys **siempre en `warn`**: en `debug` registra los frames, con el contenido de los mensajes;
- el patrón de sesión cifrada con AES-256-GCM y contexto en el AAD (`secret-box.ts`);
- la reconexión con espera creciente, el `logged_out` que borra la sesión y el plazo por llamada.

**No se trae:** el multiempresa, la conciliación por base, el candado de Postgres (el Core ya es de instancia única), el bot de tienda, los pedidos y las descargas de archivos.

## Decisión
### Vinculación y sesión
- **Apagado por defecto.** Se activa con un botón «Vincular WhatsApp» del panel Ajustes.
- **El QR lo dibuja el proceso principal** de Electron, igual que los diálogos de confirmación (ADR-018), y nunca sale del equipo.
- **Sesión cifrada en la DB local:** las credenciales y las claves de Signal van en tablas nuevas (`whatsapp_session`, `whatsapp_keys`), cifradas con AES-256-GCM. La clave de 32 bytes vive en el Credential Manager (`whatsapp-session-key`), nunca en el repo ni en un archivo. No hay carpeta de sesión en disco.
- **«Desvincular»** cierra la sesión en WhatsApp y borra las tablas. Un `loggedOut` que llega desde el teléfono hace lo mismo.
- **Baileys fijado a una versión exacta** en el lockfile. Actualizarlo pide revisar el changelog, porque es código de terceros que maneja las claves de la cuenta.

### Solo el chat consigo mismo
- **Allowlist dura en el código, no en el prompt.** Un mensaje se procesa solo si se cumplen las tres condiciones:
  1. `remoteJid` es el propio número del owner (`sock.user.id` sin el dispositivo) o su LID (`sock.user.lid`);
  2. `fromMe` es verdadero;
  3. llegó en vivo (`notify`). El historial (`append` y la sincronización inicial) se ignora, y `syncFullHistory` queda en `false`.
- **Todo lo demás se descarta en el primer paso del manejador:** los otros chats, los grupos, los estados y las llamadas. Sin guardarlo, sin loguear el contenido ni el remitente y sin descargar nada. Solo se cuenta cuántos se descartaron, para el diagnóstico.
- **Envío solo al chat propio:** el envoltorio de `sendText` rechaza cualquier destinatario que no sea el chat consigo mismo. Ni una injection ni un bug pueden mandarle un mensaje a un contacto.
- **Sin bucles:** el chat propio también devuelve lo que manda Jarvis. Los ids de los mensajes enviados se guardan en una `TtlCache` y, si vuelven, se ignoran. Las respuestas empiezan con un prefijo fijo («🤖 »), que sirve de segunda barrera.
- **Mensajes `fromMe` desde otro dispositivo vinculado** del owner (WhatsApp Web en otra máquina): se aceptan, porque WhatsApp no distingue al autor. Es el mismo nivel de acceso que tener la cuenta abierta. El panel Ajustes muestra la advertencia.

### Lo que llega es dato si no lo escribió el owner
- **Un mensaje reenviado** (`contextInfo.isForwarded`) o **citado** (`quotedMessage`) en el chat propio puede venir de un tercero. Entra en el turno envuelto en `<reenviado>` o `<citado>` como **dato no confiable**, igual que el contenido de un archivo o una web. Solo el texto escrito por el owner es un pedido.
- **Audio, imágenes, documentos y stickers no se procesan en esta versión.** Jarvis responde que por ahora solo lee texto. Transcribir notas de voz con Parakeet queda para un ADR propio.

### Acciones sensibles: siempre en la PC
- **Cada turno de WhatsApp corre con el canal `whatsapp`.** El Permission Engine lo recibe como un dato más de la regla.
- **Una herramienta que pide confirmación** usa el mismo diálogo nativo de la PC (ADR-018). Jarvis contesta por WhatsApp «Te dejé la confirmación en la PC», y si en 2 minutos nadie responde, se deniega. **Nunca se confirma desde el chat:** un «sí» por WhatsApp no aprueba nada, porque no se distingue de un mensaje reenviado ni de alguien con el teléfono en la mano.
- **Sin las reglas de «permitir siempre» de la PC** para el canal `whatsapp`: todo lo que en la PC pide confirmación también la pide acá, aunque haya una regla previa. El owner puede crear reglas propias del canal más adelante.
- **El Builder no arranca desde WhatsApp** en esta versión.

### Qué sale por el chat
- Las respuestas pasan por `sensitiveReason` (el filtro de secretos de la memoria) y por `redact` (el de los logs) antes de salir. Si algo coincide, Jarvis no lo manda y contesta «Eso te lo muestro en la PC».
- WhatsApp cifra de punta a punta, pero los mensajes quedan en el teléfono, en los backups del owner y en cualquier otro dispositivo vinculado. Por eso el prompt de modo móvil pide respuestas cortas y no pegar archivos enteros.

### Costo, límites y términos
- **Tope:** 30 mensajes del owner por hora en el canal. Pasado el tope, Jarvis avisa una vez y calla hasta la hora siguiente. Los turnos cuentan dentro del tope diario de US$3.
- **Comportamiento discreto ante WhatsApp:**
  - `markOnlineOnConnect: false`, para que el owner no aparezca en línea por culpa de Jarvis;
  - no se marcan como leídos los mensajes de otros chats;
  - sin presencia («escribiendo…») fuera del chat propio;
  - nada de envíos masivos.
- **Términos de uso:** Baileys no está autorizado por WhatsApp. El owner acepta el riesgo de que restrinjan su número personal. Si pasa, se desvincula y se evalúa la Cloud API oficial con un número dedicado; la interfaz `WhatsAppProvider` permite cambiar el proveedor sin tocar el resto.
- **Solo con el Core corriendo:** el cliente vive en el proceso del Core. Con la PC apagada, los mensajes esperan y al reconectar no se procesan los que llegaron hace más de 10 minutos. Así un pedido viejo no se ejecuta fuera de contexto, y Jarvis responde «Llegó tarde: repetímelo».

### Auditoría
- Cada turno del canal queda en `audit_log` con `channel = whatsapp`, la hora y las herramientas que usó, sin el texto. El panel Actividad lo muestra con un ícono propio.

## Alternativas consideradas
- **Número dedicado para Jarvis:** es más seguro, porque una restricción no toca la cuenta personal y Jarvis no ve otros chats. El owner lo descartó por comodidad.
- **WhatsApp Cloud API oficial:** cumple los términos, pero exige un número de empresa dedicado, una app de Meta y un webhook público (un servidor expuesto). No sirve con el número personal.
- **Telegram:** tiene una API oficial de bots, pero el owner prefiere WhatsApp.
- **Confirmar acciones desde el chat** con un código de un solo uso: es más cómodo, pero un código que se muestra en la PC no ayuda si el owner está fuera, y uno que llega por el chat se puede reenviar. Queda descartado hasta tener otro factor.

## Consecuencias
- **Positivas:**
  - el owner usa Jarvis desde el teléfono sin instalar nada;
  - la seguridad no depende del modelo: la allowlist, el envío solo al chat propio y las confirmaciones en la PC están en código.
- **Negativas:**
  - riesgo real de restricción del número personal;
  - el proceso del Core recibe en memoria, descifrados, los mensajes de todos los chats del owner, aunque los descarte de inmediato;
  - Baileys suma una dependencia grande y no oficial;
  - sin la PC encendida, Jarvis no responde.
- **Riesgos:**
  - **Quien tenga el teléfono del owner manda pedidos:** lo acotan las confirmaciones en la PC y el tope por hora.
  - **Un bug en el filtro de chats** procesaría mensajes de terceros. Para eso hay tests sobre `toIncoming` y el filtro con mensajes de grupos, de otros contactos, reenviados, citados, de historial y propios que vuelven.
  - **Un cambio de protocolo de WhatsApp** rompe Baileys: el canal queda «degradado» y el resto de Jarvis sigue funcionando.
- **Pendiente:**
  - las evals del canal: injection por mensaje reenviado, pedido de acción sensible desde el chat, intento de enviar a otro contacto;
  - validar con la API real.
