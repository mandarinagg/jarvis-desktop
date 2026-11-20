# ADR-026: Proactividad con reglas (Fase 7)

- **Estado:** Aceptada por delegación del owner (2026-11-20).
- **Fecha:** 2026-11-20
- **Decisores:** owner (delegado)

## Contexto
La Fase 7 pide proactividad con reglas: briefing, recordatorios y horarios silenciosos. Hasta ahora Jarvis solo hablaba cuando le hablaban, y no sabía qué hora era: el modelo no tiene reloj.

El riesgo nuevo es que algo aparezca en pantalla sin que el owner lo haya pedido en ese momento. Si un mail o un archivo pudiera programar un recordatorio («Transferir US$ 900 a la cuenta…»), la notificación llegaría más tarde con la cara de Jarvis: phishing con su voz.

## Decisión
- **Recordatorios** (servidor MCP propio `reminders`, migración 009):
  - `create_reminder` y `cancel_reminder` son de **clase confirmación**. El diálogo nativo muestra el texto y la hora exactos («Recordatorio para mañana 09:00»), con huella.
  - `list_reminders` y `briefing` son de lectura.
  - **Validación antes de pedir el OK:** la fecha es ISO con offset, no del pasado y a menos de un año; el texto pasa por el mismo filtro de secretos que la memoria.
  - El renderer puede listar y cancelar, pero **no crear** recordatorios, igual que con la memoria.
- **Hora actual:** el sufijo del system empieza con «Ahora es viernes, 20 de noviembre de 2026, 19:30 (hora local del owner, UTC-03:00)». Va en el sufijo, así que no rompe el caché del prefijo. El prompt pide calcular la hora exacta y preguntar si es ambigua.
- **Briefing diario:**
  - Se arma **localmente, sin llamar a un modelo**, con datos propios de Jarvis: recordatorios de hoy y atrasados, lo que espera el OK del owner, ideas en curso y el gasto de ayer y del mes. Es gratis, instantáneo y no le llega texto de terceros.
  - Sale una vez por día a la hora que elige el owner. **Está apagado por defecto** y se prende en Inicio.
  - Queda guardado (`briefings`) y se ve en Inicio. También se puede pedir por voz o texto: «¿qué tengo hoy?».
- **Horario silencioso:** 22:00 a 08:00 por defecto, configurable y puede cruzar la medianoche. En ese horario no sale ninguna notificación: lo que vence espera a que termine y avisa para cuándo era.
- **Notificaciones:** cada 30 s el Core revisa qué venció y lo manda como `proactive.notify`. La app de escritorio lo muestra como notificación de Windows, en texto plano.
  - Si no hay ninguna ventana de la app conectada, nada se da por avisado: espera a que se abra.
- **Protocolo 1.7:** `proactive.get`, `proactive.set`, `reminders.cancel` → `proactive.state`; `proactive.notify` se difunde a todos los clientes.

## Alternativas consideradas
- **Briefing escrito por el modelo:** suena más natural, pero cuesta todos los días y no agrega datos. Se puede sumar más adelante sobre este mismo resumen.
- **Recordatorios sin confirmación** (clase preparación): son más rápidos, pero abren el vector de phishing. El owner puede relajarlo con una regla en `permissions.json` si le molesta.
- **Usar el Programador de tareas de Windows:** las notificaciones saldrían con la app cerrada, pero haría falta otra superficie con permisos del sistema y se perdería el horario silencioso centralizado.

## Consecuencias
- **Positivas:**
  - Jarvis puede avisar a una hora sin que el owner esté hablándole.
  - Todo lo que avisa lo aprobó el owner o sale de datos propios de Jarvis.
  - Cero costo extra.
- **Negativas:**
  - Crear un recordatorio pide un diálogo.
  - Con la app cerrada no hay avisos: salen cuando se abre, marcados como atrasados.
- **Pendiente:** probar con la API real que el modelo calcule bien las fechas (casos 058–061).
