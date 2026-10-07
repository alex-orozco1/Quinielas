# Pagos: Plus con Stripe

Contrastado con `main` en `4e5cbec`. MON-003: el organizador compra Plus para el torneo de su quiniela con tarjeta, en Stripe Checkout.

**QRACKS cobra por el software. No administra premios ni cuotas de los participantes:** esas cuotas las registra el admin a mano.

**Fuentes de verdad:**
- `payments/stripeAdapter.js`: la frontera con Stripe. Firma, normalización de eventos, readiness y llamadas REST, sin SDK.
- `payments/paymentsDomain.js`: decisiones puras, estados, idempotencia y auditoría.
- `server.js`: rutas, `openPurchase`, `confirmPaymentAndGrant` y la reconciliación.

**Operación** (variables, alta del webhook, logs, qué hacer con cada alerta): [OPERATIONS.md](../OPERATIONS.md).

## 1. Reglas que no se negocian

- La **Secret Key** y el **webhook signing secret** viven sólo en el entorno del servidor. Nunca llegan al navegador, a un log ni al repositorio.
- **Plus se concede por dos caminos, ambos en el servidor:**
  - **compra con tarjeta**, que se concede sólo tras verificar el pago contra Stripe (§3 y §4);
  - **la plataforma, desde su panel** («Activar Plus»). Esto apunta en el libro de pagos un cobro del precio vigente, recibido fuera de Stripe (§6).
- La URL de vuelta (`success_url`), un parámetro del navegador o la metadata del evento **nunca** conceden Plus por sí solos.
- **El cliente no decide** importe, moneda ni estado. El importe sale de `commercial_config` (`plus.priceMXN`) en el servidor y se congela en la compra.
- **No se guardan tarjetas:** las maneja Stripe.
- Los errores se devuelven sanitizados. El libro de pagos y la auditoría sólo los ve la plataforma.
- **`MANUAL_GRANT` no se elimina:** es la concesión manual del operador (§6).

## 2. Configuración y estados de readiness

Tres variables, **las tres o ninguna**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` y `PUBLIC_BASE_URL`.

`PUBLIC_BASE_URL` es sólo un origen: sin ruta, sin parámetros y sin credenciales. Admite `http` sólo para `localhost`, y con clave `live` exige https público.

| Estado | Cuándo | Efecto |
|---|---|---|
| `READY` | Las tres, válidas | Checkout disponible. |
| `DISABLED` | Ninguna | Pagos apagados a propósito. La oferta de Plus muestra el contacto de respaldo de `commercial_config`. |
| `MISCONFIGURED` | Algunas, o con valores inválidos | **Falla cerrado:** sin checkout, y el webhook responde 503. |

- El servidor registra el estado al arrancar (`payments_readiness`, sin secretos).
- La plataforma lo consulta en `GET /api/platform/payments-readiness`.

## 3. Comprar: `POST /api/quinielas/:slug/checkout`

Lo pide un admin o el dueño de la quiniela (si no, 403), con límite de ritmo propio.

**Sólo una quiniela en Free puede comprar.** Con Plus, `MANUAL_GRANT` o el plan heredado (`GRANDFATHERED`) responde `409 already_on_plan`.

1. **Bajo candado** (`openPurchase`), el servidor comprueba:
   - qué compra Plus para **el torneo actual** de esa quiniela;
   - si ya hay una compra abierta o pagada para ese mismo torneo.
2. **Hay una sola sesión cobrable por torneo:**
   - Si existe una sesión reciente y vigente, se reutiliza: 10 min por el camino rápido y hasta 20 h de ventana de reutilización.
   - Reemplazar una sesión toma un reclamo con 90 s de vida, para que dos pestañas no creen dos sesiones.
   - Cada compra admite como máximo 24 intentos de creación. Al pasarse, se detiene, registra `checkout_attempts_exhausted` y el navegador recibe `502 checkout_unavailable`.
3. **Crea la sesión de Checkout** en Stripe con la cabecera `Idempotency-Key: checkout:<purchaseId>:<n>`. Si se repite el mismo intento, Stripe devuelve la misma sesión.
4. **Las URLs de vuelta:**
   - éxito: `/a/<slug>?qz_pago=<purchaseId>&qz_sess={CHECKOUT_SESSION_ID}`;
   - cancelación: `/a/<slug>?qz_pago_cancelado=1`.

**El navegador nunca da por hecho el pago.** Al volver consulta `GET /api/quinielas/:slug/checkout/:purchaseId`, y la pantalla sólo dice «Pago completado» cuando el servidor confirmó esa compra.

## 4. Confirmar: webhook y reconciliación

**Webhook:** `POST /api/payments/stripe/webhook`.
- Usa `express.raw` y la firma se verifica sobre **el cuerpo crudo** (`verifyWebhookSignature`):
  - HMAC sobre `t.cuerpo`, comparado en tiempo constante;
  - admite varias firmas `v1`, para rotar el secreto;
  - tolerancia de 300 s hacia atrás;
  - rechaza un cuerpo ya parseado.
- Si la firma no es válida responde `400 invalid_signature` y no hace nada.

**Eventos:**

| Evento | Qué hace |
|---|---|
| `checkout.session.completed` | Confirma, si `payment_status` es `paid`. |
| `checkout.session.async_payment_succeeded` | Confirma. |
| `checkout.session.async_payment_failed` | Marca la compra como fallida. |
| `checkout.session.expired` | Marca la compra como expirada. |
| `charge.refunded`, `charge.dispute.created` | **Sólo auditoría y alerta.** No revocan Plus. |
| Cualquier otro | `200 {handled:false}` |

**Qué cuenta como dinero:** sólo `payment_status === "paid"`.

**Un solo camino concede Plus:** `confirmPaymentAndGrant`, el mismo para el webhook y la reconciliación.

1. **Comprueba**, en este orden:
   - la compra no fue sustituida;
   - la identidad de la sesión, que debe ser la que la compra registró;
   - que esté pagada y no en estado terminal;
   - el **importe** y la **moneda** esperados;
   - que no esté ya pagada (`ALREADY_PAID`, contra el cobro doble);
   - que la quiniela exista;
   - que el torneo siga siendo el mismo (scope);
   - que la foto de la oferta (`snapshot`) sea válida.
2. **Si todo cuadra:**
   - escribe Plus para ese torneo (`source: stripe_purchase`);
   - apunta el pago en `platform_payment_log`;
   - deja la compra en `paid`.

**Idempotencia:**
- Los eventos ya procesados se recuerdan; se guardan los últimos 500 (`seenEvents`).
- El estado de una compra sólo avanza (`created → paid / failed / cancelled / expired`), nunca retrocede.
- El grant se identifica por la compra, así que repetir la confirmación no concede dos veces.

**Reconciliación.** Cubre el caso en que el webhook no llegó. `GET …/checkout/:purchaseId`, al que el navegador llama al volver:
- busca la sesión de esa compra, con la pista `qz_sess` o listando las sesiones recientes;
- si encuentra un pago, confirma por `confirmPaymentAndGrant`;
- si hay varias sesiones, las ordena y las marca.

## 5. Recuperación de fallos

| Situación | Qué pasa |
|---|---|
| Pagos no `READY` cuando llega un webhook | `503`, y Stripe reintenta. |
| Pago cobrado pero no aplicado (error al escribir Plus) | La transacción se deshace, se registra `payments payment_requires_attention` con el error y el webhook responde `500 unapplied_payment`, así que Stripe reintenta. Si falla la base, responde `500 server_error`. |
| El webhook nunca llega | La reconciliación al volver al sitio confirma la compra. |
| Discrepancia: importe, moneda, identidad, torneo viejo, quiniela inexistente, foto de la oferta (snapshot) inválida, varias sesiones, reembolso o disputa | **No se concede nada automáticamente.** Queda en la decisión del webhook y en la auditoría de la compra, para que el operador decida. Los valores exactos que aparecen en el log y en la auditoría (por ejemplo `stale_scope` o `paid_for_a_finished_tournament`) y qué hacer con cada uno están en [OPERATIONS.md](../OPERATIONS.md) §7. |

## 6. Plus desde el panel y concesión manual

**«Activar Plus» desde el panel de plataforma** (`POST /api/platform/quinielas/:slug/entitlement` con `plan: PLUS`):
- concede Plus para el torneo actual (`source: platform_grant`);
- apunta en `platform_payment_log` un cobro del precio vigente. Es para pagos recibidos fuera de Stripe.

**Concesión manual (`MANUAL_GRANT`)**

El operador la da desde el panel de plataforma (`POST /api/platform/quinielas/:slug/entitlement`) para casos especiales.
- Lleva límites propios, entre 1 y 100 000 personas y jornadas, y un **motivo obligatorio**.
- Nunca registra dinero.
- Se conserva al empezar un ciclo nuevo del torneo.
- Mientras está activa, la quiniela no puede comprar con tarjeta: el checkout responde `409 already_on_plan`.
- En pantalla se llama «Especial».

## 7. Señales abiertas

Las verificó Technical QA el 2026-10-07. No se corrigen en este sprint, que es sólo de documentación; se reportaron al Founder para decidir su corrección.

- **Plus del panel revocado y pago posterior.** CONFIRMED con las funciones puras, sin Stripe. Es P0 por el peor caso, que es un cobro incorrecto.
  - La secuencia: la plataforma activa Plus desde el panel, y en el mismo torneo regresa la quiniela a Gratis.
  - Después, el checkout deja pagar con tarjeta. Al confirmar, se reactiva el Plus del panel y el cargo de Stripe **no queda en el libro de pagos**.
  - Así, un torneo que el sistema ya daba por pagado puede cobrarse dos veces.
  - Con `MANUAL_GRANT` no pasa.
  - Mientras no se corrija, **evita esa secuencia**: si hay que deshacer un Plus del panel, no esperes un pago con tarjeta en ese torneo.
- **Libro de pagos escribible.** CONFIRMED en local, P2.
  - Con la contraseña de plataforma, `POST` y `DELETE /api/kv/platform_payment_log` reescriben o borran el libro.
  - `platform_payment_intents`, en cambio, sólo la escribe el servidor.
  - Ninguna pantalla escribe el libro.

## 8. Cómo se prueba

- `test/stripePayments.test.js` (unos 180 tests), `test/paymentsReadiness.test.js` y `test/paymentConfirmation.test.js` prueban el dominio y el adaptador **sin llamar a Stripe**.
- Una prueba con dinero, aunque sea en modo `test`, requiere autorización explícita del Founder.
