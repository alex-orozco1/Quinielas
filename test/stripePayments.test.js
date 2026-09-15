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

// Recorta el cuerpo de una función por su nombre, con las llaves. Existe porque
// los recortes por ancla de texto se han podrido tres veces en este archivo: un
// `indexOf` que devuelve -1 produce `slice(0, -1)`, que es CASI todo el fichero,
// y entonces la aserción pasa midiendo cualquier otra cosa. Aquí un ancla que no
// existe es un fallo, no un falso positivo.
function cuerpoDe(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at !== -1, `ancla inexistente: ${marker}`);
  const abre = src.indexOf("{", at);
  assert.ok(abre !== -1, `función sin cuerpo: ${marker}`);
  let depth = 0;
  for (let i = abre; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error(`cuerpo sin cerrar: ${marker}`);
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
  // Correction 07 afina esta prueba en vez de relajarla.
  //
  // Lo que había que impedir sigue impedido: una confirmación cuyo objeto de pago
  // pertenece a OTRA compra. Lo que ya no se confunde con eso es una HERMANA —otra
  // sesión del MISMO purchase, que existe de verdad cuando un reintento llegó a
  // crear dos—, porque tratarla como impostora perdía cobros legítimos y
  // verificables (reproducido contra eaa071b).
  //
  // La procedencia la da la metadata, y la metadata sólo la escribimos nosotros al
  // crear la sesión: por el webhook llega firmada con nuestro signing secret, y por
  // la reconciliación llega de un retrieve nuestro. Nadie de fuera puede escribirla
  // sin la clave secreta, y con la clave secreta este control no sería la defensa.
  const mine = intentOf({ providerSessionId: "cs_mine" });

  // 1. Dice ser de OTRA compra -> impostora.
  const ajena = decide(mine, observedOf({ purchaseId: "qpur_otra", sessionId: "cs_otra" }));
  assert.equal(ajena.decision, D.DECISION.IDENTITY_MISMATCH);
  assert.equal(ajena.attention, D.ATTENTION.IDENTITY_MISMATCH);

  // 2. Dice ser de OTRA quiniela -> impostora, aunque lleve nuestro id de compra.
  const otroSlug = decide(mine, observedOf({ sessionId: "cs_otra", slugHint: "otra-quiniela" }));
  assert.equal(otroSlug.decision, D.DECISION.IDENTITY_MISMATCH);

  // 3. NO declara de quién es, y su id no es ninguno de los que conocemos ->
  //    impostora: ahí el id es la única identidad que hay.
  const anonima = decide(mine, observedOf({ purchaseId: null, sessionId: "cs_otra" }));
  assert.equal(anonima.decision, D.DECISION.IDENTITY_MISMATCH);

  // 4. Una HERMANA legítima sí confirma —el dinero es real y es de esta compra— y
  //    queda anotado que hubo varias sesiones.
  const hermana = decide(mine, observedOf({ sessionId: "cs_hermana" }));
  assert.equal(hermana.decision, D.DECISION.CONFIRM);
  assert.equal(hermana.attention, D.ATTENTION.MANY_SESSIONS);
  assert.equal(hermana.sibling, "cs_hermana");

  // 5. Y una hermana NO puede colar otro importe, otra moneda ni otro torneo: esos
  //    controles corren igual y son los que protegen el dinero.
  assert.equal(decide(mine, observedOf({ sessionId: "cs_hermana", amountMinor: 1 })).decision,
    D.DECISION.AMOUNT_MISMATCH);
  assert.equal(decide(mine, observedOf({ sessionId: "cs_hermana", currency: "usd" })).decision,
    D.DECISION.CURRENCY_MISMATCH);
  assert.equal(decide(mine, observedOf({ sessionId: "cs_hermana" }), OTHER_SCOPE).decision,
    D.DECISION.STALE_SCOPE);
});

test("MON003 · 9 — FRAUDE: un segundo PaymentIntent no otorga, y se marca", () => {
  // Una hermana legítima tiene su PROPIO PaymentIntent, así que un `pi` distinto ya
  // no es por sí mismo una impostora. Lo que sí es: dos `pi` LIQUIDADOS para una
  // sola compra. Eso no otorga nada —ya está otorgado— y se anota como cargo doble,
  // que es lo que hay que devolver.
  const pagada = intentOf({ status: "paid", providerSessionId: "cs_mine", providerPaymentIntentId: "pi_mine" });
  const segundo = decide(pagada, observedOf({ sessionId: "cs_hermana", paymentIntentId: "pi_otro" }));
  assert.equal(segundo.decision, D.DECISION.ALREADY_PAID, "no se otorga dos veces");
  assert.equal(segundo.attention, D.ATTENTION.DOUBLE_CHARGE);
  assert.equal(segundo.sibling, "cs_hermana", "y la hermana se recuerda");

  // Una reentrega del MISMO pago sigue siendo un duplicado inofensivo.
  const reentrega = decide(pagada, observedOf({ sessionId: "cs_mine", paymentIntentId: "pi_mine" }));
  assert.equal(reentrega.decision, D.DECISION.ALREADY_PAID);
  assert.ok(!reentrega.attention, "una reentrega normal no es una anomalía");

  // Y sin identidad propia, un `pi` distinto sigue siendo impostora.
  const anonima = intentOf({ providerPaymentIntentId: "pi_mine" });
  assert.equal(decide(anonima, observedOf({ purchaseId: null, paymentIntentId: "pi_otro" })).decision,
    D.DECISION.IDENTITY_MISMATCH);
});

test("MON003 · 9b — la hermana se GUARDA, para que no vuelva a ser invisible", () => {
  const mine = intentOf({ providerSessionId: "cs_mine" });
  const d = decide(mine, observedOf({ sessionId: "cs_hermana" }));
  const next = D.applyDecision(mine, d, observedOf({ sessionId: "cs_hermana" }), NOW);
  assert.equal(next.providerSessionId, "cs_mine", "la primera NO se sustituye");
  assert.deepEqual(next.providerSessionIds, ["cs_hermana", "cs_mine"],
    "las dos quedan registradas, ordenadas");
  assert.equal(next.status, D.PURCHASE_STATUS.PAID, "y el cobro se registra");
  assert.equal(next.attention.code, D.ATTENTION.MANY_SESSIONS);
  // Y a partir de ahí el sistema SABE que hubo varias, así que exige descubrimiento.
  assert.equal(D.needsSessionDiscovery(next), true);
  // Una tercera se suma sin perder las anteriores.
  const tercera = D.applyDecision(next, { decision: "confirm", sibling: "cs_tercera" },
    observedOf({ sessionId: "cs_tercera" }), NOW);
  assert.deepEqual(tercera.providerSessionIds, ["cs_hermana", "cs_mine", "cs_tercera"]);
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
  // Confirma PREGUNTANDO, no creyendo: el descubrimiento es el que pregunta, y
  // dentro de él cada candidata se consulta al proveedor.
  assert.ok(body.includes("locateSessionForPurchase(intent, hint)"),
    "confirma preguntando, no creyendo");
  const loc = cuerpoDe(src, "async function locateSessionForPurchase(intent, hint)");
  assert.ok(loc.includes("retrieveCheckoutSession(sessionId)"));
  assert.ok(body.includes("confirmPaymentAndGrant"),
    "y usa el MISMO camino de confirmación que el webhook, no uno más laxo");

  // Correction 05: ahora SÍ se lee algo de la query — una PISTA del id de sesión.
  // El invariante no es "no se lee la query", que era sólo una forma cómoda de
  // comprobarlo: es que nada de lo que venga del navegador pueda decidir. Se
  // fija eso directamente.
  const leidos = [...body.matchAll(/req\.query(?:\s*&&\s*req\.query)?\.([A-Za-z_$][\w$]*)/g)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(leidos)], ["sess"],
    "lo ÚNICO que se lee del navegador es la pista del id de sesión");
  // Y esa pista pasa por el filtro de forma y por la verificación contra la
  // compra antes de que nadie la adjunte.
  const hintAt = body.indexOf("readSessionHint(req.query && req.query.sess)");
  assert.ok(hintAt !== -1, "la pista se filtra, no se usa cruda");
  const locateAt = body.indexOf("locateSessionForPurchase(intent, hint)");
  assert.ok(locateAt > hintAt, "y se resuelve por el camino que la verifica");
  // Correction 07: esta ruta OTORGA, así que descubre siempre — nunca se queda con
  // el id guardado, que no demuestra que no exista una hermana con el dinero.
  assert.ok(!/retrieveCheckoutSession\(intent\.providerSessionId\)/.test(body),
    "un id guardado no puede cortocircuitar el descubrimiento en la ruta que otorga");
  assert.ok(body.indexOf("attachProviderSession") > locateAt,
    "sólo se adjunta DESPUÉS de localizar y verificar");
  // El importe, el plan y el estado no pueden venir de la query por ninguna vía.
  for (const prohibido of ["req.query.amount", "req.query.status", "req.query.plan",
    "req.query.paid", "req.query.purchase"]) {
    assert.ok(!body.includes(prohibido), prohibido + " jamás");
  }
  // Y este endpoint NO vende: un GET no puede crear una sesión.
  assert.ok(!body.includes("createSessionFor"), "un GET no crea checkouts");
  assert.ok(!body.includes("createCheckoutSession"));
});

test("MON003 · 47b — la pista del navegador se verifica CONTRA la compra", () => {
  // Correction 05. La pista puede ser inventada, de otra compra, de otra
  // quiniela, de otro torneo o de otro importe. Ninguna de esas adjunta nada.
  const intent = intentOf();
  const buena = {
    sessionId: "cs_ok", purchaseId: intent.id, clientReferenceId: intent.id,
    metadataPurchaseId: intent.id, slugHint: intent.slug, scopeHint: intent.scopeId,
    amountMinor: intent.expectedAmountMinor, currency: "mxn",
  };
  const M = D.SESSION_MATCH;
  assert.equal(D.verifySessionForPurchase(intent, buena).reason, M.OK);
  const casos = [
    [{ purchaseId: null, clientReferenceId: null, metadataPurchaseId: null }, M.NO_IDENTITY],
    [{ purchaseId: "qpur_otra", clientReferenceId: "qpur_otra", metadataPurchaseId: "qpur_otra" }, M.OTHER_PURCHASE],
    [{ clientReferenceId: "qpur_otra" }, M.OTHER_PURCHASE],
    [{ slugHint: "otra-quiniela" }, M.OTHER_SLUG],
    [{ scopeHint: OTHER_SCOPE }, M.OTHER_SCOPE],
    [{ amountMinor: 100 }, M.AMOUNT],
    [{ amountMinor: null }, M.AMOUNT],
    [{ currency: "usd" }, M.CURRENCY],
    [{ currency: null }, M.CURRENCY],
    [{ sessionId: "" }, M.NO_SESSION],
    [{ sessionId: null }, M.NO_SESSION],
  ];
  for (const [over, esperado] of casos) {
    assert.equal(D.verifySessionForPurchase(intent, { ...buena, ...over }).reason, esperado,
      JSON.stringify(over));
  }
  // Ni una sesión inexistente ni basura.
  for (const nada of [null, undefined, {}, "cs_x", 0, []]) {
    assert.equal(D.verifySessionForPurchase(intent, nada).ok, false, JSON.stringify(nada));
  }
  // Y sin compra no se verifica nada.
  assert.equal(D.verifySessionForPurchase(null, buena).ok, false);
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
  // Correction 03 movió la llamada a createSessionFor(); lo que importa sigue
  // siendo que NINGUNA transacción del endpoint la contenga.
  const commitAt = body.indexOf('await client.query("COMMIT")');
  const netAt = body.indexOf("createSessionFor(intent, slug)");
  assert.ok(commitAt !== -1 && netAt !== -1);
  assert.ok(commitAt < netAt,
    "un tercero lento dentro de la transacción bloquea filas durante todo su round-trip");
  // Y ni createSessionFor ni resolveOpenIntent abren transacción propia alrededor
  // de la red: las escrituras van en funciones aparte.
  for (const fnName of ["async function createSessionFor(intent, slug)", "async function resolveOpenIntent(intent, currentOffer)"]) {
    const fn = src.slice(src.indexOf(fnName));
    const fnBody = fn.slice(0, fn.indexOf("\nasync function ", 10));
    assert.ok(!fnBody.includes('client.query("BEGIN")'), fnName + " no debe abrir transacción");
  }
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

// Correction 05 partió la vuelta en dos: `resolveCheckoutReturn` decide QUÉ
// compra mirar y `runCheckoutRecovery` la confirma. Las dos son la misma
// historia, así que los invariantes de la vuelta se comprueban sobre el par.
function vueltaSrc() {
  const ui = stripComments(indexSrc);
  const uno = ui.slice(ui.indexOf("async function resolveCheckoutReturn"));
  const dos = ui.slice(ui.indexOf("async function runCheckoutRecovery"));
  return uno.slice(0, uno.indexOf("\n  }\n")) + "\n" + dos.slice(0, dos.indexOf("\n  }\n"));
}

test("MON003 · 57 — UI: la vuelta del checkout confirma contra el servidor", () => {
  const body = vueltaSrc();
  assert.ok(body.includes("readCheckoutStatus"), "pregunta al servidor");
  assert.ok(/Estamos confirmando tu pago/.test(indexSrc));
  // La pantalla NUNCA decide que se pagó: lo único que mira es el estado que
  // devuelve el servidor.
  assert.ok(body.includes('status.status === "paid"'));
  assert.ok(!/qz_sess[^)]*paid|paid\s*=\s*true/.test(body),
    "ningún parámetro de la URL declara un pago");
  // Correction 05: la vuelta puede traer una PISTA del id de sesión, y se pasa
  // al servidor como tal. Que el navegador la ponga no la convierte en verdad:
  // el servidor la verifica (ver MON003 · 47 y 47b).
  assert.ok(body.includes('params.get("qz_sess")'), "se recoge la pista");
  assert.ok(/\/\^cs_\[A-Za-z0-9_\]\{1,200\}\$\//.test(body),
    "y se filtra su forma antes de mandarla");
  assert.ok(body.includes("readCheckoutStatus(purchaseId, sessionHint)"),
    "viaja al servidor, que es quien puede comprobarla");
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
  const body = vueltaSrc();
  const persistAt = body.indexOf("writePendingPurchase(purchaseId, cancelled, sessionHint)");
  const cleanAt = body.indexOf("window.history.replaceState");
  assert.ok(persistAt !== -1 && cleanAt !== -1);
  assert.ok(persistAt < cleanAt, "primero se guarda, después se limpia");
  // Y se limpian los TRES parámetros, incluida la pista nueva.
  assert.ok(body.includes('"qz_pago", "qz_pago_cancelado", "qz_sess"'));
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
  const body = vueltaSrc();
  assert.equal((body.match(/clearPendingPurchase\(\)/g) || []).length, 3,
    "se limpia en los tres finales: pagado, fallido y cancelado");
  // Y NO se limpia cuando el cobro sigue en proceso: ahí queda algo por
  // resolver y borrarlo perdería la única pista para retomarlo.
  const enProceso = body.indexOf("Tu pago sigue en proceso");
  assert.ok(enProceso !== -1);
  assert.ok(!body.slice(enProceso).includes("clearPendingPurchase"),
    "un cobro sin resolver no se olvida");
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
  assert.equal(usos.length, 2, "el endpoint y openPurchase, los dos bajo lock");
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
  const cmpBody = cmp.slice(0, cmp.indexOf("async function "));
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

test("MON003 · C2.3 — una compra abierta cuenta AUNQUE no sepamos su sesión", () => {
  // El P1 de Correction 03: exigir providerSessionId hacía invisible a la compra
  // cuya creación remota se envió y cuya respuesta se perdió. "No tengo guardado
  // el id" no es "no existe una sesión allá".
  const sinSesion = intentOf({ id: "a", providerSessionId: null, creationAttemptedAt: NOW });
  const conSesion = intentOf({ id: "b", providerSessionId: "cs_b" });
  const vieja = intentOf({ id: "c", createdAt: "2020-01-01T00:00:00.000Z", providerSessionId: "cs_c" });
  const pagada = intentOf({ id: "d", status: "paid", providerSessionId: "cs_d" });
  const muerta = intentOf({ id: "e", status: "expired", providerSessionId: "cs_e" });
  const otroScope = intentOf({ id: "f", scopeId: OTHER_SCOPE, providerSessionId: "cs_f" });
  const abiertas = D.openIntentsForScope(
    [sinSesion, conSesion, vieja, pagada, muerta, otroScope], "liga", SCOPE).map((x) => x.id);
  assert.deepEqual(abiertas.sort(), ["a", "b", "c"],
    "abiertas es abiertas: con sesión, sin sesión, y vieja también");
  assert.ok(!abiertas.includes("d"), "una pagada no está abierta");
  assert.ok(!abiertas.includes("e"), "ni una terminal");
  assert.ok(!abiertas.includes("f"), "y el invariant es por TORNEO, no por slug");
});

test("MON003 · C2.4 — no se abre otra si no se puede demostrar que la anterior murió", () => {
  const OI = D.OPEN_INTENT;
  assert.equal(D.classifyOpenIntent({ lifecycle: "dead" }, true), OI.DEAD);
  assert.equal(D.classifyOpenIntent({ lifecycle: "used" }, true), OI.USED);
  assert.equal(D.classifyOpenIntent({ paid: true, lifecycle: "dead" }, true), OI.USED,
    "si cobró, se usó, aunque su ciclo diga otra cosa");
  // Cobrable y vendiendo lo mismo -> sirve tal cual: se devuelve su enlace.
  assert.equal(D.classifyOpenIntent({ lifecycle: "chargeable" }, true), OI.USABLE);
  // Cobrable pero vendiendo otra cosa -> hay que matarla primero.
  assert.equal(D.classifyOpenIntent({ lifecycle: "chargeable" }, false), OI.MUST_EXPIRE);
  // Sin respuesta del proveedor -> no se puede demostrar nada. Fail closed.
  for (const o of [null, undefined, {}, { lifecycle: "algo_nuevo" }]) {
    assert.equal(D.classifyOpenIntent(o, true), OI.UNRESOLVED, JSON.stringify(o));
  }
});

test("MON003 · C2.5 — sólo 'muerta' o 'usada' permiten seguir adelante", () => {
  const OI = D.OPEN_INTENT;
  // Es el contrato que usa el servidor: cualquier otra cosa bloquea el alta.
  const permiteSeguir = (o, m) => [OI.DEAD, OI.USED, OI.USABLE].includes(D.classifyOpenIntent(o, m));
  assert.equal(permiteSeguir({ lifecycle: "dead" }, true), true);
  assert.equal(permiteSeguir({ lifecycle: "used" }, true), true);
  assert.equal(permiteSeguir({ lifecycle: "chargeable" }, true), true, "sirve tal cual");
  assert.equal(permiteSeguir({ lifecycle: "chargeable" }, false), false, "antes hay que matarla");
  assert.equal(permiteSeguir(null, true), false);
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

test("MON003 · C2.9 — SERVER: toda compra abierta se resuelve antes de abrir otra", () => {
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const resolveAt = body.indexOf("resolveOpenIntent(a, offer, reusable)");
  const decideAt = body.indexOf("decideOpenSet(resolved)");
  const openAt = body.indexOf("openPurchase(slug, dead)");
  const netAt = body.indexOf("createSessionFor(intent, slug)");
  assert.ok(resolveAt !== -1 && decideAt !== -1 && openAt !== -1 && netAt !== -1);
  assert.ok(resolveAt < decideAt, "primero se clasifica TODO lo abierto");
  assert.ok(decideAt < openAt, "y sólo entonces se decide");
  assert.ok(openAt < netAt, "y la compra existe antes de pedir la sesión");
  // Se itera TODO lo abierto, no sólo lo primero.
  assert.ok(body.includes("for (const a of open)"));
  // Y las cuatro salidas están contempladas.
  assert.ok(body.includes("OPEN_SET.REUSE"));
  assert.ok(body.includes("OPEN_SET.CONFIRM_EXISTING"));
  assert.ok(body.includes("OPEN_SET.OPEN_NEW"));
  assert.ok(body.includes("OPEN_INTENT.DEAD"));
  assert.ok(body.includes('error: "payment_in_progress"'));
  assert.ok(body.includes('error: "replacement_in_progress"'));
  assert.ok(body.includes('error: "checkout_unavailable"'));
});

test("MON003 · C2.10 — SERVER: reanudar usa la MISMA clave, y se verifica la muerte", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function resolveOpenIntent(intent, currentOffer, reusable = true)"));
  const body = fn.slice(0, fn.indexOf("\nasync function ", 10));
  // El paso que cierra Correction 03: sin sesión conocida, se REANUDA la creación
  // con la clave de esa compra en vez de dar por hecho que no existe ninguna.
  const resumeAt = body.indexOf("createSessionFor(intent, intent.slug)");
  assert.ok(resumeAt !== -1, "una compra sin sesión guardada se reanuda, no se ignora");
  assert.ok(body.indexOf("if (!sessionId)") < resumeAt);
  // Después se consulta la verdad fresca y se clasifica con lo OBSERVADO.
  assert.ok(body.includes("retrieveCheckoutSession(sessionId)"));
  assert.ok(body.includes("classifyOpenIntent(observed, matches)"));
  // Y al expirar se vuelve a clasificar: no se supone que quedó muerta.
  const expAt = body.indexOf("expireCheckoutSession(sessionId)");
  assert.ok(expAt !== -1);
  assert.ok(body.indexOf("classifyOpenIntent(afterExpire, matches)") > expAt);
  assert.ok(body.includes("OPEN_INTENT.UNRESOLVED"), "si tras expirar no consta muerta, se bloquea");
  // La clave es el id de compra, y los parámetros son los CONGELADOS.
  const mk = src.slice(src.indexOf("async function createSessionFor(intent, slug)"));
  const mkBody = mk.slice(0, mk.indexOf("\nasync function ", 10));
  assert.ok(mkBody.includes("idempotencyKey: attempt.idempotencyKey"),
    "la clave sale del INTENTO, congelada con sus parametros");
  assert.ok(mkBody.includes("amountMinor: intent.expectedAmountMinor"));
  assert.ok(!mkBody.includes("commercial_config"), "nunca la oferta de hoy: sería otra venta");
});

test("MON003 · C2.11 — SERVER: el turno cubre TODA el alta y se suelta siempre", () => {
  // El segundo agujero: una compra recién creada sin sesión adjunta es
  // invisible para "¿qué puede cobrar?", pero está a punto de tener una. Dos
  // peticiones concurrentes creaban cada una la suya.
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const claimAt = body.indexOf("isClaimActive(claims[key]");
  const attachAt = body.indexOf("attachProviderSession(intent.id, session,");
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
  const end = fn.indexOf("\nasync function ", 10);
  assert.ok(end > 0, "el ancla de fin de función tiene que existir de verdad");
  const body = fn.slice(0, end);
  assert.ok(body.includes("cur.token !== claim.token"),
    "si otro lo tomó entre medias, no es nuestro para soltarlo");
});

test("MON003 · C2.13 — SERVER: la compra nueva y las muertas, en UNA transacción", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function openPurchase(slug, superseded)"));
  const body = fn.slice(0, fn.indexOf("async function createSessionFor"));
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

// ==== 17 · Correction 03: una sesión perdida no crea una segunda cobrable ===
//
// El agujero era una suposición: "no tengo `providerSessionId` guardado" se leía
// como "no existe ninguna Session en el proveedor". No es lo mismo. Entre que se
// envía la creación y que se guarda el id hay una respuesta que puede perderse,
// una red que puede cortarse y un proceso que puede morir — y en los tres casos
// allá puede haber una sesión cobrable que aquí era INVISIBLE.

test("MON003 · C3.1 — una compra abierta SIN sesión conocida sigue siendo la barrera", () => {
  // Es el caso exacto del bug: se pidió la creación (queda constancia), la
  // respuesta se perdió, no hay id guardado. Antes desaparecía del censo.
  const perdida = intentOf({ id: "a", providerSessionId: null, providerCheckoutUrl: null,
    creationAttemptedAt: NOW });
  const abiertas = D.openIntentsForScope([perdida], "liga", SCOPE);
  assert.equal(abiertas.length, 1, "existe, y por tanto bloquea");
  assert.equal(abiertas[0].id, "a");
});

test("MON003 · C3.2 — ni siquiera hace falta saber si se pidió la creación", () => {
  // `creationAttemptedAt` es AUDITORÍA. La barrera no depende de él, porque
  // reanudar con la misma clave es correcto en los dos casos: si allá existe
  // sesión, la devuelve; si no, la crea. Una sola, de cualquier manera.
  const nunca = intentOf({ id: "a", providerSessionId: null, creationAttemptedAt: null });
  const quizas = intentOf({ id: "b", providerSessionId: null, creationAttemptedAt: NOW });
  assert.equal(D.openIntentsForScope([nunca, quizas], "liga", SCOPE).length, 2);
});

test("MON003 · C3.3 — una compra nace con la constancia en blanco", () => {
  const i = intentOf();
  assert.equal(i.creationAttemptedAt, null);
  assert.equal(i.providerSessionId, null);
  assert.equal(i.providerCheckoutUrl, null);
  // Y el campo NO entra en lo comprado: no es parte de la venta.
  assert.ok(!("creationAttemptedAt" in i.purchased));
});

test("MON003 · C3.4 — el proveedor devuelve el estado de la sesión al crearla", () => {
  // Sin esto, reanudar una compra perdida exigiría una consulta extra; con la
  // clave repetida la propia respuesta de creación YA es la sesión que existía.
  const src = stripComments(
    fs.readFileSync(path.join(__dirname, "..", "payments", "stripeAdapter.js"), "utf8"));
  const fn = src.slice(src.indexOf("async function createCheckoutSession({"));
  const body = fn.slice(0, fn.indexOf("\nasync function ", 10));
  assert.ok(body.includes("observed: normalizeSession(session)"));
  assert.ok(body.includes("idempotencyKey"), "y la clave viaja al proveedor");
});

test("MON003 · C3.5 — SERVER: la barrera se vuelve a comprobar BAJO EL CANDADO", () => {
  // La pregunta del ticket: ¿puede un segundo request tomar el turno caducado
  // mientras el primero sigue vivo? Sí. El turno es coordinación y caduca. Por
  // eso la condición se repite en la MISMA transacción que inserta, serializada
  // sobre platform_index: el segundo no abre nada.
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function openPurchase(slug, superseded)"));
  const body = fn.slice(0, fn.indexOf("async function createSessionFor"));
  const lockAt = body.indexOf('getRowLocked("platform_index", client)');
  const checkAt = body.indexOf("openIntentsForScope(store.purchases, slug, scope.id)");
  const insertAt = body.indexOf("purchases.concat([fresh])");
  assert.ok(lockAt !== -1 && checkAt !== -1 && insertAt !== -1);
  assert.ok(lockAt < checkAt, "se comprueba con el candado tomado, no antes");
  assert.ok(checkAt < insertAt, "y antes de insertar");
  // Las que se acaban de demostrar muertas no cuentan: son las que va a matar.
  assert.ok(body.includes("filter((p) => !deadIds.has(p.id))"));
  assert.ok(body.includes('error: "replacement_in_progress"'),
    "el segundo reintenta; encontrará la compra del primero y la reanudará");
  // Y todo en la misma transacción que el COMMIT del alta.
  assert.ok(body.indexOf('client.query("BEGIN")') < checkAt);
});

test("MON003 · C3.6 — SERVER: la compra se persiste ANTES de hablar con el proveedor", () => {
  // Es lo que hace que morir entre "el proveedor la creó" y "nosotros la
  // guardamos" sea inofensivo: la compra ya está en la fila, así que el
  // siguiente intento la ve, la reanuda con su clave y recibe la MISMA sesión.
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const openAt = body.indexOf("openPurchase(slug, dead)");
  const netAt = body.indexOf("createSessionFor(intent, slug)");
  const attachAt = body.indexOf("attachProviderSession(intent.id, session,");
  assert.ok(openAt !== -1 && netAt !== -1 && attachAt !== -1);
  assert.ok(openAt < netAt && netAt < attachAt);
});

test("MON003 · C3.7 — SERVER: un fallo al guardar la sesión NO rompe el invariant", () => {
  // La pregunta del ticket: ¿depende la seguridad de que attachProviderSession
  // nunca falle? No. Su fallo se registra y se sigue: la compra queda abierta
  // sin sesión conocida, que es precisamente el estado que ahora bloquea y se
  // reanuda. Lo que NO se hace es cancelarla ni abrir otra.
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const tail = body.slice(body.indexOf("attachProviderSession(intent.id, session,"));
  assert.ok(tail.includes("checkout_session_persist_failed"), "queda registrado");
  assert.ok(tail.includes("err && err.message"), "y con el motivo, no en silencio");
  assert.ok(!tail.includes("createSessionFor"), "no se pide otra sesión");
  assert.ok(!tail.includes("openPurchase"), "ni se abre otra compra");
});

test("MON003 · C3.8 — SERVER: reanudar guarda la sesión recuperada, sin depender de ello", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function resolveOpenIntent(intent, currentOffer, reusable = true)"));
  const body = fn.slice(0, fn.indexOf("\nasync function ", 10));
  assert.ok(/attachProviderSession\(intent\.id, \{ sessionId, url \},/.test(body),
    "si guardar falla, se sigue: la próxima vez se vuelve a localizar");
  assert.ok(body.includes("verifiedAttempts"),
    "y se anota con cuántos intentos se demostró la unicidad");
  assert.ok(body.includes("checkout_session_recovered"), "y queda constancia del rescate");
  // Correction 05: PRIMERO se localiza, y sólo se crea si se demostró que no
  // existe nada. Crear a ciegas es lo que dependía de la retención de la clave.
  const locateAt = body.indexOf("locateSessionForPurchase(intent, null)");
  const createAt = body.indexOf("createSessionFor(intent, intent.slug)");
  assert.ok(locateAt !== -1 && createAt !== -1);
  assert.ok(locateAt < createAt, "localizar antes de crear");
  assert.ok(body.includes("found.absent"), "y crear SÓLO ante una ausencia demostrada");
  // La verdad del estado se pide SIEMPRE fresca.
  assert.ok(body.indexOf("retrieveCheckoutSession(sessionId)") > createAt);
});

test("MON003 · C3.9 — la marca de creación es una PRECONDICIÓN, no una nota", () => {
  // Correction 06 invierte esta prueba a propósito. En C03 el campo era auditoría
  // y lo correcto era que su fallo no bloqueara nada. En C05 pasó a sostener la
  // afirmación "sin marca no puede haber sesión", y desde entonces un fallo
  // silencioso en su escritura es justo lo que abre un segundo cobro.
  const src = stripComments(serverSrc);
  const mkBody = cuerpoDe(src, "async function createSessionFor(intent, slug)");
  // Se marca ANTES de la red, y SIN red de escape.
  assert.ok(mkBody.includes("await recordCreationAttempt(intent.id, Date.now());"));
  assert.ok(!/recordCreationAttempt\([^)]*\)\.catch\(/.test(mkBody),
    "un .catch aquí convierte la afirmación en una mentira posible");
  assert.ok(mkBody.indexOf("recordCreationAttempt") < mkBody.indexOf("createCheckoutSession"),
    "primero la marca durable, después la petición");

  // Y la propia marca LANZA cuando no consigue quedar escrita, incluido el caso
  // en que la compra no está en la fila.
  const mark = cuerpoDe(src, "async function recordCreationAttempt(purchaseId, nowMs)");
  assert.ok(mark.includes('throw new Error("creation_marker_purchase_missing")'),
    "marcar algo que no existe no es un éxito");
  assert.ok(mark.includes('await client.query("COMMIT")'), "y se commitea de verdad");
  assert.ok(mark.includes("throw err"), "cualquier fallo sube");
  // Nunca reescribe: la primera marca es la que acota la ventana.
  assert.ok(mark.includes("isAttemptReusable(\n"), "se comprueba si la identidad anterior sirve");

  // NADA decide en función de ese campo salvo el descubrimiento, que es su razón
  // de ser.
  const locate = cuerpoDe(src, "async function locateSessionForPurchase(intent, hint)");
  // Correction 07: el descubrimiento ya no lee el campo a mano, usa las ventanas de
  // intento que el dominio deriva de él (y del legado).
  assert.ok(locate.includes("discoveryWindows(intent, SESSION_LOOKUP_MARGIN_MS)"));
  const dom = stripComments(
    fs.readFileSync(path.join(__dirname, "..", "payments", "paymentsDomain.js"), "utf8"));
  assert.ok(cuerpoDe(dom, "function creationAttemptsOf(intent)").includes("intent.creationAttemptedAt"),
    "el campo legado sigue contando como el primer intento");
});

test("MON003 · C3.10 — el dominio no exige saber la sesión para contar una compra", () => {
  // Prueba de regresión del P1: si alguien vuelve a añadir el filtro, esto cae.
  const src = stripComments(
    fs.readFileSync(path.join(__dirname, "..", "payments", "paymentsDomain.js"), "utf8"));
  const fn = src.slice(src.indexOf("function openIntentsForScope(purchases, slug, scopeId)"));
  const body = fn.slice(0, fn.indexOf("\nconst OPEN_INTENT"));
  assert.ok(!body.includes("providerSessionId"),
    "'no sé su id' no es 'no existe'; exigirlo hacía invisible la sesión perdida");
  assert.ok(body.includes("PURCHASE_STATUS.CREATED"));
  assert.ok(body.includes("p.scopeId === scopeId"));
});

test("MON003 · C3.11 — la clave de idempotencia es la identidad de la COMPRA", () => {
  // Dos compras distintas -> dos claves distintas -> dos sesiones. Por eso el
  // invariant tiene que impedir que nazca la segunda COMPRA, no sólo la segunda
  // sesión: una vez existen dos compras abiertas, ya no hay nada que las una.
  const src = stripComments(serverSrc);
  // Correction 07: una identidad por INTENTO, no por compra. Dos peticiones con
  // parametros distintos no pueden compartir clave.
  const claves = src.match(/`checkout:\$\{purchaseId\}:\$\{seq\}`/g) || [];
  assert.equal(claves.length, 1, "un solo sitio construye la clave de un intento nuevo");
  assert.ok(src.includes("idempotencyKey: attempt.idempotencyKey"),
    "y la creacion usa exactamente esa");
  // Y ese sitio es el único que crea sesiones de checkout.
  const creaciones = src.match(/stripeAdapter\.createCheckoutSession\(/g) || [];
  assert.equal(creaciones.length, 1, "todas las creaciones pasan por createSessionFor");
});

test("MON003 · C3.12 — el navegador sigue sin aportar la identidad de la compra", () => {
  // "No confíes en el browser para aportar purchaseId": el servidor lo genera y
  // lo busca por slug + scope, nunca por lo que llegue de fuera.
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  assert.ok(!/req\.body/.test(body) && !/req\.query/.test(body) && !/req\.params\.purchase/.test(body));
  assert.ok(body.includes("openIntentsForScope(store.purchases, slug, scope.id)"));
});

test("MON003 · C3.13 — reutilizar tal cual sólo vale si hay UNA compra abierta", () => {
  // Si coexistieran dos abiertas y cobrables, devolver el enlace de la primera
  // dejaría la segunda cobrando. El permiso para reutilizar es del llamador.
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  assert.ok(body.includes("const reusable = open.length === 1"));
  // Y el camino rápido aplica la MISMA regla, en memoria y gratis.
  assert.ok(body.includes("abiertas.length === 1 && sameOffer(reusable, offer)"));
  assert.ok(body.includes("abiertas[0].id === reusable.id"));
  assert.ok(body.includes("resolveOpenIntent(a, offer, reusable)"));
  const fn = src.slice(src.indexOf("async function resolveOpenIntent(intent, currentOffer, reusable = true)"));
  const fnBody = fn.slice(0, fn.indexOf("\nasync function ", 10));
  assert.ok(fnBody.includes("reusable && sameOffer(intent, currentOffer)"),
    "sin permiso, una cobrable se trata como hay que matarla aunque venda lo mismo");
  // Y en el dominio la equivalencia sigue siendo lo único que decide USABLE.
  assert.equal(D.classifyOpenIntent({ lifecycle: "chargeable" }, false), D.OPEN_INTENT.MUST_EXPIRE);
});

// ==== 18 · Correction 04: el conjunto entero, antes de responder =============
//
// El P1: la fase 2 respondía DENTRO del bucle. Con A=USED y B=cobrable, `[A, B]`
// devolvía "payment_in_progress" y B nunca se inspeccionaba ni se mataba;
// `[B, A]` sí mataba B. El invariant dependía del orden de `store.purchases`,
// que no es una entrada de negocio: es el orden en que se escribieron las filas.

const OI = D.OPEN_INTENT;
const OS = D.OPEN_SET;
const rr = (id, outcome) => ({ id, outcome });
// Todas las permutaciones de un array, para que "independiente del orden" sea
// una afirmación comprobada y no una intención.
function permutaciones(xs) {
  if (xs.length <= 1) return [xs.slice()];
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const resto = xs.slice(0, i).concat(xs.slice(i + 1));
    for (const p of permutaciones(resto)) out.push([xs[i]].concat(p));
  }
  return out;
}
// Aplica decideOpenSet a TODAS las permutaciones y devuelve el conjunto de
// respuestas distintas, comparadas como texto.
function bajoTodoOrden(entradas) {
  const vistos = new Map();
  for (const perm of permutaciones(entradas)) {
    const r = D.decideOpenSet(perm);
    vistos.set(JSON.stringify(r), (vistos.get(JSON.stringify(r)) || 0) + 1);
  }
  return { distintas: [...vistos.keys()], n: permutaciones(entradas).length };
}

test("MON003 · C4.1 — [USED, CHARGEABLE] y [CHARGEABLE, USED] acaban IGUAL", () => {
  // El servidor no marca nada USABLE cuando hay más de una abierta: una cobrable
  // se expira y llega aquí como DEAD. Éste es el escenario del ticket.
  const a = bajoTodoOrden([rr("a", OI.USED), rr("b", OI.DEAD)]);
  assert.equal(a.distintas.length, 1, "una sola respuesta para los dos órdenes");
  const r = JSON.parse(a.distintas[0]);
  assert.equal(r.action, OS.CONFIRM_EXISTING);
  assert.equal(r.purchaseId, "a", "se conserva la que cobró, para confirmarla");
  assert.deepEqual(r.dead, ["b"], "y la otra quedó demostrada incobrable ANTES de responder");
});

test("MON003 · C4.2 — [USED, UNKNOWN]: fail closed, en cualquier orden", () => {
  const a = bajoTodoOrden([rr("a", OI.USED), rr("b", OI.UNRESOLVED)]);
  assert.equal(a.distintas.length, 1);
  const r = JSON.parse(a.distintas[0]);
  assert.equal(r.action, OS.BLOCKED, "no se puede descartar que B siga cobrando");
  assert.equal(r.reason, "unresolved");
  assert.deepEqual(r.unresolved, ["b"]);
  assert.deepEqual(r.needsAttention, ["b"], "y queda para que lo mire una persona");
  // Que exista una USED no rebaja el bloqueo: sin resolver B no hay invariant.
  assert.deepEqual(r.used, ["a"]);
});

test("MON003 · C4.3 — [USED, DEAD]: se confirma la usada, en cualquier orden", () => {
  for (const perm of permutaciones([rr("a", OI.USED), rr("b", OI.DEAD)])) {
    const r = D.decideOpenSet(perm);
    assert.equal(r.action, OS.CONFIRM_EXISTING);
    assert.equal(r.purchaseId, "a");
  }
});

test("MON003 · C4.4 — [CHARGEABLE, CHARGEABLE]: ninguna se reutiliza", () => {
  // Dos cobrables a la vez es exactamente lo que no puede sobrevivir a la
  // respuesta. Con dos abiertas el servidor no marca ninguna USABLE, así que
  // llegan como DEAD y se abre una nueva.
  const a = bajoTodoOrden([rr("a", OI.DEAD), rr("b", OI.DEAD)]);
  assert.equal(a.distintas.length, 1);
  const r = JSON.parse(a.distintas[0]);
  assert.equal(r.action, OS.OPEN_NEW);
  assert.deepEqual(r.dead, ["a", "b"], "las dos se sustituyen");
  // Y si por un fallo llegaran DOS marcadas como reutilizables, se bloquea:
  // devolver una dejaría la otra cobrando.
  const dos = D.decideOpenSet([rr("a", OI.USABLE), rr("b", OI.USABLE)]);
  assert.equal(dos.action, OS.BLOCKED);
  assert.equal(dos.reason, "many_usable");
  assert.deepEqual(dos.needsAttention, ["a", "b"]);
});

test("MON003 · C4.5 — [USED, CHARGEABLE, DEAD] y sus 6 permutaciones", () => {
  const a = bajoTodoOrden([rr("a", OI.USED), rr("b", OI.DEAD), rr("c", OI.DEAD)]);
  assert.equal(a.n, 6, "las seis permutaciones");
  assert.equal(a.distintas.length, 1, "una sola respuesta");
  const r = JSON.parse(a.distintas[0]);
  assert.equal(r.action, OS.CONFIRM_EXISTING);
  assert.equal(r.purchaseId, "a");
  assert.deepEqual(r.dead, ["b", "c"], "los ids van ordenados: ni el log depende del orden");
});

test("MON003 · C4.6 — INDEPENDENCIA DEL ORDEN: todos los conjuntos, todas las permutaciones", () => {
  // La pregunta del ticket: si cambio el orden de store.purchases, ¿cambia el
  // resultado? Aquí se comprueba a lo bruto sobre todo el espacio de conjuntos
  // de hasta 4 compras con las cuatro etiquetas posibles.
  const etiquetas = [OI.USED, OI.USABLE, OI.DEAD, OI.UNRESOLVED];
  let conjuntos = 0;
  const combinaciones = (largo) => {
    if (largo === 0) return [[]];
    const out = [];
    for (const resto of combinaciones(largo - 1)) {
      for (const e of etiquetas) out.push(resto.concat([e]));
    }
    return out;
  };
  for (let largo = 1; largo <= 4; largo++) {
    for (const combo of combinaciones(largo)) {
      const entradas = combo.map((e, i) => rr("p" + i, e));
      const { distintas } = bajoTodoOrden(entradas);
      conjuntos++;
      assert.equal(distintas.length, 1,
        `el orden cambió el resultado para ${JSON.stringify(combo)}: ${JSON.stringify(distintas)}`);
    }
  }
  assert.equal(conjuntos, 4 + 16 + 64 + 256, "se cubrió el espacio entero");
});

test("MON003 · C4.7 — el número de cobrables que sobreviven NO depende del orden", () => {
  // La misma pregunta, formulada como el invariant: ¿cuántas capacidades de
  // cobro quedan vivas al responder? Se modela la consecuencia de cada acción.
  //   confirm_existing -> sobrevive la USED (ya cobró, ya no cobra otra vez)
  //   reuse            -> sobrevive UNA, la reutilizada
  //   open_new         -> sobrevive UNA, la nueva
  //   blocked          -> no se crea ninguna; sobreviven las que no se pudieron matar
  const cobrablesQueSobreviven = (r, entradas) => {
    if (r.action === OS.OPEN_NEW) return 1;
    if (r.action === OS.REUSE) return 1;
    if (r.action === OS.CONFIRM_EXISTING) return 0;   // la usada ya no puede cobrar
    return entradas.filter((e) => e.outcome === OI.UNRESOLVED || e.outcome === OI.USABLE).length;
  };
  const etiquetas = [OI.USED, OI.USABLE, OI.DEAD, OI.UNRESOLVED];
  for (const e1 of etiquetas) for (const e2 of etiquetas) for (const e3 of etiquetas) {
    const entradas = [rr("a", e1), rr("b", e2), rr("c", e3)];
    const cuentas = new Set(permutaciones(entradas)
      .map((perm) => cobrablesQueSobreviven(D.decideOpenSet(perm), perm)));
    assert.equal(cuentas.size, 1,
      `el orden cambió cuántas cobrables sobreviven en ${JSON.stringify([e1, e2, e3])}`);
    // Y nunca queda más de una viva salvo que el propio proveedor no contestara.
    const desconocidas = entradas.filter((x) => x.outcome === OI.UNRESOLVED).length;
    const n = [...cuentas][0];
    assert.ok(n <= Math.max(1, desconocidas + entradas.filter((x) => x.outcome === OI.USABLE).length),
      `quedaron ${n} cobrables con ${JSON.stringify([e1, e2, e3])}`);
  }
});

test("MON003 · C4.8 — dos que YA cobraron es un cargo doble, no un riesgo", () => {
  // Correction 05 (P2-4): hacen falta dos COBRADAS, no dos "usadas".
  const a = bajoTodoOrden([{ id: "a", outcome: OI.USED, paid: true },
    { id: "b", outcome: OI.USED, paid: true }]);
  assert.equal(a.distintas.length, 1);
  const r = JSON.parse(a.distintas[0]);
  assert.equal(r.action, OS.BLOCKED);
  assert.equal(r.reason, "double_charge");
  assert.deepEqual(r.needsAttention, ["a", "b"], "las dos se marcan: hay algo que devolver");
  assert.equal(D.ATTENTION.DOUBLE_CHARGE, "two_checkouts_were_paid_for_one_tournament");
  // Y no se elige una para confirmar: elegir sería tapar la mitad del problema.
  assert.ok(!r.purchaseId);
});

test("MON003 · C4.9 — una etiqueta desconocida cuenta como SIN RESOLVER", () => {
  // Fail closed por defecto, no por enumeración: una etiqueta futura no puede
  // colarse como "todo en orden".
  for (const raro of [undefined, null, "", "algo_nuevo", 0, false, {}]) {
    const r = D.decideOpenSet([rr("a", OI.DEAD), rr("b", raro)]);
    assert.equal(r.action, OS.BLOCKED, JSON.stringify(String(raro)));
    assert.deepEqual(r.unresolved, ["b"]);
  }
  // Y una entrada vacía o basura no rompe la función.
  assert.equal(D.decideOpenSet([]).action, OS.OPEN_NEW);
  assert.equal(D.decideOpenSet(null).action, OS.OPEN_NEW);
  assert.equal(D.decideOpenSet([null, undefined]).action, OS.OPEN_NEW);
});

test("MON003 · C4.10 — una cobrable junto a una ya cobrada se bloquea", () => {
  // No debería poder pasar —con más de una abierta el servidor no marca nada
  // USABLE— pero si pasara, sería la segunda capacidad de cobro que todo esto
  // existe para impedir. Se bloquea en vez de confiar en que no pase.
  const r = D.decideOpenSet([rr("a", OI.USED), rr("b", OI.USABLE)]);
  assert.equal(r.action, OS.BLOCKED);
  assert.equal(r.reason, "usable_beside_used");
  assert.deepEqual(r.needsAttention, ["a", "b"]);
});

test("MON003 · C4.11 — SERVER: NINGÚN return dentro del bucle de compras abiertas", () => {
  // La pregunta obligatoria del ticket, convertida en prueba: ¿hay algún return
  // dentro del procesamiento de la colección que pueda dejar otra sin mirar?
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const desde = body.indexOf("for (const a of open) {");
  assert.ok(desde !== -1);
  // El cuerpo del bucle, acotado por su propio cierre en la misma indentación.
  const fin = body.indexOf("\n    }", desde);
  const bucle = body.slice(desde, fin);
  assert.ok(!/\breturn\b/.test(bucle),
    "un return aquí deja sin inspeccionar lo que venga después en el array");
  assert.ok(!/res\.(json|status)\(/.test(bucle), "ni se responde a medias");
  assert.ok(bucle.includes("resolved.push("), "sólo se acumula");
  // Y la decisión llega después, con el conjunto completo.
  assert.ok(body.indexOf("decideOpenSet(resolved)") > fin);
});

test("MON003 · C4.12 — SERVER: se responde SÓLO desde el plan del conjunto", () => {
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const decideAt = body.indexOf("decideOpenSet(resolved)");
  // payment_in_progress y el enlace reutilizado sólo existen DESPUÉS de decidir.
  for (const salida of ['error: "payment_in_progress"', "checkoutUrl: reuseUrl"]) {
    const at = body.indexOf(salida);
    assert.ok(at !== -1 && at > decideAt, salida + " no puede decidirse antes del conjunto");
  }
  // Y la compra nueva se abre sólo con la acción OPEN_NEW.
  const openAt = body.indexOf("openPurchase(slug, dead)");
  assert.ok(body.lastIndexOf("OPEN_SET.OPEN_NEW", openAt) > decideAt);
  assert.ok(body.includes('r.outcome === paymentsDomain.OPEN_INTENT.DEAD'),
    "y sustituye exactamente a las demostradas muertas");
  // Correction 05: un enlace nulo no se devuelve como si fuera un enlace. El
  // contrato del proveedor dice que la url "sólo está presente mientras la
  // sesión está activa", así que puede faltar.
  assert.ok(body.includes("usableCheckoutUrl(it && it.url)"));
  assert.ok(body.includes("checkout_reuse_without_url"));
  assert.ok(body.includes("usableCheckoutUrl(session.url)"));
  assert.ok(body.includes("checkout_created_without_url"));
  assert.ok(!/checkoutUrl:\s*(session\.url|it\.url)\b/.test(body),
    "ninguna respuesta devuelve la url del proveedor sin comprobarla");
});

test("MON003 · C4.13 — SERVER: el conjunto ambiguo queda ANOTADO, no sólo rechazado", () => {
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  assert.ok(body.includes("flagOpenSetAttention(slug, plan)"));
  assert.ok(body.includes("open.length > 1"), "sólo cuando el conjunto era ambiguo de verdad");
  assert.ok(body.includes('error: "checkout_unavailable"'));
  const fn = src.slice(src.indexOf("async function flagOpenSetAttention(slug, plan)"));
  const fnBody = fn.slice(0, fn.indexOf("\nasync function ", 10));
  // El código de cada incidente sale del mapa del dominio, no de un if a mano.
  assert.ok(fnBody.includes("paymentsDomain.INCIDENT_ATTENTION[kind]"));
  assert.ok(fnBody.includes("buildPaymentAudit"), "y queda en la auditoría");
  // No toca el estado: la compra tiene que poder seguir confirmándose por webhook.
  assert.ok(!/status:\s*paymentsDomain\.PURCHASE_STATUS/.test(fnBody),
    "anotar no es cambiar el estado de un cobro");
  assert.ok(fnBody.includes("!p.attention"), "y no pisa una razón anterior");
  // Correction 05 (P2-3/P2-5): se recorren TODOS los incidentes, y la auditoría
  // se escribe aunque el campo singular ya estuviera ocupado.
  assert.ok(fnBody.includes("for (const inc of incidents)"), "todos los incidentes");
  const auditAt = fnBody.indexOf("audit.push(");
  const singularAt = fnBody.indexOf("if (!p.attention && !razonPara.has(id))");
  assert.ok(auditAt !== -1 && singularAt !== -1);
  assert.ok(auditAt < singularAt,
    "auditar no está condicionado a poder rellenar el campo singular");
  assert.ok(fnBody.includes("if (!entradas && !razonPara.size)"),
    "sólo se aborta si NO hay nada que auditar NI que anotar");
});

test("MON003 · C4.14 — los códigos nuevos describen problemas distintos", () => {
  const codigos = Object.values(D.ATTENTION);
  assert.equal(new Set(codigos).size, codigos.length, "ningún código repetido");
  assert.equal(D.ATTENTION.OPEN_SET_UNRESOLVED, "open_checkout_could_not_be_resolved");
  assert.notEqual(D.ATTENTION.OPEN_SET_UNRESOLVED, D.ATTENTION.SUPERSEDED);
  assert.notEqual(D.ATTENTION.DOUBLE_CHARGE, D.ATTENTION.OPEN_SET_UNRESOLVED);
});

test("MON003 · C4.15 — las hermanas muertas se RETIRAN, no se dejan a medias", () => {
  // El P2 que salió en esta misma iteración: al devolver "hay un pago en curso"
  // las hermanas quedaban en `created` sin `supersededBy`, así que un cobro que
  // apareciera sobre ellas otorgaba PLUS y registraba un SEGUNDO pago del mismo
  // torneo. La protección de Correction 02 no cubría este camino.
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  const retireAt = body.indexOf("retireDeadSiblings(slug, plan.dead || [], plan.purchaseId, plan.winnerPaid)");
  const respondAt = body.indexOf('error: "payment_in_progress"');
  assert.ok(retireAt !== -1 && respondAt !== -1);
  assert.ok(retireAt < respondAt, "se retiran ANTES de responder");
  // También en la rama que reutiliza: si hubiera hermanas muertas, se retiran.
  assert.equal((body.match(/retireDeadSiblings\(/g) || []).length, 2);

  const fn = src.slice(src.indexOf("async function retireDeadSiblings(slug, deadIds, winnerId, winnerPaid)"));
  const fnBody = fn.slice(0, fn.indexOf("\nasync function ", 10));
  assert.ok(fnBody.includes("supersededBy: winnerId"), "lo que bloquea un grant tardío");
  assert.ok(fnBody.includes("PURCHASE_STATUS.EXPIRED"));
  // Correction 05 (P2-2): el motivo depende de si la que se conserva COBRÓ.
  assert.ok(fnBody.includes("ATTENTION.RETIRED_FOR_PAID_SIBLING"));
  assert.ok(fnBody.includes("ATTENTION.RETIRED_FOR_ACTIVE_SIBLING"));
  assert.ok(fnBody.includes("winnerPaid === true"), "y de un hecho, no del contexto");
  assert.ok(fnBody.includes('buildPaymentAudit(retired, decision'));
  // Nunca se retira la que se conserva, ni algo que ya es terminal.
  assert.ok(fnBody.includes("id !== winnerId"));
  assert.ok(fnBody.includes("p.status !== paymentsDomain.PURCHASE_STATUS.CREATED"));

  // Y el dominio ya sabía bloquear un cobro sobre una retirada: es el mismo
  // mecanismo, ahora también por este camino.
  const d = decide(intentOf({ supersededBy: "qpur_ganadora" }), observedOf());
  assert.equal(d.decision, D.DECISION.SUPERSEDED_PURCHASE);
  assert.ok(!d.nextStatus, "no se toca el estado: no se inventa dinero");
  assert.equal(D.ATTENTION.RETIRED_FOR_PAID_SIBLING, "retired_because_another_checkout_was_paid");
  assert.notEqual(D.ATTENTION.RETIRED_FOR_PAID_SIBLING, D.ATTENTION.SUPERSEDED);
});

// ==== 19 · Correction 05: recuperación durable y verdad monetaria ============
//
// Tres blockers y cuatro P2. El que manda el diseño es el segundo: la clave de
// idempotencia del proveedor NO es una identidad eterna, así que la recuperación
// no puede descansar en ella.

test("MON003 · C5.1 — el adaptador siembra la identidad en DOS sitios y en el cargo", () => {
  const src = stripComments(
    fs.readFileSync(path.join(__dirname, "..", "payments", "stripeAdapter.js"), "utf8"));
  const fn = src.slice(src.indexOf("async function createCheckoutSession({"));
  const body = fn.slice(0, fn.indexOf("\nasync function ", 10));
  // En la sesión: metadata y el campo que el proveedor describe para reconciliar.
  assert.ok(body.includes('"metadata[qracks_purchase_id]": purchaseId'));
  assert.ok(body.includes("client_reference_id: purchaseId"));
  // Y en el PaymentIntent, para que el CARGO sea rastreable sin la sesión.
  assert.ok(body.includes('"payment_intent_data[metadata][qracks_purchase_id]": purchaseId'));
  assert.ok(body.includes('"payment_intent_data[metadata][qracks_slug]": slug'));
  assert.ok(body.includes('"payment_intent_data[metadata][qracks_scope_id]": scopeId'));
  // La expiración se manda explícita: el horizonte de muerte es un número que
  // conocemos, no un valor por defecto que podría cambiar.
  assert.ok(body.includes("params.expires_at = expiresAt"));
});

test("MON003 · C5.2 — el listado existe, está acotado y se pagina", () => {
  const src = stripComments(
    fs.readFileSync(path.join(__dirname, "..", "payments", "stripeAdapter.js"), "utf8"));
  const fn = src.slice(src.indexOf("async function listCheckoutSessions("));
  const body = fn.slice(0, fn.indexOf("\nasync function ", 10));
  assert.ok(body.includes("created[gte]") && body.includes("created[lte]"),
    "acotado por fecha: la ventana en la que pudo nacer es diminuta y conocida");
  assert.ok(body.includes("starting_after"), "y se pagina");
  assert.ok(body.includes("hasMore"));
  assert.ok(body.includes("Math.min"), "el límite se acota al máximo del proveedor");
  assert.ok(body.includes("normalizeSession"), "y sube ya traducido");
});

test("MON003 · C5.3 — normalizeSession distingue 'usada' de 'cobrada'", () => {
  const { normalizeSession } = require("../payments/stripeAdapter");
  const base = {
    id: "cs_1", amount_total: 19900, currency: "mxn", created: 1000, expires_at: 2000,
    client_reference_id: "qpur_a", metadata: { qracks_purchase_id: "qpur_a" },
  };
  const completaPagada = normalizeSession({ ...base, status: "complete", payment_status: "paid" });
  const completaSinPagar = normalizeSession({ ...base, status: "complete", payment_status: "unpaid" });
  assert.equal(completaPagada.lifecycle, "used");
  assert.equal(completaSinPagar.lifecycle, "used", "el ciclo de vida es el mismo");
  assert.equal(completaPagada.paid, true);
  assert.equal(completaSinPagar.paid, false, "pero el dinero NO");
  assert.equal(completaSinPagar.paymentStatus, "unpaid");
  // `no_payment_required` tampoco es un cobro.
  assert.equal(normalizeSession({ ...base, status: "complete", payment_status: "no_payment_required" }).paid, false);
  // Y el reloj del proveedor sube, que es lo que acota una búsqueda.
  assert.equal(completaPagada.createdAt, 1000);
  assert.equal(completaPagada.expiresAt, 2000);
  // Los dos portadores de identidad, por separado.
  assert.equal(completaPagada.clientReferenceId, "qpur_a");
  assert.equal(completaPagada.metadataPurchaseId, "qpur_a");
  // Sin metadata, el otro portador sigue identificándola.
  const soloRef = normalizeSession({ ...base, status: "open", payment_status: "unpaid", metadata: {} });
  assert.equal(soloRef.purchaseId, "qpur_a");
  assert.equal(soloRef.metadataPurchaseId, null);
  // La url es nullable por contrato: "only present when the session is active".
  assert.equal(normalizeSession({ ...base, status: "expired", url: null }).url, null);
  assert.equal(normalizeSession({ ...base, status: "open", url: "https://x/y" }).url, "https://x/y");
});

test("MON003 · C5.4 — SERVER: localizar NUNCA concluye una ausencia que no puede demostrar", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "async function locateSessionForPurchase(intent, hint)");
  const decidir = cuerpoDe(src, "function decidirLocalizacion(encontradas, conflict, via)");
  // Las cuatro respuestas, y cuál lleva a crear.
  assert.ok(body.includes('{ absent: true, via: "never_attempted" }'),
    "sin haber pedido la creación no puede existir nada");
  assert.ok(decidir.includes("{ absent: true, via:"));
  assert.ok(body.includes('{ unknown: true, via: "list_truncated" }'),
    "una búsqueda truncada NO demuestra una ausencia");
  assert.ok(decidir.includes('{ unknown: true, via: "conflicting_candidate"'),
    "una sesión que dice ser nuestra y no cuadra no se ignora");
  // Correction 06: UNA es una, VARIAS es una anomalía — y nunca se elige una.
  assert.ok(decidir.includes("if (todas.length === 1) return { session: todas[0], via }"));
  assert.ok(decidir.includes("if (todas.length > 1) return { multiple: todas, via }"));
  assert.ok(!/return \{ session: [^}]*\[0\][^}]*\}/.test(body.replace(decidir, "")),
    "el cuerpo del descubrimiento no elige ninguna por su cuenta");
  // Y la pista se verifica y se AÑADE al conjunto, jamás cortocircuita.
  assert.ok(body.includes("verifySessionForPurchase(intent, observed)"));
  assert.ok(body.includes("encontradas.set(observed.sessionId, observed)"));
  assert.ok(body.includes("session_candidate_rejected"),
    "lo que no verifica queda registrado, no ignorado");
  const hintAt = body.indexOf('mirar(hint, "hint")');
  const listAt = body.indexOf("listCheckoutSessions(");
  assert.ok(hintAt !== -1 && listAt !== -1 && hintAt < listAt);
  assert.ok(!/if \(hint[\s\S]{0,400}return \{ session/.test(body),
    "aceptar la pista y volver a casa dejaría invisible cualquier otra sesión");
  // Correction 07: las guardadas entran SIEMPRE en el conjunto, antes que la pista.
  assert.ok(body.includes('knownSessionIdsOf(intent)) await mirar(id, "stored")'));
  assert.ok(body.indexOf('mirar(id, "stored")') < hintAt);
  // Se recorren TODAS las páginas antes de decidir: ningún return dentro del bucle.
  // El recorte va por llaves y no por indentación, porque el bucle está anidado
  // dentro del de ventanas desde Correction 07.
  const bucle = cuerpoDe(body, "for (let page = 0");
  assert.ok(!/\breturn\b/.test(bucle),
    "un return dentro del paginado deja páginas sin leer");
  // Y lo mismo con el bucle de VENTANAS: salir a media lista de ventanas dejaría
  // sin mirar la ventana de un intento posterior, que es el agujero de C07.
  const ventanas = cuerpoDe(body, "for (const w of ventanas)");
  const salidas = ventanas.match(/\breturn\b/g) || [];
  assert.ok(salidas.length <= 2, "sólo las dos salidas de truncamiento: " + salidas.length);
  assert.ok(/agotado[\s\S]{0,200}list_truncated/.test(ventanas),
    "y ambas son por no poder demostrar nada, nunca por haber encontrado algo");
  // Buscar no es vender.
  assert.ok(!body.includes("createCheckoutSession"));
  assert.ok(!body.includes("createSessionFor"));
});

test("MON003 · C5.5 — SERVER: la ventana de búsqueda sale de un dato NUESTRO", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "async function locateSessionForPurchase(intent, hint)");
  // Correction 07: hay UNA ventana POR INTENTO, no una sola anclada al primero.
  assert.ok(body.includes("discoveryWindows(intent, SESSION_LOOKUP_MARGIN_MS)"),
    "las ventanas las fijan los instantes en que PEDIMOS cada creación");
  assert.ok(body.includes("for (const w of ventanas)"), "se recorren todas");
  assert.ok(body.includes("SESSION_LOOKUP_MAX_PAGES"));
  // Sin ningún intento registrado no puede existir ninguna sesión.
  assert.ok(body.includes('{ absent: true, via: "never_attempted" }'));
  // Y un instante ilegible no cuenta como ventana: el dominio lo descarta en vez de
  // rellenarlo con la hora de ahora.
  const dom2 = stripComments(
    fs.readFileSync(path.join(__dirname, "..", "payments", "paymentsDomain.js"), "utf8"));
  assert.ok(cuerpoDe(dom2, "function creationAttemptsOf(intent)").includes("if (!Number.isFinite(at)) continue"));
  // Y `creationAttemptedAt` no es auditoría: sostiene esto, y se escribe una sola
  // vez porque la primera marca es la que acota la ventana.
  const mark = cuerpoDe(src, "async function recordCreationAttempt(purchaseId, nowMs)");
  assert.ok(mark.includes("isAttemptReusable(\n"), "se comprueba si la identidad anterior sirve");
});

test("MON003 · C5.6 — SERVER: reanudar localiza primero y crea sólo ante una ausencia probada", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "async function resolveOpenIntent(intent, currentOffer, reusable = true)");
  const locateAt = body.indexOf("locateSessionForPurchase(intent, null)");
  const absentAt = body.indexOf("found.absent");
  const createAt = body.indexOf("createSessionFor(intent, intent.slug)");
  assert.ok(locateAt !== -1 && absentAt !== -1 && createAt !== -1);
  assert.ok(locateAt < absentAt && absentAt < createAt,
    "localizar -> demostrar la ausencia -> sólo entonces crear");
  // Y si no se sabe, no se crea NI se da por muerta.
  assert.ok(body.includes("OPEN_INTENT.UNRESOLVED"));
  assert.ok(body.includes("unlocatable: true"));
  assert.ok(body.includes("checkout_session_unlocatable"));
  // El dato de dinero sube al conjunto.
  assert.ok(body.includes("paid: !!(observed && observed.paid === true)"));
});

test("MON003 · C5.7 — el conjunto no llama cargo doble a lo que no lo es", () => {
  const paid = (id) => ({ id, outcome: OI.USED, paid: true });
  const usadaSinPago = (id) => ({ id, outcome: OI.USED, paid: false });
  // Dos cobradas SÍ.
  const dos = D.decideOpenSet([paid("a"), paid("b")]);
  assert.equal(dos.reason, D.INCIDENT.DOUBLE_CHARGE);
  assert.deepEqual(dos.paid, ["a", "b"]);
  // Dos usadas sin cobro declarado NO: fail closed con otro nombre.
  const sin = D.decideOpenSet([usadaSinPago("a"), usadaSinPago("b")]);
  assert.equal(sin.action, OS.BLOCKED, "sigue fallando cerrado");
  assert.equal(sin.reason, D.INCIDENT.USED_UNPAID);
  assert.deepEqual(sin.paid, [], "y no se afirma dinero que nadie declaró");
  assert.equal(D.INCIDENT_ATTENTION[D.INCIDENT.USED_UNPAID], D.ATTENTION.TWO_SESSIONS_USED_UNPAID);
  assert.equal(D.ATTENTION.TWO_SESSIONS_USED_UNPAID,
    "two_checkouts_were_used_without_reported_payment");
  // Una cobrada y una sin cobro: no es cargo doble, pero BLOQUEA igual. Este era
  // el caso que se me cayó al partir por `paid`: caía en "abrir una nueva", que
  // habría sido una tercera venta junto a un cobro ya hecho.
  const mixto = D.decideOpenSet([paid("a"), usadaSinPago("b")]);
  assert.equal(mixto.action, OS.BLOCKED, "no se vende encima de un cobro");
  assert.equal(mixto.reason, D.INCIDENT.USED_BESIDE_PAID);
  assert.deepEqual(mixto.paid, ["a"]);
  assert.deepEqual(mixto.needsAttention, ["a", "b"]);
  assert.equal(D.ATTENTION.USED_BESIDE_PAID, "another_checkout_was_used_beside_a_paid_one");
});

test("MON003 · C5.7b — PROPIEDAD: jamás se abre una venta encima de un cobro", () => {
  // La prueba que habría cazado el agujero de arriba, y que lo seguirá cazando
  // sea cual sea la enumeración de incidentes: se recorre el espacio COMPLETO de
  // conjuntos de hasta 4 compras con las cinco etiquetas posibles, y se exige que
  // ninguna combinación con un cobro declarado pueda acabar en una venta nueva,
  // ni en reutilizar un checkout, en ningún orden.
  const etiquetas = [
    { outcome: OI.USED, paid: true }, { outcome: OI.USED, paid: false },
    { outcome: OI.USABLE }, { outcome: OI.DEAD }, { outcome: OI.UNRESOLVED },
  ];
  const combos = (n) => (n === 0 ? [[]]
    : combos(n - 1).flatMap((resto) => etiquetas.map((e) => resto.concat([e]))));
  let revisados = 0;
  let conCobro = 0;
  for (let largo = 1; largo <= 4; largo++) {
    for (const combo of combos(largo)) {
      const entradas = combo.map((e, i) => ({ id: "p" + i, ...e }));
      const hayCobro = entradas.some((e) => e.paid === true);
      const hayVarias = entradas.filter((e) => e.outcome === OI.USED).length > 1;
      for (const perm of permutaciones(entradas)) {
        const r = D.decideOpenSet(perm);
        revisados++;
        if (hayCobro) {
          conCobro++;
          assert.notEqual(r.action, OS.OPEN_NEW,
            `venta nueva sobre un cobro: ${JSON.stringify(combo)}`);
          assert.notEqual(r.action, OS.REUSE,
            `checkout reutilizado sobre un cobro: ${JSON.stringify(combo)}`);
          // Lo único permitido: confirmar ESE cobro, o bloquear.
          if (r.action === OS.CONFIRM_EXISTING) {
            assert.equal(entradas.filter((e) => e.outcome === OI.USED).length, 1,
              "sólo se confirma cuando hay UNA usada");
            assert.equal(r.winnerPaid, true);
          }
        }
        // Y más de una usada SIEMPRE bloquea, cobrada o no.
        if (hayVarias) {
          assert.equal(r.action, OS.BLOCKED,
            `varias usadas sin bloquear: ${JSON.stringify(combo)}`);
          assert.ok(r.incidents.length >= 1, "y con su incidente registrado");
        }
      }
    }
  }
  assert.ok(revisados > 3000, "se recorrió el espacio de verdad: " + revisados);
  assert.ok(conCobro > 1000, "y con cobro declarado en " + conCobro + " casos");
});

test("MON003 · C5.8 — un cargo doble consumado NO se tapa con uno preventivo", () => {
  const set = [
    { id: "a", outcome: OI.USED, paid: true },
    { id: "b", outcome: OI.USED, paid: true },
    { id: "c", outcome: OI.UNRESOLVED },
  ];
  // En cualquier orden: los DOS hechos, y el más grave manda la razón.
  for (const perm of permutaciones(set)) {
    const r = D.decideOpenSet(perm);
    assert.equal(r.action, OS.BLOCKED);
    assert.equal(r.reason, D.INCIDENT.DOUBLE_CHARGE, "lo consumado manda sobre lo preventivo");
    const kinds = r.incidents.map((x) => x.kind);
    assert.ok(kinds.includes(D.INCIDENT.DOUBLE_CHARGE));
    assert.ok(kinds.includes(D.INCIDENT.UNRESOLVED), "y el preventivo NO desaparece");
    assert.equal(kinds[0], D.INCIDENT.DOUBLE_CHARGE, "ordenados por gravedad");
    assert.deepEqual(r.incidents.find((x) => x.kind === D.INCIDENT.UNRESOLVED).purchaseIds, ["c"]);
  }
  // La gravedad es un orden total y explícito, no el orden de detección.
  const sev = D.INCIDENT_SEVERITY;
  assert.ok(sev[D.INCIDENT.DOUBLE_CHARGE] > sev[D.INCIDENT.USABLE_BESIDE_USED]);
  assert.ok(sev[D.INCIDENT.USABLE_BESIDE_USED] > sev[D.INCIDENT.MANY_USABLE]);
  assert.ok(sev[D.INCIDENT.MANY_USABLE] > sev[D.INCIDENT.USED_UNPAID]);
  assert.ok(sev[D.INCIDENT.USED_UNPAID] > sev[D.INCIDENT.UNRESOLVED]);
});

test("MON003 · C5.9 — la independencia del orden sobrevive a la semántica nueva", () => {
  // El mismo barrido de C4.6, ahora con la dimensión `paid`.
  const etiquetas = [
    { outcome: OI.USED, paid: true }, { outcome: OI.USED, paid: false },
    { outcome: OI.USABLE }, { outcome: OI.DEAD }, { outcome: OI.UNRESOLVED },
  ];
  let conjuntos = 0;
  const combos = (n) => (n === 0 ? [[]]
    : combos(n - 1).flatMap((resto) => etiquetas.map((e) => resto.concat([e]))));
  for (let largo = 1; largo <= 3; largo++) {
    for (const combo of combos(largo)) {
      const entradas = combo.map((e, i) => ({ id: "p" + i, ...e }));
      const vistas = new Set(permutaciones(entradas).map((perm) => JSON.stringify(D.decideOpenSet(perm))));
      conjuntos++;
      assert.equal(vistas.size, 1,
        `el orden cambió el resultado para ${JSON.stringify(combo)}`);
    }
  }
  assert.equal(conjuntos, 5 + 25 + 125, "el espacio entero de hasta tres compras");
});

test("MON003 · C5.10 — SERVER: la observación vieja no puede degradar un cobro", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("async function openPurchase(slug, superseded)"));
  const body = fn.slice(0, fn.indexOf("async function createSessionFor"));
  const lockAt = body.indexOf('getRowLocked("platform_index", client)');
  const checkAt = body.indexOf("yaNoElegibles");
  const writeAt = body.indexOf("purchases.concat([fresh])");
  assert.ok(lockAt !== -1 && checkAt !== -1 && writeAt !== -1);
  assert.ok(lockAt < checkAt && checkAt < writeAt, "se recomprueba bajo el candado, antes de escribir");
  assert.ok(body.includes("p.status !== paymentsDomain.PURCHASE_STATUS.CREATED"));
  assert.ok(body.includes("!!p.supersededBy"), "ni se pisa lo que otro worker ya escribió");
  assert.ok(body.includes('error: "checkout_stale_observation"'), "si el mundo cambió, fail closed");
  // Y la segunda red: si alguna compra del torneo pasó a PAID, no se vende.
  assert.ok(body.includes("findPaidIntentForScope(store.purchases, slug, scope.id)"));
  assert.ok(body.includes("checkout_already_paid_under_lock"));
  // El map tampoco puede degradar por su cuenta.
  assert.ok(body.includes("!deadIds.has(p.id) || p.status !== paymentsDomain.PURCHASE_STATUS.CREATED"));
  // Y la monotonía del dominio sigue siendo la que decide un avance de estado.
  assert.equal(D.STATUS_RANK.paid > D.STATUS_RANK.expired, true);
});

test("MON003 · C5.11 — la vuelta del navegador acepta la pista, y sólo eso", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "function readSessionHint(raw)");
  assert.ok(/\^cs_\[A-Za-z0-9_\]\{1,200\}\$/.test(body), "se filtra la forma");
  assert.ok(body.includes("return null"), "y lo que no la cumple no viaja a ninguna parte");
  // El success_url pide la pista al proveedor, junto a NUESTRO id de compra.
  assert.ok(src.includes("qz_pago=${encodeURIComponent(intent.id)}"),
    "nuestro id, que es lo único necesario para reconciliar");
  assert.ok(src.includes("qz_sess={CHECKOUT_SESSION_ID}"),
    "y la pista del proveedor, que sólo acelera");
});

test("MON003 · C5.12 — ninguna respuesta manda al navegador a un enlace que no lo es", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "function usableCheckoutUrl(url)");
  assert.ok(body.includes("typeof url !== \"string\""));
  assert.ok(/\^https:/.test(body), "sólo https");
  // Y la pantalla tampoco navega a algo que no sea un enlace.
  const ui = stripComments(indexSrc);
  const at = ui.indexOf("window.location.href = started.checkoutUrl");
  assert.ok(at !== -1);
  const antes = ui.slice(Math.max(0, at - 400), at);
  assert.ok(/typeof started\.checkoutUrl === "string"/.test(antes));
  assert.ok(/\^https:/.test(antes));
});

test("MON003 · C5.13 — un cobro en curso es un estado de RECUPERACIÓN, no un error", () => {
  const ui = stripComments(indexSrc);
  // El id que manda el servidor se conserva y se persiste.
  const sc = ui.slice(ui.indexOf("async function startCheckout()"));
  const scBody = sc.slice(0, sc.indexOf("\n  }\n"));
  assert.ok(scBody.includes("data.purchaseId"), "el id del 409 no se tira");
  assert.ok(scBody.includes("writePendingPurchase(data.purchaseId)"), "y se persiste");
  assert.ok(scBody.includes("purchaseId: recuperable || null"), "y sube a quien decide");
  // Y la hoja pasa a confirmarlo en vez de invitar a otro checkout.
  const sheet = ui.slice(ui.indexOf("function showUpgradeSheet(upgrade, ctx)"));
  const sheetBody = sheet.slice(0, sheet.indexOf("\n  function showPlanBlock"));
  assert.ok(sheetBody.includes('motivo === "payment_in_progress" && started.purchaseId'));
  assert.ok(sheetBody.includes("runCheckoutRecovery(started.purchaseId"));
  assert.ok(sheetBody.includes('motivo === "payment_already_recorded"'),
    "y un cobro ya registrado tampoco invita a comprar otra vez");
  // El mensaje de 'sigue en proceso' dice explícitamente que no hace falta
  // reintentar: es lo que evita un segundo cargo por impaciencia.
  assert.ok(/No hace falta que lo intentes de nuevo/.test(indexSrc));
});

// ==== 20 · Correction 06: marca durable, multiplicidad y expiración explícita ==
//
// El contrato, en orden y sin atajos:
//   marca de intento DURABLE -> descubrimiento completo -> identidad verificada
//   -> verdad del pago.

test("MON003 · C6.1 — la marca se escribe ANTES de la red y sin red de escape", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "async function createSessionFor(intent, slug)");
  assert.ok(body.includes("await recordCreationAttempt(intent.id, Date.now());"));
  // Un `.catch` aquí es justamente el agujero: convierte "sin marca no puede
  // haber sesión" en una afirmación que puede ser falsa.
  assert.ok(!/recordCreationAttempt\([^)]*\)\s*\.catch/.test(body));
  assert.ok(!/recordCreationAttempt[\s\S]{0,200}?try\s*\{/.test(body),
    "ni un try/catch que se la tragüe");
  const markAt = body.indexOf("recordCreationAttempt");
  const netAt = body.indexOf("stripeAdapter.createCheckoutSession");
  assert.ok(markAt !== -1 && netAt !== -1 && markAt < netAt);
  // Y no hay ninguna otra vía que pida una sesión salteándose la marca.
  assert.equal((src.match(/stripeAdapter\.createCheckoutSession\(/g) || []).length, 1);
});

test("MON003 · C6.2 — marcar algo que no existe NO es un éxito", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "async function recordCreationAttempt(purchaseId, nowMs)");
  assert.ok(body.includes('throw new Error("creation_marker_purchase_missing")'));
  // El orden importa: se busca la compra ANTES de escribir.
  assert.ok(body.indexOf("store.purchases.find") < body.indexOf("putRow("));
  // Una marca previa no se reescribe, y no es un error.
  // Correction 07: CADA emisión deja su fila —su ventana— y lo que se hereda,
  // cuando todavía sirve, son la clave y la expiración.
  assert.ok(body.includes("isAttemptReusable("), "se comprueba si la identidad anterior sirve");
  assert.ok(body.includes("idempotencyKey: reutilizable ? ultimo.idempotencyKey"),
    "misma clave mientras sus parámetros sigan siendo válidos");
  assert.ok(body.includes("expiresAt: reutilizable ? ultimo.expiresAt"),
    "y la MISMA expiración con esa misma clave");
  assert.ok(body.includes("concat([attempt])"), "pero la fila de la emisión se añade siempre");
  assert.ok(body.includes("MAX_CREATION_ATTEMPTS"),
    "y la lista está acotada: al tope se falla cerrado, no se olvida una ventana");
  assert.ok(body.includes("creation_attempts_exhausted"));
  // Todo fallo sube, y la transacción se cierra.
  assert.ok(body.includes("throw err"));
  assert.ok(body.includes('await client.query("COMMIT")'));
  assert.ok(body.includes('client.query("ROLLBACK")'));
});

test("MON003 · C6.3 — VARIAS sesiones de una compra: el veredicto no depende del orden", () => {
  const SS = D.SESSION_SET;
  const paid = (id) => ({ sessionId: id, paid: true, lifecycle: "used" });
  const viva = (id) => ({ sessionId: id, paid: false, lifecycle: "chargeable" });
  const muerta = (id) => ({ sessionId: id, paid: false, lifecycle: "dead" });
  const usada = (id) => ({ sessionId: id, paid: false, lifecycle: "used" });
  const desconocida = (id) => ({ sessionId: id, paid: false, lifecycle: "vete_a_saber" });

  const casos = [
    [[muerta("a"), viva("b")], SS.ONE_LIVE],
    [[muerta("a"), paid("b")], SS.PAID_ALONE],
    [[viva("a"), paid("b")], SS.PAID_WITH_OPEN],
    [[paid("a"), paid("b")], SS.DOUBLE_CHARGE],
    [[desconocida("a"), paid("b")], SS.PAID_WITH_OPEN],
    [[viva("a"), viva("b")], SS.MANY_LIVE],
    [[muerta("a"), muerta("b")], SS.ALL_DEAD],
    // Una sesión CONSUMIDA sin pago declarado no es una sesión muerta: un pago
    // asíncrono iniciado antes puede liquidarse después, así que no se puede
    // vender encima. Meterla en el mismo cajón que una expirada fue un fallo de
    // la primera versión de esta función, y lo cazó la sonda de permutaciones.
    [[usada("a"), muerta("b")], SS.CONSUMED],
    [[usada("a"), usada("b")], SS.CONSUMED],
    [[usada("a"), paid("b")], SS.PAID_WITH_OPEN],
    [[desconocida("a"), muerta("b")], SS.UNRESOLVED],
    // tres mezcladas
    [[muerta("a"), viva("b"), paid("c")], SS.PAID_WITH_OPEN],
    [[muerta("a"), muerta("b"), paid("c")], SS.PAID_ALONE],
    [[paid("a"), paid("b"), viva("c")], SS.DOUBLE_CHARGE],
    [[desconocida("a"), viva("b"), muerta("c")], SS.UNRESOLVED],
    [[muerta("a"), usada("b"), viva("c")], SS.ONE_LIVE],
  ];
  for (const [set, esperado] of casos) {
    const vistos = new Set(permutaciones(set).map((p) => JSON.stringify(D.decideSessionSet(p))));
    assert.equal(vistos.size, 1,
      `el orden cambió el veredicto de ${JSON.stringify(set.map((x) => x.sessionId))}`);
    const r = D.decideSessionSet(set);
    assert.equal(r.kind, esperado, JSON.stringify(set));
  }
  assert.equal(D.decideSessionSet([]).kind, SS.NONE);
  assert.equal(D.decideSessionSet(null).kind, SS.NONE);
});

test("MON003 · C6.4 — PROPIEDAD: un cobro nunca queda invisible, en ningún orden", () => {
  // Espacio completo de conjuntos de hasta 4 sesiones con los cinco estados, en
  // todas sus permutaciones: si hay un cobro declarado, el veredicto SIEMPRE lo
  // nombra, y nunca puede leerse como "todas muertas" ni como "una viva".
  const formas = [
    { paid: true, lifecycle: "used" },
    { paid: false, lifecycle: "chargeable" },
    { paid: false, lifecycle: "dead" },
    { paid: false, lifecycle: "used" },
    { paid: false, lifecycle: "???" },
  ];
  const combos = (n) => (n === 0 ? [[]]
    : combos(n - 1).flatMap((resto) => formas.map((f) => resto.concat([f]))));
  let conjuntos = 0;
  for (let largo = 1; largo <= 4; largo++) {
    for (const combo of combos(largo)) {
      const set = combo.map((f, i) => ({ sessionId: "s" + i, ...f }));
      const cobros = set.filter((x) => x.paid === true).map((x) => x.sessionId).sort();
      const vistos = new Set(permutaciones(set).map((p) => JSON.stringify(D.decideSessionSet(p))));
      assert.equal(vistos.size, 1, `orden relevante en ${JSON.stringify(combo)}`);
      const r = D.decideSessionSet(set);
      conjuntos++;
      if (cobros.length) {
        assert.deepEqual(r.paid, cobros, "el cobro tiene que estar nombrado");
        assert.notEqual(r.kind, D.SESSION_SET.ALL_DEAD);
        assert.notEqual(r.kind, D.SESSION_SET.ONE_LIVE);
        assert.notEqual(r.kind, D.SESSION_SET.MANY_LIVE);
        assert.notEqual(r.kind, D.SESSION_SET.NONE);
        if (cobros.length > 1) assert.equal(r.kind, D.SESSION_SET.DOUBLE_CHARGE);
      }
      // Y "todas muertas" sólo puede decirse si de verdad no queda nada vivo.
      if (r.kind === D.SESSION_SET.ALL_DEAD) {
        // "Todas muertas" es la ÚNICA respuesta que autoriza vender encima, así
        // que tiene que ser estricta: ni cobros, ni vivas, ni consumidas, ni
        // desconocidas.
        assert.equal(r.paid.length, 0);
        assert.equal(r.live.length, 0);
        assert.equal(r.consumed.length, 0, "una consumida puede liquidarse todavía");
        assert.equal(r.unknown.length, 0);
        assert.equal(r.dead.length, set.length, "todas, y demostradas");
      }
      // Y un cobro con algo sin cerrar al lado nunca puede leerse como "el cobro
      // está solo".
      if (r.kind === D.SESSION_SET.PAID_ALONE) {
        assert.equal(r.paid.length, 1);
        assert.equal(r.live.length + r.consumed.length + r.unknown.length, 0);
      }
    }
  }
  assert.equal(conjuntos, 5 + 25 + 125 + 625);
});

test("MON003 · C6.5 — SERVER: la pista se UNE al conjunto, nunca lo cortocircuita", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "async function locateSessionForPurchase(intent, hint)");
  // La pista añade a un Map y el descubrimiento sigue.
  assert.ok(body.includes("encontradas.set(observed.sessionId, observed)"));
  const hintAt = body.indexOf("encontradas.set(observed.sessionId, observed)");
  const listAt = body.indexOf("listCheckoutSessions(");
  assert.ok(hintAt !== -1 && listAt !== -1 && hintAt < listAt,
    "la pista se recoge antes, pero NO evita el listado");
  // Ningún return entre aceptar la pista y empezar a listar, salvo el de
  // 'nunca se intentó' — que además contempla la contradicción.
  const entre = body.slice(hintAt, listAt);
  const returns = entre.match(/\breturn\b/g) || [];
  assert.ok(returns.length <= 5, "demasiadas salidas antes del descubrimiento: " + returns.length);
  // Y ninguna de esas salidas puede ser un "no existe nada" cuando SÍ se encontró
  // algo: eso es lo que dejaría una hermana invisible.
  assert.ok(!/encontradas\.size[\s\S]{0,120}absent: true/.test(entre));
  assert.ok(entre.includes("session_found_without_marker"),
    "una pista válida sin marca es una contradicción que se registra, no se ignora");
  // Un Map por id: la misma sesión vista dos veces cuenta una.
  assert.ok(body.includes("new Map()"));
});

test("MON003 · C6.6 — SERVER: la multiplicidad se audita, se cura si puede, y si no bloquea", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "async function resolveMultipleSessions(intent, sessions)");
  // Se audita ANTES de tocar nada.
  const auditAt = body.indexOf("flagOpenSetAttention(intent.slug");
  const expireAt = body.indexOf("expireCheckoutSession(");
  assert.ok(auditAt !== -1 && expireAt !== -1 && auditAt < expireAt,
    "si la curación falla, el hecho ya quedó escrito");
  assert.ok(body.includes("INCIDENT.MANY_SESSIONS"));
  assert.ok(body.includes("INCIDENT.DOUBLE_CHARGE"));
  // Dos cobros no se curan.
  assert.ok(body.indexOf("SESSION_SET.DOUBLE_CHARGE") < expireAt);
  // Tras matar se vuelve a PREGUNTAR, no se supone.
  assert.ok(body.includes("retrieveCheckoutSession(o.sessionId)"));
  assert.ok(body.includes("decideSessionSet(despues)"));
  // Sólo dos salidas permiten seguir, y ninguna elige "la primera".
  assert.ok(body.includes("SESSION_SET.PAID_ALONE"));
  assert.ok(body.includes("sessions.find((o) => o.paid === true)"),
    "cuando hay un cobro, la elegida es la que TIENE el dinero");
  assert.ok(body.includes("SESSION_SET.ALL_DEAD"));
  assert.ok(body.includes("SESSION_SET.CONSUMED"),
    "una consumida sin pago no se sustituye: se conserva para confirmar");
  assert.ok(body.includes("OPEN_INTENT.UNRESOLVED"));
  // NINGUNA elección es posicional: cuando hay que señalar una, se ordena por id.
  assert.ok(!/sessions\[0\]/.test(body), "elegir por posición es depender del orden");
  assert.ok(body.includes("localeCompare"), "se señala por un criterio estable");
  // Y el veredicto se devuelve como FINAL: quien llama no vuelve a clasificar.
  assert.ok(body.includes("decided: true"));
  // Y nunca crea nada.
  assert.ok(!body.includes("createSessionFor"));
  assert.ok(!body.includes("createCheckoutSession"));
  // La curación puede REVELAR un cargo doble —una que iba a matarse acababa de
  // cobrar— y ese hecho tampoco puede quedarse sin auditar.
  assert.ok(body.includes("session_double_charge_revealed"));
  assert.ok(body.includes('via: "double_charge_revealed"'));
  const revelado = body.indexOf("double_charge_revealed");
  assert.ok(revelado > body.indexOf("decideSessionSet(despues)"),
    "se comprueba DESPUES de volver a preguntar");
  assert.ok(body.slice(revelado).includes("anotar([D.INCIDENT.DOUBLE_CHARGE])"));
});

test("MON003 · C6.7 — SERVER: las DOS rutas que descubren manejan multiplicidad", () => {
  const src = stripComments(serverSrc);
  // El checkout.
  const resolve = cuerpoDe(src, "async function resolveOpenIntent(intent, currentOffer, reusable = true)");
  assert.ok(resolve.includes("if (found.multiple)"));
  assert.ok(resolve.includes("resolveMultipleSessions(intent, found.multiple)"));
  assert.ok(resolve.indexOf("found.multiple") < resolve.indexOf("found.absent"),
    "la multiplicidad se resuelve ANTES de poder concluir una ausencia");
  // El veredicto del conjunto se devuelve tal cual: volver a clasificar a partir
  // de la sesión señalada tiraría lo que se sabe del resto.
  assert.ok(resolve.includes("checkout_session_multiplicity_resolved"));
  const multAt = resolve.indexOf("resolveMultipleSessions(intent, found.multiple)");
  const classifyAt = resolve.indexOf("classifyOpenIntent(observed, matches)");
  const returnAt = resolve.indexOf("return { outcome: r.outcome, url, sessionId,");
  assert.ok(returnAt !== -1 && returnAt > multAt && returnAt < classifyAt,
    "la rama de multiplicidad sale con su propio veredicto");
  // Y la reconciliación.
  const status = src.slice(src.indexOf('app.get("/api/quinielas/:slug/checkout/:purchaseId"'));
  const stBody = status.slice(0, status.indexOf("\n});"));
  assert.ok(stBody.includes("if (found.multiple)"));
  assert.ok(stBody.includes("resolveMultipleSessions(intent, found.multiple)"));
  assert.ok(stBody.includes("reconcile_multiplicity"));
  // La reconciliación sigue sin poder crear nada.
  assert.ok(!stBody.includes("createSessionFor"));
});

test("MON003 · C6.8 — la expiración es explícita, determinista y dentro del rango", () => {
  const src = stripComments(serverSrc);
  // El caller la pasa SIEMPRE.
  const mk = cuerpoDe(src, "async function createSessionFor(intent, slug)");
  assert.ok(mk.includes("expiresAt: attempt.expiresAt"),
    "congelada con el intento, no recalculada");
  // Y el adaptador la manda.
  const adapter = stripComments(
    fs.readFileSync(path.join(__dirname, "..", "payments", "stripeAdapter.js"), "utf8"));
  // `expiresAt` es un parámetro declarado de la creación…
  assert.ok(cuerpoDe(adapter, "async function createCheckoutSession(").includes("expiresAt"));
  // …y se traduce a `expires_at` en un único sitio del archivo.
  assert.equal((adapter.match(/params\.expires_at = expiresAt/g) || []).length, 1);

  // Y el cálculo se prueba con números, no leyendo su código.
  const A = require("../payments/stripeAdapter");
  const DIA = 24 * 60 * 60 * 1000;
  const MEDIA = 30 * 60 * 1000;
  assert.equal(A.SESSION_MAX_LIFETIME_MS, DIA, "el techo contractual");
  assert.equal(A.SESSION_MIN_LIFETIME_MS, MEDIA, "el suelo contractual");
  const ahora = Date.parse("2026-09-15T12:00:00.000Z");
  const de = (h) => new Date(ahora - h * 3600 * 1000).toISOString();

  // Una compra recién creada: el techo, 24 h.
  assert.equal(A.checkoutExpiresAt(de(0), ahora) * 1000, ahora + DIA);
  // Una de hace una hora: 23 h, porque se ancla en la COMPRA.
  assert.equal(A.checkoutExpiresAt(de(1), ahora) * 1000, ahora + DIA - 3600 * 1000);

  // DETERMINISMO, que es lo que permite reintentar con la misma clave: el mismo
  // `createdAt` da el mismo instante aunque se pida en momentos distintos.
  for (const h of [0, 1, 5, 12, 20]) {
    assert.equal(A.checkoutExpiresAt(de(h), ahora), A.checkoutExpiresAt(de(h), ahora + 60 * 1000),
      "un reintento con la misma clave debe pedir los MISMOS parámetros");
  }

  // Y SIEMPRE dentro del rango contractual, para cualquier antigüedad y para una
  // fecha ilegible.
  for (const createdAt of [de(0), de(1), de(23), de(23.5), de(24), de(48), de(500),
    "no-es-fecha", null, undefined, ""]) {
    const v = A.checkoutExpiresAt(createdAt, ahora) * 1000;
    assert.ok(v >= ahora + MEDIA, `por debajo del suelo con ${createdAt}: ${new Date(v).toISOString()}`);
    assert.ok(v <= ahora + DIA, `por encima del techo con ${createdAt}`);
  }
  // Una compra tan vieja que el instante deseado ya pasó: se recorta al suelo, no
  // se manda una fecha pasada que el proveedor rechazaría.
  assert.ok(A.checkoutExpiresAt(de(500), ahora) * 1000 > ahora);
  // Y se devuelve en SEGUNDOS enteros, que es lo que el proveedor espera.
  assert.ok(Number.isSafeInteger(A.checkoutExpiresAt(de(1), ahora)));
  assert.ok(A.checkoutExpiresAt(de(1), ahora) < 1e12, "segundos, no milisegundos");
});

test("MON003 · C6.9 — los comentarios ya no afirman lo que dejó de ser cierto", () => {
  const server = serverSrc;
  const adapter = fs.readFileSync(path.join(__dirname, "..", "payments", "stripeAdapter.js"), "utf8");
  // Las tres afirmaciones que Correction 06 volvió falsas, literalmente.
  for (const obsoleto of [
    "Es AUDITORÍA, no lógica",
    "Es AUDITORÍA:",
    "la lógica no depende de este campo",
    "ésa es la pieza que sostiene",
    "Su fallo no impide nada (es auditoría)",
  ]) {
    assert.ok(!server.includes(obsoleto), `comentario obsoleto en server.js: "${obsoleto}"`);
  }
  assert.ok(!adapter.includes("La nuestra vive en el purchase"),
    "el adaptador ya no presenta la clave como la idempotencia principal");
  // Y el contrato nuevo está escrito donde vive el invariant.
  assert.ok(server.includes("marca de intento DURABLE"));
  assert.ok(server.includes("descubrimiento completo"));
  assert.ok(server.includes("identidad verificada"));
  assert.ok(server.includes("verdad del pago"));
  assert.ok(adapter.includes("NO es la pieza que sostiene la"));
  // La marca se describe como precondición, no como nota.
  assert.ok(server.includes("LA PRECONDICIÓN DE TODO"));
});

// ==== 21 · Correction 07: intentos en el tiempo, y hermanas visibles ==========
//
// El contrato, ampliado: CADA emisión deja su ventana durable; los parámetros son
// estables por clave; y un id guardado no demuestra que no exista otra sesión.

test("MON003 · C7.1 — cada emisión deja su ventana, y las ventanas se fusionan", () => {
  const w = (at) => ({ seq: 1, at, idempotencyKey: "k", expiresAt: 1 });
  const M = 15 * 60 * 1000;
  // Un solo intento: una ventana centrada en él.
  const uno = D.discoveryWindows({ attempts: [w("2026-09-15T12:00:00.000Z")] }, M);
  assert.equal(uno.length, 1);
  assert.equal(uno[0].from, Date.parse("2026-09-15T11:45:00.000Z"));
  assert.equal(uno[0].to, Date.parse("2026-09-15T12:15:00.000Z"));

  // Dos intentos separados 23 h 40: DOS ventanas. Éste es el caso del ticket — la
  // sesión del segundo quedaba fuera por construcción.
  const lejos = D.discoveryWindows({ attempts: [
    { ...w("2026-09-15T12:00:00.000Z"), seq: 1 },
    { ...w("2026-09-16T11:40:00.000Z"), seq: 2 }] }, M);
  assert.equal(lejos.length, 2);
  assert.ok(lejos[1].from > lejos[0].to, "y no se solapan");

  // Dos intentos juntos: UNA ventana fusionada, para no gastar dos consultas.
  const juntos = D.discoveryWindows({ attempts: [
    { ...w("2026-09-15T12:00:00.000Z"), seq: 1 },
    { ...w("2026-09-15T12:05:00.000Z"), seq: 2 }] }, M);
  assert.equal(juntos.length, 1);

  // El orden de la lista no cambia las ventanas.
  const alReves = D.discoveryWindows({ attempts: [
    { ...w("2026-09-16T11:40:00.000Z"), seq: 2 },
    { ...w("2026-09-15T12:00:00.000Z"), seq: 1 }] }, M);
  assert.deepEqual(alReves, lejos);

  // Legado: sólo `creationAttemptedAt` cuenta como el primer intento, para que su
  // ventana siga buscándose.
  const legado = D.discoveryWindows({ creationAttemptedAt: "2026-09-15T12:00:00.000Z" }, M);
  assert.deepEqual(legado, uno);
  // Y sin ninguna marca no hay ventana: no se pudo emitir nada.
  assert.deepEqual(D.discoveryWindows({}, M), []);
  // Una fecha ilegible no inventa una ventana.
  assert.deepEqual(D.discoveryWindows({ attempts: [w("no-es-fecha")] }, M), []);
});

test("MON003 · C7.2 — una identidad se reutiliza mientras sus parámetros sirvan", () => {
  const ahora = Date.parse("2026-09-15T12:00:00.000Z");
  const MEDIA = 30 * 60 * 1000;
  const att = (horasRestantes) => ({ seq: 1, at: "x", idempotencyKey: "k",
    expiresAt: Math.floor((ahora + horasRestantes * 3600 * 1000) / 1000) });
  // Con holgura de sobra, se reutiliza: misma clave, mismos parámetros.
  assert.equal(D.isAttemptReusable(att(20), ahora, MEDIA), true);
  assert.equal(D.isAttemptReusable(att(1), ahora, MEDIA), true);
  // Por debajo del suelo contractual, ya no: hay que estrenar identidad.
  assert.equal(D.isAttemptReusable(att(0.4), ahora, MEDIA), false);
  assert.equal(D.isAttemptReusable(att(-1), ahora, MEDIA), false);
  // Y un intento sin clave o sin expiración —el legado— nunca se reutiliza: no se
  // sabe con qué parámetros se pidió.
  assert.equal(D.isAttemptReusable({ seq: 1, at: "x" }, ahora, MEDIA), false);
  assert.equal(D.isAttemptReusable({ seq: 1, at: "x", idempotencyKey: "k" }, ahora, MEDIA), false);
  assert.equal(D.isAttemptReusable(null, ahora, MEDIA), false);
});

test("MON003 · C7.3 — SERVER: cada emisión se registra, y la identidad se hereda", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "async function recordCreationAttempt(purchaseId, nowMs)");
  // La fila se añade SIEMPRE: la ventana la fija el instante de la emisión, no el de
  // la primera. Reutilizar el registro entero era el agujero por otra puerta.
  assert.ok(body.includes("concat([attempt])"));
  assert.ok(body.includes("idempotencyKey: reutilizable ? ultimo.idempotencyKey"));
  assert.ok(body.includes("expiresAt: reutilizable ? ultimo.expiresAt"));
  // Se commitea antes de devolver, y cualquier fallo sube.
  assert.ok(body.includes('await client.query("COMMIT")'));
  assert.ok(body.includes("throw err"));
  assert.ok(body.includes('throw new Error("creation_marker_purchase_missing")'));
  // El tope no poda ninguna ventana: falla cerrado.
  assert.ok(body.includes("MAX_CREATION_ATTEMPTS"));
  assert.ok(body.includes('throw new Error("creation_attempts_exhausted")'));
  assert.ok(!body.includes("slice(-"), "no se descarta ninguna ventana");
  // Y la marca legada se conserva: es la que sostiene 'sin marca, cero emisiones'.
  assert.ok(body.includes("creationAttemptedAt: p.creationAttemptedAt || at"));
});

test("MON003 · C7.4 — SERVER: el descubrimiento recorre TODAS las ventanas", () => {
  const src = stripComments(serverSrc);
  const body = cuerpoDe(src, "async function locateSessionForPurchase(intent, hint)");
  assert.ok(body.includes("discoveryWindows(intent, SESSION_LOOKUP_MARGIN_MS)"));
  assert.ok(body.includes("for (const w of ventanas)"));
  // Y las sesiones ya GUARDADAS entran siempre en el conjunto, antes que nada.
  const storedAt = body.indexOf('mirar(id, "stored")');
  const hintAt = body.indexOf('mirar(hint, "hint")');
  const listAt = body.indexOf("listCheckoutSessions(");
  assert.ok(storedAt !== -1 && hintAt !== -1 && listAt !== -1);
  assert.ok(storedAt < hintAt && hintAt < listAt,
    "guardadas, pista, listado: y ninguna puede tapar a otra");
  // Una guardada que no se puede leer NO es una ausencia.
  assert.ok(body.includes('conflict = conflict || "stored_session_unreadable"'));
  assert.ok(body.includes('{ unknown: true, via: "stored_unreadable"'));
});

test("MON003 · C7.5 — un id guardado no demuestra que no haya hermanas", () => {
  const conUno = { id: "qpur_a", providerSessionId: "cs_a",
    attempts: [{ seq: 1, at: "2026-09-15T12:00:00.000Z", idempotencyKey: "k", expiresAt: 1 }],
    sessionSetVerified: { at: "2026-09-15T12:00:00.000Z", attempts: 1 } };
  // Con una emisión y la unicidad comprobada, no hace falta preguntar.
  assert.equal(D.needsSessionDiscovery(conUno), false);
  // Pero en cuanto aparece otra emisión, la comprobación caduca.
  assert.equal(D.needsSessionDiscovery({ ...conUno,
    attempts: conUno.attempts.concat([{ seq: 2, at: "2026-09-16T12:00:00.000Z", idempotencyKey: "k2", expiresAt: 2 }]) }), true);
  // Y con multiplicidad conocida, siempre.
  assert.equal(D.needsSessionDiscovery({ ...conUno, providerSessionIds: ["cs_a", "cs_b"] }), true);
  // Sin sesión guardada, siempre.
  assert.equal(D.needsSessionDiscovery({ ...conUno, providerSessionId: null }), true);
  // Una fila legada, sin comprobación, siempre.
  assert.equal(D.needsSessionDiscovery({ id: "qpur_a", providerSessionId: "cs_a",
    creationAttemptedAt: "2026-09-15T12:00:00.000Z" }), true);
  // Y los ids conocidos incluyen los dos campos, sin duplicar y ordenados.
  assert.deepEqual(D.knownSessionIdsOf({ providerSessionId: "cs_b",
    providerSessionIds: ["cs_a", "cs_b", null, ""] }), ["cs_a", "cs_b"]);
});

test("MON003 · C7.6 — SERVER: el camino rápido no decide, y su ceguera está acotada", () => {
  const src = stripComments(serverSrc);
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout", rateLimit'));
  const body = co.slice(0, co.indexOf("\n});"));
  // Sólo sirve un enlace que ya existe: no otorga, no mata nada y no abre ventas.
  const rapido = body.slice(body.indexOf("const fresca ="), body.indexOf("const key = paymentsDomain.replacementKey"));
  assert.ok(!rapido.includes("openPurchase"));
  assert.ok(!rapido.includes("createSessionFor"));
  assert.ok(!rapido.includes("expireCheckoutSession"));
  assert.ok(!rapido.includes("confirmPaymentAndGrant"));
  // Y pide unicidad establecida + frescura, que es lo que acota cuánto puede estar
  // desactualizado lo que devuelve.
  assert.ok(body.includes("!paymentsDomain.needsSessionDiscovery(reusable)"));
  assert.ok(body.includes("CHECKOUT_FASTPATH_WINDOW_MS"));
  assert.ok(src.includes("const CHECKOUT_FASTPATH_WINDOW_MS = 10 * 60 * 1000"));
  // Los caminos que SÍ deciden descubren siempre.
  const resolve = cuerpoDe(src, "async function resolveOpenIntent(intent, currentOffer, reusable = true)");
  assert.ok(!/if \(!sessionId\)/.test(resolve), "ya no se salta el descubrimiento por tener un id");
  assert.ok(resolve.includes("locateSessionForPurchase(intent, null)"));
});

test("MON003 · C7.7 — la expiración se congela por emisión, y en rango", () => {
  const A = require("../payments/stripeAdapter");
  const DIA = 24 * 3600 * 1000;
  const MEDIA = 30 * 60 * 1000;
  const ahora = Date.parse("2026-09-15T12:00:00.000Z");
  // Se pide con el instante de LA EMISIÓN, así que siempre sale el techo.
  const at = new Date(ahora).toISOString();
  assert.equal(A.checkoutExpiresAt(at, ahora) * 1000, ahora + DIA);
  // Y es estable: el mismo instante de emisión da el mismo valor, se pida cuando se
  // pida. Es lo que permite repetir con la misma clave.
  assert.equal(A.checkoutExpiresAt(at, ahora), A.checkoutExpiresAt(at, ahora + 5 * 60 * 1000));
  // Siempre en rango contractual respecto a `nowMs`.
  for (const h of [0, 1, 12, 23, 25, 200]) {
    const emision = new Date(ahora - h * 3600 * 1000).toISOString();
    const v = A.checkoutExpiresAt(emision, ahora) * 1000;
    assert.ok(v >= ahora + MEDIA && v <= ahora + DIA, `fuera de rango con ${h}h`);
  }
});

test("MON003 · C7.8 — un pago ajeno REETIQUETADO no habilita otra quiniela", () => {
  // Hallazgo propio de Correction 07. Al admitir hermanas, la identidad la daba la
  // metadata — y un pago real de otra compra con la metadata reescrita cumplía todos
  // los controles: mismo importe, misma moneda, mismo torneo.
  //
  // Lo cierra que la identidad viaja en DOS portadores independientes que nosotros
  // escribimos al crear: en una sesión legítima siempre coinciden, así que discrepar
  // sólo puede ser un reetiquetado. Hoy eso exigiría el signing secret; comprobarlo
  // cuesta nada y no rechaza nada legítimo.
  const mine = intentOf({ providerSessionId: "cs_mine" });
  const reetiquetado = observedOf({
    sessionId: "cs_de_otra_venta",
    purchaseId: mine.id,            // la metadata dice que es nuestro…
    metadataPurchaseId: mine.id,
    clientReferenceId: "qpur_de_otra_venta",   // …pero el otro portador no
  });
  const d = decide(mine, reetiquetado);
  assert.equal(d.decision, D.DECISION.IDENTITY_MISMATCH);
  assert.equal(d.attention, D.ATTENTION.IDENTITY_MISMATCH);

  // Y al revés: reetiquetar el `client_reference_id` tampoco cuela.
  assert.equal(decide(mine, observedOf({
    sessionId: "cs_x", purchaseId: "qpur_otra", metadataPurchaseId: "qpur_otra",
    clientReferenceId: mine.id })).decision, D.DECISION.IDENTITY_MISMATCH);

  // Una hermana legítima lleva los DOS portadores coherentes, y sí confirma.
  const hermana = decide(mine, observedOf({
    sessionId: "cs_hermana", purchaseId: mine.id,
    metadataPurchaseId: mine.id, clientReferenceId: mine.id }));
  assert.equal(hermana.decision, D.DECISION.CONFIRM);
  assert.equal(hermana.attention, D.ATTENTION.MANY_SESSIONS);

  // Con un solo portador presente se sigue aceptando: una sesión antigua puede no
  // llevar los dos, y ahí manda el que haya.
  assert.equal(decide(mine, observedOf({
    sessionId: "cs_mine", purchaseId: mine.id,
    metadataPurchaseId: mine.id, clientReferenceId: null })).decision, D.DECISION.CONFIRM);
  assert.equal(decide(mine, observedOf({
    sessionId: "cs_mine", purchaseId: mine.id,
    metadataPurchaseId: null, clientReferenceId: mine.id })).decision, D.DECISION.CONFIRM);
});

test("MON003 · C7.9 — las DOS normalizaciones exponen la MISMA identidad", () => {
  // La razón estructural por la que C7.8 pudo existir: el chequeo de los dos
  // portadores vivía en el dominio, pero `normalizeEvent` no los subía, así que el
  // webhook —que es LA autoridad— era la vía más laxa de las dos.
  //
  // Esta prueba impide que vuelvan a divergir.
  const stripeA = require("../payments/stripeAdapter");
  const base = {
    id: "cs_1", amount_total: 19900, currency: "mxn", status: "complete",
    payment_status: "paid", payment_intent: "pi_1",
    created: 1000, expires_at: 2000, url: null,
    client_reference_id: "qpur_a",
    metadata: { qracks_purchase_id: "qpur_a", qracks_slug: "liga", qracks_scope_id: SCOPE },
  };
  const porSesion = stripeA.normalizeSession(base);
  const porEvento = stripeA.normalizeEvent({
    id: "evt_1", type: "checkout.session.completed", data: { object: base } });

  // Todo lo que el dominio usa para decidir tiene que existir y coincidir en ambas.
  for (const campo of ["purchaseId", "clientReferenceId", "metadataPurchaseId",
    "slugHint", "scopeHint", "sessionId", "paymentIntentId", "paid",
    "amountMinor", "currency", "lifecycle"]) {
    assert.deepEqual(porEvento[campo], porSesion[campo], `divergen en ${campo}`);
  }

  // Y con los portadores discrepando, las DOS vías lo exponen igual.
  const reetiquetado = { ...base, client_reference_id: "qpur_otra" };
  assert.equal(stripeA.normalizeSession(reetiquetado).clientReferenceId, "qpur_otra");
  assert.equal(stripeA.normalizeEvent({ id: "e", type: "checkout.session.completed",
    data: { object: reetiquetado } }).clientReferenceId, "qpur_otra");
  // Y el dominio las rechaza por igual.
  const mine = intentOf({ providerSessionId: "cs_1" });
  for (const o of [stripeA.normalizeSession(reetiquetado),
    stripeA.normalizeEvent({ id: "e", type: "checkout.session.completed", data: { object: reetiquetado } })]) {
    assert.equal(D.evaluateConfirmation({ intent: mine, observed: o,
      currentScopeId: SCOPE, quinielaExists: true }).decision, D.DECISION.IDENTITY_MISMATCH);
  }
});
