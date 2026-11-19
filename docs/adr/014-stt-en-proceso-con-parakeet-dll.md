# ADR-014: STT dentro del proceso con `parakeet.dll` (ctypes) y push-to-talk

- **Estado:** Aceptada por delegación del owner (2026-11-19). Se revisa al cerrar la Fase 2.
- **Fecha:** 2026-11-19
- **Decisores:** owner (delegado)

## Contexto
ADR-010 eligió Parakeet TDT 0.6B v3 y midió 184 ms de inferencia, sin contar la carga del modelo, porque se asumía que "el servicio carga el modelo una sola vez". Medido en la Fase 2, cada llamada a `parakeet-cli.exe` tarda **4.7 s**: recarga el modelo y vuelve a inicializar Vulkan. Ese camino no sirve para conversar.

Los binarios fijados (ADR-009) incluyen `parakeet.dll`, que exporta una API C parecida a la de whisper.cpp (`parakeet_init_from_file_with_params`, `parakeet_full`, `parakeet_full_get_segment_text`…), pero sin el header.

## Decisión
- **El Voice Service carga `parakeet.dll` con ctypes** y mantiene el modelo en la GPU todo el tiempo que vive el proceso.
  - Antes de crear el contexto llama a `ggml_backend_load_all_from_path(bin)`, de `ggml.dll`. Sin esa llamada no se registra ningún backend y falla con `GGML_ASSERT(device)`.
  - **`parakeet_context_params`** ocupa 8 bytes (`bool use_gpu; bool flash_attn; int gpu_device`). En el ABI de Windows x64, un struct de 8 bytes viaja por valor en un registro, así que se declara como `ctypes.Structure`. Pasarle un puntero hace que lea basura: se observó `use gpu = 112` y caía a CPU.
  - **`parakeet_full_params`** es grande. El ABI pasa esos structs "por valor" como puntero a una copia, así que se pasa tal cual el puntero que devuelve `parakeet_full_default_params_by_ref` y no hace falta replicar su layout.
  - Las llamadas se serializan con un lock, porque hay un solo contexto de GPU. El texto sale en UTF-8.
  - Al cargar se transcribe 1 s de silencio para compilar los shaders de Vulkan. Sin ese paso, la primera frase real tarda ~480 ms en lugar de ~100 ms.
- **Push-to-talk** (`stt.start`/`stt.stop`/`stt.cancel`): el micrófono se abre **solo** mientras dura la frase y cada apertura y cierre se informa con `stt.listening`, que alimenta el indicador obligatorio. El audio vive en memoria hasta transcribirse y nunca se escribe a disco. Hay un tope de 60 s por frase, y lo que dura menos de 250 ms se toma como un rebote de la tecla: devuelve texto vacío sin correr el modelo.
- **Corrección post-STT** (`stt/corrections.py`):
  - reglas exactas por frase ("piel de Claudio" → "API de Claude");
  - un vocabulario difuso conservador: misma inicial, ≥ 5 letras y similitud ≥ 0.83.
  - El owner puede ampliarlo en `%APPDATA%/Jarvis/stt/vocabulary.txt`. Sobre los errores reales del benchmark de la Fase 0, la corrección baja el WER del subconjunto con nombres propios en más de un 25% sin tocar el habla normal ("Claudia", "Martín").

## Medición (2026-11-19, RX 6600 XT por Vulkan)
| Camino | Carga | Por frase (~5 s de audio) |
|--------|-------|---------------------------|
| `parakeet-cli.exe` por llamada | en cada llamada | 4.7 s |
| `parakeet.dll` en proceso, primera frase sin warm-up | 0.7–0.9 s una vez | ~480 ms |
| `parakeet.dll` en proceso, con warm-up | 0.7–0.9 s + warm-up una vez | **93–110 ms** |

## Alternativas consideradas
- **CLI por llamada:** es simple y aísla las caídas, pero los 4.7 s la descartan.
- **Compilar un binding propio (pybind11/cffi) con el header de la versión fijada:** sería más robusto ante cambios de layout, pero suma un toolchain de C++ y binarios propios sin firmar, que Smart App Control bloquea (ADR-009).
- **Proceso auxiliar persistente en C++ que lea audio por stdin:** daría el mismo aislamiento que la CLI sin pagar la recarga, pero también es un binario propio sin firmar.

## Consecuencias
- (+) El STT queda en ~100 ms: menos de la mitad de lo que mostraba el benchmark.
- (+) No hay binarios nuevos: se usan las DLL fijadas y verificadas por hash (ADR-009).
- (−) **Depende del layout de `parakeet_context_params` y del ABI de Windows x64.** Si se cambia la versión de whisper.cpp hay que volver a verificarlo. `test_real_parakeet_in_process`, que corre en local porque CI no tiene la DLL ni el modelo, es el test que lo detecta.
- (−) Si el motor se cuelga dentro de la DLL, cae todo el Voice Service. Lo cubre el supervisor del Core, que lo reinicia (ADR-008).
