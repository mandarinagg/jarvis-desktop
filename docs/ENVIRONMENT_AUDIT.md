# Auditoría de entorno (Fase 0)

> Relevado: 2026-11-12. Equipo objetivo del owner.

## Hardware

| Componente | Valor | Impacto |
|------------|-------|---------|
| CPU | AMD Ryzen 5 3600 (6C/12T) | Suficiente para wake word + VAD + STT pequeño en CPU |
| RAM | 16 GB | OK; vigilar consumo combinado (Electron + Core + whisper) |
| GPU | AMD Radeon RX 6600 XT (8 GB) | **Sin CUDA** → usar whisper.cpp con **Vulkan** |
| Audio | Realtek HD, AMD HD Audio, dispositivo USB, Nahimic, **Voicemod** | Voicemod/Nahimic pueden alterar la entrada: permitir elegir dispositivo explícitamente y testear con el mic USB |

## Software

| Herramienta | Versión | Estado |
|-------------|---------|--------|
| Windows | 11 Pro (26200) | ✅ |
| Node.js | 26.13.0 | ✅ (fijar versión LTS del proyecto en `.nvmrc`/`engines`) |
| npm / pnpm | 11.20 / 10.34 | ✅ pnpm para el monorepo |
| Python | 3.15.2 (+ 3.12.10 oficial) | ⚠️ 3.15 es muy nuevo: el servicio de voz usa 3.12 vía `uv`. **Smart App Control activo**: solo intérpretes firmados (ver TROUBLESHOOTING) |
| Micrófono | Razer Seiren Mini (WASAPI, predeterminado) | ✅ Latencia del driver: 22 ms entrada / 22 ms salida (Realtek) |
| Rust / Cargo | — | ❌ No instalado (ver ADR-002) |
| Git | 2.56 | ✅ |
| GitHub CLI | logueado | ✅ |
| ffmpeg | — | ❌ Instalar (útil para pruebas de audio): `winget install Gyan.FFmpeg` |

## Pendiente

- [ ] Prueba de micrófono: nivel, ruido de fondo, latencia de captura (con y sin Voicemod) → `uv run jarvis-audio-check` en `services/voice`
- [ ] Prueba de salida de audio y latencia de reproducción
- [ ] Verificar soporte Vulkan: `vulkaninfo --summary`
- [ ] Benchmark whisper.cpp
- [ ] Comparativa TTS
