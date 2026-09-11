// paymentsDomain.js — MON-003: el dominio de pagos de QRACKS.
//
// Aquí NO hay Stripe. Ni un nombre de campo, ni un estado, ni un evento suyo.
// Stripe es la primera implementación, no el dominio: cuando entre Mercado
// Pago, este archivo no se toca y el adaptador nuevo traduce a estas mismas
// palabras — purchase intent, amount, currency, scope, status.
//
// Módulo puro: sin I/O, sin red, sin reloj. Todo lo que decide seguridad se
// puede probar sin una pasarela delante.
//
// ==========================================================================
// LAS DOS DIMENSIONES DE UN PAGO, deliberadamente separadas:
//
//   STATUS     — el estado ECONÓMICO. Monótono: una vez cobrado, nada lo
//                degrada. Es lo único que puede autorizar un entitlement.
//
//   ATTENTION  — una anomalía que un humano tiene que mirar (un reembolso, un
//                importe que no cuadra, un pago que llegó para un torneo que
//                ya terminó). Es ortogonal al status a propósito: marcar
//                "requires_attention" COMO status obligaría a elegir entre
//                "se cobró" y "hay un problema", y las dos cosas son ciertas
//                a la vez. Un pago cobrado con anomalía sigue estando
//                cobrado; lo que no puede es otorgar nada.
// ==========================================================================

const PURCHASE_STATUS = Object.freeze({
  CREATED: "created",
  PAID: "paid",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
});

// El orden importa y es lo que hace el estado monótono. Un evento viejo que
// llega tarde —Stripe reintenta y puede entregar fuera de orden— no puede
// bajar un pago confirmado a "expirado".
const STATUS_RANK = Object.freeze({
  [PURCHASE_STATUS.CREATED]: 0,
  [PURCHASE_STATUS.CANCELLED]: 1,
  [PURCHASE_STATUS.EXPIRED]: 1,
  [PURCHASE_STATUS.FAILED]: 1,
  [PURCHASE_STATUS.PAID]: 2,
});

const ATTENTION = Object.freeze({
  AMOUNT_MISMATCH: "amount_mismatch",
  CURRENCY_MISMATCH: "currency_mismatch",
  IDENTITY_MISMATCH: "provider_identity_mismatch",
  STALE_SCOPE: "paid_for_a_finished_tournament",
  REFUNDED: "refunded",
  DISPUTED: "disputed",
});

// Qué hacer con una confirmación. Un solo enum para las dos rutas que pueden
// confirmar un pago (webhook y reconciliación), así no pueden divergir.
const DECISION = Object.freeze({
  CONFIRM: "confirm",                     // cobrar y otorgar PLUS
  REPLAY_EVENT: "replay_event",           // este evento ya se procesó
  ALREADY_PAID: "already_paid",           // este pago ya se confirmó
  UNKNOWN_PURCHASE: "unknown_purchase",   // no hay intent que corresponda
  NOT_PAID: "not_paid",                   // el proveedor no dice que se pagó
  AMOUNT_MISMATCH: "amount_mismatch",
  CURRENCY_MISMATCH: "currency_mismatch",
  IDENTITY_MISMATCH: "identity_mismatch",
  STALE_SCOPE: "stale_scope",             // se pagó, pero para otro torneo
  IGNORED_STALE: "ignored_stale_event",   // evento viejo que no puede degradar
});

function isSafeCount(n) { return Number.isSafeInteger(n) && n >= 0; }
function str(v) { return v == null || v === "" ? null : String(v); }

// ---- importes -------------------------------------------------------------
//
// El dominio trabaja SIEMPRE en unidades mínimas enteras (centavos). Los
// flotantes no entran: 199.99 * 100 no es 19999 en coma flotante, y un importe
// que se compara mal es un pago que se rechaza o se acepta por la razón
// equivocada. `commercial_config` guarda pesos, así que la conversión ocurre
// una vez, aquí, y se valida.
function toMinorUnits(majorAmount) {
  if (!Number.isFinite(majorAmount) || majorAmount < 0) return null;
  const minor = Math.round(majorAmount * 100);
  if (!Number.isSafeInteger(minor)) return null;
  // Un céntimo de diferencia entre lo redondeado y lo original significa que
  // llegó algo con más de dos decimales: no es un precio, es un error.
  if (Math.abs(majorAmount * 100 - minor) > 1e-6) return null;
  return minor;
}

// Sólo MXN en V1. Se declara como lista y no como constante suelta para que
// añadir una moneda sea un cambio visible y no un descuido.
const SUPPORTED_CURRENCIES = Object.freeze(["mxn"]);
function normalizeCurrency(value) {
  const c = typeof value === "string" ? value.trim().toLowerCase() : null;
  return c && SUPPORTED_CURRENCIES.includes(c) ? c : null;
}

// ---- el purchase intent ---------------------------------------------------
//
// Identidad durable propiedad del SERVIDOR. Nunca es sólo el slug: un slug no
// distingue dos intentos de compra, ni dos torneos, ni un reintento de una
// compra nueva. Todo lo comercial —importe, moneda, torneo, versión de
// configuración— se congela aquí en el momento de crearlo, y es esto, no el
// navegador ni el proveedor, lo que manda al confirmar.
function makePurchaseIntent({
  purchaseId, slug, scopeId, configVersion, expectedAmountMinor, currency,
  provider, now,
}) {
  if (!str(purchaseId) || !str(slug) || !str(scopeId)) return null;
  if (!isSafeCount(expectedAmountMinor) || expectedAmountMinor <= 0) return null;
  const cur = normalizeCurrency(currency);
  if (!cur) return null;
  if (!str(provider)) return null;
  const at = now || new Date().toISOString();
  return {
    id: String(purchaseId),
    slug: String(slug),
    // El torneo que se está comprando, congelado. Si el Admin inicia otro
    // ciclo antes de que llegue la confirmación, este id sigue siendo el del
    // torneo por el que pagó — que es exactamente lo que permite detectarlo.
    scopeId: String(scopeId),
    configVersion: Number.isFinite(configVersion) ? configVersion : null,
    expectedAmountMinor,
    currency: cur,
    provider: String(provider),
    providerSessionId: null,
    providerPaymentIntentId: null,
    // La URL del checkout hospedado. Guardarla es lo que hace que un segundo
    // tap no cueste ni una llamada de red: se devuelve la misma.
    providerCheckoutUrl: null,
    status: PURCHASE_STATUS.CREATED,
    attention: null,
    createdAt: at,
    updatedAt: at,
    confirmedAt: null,
  };
}

// ¿Puede este pago avanzar a ese estado? La respuesta es "sí" sólo si sube de
// rango. Nunca hacia atrás, y nunca lateralmente entre dos estados fallidos
// (que reescribiría "expiró" por "se canceló" sin ganar nada).
function canAdvance(fromStatus, toStatus) {
  const from = STATUS_RANK[fromStatus];
  const to = STATUS_RANK[toStatus];
  if (from == null || to == null) return false;
  return to > from;
}

// Un intent reutilizable es uno que todavía puede acabar en un pago. Es lo que
// impide que dos taps, dos pestañas o una respuesta perdida creen dos compras:
// el segundo intento se encuentra con el primero y lo reutiliza.
// Deliberadamente NO exige que ya tenga sesión del proveedor: un intent que se
// creó y cuya llamada al proveedor se perdió a medias es justo el que hay que
// reutilizar. Reutilizarlo hace que el reintento lleve la MISMA clave de
// idempotencia al proveedor, y por tanto que devuelva la sesión que ya existía
// en vez de crear una segunda.
function isReusableIntent(intent, nowMs, maxAgeMs) {
  if (!intent || intent.status !== PURCHASE_STATUS.CREATED) return false;
  const created = Date.parse(intent.createdAt);
  if (!Number.isFinite(created)) return false;
  const age = nowMs - created;
  if (!Number.isFinite(age) || age < 0) return false;
  return age < maxAgeMs;
}

// El intent vivo de un scope: el que un segundo clic debe reutilizar en vez de
// duplicar. Se busca por scope y no por slug, porque una compra pertenece a un
// torneo concreto y la del torneo anterior no sirve para éste.
function findReusableIntent(purchases, slug, scopeId, nowMs, maxAgeMs) {
  const list = Array.isArray(purchases) ? purchases : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p || p.slug !== slug || p.scopeId !== scopeId) continue;
    if (isReusableIntent(p, nowMs, maxAgeMs)) return p;
  }
  return null;
}

// ¿Este scope ya tiene una compra confirmada? Comprar dos veces el mismo
// torneo no es una venta, es un cobro doble.
function findPaidIntentForScope(purchases, slug, scopeId) {
  const list = Array.isArray(purchases) ? purchases : [];
  return list.find((p) => p && p.slug === slug && p.scopeId === scopeId
    && p.status === PURCHASE_STATUS.PAID) || null;
}

function findIntentById(purchases, purchaseId) {
  const id = str(purchaseId);
  if (!id) return null;
  return (Array.isArray(purchases) ? purchases : []).find((p) => p && p.id === id) || null;
}

// Localiza el intent al que pertenece lo que observó el proveedor.
//
// El id interno viene de la metadata del proveedor, y la metadata NO es
// autoridad por sí sola: es una pista para encontrar el registro durable, y el
// registro es quien decide. Por eso, cuando la pista existe, se comprueba
// ADEMÁS que la identidad del proveedor coincida; y cuando no existe, se busca
// por la identidad del proveedor, que sí escribimos nosotros al crear.
function locateIntent(purchases, observed) {
  const o = observed || {};
  const byId = findIntentById(purchases, o.purchaseId);
  if (byId) return byId;
  const list = Array.isArray(purchases) ? purchases : [];
  const sid = str(o.sessionId);
  if (sid) {
    const bySession = list.find((p) => p && p.providerSessionId === sid);
    if (bySession) return bySession;
  }
  const pid = str(o.paymentIntentId);
  if (pid) {
    const byPayment = list.find((p) => p && p.providerPaymentIntentId === pid);
    if (byPayment) return byPayment;
  }
  return null;
}

// ---- la decisión ----------------------------------------------------------
//
// La única función que dice si un pago otorga PLUS, y la usan las DOS rutas
// que pueden confirmar (webhook y reconciliación). Tenerla una sola vez es lo
// que impide que una de las dos sea más laxa que la otra.
//
// `observed` es lo que el adaptador tradujo del proveedor, ya en vocabulario
// de QRACKS: { purchaseId, sessionId, paymentIntentId, paid, amountMinor,
// currency, terminalStatus }.
//
// `currentScopeId` se lee de la fila bloqueada, nunca del proveedor ni del
// navegador.
function evaluateConfirmation({ intent, observed, currentScopeId }) {
  const o = observed || {};
  if (!intent) return { decision: DECISION.UNKNOWN_PURCHASE };

  // La metadata dijo un intent y la identidad del proveedor apunta a otro. No
  // se elige uno: no se otorga nada. Es la forma exacta que tendría un intento
  // de reutilizar un pago ajeno.
  const sid = str(o.sessionId);
  const pid = str(o.paymentIntentId);
  if (sid && intent.providerSessionId && sid !== intent.providerSessionId) {
    return { decision: DECISION.IDENTITY_MISMATCH, attention: ATTENTION.IDENTITY_MISMATCH };
  }
  if (pid && intent.providerPaymentIntentId && pid !== intent.providerPaymentIntentId) {
    return { decision: DECISION.IDENTITY_MISMATCH, attention: ATTENTION.IDENTITY_MISMATCH };
  }

  if (o.paid !== true) {
    // No se pagó (todavía, o nunca). Sólo puede registrar un estado terminal,
    // y sólo si eso es AVANZAR: un "expiró" que llega después del cobro no
    // deshace el cobro.
    const terminal = o.terminalStatus;
    if (terminal && canAdvance(intent.status, terminal)) {
      return { decision: DECISION.NOT_PAID, nextStatus: terminal };
    }
    if (intent.status === PURCHASE_STATUS.PAID) {
      return { decision: DECISION.IGNORED_STALE };
    }
    return { decision: DECISION.NOT_PAID };
  }

  // A partir de aquí el proveedor afirma que se cobró. Antes de creerle sobre
  // CUÁNTO, se compara con lo que congelamos al crear la compra. Si el importe
  // no cuadra, no hay decisión buena posible: falla cerrado y lo marca.
  if (!isSafeCount(o.amountMinor) || o.amountMinor !== intent.expectedAmountMinor) {
    return { decision: DECISION.AMOUNT_MISMATCH, attention: ATTENTION.AMOUNT_MISMATCH };
  }
  if (normalizeCurrency(o.currency) !== intent.currency) {
    return { decision: DECISION.CURRENCY_MISMATCH, attention: ATTENTION.CURRENCY_MISMATCH };
  }

  // Ya estaba confirmado. N entregas del mismo pago producen UN entitlement:
  // ésta es la barrera que lo garantiza aunque la deduplicación por evento no
  // llegue a tiempo (dos entregas concurrentes, un id de evento nuevo para el
  // mismo pago, una reconciliación que corre a la vez que el webhook).
  if (intent.status === PURCHASE_STATUS.PAID) {
    return { decision: DECISION.ALREADY_PAID };
  }

  // Se cobró de verdad, pero el torneo que se compró ya no es el que se juega.
  // El dinero existe y se registra; el entitlement NO se otorga, porque
  // otorgarlo aquí sería habilitar un torneo que nadie compró. Queda marcado
  // para que un humano decida (reembolso, traslado), que es una decisión
  // comercial y no del código.
  if (str(currentScopeId) && intent.scopeId !== str(currentScopeId)) {
    return {
      decision: DECISION.STALE_SCOPE, nextStatus: PURCHASE_STATUS.PAID,
      attention: ATTENTION.STALE_SCOPE,
    };
  }

  return { decision: DECISION.CONFIRM, nextStatus: PURCHASE_STATUS.PAID };
}

// Aplica una decisión sobre el intent y devuelve uno NUEVO. No muta la
// entrada: el llamador decide si persiste el resultado, y sólo dentro de su
// transacción.
function applyDecision(intent, decision, observed, now) {
  const at = now || new Date().toISOString();
  const o = observed || {};
  const next = { ...intent, updatedAt: at };
  // La identidad del proveedor se ADJUNTA cuando aparece por primera vez —un
  // PaymentIntent no existe hasta que hay un pago— pero nunca se reescribe:
  // cambiarla convertiría este registro en el de otro pago.
  if (!next.providerSessionId && str(o.sessionId)) next.providerSessionId = str(o.sessionId);
  if (!next.providerPaymentIntentId && str(o.paymentIntentId)) {
    next.providerPaymentIntentId = str(o.paymentIntentId);
  }
  if (decision.attention) {
    next.attention = { code: decision.attention, at, detail: decision.detail || null };
  }
  if (decision.nextStatus && canAdvance(next.status, decision.nextStatus)) {
    next.status = decision.nextStatus;
    if (decision.nextStatus === PURCHASE_STATUS.PAID) next.confirmedAt = at;
  }
  return next;
}

// ---- deduplicación por evento --------------------------------------------
//
// La primera barrera contra las reentregas. La segunda —y la que de verdad
// garantiza un solo entitlement— es ALREADY_PAID de arriba: ésta es una
// optimización honesta, no la garantía, porque la lista se acota.
const MAX_SEEN_EVENTS = 500;

function hasSeenEvent(seen, eventId) {
  const id = str(eventId);
  if (!id) return false;
  return (Array.isArray(seen) ? seen : []).some((e) => e && e.id === id);
}

function rememberEvent(seen, eventId, now) {
  const id = str(eventId);
  if (!id) return Array.isArray(seen) ? seen : [];
  const list = (Array.isArray(seen) ? seen : []).filter((e) => e && e.id !== id);
  list.push({ id, at: now || new Date().toISOString() });
  // Acotada a propósito: sin límite, esta fila crece para siempre. Con límite,
  // una reentrega MUY tardía podría pasar el filtro — y por eso la garantía
  // real vive en el estado del pago, no aquí.
  return list.length > MAX_SEEN_EVENTS ? list.slice(list.length - MAX_SEEN_EVENTS) : list;
}

// ---- la entrada de auditoría ---------------------------------------------
//
// Lo que hay que poder responder meses después sin abrir el panel del
// proveedor: qué quiniela, qué torneo, cuánto, en qué moneda, cuándo, con qué
// proveedor, contra qué identidad suya, en qué estado quedó y si otorgó plan.
function buildPaymentAudit(intent, decision, entitlementResult, now) {
  return {
    purchaseId: intent.id,
    slug: intent.slug,
    scopeId: intent.scopeId,
    amountMinor: intent.expectedAmountMinor,
    currency: intent.currency,
    provider: intent.provider,
    providerSessionId: intent.providerSessionId || null,
    providerPaymentIntentId: intent.providerPaymentIntentId || null,
    status: intent.status,
    decision,
    entitlement: entitlementResult || "none",
    attention: intent.attention ? intent.attention.code : null,
    at: now || new Date().toISOString(),
  };
}

module.exports = {
  PURCHASE_STATUS, STATUS_RANK, ATTENTION, DECISION, SUPPORTED_CURRENCIES,
  MAX_SEEN_EVENTS,
  toMinorUnits, normalizeCurrency,
  makePurchaseIntent, canAdvance, isReusableIntent, findReusableIntent,
  findPaidIntentForScope, findIntentById, locateIntent,
  evaluateConfirmation, applyDecision,
  hasSeenEvent, rememberEvent, buildPaymentAudit,
};
