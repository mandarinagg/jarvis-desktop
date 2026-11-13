# ADR-012: Toolchain del monorepo TypeScript

- **Estado:** Aceptada (2026-11-13)
- **Fecha:** 2026-11-13
- **Decisores:** owner (por delegación)

## Contexto
La Fase 1 necesita lint, tipos, tests y CI para `packages/*` y `apps/*`. TypeScript 7 (el compilador nativo en Go) ya salió, pero typescript-eslint 8.72 solo soporta TypeScript `>=4.8.4 <6.1.0`.

## Decisión
- **TypeScript 6.0.3** con `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` y `verbatimModuleSyntax`. Los módulos son ESM y la resolución es `NodeNext`.
- **ESLint 10** (flat config) con `typescript-eslint` en modo `strict`. `no-console` está prohibido, salvo `warn`/`error`, para que nada escriba secretos en la salida por accidente.
- **Vitest 5** como runner único desde la raíz.
- **Versiones exactas** en `package.json`, con lockfile congelado en CI.
- **CI** en GitHub Actions con `windows-latest`, la plataforma objetivo:
  - job Node: lint, build, typecheck y test;
  - job Python: `uv sync --locked` y pytest del servicio de voz.
- Los paquetes compilan a `dist/` con `tsc` y se consumen entre sí por `workspace:*`.

## Alternativas consideradas
- **TypeScript 7:** compila mucho más rápido, pero hoy rompe typescript-eslint. Se reevalúa cuando typescript-eslint lo soporte.
- **Biome en lugar de ESLint:** más rápido, pero hoy tiene menos reglas con información de tipos.

## Consecuencias
- (+) Una sola forma de correr lint, tipos y tests, igual en local y en CI.
- (−) TypeScript 6 compila más lento que el 7. Con este tamaño de repo no importa.
