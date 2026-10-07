# Operación de QRACKS en Render

Guía corta para operar y diagnosticar. No sustituye un monitoreo dedicado.

Revisada el 2026-10-06 contra `main` (`4e5cbec`) y contra la configuración real de Render, leída con su API. Se corrigieron afirmaciones viejas:
- `/api/health` no consulta la base;
- el servicio de producción se llama `quinielas`;
- sin las variables obligatorias, el proceso no arranca.

## 0. Entornos

| | Producción | Sandbox |
|---|---|---|
| Servicio de Render | `quinielas` (`srv-d9amu2ucjfls73d67be0`) | `qracks-mon003-sandbox` (`srv-daq4rurtqb8s73ec3rng`) |
| Rama que despliega | `main` | `mon001a-plan-limits-enforcement` |
| Cuándo despliega | Automático con cada commit nuevo en esa rama | Igual |
| Plan e instancias | `free`, 1 instancia, región Virginia | `free`, 1 instancia, región Virginia |
| Dominio | `qracks.net`, detrás de Cloudflare | `qracks-mon003-sandbox.onrender.com` |
| Base de datos | PostgreSQL de producción (Supabase) | Una base distinta de la de producción. Lo confirmó el Founder; desde el repositorio no se puede verificar. |
| Pagos | Modo `live`, según su log de arranque | Modo `test`, según su log de arranque |

- **Comandos:** `npm install` para construir y `node server.js` para arrancar.
- **Sin health check ni previews:** Render no tiene configurado ningún health check, y las previews de PR están apagadas.
- **`render.yaml` no describe estos servicios:** declara un servicio llamado `quiniela-liga-mx`, sin rama, y no incluye las variables de los proveedores deportivos. La fuente de verdad es el dashboard de Render.
- **Desplegar en el sandbox** es subir un commit a `mon001a-plan-limits-enforcement`. Hasta ahora, cada validación se subió como un commit con el árbol del PR a probar encima de la punta de esa rama, sin forzar. **Desplegar en el sandbox también requiere autorización explícita.**
- **Producción despliega al fusionar a `main`.** Merge y deploy requieren autorización explícita del Founder (ver `CLAUDE.md` en la rama del equipo).
- **Arranque en frío:** con el plan `free`, el servicio se duerme tras unos minutos sin tráfico. La primera visita lo despierta y puede tardar de 30 a 60 s. En el log aparece un `Running 'node server.js'` sin deploy previo; **no es un fallo**.

## 1. Verificar que el servicio está vivo

```
GET https://qracks.net/api/health
```

Respuesta esperada: `{"ok": true, "time": "…"}`.

- **`ok:true`:** el proceso está arriba. **No dice nada de la base**: este endpoint no la consulta. Si las páginas fallan, revisa los logs (paso 2).
- **No responde, timeout o 502:** el servicio está caído o despertando. Espera un minuto y, si sigue igual, ve a Render.

**Al arrancar, el log debe mostrar, en este orden:**
1. `client_ip_source {"source":"render",…}`
2. `credential_attempts_loaded {"rows":N,…}`
3. `Quiniela server listening on port 10000`
4. `payments_readiness {"when":"startup","state":…}`

Si falta alguna línea o hay errores antes de `listening`, el arranque falló.

## 2. Dónde revisar logs en Render

1. Entra a [dashboard.render.com](https://dashboard.render.com) y abre el servicio `quinielas`, o `qracks-mon003-sandbox` para el sandbox.
2. **Logs** muestra la salida del proceso (`console.log` y `console.error` de `server.js`). Filtra por fecha y hora si buscas un evento concreto.
3. Los errores de base de datos suelen verse como `ECONNREFUSED`, `password authentication failed` o timeouts de Postgres. Casi siempre significan que `DATABASE_URL` cambió o expiró, o que Supabase tiene un problema por su lado.
4. **Events** muestra los deploys: qué commit se desplegó y si el build o el deploy fallaron.

## 3. Rollback

Render conserva los deploys anteriores:
1. Dashboard → servicio → **Events** o **Deploys**.
2. Elige el último deploy que funcionaba.
3. **Rollback to this deploy**, o **Redeploy** sobre ese commit.
4. Verifica con `/api/health` y una revisión rápida: login y Jornada.

**El rollback es del código, no de la base:**
- Las migraciones al arrancar (`ensureTable`) crean tablas, índices y semillas si faltan. También completan datos en filas existentes: `roundsRevision`, y el plan y el ciclo de las quinielas que no los tenían. Un rollback no las deshace, y **no está probado** que un código anterior las tolere siempre.
- Un problema causado por un cambio de datos requiere una acción aparte en Supabase. Eso es un cambio de datos de producción y requiere autorización explícita.

## 4. Si un deploy falla

1. **Events** → el deploy fallido → su log de build.
2. Causas comunes:
   - **`npm install` falla:** revisar los cambios en `package.json` o `package-lock.json`.
   - **El proceso arranca y muere enseguida:** el log del primer minuto lo dice.
     - Si faltan `DATABASE_URL` o `PLATFORM_PASSWORD`, el proceso termina con «Missing required environment variable(s)».
     - Si la base no responde, reintenta 5 veces cada 3 s y termina.
   - **Build correcto pero `/api/health` no responde:** puede ser el arranque en frío. Espera un minuto.
3. Si no se resuelve, haz rollback (paso 3) mientras se investiga.

## 5. Variables de entorno (Render → Environment)

Los **valores** viven sólo en Render. Nunca en el repositorio, en un issue, en un log ni en un chat.

| Variable | Obligatoria | Para qué |
|---|---|---|
| `DATABASE_URL` | Sí | Conexión a PostgreSQL. Si contiene `localhost`, se desactivan SSL y las cookies `Secure` (modo local). Si no, la conexión usa SSL **sin verificar el certificado** del servidor de base de datos (`rejectUnauthorized: false`). |
| `PLATFORM_PASSWORD` | Sí | Contraseña **inicial** del panel de plataforma. En cuanto se cambia desde el panel, manda la guardada en la base. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_BASE_URL` | Las tres o ninguna | Pagos. Ninguna: pagos apagados. Algunas: `MISCONFIGURED`, que falla cerrado. Ver §7. |
| `THESPORTSDB_API_KEY` | Para importar y para resultados automáticos | Sin ella, la importación de jornadas y los resultados automáticos fallan. Lo manual sigue funcionando. |
| `SPORTMONKS_API_TOKEN` | Sólo si alguna quiniela usa Sportmonks | Proveedor alternativo, opcional. |
| `PG_POOL_MAX` | No (10) | Tamaño del pool de conexiones. |
| `PORT` | No | Render la pone. |
| `RENDER` | No | Render la pone. Con `true`, la IP del cliente se toma de Cloudflare. |
| `QRACKS_CLIENT_IP_SOURCE` | No | Fuerza la fuente de la IP (`render`, `socket` o `xff:N`). Ver [SECURITY_CREDENTIAL_LIMITS.md](SECURITY_CREDENTIAL_LIMITS.md) §3. |

Cambiar cualquier variable en Render requiere autorización explícita del Founder.

## 6. Seguridad de la base

- `docs/security/sec-002-hardening.sql` crea políticas que niegan a los roles de la API de Supabase (`anon` y `authenticated`) el acceso a `kv` y `analytics_events`. Se aplica a mano.
- **Ese script no activa RLS.** No ejecuta `ENABLE ROW LEVEL SECURITY`. Sin RLS activo, las políticas no tienen efecto.
- **Que RLS esté activo en producción es UNKNOWN / NOT PROVEN:** no se puede comprobar desde el repositorio.
- **Cómo comprobarlo** (sólo lectura, en el editor SQL de Supabase): `select relname, relrowsecurity from pg_class where relname in ('kv', 'analytics_events');`. Debe dar `true` en las dos.
- **Si da `false`:** activarlo (`alter table … enable row level security`) es un cambio en la base de producción y requiere autorización explícita del Founder.
- La tabla `credential_attempt_buckets` sí activa RLS: lo hace el servidor al arrancar.

## 7. Pagos (MON-003): poner Stripe en marcha

QRACKS cobra por el software. No custodia ni reparte premios, y nunca ve ni guarda un número de tarjeta: el cobro ocurre en el checkout de Stripe. Las reglas y el flujo están en [flujos/pagos.md](flujos/pagos.md).

### Lo que hace falta en el entorno

Tres variables, **las tres juntas**:

| Variable | De dónde sale |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → *Secret key* |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → el endpoint → *Signing secret* |
| `PUBLIC_BASE_URL` | El origen público del servicio, por ejemplo `https://qracks.net`. Sin ruta. |

### Alta del webhook en Stripe

1. Stripe → Developers → Webhooks → *Add endpoint*.
2. URL: `https://<tu-dominio>/api/payments/stripe/webhook`.
3. Envía sólo estos eventos:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded` *(sólo auditoría)*
   - `charge.dispute.created` *(sólo auditoría)*
4. Copia el *Signing secret* a `STRIPE_WEBHOOK_SECRET` y reinicia el servicio.

**Claves y webhooks:**
- Las claves de test y las de producción tienen webhooks distintos: al cambiar unas, hay que cambiar el otro.
- El sandbox usa claves de test y producción, claves live.
- Cualquier cobro, también de prueba, requiere autorización explícita del Founder.

### Comprobar que está vivo

- El precio se lee de `commercial_config`, no del código. Cambiarlo en el panel cambia el siguiente checkout; las compras ya hechas conservan su precio.
- Al arrancar, el log dice el estado de los pagos en una línea y sin secretos: `payments_readiness {"when":"startup","state":"ready",…}`, o `PAYMENTS MISCONFIGURED {…"problems":[…]}` con lo que falta.
- El mismo diagnóstico, con la URL exacta del webhook, está en el panel de plataforma → **Pagos (Stripe)**.
- **`disabled`** (ninguna variable): «Pasar a Plus» dice que el pago con tarjeta no está disponible y ofrece la vía manual.
- **`misconfigured`** (algunas variables, o alguna mal): no se abre ningún checkout, el webhook responde 503 (Stripe reintenta) y la pantalla no ofrece la vía manual. Al corregirlo y reiniciar, los pagos pendientes se confirman solos.
- Checklist de despliegue: «MON-003 / Stripe deployment checklist» en el `README.md`.

### Qué mirar cuando algo va mal

Los logs de pagos son una línea `payments <evento> {…json…}`, sin secretos. La lista completa sale con `grep -o 'logPayment("[a-z_]*' server.js`. Los valores de abajo son **los que aparecen escritos en el log**: búscalos tal cual.

**Rutina y configuración:**

| Línea en el log | Significa | Qué hacer |
|---|---|---|
| `payments checkout_created` / `checkout_reused` | Se abrió un checkout, o un reintento reutilizó el anterior en vez de duplicarlo | Nada |
| `payments checkout_creation_failed` | No se pudo crear; `code` dice por qué | Si persiste, revisar Stripe |
| `payments_readiness` / `PAYMENTS MISCONFIGURED` | Estado de los pagos al arrancar; `problems` dice qué falta | Corregir las variables (con autorización) |
| `payments checkout_refused_misconfigured` | Se pidió Plus con los pagos mal configurados; no se creó nada | Corregir la configuración |
| `payments checkout_replacement_busy` | Dos pestañas pidieron un checkout nuevo a la vez; la segunda recibió `409 replacement_in_progress` | Nada |
| `payments checkout_identity_still_chargeable` / `checkout_blocked_unresolved` | Una sesión anterior podría seguir cobrando, así que no se crea otra (`503 checkout_unavailable`) | Revisar en Stripe las sesiones abiertas de esa quiniela |
| `payments checkout_attempts_exhausted` | 24 intentos sobre la misma compra; se detiene y pide a una persona | Revisar la compra y sus sesiones en Stripe |
| `payments webhook_rejected` | Llegó un evento con los pagos sin configurar o mal configurados; respondió 503 y Stripe reintenta | Corregir la configuración |
| `payments webhook_invalid_signature` | Llegó algo que no venía de Stripe, o el signing secret no es el de ese destino (test y live cruzados) | Revisar el secret del destino |
| `payments webhook_api_version_differs` | El destino del webhook usa otra versión de API | Crear el destino con la versión fijada |
| `payments reconciled` | Un pago se recuperó sin webhook, al volver el admin | Nada |

**Cobros que necesitan a una persona.** **La decisión es manual del operador**: no hay un procedimiento automatizado ni una política de devoluciones escrita.

1. `payments webhook_processed {"decision": …}` con una de estas decisiones significa **dinero cobrado y Plus no otorgado**:

| `decision` | Qué pasó |
|---|---|
| `stale_scope` | Pagaron un torneo que ya terminó: hay que devolver o trasladar |
| `amount_mismatch`, `currency_mismatch` | El importe o la moneda no son los esperados |
| `identity_mismatch`, `scope_unproven`, `snapshot_unusable` | No se pudo probar que el pago corresponda a esa compra y torneo |
| `quiniela_missing` | La quiniela ya no existe |
| `superseded_purchase` | Pagaron una compra que el sistema ya había sustituido por otra |

   `unknown_purchase` es un evento de Stripe que no corresponde a ninguna compra de QRACKS. Se decide antes de mirar si hubo cobro, así que puede traerlo o no: revísalo en Stripe.

   No requieren acción: `confirm` (otorgado), `replay_event` / `ignored_stale_event` (evento repetido o viejo), `already_paid` (ya estaba confirmado) y `not_paid` (sin cobro).

2. `payments payment_requires_attention` tiene tres formas:

| Forma | Significa |
|---|---|
| `{"purchaseId", "code": "refunded" \| "disputed"}` | Reembolso o disputa en Stripe. **No revoca Plus automáticamente**: la política de revocación no está decidida. |
| `{"purchaseId", "code": <error>}`, y el webhook responde `500 unapplied_payment` | Un pago válido no se pudo aplicar. Stripe reintenta; si se repite, revisar logs y base. |
| `{"slug", "incidents": […], "auditEntries", "flagged"}` | Varias sesiones de checkout para una misma compra (posible cargo doble). Revisar en Stripe cuál cobró. |

3. También piden revisión `payments session_multiplicity`, `checkout_session_multiplicity_blocked` y `session_double_charge_revealed` (cargo doble revelado), y `payments entitlement_grant_failed` (Plus no se pudo escribir; Stripe reintenta).

**Dónde mirar:**

- **El log de Render:** el evento y el `purchaseId`.
- **La fila `platform_payment_intents`:** las compras (`purchases`), los eventos ya vistos (`seenEvents`) y la auditoría (`audit`).
  - Sólo la lee la plataforma, con `GET /api/kv/platform_payment_intents` y la contraseña de plataforma en `X-Qracks-Platform-Auth`. El panel no tiene una vista de esta fila.
  - No pegues la contraseña en un chat ni la dejes en el historial de la terminal.
  - La fila sólo la escribe el servidor.
- **En la auditoría**, cada alerta lleva uno de estos códigos, escritos tal cual:

| Código en la auditoría | Significa |
|---|---|
| `paid_for_a_finished_tournament` | Se pagó un torneo que ya terminó |
| `amount_mismatch`, `currency_mismatch` | Importe o moneda distintos de los esperados |
| `provider_identity_mismatch` | La sesión no es la que la compra registró |
| `paid_for_a_deleted_quiniela` | La quiniela ya no existe |
| `purchase_snapshot_unusable`, `current_tournament_unreadable` | No se puede probar el torneo o la oferta |
| `refunded`, `disputed` | Reembolso o disputa |
| `several_provider_checkouts_for_one_purchase`, `another_checkout_was_used_beside_a_paid_one`, `two_checkouts_were_used_without_reported_payment`, `two_checkouts_were_paid_for_one_tournament` | Varias sesiones o un cargo doble |
| `open_checkout_could_not_be_resolved` | No se pudo descartar que una sesión abierta cobre |
| `retired_because_another_checkout_is_the_active_one`, `retired_because_another_checkout_was_paid`, `superseded_by_a_newer_checkout` | Sesiones retiradas a propósito; normalmente informativo |

- **En Stripe:** cada compra guarda los ids de sus sesiones de checkout (`providerSessionId` / `providerSessionIds`, que empiezan con `cs_`). Con ese id se busca la sesión y su cobro en el Dashboard de Stripe.

Las compras y su auditoría viven en `platform_payment_intents`, que sólo lee la plataforma y sólo escribe el servidor.
