// MON-003 — pagos con Stripe.
//
// Lo que estas pruebas existen para impedir, en una sola frase: que alguien
// consiga PLUS sin pagarlo, o que alguien pague y no lo reciba.
//
// La mayoría son de DOMINIO y no mencionan Stripe: ésa es la prueba de que la
// frontera existe. Las que sí lo mencionan están agrupadas al final y sólo
// tocan el adaptador.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const D = require("../payments/paymentsDomain");
const stripe = require("../payments/stripeAdapter");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((line) => {
      for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === "/" && line[i + 1] === "/" && line[i - 1] !== ":") return line.slice(0, i);
      }
      return line;
    }).join("\n");
}

const NOW = "2026-09-10T12:00:00.000Z";
const SCOPE = "ts:1:football:thesportsdb:4350:e1";
const OTHER_SCOPE = "ts:1:football:thesportsdb:4350:e2";

const intentOf = (over = {}) => ({
  ...D.makePurchaseIntent({
    purchaseId: "qpur_a1", slug: "liga", scopeId: SCOPE, configVersion: 1,
    expectedAmountMinor: 19900, currency: "mxn", provider: "stripe", now: NOW,
  }),
  ...over,
});
const observedOf = (over = {}) => ({
  purchaseId: "qpur_a1", sessionId: "cs_1", paymentIntentId: "pi_1",
  paid: true, amountMinor: 19900, currency: "mxn", terminalStatus: null, ...over,
});
const decide = (intent, observed, currentScopeId = SCOPE) =>
  D.evaluateConfirmation({ intent, observed, currentScopeId });

// ==== 1 · importes: nunca en coma flotante ================================

test("MON003 · 1 — los pesos se convierten a centavos enteros, o no se convierten", () => {
  assert.equal(D.toMinorUnits(199), 19900);
  assert.equal(D.toMinorUnits(0.5), 50);
  assert.equal(D.toMinorUnits(199.99), 19999);
  // Más de dos decimales no es un precio: es un error que redondear taparía.
  assert.equal(D.toMinorUnits(199.999), null);
  assert.equal(D.toMinorUnits(-1), null);
  assert.equal(D.toMinorUnits(NaN), null);
  assert.equal(D.toMinorUnits(Infinity), null);
  assert.equal(D.toMinorUnits("199"), null, "una cadena no es un importe");
});

test("MON003 · 2 — sólo MXN, y la moneda se normaliza antes de comparar", () => {
  assert.equal(D.normalizeCurrency("MXN"), "mxn");
  assert.equal(D.normalizeCurrency(" mxn "), "mxn");
  assert.equal(D.normalizeCurrency("usd"), null);
  assert.equal(D.normalizeCurrency(null), null);
});

test("MON003 · 3 — un purchase intent inválido no se crea a medias", () => {
  const base = { purchaseId: "p", slug: "s", scopeId: SCOPE, configVersion: 1,
    expectedAmountMinor: 19900, currency: "mxn", provider: "stripe", now: NOW };
  assert.ok(D.makePurchaseIntent(base));
  assert.equal(D.makePurchaseIntent({ ...base, scopeId: null }), null, "sin torneo no hay compra");
  assert.equal(D.makePurchaseIntent({ ...base, expectedAmountMinor: 0 }), null);
  assert.equal(D.makePurchaseIntent({ ...base, expectedAmountMinor: 19900.5 }), null);
  assert.equal(D.makePurchaseIntent({ ...base, currency: "usd" }), null);
  assert.equal(D.makePurchaseIntent({ ...base, slug: "" }), null);
});

// ==== 2 · camino feliz =====================================================

test("MON003 · 4 — HAPPY PATH: pago verificado del importe correcto otorga PLUS", () => {
  const d = decide(intentOf(), observedOf());
  assert.equal(d.decision, D.DECISION.CONFIRM);
  assert.equal(d.nextStatus, D.PURCHASE_STATUS.PAID);
  const next = D.applyDecision(intentOf(), d, observedOf(), NOW);
  assert.equal(next.status, "paid");
  assert.equal(next.confirmedAt, NOW);
  assert.equal(next.providerPaymentIntentId, "pi_1", "la identidad del cargo queda registrada");
});

// ==== 3 · fraude ===========================================================

test("MON003 · 5 — FRAUDE: un importe alterado NO otorga nada", () => {
  for (const amount of [1, 100, 19899, 19901, 999900]) {
    const d = decide(intentOf(), observedOf({ amountMinor: amount }));
    assert.equal(d.decision, D.DECISION.AMOUNT_MISMATCH, `importe ${amount}`);
    assert.equal(d.nextStatus, undefined, "y no marca el pago como cobrado");
  }
});

test("MON003 · 6 — FRAUDE: un importe ausente o no entero falla cerrado", () => {
  for (const amount of [null, undefined, "19900", 19900.5, NaN]) {
    assert.equal(decide(intentOf(), observedOf({ amountMinor: amount })).decision,
      D.DECISION.AMOUNT_MISMATCH, JSON.stringify(amount));
  }
});

test("MON003 · 7 — FRAUDE: otra moneda por el mismo número no cuela", () => {
  const d = decide(intentOf(), observedOf({ currency: "usd" }));
  assert.equal(d.decision, D.DECISION.CURRENCY_MISMATCH);
});

test("MON003 · 8 — FRAUDE: un pago de OTRA compra no puede reutilizarse", () => {
  // La sesión que se observa no es la que este intent tiene guardada. Aunque
  // la metadata diga que sí, la identidad del proveedor manda sobre la pista.
  const mine = intentOf({ providerSessionId: "cs_mine" });
  const d = decide(mine, observedOf({ sessionId: "cs_someone_else" }));
  assert.equal(d.decision, D.DECISION.IDENTITY_MISMATCH);
  assert.equal(d.attention, D.ATTENTION.IDENTITY_MISMATCH);
});

test("MON003 · 9 — FRAUDE: un PaymentIntent reutilizado tampoco", () => {
  const mine = intentOf({ providerPaymentIntentId: "pi_mine" });
  assert.equal(decide(mine, observedOf({ paymentIntentId: "pi_otro" })).decision,
    D.DECISION.IDENTITY_MISMATCH);
});

test("MON003 · 10 — FRAUDE: una compra que no existe no otorga nada", () => {
  assert.equal(D.evaluateConfirmation({ intent: null, observed: observedOf(), currentScopeId: SCOPE }).decision,
    D.DECISION.UNKNOWN_PURCHASE);
  assert.equal(D.locateIntent([], observedOf()), null);
});

test("MON003 · 11 — FRAUDE: 'el cliente dice que pagó' no es una afirmación de pago", () => {
  // paid !== true, exactamente. Ni "true", ni 1, ni "paid".
  for (const claim of ["true", 1, "paid", {}, [], "yes"]) {
    const d = decide(intentOf(), observedOf({ paid: claim }));
    assert.notEqual(d.decision, D.DECISION.CONFIRM, JSON.stringify(claim));
  }
});

// ==== 4 · idempotencia =====================================================

test("MON003 · 12 — IDEMPOTENCIA: un pago ya confirmado no se otorga dos veces", () => {
  const paid = intentOf({ status: "paid", confirmedAt: NOW });
  assert.equal(decide(paid, observedOf()).decision, D.DECISION.ALREADY_PAID);
});

test("MON003 · 13 — IDEMPOTENCIA: N entregas del mismo evento se ven una sola vez", () => {
  let seen = [];
  assert.equal(D.hasSeenEvent(seen, "evt_1"), false);
  seen = D.rememberEvent(seen, "evt_1", NOW);
  assert.equal(D.hasSeenEvent(seen, "evt_1"), true);
  seen = D.rememberEvent(seen, "evt_1", NOW);
  assert.equal(seen.filter((e) => e.id === "evt_1").length, 1, "no se duplica la entrada");
});

test("MON003 · 14 — IDEMPOTENCIA: la lista de eventos vistos está acotada", () => {
  let seen = [];
  for (let i = 0; i < D.MAX_SEEN_EVENTS + 50; i++) seen = D.rememberEvent(seen, "evt_" + i, NOW);
  assert.equal(seen.length, D.MAX_SEEN_EVENTS);
  assert.equal(D.hasSeenEvent(seen, "evt_" + (D.MAX_SEEN_EVENTS + 49)), true, "el último sigue");
  // Y por eso la garantía real NO vive aquí: el pago ya confirmado la sostiene.
  const paid = intentOf({ status: "paid" });
  assert.equal(decide(paid, observedOf()).decision, D.DECISION.ALREADY_PAID);
});

test("MON003 · 15 — IDEMPOTENCIA: eventos DISTINTOS del mismo pago otorgan una vez", () => {
  // checkout.session.completed y async_payment_succeeded pueden llegar los dos.
  let intent = intentOf();
  const d1 = decide(intent, observedOf());
  assert.equal(d1.decision, D.DECISION.CONFIRM);
  intent = D.applyDecision(intent, d1, observedOf(), NOW);
  const d2 = decide(intent, observedOf());
  assert.equal(d2.decision, D.DECISION.ALREADY_PAID, "el segundo evento no vuelve a otorgar");
});

// ==== 5 · orden de llegada =================================================

test("MON003 · 16 — ORDEN: el estado económico sólo avanza, nunca retrocede", () => {
  assert.equal(D.canAdvance("created", "paid"), true);
  assert.equal(D.canAdvance("created", "expired"), true);
  assert.equal(D.canAdvance("paid", "expired"), false);
  assert.equal(D.canAdvance("paid", "failed"), false);
  assert.equal(D.canAdvance("paid", "created"), false);
  assert.equal(D.canAdvance("expired", "cancelled"), false, "ni lateralmente entre fallidos");
  assert.equal(D.canAdvance("expired", "paid"), true, "pero un cobro tardío sí manda");
});

test("MON003 · 17 — ORDEN: un 'expiró' que llega tras el cobro se ignora", () => {
  const paid = intentOf({ status: "paid", confirmedAt: NOW });
  const d = decide(paid, observedOf({ paid: false, terminalStatus: "expired" }));
  assert.equal(d.decision, D.DECISION.IGNORED_STALE);
  const next = D.applyDecision(paid, d, {}, "2026-09-11T00:00:00.000Z");
  assert.equal(next.status, "paid", "el cobro sobrevive al evento viejo");
});

test("MON003 · 18 — ORDEN: expiración y fallo sí se registran sobre una compra abierta", () => {
  for (const terminal of ["expired", "failed", "cancelled"]) {
    const d = decide(intentOf(), observedOf({ paid: false, terminalStatus: terminal }));
    assert.equal(d.decision, D.DECISION.NOT_PAID);
    assert.equal(D.applyDecision(intentOf(), d, {}, NOW).status, terminal);
  }
});

test("MON003 · 19 — ORDEN: un cobro que llega después de una expiración sí gana", () => {
  const expired = intentOf({ status: "expired" });
  const d = decide(expired, observedOf());
  assert.equal(d.decision, D.DECISION.CONFIRM);
  assert.equal(D.applyDecision(expired, d, observedOf(), NOW).status, "paid");
});

// ==== 6 · ciclo de torneo ==================================================

test("MON003 · 20 — LIFECYCLE: un pago del torneo ANTERIOR no habilita el nuevo", () => {
  // El caso del ticket: el Admin abrió el checkout, inició otro torneo y
  // después pagó. El dinero es real; el torneo comprado ya no se juega.
  const d = decide(intentOf(), observedOf(), OTHER_SCOPE);
  assert.equal(d.decision, D.DECISION.STALE_SCOPE);
  assert.equal(d.nextStatus, D.PURCHASE_STATUS.PAID, "el cobro se registra: existió");
  assert.equal(d.attention, D.ATTENTION.STALE_SCOPE, "y queda marcado para revisar");
  const next = D.applyDecision(intentOf(), d, observedOf(), NOW);
  assert.equal(next.status, "paid");
  assert.equal(next.attention.code, D.ATTENTION.STALE_SCOPE);
  assert.equal(next.scopeId, SCOPE, "sigue apuntando al torneo que se compró");
});

test("MON003 · 21 — LIFECYCLE: una compra pertenece a UN torneo, no al slug", () => {
  const purchases = [intentOf({ status: "paid" })];
  assert.ok(D.findPaidIntentForScope(purchases, "liga", SCOPE), "el torneo comprado, sí");
  assert.equal(D.findPaidIntentForScope(purchases, "liga", OTHER_SCOPE), null, "el siguiente, no");
  assert.equal(D.findPaidIntentForScope(purchases, "otra", SCOPE), null, "otra quiniela, tampoco");
});

test("MON003 · 22 — LIFECYCLE: un checkout abierto del torneo viejo no se reutiliza en el nuevo", () => {
  const purchases = [intentOf({ providerCheckoutUrl: "https://pay/x" })];
  const nowMs = Date.parse(NOW) + 60000;
  assert.ok(D.findReusableIntent(purchases, "liga", SCOPE, nowMs, 3600e3));
  assert.equal(D.findReusableIntent(purchases, "liga", OTHER_SCOPE, nowMs, 3600e3), null);
});

// ==== 7 · reutilización del checkout =======================================

test("MON003 · 23 — CHECKOUT: dos taps reutilizan la compra abierta", () => {
  const purchases = [intentOf({ providerCheckoutUrl: "https://pay/x" })];
  const found = D.findReusableIntent(purchases, "liga", SCOPE, Date.parse(NOW) + 1000, 3600e3);
  assert.equal(found.id, "qpur_a1");
});

test("MON003 · 24 — CHECKOUT: una compra sin sesión TAMBIÉN se reutiliza", () => {
  // Es el caso de la respuesta perdida: reutilizar el id manda la misma clave
  // de idempotencia al proveedor y recupera la sesión que ya creó.
  const sinSesion = intentOf();
  assert.equal(sinSesion.providerSessionId, null);
  assert.ok(D.isReusableIntent(sinSesion, Date.parse(NOW) + 1000, 3600e3));
});

test("MON003 · 25 — CHECKOUT: no se reutiliza una compra vieja, pagada o fallida", () => {
  const nowMs = Date.parse(NOW) + 1000;
  assert.equal(D.isReusableIntent(intentOf({ status: "paid" }), nowMs, 3600e3), false);
  assert.equal(D.isReusableIntent(intentOf({ status: "expired" }), nowMs, 3600e3), false);
  assert.equal(D.isReusableIntent(intentOf(), Date.parse(NOW) + 4000e3, 3600e3), false, "caducada");
  assert.equal(D.isReusableIntent(intentOf({ createdAt: "no-es-fecha" }), nowMs, 3600e3), false);
});

test("MON003 · 26 — CHECKOUT: la identidad del proveedor se adjunta pero NUNCA se reescribe", () => {
  const conSesion = intentOf({ providerSessionId: "cs_original", providerPaymentIntentId: "pi_original" });
  const d = { decision: D.DECISION.ALREADY_PAID };
  const next = D.applyDecision(conSesion, d, { sessionId: "cs_otro", paymentIntentId: "pi_otro" }, NOW);
  assert.equal(next.providerSessionId, "cs_original");
  assert.equal(next.providerPaymentIntentId, "pi_original");
});

// ==== 8 · configuración comercial ==========================================

test("MON003 · 27 — CONFIG: el importe esperado se congela al crear la compra", () => {
  // El precio sube entre crear y confirmar. Lo que manda es lo que se congeló:
  // si el proveedor cobró otra cosa, falla cerrado en vez de aceptar cualquiera
  // de los dos números.
  const intent = intentOf({ expectedAmountMinor: 19900 });
  assert.equal(decide(intent, observedOf({ amountMinor: 29900 })).decision, D.DECISION.AMOUNT_MISMATCH);
  assert.equal(decide(intent, observedOf({ amountMinor: 19900 })).decision, D.DECISION.CONFIRM);
});

// ==== 9 · auditoría ========================================================

test("MON003 · 28 — AUDIT: la entrada permite reconstruir el pago sin abrir el proveedor", () => {
  const intent = intentOf({ status: "paid", providerSessionId: "cs_1", providerPaymentIntentId: "pi_1" });
  const a = D.buildPaymentAudit(intent, D.DECISION.CONFIRM, "granted", NOW);
  for (const f of ["purchaseId", "slug", "scopeId", "amountMinor", "currency", "provider",
    "providerSessionId", "providerPaymentIntentId", "status", "decision", "entitlement", "at"]) {
    assert.ok(f in a, `falta ${f} en la auditoría`);
  }
  assert.equal(a.amountMinor, 19900);
  assert.equal(a.entitlement, "granted");
});

// ==== 10 · la frontera con el proveedor ====================================

test("MON003 · 29 — FRONTERA: el CÓDIGO del dominio no menciona a Stripe", () => {
  // Se miran las instrucciones, no la prosa: los comentarios que explican POR
  // QUÉ el proveedor no está aquí son justamente lo que hay que conservar.
  const domainSrc = stripComments(
    fs.readFileSync(path.join(__dirname, "..", "payments", "paymentsDomain.js"), "utf8"));
  assert.ok(!/stripe/i.test(domainSrc),
    "si el dominio conoce al proveedor, cambiar de proveedor deja de ser cambiar un archivo");
  // Y tampoco su vocabulario, que es la otra forma de acoplarse sin nombrarlo.
  for (const term of ["payment_status", "checkout.session", "amount_total", "whsec", "payment_intent"]) {
    assert.ok(!domainSrc.includes(term), `el dominio no debe hablar de ${term}`);
  }
});

test("MON003 · 30 — FRONTERA: Stripe vive en un solo archivo", () => {
  const files = ["planLimits.js", "platformState.js", "tournamentScope.js", "competitionSync.js"];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
    assert.ok(!/stripe/i.test(src), `${f} no debería saber que Stripe existe`);
  }
  // server.js sí lo nombra, pero SÓLO a través del adaptador: nunca una URL
  // suya, nunca una clave, nunca un nombre de evento.
  const src = stripComments(serverSrc);
  assert.ok(!/api\.stripe\.com/.test(src));
  assert.ok(!/checkout\.session\./.test(src), "los nombres de sus eventos se quedan en el adaptador");
  assert.ok(!/payment_status/.test(src));
});

// ==== 11 · verificación de firma ===========================================

const SECRET = "whsec_test_secret";
const signed = (body, secret = SECRET, ts = Math.floor(Date.now() / 1000)) => {
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${sig}`;
};

test("MON003 · 31 — FIRMA: una firma legítima se acepta", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  assert.equal(stripe.verifyWebhookSignature(body, signed(body), SECRET).ok, true);
  // Y también como Buffer, que es lo que express.raw entrega de verdad.
  assert.equal(stripe.verifyWebhookSignature(Buffer.from(body, "utf8"), signed(body), SECRET).ok, true);
});

test("MON003 · 32 — FIRMA: un webhook falsificado se rechaza", () => {
  const body = JSON.stringify({ id: "evt_1" });
  assert.equal(stripe.verifyWebhookSignature(body, `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}`, SECRET).ok, false);
  assert.equal(stripe.verifyWebhookSignature(body, signed(body, "otro_secreto"), SECRET).ok, false);
});

test("MON003 · 33 — FIRMA: sin secreto configurado NO se acepta nada", () => {
  const body = "{}";
  assert.equal(stripe.verifyWebhookSignature(body, signed(body), "").ok, false);
  assert.equal(stripe.verifyWebhookSignature(body, signed(body), null).ok, false);
});

test("MON003 · 34 — FIRMA: una cabecera malformada se rechaza sin reventar", () => {
  const body = "{}";
  for (const header of ["", null, undefined, "basura", "t=abc,v1=x", "v1=solo", "t=123", 42, ["a"]]) {
    const r = stripe.verifyWebhookSignature(body, header, SECRET);
    assert.equal(r.ok, false, JSON.stringify(header));
  }
});

test("MON003 · 35 — FIRMA: el cuerpo tiene que ser el CRUDO, no uno reparseado", () => {
  const obj = { id: "evt_1", type: "checkout.session.completed" };
  const body = JSON.stringify(obj);
  const header = signed(body);
  assert.equal(stripe.verifyWebhookSignature(obj, header, SECRET).reason, "payload_not_raw");
  // Reserializar produce los mismos bytes AQUÍ, pero no en general: por eso la
  // regla es el crudo y no "algo equivalente".
  assert.equal(stripe.verifyWebhookSignature(JSON.stringify({ type: obj.type, id: obj.id }), header, SECRET).ok,
    false, "otro orden de claves ya no verifica");
});

test("MON003 · 36 — FIRMA: una reproducción vieja cae fuera de tolerancia", () => {
  const body = "{}";
  const viejo = Math.floor(Date.now() / 1000) - 3600;
  const r = stripe.verifyWebhookSignature(body, signed(body, SECRET, viejo), SECRET);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timestamp_out_of_tolerance");
  // Dentro de la ventana, la MISMA firma sí vale.
  const reciente = Math.floor(Date.now() / 1000) - 10;
  assert.equal(stripe.verifyWebhookSignature(body, signed(body, SECRET, reciente), SECRET).ok, true);
});

test("MON003 · 37 — FIRMA: varias v1 en la cabecera (rotación de secreto)", () => {
  const body = "{}";
  const ts = Math.floor(Date.now() / 1000);
  const buena = crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  const header = `t=${ts},v1=${"0".repeat(64)},v1=${buena}`;
  assert.equal(stripe.verifyWebhookSignature(body, header, SECRET).ok, true,
    "durante una rotación llegan las dos y basta con que una case");
});

// ==== 12 · traducción de eventos ===========================================

const sessionEvent = (over = {}) => ({
  id: "evt_1", type: "checkout.session.completed",
  data: { object: { id: "cs_1", payment_status: "paid", amount_total: 19900, currency: "mxn",
    payment_intent: "pi_1", status: "complete",
    metadata: { qracks_purchase_id: "qpur_a1", qracks_slug: "liga", qracks_scope_id: SCOPE },
    ...over } },
});

test("MON003 · 38 — EVENTOS: 'complete' NO es 'pagado'", () => {
  // La trampa: una sesión puede completarse con el pago todavía en curso.
  const o = stripe.normalizeEvent(sessionEvent({ status: "complete", payment_status: "unpaid" }));
  assert.equal(o.paid, false, "sólo payment_status:'paid' cuenta como cobro");
  assert.equal(decide(intentOf(), o).decision !== D.DECISION.CONFIRM, true);
});

test("MON003 · 39 — EVENTOS: sólo se escuchan los del checkout de pago único", () => {
  assert.deepEqual(stripe.HANDLED_EVENTS.slice(0, 4), [
    "checkout.session.completed", "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed", "checkout.session.expired",
  ]);
  assert.equal(stripe.normalizeEvent({ id: "evt", type: "customer.subscription.created", data: { object: {} } }), null,
    "una suscripción no existe en este producto y no debe procesarse");
  assert.equal(stripe.normalizeEvent({ id: "evt", type: "invoice.paid", data: { object: {} } }), null);
});

test("MON003 · 40 — EVENTOS: un payload basura no revienta la traducción", () => {
  for (const bad of [null, undefined, {}, { id: 1 }, { type: "x" }, { id: "e", type: "checkout.session.completed" },
    { id: "e", type: "checkout.session.completed", data: {} },
    { id: "e", type: "checkout.session.completed", data: { object: null } }]) {
    assert.equal(stripe.normalizeEvent(bad), null, JSON.stringify(bad));
  }
});

test("MON003 · 41 — EVENTOS: expiración y fallo asíncrono se traducen a estado terminal", () => {
  const exp = stripe.normalizeEvent({ ...sessionEvent({ payment_status: "unpaid" }), type: "checkout.session.expired" });
  assert.equal(exp.terminalStatus, "expired");
  const fail = stripe.normalizeEvent({ ...sessionEvent({ payment_status: "unpaid" }), type: "checkout.session.async_payment_failed" });
  assert.equal(fail.terminalStatus, "failed");
});

test("MON003 · 42 — EVENTOS: reembolso y disputa se auditan, no revocan", () => {
  const ref = stripe.normalizeEvent({ id: "evt_r", type: "charge.refunded",
    data: { object: { payment_intent: "pi_1", metadata: { qracks_purchase_id: "qpur_a1" } } } });
  assert.equal(ref.kind, "audit_only");
  assert.equal(ref.paid, false, "un reembolso nunca puede leerse como un cobro");
  assert.equal(ref.attentionHint, "refunded");
});

test("MON003 · 43 — EVENTOS: la metadata es una PISTA, no la autoridad", () => {
  // Metadata que apunta a una compra que no es la suya: el registro durable
  // manda y la discrepancia de identidad lo frena.
  const o = stripe.normalizeEvent(sessionEvent({
    id: "cs_ajena", metadata: { qracks_purchase_id: "qpur_a1", qracks_slug: "otra", qracks_scope_id: OTHER_SCOPE },
  }));
  const mine = intentOf({ providerSessionId: "cs_mia" });
  assert.equal(decide(mine, o).decision, D.DECISION.IDENTITY_MISMATCH);
});

test("MON003 · 44 — EVENTOS: el scope de la metadata NO decide nada", () => {
  // Aunque el evento diga que es del torneo actual, quien decide es el scopeId
  // congelado en el intent contra el scope leído de la fila bloqueada.
  const o = stripe.normalizeEvent(sessionEvent());
  assert.equal(o.scopeHint, SCOPE);
  assert.equal(decide(intentOf(), o, OTHER_SCOPE).decision, D.DECISION.STALE_SCOPE);
});

// ==== 13 · el servidor: contratos estructurales ============================

test("MON003 · 45 — SERVER: el webhook recibe el cuerpo crudo, y sólo el webhook", () => {
  const src = stripComments(serverSrc);
  const rawAt = src.indexOf("app.post(STRIPE_WEBHOOK_PATH, express.raw(");
  const jsonAt = src.indexOf("app.use(express.json(");
  assert.ok(rawAt !== -1, "la ruta cruda tiene que existir");
  assert.ok(jsonAt !== -1);
  assert.ok(rawAt < jsonAt,
    "si el parser JSON global va antes, el cuerpo original se pierde y ninguna firma verifica jamás");
  assert.ok(src.includes('express.raw({ type: "application/json", limit: "1mb" })'),
    "acotado en tipo y tamaño: es un endpoint sin autenticar");
});

test("MON003 · 46 — SERVER: la firma se verifica ANTES de mirar el contenido", () => {
  const src = stripComments(serverSrc);
  const hook = src.slice(src.indexOf("app.post(STRIPE_WEBHOOK_PATH, async"));
  const body = hook.slice(0, hook.indexOf("\n});"));
  const verifyAt = body.indexOf("verifyWebhookSignature");
  const parseAt = body.indexOf("JSON.parse");
  assert.ok(verifyAt !== -1 && parseAt !== -1);
  assert.ok(verifyAt < parseAt, "parsear antes de verificar es procesar lo que no está probado");
  assert.ok(body.includes('return res.status(400).json({ error: "invalid_signature" })'));
});

test("MON003 · 47 — SERVER: el success_url no otorga NADA", () => {
  const src = stripComments(serverSrc);
  const status = src.slice(src.indexOf('app.get("/api/quinielas/:slug/checkout/:purchaseId"'));
  const body = status.slice(0, status.indexOf("\n});"));
  // La ruta de estado sólo puede confirmar preguntándole al proveedor.
  assert.ok(body.includes("retrieveCheckoutSession"), "confirma preguntando, no creyendo");
  assert.ok(!/req\.query/.test(body), "no lee nada de la query del navegador");
  assert.ok(body.includes("confirmPaymentAndGrant"),
    "y usa el MISMO camino de confirmación que el webhook, no uno más laxo");
});

test("MON003 · 48 — SERVER: el precio y el torneo salen del servidor, nunca del cuerpo", () => {
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout"'));
  const body = co.slice(0, co.indexOf("\n});"));
  assert.ok(!/req\.body/.test(body), "el navegador no aporta nada a una compra");
  assert.ok(body.includes("commercial_config"), "el precio sale de la configuración comercial");
  assert.ok(body.includes("entry.tournamentScope"), "y el torneo, de la fila bloqueada");
  assert.ok(body.includes('getRowLocked("platform_index", client)'));
});

test("MON003 · 49 — SERVER: comprar lo que ya se tiene se corta antes de cobrar", () => {
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout"'));
  const body = co.slice(0, co.indexOf("\n});"));
  assert.ok(body.includes('entry.entitlement.plan !== "FREE"'));
  assert.ok(body.includes('error: "already_on_plan"'));
  assert.ok(body.includes("findPaidIntentForScope"), "ni se cobra dos veces el mismo torneo");
});

test("MON003 · 50 — SERVER: la confirmación es una sola transacción", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function confirmPaymentAndGrant"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes('client.query("BEGIN")'));
  assert.ok(body.includes('client.query("COMMIT")'));
  assert.ok(body.includes('client.query("ROLLBACK")'));
  // Las tres escrituras van con el MISMO client: o las tres, o ninguna.
  assert.ok(body.includes("putRow(PAYMENT_INTENTS_KEY,"));
  assert.ok(body.includes('putRow("platform_payment_log", nextPaymentLog, client)'));
  assert.ok(body.includes('putRow("platform_index", nextIndex, client)'));
  assert.ok(body.includes("applyEntitlementGrant"), "reutiliza el otorgamiento atómico de MON-002B");
});

test("MON003 · 51 — SERVER: el scope se lee de la fila bloqueada, no del proveedor", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function confirmPaymentAndGrant"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes("entry.tournamentScope ? entry.tournamentScope.id : null"));
  assert.ok(!/observed\.scopeHint/.test(body), "la pista del proveedor no puede decidir el torneo");
});

test("MON003 · 52 — SERVER: ningún secreto puede salir por una respuesta", () => {
  const src = stripComments(serverSrc);
  assert.ok(!/STRIPE_SECRET_KEY/.test(src), "la clave sólo se lee dentro del adaptador");
  assert.ok(!/STRIPE_WEBHOOK_SECRET/.test(src));
  // Y el adaptador tampoco los registra.
  const adapterSrc = stripComments(fs.readFileSync(path.join(__dirname, "..", "payments", "stripeAdapter.js"), "utf8"));
  assert.ok(!/console\.(log|error|warn)/.test(adapterSrc), "el adaptador no escribe logs con material sensible");
});

test("MON003 · 53 — SERVER: la fila de compras es de plataforma", () => {
  assert.ok(serverSrc.includes('"platform_payment_intents"'));
  const src = stripComments(serverSrc);
  assert.ok(src.includes('req.params.key === "platform_payment_intents"'),
    "leerla exige autenticación de plataforma, igual que el libro de pagos");
});

test("MON003 · 54 — SERVER: la llamada de red NO ocurre dentro de la transacción", () => {
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout"'));
  const body = co.slice(0, co.indexOf("\n});"));
  const commitAt = body.indexOf('await client.query("COMMIT")');
  const netAt = body.indexOf("stripeAdapter.createCheckoutSession");
  assert.ok(commitAt !== -1 && netAt !== -1);
  assert.ok(commitAt < netAt,
    "un tercero lento dentro de la transacción bloquea filas durante todo su round-trip");
});

// ==== 14 · la pantalla =====================================================

test("MON003 · 55 — UI: la pantalla no conoce el precio ni el torneo", () => {
  const ui = stripComments(indexSrc);
  const fn = ui.slice(ui.indexOf("async function startCheckout"));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.ok(!/priceMXN|amount|scopeId/.test(body), "pide que se prepare el pago y nada más");
  assert.ok(body.includes('body: "{}"'), "no manda ningún dato comercial");
});

test("MON003 · 56 — UI: sin pasarela configurada NO se finge un cobro", () => {
  const ui = stripComments(indexSrc);
  assert.ok(ui.includes('reason: "unavailable"'));
  assert.ok(/El pago con tarjeta no está disponible/.test(indexSrc),
    "se dice la verdad y queda la vía manual");
});

test("MON003 · 57 — UI: la vuelta del checkout confirma contra el servidor", () => {
  const ui = stripComments(indexSrc);
  const fn = ui.slice(ui.indexOf("async function resolveCheckoutReturn"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  assert.ok(body.includes("readCheckoutStatus"), "pregunta al servidor");
  assert.ok(!/session_id/.test(body), "no usa ningún identificador del proveedor de la URL");
  assert.ok(/Estamos confirmando tu pago/.test(indexSrc));
});

// ==== 15 · Quick Win 1: el panel dejaba entender "PLUS = 18 jornadas" ======

test("MON003 · 58 — QUICK WIN 1: Plus con torneo cubre el torneo, no 18 jornadas", () => {
  const { buildUpgradeOffer, DEFAULT_COMMERCIAL_CONFIG } = require("../planLimits");
  const cfg = DEFAULT_COMMERCIAL_CONFIG;
  const conTorneo = { plan: "FREE", competitionIdentity: "4350:2026-2027" };
  const sinTorneo = { plan: "FREE", competitionIdentity: null };
  assert.equal(buildUpgradeOffer(conTorneo, cfg).roundLimitApplies, false);
  assert.equal(buildUpgradeOffer(sinTorneo, cfg).roundLimitApplies, true);
});

test("MON003 · 59 — QUICK WIN 1: la copy sigue la regla del servidor, no la suya", () => {
  assert.ok(indexSrc.includes("offer.roundLimitApplies"));
  assert.ok(indexSrc.includes("y el torneo completo."));
  assert.ok(indexSrc.includes("Plus — jornadas sin torneo"),
    "el campo editable es el tope manual, y ahora lo dice");
});

test("MON003 · 60 — QUICK WIN 1: el enforcement NO cambió", () => {
  // La copy se corrigió; la regla es exactamente la misma que antes.
  const { checkLifecycleRoundConsumption, DEFAULT_COMMERCIAL_CONFIG } = require("../planLimits");
  const cfg = DEFAULT_COMMERCIAL_CONFIG;
  const plus = { plan: "PLUS", participantLimit: 50, manualRoundLimit: 18,
    competitionIdentity: "4350:2026-2027", scopeId: SCOPE };
  assert.equal(checkLifecycleRoundConsumption(plus, cfg, 500, 1, { currentScopeId: SCOPE }).allowed, true);
  const sinComp = { ...plus, competitionIdentity: null };
  assert.equal(checkLifecycleRoundConsumption(sinComp, cfg, 18, 1, { currentScopeId: SCOPE }).allowed, false);
});

// ==== 16 · Quick Win 2: la bandera de la Premier ===========================

test("MON003 · 61 — QUICK WIN 2: la Premier ya no lleva una bandera negra", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const line = readme.split("\n").find((l) => l.includes("Premier League"));
  assert.ok(line);
  assert.ok(!line.includes("\u{1F3F4}"),
    "U+1F3F4 a secas se pinta como un rectángulo negro en casi todas partes");
  assert.ok(line.includes("\u{1F1EC}\u{1F1E7}"), "se usa la bandera del Reino Unido, que sí renderiza");
});

// ==== 17 · el contrato de reintento con el proveedor =======================

test("MON003 · 62 — SERVER: un pago cobrado y NO aplicado devuelve 500, no 200", () => {
  // Un 200 le dice al proveedor "resuelto, no reintentes". Si el pago está
  // cobrado y el otorgamiento falló, eso deja a alguien que pagó sin su plan
  // hasta que un humano lo note. El 500 es lo que mantiene vivo el reintento.
  const src = stripComments(serverSrc);
  const hook = src.slice(src.indexOf("app.post(STRIPE_WEBHOOK_PATH, async"));
  const body = hook.slice(0, hook.indexOf("\n});"));
  assert.ok(body.includes("if (result.error)"));
  assert.ok(body.includes('res.status(500).json({ error: "unapplied_payment" })'));
  const tail = body.slice(body.indexOf("await confirmPaymentAndGrant"));
  const errAt = tail.indexOf("if (result.error)");
  const okAt = tail.indexOf("res.json({ received: true, handled: true })");
  assert.ok(errAt !== -1 && okAt !== -1);
  assert.ok(errAt < okAt, "el caso de error se decide antes de contestar que todo fue bien");
});

test("MON003 · 63 — SERVER: una decisión resuelta SÍ devuelve 200", () => {
  // Importe que no cuadra, torneo viejo o reentrega ya están correctamente
  // decididos: reintentarlos no cambiaría nada y sólo generaría ruido.
  const src = stripComments(serverSrc);
  const hook = src.slice(src.indexOf("app.post(STRIPE_WEBHOOK_PATH, async"));
  const body = hook.slice(0, hook.indexOf("\n});"));
  assert.ok(body.includes("res.json({ received: true, handled: true })"));
  assert.ok(body.includes("res.json({ received: true, handled: false })"),
    "y un evento que no escuchamos también se acepta, para que no se reintente para siempre");
});

test("MON003 · 64 — SERVER: la fila de compras conserva lo que ya tenía", () => {
  // El fallo que encontró la sonda: readPaymentIntents reconstruía la fila con
  // dos campos, así que cada `{ ...store }` borraba la auditoría entera.
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function readPaymentIntents"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes("...row,"), "se conserva la fila entera, no sólo los campos de interés");
  assert.ok(body.includes("audit: Array.isArray(row.audit) ? row.audit : []"));
});

test("MON003 · 65 — el webhook NO está limitado por tasa", () => {
  // Deliberado: el proveedor entrega legítimamente muchos eventos seguidos y
  // reintenta los que fallan. Limitarlo por tasa descartaría cobros reales.
  // La creación de checkout SÍ lo está, porque ahí quien llama es un navegador.
  const src = stripComments(serverSrc);
  assert.ok(!/app\.post\(STRIPE_WEBHOOK_PATH, rateLimit/.test(src));
  assert.ok(src.includes('app.post("/api/quinielas/:slug/checkout", rateLimit("checkout")'));
  assert.ok(src.includes('app.get("/api/quinielas/:slug/checkout/:purchaseId", rateLimit("checkout")'));
});

// ==== 18 · la vuelta del pago en un navegador de verdad ====================
//
// Los tres fallos que sólo aparecieron abriendo el navegador. Los tres tenían
// la misma consecuencia: alguien pagaba y la pantalla no se enteraba.

test("MON003 · 66 — VUELTA: no se exige una credencial que la recarga destruye", () => {
  // Volver del pago es una navegación completa: ownerPasswordCache y
  // currentUserPinCache mueren con la página. Lo que sobrevive es la cookie,
  // que es justo con lo que el servidor autoriza.
  const ui = stripComments(indexSrc);
  const fn = ui.slice(ui.indexOf("async function resolveCheckoutReturn"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  assert.ok(body.includes("currentUser && currentUser.isAdmin"),
    "se admite la sesión restaurada, no sólo la credencial en memoria");
  assert.ok(!/^\s*if\(!adminOrOwnerCred\(\)\) return;/m.test(body));
  // Y las peticiones llevan la cookie.
  assert.ok(ui.includes('credentials: "same-origin"'));
});

test("MON003 · 67 — VUELTA: se resuelve DESPUÉS de que render restaure la sesión", () => {
  const ui = stripComments(indexSrc);
  const boot = ui.slice(ui.indexOf("async function boot(attempt)"));
  assert.ok(/await render\(\);\s*resolveCheckoutReturn\(\)/.test(boot),
    "sin await, la confirmación arranca antes de saber quién volvió y se rinde en silencio");
});

test("MON003 · 68 — VUELTA: la señal se persiste ANTES de limpiar la URL", () => {
  // La app puede preguntar "¿Eres Ana?" antes de poder actuar. Si el parámetro
  // se consume ahí, se pierde para siempre: pagado y sin Plus.
  const ui = stripComments(indexSrc);
  const fn = ui.slice(ui.indexOf("async function resolveCheckoutReturn"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  const persistAt = body.indexOf("writePendingPurchase(purchaseId, cancelled)");
  const cleanAt = body.indexOf("window.history.replaceState");
  assert.ok(persistAt !== -1 && cleanAt !== -1);
  assert.ok(persistAt < cleanAt, "primero se guarda, después se limpia");
});

test("MON003 · 69 — VUELTA: se reintenta al confirmar la identidad", () => {
  const ui = stripComments(indexSrc);
  const at = ui.indexOf('getElementById("qz-session-yes")');
  assert.ok(at !== -1);
  const body = ui.slice(at, at + 900);
  assert.ok(body.includes("resolveCheckoutReturn()"),
    "ése es el primer instante en que se sabe que quien volvió es el organizador");
});

test("MON003 · 70 — VUELTA: una cancelación también se persiste y se cuenta", () => {
  const ui = stripComments(indexSrc);
  const fn = ui.slice(ui.indexOf("function writePendingPurchase"));
  assert.ok(fn.includes("cancelled: !!cancelled"), "la vuelta cancelada es una señal, no la ausencia de una");
  assert.ok(/No se hizo ning[úu]n cargo/.test(indexSrc));
});

test("MON003 · 71 — VUELTA: el pendiente caduca y se limpia en cada final", () => {
  const ui = stripComments(indexSrc);
  assert.ok(ui.includes("PENDING_PURCHASE_MAX_AGE_MS"),
    "sin caducidad, un pendiente irresoluble se preguntaría en cada carga para siempre");
  const fn = ui.slice(ui.indexOf("async function resolveCheckoutReturn"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  assert.equal((body.match(/clearPendingPurchase\(\)/g) || []).length, 3,
    "se limpia en los tres finales: pagado, fallido y cancelado");
});

// ==== 19 · orden de locks ==================================================

test("MON003 · 72 — LOCKS: las rutas de pago respetan el orden de siempre", () => {
  // platform_index -> platform_payment_intents -> platform_payment_log.
  // Tomarlos siempre en el mismo orden es lo que impide que dos transacciones
  // se bloqueen mutuamente; MON-003 extiende la cadena, no la reordena.
  const src = stripComments(serverSrc);
  const order = (body) => {
    const seen = [];
    const re = /getRowLocked\(\s*"([a-z_]+)"|readPaymentIntents\(client\)/g;
    let m;
    while ((m = re.exec(body))) {
      const key = m[1] || "platform_payment_intents";
      if (!seen.includes(key)) seen.push(key);
    }
    return seen;
  };
  const RANK = { platform_index: 0, platform_payment_intents: 1, platform_payment_log: 2 };

  const checkout = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const checkoutBody = checkout.slice(0, checkout.indexOf("\n});"));
  const confirm = src.slice(src.indexOf("async function confirmPaymentAndGrant"));
  const confirmBody = confirm.slice(0, confirm.indexOf("\n// ---------- el webhook"));

  for (const [name, body] of [["checkout", checkoutBody], ["confirm", confirmBody]]) {
    const seq = order(body).map((k) => RANK[k]);
    assert.ok(seq.length > 0, `${name} debería tomar algún lock`);
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] > seq[i - 1], `${name} toma los locks fuera de orden: ${order(body).join(" -> ")}`);
    }
  }
  assert.deepEqual(order(confirmBody),
    ["platform_index", "platform_payment_intents", "platform_payment_log"]);
});
