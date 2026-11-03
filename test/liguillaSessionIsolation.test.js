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
const SET_PICKS = sliceFn(html, "async function setPicksWithError(pid, data)");

// Arma un «navegador» con el bloque real y un fetch controlable.
function harness(opts = {}) {
  const requests = [];
  const pending = [];
  const confirms = [];
  const env = {
    window: { QracksLiguilla: L },
    fetch: (url, opts) => new Promise((resolve) => {
      const req = { url, headers: opts.headers, body: JSON.parse(opts.body), resolve };
      requests.push(req);
      pending.push(req);
    }),
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    qzConfirm: async (message, o) => { confirms.push({ message, o }); return !!opts.confirm; },
    kvSetWithError: opts.kvSet || (async () => ({ ok: true })),
    getPicks: opts.getPicks || (async () => ({})),
  };
  const factory = new Function("env", `
    const window = env.window, fetch = env.fetch, document = env.document, qzConfirm = env.qzConfirm;
    const kvSetWithError = env.kvSetWithError, getPicks = env.getPicks;
    let currentUser = null, currentUserPinCache = null, ownerPasswordCache = null, myPicks = {}, meta = { rounds: env.rounds || [], settings: {} };
    let SLUG = "lg-demo", activeTab = "otra", jornadaFilter = "porjugar";
    const toast = () => {}, renderJornada = () => {}, serverNow = () => Date.now(), isRoundLocked = () => false;
    const esc = (s) => String(s), humanizeError = (c) => String(c);
    ${SET_AUTH}
    const currentPicksKey = (pid) => "quiniela:" + SLUG + ":picks:" + pid;
    ${SET_PICKS}
    ${BLOCK}
    return {
      as(user, pin, picks){ currentUser = user; currentUserPinCache = pin; myPicks = picks || {}; },
      // «Cambiar usuario»: lo que hace el botón de la app antes de volver al login.
      switchUser(){ if (typeof lgResetSession === "function") lgResetSession(); currentUser = null; currentUserPinCache = null; },
      // El botón real: primero lgBeforeSwitch (si existe); si se cancela, no cambia.
      async clickSwitch(){
        if (typeof lgBeforeSwitch === "function" && !(await lgBeforeSwitch())) return false;
        this.switchUser(); return true;
      },
      // Entrar como en la app: currentUser primero y luego se cargan sus
      // pronósticos del servidor (myPicks = lgWithLate(await getPicks(id), id)).
      async login(user, pin, loadPicks){
        currentUser = user; currentUserPinCache = pin;
        const fresh = await loadPicks();
        myPicks = typeof lgWithLate === "function" ? lgWithLate(fresh, user.id) : fresh;
      },
      typeScore(round, matchId, a, b){
        const m = { id: matchId };
        lgOnScoreInput(round, m, "a", { value: String(a), setAttribute(){} }, false);
        lgOnScoreInput(round, m, "b", { value: String(b), setAttribute(){} }, false);
      },
      picks(){ return myPicks; },
      setRounds(rs){ meta.rounds = rs; },
      setPicksWithError,
      lgEnqueue, lgRetryAll, lgSt, lgDraft, lgSetDraft, lgSetSt,
    };
  `);
  return { app: factory(env), requests, pending, confirms };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ---- Technical QA de 6e12f12 ------------------------------------------------

test("CAMBIAR USUARIO · H2: lo que A dejó escribiendo se envía con la identidad de A antes de salir, sin preguntar", async () => {
  const { app, requests, pending, confirms } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.typeScore(ROUND, "m1", 2, 1);                    // aún en la espera de 700 ms
  assert.equal(requests.length, 0);
  const done = app.clickSwitch();
  await tick();
  assert.equal(requests.length, 1, "el 2–1 sale al pulsar «Cambiar usuario»");
  assert.equal(pidOf(requests[0]), A.id);
  assert.equal(requests[0].headers["X-Qracks-Auth"], "1111");
  pending.shift().resolve(ok({ a: 2, b: 1 }));
  assert.equal(await done, true, "guardado: cambia sin preguntar");
  assert.equal(confirms.length, 0);
  assert.equal(app.lgSt(ROUND.id, "m1"), null, "la sesión quedó limpia al salir");
  assert.equal(app.lgDraft(ROUND.id, "m1"), null);
});

test("CAMBIAR USUARIO · H2: si algo de A no se pudo guardar, se avisa; «Quedarme» no cierra la sesión ni borra su trabajo", async () => {
  const { app, requests, pending, confirms } = harness({ confirm: false });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  pending.shift().resolve({ ok: false, status: 0, json: async () => { throw new Error("sin red"); } });
  for (let i = 0; i < 5; i++) await tick();
  app.lgSetDraft(ROUND.id, "m2", { a: "3", b: "" });   // incompleto
  const changed = await app.clickSwitch();
  assert.equal(changed, false, "se queda");
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].message, /2 pronósticos de liguilla que todavía no quedan guardados/);
  assert.equal(confirms[0].o.confirmLabel, "Cambiar de todos modos");
  assert.equal(app.lgSt(ROUND.id, "m1").st, "error", "su error sigue a la vista");
  assert.deepEqual(app.lgDraft(ROUND.id, "m2"), { a: "3", b: "" }, "su borrador sigue");
  assert.equal(requests.length, 1);
});

test("CAMBIAR USUARIO · H2: «Cambiar de todos modos» sí cambia y B no hereda nada", async () => {
  const { app, pending } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  pending.shift().resolve({ ok: false, status: 0, json: async () => { throw new Error("sin red"); } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(await app.clickSwitch(), true);
  app.as(B, "2222", {});
  assert.equal(app.lgSt(ROUND.id, "m1"), null);
});

test("ENTRADA · H3: si el 2–1 de A llega mientras A vuelve a entrar y su carga no lo trae, se muestra igual", async () => {
  const { app, pending } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  app.switchUser();
  let release;
  const loading = app.login(A, "1111", () => new Promise((r) => { release = r; }));
  pending.shift().resolve(ok({ a: 2, b: 1 }));        // llega a media carga
  for (let i = 0; i < 5; i++) await tick();
  release({});                                         // la lectura salió antes de que el servidor lo aceptara
  await loading;
  assert.deepEqual(app.picks(), { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } });
});

test("ENTRADA · H3: si llega con nadie dentro, A lo ve al volver; B no", async () => {
  const { app, pending } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  app.switchUser();
  pending.shift().resolve(ok({ a: 2, b: 1 }));
  for (let i = 0; i < 5; i++) await tick();
  await app.login(B, "2222", async () => ({}));
  assert.deepEqual(app.picks(), {}, "B no ve el pronóstico de A");
  await app.clickSwitch();
  await app.login(A, "1111", async () => ({}));
  assert.deepEqual(app.picks(), { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } });
});

test("ENTRADA · H4: lo aceptado tarde no pisa lo que A ya escribió o guardó en la sesión nueva", async () => {
  const { app, requests, pending } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  app.switchUser();
  await app.login(A, "1111", async () => ({}));
  app.lgEnqueue(ROUND, "m1", { a: 0, b: 0 });          // A cambia de idea en la sesión nueva
  await tick();
  assert.equal(requests.length, 2);
  pending.shift().resolve(ok({ a: 2, b: 1 }));        // llega el viejo
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(app.lgSt(ROUND.id, "m1").st, "saving", "sigue mostrando su 0–0 en camino");
  assert.equal(app.picks().r_lg, undefined, "el 2–1 viejo no se pinta encima");
  pending.shift().resolve(ok({ a: 0, b: 0 }));
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 0, b: 0 });
  // Y en la siguiente entrada tampoco revive el viejo.
  await app.clickSwitch();
  await app.login(A, "1111", async () => ({ r_lg: { m1: "D", __score: { m1: { a: 0, b: 0 } } } }));
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 0, b: 0 });
});

test("ENTRADA · H4: lo aplicado con A dentro no revive en una entrada posterior", async () => {
  const { app, pending } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  app.switchUser();
  await app.login(A, "1111", async () => ({}));
  pending.shift().resolve(ok({ a: 2, b: 1 }));        // ya dentro: se muestra
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 2, b: 1 });
  await app.clickSwitch();
  // Otro dispositivo lo cambió a 1–1 después; al volver manda el servidor.
  await app.login(A, "1111", async () => ({ r_lg: { m1: "D", __score: { m1: { a: 1, b: 1 } } } }));
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 1, b: 1 });
});

test("GUARDAR · H1: el reintento tras liguilla_pick_conflict conserva las respuestas de la jornada (__extra)", async () => {
  const sent = [];
  const { app } = harness({
    kvSet: async (key, value) => { sent.push(JSON.parse(JSON.stringify(value))); return sent.length === 1 ? { ok: false, error: "liguilla_pick_conflict" } : { ok: true }; },
    getPicks: async () => ({}),                        // el servidor aún no tiene esa jornada
  });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  const r = await app.setPicksWithError(A.id, { r_lg: { m1: "A", __extra: { q1: "Sí" } } });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { r_lg: { __extra: { q1: "Sí" } } }, "la respuesta extra sigue; el partido lo decide el servidor");
});

