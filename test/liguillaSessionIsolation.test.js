// Liguilla · aislamiento del autoguardado por sesión (P1 de la revisión de e8fde8d).
//
// Ejecuta las funciones REALES del autoguardado de public/index.html (la cola,
// el envío y setAuthHeaders) con fetch y DOM simulados. Reproduce el caso que
// se encontró: A deja un guardado en curso y otro en cola, «Cambiar usuario»
// sin recargar, entra B, y el trabajo pendiente de A salía con la identidad y
// el PIN de B y quedaba en la fila de pronósticos de B.
//
// El recorrido en el navegador real (Cambiar usuario en la misma página, contra
// el servidor y PostgreSQL) es aparte; esto fija la lógica.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const L = require("../liguillaScoring");

function sliceFn(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start !== -1, "no está " + signature);
  let depth = 0, i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}
const blockStart = html.indexOf("  // ---------- LIGUILLA (sprint de liguilla, D1–D7) ----------");
const blockEnd = html.indexOf("  // ---- participante: votar", blockStart);
assert.ok(blockStart > 0 && blockEnd > blockStart, "bloque de liguilla");
const BLOCK = html.slice(blockStart, blockEnd);
const SET_AUTH = sliceFn(html, "function setAuthHeaders(headers, cred, bindTo)");

// Arma un «navegador» con el bloque real y un fetch controlable.
function harness() {
  const requests = [];
  const pending = [];
  const env = {
    window: { QracksLiguilla: L },
    fetch: (url, opts) => new Promise((resolve) => {
      const req = { url, headers: opts.headers, body: JSON.parse(opts.body), resolve };
      requests.push(req);
      pending.push(req);
    }),
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
  };
  const factory = new Function("env", `
    const window = env.window, fetch = env.fetch, document = env.document;
    let currentUser = null, currentUserPinCache = null, ownerPasswordCache = null, myPicks = {}, meta = { rounds: [], settings: {} };
    let SLUG = "lg-demo", activeTab = "otra", jornadaFilter = "porjugar";
    const toast = () => {}, renderJornada = () => {}, serverNow = () => Date.now(), isRoundLocked = () => false;
    const esc = (s) => String(s), humanizeError = (c) => String(c);
    ${SET_AUTH}
    ${BLOCK}
    return {
      as(user, pin, picks){ currentUser = user; currentUserPinCache = pin; myPicks = picks || {}; },
      // «Cambiar usuario»: lo que hace el botón de la app antes de volver al login.
      switchUser(){ if (typeof lgResetSession === "function") lgResetSession(); currentUser = null; currentUserPinCache = null; },
      picks(){ return myPicks; },
      lgEnqueue, lgRetryAll, lgSt, lgDraft, lgSetDraft, lgSetSt,
    };
  `);
  return { app: factory(env), requests, pending };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const ROUND = { id: "r_lg", stage: "liguilla", published: true, deadline: "2099-01-01T00:00:00Z",
  scoring: { capture: "score", resultPoints: 1, exactBonus: 1 }, matches: [{ id: "m1" }, { id: "m2" }] };
const A = { id: "p_ana" }, B = { id: "p_beto" };
const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value, acceptedAt: "2026-11-03T00:00:00Z" }) });
const pidOf = (req) => decodeURIComponent(req.url.split("/picks/")[1].split("/")[0]);

test("AISLAMIENTO · A→B: el trabajo en cola de A nunca sale con la identidad de B, y B no hereda su estado", async () => {
  const { app, requests, pending } = harness();
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  app.lgSetDraft(ROUND.id, "m2", { a: "3", b: "0" });
  app.lgEnqueue(ROUND, "m2", { a: 3, b: 0 });
  await tick();
  assert.equal(requests.length, 1, "el primero va en camino; el segundo espera en la cola");
  app.switchUser();
  app.as(B, "2222", {});
  pending.shift().resolve(ok({ a: 2, b: 1 }));        // llega tarde la respuesta del de A
  for (let i = 0; i < 5; i++) await tick();
  const foreign = requests.filter((r) => pidOf(r) === B.id || r.headers["X-Qracks-Participant"] === B.id || r.headers["X-Qracks-Auth"] === "2222");
  assert.deepEqual(foreign.map((r) => r.body), [], "nada de A sale como B");
  assert.equal(requests.length, 1, "el trabajo pendiente de A no se envía");
  assert.equal(app.lgSt(ROUND.id, "m2"), null, "B no ve el «Guardando…» de A");
  assert.equal(app.lgDraft(ROUND.id, "m2"), null, "ni su borrador");
  assert.deepEqual(app.picks(), {}, "la respuesta tardía de A no escribe en los pronósticos de B");
});

test("AISLAMIENTO · un guardado de A que nunca responde no bloquea los de B", async () => {
  const { app, requests } = harness();
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });         // queda colgado para siempre
  await tick();
  app.switchUser();
  app.as(B, "2222", {});
  app.lgEnqueue(ROUND, "m1", { a: 0, b: 0 });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(requests.length, 2);
  assert.equal(pidOf(requests[1]), B.id);
  assert.equal(requests[1].headers["X-Qracks-Auth"], "2222");
  assert.deepEqual(requests[1].body.value, { a: 0, b: 0 });
});

test("AISLAMIENTO · salir con trabajos pendientes: no se envía nada más y no falla", async () => {
  const { app, requests, pending } = harness();
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  app.lgEnqueue(ROUND, "m2", { a: 3, b: 0 });
  await tick();
  app.switchUser();                                    // nadie entra
  pending.shift().resolve(ok({ a: 2, b: 1 }));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(requests.length, 1);
  assert.equal(app.lgSt(ROUND.id, "m2"), null);
});

test("AISLAMIENTO · reintentar tras cambiar: el error de A no se reintenta como B", async () => {
  const { app, requests, pending } = harness();
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  pending.shift().resolve({ ok: false, status: 0, json: async () => { throw new Error("sin red"); } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(app.lgSt(ROUND.id, "m1").st, "error", "A ve su error");
  app.switchUser();
  app.as(B, "2222", {});
  assert.equal(app.lgSt(ROUND.id, "m1"), null, "B no ve el error de A");
  app.lgRetryAll(ROUND);                               // «Reintentar todo» en la pantalla de B
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(requests.length, 1, "nada se reintenta como B");
});

test("AISLAMIENTO · A→salir→A: lo de la sesión anterior no se envía ni pisa lo que el servidor ya aceptó", async () => {
  const { app, requests, pending } = harness();
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  app.lgEnqueue(ROUND, "m2", { a: 3, b: 0 });
  await tick();
  app.switchUser();
  // A vuelve a entrar: sus pronósticos se cargan del servidor (ya tiene el 2–1).
  const fresh = { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } };
  app.as(A, "1111", fresh);
  pending.shift().resolve(ok({ a: 2, b: 1 }));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(requests.length, 1, "el 3–0 de la sesión anterior no se envía solo");
  assert.deepEqual(app.picks(), fresh, "lo aceptado por el servidor sigue intacto");
});

test("AISLAMIENTO · A→salir→A con la respuesta aún en camino: al llegar se muestra lo que el servidor aceptó para A", async () => {
  const { app, requests, pending } = harness();
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  app.lgEnqueue(ROUND, "m2", { a: 3, b: 0 });
  await tick();
  app.switchUser();
  app.as(A, "1111", {});                               // al volver, el servidor aún no tenía el 2–1
  pending.shift().resolve(ok({ a: 2, b: 1 }));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(requests.length, 1, "el 3–0 sigue sin enviarse");
  assert.deepEqual(app.picks(), { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } }, "el 2–1 aceptado se muestra");
  assert.equal(app.lgSt(ROUND.id, "m2"), null);
  assert.equal(app.lgSt(ROUND.id, "m2"), null);
});

test("AISLAMIENTO · «Cambiar usuario» invalida la sesión de liguilla antes de volver a entrar", () => {
  const handler = sliceFn(html, 'document.getElementById("qz-switch-user").addEventListener("click", async () =>');
  assert.ok(handler.includes("lgResetSession()"), "el botón limpia cola, borradores y estados de liguilla");
});
