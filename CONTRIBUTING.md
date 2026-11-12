# Contribuir

## Flujo
1. Tomá o creá un issue (usá las plantillas).
2. Rama desde `main`: `feat/…`, `fix/…`, `docs/…`, `spike/…`.
3. Commits con [Conventional Commits](https://www.conventionalcommits.org/) en inglés (`feat(core): add claude adapter`).
4. PR con la plantilla completa. `main` está protegida.

## Labels
- `fase:0` … `fase:7` — fase del roadmap
- `area:core` `area:voice` `area:desktop` `area:memory` `area:tools` `area:builder` `area:evals` `area:docs` `area:infra`
- `tipo:feature` `tipo:bug` `tipo:spike` `tipo:adr` `tipo:chore`
- `prioridad:alta` `prioridad:media` `prioridad:baja`

## Definition of Done
- [ ] Código con tests
- [ ] Evals verdes si toca prompts/orquestación/router/skills
- [ ] Docs actualizadas (y ADR si hubo decisión)
- [ ] Sin secretos ni datos personales
- [ ] Si toca herramientas: clase de riesgo definida y auditoría

## Decisiones
Usá `docs/adr/000-template.md`. Una decisión = un ADR.
