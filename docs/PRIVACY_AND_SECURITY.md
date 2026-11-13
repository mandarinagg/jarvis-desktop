# Privacidad y seguridad

## 1. Modelo de amenazas (resumen)

| Amenaza | Vector | Control |
|---------|--------|---------|
| Prompt injection | Mails, documentos, webs, salida de herramientas | Datos ≠ instrucciones; permisos por tool; confirmación en acciones externas; evals adversariales |
| Acción destructiva por error | Alucinación del modelo | Clases de riesgo, confirmación doble, Builder en ramas git, sin shell genérico |
| Robo de API key | Logs, repo, renderer | Credential Manager; redacción en logs; renderer sin Node |
| Escucha no deseada | Wake word | Detección 100% local, indicador obligatorio, mute global |
| Servidor MCP malicioso | Terceros | Opt-in, revisión, mínimos privilegios, aislamiento |
| Acceso local a IPC | Otro proceso del equipo | Named pipe + token de sesión de 256 bits (comparación en tiempo constante, timeout de auth de 5 s); sin puertos TCP abiertos. La ACL del pipe queda por defecto (Node no permite fijarla): ver `packages/core/README.md` |
| Fuga en repo público | Commits | `.gitignore`, datos en `%APPDATA%`, secret scanning y push protection de GitHub |

## 2. Controles obligatorios

- Indicador visible del micrófono; silencio inmediato.
- No almacenar audio crudo por defecto; transcripciones solo si se activa.
- Cifrado de datos locales sensibles (AES-256-GCM; clave maestra en Windows Credential Manager, ADR-007).
- API keys en almacén seguro del SO.
- Permisos por carpeta y herramienta; confirmación antes de enviar datos externamente.
- Registro de acciones.
- Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, CSP estricta, IPC con canales allowlisted y validados.
- No abrir puertos locales innecesarios.
- Filtro de secretos antes de guardar memoria o enviar contexto (patrones de API keys, tokens, contraseñas).

## 3. Repo público

- Nunca commitear: `.env`, bases de datos, logs, transcripciones, memoria, datos personales.
- Evals y ejemplos con datos **sintéticos**.
- Activar en GitHub: secret scanning, push protection, Dependabot.

## 4. Reporte de vulnerabilidades

Ver `SECURITY.md` en la raíz.
