# ADR-031: Modelo de respaldo con OmniRoute local

- **Estado:** Aceptada por el owner (2026-11-24).
- **Fecha:** 2026-11-24
- **Decisores:** owner
- **Relacionada:** ADR-005 (router de modelos y costos), ADR-022 (evals de seguridad), ADR-029 (WhatsApp).

## Contexto
Jarvis depende de un solo proveedor. Si se llega al tope diario (US$3), si Anthropic limita el uso (429) o si la API se cae, Jarvis deja de contestar. El owner pidió usar **OmniRoute** para «aprovechar cuando se nos acaben los tokens» (2026-11-23). OmniRoute es un proxy local MIT que reparte pedidos entre más de 60 proveedores y expone una API compatible con Anthropic (`/v1/messages`).

En 2026-11-23 el owner había descartado un modo híbrido con un modelo local. Esto es distinto: no reemplaza a Claude, solo lo cubre cuando no está.

## Revisión de OmniRoute (2026-11-24)
- **Versión:** se instala la última oficial de npm, **3.8.54**, fijada en `%LOCALAPPDATA%\OmniRoute`. El clon del owner (fork de un tercero, v3.6.1) tenía siete meses de atraso.
- **Señal de cadena de suministro:** el paquete cambió de repo (de `diegosouzapw/OmniRoute` a la org `cheaper-inference/OmniRoute`) y sumó un segundo maintainer. No es un bloqueo, pero obliga a fijar la versión y revisar antes de actualizar.
- **Scripts de instalación:**
  - el `postinstall` se revisó: solo repara módulos nativos y sincroniza su `.env`;
  - se aprobaron `omniroute`, `better-sqlite3`, `esbuild`, `@swc/core`, `protobufjs` y `keytar`;
  - se negaron `onnxruntime-node` (compresión opcional) y `@parcel/watcher`.
- **Telemetría:** no se encontraron envíos a servidores propios en `bin/` ni en `open-sse/`. La «telemetry» es una API local de métricas.
- **Exposición de red:** por defecto escucha en `0.0.0.0` y no exige API key. Se configura con `HOST=127.0.0.1`, `OMNIROUTE_SERVER_HOST=127.0.0.1`, `REQUIRE_API_KEY=true` y `ENABLE_REQUEST_LOGS=false`, con secretos aleatorios en `data\.env` (ACL solo del owner).
  - Verificado: escucha solo en `127.0.0.1:20128` y `/v1/*` sin key devuelve 401.

## Decisión
- **Cuándo entra el respaldo:**
  - con el tope diario alcanzado;
  - o cuando Claude falla **antes de escribir texto**, por un error reintentable (429, 5xx, sin conexión) o por sobrecarga (529).
  - Nunca continúa una respuesta de Claude a medias, y nunca cubre una key inválida (401/403) ni un pedido rechazado (400): eso lo tiene que arreglar el owner.
- **Cómo:** con el mismo SDK oficial (`@anthropic-ai/sdk`), apuntado a `http://127.0.0.1:20128` y con el modelo `jarvis-fallback`. Ese combo lo arma el owner en OmniRoute (Gemini en la capa gratis, después Groq).
  - Va en la Messages API simple: sin betas, `effort` ni `cache_control`, que un proveedor traducido puede rechazar.
  - Nunca se usa `auto`, que podría elegir cualquier proveedor conectado.
- **Solo localhost:** `JARVIS_FALLBACK_URL` tiene que ser loopback. Cualquier otra dirección desactiva el respaldo, porque el turno lleva datos personales.
- **Solo lectura:** el modelo de respaldo no pasó las evals de seguridad (la resistencia a injections está medida solo con Claude).
  - Ve únicamente las herramientas de riesgo `read`. Las demás no aparecen y, si las pide igual, se rechazan antes de llegar al Permission Engine.
  - Sin escritura, sin Builder, sin cambios de memoria y sin recordatorios.
- **Siempre avisa:** la respuesta empieza con «(Respaldo: Claude no está disponible ahora, te respondo con otro modelo y sin acciones.)». Así se ve en la PC, en WhatsApp y en la voz.
- **Costos:** el uso se registra con el modelo `omniroute:<modelo>` y costo 0, sin sumar al tope de Claude. El gasto real (si el owner agrega proveedores pagos) se controla en el presupuesto de OmniRoute.
- **Credenciales:**
  - la key de Jarvis hacia OmniRoute vive en el Credential Manager (`omniroute-api-key`), en la lista de secretos que nunca se pasan a servidores MCP de terceros;
  - las keys de los proveedores (Gemini, Groq) las carga el owner en el panel de OmniRoute y nunca pasan por Jarvis ni por el chat.
- **Suscripciones por OAuth: nunca.** No se conecta la suscripción de Claude (ni otras) a OmniRoute para Jarvis: usar la suscripción desde un producto de terceros va contra los términos de Anthropic y arriesga la cuenta del owner.
- **Apagado:** `JARVIS_FALLBACK=0`, o borrar la key del Credential Manager.

## Alternativas descartadas
- **Llamar a Gemini directo con su SDK:** suma un segundo cliente, otro formato de herramientas y otra key en Jarvis. OmniRoute permite cambiar o sumar proveedores sin tocar código.
- **Darle al respaldo todas las herramientas:** no tiene evals de seguridad propias. Se habilitará cuando el modelo del combo pase las evals de injection (`--model` en el runner, pendiente).
- **Bajar el modelo de Claude al llegar al tope (Haiku):** sigue gastando en la misma cuenta y no cubre una caída de Anthropic.

## Validación (2026-11-24)
- **Combo `jarvis-fallback`, por prioridad:**
  1. `groq/openai/gpt-oss-120b`;
  2. `gemini/gemini-3.1-flash-lite`;
  3. `groq/qwen/qwen3.8-27b`.
- **Herramientas con el SDK oficial por OmniRoute:**
  - Groq gpt-oss-120b, 0,6 s;
  - Qwen 3.8, 1,1 s;
  - Gemini 3.1 Flash Lite, 0,8 s.
- **Gemini que fallaron ese día:** 3.8 y 3.7 Flash se cortaron a los 110 s, 2.5 Flash está retirado para cuentas nuevas, 3.1 Pro quedó en espera por límite de uso y 3 Flash Preview volvió vacío.
- **Punta a punta con `ChatService` y el tope superado:**
  - leyó `README.md` con `read_file` y contestó en 1,2 s, con el aviso y costo 0;
  - le pidieron crear un archivo y no tenía la herramienta, así que explicó que no puede.
- **Proveedores sin key:** OmniRoute trae activados por defecto proveedores anónimos o hechos con scraping web: `aihorde` (máquinas de voluntarios que pueden ver los prompts), `dva`, `cxa`, `ddgw`, `cfp` y `veo-free`. Jarvis usa solo el combo, pero conviene **desactivarlos en Providers** y **limitar la key `jarvis` al combo `jarvis-fallback`**, para que ni un error de configuración mande datos ahí.

## Consecuencias
- El owner tiene que tener OmniRoute corriendo. Si no está, la respuesta es «El respaldo (OmniRoute) no está corriendo».
- Lo que se manda al respaldo sale hacia el proveedor del combo (Google en el caso de Gemini). Las capas gratis pueden usar los datos para entrenar: el owner elige los proveedores sabiéndolo.
- Pendiente: correr las evals de seguridad contra `jarvis-fallback` antes de ampliar sus herramientas.
