# UX-INFRA-001 · Piloto de la pantalla de carga (preparación local)

**Estado:** código y pruebas **locales**. No se creó ningún recurso externo ni se desplegó nada. Tampoco hubo cambios de DNS, infraestructura, producción ni pagos.
**Base:** `main` en `9164bac`, con la propuesta v3 y los ajustes de la revisión de GPT. Incluye las correcciones de la revisión de GPT sobre `84ddb70` (ver «Correcciones tras la revisión de 84ddb70»).

**Fuentes de evidencia:**
- **[Claude]**: ejecutado o leído en el código.
- **[GPT]**: comprobado o revisado por GPT.
- **[Render API]**: leído con el conector de Render, sólo lectura.
- **[Doc]**: documentación consultada. **No es una prueba ejecutada.**

## Qué hay aquí
| Archivo | Qué es |
|---|---|
| `edge/worker.mjs` | El Worker. Sólo actúa en navegaciones `GET`/`HEAD`; todo lo demás pasa tal cual, una vez y sin reintentos. |
| `edge/page.mjs` | El HTML de la pantalla. Es autocontenido y su única petición es `GET /api/health`. |
| `edge/waker.mjs` | El ciclo de espera: los intentos, el tiempo máximo y el plazo, y el contrato de `/api/health`. |
| `edge/copy.mjs` | Los textos por destino (`/`, `/crear`, `/q/…`, `/a/…`) y los de «Mientras tanto». |
| `wake-service/server.mjs` | El servicio mínimo del piloto, sin base de datos ni dependencias. |
| `dev/emulator.mjs` | Un servidor Node que pasa cada petición por el Worker. **Sólo para pruebas locales.** |
| `test/*.test.mjs` | Las pruebas locales. |
| `measure/` | H-WAKE: Worker de medición (`probe-worker.mjs`, bundle en `dist/worker.mjs`), `probe.mjs` (HTTP), `browser-probe.mjs` (navegador real), `cloudflare.mjs` (API de Cloudflare, con protección y registro), `recursos.mjs` (registro de lo creado) y el plan `PLAN-H-WAKE.md`. |
| `dev/bundle.mjs` | Genera el Worker en un solo archivo. |

**No se tocan** la app (`server.js`, `public/`), `render.yaml`, `package.json` ni la suite principal (`test/`).

## Cómo correr las pruebas
```
node --test pilot/test/*.test.mjs
```
La prueba de navegador usa Playwright si está instalado (`NODE_PATH=/opt/node22/lib/node_modules` en el entorno de Claude); si no, se salta.

## Decisiones (propuesta v3 + revisión de GPT)
1. **Contrato de `/api/health` sin cambios.** «Listo» exige las cuatro: estado 200, `Content-Type` JSON, `ok === true` y `time` con una fecha válida. No se añaden campos a la app.
2. **Consultas acotadas.**
   - Una a la vez, `GET`, `cache: "no-store"`, sin credenciales y con un tiempo máximo de 8 s.
   - Intervalos de 2, 2, 3, 3, 5, 5 y luego 8 s, con un plazo de **120 s de reloj** desde que se mostró la pantalla.
   - Terminan al abrir la página, al salir de ella (`pagehide`) o al agotar el plazo.
   - Con la pestaña oculta o sin red se pausan. Al volver sólo siguen si queda plazo: ocultar la pestaña no lo reinicia.
   - Sólo «Reintentar», que pulsa la persona, abre un plazo nuevo.
   - Así la pantalla **no mantiene despierto Render indefinidamente**: como mucho hace unas 18 consultas por pestaña.
3. **Al estar lista, la página se recarga** (como mucho 3 veces seguidas y dentro del mismo plazo de 120 s; ver la decisión 7) (`location.reload()`) en la **misma URL**, con ruta, parámetros y fragmento, sin añadir una entrada al historial.
   - [Claude] La prueba local encontró que `location.replace(location.href)` falla cuando la URL tiene un `#fragmento`: lo trata como un cambio dentro del mismo documento y no vuelve a pedir la página.
4. **El Worker nunca intercepta** la API, los webhooks, los archivos (rutas con extensión) ni `POST`/`PUT`/`PATCH`/`DELETE`.
   - Esas peticiones se reenvían una sola vez y sin reintentos. Si el origen falla, el error llega tal cual.
   - Las redirecciones del origen se entregan sin seguirlas.
5. **H-WAKE:** cómo distinguir la página de arranque de Render queda **sin definir** (`isRenderWakePage` devuelve `false`) hasta medirla en el piloto externo.
6. **Textos sólo por destino**, sin cookies. Nada de la URL se imprime en la página.
7. **Límite de recargas automáticas.** Si `/api/health` responde pero la página no termina de abrir, el Worker vuelve a servir la pantalla tras cada recarga.
   - Una recarga automática **continúa el mismo plazo** de 120 s y hay **como mucho 3**. Después aparece «QRACKS ya responde, pero la página no terminó de abrir» con el botón «Abrir de nuevo».
   - Sólo una acción de la persona («Reintentar» o «Abrir de nuevo») abre un plazo nuevo.
   - El registro vive en `sessionStorage` de la pestaña (no es una cookie ni viaja al servidor), por ruta y parámetros. Sólo vale si el navegador marca la carga como recarga y la anterior fue hace menos de 10 min. Una navegación nueva siempre empieza de cero.
   - Sin `sessionStorage` no hay recarga automática: sólo el botón.

## Correcciones tras la revisión de 84ddb70
1. **[GPT] reprodujo; [Claude] reprodujo con pruebas nuevas y corrigió:** al cancelar o reiniciar con una consulta en curso, la continuación antigua podía limpiar el tiempo máximo del intento nuevo y volver a programar, con dos consultas a la vez.
   - Ahora cada ciclo e intento lleva una generación; cancelar la sube y las continuaciones antiguas se descartan. Cada intento sólo limpia su propio temporizador.
2. **[GPT] reprodujo; [Claude] reprodujo y corrigió:** el plazo de 120 s no cortaba una consulta ya iniciada, y una respuesta válida a los 122 s abría la página.
   - Ahora el tiempo máximo de cada intento nunca pasa del plazo (se aborta al vencer) y cualquier respuesta en o después del plazo se rechaza.
3. **[GPT] lo señaló como riesgo, sin reproducirlo; [Claude] lo comprobó localmente:** con `/api/health` bien y la navegación lenta, la recarga reiniciaba el plazo y el ciclo podía no terminar. Ver la decisión 7.

## Qué demuestran las pruebas locales [Claude]
Corrida en Node 22.22.0: `# tests 39 · # pass 39 · # fail 0 · # skipped 0`.
Las regresiones 1a, 1b, 1c, 2 y 2b (más la de `startedAt`) **fallan con el `waker.mjs` de 84ddb70** (`# tests 16 · # pass 10 · # fail 6`) y pasan con la corrección.

**Unitarias:**
- **Salud:** sólo el contrato actual cuenta como «listo». No bastan un 200 en HTML, un JSON sin `ok`, una fecha inválida ni un estado que no sea 200.
- **Navegación:** se detecta sólo con `GET`/`HEAD` de página. Quedan fuera `/api/*`, el webhook, los archivos, los métodos que escriben y los `fetch()` de la app.
- **URL de origen:** ruta, parámetros y fragmento se conservan.
- **Textos:** cada uno de los 4 destinos tiene el suyo, y no aparecen «se guarda», liguilla ni premios.
- **R1:** la página hace un solo `fetch` (`GET /api/health`, sin caché). No tiene formularios, XHR, `sendBeacon` ni WebSocket, no refleja nada de la URL, y el aviso de pago sale sólo con `qz_pago` y sin `qz_pago_cancelado`.

**Ciclo de espera** (reloj simulado):
- Los intentos caen a los 2, 4, 7, 10, 15, 20, 28 y 36 s, y nunca hay dos a la vez.
- El contador «Próximo intento en N s» coincide con el programa real.
- Al recibir una respuesta válida se abre la página una sola vez y se deja de consultar.
- Una consulta colgada se corta a los 8 s.
- A los 120 s pasa a error y no queda ningún temporizador vivo.
- Con la pestaña oculta no consulta, y al volver fuera de plazo termina.
- Al salir de la página se cancela también la consulta en curso.
- Sin red se pausa y sigue al volver la conexión.
- «Reintentar» abre un plazo nuevo.
- «Reintentar» u ocultar y volver con una consulta en curso, incluso si el aborto rechaza tarde: nunca dos consultas vivas, un solo programa, y el tiempo máximo del intento nuevo sigue en pie.
- Una consulta empezada a los 116 s se aborta a los 120 s exactos y su respuesta «lista» de los 123 s no abre la página; una que llega justo a los 120 s tampoco.

**Recargas** (reloj simulado, `pilot/test/reload.test.mjs`):
- Con `/api/health` bien y cada recarga devolviendo la pantalla: 1 carga + 3 recargas, todas en el mismo plazo, y luego el botón.
- Si cada recarga tarda 50 s o 70 s, el plazo compartido se agota y termina en error, sin más recargas.
- Sin `sessionStorage` (bloqueado o con error): ninguna recarga automática.
- Un registro viejo, corrupto o de una navegación nueva no recorta el plazo.

**Worker contra el servicio mínimo local** (el «arranque en frío» se simula reteniendo respuestas):
- **Origen despierto:** la página pasa intacta (estado, dos `Set-Cookie`, cuerpo), y el origen recibe la misma ruta y los mismos parámetros, incluida una «ñ».
- **Origen dormido:** la navegación recibe la pantalla (503, `no-store`, `noindex`) con el título del destino. La petición al origen queda viva (`waitUntil`) y no se repite. `HEAD` recibe 503 sin cuerpo.
- **Origen dormido, sin pantalla** y con exactamente una petición al origen cuando despierta:
  - `GET /api/health`, aunque pida HTML;
  - `POST /api/eco`, con los mismos bytes y el mismo sha256;
  - el webhook de Stripe, con el cuerpo crudo idéntico y `stripe-signature`;
  - un `POST` a una ruta de página;
  - un archivo estático.
- **Origen caído:** la API recibe el error una sola vez, y la página recibe la pantalla.

**Navegador** (Chromium, emulador local y servicio dormido):
- `/a/mi-q?qz_pago=pi_1&qz_sess=cs_2#arriba` muestra «Estamos abriendo la administración de tu quiniela», el aviso de pago y la nota sobre pronósticos.
- Al «despertar», abre la app en la **misma URL**, y el origen recibe `/a/mi-q?qz_pago=pi_1&qz_sess=cs_2`.
- La pantalla sólo hizo `GET /api/health`. Cada consulta llegó al origen, así que ninguna salió de caché.
- Tras abrir la página no hay más consultas.
- En «Mientras tanto», la pausa funciona con teclado: Enter pausa y el beneficio no cambia en 8 s; Espacio reanuda.
- Con un origen que responde `/api/health` pero retiene las páginas: 4 documentos pedidos (la carga y 3 recargas), siempre la misma URL. Aparece «Abrir de nuevo» y en 6 s no hay más consultas ni recargas. Al pulsarlo, con el origen ya sirviendo páginas, abre la app en la misma URL con su fragmento.

> **Estas pruebas NO aprueban H-WAKE, H-IP ni H-TLS.** Usan un origen local que *simula* el arranque reteniendo respuestas, sin Cloudflare ni Render.

## Lo que sólo puede demostrarse en el piloto externo
- **H-WAKE:** qué devuelve Render a una subpetición del Worker mientras despierta (estado, cabeceras y tiempos), y cómo distinguirlo de la app (`isRenderWakePage`).
- **H-IP, en dos niveles:**
  - **(a) IP recibida correctamente:** el eco (`/api/eco-ip`) muestra la IP real de dos redes distintas conocidas, tanto por el Worker como por la ruta sin Worker. **Un eco no cierra H-IP.**
  - **(b) Limitador real validado:** sólo con la app completa. Hay que comprobar que los intentos de PIN se cuentan por visitante, sin mezclar a dos personas ni dejar que una evite el límite.
- **H-TLS:** emitir el certificado de Render con el registro sin proxy y luego activar el proxy en «Full (strict)» ([GPT/Doc]: Render documenta ese orden). La **renovación** no se puede observar en un piloto corto, así que queda como riesgo con un plan.
- **H-DNS:** importar en Cloudflare **todos** los registros de GoDaddy y compararlos antes de cambiar los nameservers.
- **Recargas con Render real:** si la navegación lenta tras un `/api/health` sano ocurre de verdad, y con qué frecuencia. El límite está probado sólo localmente y en Chromium; Safari y Firefox no se probaron.
- **Con la app completa:** `/q`, `/a` y `/crear` reales (incluidas las vistas previas OG de `/q`), sesiones y permisos tras la recarga, el retorno de Stripe y el webhook a través del proxy, y el tiempo real de arranque con base de datos.

## Reversión (para cuando haya Worker)
- **Retirar el Worker** (quitar su ruta) es una **reversión rápida, pero hay que comprobarla**:
  - verificar que la página ya no se sirve;
  - verificar que `/api/health` responde directo;
  - verificar que no queda caché intermedia.
  - El tráfico sigue pasando por el proxy de Cloudflare, así que no es una vuelta al estado anterior.
- **Revertir el DNS** a GoDaddy **requiere propagación**, que puede tardar hasta 24–48 h según los TTL. Durante ese tiempo conviven las dos rutas.

## Horas gratuitas: comprobar antes de proponer la creación
- **[Render API]** El workspace tiene **dos servicios free**: `quinielas` (producción) y `qracks-mon003-sandbox`. Un servicio piloto sería el tercero y **compartiría las 750 h/mes del workspace con producción** [Doc].
- **[Render API]** La métrica `instance_count` de los servicios free llega **vacía** con el conector, así que **no puedo ver las horas consumidas** este mes. Ese dato está en el dashboard (Billing / uso del plan free).
- **Duración prevista:**
  - una sesión de H-WAKE de unas 2 h (dejarlo dormir más de 15 min y despertarlo varias veces), de las que sólo están despiertos los ratos de medición;
  - una sesión de H-IP/H-TLS de unas 2 h, si hay un dominio de prueba.
  - Estimación: **≤ 4 h despiertas** en total. Es una estimación, no una medición.
- **Apagado al terminar:**
  - suspender el servicio desde el dashboard (el conector no tiene herramienta para suspender ni borrar servicios), o borrarlo;
  - desactivar el auto-deploy;
  - confirmar en el dashboard que no queda despierto.
  - La rama del piloto sería propia: nunca `main` ni `mon001a-plan-limits-enforcement`.

## Qué puedo consultar yo y qué necesito de ti
**Puedo consultar** [Claude]:
- **Render API:** servicios, deploys, logs, métricas, Postgres y workspaces, en modo lectura.
- **GitHub:** el repo, los PRs y Actions.

**No puedo consultar** [Claude]:
- dominios personalizados de Render (el conector no los expone);
- horas free consumidas (métrica vacía);
- DNS y GoDaddy (no hay resolución de DNS en esta sesión);
- Cloudflare (no hay conector);
- render.com (bloqueado por la red de la sesión).

**Necesito de ti, sólo para la fase externa** (nada de esto bloquea lo local):
1. Las **horas free consumidas este mes**, del dashboard de Render.
2. Si **existe una cuenta de Cloudflare**, o si creamos una (eso es tuyo).
3. Si hay un **dominio de prueba** que no sea `qracks.net`, para H-IP completo y H-TLS. Sin él, el piloto externo cubre H-WAKE y la parte del Worker de H-IP con `workers.dev`.

Los dominios adicionales y el export de GoDaddy hacen falta para H-DNS, pero **no bloquean** ni la preparación local ni el piloto con el servicio mínimo.
