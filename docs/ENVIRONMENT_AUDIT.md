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
| Salida de audio | **Auriculares** (sin parlantes) | ✅ Sin eco: AEC no es bloqueante para barge-in. Evitar el mic Bluetooth en modo manos libres (HFP, calidad telefónica) → usar la Razer |
| Rust / Cargo | — | ❌ No instalado (ver ADR-002) |
| Git | 2.56 | ✅ |
| GitHub CLI | logueado | ✅ |
| ffmpeg | — | ❌ Instalar (útil para pruebas de audio): `winget install Gyan.FFmpeg` |

## Pendiente

- [x] Prueba de micrófono (2026-11-13, `jarvis-audio-check`): ruido −72.5 dBFS, voz −32.2 dBFS (pico −17.9, sin saturación), **SNR 40.3 dB**. Acción: subir la ganancia de la Razer ~8–10 dB antes del benchmark de STT
- [x] Prueba de salida (auriculares por el jack Realtek): OK; latencia del driver 22 ms. Latencia acústica ida y vuelta: no aplica (auriculares, sin eco)
- [x] Vulkan: API 1.4.315, driver propietario AMD, RX 6600 XT detectada por ggml-vulkan (2026-11-13)
- [x] Benchmark de STT con la voz del owner (2026-11-13) → Parakeet TDT v3 (ADR-010)
- [ ] Comparativa TTS
