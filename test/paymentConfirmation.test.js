// MON-003 · confirmación visible del pago.
//
// "Pago completado. Tu quiniela ya tiene Plus." era un aviso que se iba a los 6
// segundos. Ahora es una tarjeta al inicio del panel Admin, con "Entendido",
// que sólo aparece cuando el SERVIDOR dice que esta compra dio Plus al torneo
// actual, sigue al navegar y al recargar, y no vuelve por la misma compra una
// vez descartada.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const { entitlementScopeId } = require("../planLimits");

const confirmedPurchaseIdOf = new Function("entitlementScopeId",
  serverSrc.slice(serverSrc.indexOf("function confirmedPurchaseIdOf(entry) {"),
    serverSrc.indexOf("// MON-003. Qué cubre Plus en esta quiniela")) + "; return confirmedPurchaseIdOf;")(entitlementScopeId);

const E1 = "ts:1:football:thesportsdb:4350:e1";
const E2 = "ts:1:football:thesportsdb:4350:e2";
const plusPorCompra = (over = {}) => ({ plan: "PLUS", source: "stripe_purchase", purchaseId: "qpur_a", scopeId: E1, revoked: false, ...over });

test("SERVIDOR · la compra que dio Plus al torneo ACTUAL, y ninguna otra cosa", () => {
  assert.equal(confirmedPurchaseIdOf({ entitlement: plusPorCompra(), tournamentScope: { id: E1 } }), "qpur_a");
  // Plus previo por otra vía: no hay compra que confirmar.
  assert.equal(confirmedPurchaseIdOf({ entitlement: plusPorCompra({ source: "manual_grant_plus" }), tournamentScope: { id: E1 } }), null);
  assert.equal(confirmedPurchaseIdOf({ entitlement: plusPorCompra({ source: "purchase" }), tournamentScope: { id: E1 } }), null,
    "Activar Plus del operador no es un pago con tarjeta");
  assert.equal(confirmedPurchaseIdOf({ entitlement: plusPorCompra({ purchaseId: undefined }), tournamentScope: { id: E1 } }), null);
  // Otro torneo, revocado, Gratis: nada.
  assert.equal(confirmedPurchaseIdOf({ entitlement: plusPorCompra(), tournamentScope: { id: E2 } }), null);
  assert.equal(confirmedPurchaseIdOf({ entitlement: plusPorCompra({ revoked: true }), tournamentScope: { id: E1 } }), null);
  assert.equal(confirmedPurchaseIdOf({ entitlement: { plan: "FREE" }, tournamentScope: { id: E1 } }), null);
  assert.equal(confirmedPurchaseIdOf(null), null);
  assert.equal(confirmedPurchaseIdOf({ entitlement: plusPorCompra() }), null, "sin ciclo legible, no se afirma nada");
});

test("SERVIDOR · /plan y el estado de la compra dicen lo mismo, con la misma función", () => {
  assert.ok(serverSrc.includes("confirmedPurchaseId: confirmedPurchaseIdOf(entry),"), "/plan");
  assert.ok(serverSrc.includes("plusApplied: intent.status === paymentsDomain.PURCHASE_STATUS.PAID\n        && confirmedPurchaseIdOf(entryAhora) === intent.id,"),
    "estado de la compra: pagada Y es la que dio Plus");
  // La compra con tarjeta se estampa con su id y source, y el grant copia ambos.
  assert.ok(serverSrc.includes('source: "stripe_purchase", grantedBy: "stripe",'));
  assert.ok(serverSrc.includes("entitlement.purchaseId = intent.id;"));
});

// ---- la pantalla ----
function pantalla(storage) {
  const code = indexSrc.slice(indexSrc.indexOf("  let confirmedPurchaseMem = null;"), indexSrc.indexOf("  function scheduleCheckoutRecheck("));
  const window = { localStorage: storage };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Function("window", "esc", "SLUG", `${code}; return { rememberConfirmedPurchase, confirmedPurchaseToShow,
    paymentConfirmedHtml, dismissConfirmedPurchase };`)(window, esc, "mi-quiniela");
}
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
const PLUS_A = { plan: "PLUS", confirmedPurchaseId: "qpur_a" };

test("PANTALLA · sin confirmación del servidor, no hay tarjeta (tampoco por tener Plus de antes)", () => {
  const ui = pantalla(memStorage());
  assert.equal(ui.paymentConfirmedHtml(PLUS_A), "", "Plus previo, sin compra recordada: nada");
  ui.rememberConfirmedPurchase("qpur_a");
  assert.equal(ui.confirmedPurchaseToShow({ plan: "FREE", confirmedPurchaseId: null }), null, "el servidor no dice Plus");
  assert.equal(ui.confirmedPurchaseToShow({ plan: "PLUS", confirmedPurchaseId: "qpur_otra" }), null, "Plus por otra compra");
  assert.equal(ui.confirmedPurchaseToShow({ plan: "PLUS", confirmedPurchaseId: null }), null, "Plus por otra vía");
  assert.equal(ui.confirmedPurchaseToShow(null), null, "plan ilegible");
});

test("PANTALLA · confirmada: tarjeta con el texto y 'Entendido'; persiste (recarga = misma memoria)", () => {
  const st = memStorage();
  pantalla(st).rememberConfirmedPurchase("qpur_a");
  const recargada = pantalla(st);        // otra carga de la página, mismo almacenamiento
  const html = recargada.paymentConfirmedHtml(PLUS_A);
  assert.match(html, /id="qz-payment-confirmed"/);
  assert.match(html, /Pago completado\. Tu quiniela ya tiene Plus\./);
  assert.match(html, /data-payment-confirmed-dismiss>Entendido</);
  assert.match(html, /data-purchase="qpur_a"/);
});

test("PANTALLA · descartada no vuelve por la MISMA compra, ni aunque se vuelva a confirmar", () => {
  const st = memStorage();
  const ui = pantalla(st);
  ui.rememberConfirmedPurchase("qpur_a");
  ui.dismissConfirmedPurchase("qpur_a");
  assert.equal(ui.paymentConfirmedHtml(PLUS_A), "");
  // La misma vuelta abierta otra vez (enlace del historial): el servidor vuelve a confirmar.
  ui.rememberConfirmedPurchase("qpur_a");
  assert.equal(pantalla(st).paymentConfirmedHtml(PLUS_A), "", "tras recargar tampoco");
  // Otra compra (otro torneo) sí tendría su propia tarjeta.
  ui.rememberConfirmedPurchase("qpur_b");
  assert.match(ui.paymentConfirmedHtml({ plan: "PLUS", confirmedPurchaseId: "qpur_b" }), /qpur_b/);
});

test("PANTALLA · sin almacenamiento, funciona en memoria durante la página", () => {
  const roto = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); }, removeItem() { throw new Error("x"); } };
  const ui = pantalla(roto);
  ui.rememberConfirmedPurchase("qpur_a");
  assert.match(ui.paymentConfirmedHtml(PLUS_A), /Pago completado/);
  ui.dismissConfirmedPurchase("qpur_a");
  assert.equal(ui.paymentConfirmedHtml(PLUS_A), "");
});

test("PANTALLA · al inicio del panel Admin, y ya no como aviso de 6 segundos", () => {
  const strip = indexSrc.slice(indexSrc.indexOf("async function renderPlanStrip()"));
  assert.ok(strip.includes("slot.innerHTML = paymentConfirmedHtml(plan);"), "en su propio espacio");
  assert.ok(strip.includes("wirePaymentConfirmed(slot);"));
  const admin = indexSrc.slice(indexSrc.indexOf("async function renderAdmin(main){"));
  const html = admin.slice(admin.indexOf("main.innerHTML = `"));
  assert.ok(html.indexOf('<div id="qz-payment-confirmed-slot"></div>') < html.indexOf('${screenHeaderHtml("admin"'),
    "antes del título y del consejo: al inicio del panel");
  // No convive con "Estamos confirmando tu pago…".
  const flujo = indexSrc.slice(indexSrc.indexOf("async function checkPurchaseOnce("));
  const ok = flujo.slice(flujo.indexOf("rememberConfirmedPurchase(purchaseId);"), flujo.indexOf('return "done";'));
  assert.ok(ok.includes("hideNotice();"));
  const once = indexSrc.slice(indexSrc.indexOf("async function checkPurchaseOnce("), indexSrc.indexOf("  // MON-003 · la tarjeta \"Pago completado\"."));
  assert.ok(!once.includes('notice("Pago completado'), "el aviso efímero se quitó");
  assert.ok(once.includes('if(plan && plan.plan === "PLUS" && plan.confirmedPurchaseId === purchaseId){'));
  // Sólo se recuerda tras la confirmación del servidor, nunca desde la URL de vuelta.
  const vuelta = indexSrc.slice(indexSrc.indexOf("async function resolveCheckoutReturn()"));
  assert.ok(!vuelta.slice(0, vuelta.indexOf("\n  }\n")).includes("rememberConfirmedPurchase"));
  assert.equal((indexSrc.match(/rememberConfirmedPurchase\(purchaseId\)/g) || []).length, 1);
});

test("VUELTA · una compra que el servidor no conoce para esta quiniela no deja la pantalla esperando", () => {
  const read = indexSrc.slice(indexSrc.indexOf("async function readCheckoutStatus("), indexSrc.indexOf("// El bucle de recuperación de un cobro"));
  assert.ok(read.includes('if(res.status === 404){'));
  assert.ok(read.includes('body && body.error === "purchase_not_found" ? { status: "not_found" } : null'),
    "sólo el 404 explícito de compra inexistente; cualquier otro fallo sigue esperando");
  const once = indexSrc.slice(indexSrc.indexOf("async function checkPurchaseOnce("), indexSrc.indexOf("  // MON-003 · la tarjeta \"Pago completado\"."));
  const nf = once.slice(once.indexOf('if(status && status.status === "not_found"){'));
  assert.ok(nf.startsWith('if(status && status.status === "not_found"){\n      clearPendingPurchase();'));
  assert.ok(!nf.slice(0, 200).includes("rememberConfirmedPurchase"), "y nunca muestra la tarjeta");
  assert.ok(serverSrc.includes('return res.status(404).json({ error: "purchase_not_found" });'));
});
