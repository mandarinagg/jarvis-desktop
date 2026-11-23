# ADR-025: Panel Inicio (Fase 7)

- **Estado:** Aceptada por delegación del owner (2026-11-20).
- **Fecha:** 2026-11-20
- **Decisores:** owner (delegado)

## Contexto
El owner pidió un dashboard. La app mostraba solo el gasto de hoy contra el tope y el costo de la última respuesta. Lo demás estaba repartido en los paneles Actividad y Memoria.

PRODUCT_SPEC §4.7 pide, además:
- el costo por conversación y el acumulado diario y mensual;
- un indicador de cuándo se mandan datos a la nube y a qué proveedor.

La Fase 7 (proactividad) va a necesitar un lugar donde mostrar el briefing y los recordatorios.

## Decisión
- **Vista Inicio:** es la primera que abre la app. Al escribir, hablar o abrir una conversación, la app pasa al chat.
- **Protocolo 1.6:** `dashboard.get` → `dashboard.result`, una foto de solo lectura armada en el Core con consultas a la DB local (`packages/core/src/dashboard.ts`). No llama a ningún modelo ni manda nada afuera. El renderer solo puede pedirla.
- **Contenido:**
  - **Gasto:** hoy contra el tope, el mes y su proyección al cierre, el desglose del mes (chat y voz, Builder, reflexión), las 5 conversaciones más caras del mes y el porcentaje de la entrada que se leyó del caché.
  - **Gráfico:** gasto por día de los últimos 30 días, apilado por uso, con la línea del tope diario, detalle al pasar el mouse y vista de tabla.
  - **Nube hoy:** cuántas veces se llamó a Anthropic para chat, Builder y reflexión, y si la voz neural de Google está activa (no se cuentan sus llamadas).
  - **Lo que espera al owner:** propuestas de memoria y tareas del Builder para revisar.
  - **Actividad de hoy:** acciones, aprobadas por el owner y rechazadas.
  - **Memoria:** ideas abiertas y cantidad de recuerdos activos.
- **Colores:** los tres colores de las series son los slots 1 a 3 de la paleta de referencia de visualización, validados contra el fondo de los paneles en modo oscuro y claro. En claro, el verde queda por debajo de 3:1, por eso el gráfico tiene leyenda y tabla.

## Alternativas consideradas
- **Armar el dashboard en el renderer con los mensajes que ya existen:** se necesitarían varias consultas nuevas igual, y el renderer no tiene por qué leer más de lo que muestra.
- **Tope mensual duro:** queda para cuando el owner lo pida. El de la consola de Anthropic (US$60) ya funciona como tope mensual.

## Consecuencias
- El owner ve en una pantalla cuánto gasta, en qué y qué le falta decidir.
- Agregar cosas al panel es sumar campos al resultado, sin cambiar el modelo de datos.
- Las llamadas a Google TTS no se cuentan: solo se muestra si la voz neural está activa.
