# ADR-021: Wake word «Hey Jarvis» local con openWakeWord (Fase 4)

- **Estado:** Aceptada por delegación del owner (2026-11-20). Se revisa al cerrar la Fase 4, con la medición real de falsas activaciones.
- **Fecha:** 2026-11-20
- **Decisores:** owner (delegado)

## Contexto
ADR-004 eligió openWakeWord para la palabra de activación. La Fase 4 la pide «local y configurable», con menos de 1 falsa activación por día. Las restricciones son:
- **privacidad:** nada de audio previo a la activación sale ni se guarda (VOICE_PIPELINE §5), y hay un indicador obligatorio;
- **Smart App Control (ADR-009):** bloquea binarios y wheels nuevos sin firma conocida.

El paquete `openwakeword` arrastra `tflite-runtime`, `scipy` y `scikit-learn`. En cambio, `onnxruntime` ya está en el servicio de voz por el VAD (ADR-016).

## Decisión

### Detector
- Implementamos el pipeline de openWakeWord **sobre onnxruntime, sin el paquete** (`stt/wake.py`):
  1. log-mel de cada bloque de 80 ms (1280 muestras, más 480 de contexto);
  2. embedding de 96 valores sobre las últimas 76 tramas;
  3. el modelo `hey_jarvis_v0.1` puntúa los últimos 16 embeddings (1,28 s).
- Corre en CPU con un hilo y consume unos 45 ms por segundo de audio, medido en la PC del owner.
- Al detectar, limpia los buffers y aplica un enfriamiento de 2 s, así la misma frase no dispara dos veces.
- **Modelos:** openWakeWord v0.5.1, fijados por SHA-256 en `jarvis-stt-bench setup` y guardados en `%APPDATA%/Jarvis/models/wakeword/`.
  - **Licencia:** el código es Apache-2.0, pero los **modelos preentrenados son CC BY-NC-SA 4.0**. Sirven para uso personal no comercial, que es el caso de Jarvis. Si el producto cambia de uso, hay que entrenar un modelo propio.
- **Palabra:** «Hey Jarvis» en inglés, porque es el modelo que existe. Con la voz de Piper en español puntúa alrededor de 0,47; una frase normal en español puntúa 0,00. El umbral por defecto es 0,5 y se ajusta con `JARVIS_WAKE_THRESHOLD`.
- **Calibración:** `uv run python -m jarvis_voice.diagnostics.wake_check` imprime el puntaje por segundo con el micrófono real. No graba nada.

### Flujo (protocolo de voz 1.2)
1. El Core manda `wake.enable` y el servicio responde `wake.listening {open: true}`. Desde ahí el micrófono **queda abierto entre capturas**, pero solo alimenta al detector.
2. Mientras dura una captura (push-to-talk, barge-in o comando), el audio no llega al detector. Al terminar, el detector se reinicia.
3. `wake.detected {score}`: si Jarvis está libre, el Core arma el VAD (`vad.arm`) para grabar el pedido, igual que el barge-in de ADR-016:
   - empieza con habla de al menos 250 ms y termina con 700 ms de silencio;
   - si en 6 s no se habla, vuelve a esperar;
   - Jarvis no responde «¿sí?» en voz alta, porque sin AEC se escucharía a sí mismo.
4. Si llega la detección mientras Jarvis está ocupado (pensando, hablando o escuchando), se ignora.
5. El texto pierde el resto de la frase de activación que pueda haber quedado («…vis, ¿qué hora es?»).

### Privacidad e indicador
- El detector guarda solo features (mel y embeddings) de los últimos 1,3 s, en memoria. **Nunca guarda audio crudo previo a la activación** y nada sale de la PC.
- **Indicador obligatorio mientras espera la wake word:**
  - un punto en el botón de la barra de tareas (overlay icon de Windows);
  - el título de la ventana;
  - el chip «Atento a «Hey Jarvis»».
- El overlay flotante se reserva para cuando el micrófono graba de verdad, como antes. Si apareciera mientras se espera la wake word, no se iría nunca.
- **Apagada por defecto.** Se prende con `JARVIS_WAKE_WORD=1` o con el botón «Activar «Hey Jarvis»» de la app (`voice.wake`, protocolo de clientes 1.3).

### Métrica de salida
La migración 006 agrega `wake_events` con hora, puntaje y resultado: `command`, `empty`, `timeout` o `ignored`. No guarda audio ni texto.
- `voice-stats` muestra, por día, las activaciones y las que no tuvieron pedido (`empty` y `timeout`), que es el estimado de falsas activaciones.
- La condición de salida es menos de 1 por día.

## Alternativas consideradas
- **El paquete `openwakeword`:** suma dependencias pesadas y wheels que Smart App Control puede bloquear, para hacer lo mismo que 100 líneas sobre onnxruntime.
- **Porcupine:** ya se había descartado en ADR-004 por requerir access key y licencia comercial.
- **Entrenar «Jarvis» en español:** es lo ideal para el acento del owner, pero exige generar datos y entrenar. Queda como mejora si la calibración muestra que «Hey Jarvis» no anda bien con su voz.
- **Mostrar el overlay todo el tiempo:** es más visible, pero tapa la pantalla de forma permanente. El badge en la barra de tareas es persistente y discreto.
- **Confirmar la activación con una frase hablada:** sin cancelación de eco, Jarvis se grabaría a sí mismo.

## Consecuencias
- **Positivas:**
  - Jarvis se puede usar sin manos y 100 % local.
  - Las falsas activaciones quedan medidas.
- **Negativas:**
  - Con la wake word prendida, el micrófono queda abierto (con indicador).
  - El modelo está entrenado en inglés: falta calibrarlo con la voz del owner.
  - La licencia de los modelos no permite uso comercial.
- **Pendiente (owner):**
  - calibrar con `wake_check`;
  - usarla unos días y revisar `voice-stats` (menos de 1 falsa activación por día).
