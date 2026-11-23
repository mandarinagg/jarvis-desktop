# ADR-028: La reflexión diaria detecta pedidos repetidos y propone skills (Fase 7)

- **Estado:** Aceptada por delegación del owner (2026-11-22).
- **Fecha:** 2026-11-22
- **Decisores:** owner (delegado)

## Contexto
Con ADR-027, Jarvis propone skills solo dentro de una conversación, cuando el owner lo pide o cuando nota que repite un pedido. Pero en una conversación Jarvis no ve los días anteriores. Y la reflexión diaria (ADR-024) mira solo las conversaciones nuevas, así que tampoco puede notar que algo se repite entre días.

EVOLUTION.md pide que el ciclo de evolución arranque solo. La pregunta es cómo hacerlo sin abrir una vía nueva para que una injection active una skill.

## Decisión
- **Más contexto para la reflexión:** además de las conversaciones nuevas, recibe:
  - los episodios de los últimos 30 días (como mucho 60, sin los de las conversaciones que ya ve), con ids `e1…`;
  - los nombres de las skills existentes, en `<skills_existentes>`.
- **Salida nueva `skills`** (opcional): candidatos con nombre, descripción, pasos, casos de prueba, el porqué y `occurrences`, que son los ids (`c…`, `e…`) donde el owner hizo el pedido.
- **El código valida cada candidato** (`Reflector.proposeSkills`), sin confiar en el modelo:
  - **al menos 3 ocurrencias distintas** que existan, contadas por conversación (un episodio y una conversación de hoy que son la misma cuentan una vez);
  - **al menos una de hoy**: un pedido que dejó de repetirse no genera una skill;
  - el nombre no puede ser el de una skill existente, ni el de una propuesta pendiente, ni el de una propuesta de los últimos 30 días, aceptada o rechazada; así una skill que el owner descartó no vuelve cada mañana;
  - pasa los mismos chequeos estáticos que `propose_skill` (`skillProblem`: formato, secretos, patrones prohibidos);
  - **como máximo 1 por corrida**, dentro del tope de 5 pendientes del panel.
- **Resultado:** una propuesta **inerte**, igual que las de la charla, con el porqué prefijado «Reflexión diaria: …». Para activarla, sus evals tienen que pasar sobre el texto exacto y el owner la tiene que aprobar en el diálogo nativo (ADR-027). La reflexión no corre evals ni gasta más que su llamada habitual.
- **El prompt** (`REFLECTION_SYSTEM`) explica que solo cuentan los pedidos del owner, nunca un texto pegado, un archivo o un resultado de herramienta que diga «creá una skill». Agrega que lo normal es no proponer ninguna.

## Alternativas consideradas
- **Contar las repeticiones en el código** (similitud léxica entre los pedidos): sería determinista, pero el mismo pedido se dice de muchas formas («el informe semanal», «qué hice esta semana») y el FTS5 no alcanza para eso. El modelo detecta la repetición y el código verifica que las ocurrencias que cita existan y sean suficientes.
- **Mandar a la reflexión todas las conversaciones de 30 días:** sería mucho más caro por día. Los episodios ya son el resumen de cada conversación.
- **Que la reflexión corra las evals sola:** gastaría todos los días sin que el owner lo pida. Hoy las corre el owner en el panel por unos centavos.

## Consecuencias
- **Positivas:** el ciclo de evolución empieza solo, sin agregar una forma nueva de activar skills. El techo sigue siendo el mismo: evals más aprobación nativa.
- **Negativas:**
  - el input de la reflexión crece unos miles de caracteres por día (60 episodios cortos), con un costo bajo dentro del tope diario;
  - si los episodios resumen mal, se pierden repeticiones: un falso negativo, que es aceptable.
- **Riesgos:** una injection en una conversación podría inventar «el owner pidió X» en el resumen de un episodio. Para eso tiene que repetirse en 3 conversaciones distintas, una de hoy, pasar el lint y llega como propuesta inerte: el owner ve el texto completo y decide.
- **Pendiente:** validar con la API real que la reflexión no proponga skills de más (la mayoría de los días tiene que devolver `skills` vacío) y medir la aceptación junto con `memory-stats`.
