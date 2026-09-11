# Operación — QRACKS en Render

Guía corta para diagnosticar y responder si algo falla en producción. No sustituye monitoreo dedicado — es lo mínimo para operar con los primeros organizadores.

## 1. Verificar que el servicio está vivo

```
GET https://<tu-dominio-render>/api/health
```

Respuesta esperada:
```json
{"ok": true, "time": "2026-08-14T..."}
```

- **Responde con `ok:true`** → el servidor está arriba y conectado a la base de datos (el endpoint no depende de la DB directamente, así que si el servidor responde pero las páginas fallan, ver paso 2 — puede ser un problema de conexión a Postgres).
- **No responde / timeout / 502** → el servicio está caído o Render no pudo levantarlo. Ir a Render.
- **Responde pero las páginas normales fallan** → revisar logs (paso 2), probable problema de `DATABASE_URL` o conexión a Supabase.

## 2. Dónde revisar logs en Render

1. Entra a [dashboard.render.com](https://dashboard.render.com) → selecciona el servicio `quiniela-liga-mx`.
2. Pestaña **"Logs"** (menú lateral) — muestra el output en vivo del proceso (`console.log`/`console.error` de `server.js`).
3. Filtra por fecha/hora si buscas un evento específico (ej. el momento en que alguien reportó un error).
4. Errores de conexión a base de datos suelen verse como `ECONNREFUSED`, `password authentication failed`, o timeouts de Postgres — casi siempre apuntan a que `DATABASE_URL` cambió, expiró, o Supabase está teniendo un problema por su lado.
5. Pestaña **"Events"** — muestra el historial de deploys (cuándo se desplegó qué commit, y si el build/deploy falló).

## 3. Procedimiento básico de rollback

Render conserva los deploys anteriores — no hace falta revertir código a mano:

1. Dashboard → servicio → pestaña **"Events"** (o **"Deploys"**).
2. Busca el último deploy que sabías que funcionaba bien.
3. Botón **"Rollback to this deploy"** (o **"Redeploy"** sobre ese commit específico, según la versión de la interfaz de Render).
4. Confirma. Render vuelve a desplegar ese commit — toma unos minutos, igual que un deploy normal.
5. Verifica con `/api/health` y una revisión visual rápida (login, Jornada) de que todo responde bien otra vez.

**Nota:** el rollback es sobre el código/deploy, no sobre la base de datos. Si el problema fue causado por un cambio de datos (no de código), el rollback de Render no lo revierte — eso requeriría una acción aparte sobre Supabase.

## 4. Qué revisar si un deploy falla

1. **Events → el deploy fallido** → abre el log de build de ese intento específico.
2. Errores más comunes:
   - **`npm install` falla** → revisar si `package.json`/`package-lock.json` cambiaron de forma incompatible.
   - **El proceso arranca y muere enseguida** → revisar los logs (paso 2) del primer minuto tras el arranque — casi siempre `DATABASE_URL` o `PLATFORM_PASSWORD` faltante o mal configurado en el servicio.
   - **Build exitoso pero `/api/health` no responde** → puede ser que el servicio tarde en levantar (Render free tier duerme instancias inactivas — el primer request tras inactividad puede tardar ~30-60s, no es necesariamente un fallo).
3. Si nada de lo anterior resuelve: rollback (paso 3) al último deploy funcional mientras se investiga con más calma — no hay necesidad de diagnosticar bajo presión con el servicio caído.

## Variables de entorno requeridas (Render → Environment)

| Variable | Qué es |
|---|---|
| `DATABASE_URL` | Cadena de conexión a Postgres (Supabase) |
| `PLATFORM_PASSWORD` | Contraseña del panel de plataforma (`/api/platform-*`) |

Si alguna falta o es incorrecta, el servicio puede levantar pero fallar en cualquier operación que toque la base de datos.

---

## Pagos (MON-003) — poner Stripe en marcha

QRACKS cobra por el software. No custodia ni reparte premios, y nunca ve ni
guarda un número de tarjeta: el cobro ocurre en el checkout hospedado de Stripe.

### Lo que hace falta en el entorno

Tres variables, y **las tres juntas**. Con sólo algunas, el producto podría
iniciar un cobro que después no sabría verificar, así que los pagos se quedan
apagados hasta que estén las tres:

| Variable | De dónde sale |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → *Secret key* |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → el endpoint → *Signing secret* |
| `PUBLIC_BASE_URL` | El origen público del servicio, p. ej. `https://qracks.net` |

Se configuran en Render (Environment). **Nunca en el repositorio**, nunca en un
issue, nunca pegadas en un chat.

### Alta del webhook en Stripe

1. Stripe → Developers → Webhooks → *Add endpoint*.
2. URL: `https://<tu-dominio>/api/payments/stripe/webhook`
3. Eventos a enviar — sólo estos, y ninguno más:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded` *(sólo auditoría)*
   - `charge.dispute.created` *(sólo auditoría)*
4. Copia el *Signing secret* a `STRIPE_WEBHOOK_SECRET` y reinicia el servicio.

Empieza en **Test mode**, comprueba una compra de punta a punta con una tarjeta
de prueba de Stripe, y sólo después cambia a las claves de producción. Las
claves de test y las de producción tienen webhooks distintos: al cambiar unas,
hay que cambiar el otro.

### Comprobar que está vivo

- El precio se lee de `commercial_config`, no del código. Cambiarlo en Panel
  Plataforma cambia lo que se cobra en el siguiente checkout; las compras ya
  hechas conservan lo que pagaron.
- Con las variables ausentes, "Pasar a Plus" dice que el pago con tarjeta no
  está disponible y deja la vía manual. Eso es lo correcto, no un fallo.

### Qué mirar cuando algo va mal

En los logs, sin secretos (nunca se escribe ninguna clave):

| Mensaje | Significa |
|---|---|
| `payments checkout_created` | se abrió un checkout |
| `payments checkout_reused` | un segundo intento reutilizó el anterior, no se duplicó |
| `payments checkout_creation_failed` | no se pudo crear; el `code` dice por qué |
| `payments webhook_invalid_signature` | llegó algo que no venía de Stripe, o el signing secret no coincide |
| `payments webhook_processed` | evento evaluado; `decision` dice qué se hizo |
| `payments reconciled` | un pago se recuperó sin webhook, al volver el Admin |
| `payments payment_requires_attention` | hay un cobro que un humano tiene que mirar |

Un `webhook_processed` con `decision: "stale_scope"` significa que alguien pagó
un torneo que ya terminó: **el cobro es real y el plan no se otorgó**. Hay que
decidir a mano (devolver o trasladar); el producto no lo hace solo a propósito.

Lo mismo con `charge.refunded` y `charge.dispute.created`: se registran y se
marcan, pero **no revocan Plus automáticamente**. La política de revocación es
una decisión comercial que todavía no está tomada.

Las compras y su auditoría viven en la fila `platform_payment_intents`, que sólo
se puede leer con la contraseña de plataforma.
