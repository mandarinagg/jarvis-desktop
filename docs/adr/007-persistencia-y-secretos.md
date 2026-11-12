# ADR-007: Persistencia local y manejo de secretos

- **Estado:** Aceptada — por delegación del owner (2026-11-12); revisable al cerrar Fase 1
- **Fecha:** 2026-11-12

## Contexto
`ARCHITECTURE.md` proponía `better-sqlite3` y `keytar`. Hallazgos:
- `better-sqlite3` es un módulo nativo: hay que recompilarlo o conseguir prebuilds para cada ABI (Node del Core, Electron), lo que suele romperse con cada actualización.
- Node 26 (LTS, instalado: v26.13.0) trae **`node:sqlite`** integrado (SQLite 3.54, FTS5 verificado), sin dependencias nativas.
- `keytar` está **archivado** (sin mantenimiento).
- `@napi-rs/keyring` está mantenido (v2.x), trae binarios precompilados (no requiere Rust) y usa Windows Credential Manager.

## Decisión
- **Base de datos:** `node:sqlite` (`DatabaseSync`) en el Core, en modo WAL, archivo único en `%APPDATA%/Jarvis/jarvis.db`. Solo el Core abre la DB; los clientes acceden vía IPC.
- **Migraciones:** archivos SQL versionados en `packages/core/migrations/`, aplicados al arrancar dentro de una transacción; tabla `schema_version`.
- **Búsqueda:** FTS5 para el índice de proyectos y la memoria. Los embeddings se deciden en Fase 3.
- **Secretos** (API keys, tokens de servicios): `@napi-rs/keyring` → Windows Credential Manager, servicio `Jarvis`. Nunca en DB, config, logs ni variables persistidas.
- **Cifrado de campos sensibles:** AES-256-GCM (`node:crypto`), con la clave maestra guardada en Credential Manager. Si se pierde la clave, los campos cifrados se descartan sin afectar el resto de la DB.
- **Backups:** `VACUUM INTO` diario a `%APPDATA%/Jarvis/backups/`, con rotación de 7.

## Alternativas consideradas
- **better-sqlite3:** API muy madura, pero el dolor de módulo nativo con dos runtimes.
- **Electron `safeStorage`:** solo disponible en el proceso de Electron; el Core corre aparte (ADR-001).
- **DPAPI directo:** requiere bindings nativos propios.

## Consecuencias
- (+) Cero módulos nativos para la persistencia; actualizaciones de Node/Electron sin recompilar.
- (+) Una sola dependencia nativa (keyring), con prebuilds.
- (−) La API de `node:sqlite` es síncrona: las consultas pesadas (indexado) van a un `worker_thread`.
- (−) Si el Core se empaqueta con el runtime de Electron (ADR-008), hay que verificar que esa versión incluya `node:sqlite`.
