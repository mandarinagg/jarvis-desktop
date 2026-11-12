# ADR-003: MCP como protocolo de herramientas

- **Estado:** Propuesta
- **Fecha:** 2026-11-12

## Contexto
El spec v1 propone un Tool Registry propio. La visión requiere muchas integraciones (archivos, git, calendario, mail, GitHub, Notion…). Model Context Protocol (MCP) es el estándar abierto para exponer herramientas a modelos, con cientos de servidores existentes.

## Decisión
El Core es un **cliente MCP**. Toda herramienta (incluidas las propias) se expone como servidor MCP. El **Permission Engine** se ubica entre el modelo y el MCP Client Hub y evalúa **cada** llamada (servidor, tool, argumentos) contra la política antes de ejecutar. Servidores de terceros se habilitan uno a uno, opt-in, con su política.

## Alternativas consideradas
- **Registry propio:** control total, pero reinventar integraciones una por una.
- **Solo Agent SDK para todo:** potente para código, demasiado amplio para la conversación diaria.

## Consecuencias
- (+) Ecosistema enorme; herramientas reutilizables por el Builder.
- (+) Una sola superficie de control de permisos.
- (−) Servidores MCP de terceros son código no confiable: correrlos con mínimos privilegios y revisarlos antes de habilitar.
