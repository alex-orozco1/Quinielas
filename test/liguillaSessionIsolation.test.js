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
// AUD-01: el guardado de pronósticos es un bloque (base, cola, mezcla): se
// toma entero, desde su encabezado hasta setPicksWithError.
const SET_PICKS = (() => {
  const start = html.indexOf("  // ---- AUD-01 · guardar pronósticos sin pisar nada");
  assert.ok(start > 0, "bloque AUD-01");
  const fnStart = html.indexOf("  function setPicksWithError(pid, data)", start);
  assert.ok(fnStart > start, "setPicksWithError");
  return html.slice(start, fnStart) + sliceFn(html.slice(fnStart), "function setPicksWithError(pid, data)");
})();

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
    document: { els: {}, activeElement: null, getElementById: (id) => env.document.els[id] || null, querySelectorAll: () => [], querySelector: () => null },
    qzConfirm: async (message, o) => { confirms.push({ message, o }); return !!opts.confirm; },
    kvSetWithError: opts.kvSet || (async () => ({ ok: true })),
    loader: null,
    getPicks: null,
  };
  // «Servidor»: lo que una lectura de pronósticos devuelve. La carga al entrar
  // puede usar un cargador propio (una sola vez); las relecturas leen esto.
  env.server = opts.server || {};
  env.getPicks = async (pid, o) => {
    if (env.loader) { const l = env.loader; env.loader = null; return l(pid); }
    if (opts.getPicks) return opts.getPicks(pid);
    if (env.failReads) return o && o.strict ? null : {}; // como la real: estricta, un error es null
    return JSON.parse(JSON.stringify(env.server[pid] || {}));
  };
  env.toasts = [];
  // Lectura directa del «servidor» (la relectura tras una respuesta tardía).
  // env.reads permite retener o hacer fallar cada lectura.
  env.reads = [];
  env.kvGet = (key) => new Promise((resolve, reject) => {
    const pid = key.split(":picks:")[1];
    const snap = () => (env.server[pid] ? { found: true, value: JSON.parse(JSON.stringify(env.server[pid])) } : { found: false });
    if (env.holdReads) env.reads.push({ pid, ok: () => resolve(snap()), okWith: (v) => resolve({ found: true, value: v }), fail: () => reject(new Error("kv get failed: HTTP 500")) });
    else if (env.failReads) reject(new Error("kv get failed: HTTP 500"));
    else resolve(snap());
  });
  const factory = new Function("env", `
    const window = env.window, fetch = env.fetch, document = env.document, qzConfirm = env.qzConfirm;
    const kvSetWithError = env.kvSetWithError, getPicks = env.getPicks, kvGet = env.kvGet;
    let currentUser = null, currentUserPinCache = null, ownerPasswordCache = null, myPicks = {}, meta = { rounds: env.rounds || [], settings: {} };
    let SLUG = "lg-demo", activeTab = "otra", jornadaFilter = "porjugar";
    const toast = (m) => env.toasts.push(m), renderJornada = () => {}, serverNow = () => Date.now(), isRoundLocked = () => false;
    const esc = (s) => String(s), humanizeError = (c) => String(c), joinEs = (a) => a.join(", ");
    ${SET_AUTH}
    const currentPicksKey = (pid) => "quiniela:" + SLUG + ":picks:" + pid;
    ${SET_PICKS}
    ${BLOCK}
    return {
      as(user, pin, picks){ currentUser = user; currentUserPinCache = pin; myPicks = picks || {}; adoptPicksBase(user.id, myPicks); },
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
        env.loader = loadPicks;
        try{
          if (typeof lgReadPicks === "function") myPicks = await lgReadPicks(user.id);
          else { const fresh = await getPicks(user.id); myPicks = typeof lgWithLate === "function" ? lgWithLate(fresh, user.id) : fresh; }
        } finally { env.loader = null; }
      },
      type(round, matchId, side, v){ lgOnScoreInput(round, { id: matchId }, side, { value: String(v), setAttribute(){} }, false); },
      typeScore(round, matchId, a, b){
        const m = { id: matchId };
        lgOnScoreInput(round, m, "a", { value: String(a), setAttribute(){} }, false);
        lgOnScoreInput(round, m, "b", { value: String(b), setAttribute(){} }, false);
      },
      picks(){ return myPicks; },
      setRounds(rs){ meta.rounds = rs; },
      setPicksWithError,
      base(){ return myPicksBase; },
      pending(){ return picksPendingFor(lgGen); },
      lgEnqueue, lgRetryAll, lgSt, lgDraft, lgSetDraft, lgSetSt,
    };
  `);
  return { app: factory(env), requests, pending, confirms, toasts: env.toasts, server: env.server, env };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUND = { id: "r_lg", stage: "liguilla", published: true, deadline: "2099-01-01T00:00:00Z",
  scoring: { capture: "score", resultPoints: 1, exactBonus: 1 }, matches: [{ id: "m1" }, { id: "m2" }] };
const A = { id: "p_ana" }, B = { id: "p_beto" };
const ok = (value, acceptedAt = "2026-11-03T00:00:00Z") => ({ ok: true, status: 200, json: async () => ({ ok: true, value, acceptedAt }) });
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

test("AISLAMIENTO · A→salir→A con la respuesta aún en camino: al llegar se relee y se muestra lo que el servidor tiene para A", async () => {
  const { app, requests, pending, server } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  app.lgEnqueue(ROUND, "m2", { a: 3, b: 0 });
  await tick();
  app.switchUser();
  app.as(A, "1111", {});                               // al volver, el servidor aún no tenía el 2–1
  server[A.id] = { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } };                // ahora sí
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
  assert.ok(handler.indexOf("lgBeforeSwitch()") > -1 && handler.indexOf("lgBeforeSwitch()") < handler.indexOf("lgResetSession()"), "primero se guarda o se pregunta");
});

test("ENTRADA · las tres entradas cargan los pronósticos con lgReadPicks (lo aceptado tarde, con su orden)", () => {
  for (const id of ["currentUser.id", "newParticipant.id", "p.id"]) {
    assert.ok(html.includes("myPicks = await lgReadPicks(" + id + ");"), id);
  }
  assert.equal((html.match(/myPicks = await getPicks\(/g) || []).length, 0, "ninguna entrada lee sin pasar por lgReadPicks");
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

test("ENTRADA · H3: si el 2–1 de A llega mientras A vuelve a entrar y su carga no lo trae, se relee y se muestra", async () => {
  const { app, pending, server } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  app.switchUser();
  let release;
  const loading = app.login(A, "1111", () => new Promise((r) => { release = r; }));
  server[A.id] = { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } };
  pending.shift().resolve(ok({ a: 2, b: 1 }));        // llega a media carga
  for (let i = 0; i < 5; i++) await tick();
  release({});                                         // la lectura salió antes de que el servidor lo aceptara
  await loading;
  assert.deepEqual(app.picks(), { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } });
});

test("ENTRADA · H3: si llega con nadie dentro, B no lo ve; A al volver ve lo del servidor", async () => {
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
  // Esta lectura sale DESPUÉS de que llegó la respuesta: el servidor ya lo tiene.
  await app.login(A, "1111", async () => ({ r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } }));
  assert.deepEqual(app.picks(), { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } });
});

test("ENTRADA · H4: lo aceptado tarde no pisa lo que A ya escribió o guardó en la sesión nueva", async () => {
  const { app, requests, pending, server } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  app.switchUser();
  await app.login(A, "1111", async () => ({}));
  app.lgEnqueue(ROUND, "m1", { a: 0, b: 0 });          // A cambia de idea en la sesión nueva
  await tick();
  assert.equal(requests.length, 2);
  server[A.id] = { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } };                // el servidor aceptó el viejo; el 0–0 aún no
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
  const { app, pending, server } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  app.switchUser();
  await app.login(A, "1111", async () => ({}));
  server[A.id] = { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } };
  pending.shift().resolve(ok({ a: 2, b: 1 }));        // ya dentro: se relee y se muestra
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 2, b: 1 });
  await app.clickSwitch();
  // Otro dispositivo lo cambió a 1–1 después; al volver manda el servidor.
  await app.login(A, "1111", async () => ({ r_lg: { m1: "D", __score: { m1: { a: 1, b: 1 } } } }));
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 1, b: 1 });
});

test("GUARDAR · H1 (AUD-01): de una jornada de liguilla el documento sólo lleva las respuestas de la jornada (__extra); sus partidos los guarda su endpoint", async () => {
  const sent = [];
  const { app } = harness({
    kvSet: async (key, value, creds, extra) => { sent.push({ value: JSON.parse(JSON.stringify(value)), base: extra && extra.base }); return { ok: true, value: { r_lg: { __extra: { q1: "Sí" } } } }; },
  });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  const r = await app.setPicksWithError(A.id, { r_lg: { m1: "A", __extra: { q1: "Sí" } } });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].value, { r_lg: { __extra: { q1: "Sí" } } }, "la respuesta extra sí; el partido lo decide su propio endpoint");
  assert.deepEqual(sent[0].base, {}, "con la base que el servidor confirmó");
});

test("GUARDAR · AUD-01: sin la lectura de lo guardado no se manda nada", async () => {
  const sent = [];
  const { app } = harness({ kvSet: async (key, value) => { sent.push(value); return { ok: true }; } });
  app.setRounds([ROUND]);
  await app.login(A, "1111", async () => null);        // la lectura inicial falló
  const r = await app.setPicksWithError(A.id, { r_x: { m1: "A" } });
  assert.deepEqual([r.ok, r.error, sent.length], [false, "picks_not_loaded", 0]);
});

// ---- Technical QA de f7d4098 ------------------------------------------------

test("ENTRADA · F1: lo aceptado tarde NO pisa una lectura del servidor más nueva (otro dispositivo lo cambió)", async () => {
  const { app, pending } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 6, b: 6 });
  await tick();
  assert.equal(await app.clickSwitch(), true);         // colgado: «Cambiar de todos modos»
  await app.login(B, "2222", async () => ({}));
  pending.shift().resolve(ok({ a: 6, b: 6 }));        // llega con B dentro
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(app.picks(), {}, "B no ve nada");
  // Ana, en otro dispositivo, cambia a 0–1. Beto sale y Ana vuelve a entrar.
  await app.clickSwitch();
  await app.login(A, "1111", async () => ({ r_lg: { m1: "B", __score: { m1: { a: 0, b: 1 } } } }));
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 0, b: 1 }, "manda la lectura del servidor");
});

test("ENTRADA · F1: dos aceptados tardíos que llegan desordenados: manda lo que el servidor tiene, no el orden de llegada", async () => {
  const { app, pending, server } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  await app.clickSwitch();
  app.as(A, "1111", {});
  app.lgEnqueue(ROUND, "m1", { a: 3, b: 0 });
  await tick();
  await app.clickSwitch();
  let release;
  const loading = app.login(A, "1111", () => new Promise((r) => { release = r; }));
  const [first, second] = [pending.shift(), pending.shift()];
  server[A.id] = { r_lg: { m1: "A", __score: { m1: { a: 3, b: 0 } } } };
  second.resolve(ok({ a: 3, b: 0 }, "2026-11-03T00:00:02Z"));   // el más nuevo llega primero
  for (let i = 0; i < 5; i++) await tick();
  first.resolve(ok({ a: 2, b: 1 }, "2026-11-03T00:00:01Z"));
  for (let i = 0; i < 5; i++) await tick();
  release({});
  await loading;
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 3, b: 0 });
});

test("CAMBIAR USUARIO · F2: lo que A escribe mientras se espera también se envía como A, o se avisa", async () => {
  const { app, requests, pending, confirms } = harness({ confirm: false });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  const done = app.clickSwitch();
  await wait(50);
  app.typeScore(ROUND, "m2", 1, 0);                    // escribe durante la espera
  await wait(400);
  pending.shift().resolve(ok({ a: 2, b: 1 }));
  await wait(400);
  assert.equal(requests.length, 2, "el 1–0 también salió");
  assert.equal(pidOf(requests[1]), A.id);
  assert.equal(requests[1].headers["X-Qracks-Auth"], "1111");
  pending.shift().resolve(ok({ a: 1, b: 0 }));
  assert.equal(await done, true);
  assert.equal(confirms.length, 0, "todo quedó guardado: no pregunta");
});

test("CAMBIAR USUARIO · F2: si lo escrito durante la espera no alcanza a guardarse, se cuenta en el aviso", async () => {
  const { app, pending, confirms } = harness({ confirm: false });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  const done = app.clickSwitch();
  await wait(50);
  app.type(ROUND, "m2", "a", 1);                       // a medias
  pending.shift().resolve(ok({ a: 2, b: 1 }));
  assert.equal(await done, false);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].message, /Tienes 1 pronóstico de liguilla/);
  assert.deepEqual(app.lgDraft(ROUND.id, "m2"), { a: "1", b: "" });
});

test("CAMBIAR USUARIO · F3: el guardado colgado de A no le cuenta a B ni lo hace esperar", async () => {
  const { app, confirms } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });         // se queda colgado para siempre
  await tick();
  assert.equal(await app.clickSwitch(), true);
  assert.equal(confirms.length, 1, "a A sí se le preguntó");
  await app.login(B, "2222", async () => ({}));
  const t0 = Date.now();
  assert.equal(await app.clickSwitch(), true);
  assert.ok(Date.now() - t0 < 1000, "B no espera por lo de A");
  assert.equal(confirms.length, 1, "a B no se le pregunta nada");
});

test("CAMBIAR USUARIO · F4: el aviso cuenta partidos, no envíos; un borrador vacío no cuenta", async () => {
  const { app, pending, confirms } = harness({ confirm: false });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });         // reenvío del mismo partido (al perder el foco)
  app.lgSetDraft(ROUND.id, "m2", { a: "", b: "" });    // escribió y borró
  const done = app.clickSwitch();
  await wait(100);
  pending.shift().resolve({ ok: false, status: 0, json: async () => { throw new Error("sin red"); } });
  await wait(300);
  if (pending.length) pending.shift().resolve({ ok: false, status: 0, json: async () => { throw new Error("sin red"); } });
  assert.equal(await done, false);
  assert.match(confirms[0].message, /Tienes 1 pronóstico de liguilla/);
});

test("CAMBIAR USUARIO · F5: un segundo «Cambiar usuario» durante la espera no abre otro diálogo", async () => {
  const { app, pending, confirms } = harness({ confirm: false });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  const first = app.clickSwitch();
  const second = await app.clickSwitch();
  assert.equal(second, false, "el segundo no cambia");
  pending.shift().resolve({ ok: false, status: 0, json: async () => { throw new Error("sin red"); } });
  await first;
  assert.equal(confirms.length, 1);
});

test("CAMBIAR USUARIO · F2: mientras espera, avisa que está guardando", async () => {
  const { app, pending, toasts } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  const done = app.clickSwitch();
  await tick();
  assert.ok(toasts.some((t) => /Guardando tus pronósticos antes de cambiar de usuario/.test(t)));
  pending.shift().resolve(ok({ a: 2, b: 1 }));
  assert.equal(await done, true);
});

// ---- Technical QA de 602a38a ------------------------------------------------

test("TARDÍA · G1: con A dentro, la respuesta vieja de otra sesión no pisa lo que A guardó después (mismo dispositivo)", async () => {
  const { app, pending, server } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m2", { a: 6, b: 6 });          // el servidor lo acepta; la respuesta se retiene
  await tick();
  assert.equal(await app.clickSwitch(), true);
  server[A.id] = { r_lg: { m2: "D", __score: { m2: { a: 6, b: 6 } } } };
  await app.login(A, "1111", async () => JSON.parse(JSON.stringify(server[A.id])));
  app.lgEnqueue(ROUND, "m2", { a: 3, b: 3 });          // guarda 3–3 en la sesión nueva
  await tick();
  server[A.id] = { r_lg: { m2: "D", __score: { m2: { a: 3, b: 3 } } } };
  pending.pop().resolve(ok({ a: 3, b: 3 }));
  for (let i = 0; i < 5; i++) await tick();
  app.lgSetSt(ROUND.id, "m2", null);                   // toca el campo y lo deja igual: se limpia el estado
  pending.shift().resolve(ok({ a: 6, b: 6 }));        // llega la vieja
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(app.picks().r_lg.__score.m2, { a: 3, b: 3 }, "manda lo que el servidor tiene");
});

test("TARDÍA · G1: otro dispositivo cambió a 0–1 y A ya volvió a entrar; la respuesta vieja no lo pisa", async () => {
  const { app, pending, server } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m2", { a: 6, b: 6 });
  await tick();
  assert.equal(await app.clickSwitch(), true);
  server[A.id] = { r_lg: { m2: "B", __score: { m2: { a: 0, b: 1 } } } };   // desde otro dispositivo
  await app.login(A, "1111", async () => JSON.parse(JSON.stringify(server[A.id])));
  assert.deepEqual(app.picks().r_lg.__score.m2, { a: 0, b: 1 });
  pending.shift().resolve(ok({ a: 6, b: 6 }));
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(app.picks().r_lg.__score.m2, { a: 0, b: 1 });
  assert.equal(app.picks().r_lg.m2, "B");
});

test("TARDÍA · G1: si la relectura termina antes que la carga de la entrada, la carga vieja no la pisa", async () => {
  const { app, pending, server } = harness();
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  app.switchUser();
  let release;
  const loading = app.login(A, "1111", () => new Promise((r) => { release = r; }));
  server[A.id] = { r_lg: { m1: "A", __score: { m1: { a: 2, b: 1 } } } };
  pending.shift().resolve(ok({ a: 2, b: 1 }));        // relectura inmediata con el 2–1
  for (let i = 0; i < 10; i++) await tick();
  release({});                                         // la carga de la entrada (más vieja) termina después
  await loading;
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 2, b: 1 });
});

test("TARDÍA · G1: la respuesta tardía no usa su propio valor como verdad (sólo dispara una relectura)", () => {
  const at = html.indexOf("async function lgSend({ round, matchId, value, force, owner })");
  const send = html.slice(at, html.indexOf("function lgDraftEquals(", at));
  const late = send.slice(send.indexOf("if(!lgSameOwner(owner)){", send.indexOf("lgPost(")), send.indexOf("return;\n    }", send.indexOf("lgPost(")));
  assert.ok(late.includes("lgRefreshAfterLate(owner)"), "relee del servidor");
  assert.ok(!/lgSetAccepted|r\.value/.test(late), "no aplica el valor de la respuesta");
});

test("CAMBIAR USUARIO · el aviso de espera dura lo que la espera y se repite si se vuelve a tocar", async () => {
  const { app, pending, toasts } = harness({ confirm: false });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m1", { a: 2, b: 1 });
  await tick();
  const first = app.clickSwitch();
  await tick();
  assert.equal(await app.clickSwitch(), false);
  assert.equal(toasts.filter((t) => /Guardando tus pronósticos/.test(t)).length, 2, "el segundo toque también lo dice");
  pending.shift().resolve(ok({ a: 2, b: 1 }));
  assert.equal(await first, true);
  const fn = sliceFn(html, "async function lgBeforeSwitch()");
  assert.ok(/toast\(WAIT, 6500\)/.test(fn), "dura más que la espera de 6 s");
});

// ---- Technical QA de b14c58c ------------------------------------------------

test("RELECTURA · H1: si la relectura falla, no se borra nada de la pantalla", async () => {
  const { app, pending, server, env } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m2", { a: 6, b: 6 });
  await tick();
  assert.equal(await app.clickSwitch(), true);
  server[A.id] = { r_lg: { m1: "A", m2: "D", __score: { m1: { a: 2, b: 1 }, m2: { a: 6, b: 6 } } } };
  await app.login(A, "1111", async () => JSON.parse(JSON.stringify(server[A.id])));
  env.failReads = true;                                // el servidor responde 500 a la relectura
  pending.shift().resolve(ok({ a: 6, b: 6 }));
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(app.picks().r_lg.__score, { m1: { a: 2, b: 1 }, m2: { a: 6, b: 6 } }, "siguen los dos guardados");
});

test("RELECTURA · H1: si la relectura falla durante la entrada, no pisa la carga buena", async () => {
  const { app, pending, server, env } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m2", { a: 6, b: 6 });
  await tick();
  assert.equal(await app.clickSwitch(), true);
  server[A.id] = { r_lg: { m1: "A", m2: "D", __score: { m1: { a: 2, b: 1 }, m2: { a: 6, b: 6 } } } };
  let release;
  const loading = app.login(A, "1111", () => new Promise((r) => { release = r; }));
  env.failReads = true;
  pending.shift().resolve(ok({ a: 6, b: 6 }));
  for (let i = 0; i < 10; i++) await tick();
  release(JSON.parse(JSON.stringify(server[A.id])));
  await loading;
  assert.deepEqual(app.picks().r_lg.__score, { m1: { a: 2, b: 1 }, m2: { a: 6, b: 6 } });
});

test("RELECTURA · H2: una relectura lenta que termina después de salir y volver a entrar no pisa lo más nuevo", async () => {
  const { app, pending, server, env } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m2", { a: 6, b: 6 });
  await tick();
  assert.equal(await app.clickSwitch(), true);          // sesión 1 → 2
  server[A.id] = { r_lg: { m2: "D", __score: { m2: { a: 6, b: 6 } } } };
  await app.login(A, "1111", async () => JSON.parse(JSON.stringify(server[A.id])));
  env.holdReads = true;
  pending.shift().resolve(ok({ a: 6, b: 6 }));          // lanza la relectura; el servidor la atiende con 6–6
  for (let i = 0; i < 5; i++) await tick();
  const stale = env.reads.shift();
  const staleValue = JSON.parse(JSON.stringify(server[A.id]));
  env.holdReads = false;
  app.lgEnqueue(ROUND, "m2", { a: 3, b: 3 });           // guarda 3–3
  await tick();
  server[A.id] = { r_lg: { m2: "D", __score: { m2: { a: 3, b: 3 } } } };
  pending.shift().resolve(ok({ a: 3, b: 3 }));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(await app.clickSwitch(), true);          // sesión 2 → 3
  await app.login(A, "1111", async () => JSON.parse(JSON.stringify(server[A.id])));
  assert.deepEqual(app.picks().r_lg.__score.m2, { a: 3, b: 3 });
  stale.okWith(staleValue);                              // llega la relectura vieja
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(app.picks().r_lg.__score.m2, { a: 3, b: 3 }, "no vuelve el 6–6");
});

test("RELECTURA · H2: en la misma sesión, una relectura que salió antes de un guardado no lo pisa aunque se toque el campo", async () => {
  const { app, pending, server, env } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m2", { a: 6, b: 6 });
  await tick();
  assert.equal(await app.clickSwitch(), true);
  server[A.id] = { r_lg: { m2: "D", __score: { m2: { a: 6, b: 6 } } } };
  await app.login(A, "1111", async () => JSON.parse(JSON.stringify(server[A.id])));
  env.holdReads = true;
  pending.shift().resolve(ok({ a: 6, b: 6 }));
  for (let i = 0; i < 5; i++) await tick();
  const stale = env.reads.shift();
  const staleValue = JSON.parse(JSON.stringify(server[A.id]));
  env.holdReads = false;
  app.lgEnqueue(ROUND, "m2", { a: 3, b: 3 });
  await tick();
  pending.shift().resolve(ok({ a: 3, b: 3 }));
  for (let i = 0; i < 5; i++) await tick();
  app.lgSetSt(ROUND.id, "m2", null);                     // toca el campo: se limpia el estado
  stale.okWith(staleValue);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(app.picks().r_lg.__score.m2, { a: 3, b: 3 });
});

test("RELECTURA · H3: la relectura no redibuja la jornada (no mueve el scroll ni quita el foco)", () => {
  const fn = html.slice(html.indexOf("async function lgRefreshAfterLate(owner)"), html.indexOf("function lgOwnerNow()"));
  assert.ok(!/renderJornada\(/.test(fn), "sólo pinta los partidos que cambiaron");
  assert.ok(/lgPaintChanged\(changed\)/.test(fn));
  const paint = sliceFn(html, "function lgPaintChanged(changed)");
  assert.ok(!/renderJornada\(/.test(paint));
});

// ---- Technical QA de 9639ad1 ------------------------------------------------

test("RELECTURA · J1: si un campo del partido está enfocado, también se actualiza (no queda un marcador mezclado)", async () => {
  const { app, pending, server, env } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m2", { a: 6, b: 6 });
  await tick();
  assert.equal(await app.clickSwitch(), true);
  server[A.id] = { r_lg: { m1: "A", m2: "D", __score: { m1: { a: 2, b: 1 }, m2: { a: 6, b: 6 } } } };
  await app.login(A, "1111", async () => JSON.parse(JSON.stringify(server[A.id])));
  const input = (v) => ({ value: v, sel: null, selected: false, setSelectionRange(a, b){ this.sel = [a, b]; }, select(){ this.selected = true; } });
  const a1 = input("2"), b1 = input("1");
  env.document.els["qz-lg-a-r_lg-m1"] = a1;
  env.document.els["qz-lg-b-r_lg-m1"] = b1;
  env.document.activeElement = a1;                       // Ana tocó el campo de goles local de m1
  server[A.id].r_lg.m1 = "B"; server[A.id].r_lg.__score.m1 = { a: 0, b: 3 };   // otro dispositivo: 0–3
  pending.shift().resolve(ok({ a: 6, b: 6 }));
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(app.picks().r_lg.__score.m1, { a: 0, b: 3 });
  assert.equal(a1.value, "0", "el campo enfocado muestra lo del servidor");
  assert.equal(b1.value, "3");
  assert.equal(a1.selected, true, "el valor nuevo queda seleccionado");
});

// ---- Technical QA de 3bea6f9 ------------------------------------------------

test("RELECTURA · K1: si el campo enfocado tenía todo seleccionado, el valor nuevo queda seleccionado (lo que se teclee lo reemplaza)", async () => {
  const { app, pending, server, env } = harness({ confirm: true });
  app.setRounds([ROUND]);
  app.as(A, "1111");
  app.lgEnqueue(ROUND, "m2", { a: 6, b: 6 });
  await tick();
  assert.equal(await app.clickSwitch(), true);
  server[A.id] = { r_lg: { m1: "A", m2: "D", __score: { m1: { a: 2, b: 1 }, m2: { a: 6, b: 6 } } } };
  await app.login(A, "1111", async () => JSON.parse(JSON.stringify(server[A.id])));
  const input = (v, s0, s1) => ({ value: v, selectionStart: s0, selectionEnd: s1, selected: false, sel: null,
    select(){ this.selected = true; this.selectionStart = 0; this.selectionEnd = this.value.length; },
    setSelectionRange(a, b){ this.sel = [a, b]; this.selectionStart = a; this.selectionEnd = b; } });
  const a1 = input("2", 0, 1), b1 = input("1", 1, 1);   // Shift+Tab: todo seleccionado
  env.document.els["qz-lg-a-r_lg-m1"] = a1;
  env.document.els["qz-lg-b-r_lg-m1"] = b1;
  env.document.activeElement = a1;
  server[A.id].r_lg.m1 = "B"; server[A.id].r_lg.__score.m1 = { a: 1, b: 3 };
  pending.shift().resolve(ok({ a: 6, b: 6 }));
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(a1.value, "1");
  assert.equal(a1.selected, true, "sigue todo seleccionado");
  assert.deepEqual([a1.selectionStart, a1.selectionEnd], [0, 1]);
  assert.equal(b1.value, "3");
});

// ---- Technical QA de fc67921 ------------------------------------------------

for (const [name, start] of [["K2: campo vacío", { value: "", s: 0, e: 0 }], ["K3: cursor al inicio del valor anterior", { value: "2", s: 0, e: 0 }], ["K3: cursor al final del valor anterior", { value: "2", s: 1, e: 1 }]]) {
  test("RELECTURA · " + name + ": el valor nuevo queda seleccionado (lo que se teclee lo reemplaza)", async () => {
    const { app, pending, server, env } = harness({ confirm: true });
    app.setRounds([ROUND]);
    app.as(A, "1111");
    app.lgEnqueue(ROUND, "m2", { a: 6, b: 6 });
    await tick();
    assert.equal(await app.clickSwitch(), true);
    server[A.id] = start.value
      ? { r_lg: { m1: "A", m2: "D", __score: { m1: { a: 2, b: 1 }, m2: { a: 6, b: 6 } } } }
      : { r_lg: { m2: "D", __score: { m2: { a: 6, b: 6 } } } };
    await app.login(A, "1111", async () => JSON.parse(JSON.stringify(server[A.id])));
    const a1 = { value: start.value, selectionStart: start.s, selectionEnd: start.e, selected: false,
      select(){ this.selected = true; this.selectionStart = 0; this.selectionEnd = this.value.length; },
      setSelectionRange(a, b){ this.selectionStart = a; this.selectionEnd = b; } };
    env.document.els["qz-lg-a-r_lg-m1"] = a1;
    env.document.activeElement = a1;
    server[A.id].r_lg.m1 = "B"; server[A.id].r_lg.__score = server[A.id].r_lg.__score || {}; server[A.id].r_lg.__score.m1 = { a: 1, b: 3 };
    pending.shift().resolve(ok({ a: 6, b: 6 }));
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(a1.value, "1");
    assert.equal(a1.selected, true);
    assert.deepEqual([a1.selectionStart, a1.selectionEnd], [0, 1]);
  });
}


// ---- FIA-GPT-02: la cola de pronósticos normales es de cada sesión ----------
// Con las funciones reales de cola (setPicksWithError) y de cambio de sesión
// (lgResetSession): una petición de A que nunca responde no detiene los
// guardados de B; los trabajos de A que no salieron no salen nunca; y una
// respuesta tardía de A no toca base, pantalla ni contadores de B.
function deferredKv() {
  const calls = [];
  const kvSet = (key, value, creds, extra) => new Promise((resolve) => { calls.push({ key, value, creds, base: extra && extra.base, resolve }); });
  return { calls, kvSet };
}
const R1 = { id: "r1", number: 1, published: true, deadline: "2099-01-01T00:00:00Z", matches: [{ id: "m1" }, { id: "m2" }] };

test("FIA-GPT-02 · A→B: una petición de A sin respuesta no detiene el guardado de B", async () => {
  const kv = deferredKv();
  const { app } = harness({ kvSet: kv.kvSet });
  app.setRounds([R1]);
  app.as(A, "1111", {});
  const aSave = app.setPicksWithError(A.id, { r1: { m1: "A" } });
  await tick();
  assert.equal(kv.calls.length, 1, "sale la de A");
  app.switchUser();
  await app.login(B, "2222", async () => ({}));
  const bSave = app.setPicksWithError(B.id, { r1: { m1: "B" } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(kv.calls.length, 2, "la de B sale aunque A siga colgada");
  assert.ok(kv.calls[1].key.endsWith(":picks:" + B.id) && kv.calls[1].creds.owner === "2222");
  kv.calls[1].resolve({ ok: true, value: { r1: { m1: "B" } } });
  assert.equal((await bSave).ok, true);
  // La respuesta tardía de A llega con B dentro: no toca nada de B.
  kv.calls[0].resolve({ ok: true, value: { r1: { m1: "A" } } });
  const late = await aSave;
  assert.equal(late.ok, false);
  assert.equal(late.error, "session_changed");
  assert.deepEqual(app.base(), { r1: { m1: "B" } }, "la base sigue siendo la de B");
  assert.equal(app.pending(), 0, "los contadores de B no cuentan lo de A");
});

test("FIA-GPT-02 · A→B→A: lo que A dejó en cola no sale después; la A nueva guarda en seguida", async () => {
  const kv = deferredKv();
  const { app } = harness({ kvSet: kv.kvSet });
  app.setRounds([R1]);
  app.as(A, "1111", {});
  const first = app.setPicksWithError(A.id, { r1: { m1: "A" } });     // en camino, nunca responde
  const queued = app.setPicksWithError(A.id, { r1: { m1: "D" } });    // en cola detrás
  await tick();
  assert.equal(kv.calls.length, 1);
  app.switchUser();
  await app.login(B, "2222", async () => ({}));
  app.switchUser();
  await app.login(A, "1111", async () => ({ r1: { m1: "A" } }));
  const fresh = app.setPicksWithError(A.id, { r1: { m1: "B" } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(kv.calls.length, 2, "la A nueva sale; la vieja en cola no");
  assert.deepEqual(kv.calls[1].value, { r1: { m1: "B" } });
  assert.deepEqual(kv.calls[1].base, { r1: { m1: "A" } }, "con la base que leyó esta entrada");
  kv.calls[1].resolve({ ok: true, value: { r1: { m1: "B" } } });
  assert.equal((await fresh).ok, true);
  kv.calls[0].resolve({ ok: true, value: { r1: { m1: "A" } } });
  assert.equal((await first).error, "session_changed");
  const q = await queued;
  assert.deepEqual([q.ok, q.error], [false, "session_changed"], "el trabajo viejo en cola no se envía");
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(kv.calls.length, 2, "nunca salió");
  assert.deepEqual(app.base(), { r1: { m1: "B" } });
});
