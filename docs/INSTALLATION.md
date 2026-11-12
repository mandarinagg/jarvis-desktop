# Instalación (desarrollo)

> El proyecto está en Fase 0: todavía no hay app ejecutable. Esta guía prepara el entorno.

## Requisitos

- Windows 11
- Node.js LTS + pnpm (`corepack enable`)
- Git
- [uv](https://docs.astral.sh/uv/) para el servicio de voz (`winget install astral-sh.uv`), que gestiona Python 3.12 aislado
- ffmpeg (`winget install Gyan.FFmpeg`) para pruebas de audio
- Drivers de GPU con soporte Vulkan (AMD Adrenalin actualizado)
- Cuenta en la consola de Anthropic con API key y **tope de gasto configurado**

## Pasos

```bash
git clone https://github.com/mandarinagg/jarvis-desktop.git
cd jarvis-desktop
pnpm install
cp .env.example .env   # solo desarrollo; en producción la clave va al Credential Manager
```

Los comandos de ejecución se agregarán al cerrar la Fase 1.
