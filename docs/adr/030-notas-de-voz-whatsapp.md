# ADR-030: Notas de voz en WhatsApp (Fase 7)

- **Estado:** Aceptada por el owner (2026-11-23).
- **Fecha:** 2026-11-23
- **Decisores:** owner
- **Modifica:** ADR-029, que decía «solo texto», y ADR-013, que decía «el audio nunca cruza el canal con el servicio de voz».

## Contexto
El canal de WhatsApp (ADR-029) solo lee texto: si el owner manda una nota de voz, Jarvis le contesta «por ahora solo leo texto». El owner pidió dos cosas (2026-11-23):
- que Jarvis entienda sus notas de voz;
- que conteste con la misma voz de la PC (`es-US-Neural2-B`), con la regla **«si le hablás, te habla; si le escribís, te escribe»**.

Las piezas ya existen en el servicio de voz: Parakeet transcribe en local (ADR-013) y Neural2 sintetiza con Piper como respaldo (ADR-011). Lo que falta es leer y escribir el formato de las notas de voz, Ogg Opus, sin agregar dependencias del sistema.

## Prueba previa (2026-11-23)
- `soundfile` (libsndfile 1.2.2, en el wheel; el proyecto fija 0.14) **carga bajo Smart App Control**, decodifica y codifica Ogg Opus: 3 s se decodifican en ~9 ms.
- Neural2-B en `OGG_OPUS` tardó 872 ms para una frase y devolvió un Ogg Opus mono a 24 kHz. `soundfile` lo lee sin problemas.

## Decisión
- **Todo el audio vive en el servicio de voz.** El Core solo hace de puente entre Baileys y el servicio. El protocolo de voz pasa a la versión **1.3**, compatible con la 1.2, con dos pedidos nuevos:
  - `stt.transcribe { id, audio }`: el audio es la nota de voz en base64. El servicio la decodifica con `soundfile`, la pasa a mono a 16 kHz, la transcribe con Parakeet en la misma cola que el push-to-talk y contesta con el `stt.final` de siempre, con el mismo `id`.
  - `tts.render { id, text }`: sintetiza el texto completo con el motor configurado (Neural2 con un reintento, después Piper), lo codifica en Ogg Opus mono con `soundfile` y contesta `tts.rendered { id, audio, durationMs, engine }`.
  - Si algo falla, contesta `voice.error` con ese `id`.
- **Se codifica en local, no con `OGG_OPUS` de Google.** Así funciona igual con Piper cuando no hay red, y una respuesta larga se sintetiza por frases y se une sin pasar el límite de 5000 bytes de Google. Codificar en local no cuesta nada aparte.
- **El audio cruza el stdio solo en memoria.** Nunca se escribe a disco ni a la base, y nunca va a un log. Lo que se guarda es lo mismo que en un turno de texto: el texto transcripto como mensaje del owner y la respuesta de Jarvis. La nota de voz del owner **nunca sale de la PC** (ADR-004).
- **Límites:**
  - una nota de más de **2 minutos** o de más de **600 KB** se rechaza **antes de descargarla**, con un aviso;
  - una respuesta de más de 4000 caracteres va solo como texto;
  - transcribir tiene un plazo de 60 s y sintetizar, de 45 s.
- **La regla «si le hablás, te habla»:**
  - **nota de voz del owner:** el turno corre con el prompt de voz (ADR-015) además del de WhatsApp. Jarvis contesta con una nota de voz (`audio` con `ptt: true`) y, debajo, el mismo texto, que es la fuente de verdad si el audio no se entiende;
  - **texto del owner:** contesta solo texto, como hasta ahora;
  - **nota de voz reenviada:** la habló otra persona. Se transcribe y entra como `<reenviado>`, es decir como dato y no como pedido, y la respuesta va en texto.
- **Se descarga solo lo aceptado.** `screen` (ADR-029) decide primero, con los metadatos. Solo el audio de una nota aceptada se baja de los servidores de WhatsApp. El audio de otros chats nunca se descarga.
- **Si el servicio de voz está apagado o degradado:**
  - una nota de voz recibe «No puedo escuchar notas de voz ahora: el servicio de voz no está andando. Escribime.»;
  - si falla la síntesis, la respuesta va en texto con un aviso breve.
- **La salida pasa por los mismos filtros.** El filtro de secretos se aplica al texto *antes* de sintetizar: si el texto no puede salir, el audio tampoco. Antes de sintetizar se le saca el formato de WhatsApp (asteriscos, guiones de lista). La nota no lleva el prefijo «🤖 », que sí va en el texto de abajo, pero su id entra en la caché de ecos como cualquier envío. El `sendVoiceNote` del proveedor tiene la misma segunda barrera que `sendText`: solo el chat propio.

## Alternativas descartadas
- **Transcribir en la nube** (Google STT o Whisper por API): el audio del owner saldría de la PC.
- **Llamar a Google desde el Core y convertir con `ffmpeg`:** duplica la key de Google en otro proceso y depende de un binario instalado aparte.
- **Pasar el audio por archivos temporales:** quedan en disco si algo se corta a la mitad. En base64 por stdio, una nota de 2 minutos ocupa unos 500 KB y entra en el límite de 1 MiB por línea.

## Consecuencias
- El servicio de voz suma `soundfile` como dependencia, con libsndfile incluida en el wheel.
- Baileys calcula la forma de onda de la nota con `audio-decode`, que no está instalado. La nota se reproduce igual, pero con una forma de onda plana. Es aceptable.
- Cada nota de voz de Jarvis cuesta lo mismo que la voz en la PC (Neural2, ~US$16 por millón de caracteres). Una respuesta típica de 300 caracteres cuesta ~US$0,005.
