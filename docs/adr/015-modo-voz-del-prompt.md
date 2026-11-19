# ADR-015: Modo voz del prompt (instrucciones por turno después del system cacheado)

- **Estado:** Aceptada por delegación del owner (2026-11-19). Se revisa con las evals reales.
- **Fecha:** 2026-11-19
- **Decisores:** owner (delegado)

## Contexto
En la Fase 2 la respuesta de Claude se escucha por el parlante, frase por frase. El system prompt (`prompts/system.md`) ya pide brevedad, pero no distingue entre texto y voz. Cuando Claude responde con listas, markdown, links o «15:00 hs», el segmentador limpia los símbolos, pero lo que queda suena mal. Además, las respuestas largas alargan el turno y no aportan nada al oído.

## Decisión
- **`prompts/voice.md`:** instrucciones de modo voz:
  - una a tres oraciones;
  - nada de markdown, emojis ni links;
  - números y horas escritos como se dicen;
  - el código va en un bloque, que no se lee en voz alta pero queda en pantalla, precedido de una frase que diga qué hace;
  - tolerancia a errores de transcripción.
- **Dónde va en el pedido:** como un **segundo bloque de `system`, sin `cache_control`**, después del system prompt cacheado. Solo se agrega en los turnos que llegan por voz: `ChatService.chatSend(…, "voice")`, que llama `VoiceTurns`. El historial persistido no cambia.
- **Evals:** los casos aceptan `"mode": "voice"`, y el runner agrega el mismo `voice.md`, así que mide lo que se usa en producción. Hay 4 casos nuevos (016–019): sin markdown, comando en pantalla, error de transcripción y horas habladas. El juez sabe que la respuesta se escucha.

## Alternativas consideradas
- **Mensaje `system` a mitad de conversación** (`{role: "system"}` en `messages`, soportado por Opus 5.5): conserva el prefijo cacheado del turno en curso. Pero el historial persistido no guarda esos mensajes, así que en el turno siguiente el prefijo ya no coincide. Para que funcione habría que persistirlos o usar el beta `clear_at`. Además, en una conversación toda por voz (el caso normal) el bloque fijo en `system` cachea igual de bien. Queda como opción si las mezclas de texto y voz resultan frecuentes.
- **Prefijo en el mensaje del usuario:** ensucia el historial y la UI, y mezcla instrucciones de operador con contenido del usuario.
- **Solo limpiar en el segmentador:** ya se hace, pero no acorta las respuestas ni arregla números y horas.

## Consecuencias
- **Positivas:** respuestas habladas más cortas y naturales, y sin costo en conversaciones solo de voz o solo de texto.
- **Negativas:** al pasar de texto a voz (o al revés) dentro de la misma conversación, se pierde una vez la caché del historial, porque cambia el `system` que lo precede. El system base sigue cacheado.
- **Pendiente:** correr las evals con la API real (19 casos, ~US$ 0,40) cuando exista la key, y ajustar `voice.md` según los resultados.
