# Handoff: estado del proyecto

> Última actualización: **2026-11-13**. Actualizar al cerrar cada sesión de trabajo. Lo de largo plazo está en `ROADMAP.md`; este archivo cuenta **dónde estamos y qué sigue**.

## Dónde estamos
- **Fase 0 (Diagnóstico):** completa, salvo la cuenta de la API de Anthropic, que la tiene que crear el owner.
- **Fase 1 (L0: Core + chat):** **implementada y mergeada en `main`** (PRs #20–#25, CI en verde). Falta validarla con la API real.
- **Fase 2 (Voz):** sin empezar. Se recomienda arrancarla después de tener datos reales de la API (latencia y costo).

## Lo que funciona hoy
| Pieza | Dónde | Notas |
|---|---|---|
| Contratos IPC (Zod, JSON Lines) | `packages/shared` | Protocolo v1.0, objetos estrictos, frame máximo de 1 MB |
| Core daemon | `packages/core` | Named pipe + token de sesión, instancia única, logs con redacción de secretos |
| Persistencia | `packages/core/src/store.ts` | `node:sqlite` (WAL) en `%APPDATA%/Jarvis/jarvis.db` |
| Secretos | `packages/core/src/secrets.ts` | Credential Manager; `set-secret` |
| Claude | `packages/core/src/claude/` | SDK 1.8, streaming, `effort: low`, caché, fallbacks del lado del servidor |
| Costo y tope | `chat.ts`, `pricing.ts` | Tope diario por defecto de US$3 (`JARVIS_DAILY_BUDGET_USD`) |
| Chat por terminal | `packages/core/dist/chat-cli.js` | Cliente IPC |
| App de escritorio | `apps/desktop` | Electron 45 + React 19. Si el Core no está corriendo, lo arranca con el Node de Electron |
| Evals | `evals/` | 15 conversaciones, juez Opus 5.5, umbral del 80% |
| Benchmarks de voz | `services/voice` | STT: Parakeet (ADR-010). TTS: Google Neural2 (ADR-011) |

## Pendiente del owner (bloquea el cierre de la Fase 1)
1. Crear la cuenta de la API de Anthropic con **tope mensual de US$60** en la consola.
2. Guardar la clave: `pnpm build` y después `node packages/core/dist/set-secret.js anthropic-api-key`.
3. Correr las evals: `pnpm --filter @jarvis/evals eval` (~US$0,32; tiene que dar ≥ 80%).
4. Usar Jarvis por texto durante una semana: `pnpm --filter @jarvis/desktop start`.

## Próximos pasos (para quien retome)
1. Cuando la clave esté guardada: correr las evals, revisar los criterios que fallen y ajustar `packages/core/prompts/system.md`. Cada cambio de prompt se vuelve a medir con las evals.
2. Probar el chat real y anotar la latencia hasta el primer token y el costo por turno para recalibrar `CLAUDE_API.md` §4.1. Hoy el estimado de uso típico es de ~US$2,2/día, por encima del objetivo de US$1.
3. Con esos datos, planificar la **Fase 2 (voz)**: Voice Service como proceso hijo del Core por stdio (ADR-008), Parakeet para STT, Neural2 para TTS, más las mitigaciones de latencia de ADR-011 (caché de acuses, síntesis superpuesta).

## Decisiones abiertas
- **Costo:** el uso típico estimado (~US$2,2/día) supera el objetivo de US$1. Hay que decidir si se sube el objetivo o se ajusta `effort`, el largo de las respuestas o el router, con datos reales.
- **Latencia del TTS:** Google tarda ~1,2 s hasta el primer audio, contra 300 ms de presupuesto (ADR-011). Se revisa en la Fase 2.
- **Fallbacks del lado del servidor:** están activados por defecto (`fallbacks: "default"`). El owner puede desactivarlos.
- **Pendientes de ADR-007:** el cifrado AES-GCM de campos (Fase 3) y los backups `VACUUM INTO`.

## Trampas conocidas
- **Smart App Control:** bloquea los `.exe` nuevos que genera `uv` y los intérpretes sin firmar. Hay que usar `uv run python -m …` (ver `TROUBLESHOOTING.md`).
- **Git Bash convierte `\\.\pipe\…`** en las variables de entorno. Las pruebas con named pipes van desde PowerShell.
- **`tsc` emite aunque haya errores:** si el build falla, `dist/` puede quedar roto. Revisá la salida antes de probar.
- **Electron oculto no se repinta:** el modo smoke usa `showInactive()` para que `capturePage` funcione.
- **SDK 1.x** autentica con `Authorization: Bearer` y no con `x-api-key`. Tenelo en cuenta en los mocks.
- **pnpm 10:** los argumentos se pasan sin `--` (`pnpm --filter @jarvis/evals eval --dry-run`).
- **Credenciales:** la API key de Google TTS está en la variable de usuario `JARVIS_GOOGLE_TTS_API_KEY`. Hay que migrarla al Credential Manager (`google-tts-api-key`) en la Fase 2.

## Cómo verificar el estado
```powershell
pnpm install --frozen-lockfile
pnpm lint; pnpm build; pnpm typecheck; pnpm test     # 74 tests
cd services/voice; uv run pytest -q                   # 51 tests
```
