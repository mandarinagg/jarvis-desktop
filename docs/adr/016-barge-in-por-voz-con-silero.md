# ADR-016: Barge-in por voz con Silero VAD (sin AEC, con auriculares)

- **Estado:** Aceptada por delegación del owner (2026-11-19). Se revisa con el uso real.
- **Fecha:** 2026-11-19
- **Decisores:** owner (delegado)

## Contexto
Con el push-to-talk (ADR-013), para interrumpir a Jarvis hay que volver a apretar el atajo. `VOICE_PIPELINE.md` §4 prevé el barge-in por VAD: si el owner habla mientras Jarvis habla, Jarvis se calla y lo escucha. ADR-004 eligió Silero VAD, y ADR-013 dejó el barge-in por VAD para después del push-to-talk. El owner usa auriculares, así que el micrófono no capta la voz de Jarvis y no hace falta cancelación de eco (AEC) para empezar.

## Decisión
- **Motor:** Silero VAD v5 (MIT) sobre `onnxruntime`, en CPU.
  - Frames de 32 ms y ~0,1 ms por frame.
  - El modelo (2,3 MB, v5.1.2, SHA-256 fijado) se descarga con `jarvis-stt-bench setup` a `%APPDATA%/Jarvis/models/vad/`.
  - `onnxruntime` pasa a ser dependencia principal; sus DLL están firmadas por Microsoft y Smart App Control no las bloquea.
- **Protocolo de voz 1.1:**
  - `vad.arm {id}` y `vad.disarm {id}`, del Core a la voz;
  - `vad.speech {id}`, de la voz al Core.
  - El `id` del arm es el de la frase que se va a grabar si hay voz. Todo lo demás (`stt.listening`, `stt.final`, `stt.stop`, `stt.cancel`) se reusa sin cambios.
- **Flujo:**
  1. Cuando empieza a sonar un turno, el Core manda `vad.arm`.
  2. El servicio abre el micrófono, lo informa con `stt.listening` (el indicador sigue siendo obligatorio) y solo corre el VAD, guardando 0,5 s de pre-roll.
  3. Con ≥ 250 ms de voz manda `vad.speech`. El Core interrumpe a Jarvis igual que con el atajo: cancela Claude y manda `tts.cancel`.
  4. El servicio sigue grabando hasta 700 ms de silencio y cierra el micrófono. El Core toma ese cierre como si el owner hubiera soltado el atajo, y la transcripción sigue el camino normal.
  5. Cuando termina el turno, el Core manda `vad.disarm`. Si ya había voz, esa frase termina sola.
- **Umbrales:** los de Silero (0,5 para empezar y 0,35 para terminar), con histéresis.
- **Convivencia con el atajo:** el push-to-talk siempre gana. Apretar el atajo desarma el VAD, y si el VAD está grabando, el atajo termina la frase antes.
- **Interruptor:** activado por defecto. `JARVIS_BARGE_IN=0` lo apaga y deja solo el push-to-talk.

## Alternativas consideradas
- **WebRTC VAD:** más liviano, pero con muchos más falsos positivos ante ruido. Silero ya estaba elegido en ADR-004.
- **El paquete pip `silero-vad`:** arrastra torch (~2 GB). Con `onnxruntime` y el `.onnx` alcanza.
- **AEC (WebRTC APM) desde ahora:** hace falta con parlantes, pero agrega un componente nativo más (Smart App Control) y no lo necesita el setup actual. Queda para cuando se use con parlantes.
- **VAD también mientras Jarvis «piensa»:** el micrófono quedaría abierto más tiempo sin necesidad. Ahí el atajo alcanza.

## Consecuencias
- **Positivas:** se puede interrumpir hablando. La detección mide ~250 ms desde que empieza la voz (medido con una grabación real) y el corte de audio tarda < 100 ms más (fade de 30 ms).
- **Privacidad:** mientras Jarvis habla, el micrófono está abierto. El overlay y el chip lo muestran («Hablando · te escucho»). Lo que se descarta en el pre-roll no se transcribe ni se guarda, y nada se escribe a disco.
- **Riesgos:**
  - Con parlantes, Jarvis se puede interrumpir a sí mismo. Para eso existe `JARVIS_BARGE_IN=0`, hasta que haya AEC.
  - Una tos larga o un ruido sostenido de ≥ 250 ms también lo interrumpe. Se ajusta con el uso real.
- **Pendiente:** medir los falsos positivos en uso real y, si se usa con parlantes, implementar el AEC.
