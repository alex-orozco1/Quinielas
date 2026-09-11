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

// Correction 01: una compra congela también los LÍMITES, no sólo el importe.
const SOLD = Object.freeze({ participantLimit: 50, manualRoundLimit: 18 });
const intentOf = (over = {}) => ({
  ...D.makePurchaseIntent({
    purchaseId: "qpur_a1", slug: "liga", scopeId: SCOPE, configVersion: 1,
    expectedAmountMinor: 19900, currency: "mxn", provider: "stripe", now: NOW,
    ...SOLD,
  }),
  ...over,
});
const observedOf = (over = {}) => ({
  purchaseId: "qpur_a1", sessionId: "cs_1", paymentIntentId: "pi_1",
  paid: true, amountMinor: 19900, currency: "mxn", terminalStatus: null, ...over,
});
// `quinielaExists` es explícito a propósito: cualquier cosa que no sea true
// cuenta como ausente. El caso por defecto de estas pruebas es que existe.
const decide = (intent, observed, currentScopeId = SCOPE, quinielaExists = true) =>
  D.evaluateConfirmation({ intent, observed, currentScopeId, quinielaExists });

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
    expectedAmountMinor: 19900, currency: "mxn", provider: "stripe", now: NOW, ...SOLD };
  assert.ok(D.makePurchaseIntent(base));
  assert.equal(D.makePurchaseIntent({ ...base, scopeId: null }), null, "sin torneo no hay compra");
  assert.equal(D.makePurchaseIntent({ ...base, expectedAmountMinor: 0 }), null);
  assert.equal(D.makePurchaseIntent({ ...base, expectedAmountMinor: 19900.5 }), null);
  assert.equal(D.makePurchaseIntent({ ...base, currency: "usd" }), null);
  assert.equal(D.makePurchaseIntent({ ...base, slug: "" }), null);
  // Correction 01: sin los límites tampoco hay compra. Vender sin saber qué se
  // vende es lo que obligaba a adivinarlo después leyendo la config de hoy.
  assert.equal(D.makePurchaseIntent({ ...base, participantLimit: undefined }), null);
  assert.equal(D.makePurchaseIntent({ ...base, manualRoundLimit: undefined }), null);
  assert.equal(D.makePurchaseIntent({ ...base, participantLimit: 0 }), null);
  assert.equal(D.makePurchaseIntent({ ...base, manualRoundLimit: -1 }), null);
  assert.equal(D.makePurchaseIntent({ ...base, participantLimit: 50.5 }), null);
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

// ==========================================================================
// CORRECTION 01
// ==========================================================================

// ==== 20 · el snapshot de lo vendido =======================================

test("MON003 · C1.1 — SNAPSHOT: una compra congela límites, precio y versión", () => {
  const i = intentOf();
  assert.deepEqual(i.purchased, {
    plan: "PLUS", participantLimit: 50, manualRoundLimit: 18,
    priceMinor: 19900, currency: "mxn", configVersion: 1,
    // Auditoría: si ya había competencia al comprar, el límite de jornadas no
    // será el que vivirá (un PLUS con torneo cubre el torneo entero).
    boundToCompetition: false,
  });
  // Congelado de verdad: el objeto no se puede reescribir en sitio.
  assert.ok(Object.isFrozen(i.purchased));
});

test("MON003 · C1.2 — SNAPSHOT: se traduce a lo que el entitlement necesita", () => {
  const snap = D.purchasedSnapshotOf(intentOf());
  assert.deepEqual(snap, { participantLimit: 50, manualRoundLimit: 18, pricePaidMXN: 199, configVersion: 1 });
});

test("MON003 · C1.3 — SNAPSHOT: un snapshot roto NO se rellena con nada", () => {
  assert.equal(D.purchasedSnapshotOf(intentOf({ purchased: null })), null);
  assert.equal(D.purchasedSnapshotOf(intentOf({ purchased: {} })), null);
  assert.equal(D.purchasedSnapshotOf(intentOf({
    purchased: { participantLimit: 50, manualRoundLimit: 18, priceMinor: 0 } })), null);
  // Y si el importe congelado y el del snapshot no coinciden, algo reescribió
  // uno de los dos: no hay forma honesta de elegir cuál.
  assert.equal(D.purchasedSnapshotOf(intentOf({
    purchased: { plan: "PLUS", participantLimit: 50, manualRoundLimit: 18,
      priceMinor: 29900, currency: "mxn", configVersion: 1 } })), null);
});

test("MON003 · C1.4 — SNAPSHOT: PLUS se construye desde números, no desde una config", () => {
  const { buildPurchasedPlusEntitlement, buildPlusEntitlement, DEFAULT_COMMERCIAL_CONFIG } = require("../planLimits");
  const e = buildPurchasedPlusEntitlement(
    { participantLimit: 50, manualRoundLimit: 18, pricePaidMXN: 199, configVersion: 1 },
    NOW, { source: "stripe_purchase", grantedBy: "stripe" });
  assert.equal(e.plan, "PLUS");
  assert.equal(e.participantLimit, 50);
  assert.equal(e.manualRoundLimit, 18);
  assert.equal(e.pricePaidMXN, 199);
  assert.equal(e.configVersionAtGrant, 1);
  assert.equal(e.source, "stripe_purchase");
  // La FORMA se define una sola vez: el constructor de siempre delega en éste,
  // así que la ruta de compra y la de grant manual no pueden divergir.
  const viaConfig = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, NOW, { source: "stripe_purchase", grantedBy: "stripe" });
  assert.deepEqual(Object.keys(e).sort(), Object.keys(viaConfig).sort());
  // Y un snapshot incompleto no produce un PLUS a medias.
  assert.equal(buildPurchasedPlusEntitlement({ participantLimit: 50 }, NOW, {}), null);
  assert.equal(buildPurchasedPlusEntitlement(null, NOW, {}), null);
});

test("MON003 · C1.5 — SNAPSHOT: la config NO se relee al confirmar", () => {
  // La raíz del blocker: confirmar llamaba buildPlusEntitlement(commercialConfig)
  // y por ahí entraban los límites de HOY.
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function confirmPaymentAndGrant"));
  const body = fn.slice(0, fn.indexOf("\n// ---------- el webhook"));
  assert.ok(!/commercial_config/.test(body),
    "la configuración comercial no puede entrar en la confirmación de un pago");
  assert.ok(!/buildPlusEntitlement\(/.test(body),
    "el constructor que toma una config no debe usarse aquí");
  assert.ok(body.includes("purchasedSnapshotOf(intent)"));
  assert.ok(body.includes("buildPurchasedPlusEntitlement(snapshot, now"));
});

test("MON003 · C1.6 — SNAPSHOT: el checkout exige la oferta ENTERA antes de vender", () => {
  // Correction 02 lo movió a readPlusOffer(), que devuelve la oferta completa o
  // null: así ninguna ruta puede quedarse con media oferta.
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("function readPlusOffer(commercialConfig)"));
  const body = fn.slice(0, fn.indexOf("function sameOffer"));
  assert.ok(body.includes("Number.isSafeInteger(plus.participantLimit)"));
  assert.ok(body.includes("Number.isSafeInteger(plus.manualRoundLimit)"));
  assert.ok(body.includes("amountMinor == null || amountMinor <= 0"));
  assert.ok(body.includes("return null"), "una oferta incompleta no es una oferta");
  // Los DOS sitios que abren una compra la usan; ninguno lee la config a mano.
  const usos = src.match(/readPlusOffer\(await getRow\("commercial_config", client\)\)/g) || [];
  assert.equal(usos.length, 2, "checkout y openPurchase, los dos");
  assert.ok(src.includes("participantLimit: offer.participantLimit"));
  assert.ok(src.includes("manualRoundLimit: offer.manualRoundLimit"));
});

test("MON003 · C1.7 — SNAPSHOT: sólo se reutiliza un checkout que venda LO MISMO", () => {
  // Con el precio solo no bastaba: la config puede cambiar los límites sin
  // tocar el importe, y reutilizar habría cobrado lo de antes prometiendo lo
  // de ahora.
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const cmp = src.slice(src.indexOf("function sameOffer(purchase, offer)"));
  const cmpBody = cmp.slice(0, cmp.indexOf("async function releaseReplacementClaim"));
  assert.ok(cmpBody.includes("purchase.expectedAmountMinor === offer.amountMinor"));
  assert.ok(cmpBody.includes("purchase.purchased.participantLimit === offer.participantLimit"));
  assert.ok(cmpBody.includes("purchase.purchased.manualRoundLimit === offer.manualRoundLimit"));
  assert.ok(body.includes("sameOffer(reusable, offer)"));
  assert.ok(!body.includes("reusable.expectedAmountMinor === amountMinor"),
    "no puede quedar ninguna comparación que mire sólo el importe");
});

test("MON003 · C1.8 — SNAPSHOT: sin snapshot utilizable el pago NO otorga nada", () => {
  const d = decide(intentOf({ purchased: null }), observedOf());
  assert.equal(d.decision, D.DECISION.SNAPSHOT_UNUSABLE);
  assert.equal(d.nextStatus, D.PURCHASE_STATUS.PAID, "el cobro existió y se registra");
  assert.equal(d.attention, D.ATTENTION.SNAPSHOT_UNUSABLE);
  const next = D.applyDecision(intentOf({ purchased: null }), d, observedOf(), NOW);
  assert.equal(next.status, "paid");
  assert.equal(next.attention.code, "purchase_snapshot_unusable");
});

// ==== 21 · quiniela eliminada =============================================

test("MON003 · C1.9 — BORRADA: la decisión la toma el dominio, no un parche después", () => {
  const d = decide(intentOf(), observedOf(), null, false);
  assert.equal(d.decision, D.DECISION.QUINIELA_MISSING);
  assert.equal(d.nextStatus, D.PURCHASE_STATUS.PAID);
  assert.equal(d.attention, D.ATTENTION.QUINIELA_MISSING);
});

test("MON003 · C1.10 — BORRADA: el attention SÍ queda en el intent persistido", () => {
  // La raíz del blocker: applyDecision corría ANTES de descubrir que la
  // quiniela no estaba, así que la anotación se escribía sobre un objeto ya
  // usado y no se persistía nunca.
  const d = decide(intentOf(), observedOf(), null, false);
  const next = D.applyDecision(intentOf(), d, observedOf(), NOW);
  assert.equal(next.status, "paid", "el dinero existió");
  assert.ok(next.attention, "y queda dicho que hay que mirarlo");
  assert.equal(next.attention.code, "paid_for_a_deleted_quiniela");
  // La auditoría lo explica con la misma palabra.
  const a = D.buildPaymentAudit(next, d.decision, "quiniela_missing", NOW);
  assert.equal(a.decision, "quiniela_missing");
  assert.equal(a.attention, "paid_for_a_deleted_quiniela");
});

test("MON003 · C1.11 — BORRADA: el código de atención describe el problema", () => {
  // El ticket lo pide explícitamente: no reutilizar IDENTITY_MISMATCH, que
  // describe otra cosa.
  assert.equal(D.ATTENTION.QUINIELA_MISSING, "paid_for_a_deleted_quiniela");
  assert.notEqual(D.ATTENTION.QUINIELA_MISSING, D.ATTENTION.IDENTITY_MISMATCH);
  const src = stripComments(serverSrc);
  assert.ok(!/quiniela_missing[\s\S]{0,200}IDENTITY_MISMATCH/.test(src));
  assert.ok(!/decision\.attention\s*=/.test(src),
    "la decisión no se corrige a posteriori en ninguna parte");
});

test("MON003 · C1.12 — BORRADA: un pago sin quiniela no se cuela por delante", () => {
  // El orden importa: sin quiniela no hay ciclo con el que comparar, así que
  // esta comprobación va antes que la del torneo.
  const d = decide(intentOf(), observedOf(), OTHER_SCOPE, false);
  assert.equal(d.decision, D.DECISION.QUINIELA_MISSING,
    "con la quiniela borrada, ése es el hecho que manda sobre el torneo viejo");
});

// ==== 22 · el pipeline, en orden ==========================================

test("MON003 · C1.13 — PIPELINE: la decisión está cerrada antes de aplicar", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function confirmPaymentAndGrant"));
  const body = fn.slice(0, fn.indexOf("\n// ---------- el webhook"));
  const decideAt = body.indexOf("paymentsDomain.evaluateConfirmation({");
  const applyAt = body.indexOf("paymentsDomain.applyDecision(");
  const grantAt = body.indexOf("applyEntitlementGrant({");
  const persistAt = applyAt + body.slice(applyAt).indexOf("putRow(PAYMENT_INTENTS_KEY,");
  assert.ok(decideAt !== -1 && applyAt !== -1 && grantAt !== -1);
  assert.ok(persistAt > applyAt, "tras aplicar el intent tiene que haber una escritura");
  assert.ok(decideAt < grantAt, "primero se decide");
  assert.ok(grantAt < applyAt, "la realidad de QRACKS se resuelve antes de aplicar el intent");
  assert.ok(applyAt < persistAt, "y sólo entonces se persiste");
  // La otra escritura, la de la salida temprana, retorna sin tocar el flujo
  // principal: no puede persistir un intent a medio decidir.
  const early = body.slice(0, decideAt);
  assert.ok(early.includes("DECISION.UNKNOWN_PURCHASE"));
  assert.ok(early.includes("return {"), "esa rama sale antes de decidir nada más");
});

test("MON003 · C1.14 — PIPELINE: la existencia de la quiniela entra en la decisión", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function confirmPaymentAndGrant"));
  const body = fn.slice(0, fn.indexOf("\n// ---------- el webhook"));
  assert.ok(body.includes("quinielaExists: !!entry"));
  // Y sale de la fila bloqueada, como el scope.
  assert.ok(body.includes('getRowLocked("platform_index", client)'));
});

test("MON003 · C1.15 — PIPELINE: quinielaExists se exige explícito", () => {
  // No se deduce de que no haya scope: una quiniela puede existir sin ciclo.
  // Cualquier cosa que no sea true cuenta como ausente.
  for (const v of [undefined, null, false, 0, "", "true", 1, {}]) {
    const d = D.evaluateConfirmation({ intent: intentOf(), observed: observedOf(), currentScopeId: SCOPE, quinielaExists: v });
    assert.equal(d.decision, D.DECISION.QUINIELA_MISSING, JSON.stringify(v));
  }
  assert.equal(D.evaluateConfirmation({ intent: intentOf(), observed: observedOf(), currentScopeId: SCOPE, quinielaExists: true }).decision,
    D.DECISION.CONFIRM);
});

test("MON003 · C1.16 — el orden de las decisiones es el correcto de arriba abajo", () => {
  const i = intentOf();
  const o = observedOf();
  // Un importe que no cuadra manda sobre todo lo demás: no se sabe ni qué se cobró.
  assert.equal(decide(i, { ...o, amountMinor: 1 }, null, false).decision, D.DECISION.AMOUNT_MISMATCH);
  // Un pago ya confirmado no se reevalúa aunque la quiniela haya desaparecido.
  assert.equal(decide(intentOf({ status: "paid" }), o, null, false).decision, D.DECISION.ALREADY_PAID);
  // Sin quiniela, eso manda sobre el torneo y sobre el snapshot.
  assert.equal(decide(intentOf({ purchased: null }), o, OTHER_SCOPE, false).decision, D.DECISION.QUINIELA_MISSING);
  // Con quiniela, el torneo viejo manda sobre el snapshot roto.
  assert.equal(decide(intentOf({ purchased: null }), o, OTHER_SCOPE, true).decision, D.DECISION.STALE_SCOPE);
});

test("MON003 · C1.17 — el binding a competencia NO se congela, y es deliberado", () => {
  // Respuesta a "¿queda algo más que se relea del estado mutable?": sí, el
  // competitionIdentity, que applyEntitlementGrant toma de la entitlement
  // ACTUAL (MON-002B). Es intencional: MON-001D lo adopta en la primera
  // importación, así que congelarlo castigaría a quien compra antes de elegir
  // liga. El precio de PLUS es el mismo con liga y sin ella, así que no hay
  // nada que pagar de menos — como mucho se recibe más. Se REGISTRA para que
  // sea visible en la auditoría en vez de deducirse.
  const sinLiga = D.makePurchaseIntent({
    purchaseId: "p", slug: "s", scopeId: SCOPE, configVersion: 1,
    expectedAmountMinor: 19900, currency: "mxn", provider: "stripe", now: NOW,
    ...SOLD, boundToCompetition: false });
  const conLiga = D.makePurchaseIntent({
    purchaseId: "p", slug: "s", scopeId: SCOPE, configVersion: 1,
    expectedAmountMinor: 19900, currency: "mxn", provider: "stripe", now: NOW,
    ...SOLD, boundToCompetition: true });
  assert.equal(sinLiga.purchased.boundToCompetition, false);
  assert.equal(conLiga.purchased.boundToCompetition, true);
  // Y NO entra en el snapshot de enforcement: no cambia los números aplicados.
  assert.deepEqual(D.purchasedSnapshotOf(sinLiga), D.purchasedSnapshotOf(conLiga));

  // El otro sentido —atado al comprar y desatado al confirmar— ya está cerrado
  // por otra vía: desatar sólo ocurre al iniciar un ciclo nuevo, y eso cambia
  // el scope, que la decisión rechaza antes de llegar a otorgar.
  assert.equal(decide(conLiga, observedOf({ purchaseId: "p" }), OTHER_SCOPE).decision,
    D.DECISION.STALE_SCOPE);
});

test("MON003 · C1.18 — el checkout registra el binding del momento de la compra", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function openPurchase(slug, superseded)"));
  assert.ok(fn.slice(0, 4000).includes("boundToCompetition: !!(entry.entitlement && entry.entitlement.competitionIdentity)"));
});

// ==== 23 · segunda pasada adversarial sobre los estados nuevos =============

test("MON003 · C1.19 — ni el navegador ni el proveedor determinan los límites", () => {
  const { buildPurchasedPlusEntitlement } = require("../planLimits");
  // Un observed que intenta colar sus propios números: el dominio no los mira,
  // y el entitlement sale del snapshot.
  const sucio = observedOf({ participantLimit: 9999, manualRoundLimit: 9999,
    purchased: { participantLimit: 9999 }, plan: "PLUS" });
  assert.equal(decide(intentOf(), sucio).decision, D.DECISION.CONFIRM);
  const e = buildPurchasedPlusEntitlement(D.purchasedSnapshotOf(intentOf()), NOW, {});
  assert.equal(e.participantLimit, 50);
  assert.equal(e.manualRoundLimit, 18);
  assert.equal(e.pricePaidMXN, 199);
});

test("MON003 · C1.20 — un snapshot cuyo precio no cuadra no otorga nada", () => {
  // Subir los límites a mano en la fila SIN tocar el precio congelado es la
  // forma que tendría un error (o una mano) de regalar capacidad. El importe
  // congelado y el del snapshot tienen que ser el mismo número.
  const manipulado = intentOf({ purchased: { plan: "PLUS", participantLimit: 9999,
    manualRoundLimit: 9999, priceMinor: 1, currency: "mxn", configVersion: 1 } });
  assert.equal(D.purchasedSnapshotOf(manipulado), null);
  assert.equal(decide(manipulado, observedOf()).decision, D.DECISION.SNAPSHOT_UNUSABLE);
});

test("MON003 · C1.21 — duplicados y fuera de orden sobre los estados nuevos", () => {
  for (const [nombre, intent] of [
    ["quiniela borrada", intentOf()],
    ["snapshot roto", intentOf({ purchased: null })],
  ]) {
    const existe = nombre === "snapshot roto";
    const d1 = decide(intent, observedOf(), existe ? SCOPE : null, existe);
    const tras = D.applyDecision(intent, d1, observedOf(), NOW);
    assert.equal(tras.status, "paid", nombre + ": el cobro se registra");
    assert.ok(tras.attention, nombre + ": con anotación");
    // Un segundo evento no lo reevalúa.
    assert.equal(decide(tras, observedOf(), existe ? SCOPE : null, existe).decision,
      D.DECISION.ALREADY_PAID, nombre + ": no se reevalúa");
    // Y un evento viejo no lo degrada ni borra la anotación.
    const viejo = decide(tras, observedOf({ paid: false, terminalStatus: "expired" }),
      existe ? SCOPE : null, existe);
    assert.equal(viejo.decision, D.DECISION.IGNORED_STALE, nombre + ": el evento viejo se ignora");
    const final = D.applyDecision(tras, viejo, {}, "2026-12-31T00:00:00.000Z");
    assert.equal(final.status, "paid", nombre + ": sigue cobrado");
    assert.deepEqual(final.attention, tras.attention, nombre + ": la anotación sobrevive");
  }
});

test("MON003 · C1.22 — el snapshot y la auditoría sobreviven a los reintentos", () => {
  let intent = intentOf();
  const d = decide(intent, observedOf());
  intent = D.applyDecision(intent, d, observedOf(), NOW);
  // Tres reintentos del mismo pago: el snapshot no se toca en ninguno.
  for (let i = 0; i < 3; i++) {
    const again = decide(intent, observedOf());
    assert.equal(again.decision, D.DECISION.ALREADY_PAID);
    intent = D.applyDecision(intent, again, observedOf(), NOW);
    assert.deepEqual(intent.purchased, intentOf().purchased, "el snapshot es intacto tras el reintento " + (i + 1));
  }
  const a = D.buildPaymentAudit(intent, D.DECISION.ALREADY_PAID, "already_on_plan", NOW);
  assert.equal(a.amountMinor, 19900);
  assert.equal(a.currency, "mxn");
});

test("MON003 · C1.23 — un pago que no puede otorgar nada nunca queda sin explicación", () => {
  // Las tres formas de "se cobró y no hay plan": las tres dejan estado paid,
  // anotación y una decisión con nombre. Ninguna queda muda.
  const casos = [
    [decide(intentOf(), observedOf(), OTHER_SCOPE, true), D.ATTENTION.STALE_SCOPE],
    [decide(intentOf(), observedOf(), null, false), D.ATTENTION.QUINIELA_MISSING],
    [decide(intentOf({ purchased: null }), observedOf(), SCOPE, true), D.ATTENTION.SNAPSHOT_UNUSABLE],
  ];
  for (const [d, code] of casos) {
    assert.equal(d.nextStatus, D.PURCHASE_STATUS.PAID, d.decision);
    assert.equal(d.attention, code, d.decision);
    const next = D.applyDecision(intentOf(), d, observedOf(), NOW);
    assert.equal(next.attention.code, code);
    assert.ok(D.buildPaymentAudit(next, d.decision, "none", NOW).attention);
  }
});

// ==========================================================================
// CORRECTION 02 — un solo objeto del proveedor cobrable por slug + torneo
// ==========================================================================

test("MON003 · C2.1 — el estado de una sesión se PREGUNTA, no se deduce", () => {
  assert.equal(D.sessionStateOf({ lifecycle: "chargeable" }), D.SESSION_STATE.CHARGEABLE);
  assert.equal(D.sessionStateOf({ lifecycle: "used" }), D.SESSION_STATE.USED);
  assert.equal(D.sessionStateOf({ lifecycle: "dead" }), D.SESSION_STATE.DEAD);
  // Un pago manda sobre el ciclo de vida: si cobró, se usó.
  assert.equal(D.sessionStateOf({ paid: true, lifecycle: "dead" }), D.SESSION_STATE.USED);
  // Y DESCONOCIDO cuenta como cobrable, nunca como muerto: es la diferencia
  // entre fallar cerrado y cobrar dos veces.
  for (const o of [null, undefined, {}, { lifecycle: "raro" }, { lifecycle: null }]) {
    assert.equal(D.sessionStateOf(o), D.SESSION_STATE.UNKNOWN, JSON.stringify(o));
  }
});

test("MON003 · C2.2 — el proveedor traduce sus tres estados, y nada más", () => {
  const mk = (status) => stripe.normalizeSession({ id: "cs", status, payment_status: "unpaid", metadata: {} });
  assert.equal(mk("open").lifecycle, "chargeable");
  assert.equal(mk("complete").lifecycle, "used");
  assert.equal(mk("expired").lifecycle, "dead");
  assert.equal(mk("algo_nuevo").lifecycle, "unknown", "un estado que no conocemos no es seguro");
  assert.equal(mk(undefined).lifecycle, "unknown");
  // El evento del webhook trae la misma traducción.
  const ev = stripe.normalizeEvent(sessionEvent({ status: "open", payment_status: "unpaid" }));
  assert.equal(ev.lifecycle, "chargeable");
});

test("MON003 · C2.3 — las candidatas son TODAS las que pueden cobrar, sin filtros de edad", () => {
  const viejo = intentOf({ id: "a", createdAt: "2020-01-01T00:00:00.000Z", providerSessionId: "cs_a" });
  const nuevo = intentOf({ id: "b", providerSessionId: "cs_b" });
  const pagada = intentOf({ id: "c", status: "paid", providerSessionId: "cs_c" });
  const sinSesion = intentOf({ id: "d" });
  const otroScope = intentOf({ id: "e", scopeId: OTHER_SCOPE, providerSessionId: "cs_e" });
  const todas = [viejo, nuevo, pagada, sinSesion, otroScope];
  const cands = D.chargeableCandidates(todas, "liga", SCOPE).map((c) => c.id);
  // La edad es NUESTRA contabilidad; la capacidad de cobrar es del proveedor.
  assert.deepEqual(cands.sort(), ["a", "b"], "el viejo entra igual: su sesión puede seguir viva");
  assert.ok(!cands.includes("c"), "una ya pagada no es candidata a morir");
  assert.ok(!cands.includes("e"), "y el invariant es por TORNEO, no por slug");
});

test("MON003 · C2.4 — no se abre otra si no se puede demostrar que la anterior murió", () => {
  const a = intentOf({ id: "a", providerSessionId: "cs_a" });
  assert.equal(D.planCheckoutReplacement([], {}).decision, "proceed", "sin anteriores, adelante");
  assert.equal(D.planCheckoutReplacement([a], { a: { lifecycle: "dead" } }).decision, "proceed");
  // Sin respuesta del proveedor -> bloqueado. Fail closed.
  assert.equal(D.planCheckoutReplacement([a], {}).decision, "blocked");
  assert.equal(D.planCheckoutReplacement([a], { a: null }).decision, "blocked");
  // Todavía cobrable tras intentar matarla -> bloqueado.
  assert.equal(D.planCheckoutReplacement([a], { a: { lifecycle: "chargeable" } }).decision, "blocked");
  // Ya usada -> hay que confirmarla, no abrir otra.
  const usada = D.planCheckoutReplacement([a], { a: { lifecycle: "used" } });
  assert.equal(usada.decision, "confirm_existing");
  assert.deepEqual(usada.used, ["a"]);
});

test("MON003 · C2.5 — una usada manda sobre una sin resolver", () => {
  const a = intentOf({ id: "a", providerSessionId: "cs_a" });
  const b = intentOf({ id: "b", providerSessionId: "cs_b" });
  const r = D.planCheckoutReplacement([a, b], { a: null, b: { lifecycle: "used" } });
  assert.equal(r.decision, "confirm_existing",
    "abrir otra sería ofrecer un segundo cargo por algo que ya se está pagando");
});

test("MON003 · C2.6 — un pago sobre una compra SUSTITUIDA no otorga nada", () => {
  // El P1 que encontró la sonda: `expired` significaba dos cosas —caducó sola,
  // y la matamos nosotros— y canAdvance("expired","paid") es true a propósito
  // para el cobro tardío legítimo. Una sustituida no lo es.
  const sust = intentOf({ status: "expired", supersededBy: "qpur_nueva" });
  const d = decide(sust, observedOf());
  assert.equal(d.decision, D.DECISION.SUPERSEDED_PURCHASE);
  assert.equal(d.attention, D.ATTENTION.SUPERSEDED);
  assert.equal(d.nextStatus, undefined, "no se inventa dinero: el estado no se toca");
  const next = D.applyDecision(sust, d, observedOf(), NOW);
  assert.equal(next.status, "expired");
  assert.equal(next.attention.code, "superseded_by_a_newer_checkout");
});

test("MON003 · C2.7 — pero una que caducó SOLA sí acepta un cobro tardío", () => {
  const caducada = intentOf({ status: "expired" });   // sin supersededBy
  assert.equal(decide(caducada, observedOf()).decision, D.DECISION.CONFIRM);
});

test("MON003 · C2.8 — el turno serializa, y caduca para no bloquear", () => {
  assert.equal(D.replacementKey("liga", SCOPE), "liga|" + SCOPE);
  assert.equal(D.replacementKey("liga", null), null);
  assert.equal(D.replacementKey("", SCOPE), null);
  const nowMs = Date.parse(NOW);
  assert.equal(D.isClaimActive({ at: NOW, token: "t" }, nowMs + 1000, 90000), true);
  assert.equal(D.isClaimActive({ at: NOW, token: "t" }, nowMs + 120000, 90000), false, "caduca");
  assert.equal(D.isClaimActive(null, nowMs, 90000), false);
  assert.equal(D.isClaimActive({ at: "no-es-fecha" }, nowMs, 90000), false);
  assert.equal(D.isClaimActive({ at: NOW }, nowMs - 5000, 90000), false, "un turno del futuro no vale");
});

// ---- el servidor: el invariant, estructuralmente ----

test("MON003 · C2.9 — SERVER: se demuestra la muerte antes de abrir otra", () => {
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const proveAt = body.indexOf("proveSessionsDead(candidates)");
  const openAt = body.indexOf("openPurchase(slug, candidates)");
  const netAt = body.indexOf("stripeAdapter.createCheckoutSession");
  assert.ok(proveAt !== -1 && openAt !== -1 && netAt !== -1);
  assert.ok(proveAt < openAt, "primero se mata lo anterior");
  assert.ok(openAt < netAt, "y la compra existe antes de pedir la sesión");
  // Las tres salidas que NO abren nada.
  assert.ok(body.includes('error: "payment_in_progress"'));
  assert.ok(body.includes('error: "replacement_in_progress"'));
  assert.ok(body.includes('error: "checkout_unavailable"'));
});

test("MON003 · C2.10 — SERVER: se consulta antes de expirar, y se verifica después", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function proveSessionsDead(candidates)"));
  const body = fn.slice(0, fn.indexOf("async function openPurchase"));
  const getAt = body.indexOf("retrieveCheckoutSession");
  const expAt = body.indexOf("expireCheckoutSession");
  assert.ok(getAt !== -1 && expAt !== -1);
  assert.ok(getAt < expAt,
    "Stripe sólo expira sesiones abiertas: preguntar primero evita depender de sus mensajes de error");
  assert.ok(body.includes("SESSION_STATE.CHARGEABLE"), "sólo se expira lo que está cobrable");
  // Y la decisión la toma el dominio con lo OBSERVADO, no con lo supuesto.
  assert.ok(body.includes("planCheckoutReplacement(candidates, observations)"));
  // Un error deja la observación en null, que el dominio lee como desconocido.
  assert.ok(body.includes("observed = null"));
});

test("MON003 · C2.11 — SERVER: el turno cubre TODA el alta y se suelta siempre", () => {
  // El segundo agujero: una compra recién creada sin sesión adjunta es
  // invisible para "¿qué puede cobrar?", pero está a punto de tener una. Dos
  // peticiones concurrentes creaban cada una la suya.
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const claimAt = body.indexOf("isClaimActive(claims[key]");
  const attachAt = body.indexOf("attachProviderSession(intent.id, session)");
  const releaseAt = body.indexOf("releaseReplacementClaim(claim)");
  assert.ok(claimAt !== -1 && attachAt !== -1 && releaseAt !== -1);
  assert.ok(claimAt < attachAt, "el turno se toma antes de decidir nada");
  assert.ok(attachAt < releaseAt, "y se suelta DESPUÉS de guardar la sesión, no antes");
  assert.ok(/\}\s*finally\s*\{\s*[\s\S]{0,400}releaseReplacementClaim/.test(body),
    "se suelta en un finally: por cualquier salida");
});

test("MON003 · C2.12 — SERVER: sólo se suelta el turno PROPIO", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function releaseReplacementClaim(claim)"));
  const body = fn.slice(0, fn.indexOf("async function proveSessionsDead"));
  assert.ok(body.includes("cur.token !== claim.token"),
    "si otro lo tomó entre medias, no es nuestro para soltarlo");
});

test("MON003 · C2.13 — SERVER: la compra nueva y las muertas, en UNA transacción", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function openPurchase(slug, superseded)"));
  const body = fn.slice(0, fn.indexOf("async function attachProviderSession"));
  assert.ok(body.includes('client.query("BEGIN")'));
  assert.ok(body.includes("supersededBy: fresh.id"), "queda dicho quién la sustituyó");
  assert.ok(body.includes("ATTENTION.SUPERSEDED"));
  assert.ok(body.includes('buildPaymentAudit(dead, "superseded"'), "y queda auditado");
  assert.ok(body.includes("purchases: purchases.concat([fresh])"));
  // Una sola escritura: no hay instante con dos compras abiertas ni con ninguna.
  assert.equal((body.match(/putRow\(PAYMENT_INTENTS_KEY,/g) || []).length, 1);
});

test("MON003 · C2.14 — SERVER: el navegador no decide cuál es la compra activa", () => {
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  assert.ok(!/req\.body/.test(body));
  assert.ok(!/req\.query/.test(body));
});

test("MON003 · C2.15 — el scope ilegible NO otorga, por ninguna vía", () => {
  const d = decide(intentOf(), observedOf(), null, true);
  assert.equal(d.decision, D.DECISION.SCOPE_UNPROVEN);
  assert.equal(d.nextStatus, D.PURCHASE_STATUS.PAID, "el cobro existió");
  assert.equal(d.attention, D.ATTENTION.SCOPE_UNPROVEN);
  // Con su propio código: no es un torneo VIEJO, es un torneo ILEGIBLE.
  assert.notEqual(D.ATTENTION.SCOPE_UNPROVEN, D.ATTENTION.STALE_SCOPE);
  assert.equal(D.ATTENTION.SCOPE_UNPROVEN, "current_tournament_unreadable");
  // Un scope id es SIEMPRE una cadena no vacía. Todo lo demás es ILEGIBLE, no
  // "otro torneo": coaccionar con String() hacía que un 0 se leyera como el
  // torneo "0" y se anotara como torneo VIEJO, mintiendo a quien lo lea después.
  for (const sc of [null, undefined, "", "   ", "\t\n", 0, false, NaN, {}, [], true, 123]) {
    const r = D.evaluateConfirmation({
      intent: intentOf(), observed: observedOf(), currentScopeId: sc, quinielaExists: true });
    assert.equal(r.decision, D.DECISION.SCOPE_UNPROVEN, JSON.stringify(String(sc)));
  }
  // Y un torneo legítimo distinto sigue siendo un torneo VIEJO, no ilegible.
  assert.equal(decide(intentOf(), observedOf(), OTHER_SCOPE, true).decision, D.DECISION.STALE_SCOPE);
  // Con espacios alrededor es el mismo torneo, no otro.
  assert.equal(decide(intentOf(), observedOf(), "  " + SCOPE + "  ", true).decision, D.DECISION.CONFIRM);
});

test("MON003 · C2.16 — el orden de decisiones sigue siendo el correcto", () => {
  const o = observedOf();
  // Sustituida manda sobre todo: ni se evalúa el resto.
  assert.equal(decide(intentOf({ supersededBy: "x", purchased: null }), o, null, false).decision,
    D.DECISION.SUPERSEDED_PURCHASE);
  // Importe que no cuadra, después.
  assert.equal(decide(intentOf(), { ...o, amountMinor: 1 }, null, false).decision, D.DECISION.AMOUNT_MISMATCH);
  // Sin quiniela, antes que el scope.
  assert.equal(decide(intentOf(), o, null, false).decision, D.DECISION.QUINIELA_MISSING);
  // Con quiniela y scope ilegible, antes que el snapshot roto.
  assert.equal(decide(intentOf({ purchased: null }), o, null, true).decision, D.DECISION.SCOPE_UNPROVEN);
  // Con scope legible pero distinto, el torneo viejo.
  assert.equal(decide(intentOf({ purchased: null }), o, OTHER_SCOPE, true).decision, D.DECISION.STALE_SCOPE);
});
