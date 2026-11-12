# Solución de problemas

Se completa a medida que aparecen problemas reales. Formato: **Síntoma → Causa → Solución**.

## Audio
- **Jarvis no escucha / entrada distorsionada** → Voicemod o Nahimic interceptando el micrófono → Elegir explícitamente el dispositivo físico en Ajustes, o desactivar el efecto.

## Voz / STT
- **Falla la instalación de dependencias de Python** → Python 3.15 sin wheels → Usar `uv` con Python 3.12 oficial (`py install 3.12`).
- **`uv` falla con "Una directiva de Control de aplicaciones bloqueó este archivo" (os error 4551)** → Smart App Control bloquea los intérpretes sin firmar que descarga `uv` → Instalar el Python 3.12 firmado de la PSF (`py install 3.12`) y borrar `.venv`; `services/voice/pyproject.toml` ya fija `python-preference = "only-system"`.
- **STT lento** → whisper.cpp corriendo en CPU → Verificar build con Vulkan y drivers AMD.

## API
- **401** → API key inválida o ausente en Credential Manager.
- **429** → Rate limit: el Core reintenta con backoff; revisar el tope diario.
