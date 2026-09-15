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
  // Se cobró y la quiniela ya no existe. Tiene su propio código porque no es
  // ninguna de las otras cosas: no es una identidad que no cuadra, ni un
  // importe raro, ni un torneo viejo. Reutilizar otro código habría descrito
  // mal el problema al único lector que importa, que es una persona mirando
  // por qué hay dinero sin contrapartida.
  QUINIELA_MISSING: "paid_for_a_deleted_quiniela",
  // El purchase intent no lleva el snapshot de lo que se vendió, así que no se
  // puede reconstruir PLUS sin inventarlo. Falla cerrado y pide una persona.
  SNAPSHOT_UNUSABLE: "purchase_snapshot_unusable",
  // La quiniela existe, pero no se puede leer a qué torneo está jugando ahora.
  // Sin eso no se puede demostrar que el plan vaya al torneo que se compró.
  // Tiene su propio código: no es un torneo VIEJO, es un torneo ILEGIBLE.
  SCOPE_UNPROVEN: "current_tournament_unreadable",
  // El proveedor tiene VARIAS sesiones para UNA sola compra. El invariant es "un
  // objeto cobrable por quiniela y torneo", así que esto es material aunque
  // acabe curándose: significa que en algún momento salieron dos peticiones de
  // creación para la misma compra.
  MANY_SESSIONS: "several_provider_checkouts_for_one_purchase",
  // Más de una sesión del torneo consta usada y UNA de ellas cobró. No es un
  // cargo doble —sólo hay un cobro declarado— pero tampoco se puede vender nada
  // más: el dinero ya entró por una puerta.
  USED_BESIDE_PAID: "another_checkout_was_used_beside_a_paid_one",
  // Dos sesiones del mismo torneo constan COMPLETADAS, pero el proveedor no
  // afirma que ninguna haya cobrado. No es un cargo doble —no hay dinero
  // declarado— y tampoco es normal: pide una persona sin inventar una cifra.
  TWO_SESSIONS_USED_UNPAID: "two_checkouts_were_used_without_reported_payment",
  // Esta compra se retiró porque otra del mismo torneo es la que sigue activa.
  // NO hubo pago: decirlo así sería escribir historia financiera falsa.
  RETIRED_FOR_ACTIVE_SIBLING: "retired_because_another_checkout_is_the_active_one",
  // Había varias compras abiertas para el mismo torneo y al menos una no se
  // pudo clasificar. Tiene su propio código porque describe un riesgo distinto
  // de todos los demás: aquí no hay dinero mal aplicado, hay una capacidad de
  // cobro que no se ha podido descartar. Pide una persona ANTES de que alguien
  // pague dos veces, no después.
  OPEN_SET_UNRESOLVED: "open_checkout_could_not_be_resolved",
  // Dos compras del mismo torneo llegaron a cobrar. Eso ya es un cargo doble:
  // no hay nada que prevenir, hay algo que devolver.
  DOUBLE_CHARGE: "two_checkouts_were_paid_for_one_tournament",
  // Esta compra se retiró porque OTRA del mismo torneo ya cobró. No es "una más
  // nueva la sustituyó": es que el dinero entró por otra puerta. Con su propio
  // código porque, si algún día llegara un cobro sobre ésta, quien lo lea tiene
  // que saber que había un pago hermano, no un reemplazo rutinario.
  RETIRED_FOR_PAID_SIBLING: "retired_because_another_checkout_was_paid",
  // Esta compra se sustituyó por otra: su sesión quedó inutilizada a propósito.
  SUPERSEDED: "superseded_by_a_newer_checkout",
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
  // Se pagó y no hay a quién otorgárselo. El dinero se registra; no hay plan.
  QUINIELA_MISSING: "quiniela_missing",
  // Se pagó y no se puede saber QUÉ se vendió. No se otorga nada inventado.
  SNAPSHOT_UNUSABLE: "snapshot_unusable",
  // Se pagó y no se puede leer el torneo actual: no hay forma de demostrar que
  // el plan iría al torneo correcto.
  SCOPE_UNPROVEN: "scope_unproven",
  // Llegó un pago para una compra que SUSTITUIMOS a propósito. No otorga nada.
  SUPERSEDED_PURCHASE: "superseded_purchase",
});

function isSafeCount(n) { return Number.isSafeInteger(n) && n >= 0; }
function str(v) { return v == null || v === "" ? null : String(v); }
// Un identificador de torneo LEGIBLE.
//
// Un scope id es SIEMPRE una cadena no vacía (tournamentScope.js las produce con
// forma "ts:1:..."). Cualquier otra cosa —0, false, NaN, un objeto, sólo
// espacios— no es "otro torneo": es un torneo que no se puede leer, y la
// diferencia importa porque son dos anotaciones distintas para la persona que
// acabe mirando por qué un cobro no otorgó nada. Coaccionar con String() hacía
// que un 0 se leyera como el torneo "0" y se anotara como torneo VIEJO.
function readableScope(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

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

// ---- ¿puede esta sesión del proveedor seguir cobrando? --------------------
//
// Correction 02. Hacer idempotente un purchase intent no impide DOS CARGOS: lo
// que impide dos cargos es que no exista más de un objeto del proveedor capaz
// de aceptar dinero para el mismo torneo. La ventana de reutilización interna
// (CHECKOUT_REUSE_WINDOW_MS) es contabilidad NUESTRA y no tiene por qué
// coincidir con el ciclo de vida real de la sesión allá: un intent que para
// nosotros caducó puede seguir perfectamente cobrable en el proveedor.
//
// Así que el estado de una sesión no se deduce del reloj: se pregunta.
const SESSION_STATE = Object.freeze({
  CHARGEABLE: "chargeable",   // puede aceptar dinero AHORA
  USED: "used",               // ya se usó; hay o habrá un pago
  DEAD: "dead",               // no puede aceptar dinero nunca más
  UNKNOWN: "unknown",         // no se pudo averiguar -> se trata como cobrable
});

// Desconocido cuenta como COBRABLE, no como muerto. Es la diferencia entre
// fallar cerrado y cobrar dos veces.
function sessionStateOf(observed) {
  const o = observed || {};
  if (o.paid === true) return SESSION_STATE.USED;
  switch (o.lifecycle) {
    case "chargeable": return SESSION_STATE.CHARGEABLE;
    case "used": return SESSION_STATE.USED;
    case "dead": return SESSION_STATE.DEAD;
    default: return SESSION_STATE.UNKNOWN;
  }
}

// Las compras ABIERTAS de este torneo: las que todavía no son terminales.
//
// Correction 03. Antes esto exigía `providerSessionId`, y ahí estaba el agujero:
// "no tengo guardado el id de la sesión" NO significa "no existe una sesión en
// el proveedor". Si se envió la creación y la respuesta se perdió —o el proceso
// murió entre que el proveedor la creó y que nosotros la guardáramos— allá hay
// una sesión cobrable que aquí era INVISIBLE, y el reintento abría otra.
//
// La barrera durable es la EXISTENCIA de una compra abierta, no lo que sepamos
// de ella. Una compra abierta se REANUDA con su propia clave de idempotencia,
// nunca se sustituye por otra hasta demostrarla terminal.
//
// Se busca por scope, no por slug, porque el invariant es por torneo. Y no se
// filtra por antigüedad: la edad es contabilidad nuestra, la capacidad de cobrar
// es del proveedor.
function openIntentsForScope(purchases, slug, scopeId) {
  return (Array.isArray(purchases) ? purchases : []).filter((p) =>
    p && p.slug === slug && p.scopeId === scopeId
    && p.status === PURCHASE_STATUS.CREATED);
}

// Qué hacer con una compra ABIERTA, una vez que se ha observado su sesión.
//
// `offerMatches` dice si lo que esa compra vende sigue siendo lo que se vende
// hoy. Función pura: la decisión no depende de la hora ni de la red.
const OPEN_INTENT = Object.freeze({
  USABLE: "usable",           // sirve tal cual: se devuelve su enlace
  MUST_EXPIRE: "must_expire", // cobrable pero vende otra cosa: hay que matarla
  USED: "used",               // ya se usó: confirmarla, no abrir otra
  DEAD: "dead",               // demostrada incobrable: se puede abrir otra
  UNRESOLVED: "unresolved",   // no se pudo demostrar nada: fail closed
});

function classifyOpenIntent(observed, offerMatches) {
  switch (sessionStateOf(observed)) {
    case SESSION_STATE.USED: return OPEN_INTENT.USED;
    case SESSION_STATE.DEAD: return OPEN_INTENT.DEAD;
    case SESSION_STATE.CHARGEABLE:
      return offerMatches ? OPEN_INTENT.USABLE : OPEN_INTENT.MUST_EXPIRE;
    default: return OPEN_INTENT.UNRESOLVED;
  }
}

// ---- ¿es ESTA sesión del proveedor la de ESTA compra? ----------------------
//
// Correction 05. Una sesión puede llegar por tres vías: la teníamos guardada, la
// encontró un listado por fecha, o la sugirió el navegador al volver del pago.
// La tercera NO es de fiar —el navegador puede escribir lo que quiera en su
// URL—, así que ninguna de las tres se acepta por su procedencia: las tres pasan
// por aquí, y aquí se comparan contra lo que congelamos al crear la compra.
//
// Función pura y exhaustiva a propósito: cada campo que NO se comprobara sería
// una forma de colar el cobro de otra persona, de otra quiniela o de otro
// importe. Devuelve el motivo del rechazo para que quede auditado.
const SESSION_MATCH = Object.freeze({
  OK: "ok",
  NO_SESSION: "no_session",
  NO_IDENTITY: "session_carries_no_purchase_id",
  OTHER_PURCHASE: "session_belongs_to_another_purchase",
  OTHER_SLUG: "session_belongs_to_another_quiniela",
  OTHER_SCOPE: "session_belongs_to_another_tournament",
  AMOUNT: "amount_does_not_match",
  CURRENCY: "currency_does_not_match",
});

function verifySessionForPurchase(intent, observed) {
  if (!intent) return { ok: false, reason: SESSION_MATCH.NO_SESSION };
  const o = observed || null;
  if (!o || typeof o !== "object") return { ok: false, reason: SESSION_MATCH.NO_SESSION };
  if (typeof o.sessionId !== "string" || !o.sessionId) {
    return { ok: false, reason: SESSION_MATCH.NO_SESSION };
  }
  // Sin identidad no hay nada que comparar. Una sesión ajena sin metadata NO
  // se adopta: se rechaza, que es lo contrario de "no consta, pues adelante".
  const claimed = str(o.purchaseId);
  if (!claimed) return { ok: false, reason: SESSION_MATCH.NO_IDENTITY };
  if (claimed !== intent.id) return { ok: false, reason: SESSION_MATCH.OTHER_PURCHASE };
  // Si los DOS portadores vienen y no coinciden entre sí, tampoco se adopta.
  const ref = str(o.clientReferenceId);
  const metaId = str(o.metadataPurchaseId);
  if (ref && metaId && ref !== metaId) return { ok: false, reason: SESSION_MATCH.OTHER_PURCHASE };
  if (str(o.slugHint) && str(o.slugHint) !== intent.slug) {
    return { ok: false, reason: SESSION_MATCH.OTHER_SLUG };
  }
  if (str(o.scopeHint) && str(o.scopeHint) !== intent.scopeId) {
    return { ok: false, reason: SESSION_MATCH.OTHER_SCOPE };
  }
  // El importe y la moneda se comparan contra lo CONGELADO, no contra la
  // configuración de hoy: es la misma regla que usa la confirmación.
  if (!Number.isSafeInteger(o.amountMinor) || o.amountMinor !== intent.expectedAmountMinor) {
    return { ok: false, reason: SESSION_MATCH.AMOUNT };
  }
  if (normalizeCurrency(o.currency) !== normalizeCurrency(intent.currency)) {
    return { ok: false, reason: SESSION_MATCH.CURRENCY };
  }
  return { ok: true, reason: SESSION_MATCH.OK };
}

// ---- los INTENTOS de creación, y las ventanas donde pudo nacer una sesión ---
//
// Correction 07. Hasta aquí había UNA marca, la del primer intento, y el
// descubrimiento buscaba sólo alrededor de ella. Eso sólo sería correcto si todas
// las sesiones posibles de una compra pudieran nacer alrededor de ese primer
// instante, y no es cierto: el primer intento puede fallar ANTES de crear nada, y
// el segundo ocurrir veintitrés horas después. La sesión de ese segundo intento
// quedaba fuera de la ventana por construcción, invisible para siempre.
//
// Así que cada intento que puede haber producido una sesión se registra, con:
//
//   at              cuándo se emitió -> acota la ventana donde buscar la suya
//   idempotencyKey  la identidad de ESE intento ante el proveedor
//   expiresAt       cuándo deja de poder cobrar la sesión de ESE intento, CONGELADO
//
// Congelar `expiresAt` por intento es lo que permite reintentar con la misma clave:
// el proveedor declara `idempotency_error` como tipo de error, y reutilizar una
// clave con parámetros distintos es la forma de provocarlo. Antes `expires_at` se
// derivaba de la fecha de la compra y, para una compra vieja, quedaba recortado al
// suelo del rango y por tanto dependía de la hora de AHORA: dos reintentos de la
// misma clave pedían instantes distintos.
//
// La lista está acotada. No se poda nunca —olvidar una ventana es perder la única
// forma de encontrar un cobro que ocurriera en ella— así que al llegar al tope se
// falla cerrado y se pide una persona. Veinticuatro intentos fallidos sobre una
// misma compra ya no son un reintento: son algo que hay que mirar.
const MAX_CREATION_ATTEMPTS = 24;

// Los intentos registrados, en forma normalizada y ordenados por fecha. Una compra
// anterior a Correction 07 sólo tiene `creationAttemptedAt`: se lee como el primer
// intento, para que su ventana siga buscándose.
function creationAttemptsOf(intent) {
  const out = [];
  const lista = (intent && Array.isArray(intent.attempts)) ? intent.attempts : [];
  for (const a of lista) {
    const at = Date.parse(a && a.at);
    if (!Number.isFinite(at)) continue;
    out.push({
      seq: isSafeCount(a.seq) ? a.seq : out.length + 1,
      at: a.at,
      atMs: at,
      idempotencyKey: str(a.idempotencyKey),
      expiresAt: Number.isSafeInteger(a.expiresAt) ? a.expiresAt : null,
    });
  }
  if (!out.length && intent && intent.creationAttemptedAt) {
    const at = Date.parse(intent.creationAttemptedAt);
    if (Number.isFinite(at)) {
      // Legado: no se conocen su clave ni su expiración, pero SÍ su ventana, que es
      // lo que hace falta para no perder su sesión.
      out.push({ seq: 1, at: intent.creationAttemptedAt, atMs: at, idempotencyKey: null, expiresAt: null, legacy: true });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
}

// ¿Sirve todavía este intento para volver a pedir con SU clave?
//
// Sólo si su expiración congelada sigue lo bastante en el futuro para ser un
// parámetro válido. Cuando deja de serlo hay que abrir otro intento — y eso es
// seguro precisamente porque la expiración ya pasó: cualquier sesión que hubiera
// nacido de este intento ya no puede cobrar, lo demuestre el descubrimiento o no.
function isAttemptReusable(attempt, nowMs, minLifetimeMs) {
  if (!attempt || !attempt.idempotencyKey || !Number.isSafeInteger(attempt.expiresAt)) return false;
  return attempt.expiresAt * 1000 - nowMs > minLifetimeMs;
}

// Las ventanas donde buscar, fusionadas. Los reintentos se agrupan, así que lo
// normal es que veinte intentos quepan en una o dos consultas.
function discoveryWindows(intent, marginMs) {
  const m = Number.isFinite(marginMs) && marginMs > 0 ? marginMs : 0;
  const crudas = creationAttemptsOf(intent)
    .map((a) => ({ from: a.atMs - m, to: a.atMs + m }))
    .sort((x, y) => x.from - y.from);
  const out = [];
  for (const w of crudas) {
    const ult = out[out.length - 1];
    if (ult && w.from <= ult.to) ult.to = Math.max(ult.to, w.to);
    else out.push({ ...w });
  }
  return out;
}

// ---- cuándo basta con la sesión que ya tenemos guardada ---------------------
//
// Correction 07. El descubrimiento sólo corría cuando NO había sesión guardada, y
// eso dejaba invisible a cualquier hermana en cuanto una se hubiera persistido
// primero. Pero listar el proveedor en cada petición normal no aporta nada: con un
// solo intento y una unicidad ya comprobada, la guardada es la única que puede
// existir.
//
// Así que la política es explícita: hace falta descubrir cuando no se sabe nada,
// cuando ya consta multiplicidad, cuando hubo más de un intento capaz de crear, o
// cuando la comprobación de unicidad no existe o quedó obsoleta.
function knownSessionIdsOf(intent) {
  const out = [];
  const uno = str(intent && intent.providerSessionId);
  if (uno) out.push(uno);
  const varios = (intent && Array.isArray(intent.providerSessionIds)) ? intent.providerSessionIds : [];
  for (const id of varios) {
    const v = str(id);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.sort();
}

function needsSessionDiscovery(intent) {
  if (!intent) return false;
  if (!str(intent.providerSessionId)) return true;
  if (knownSessionIdsOf(intent).length > 1) return true;
  const intentos = creationAttemptsOf(intent).length;
  if (intentos > 1) return true;
  const v = intent.sessionSetVerified;
  if (!v || !isSafeCount(v.attempts)) return true;
  if (v.attempts < intentos) return true;
  return false;
}

// ---- varias sesiones del proveedor para UNA sola compra --------------------
//
// Correction 06. El descubrimiento devolvía la PRIMERA sesión verificada que
// encontraba, y eso daba por supuesta la unicidad justo donde hay que
// demostrarla: si el listado sacaba primero una expirada, una hermana abierta
// —o pagada— quedaba invisible, la compra parecía muerta, y el sistema abría
// otra venta al lado de algo que podía cobrar o que ya había cobrado. El
// resultado dependía del orden del listado del proveedor.
//
// Esta función mira TODAS y dice qué se puede afirmar. Pura y sin orden: se
// ordenan los ids que devuelve.
const SESSION_SET = Object.freeze({
  DOUBLE_CHARGE: "double_charge",     // dos o más cobraron: hay algo que devolver
  PAID_WITH_OPEN: "paid_with_open",   // una cobró y algo más sigue sin estar cerrado
  PAID_ALONE: "paid_alone",           // una cobró y TODO lo demás está demostrado muerto
  CONSUMED: "consumed",               // ninguna cobró, pero alguna se consumió: no se sustituye
  MANY_LIVE: "many_live",             // dos o más pueden cobrar
  ONE_LIVE: "one_live",               // una puede cobrar y el resto está muerto
  ALL_DEAD: "all_dead",               // todas demostradas incobrables
  UNRESOLVED: "unresolved",           // hay alguna que no se pudo clasificar
  NONE: "none",                       // no había ninguna
});

function decideSessionSet(observed) {
  const list = (Array.isArray(observed) ? observed : []).filter(Boolean);
  const idOf = (o) => str(o.sessionId);
  const ids = (xs) => xs.map(idOf).filter(Boolean).sort();
  if (!list.length) {
    return { kind: SESSION_SET.NONE, paid: [], live: [], consumed: [], dead: [], unknown: [] };
  }

  // "Cobró" es SÓLO que el proveedor lo diga. Una sesión consumida sin pago
  // declarado no es dinero (la misma regla que el resto del dominio).
  const paid = list.filter((o) => o.paid === true);
  const resto = list.filter((o) => o.paid !== true);
  const live = resto.filter((o) => sessionStateOf(o) === SESSION_STATE.CHARGEABLE);
  // CONSUMIDA, no muerta. Una sesión que el proveedor da por usada pero sin pago
  // declarado no es un objeto inofensivo: un pago asíncrono iniciado antes puede
  // liquidarse después. Por eso `classifyOpenIntent` nunca la sustituye, y por eso
  // aquí NO cuenta como demostradamente muerta — meterla en el mismo cajón que
  // una expirada decía "se puede vender otra vez encima", que es falso.
  const consumed = resto.filter((o) => sessionStateOf(o) === SESSION_STATE.USED);
  const dead = resto.filter((o) => sessionStateOf(o) === SESSION_STATE.DEAD);
  const unknown = resto.filter((o) => sessionStateOf(o) === SESSION_STATE.UNKNOWN);

  const base = {
    paid: ids(paid), live: ids(live), consumed: ids(consumed),
    dead: ids(dead), unknown: ids(unknown),
  };
  if (paid.length > 1) return { kind: SESSION_SET.DOUBLE_CHARGE, ...base };
  if (paid.length === 1) {
    // Un cobro sólo está "solo" si TODO lo demás está demostrado muerto. Una viva
    // es la puerta al segundo cargo; una consumida o una desconocida son dinero
    // sin determinar. En los tres casos el invariant NO está restaurado.
    const sinCerrar = live.length + consumed.length + unknown.length;
    return { kind: sinCerrar ? SESSION_SET.PAID_WITH_OPEN : SESSION_SET.PAID_ALONE, ...base };
  }
  if (unknown.length) return { kind: SESSION_SET.UNRESOLVED, ...base };
  if (live.length > 1) return { kind: SESSION_SET.MANY_LIVE, ...base };
  if (live.length === 1) return { kind: SESSION_SET.ONE_LIVE, ...base };
  // Sin cobros, sin vivas y sin desconocidas: si alguna se consumió, no se puede
  // vender encima; si no, todas están demostradas muertas.
  if (consumed.length) return { kind: SESSION_SET.CONSUMED, ...base };
  return { kind: SESSION_SET.ALL_DEAD, ...base };
}

// ¿Qué hacer con el CONJUNTO de compras abiertas, una vez clasificadas todas?
//
// Correction 04. Antes esto se decidía dentro del bucle, con un `return` en
// cuanto una compra daba USED, USABLE o UNRESOLVED — y lo que venía después del
// array no se miraba. Con A=USED y B=CHARGEABLE, `[A, B]` respondía
// "payment_in_progress" y dejaba B cobrando; `[B, A]` sí mataba B antes. El
// resultado dependía del ORDEN del array, que no es una entrada de negocio: es
// el orden en que se fueron escribiendo filas.
//
// Así que la decisión se toma con el conjunto COMPLETO ya clasificado, y esta
// función es pura: mismas etiquetas, misma respuesta, en cualquier orden. Lo
// único que se ordena son los ids que se devuelven, para que ni los mensajes ni
// la auditoría dependan del orden de entrada.
const OPEN_SET = Object.freeze({
  CONFIRM_EXISTING: "confirm_existing", // una ya cobró: confirmarla, no abrir otra
  REUSE: "reuse",                       // una sirve tal cual y las demás están muertas
  OPEN_NEW: "open_new",                 // todas muertas: puede nacer otra
  BLOCKED: "blocked",                   // no se puede demostrar el invariant: fail closed
});

// Los incidentes materiales que un conjunto puede revelar, de más grave a menos.
// El orden NO es cosmético: decide qué razón queda en el campo `attention`, que
// es singular. La AUDITORÍA registra todos, siempre (Correction 05, P2-3/P2-5):
// una anomalía financiera ya consumada no puede desaparecer del historial
// porque encima de ella haya otra preventiva.
const INCIDENT = Object.freeze({
  DOUBLE_CHARGE: "double_charge",                 // dos cobros declarados: hay algo que devolver
  MANY_SESSIONS: "many_sessions_for_one_purchase", // el proveedor tiene varias de una compra
  USED_BESIDE_PAID: "used_beside_paid",           // varias usadas y UNA cobrada
  USED_UNPAID: "many_used_without_payment",       // dos sesiones usadas, ningún cobro declarado
  USABLE_BESIDE_USED: "usable_beside_used",       // una cobrable junto a una ya cobrada
  MANY_USABLE: "many_usable",                     // dos cobrables a la vez
  UNRESOLVED: "unresolved",                       // no se pudo demostrar qué pasó
});
const INCIDENT_SEVERITY = Object.freeze({
  double_charge: 6, used_beside_paid: 5, usable_beside_used: 4,
  many_sessions_for_one_purchase: 4, many_usable: 3,
  many_used_without_payment: 2, unresolved: 1,
});
const INCIDENT_ATTENTION = Object.freeze({
  double_charge: ATTENTION.DOUBLE_CHARGE,
  used_beside_paid: ATTENTION.USED_BESIDE_PAID,
  many_sessions_for_one_purchase: ATTENTION.MANY_SESSIONS,
  many_used_without_payment: ATTENTION.TWO_SESSIONS_USED_UNPAID,
  usable_beside_used: ATTENTION.OPEN_SET_UNRESOLVED,
  many_usable: ATTENTION.OPEN_SET_UNRESOLVED,
  unresolved: ATTENTION.OPEN_SET_UNRESOLVED,
});

function decideOpenSet(resolved) {
  const list = (Array.isArray(resolved) ? resolved : []).filter(Boolean);
  const ids = (xs) => xs.map((r) => r.id).sort();
  const of = (outcome) => list.filter((r) => r.outcome === outcome);

  const used = of(OPEN_INTENT.USED);
  const usable = of(OPEN_INTENT.USABLE);
  const dead = of(OPEN_INTENT.DEAD);
  // Todo lo que no es una de las tres etiquetas conocidas cuenta como sin
  // resolver, incluido un `undefined` o una etiqueta futura: fail closed por
  // defecto, no por enumeración.
  const unresolved = list.filter((r) => r.outcome !== OPEN_INTENT.USED
    && r.outcome !== OPEN_INTENT.USABLE && r.outcome !== OPEN_INTENT.DEAD);

  // LA DISTINCIÓN DE Correction 05 (P2-4): "usada" no es "cobrada".
  //
  // El proveedor declara dos cosas distintas: que su objeto ya se consumió y que
  // hay dinero. Una sesión puede constar completada con el pago sin confirmar.
  // Antes se anotaban dos "usadas" como un cargo doble, afirmando dinero que
  // nadie había declarado. Sólo `paid === true` cuenta como cobro.
  const paidUsed = used.filter((r) => r.paid === true);
  const unpaidUsed = used.filter((r) => r.paid !== true);

  // Se reúnen TODOS los incidentes antes de elegir la acción, para que ninguno
  // quede tapado por otro (P2-5).
  const incidents = [];
  const add = (kind, affected) => {
    if (affected.length) incidents.push({ kind, purchaseIds: ids(affected) });
  };
  // Más de una USADA es SIEMPRE un incidente. La mezcla de cobradas y no
  // cobradas sólo cambia CÓMO se llama, nunca si bloquea: la primera versión de
  // esto partía por `paid` y dejaba caer el caso mixto —dos usadas, una cobrada—
  // hasta "abrir una nueva", que es una tercera venta junto a un cobro hecho.
  // Las tres ramas cubren `used.length > 1` por completo, a propósito.
  if (used.length > 1) {
    if (paidUsed.length > 1) add(INCIDENT.DOUBLE_CHARGE, paidUsed);
    else if (paidUsed.length === 1) add(INCIDENT.USED_BESIDE_PAID, used);
    else add(INCIDENT.USED_UNPAID, used);
  }
  if (used.length && usable.length) add(INCIDENT.USABLE_BESIDE_USED, used.concat(usable));
  if (usable.length > 1) add(INCIDENT.MANY_USABLE, usable);
  add(INCIDENT.UNRESOLVED, unresolved);
  incidents.sort((a, b) => (INCIDENT_SEVERITY[b.kind] || 0) - (INCIDENT_SEVERITY[a.kind] || 0)
    || String(a.kind).localeCompare(String(b.kind)));

  // La acción: cualquier incidente bloquea. La razón que se reporta es la del
  // incidente MÁS GRAVE, no la del primero que se detectó.
  if (incidents.length) {
    const worst = incidents[0];
    return {
      action: OPEN_SET.BLOCKED,
      reason: worst.kind,
      incidents,
      unresolved: ids(unresolved),
      used: ids(used),
      paid: ids(paidUsed),
      needsAttention: worst.purchaseIds,
    };
  }

  // RED DE SEGURIDAD, no redundancia. Si alguna compra abierta declara un cobro,
  // aquí no se abre nada por ninguna vía, pase lo que pase con la enumeración de
  // arriba. Es lo que convierte "creo que cubrí todos los casos" en "no se puede
  // vender encima de un cobro".
  if (paidUsed.length && !incidents.length && used.length !== 1) {
    return { action: OPEN_SET.BLOCKED, reason: INCIDENT.DOUBLE_CHARGE,
      incidents: [{ kind: INCIDENT.DOUBLE_CHARGE, purchaseIds: ids(paidUsed) }],
      unresolved: [], used: ids(used), paid: ids(paidUsed), needsAttention: ids(paidUsed) };
  }

  // Sin incidentes: como máximo hay una usada y como máximo una cobrable, y no
  // pueden coexistir.
  if (used.length === 1) {
    // Regla 1: se conserva para confirmar, y las demás ya están demostradas
    // incobrables porque sólo quedan DEAD.
    return { action: OPEN_SET.CONFIRM_EXISTING, purchaseId: used[0].id,
      // Si el proveedor declaró el cobro, quien lea la auditoría tiene que poder
      // distinguirlo de "la sesión se usó y no sabemos si hubo dinero".
      winnerPaid: used[0].paid === true,
      incidents: [], unresolved: [], used: ids(used), paid: ids(paidUsed), dead: ids(dead) };
  }
  // Regla 2: exactamente una sirve, y todas las demás están DEAD — que es lo que
  // queda por eliminación, porque aquí ya no hay USED ni sin resolver.
  if (usable.length === 1) {
    return { action: OPEN_SET.REUSE, purchaseId: usable[0].id,
      // Reutilizar no es cobrar: nadie ha pagado nada por esta vía.
      winnerPaid: false,
      incidents: [], unresolved: [], dead: ids(dead) };
  }
  // Regla 3: todas muertas (o no había ninguna abierta).
  return { action: OPEN_SET.OPEN_NEW, incidents: [], unresolved: [], dead: ids(dead) };
}

// ---- el turno para reemplazar ---------------------------------------------
//
// Dos pestañas pidiendo upgrade a la vez no deben lanzar dos reemplazos: la
// primera toma el turno y la segunda espera. El turno caduca para que una
// petición que murió a medias no bloquee el torneo para siempre — y retomarlo
// es seguro porque expirar una sesión ya expirada no hace daño.
function replacementKey(slug, scopeId) {
  const a = str(slug), b = str(scopeId);
  return a && b ? `${a}|${b}` : null;
}

function isClaimActive(claim, nowMs, ttlMs) {
  if (!claim || typeof claim !== "object") return false;
  const at = Date.parse(claim.at);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
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
  provider, now, participantLimit, manualRoundLimit, boundToCompetition,
}) {
  if (!str(purchaseId) || !str(slug) || !str(scopeId)) return null;
  if (!isSafeCount(expectedAmountMinor) || expectedAmountMinor <= 0) return null;
  const cur = normalizeCurrency(currency);
  if (!cur) return null;
  if (!str(provider)) return null;
  // Correction 01: los LÍMITES también se congelan, no sólo el importe. Sin
  // ellos, confirmar tenía que volver a leer la configuración comercial viva y
  // entregaba los límites de hoy a quien compró los de hace veinte minutos.
  // Se exigen al crear: una compra sin saber qué vende no debe existir.
  if (!Number.isSafeInteger(participantLimit) || participantLimit < 1) return null;
  if (!Number.isSafeInteger(manualRoundLimit) || manualRoundLimit < 1) return null;
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
    // EL SNAPSHOT DE LO VENDIDO. Todo lo que hace falta para reconstruir
    // exactamente el PLUS que se compró, sin volver a preguntarle nada a una
    // fila que puede haber cambiado mientras el Admin pagaba.
    purchased: Object.freeze({
      plan: "PLUS",
      participantLimit,
      manualRoundLimit,
      priceMinor: expectedAmountMinor,
      currency: cur,
      configVersion: Number.isFinite(configVersion) ? configVersion : null,
      // AUDITORÍA, no enforcement. Si la quiniela ya estaba atada a una
      // competencia al comprar, `manualRoundLimit` no es el límite que vivirá:
      // un PLUS con torneo cubre el torneo entero (MON-002B). El binding se
      // sigue tomando del estado actual al otorgar, y eso es deliberado —
      // MON-001D lo adopta en la primera importación, así que congelarlo aquí
      // castigaría a quien compra antes de elegir liga. El precio de PLUS es el
      // mismo con liga y sin ella, así que no hay nada que pagar de menos: lo
      // único que cambia es que puede recibir MÁS de lo que el número dice.
      // Se registra para que eso se pueda ver, en vez de deducirlo.
      boundToCompetition: !!boundToCompetition,
    }),
    provider: String(provider),
    providerSessionId: null,
    providerPaymentIntentId: null,
    // Cuándo se le pidió al proveedor crear la sesión. Es AUDITORÍA, no lógica:
    // la seguridad no depende de este campo. Da igual si se envió la petición o
    // no, porque reanudar siempre usa la misma clave de idempotencia, y eso es
    // correcto en los dos casos. Sirve para que un operador sepa si allá puede
    // existir un objeto que aquí no se llegó a guardar.
    creationAttemptedAt: null,
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

// Lo que se vendió, en la forma que necesita quien construye el entitlement.
// Devuelve null si el snapshot no está o no es utilizable — que es un estado
// real, no un hueco que se rellene con lo que haya hoy.
function purchasedSnapshotOf(intent) {
  const p = intent && intent.purchased;
  if (!p || typeof p !== "object") return null;
  if (!Number.isSafeInteger(p.participantLimit) || p.participantLimit < 1) return null;
  if (!Number.isSafeInteger(p.manualRoundLimit) || p.manualRoundLimit < 1) return null;
  if (!isSafeCount(p.priceMinor) || p.priceMinor <= 0) return null;
  // El importe congelado y el del snapshot tienen que ser el MISMO número. Si
  // divergen, algo reescribió uno de los dos y no hay forma honesta de elegir.
  if (p.priceMinor !== intent.expectedAmountMinor) return null;
  return {
    participantLimit: p.participantLimit,
    manualRoundLimit: p.manualRoundLimit,
    pricePaidMXN: p.priceMinor / 100,
    configVersion: Number.isFinite(p.configVersion) ? p.configVersion : null,
  };
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
// `currentScopeId` y `quinielaExists` se leen de la fila BLOQUEADA, nunca del
// proveedor ni del navegador. Los dos entran aquí, en la decisión, y no después:
// Correction 01 encontró que comprobar "¿existe la quiniela?" DESPUÉS de haber
// construido el intent dejaba la anotación fuera de lo que se persistía, así
// que el pago quedaba cobrado, sin plan y sin decir por qué.
//
// El orden del pipeline es, y tiene que seguir siendo:
//   observación del proveedor -> decisión de dominio -> realidad de QRACKS bajo
//   lock -> decisión FINAL -> aplicar y persistir
//
// `quinielaExists` se exige explícito: no se deduce de que no haya scope, porque
// una quiniela puede existir sin ciclo. Cualquier cosa que no sea `true` cuenta
// como ausente, que es el lado seguro.
function evaluateConfirmation({ intent, observed, currentScopeId, quinielaExists }) {
  // Una compra SUSTITUIDA no otorga nada, pase lo que pase.
  //
  // `expired` significa dos cosas muy distintas: "caducó sola" —y entonces un
  // cobro tardío legítimo SÍ debe ganar, que es por qué canAdvance lo permite— y
  // "la matamos nosotros al abrir otra". Sin distinguirlas, un webhook sobre la
  // sesión que acabábamos de inutilizar otorgaba PLUS, que es exactamente el
  // segundo cargo que Correction 02 existe para impedir.
  //
  // Una sesión expirada en el proveedor no puede cobrar, así que un pago aquí
  // significa que nuestro protocolo la vio muerta cuando no lo estaba. No se
  // toca el estado —no se inventa dinero— y se pide una persona.
  if (intent && intent.supersededBy) {
    return { decision: DECISION.SUPERSEDED_PURCHASE, attention: ATTENTION.SUPERSEDED };
  }
  const o = observed || {};
  if (!intent) return { decision: DECISION.UNKNOWN_PURCHASE };

  // ========================================================================
  // IDENTIDAD: impostora, o HERMANA (Correction 07)
  //
  // Hasta aquí, cualquier sesión cuyo id no fuera el guardado se rechazaba como
  // identidad ajena. Eso protege del caso real que hay que proteger —una
  // confirmación que dice ser de esta compra pero cuyo objeto de pago pertenece a
  // otra— pero confundía con él un caso muy distinto: una HERMANA, otra sesión del
  // MISMO purchase, que existe cuando un reintento llegó a crear dos.
  //
  // Y la diferencia vale dinero: una hermana pagada se rechazaba como impostora, y
  // el cobro quedaba sin otorgar aunque fuera legítimo y verificable.
  //
  // Lo que decide es de quién dice ser, no cuál guardamos primero:
  //
  //   - si trae identidad propia y NO es de esta compra -> impostora, se rechaza;
  //   - si trae identidad propia y SÍ es de esta compra -> es nuestra. Un id
  //     distinto del guardado es multiplicidad, no fraude: se otorga si todo lo
  //     demás cuadra, y se anota que hubo varias;
  //   - si NO trae identidad propia, sólo se acepta si coincide con lo guardado —
  //     ahí el id ES la única identidad que hay.
  // ========================================================================
  const sid = str(o.sessionId);
  const pid = str(o.paymentIntentId);
  const declarada = str(o.purchaseId);
  if (declarada && declarada !== intent.id) {
    return { decision: DECISION.IDENTITY_MISMATCH, attention: ATTENTION.IDENTITY_MISMATCH };
  }
  // LOS DOS PORTADORES TIENEN QUE DECIR LO MISMO.
  //
  // Al crear una sesión se escribe la identidad de la compra en dos sitios
  // independientes, así que en una sesión legítima —hermana incluida— ambos
  // coinciden siempre. Que discrepen sólo puede significar que alguien reetiquetó
  // uno: es exactamente la forma de un pago ajeno presentado como propio.
  //
  // El descubrimiento ya lo comprobaba (`verifySessionForPurchase`), pero por el
  // webhook no pasa nada por ahí, y confiar sólo en la metadata dejaba esta puerta
  // abierta a quien pudiera construir el cuerpo. Que hoy eso exija el signing
  // secret no es razón para no comprobarlo: cuesta nada y no rechaza nada legítimo.
  const ref = str(o.clientReferenceId);
  const metaId = str(o.metadataPurchaseId);
  if (ref && metaId && ref !== metaId) {
    return { decision: DECISION.IDENTITY_MISMATCH, attention: ATTENTION.IDENTITY_MISMATCH };
  }
  // La quiniela que declara el objeto tiene que ser la de esta compra. Antes esto
  // lo frenaba de rebote el chequeo por id de sesión; al admitir hermanas hace
  // falta decirlo explícitamente, o una sesión que dijera ser de otra quiniela
  // pasaría sólo por llevar nuestro id de compra.
  if (str(o.slugHint) && str(o.slugHint) !== intent.slug) {
    return { decision: DECISION.IDENTITY_MISMATCH, attention: ATTENTION.IDENTITY_MISMATCH };
  }
  const conocidas = knownSessionIdsOf(intent);
  if (!declarada) {
    if (sid && intent.providerSessionId && !conocidas.includes(sid)) {
      return { decision: DECISION.IDENTITY_MISMATCH, attention: ATTENTION.IDENTITY_MISMATCH };
    }
    if (pid && intent.providerPaymentIntentId && pid !== intent.providerPaymentIntentId) {
      return { decision: DECISION.IDENTITY_MISMATCH, attention: ATTENTION.IDENTITY_MISMATCH };
    }
  }
  // Una hermana: dice ser de esta compra y su id no es el que teníamos guardado.
  // No cambia si se otorga; cambia que quede dicho que hubo más de una.
  const hermana = !!(declarada && sid && intent.providerSessionId
    && !conocidas.includes(sid));

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
    // Pero con un PaymentIntent DISTINTO del registrado no es una reentrega: son
    // dos cobros liquidados para una sola compra. No se otorga nada —ya está
    // otorgado— y deja de ser un duplicado inofensivo para pasar a ser algo que
    // hay que devolver (Correction 07).
    if (pid && intent.providerPaymentIntentId && pid !== intent.providerPaymentIntentId) {
      return { decision: DECISION.ALREADY_PAID, attention: ATTENTION.DOUBLE_CHARGE,
        sibling: sid || null };
    }
    return { decision: DECISION.ALREADY_PAID };
  }

  // Se cobró y la quiniela ya no está. Se comprueba ANTES del torneo porque es
  // un hecho más fundamental: sin quiniela no hay ciclo con el que comparar. El
  // dinero se registra; no hay nada que otorgar.
  if (quinielaExists !== true) {
    return {
      decision: DECISION.QUINIELA_MISSING, nextStatus: PURCHASE_STATUS.PAID,
      attention: ATTENTION.QUINIELA_MISSING,
    };
  }

  // La quiniela está, pero no se puede leer a qué torneo juega ahora.
  //
  // Correction 02: antes esto CONFIRMABA. La comprobación de torneo era
  // `if (currentScopeId && ...)`, así que un scope ausente se saltaba la
  // comparación entera y caía en otorgar. Una compra nació atada a un torneo
  // concreto; si no se puede demostrar cuál es el de ahora, no se puede
  // demostrar que el plan vaya al sitio correcto — y "no se puede demostrar"
  // nunca debe significar "adelante".
  if (!readableScope(currentScopeId)) {
    return {
      decision: DECISION.SCOPE_UNPROVEN, nextStatus: PURCHASE_STATUS.PAID,
      attention: ATTENTION.SCOPE_UNPROVEN,
    };
  }

  // Se cobró de verdad, pero el torneo que se compró ya no es el que se juega.
  // El dinero existe y se registra; el entitlement NO se otorga, porque
  // otorgarlo aquí sería habilitar un torneo que nadie compró. Queda marcado
  // para que un humano decida (reembolso, traslado), que es una decisión
  // comercial y no del código.
  if (intent.scopeId !== readableScope(currentScopeId)) {
    return {
      decision: DECISION.STALE_SCOPE, nextStatus: PURCHASE_STATUS.PAID,
      attention: ATTENTION.STALE_SCOPE,
    };
  }

  // Se cobró y no se puede reconstruir QUÉ se vendió. No se otorga nada
  // aproximado: rellenar el hueco con la configuración de hoy sería
  // exactamente el fallo que Correction 01 vino a cerrar, una línea más abajo.
  if (!purchasedSnapshotOf(intent)) {
    return {
      decision: DECISION.SNAPSHOT_UNUSABLE, nextStatus: PURCHASE_STATUS.PAID,
      attention: ATTENTION.SNAPSHOT_UNUSABLE,
    };
  }

  // Se cobró, todo cuadra y hay a quién otorgárselo. Si además vino por una
  // hermana, se otorga IGUAL —el dinero es real y es de esta compra— y queda
  // anotado que existieron varias sesiones, que es lo que una persona debe mirar.
  return hermana
    ? { decision: DECISION.CONFIRM, nextStatus: PURCHASE_STATUS.PAID,
        attention: ATTENTION.MANY_SESSIONS, sibling: sid }
    : { decision: DECISION.CONFIRM, nextStatus: PURCHASE_STATUS.PAID };
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
  // Correction 07: si esta confirmación vino por una HERMANA, su id se GUARDA. No
  // sustituye a la primera —eso convertiría el registro en el de otro pago— sino
  // que se suma: a partir de aquí el sistema sabe que esta compra tuvo varias
  // sesiones, y ninguna de ellas puede volver a ser invisible.
  if (str(decision.sibling)) {
    const ids = knownSessionIdsOf(next);
    if (!ids.includes(str(decision.sibling))) ids.push(str(decision.sibling));
    next.providerSessionIds = ids.sort();
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
  SESSION_STATE, sessionStateOf, openIntentsForScope,
  OPEN_INTENT, classifyOpenIntent,
  OPEN_SET, decideOpenSet, INCIDENT, INCIDENT_SEVERITY, INCIDENT_ATTENTION,
  SESSION_MATCH, verifySessionForPurchase,
  SESSION_SET, decideSessionSet,
  MAX_CREATION_ATTEMPTS, creationAttemptsOf, isAttemptReusable, discoveryWindows,
  knownSessionIdsOf, needsSessionDiscovery,
  replacementKey, isClaimActive,
  MAX_SEEN_EVENTS,
  toMinorUnits, normalizeCurrency,
  makePurchaseIntent, canAdvance, isReusableIntent, findReusableIntent,
  findPaidIntentForScope, findIntentById, locateIntent,
  purchasedSnapshotOf,
  evaluateConfirmation, applyDecision,
  hasSeenEvent, rememberEvent, buildPaymentAudit,
};
