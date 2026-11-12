# ADR-001: Arquitectura Core daemon + clientes

- **Estado:** Propuesta
- **Fecha:** 2026-11-12

## Contexto
La visión es un asistente que "maneje todo lo que hago", activable por voz en cualquier momento y, a futuro, desde otros dispositivos. El spec v1 asumía una app de escritorio monolítica.

## Decisión
Separar un **Jarvis Core** (proceso Node/TS en segundo plano) que contiene orquestación, memoria, permisos, auditoría y conexión a Claude, de los **clientes** (UI desktop, overlay de voz, CLI, futuros móvil/Telegram) que se comunican por IPC local autenticado (named pipe de Windows + token por sesión). La UI se puede cerrar sin que Jarvis "muera".

## Alternativas consideradas
- **App monolítica** (todo en el proceso de la UI): más simple al inicio; obliga a re-arquitecturar para multi-cliente, jobs en segundo plano y proactividad.
- **Servidor en la nube**: habilita multi-dispositivo nativo; rompe local-first y privacidad.

## Consecuencias
- (+) Jobs de fondo (reflexión, recordatorios), multi-cliente y resiliencia.
- (+) Contratos de IPC explícitos → tests más fáciles.
- (−) Un proceso más que empaquetar y supervisar; hay que asegurar el IPC (sin puertos de red abiertos).
