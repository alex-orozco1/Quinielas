// Pruebas LOCALES del ciclo de espera con reloj simulado (no son H-WAKE).
import test from "node:test";
import assert from "node:assert/strict";
import { createWaker, isHealthyPayload, WAKE_DEFAULTS } from "../edge/waker.mjs";

// Reloj y red simulados. `health(n, now)` describe la respuesta de la n-ésima consulta:
// { status, json, type, delay } o { hang: true }. `abortDelayMs` retrasa la
// continuación del aborto (la promesa rechaza más tarde), como puede pasar en un
// navegador real; así se reproducen las continuaciones antiguas.
function rig({ health = () => ({ status: 503, json: { ok: false } }), slowMs = 0, abortDelayMs = 0 } = {}) {
  let now = 0, seq = 0; const timers = new Map(); const calls = []; const states = [];
  let active = 0, maxActive = 0;           // consultas vivas (ni respondidas ni abortadas)
  let hidden = false, online = true, ready = 0, readyAt = null;
  class AC { constructor(){ this.signal = { aborted: false, listeners: [] }; } abort(){ if (this.signal.aborted) return; this.signal.aborted = true; this.signal.listeners.forEach((f) => f()); } }
  const fakeFetch = (url, init) => new Promise((resolve, reject) => {
    const call = { url, init, at: now, settledAt: null }; calls.push(call);
    let live = true; active++; maxActive = Math.max(maxActive, active);
    const end = () => { if (live) { live = false; active--; call.settledAt = now; } };
    init.signal.listeners.push(() => { end(); const rj = () => reject(new Error("aborted")); abortDelayMs ? setT(rj, abortDelayMs) : rj(); });
    const r = health(calls.length, now);
    if (r.hang) return; // nunca responde: sólo el tiempo máximo (o el plazo) lo corta
    setT(() => { if (init.signal.aborted) return; end(); resolve({ status: r.status, headers: { get: () => r.type || "application/json" }, json: async () => r.json }); }, r.delay ?? slowMs);
  });
  function setT(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; }
  function clearT(id) { timers.delete(id); }
  async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
      await flush();
    }
    now = end; await flush();
  }
  const w = createWaker(Object.assign({}, WAKE_DEFAULTS, {
    fetch: fakeFetch, setTimeout: setT, clearTimeout: clearT, now: () => now, AbortController: AC,
    isHidden: () => hidden, isOnline: () => online, isHealthyPayload,
    onState: (s) => states.push(s), onReady: () => { ready++; readyAt = now; },
  }));
  return { w, calls, states, advance, flush, get now() { return now; }, get ready() { return ready; }, get readyAt() { return readyAt; },
    get maxInflight() { return maxActive; }, get active() { return active; },
    setHidden(v) { hidden = v; w.onVisibilityChange(); }, setOnline(v) { online = v; v ? w.onOnline() : w.onOffline(); },
    pendingTimers: () => timers.size };
}

test("programa: intentos a los 2, 4, 7, 10, 15, 20 s y luego cada 8 s; GET sin caché y sin credenciales", async () => {
  const r = rig(); r.w.start();
  await r.advance(36_100);
  assert.deepEqual(r.calls.map((c) => c.at / 1000), [2, 4, 7, 10, 15, 20, 28, 36]);
  for (const c of r.calls) { assert.equal(c.init.method, "GET"); assert.equal(c.init.cache, "no-store"); assert.equal(c.init.credentials, "omit"); assert.equal(c.url, "/api/health"); }
  assert.equal(r.maxInflight, 1, "nunca dos consultas a la vez");
});

test("el contador del próximo intento es real (nextAt del programa)", async () => {
  const r = rig(); r.w.start();
  assert.equal(r.states[0].nextAt, 2000);
  await r.advance(4_500);
  const last = r.states[r.states.length - 1];
  assert.equal(last.nextAt, 7000, "a los 4,5 s el siguiente es a los 7 s");
});

test("termina al abrir: con la respuesta válida llama onReady una vez y no consulta más", async () => {
  const t = new Date().toISOString();
  const r = rig({ health: (n) => (n < 3 ? { status: 503, json: {} } : { status: 200, json: { ok: true, time: t } }) });
  r.w.start(); await r.advance(60_000);
  assert.equal(r.ready, 1); assert.equal(r.calls.length, 3); assert.equal(r.pendingTimers(), 0);
});

test("un 200 que no es la salud de QRACKS no abre la página", async () => {
  const r = rig({ health: () => ({ status: 200, type: "text/html", json: null }) });
  r.w.start(); await r.advance(30_000);
  assert.equal(r.ready, 0); assert.ok(r.calls.length > 3);
});

test("tiempo máximo: una consulta colgada se corta a los 8 s y se sigue con la siguiente", async () => {
  const r = rig({ health: (n) => (n === 1 ? { hang: true } : { status: 503, json: {} }) });
  r.w.start(); await r.advance(12_100);
  assert.equal(r.calls.length, 2, "la 1.ª (2 s) se cortó a los 10 s; la 2.ª fue a los 12 s");
  assert.equal(r.calls[1].at, 12_000);
  assert.equal(r.maxInflight, 1);
});

test("termina al agotar el plazo: a los 120 s pasa a error y deja de consultar", async () => {
  const r = rig(); r.w.start(); await r.advance(400_000);
  assert.equal(r.states[r.states.length - 1].state, "error");
  assert.ok(r.calls.every((c) => c.at <= 120_000));
  assert.ok(r.calls.length <= 20, `consultas: ${r.calls.length}`);
  assert.equal(r.pendingTimers(), 0, "sin temporizadores vivos");
});

test("pestaña oculta: no consulta; si vuelve dentro del plazo sigue; el plazo no se reinicia", async () => {
  const r = rig(); r.w.start(); await r.advance(3_000);
  r.setHidden(true); const n = r.calls.length;
  await r.advance(200_000);
  assert.equal(r.calls.length, n, "nada mientras está oculta");
  r.setHidden(false); await r.advance(1_000);
  assert.equal(r.states[r.states.length - 1].state, "error", "al volver fuera de plazo, termina");
  assert.equal(r.calls.length, n);
});

test("salir de la página (pagehide) corta todo, incluida la consulta en curso", async () => {
  const r = rig({ health: () => ({ hang: true }) }); r.w.start(); await r.advance(2_100);
  assert.equal(r.calls.length, 1);
  r.w.stop(); await r.advance(300_000);
  assert.equal(r.calls.length, 1); assert.equal(r.pendingTimers(), 0);
});

test("sin red: pausa y sigue al volver la conexión", async () => {
  const r = rig(); r.w.start(); r.setOnline(false);
  await r.advance(10_000); assert.equal(r.calls.length, 0);
  assert.equal(r.states[r.states.length - 1].state, "offline");
  r.setOnline(true); await r.advance(2_100); assert.equal(r.calls.length, 1);
});

test("«Reintentar» abre un plazo nuevo sólo por acción del usuario", async () => {
  const r = rig(); r.w.start(); await r.advance(130_000);
  const n = r.calls.length; r.w.retry(); await r.advance(2_100);
  assert.equal(r.calls.length, n + 1);
});

// ── Regresiones de la revisión de GPT sobre 84ddb70 ─────────────────────────────

const OK = () => ({ status: 200, json: { ok: true, time: new Date().toISOString() } });

test("regresión 1a: «Reintentar» con una consulta en curso no deja dos consultas ni un ciclo duplicado", async () => {
  const r = rig({ health: () => ({ hang: true }) });
  r.w.start(); await r.advance(2_100);                 // 1.ª consulta (2 s) colgada
  assert.equal(r.calls.length, 1);
  r.w.retry();                                          // aborta la 1.ª; su continuación llega después
  await r.advance(2_100);                               // 2.ª consulta del ciclo nuevo (4,1 s)
  assert.equal(r.calls.length, 2, "sin un segundo programa heredado del ciclo anterior");
  await r.advance(30_000);
  assert.equal(r.maxInflight, 1, "nunca dos consultas vivas a la vez");
  const times = r.calls.map((c) => c.at);
  // ciclo nuevo desde 2,1 s: 4,1 → (corte 8 s) 12,1 → +2 = 14,1 → (corte) 22,1 → +3 = 25,1
  assert.deepEqual(times, [2_000, 4_100, 14_100, 25_100]);
});

test("regresión 1b: la continuación tardía del aborto no limpia el tiempo máximo del intento nuevo ni reprograma", async () => {
  const r = rig({ health: () => ({ hang: true }), abortDelayMs: 3_000 });
  r.w.start(); await r.advance(2_100);                 // 1.ª consulta colgada
  r.w.retry();                                          // su rechazo llega a los 5,1 s
  await r.advance(2_100);                               // 2.ª consulta a los 4,1 s, ANTES de esa continuación
  assert.equal(r.calls.length, 2);
  await r.advance(1_500);                               // 5,6 s: ya llegó la continuación antigua
  assert.equal(r.active, 1, "la 2.ª sigue viva y sola");
  await r.advance(6_600);                               // 12,2 s: el tiempo máximo de la 2.ª (4,1 + 8) sigue en pie
  assert.equal(r.calls[1].init.signal.aborted, true, "la 2.ª se cortó a los 8 s");
  assert.equal(r.calls[1].settledAt, 12_100);
  await r.advance(5_000);
  assert.equal(r.maxInflight, 1, "nunca dos consultas vivas a la vez");
  // El corte propio de la 2.ª (12,1 s) también rechaza 3 s tarde (15,1 s); +2 s = 17,1 s.
  assert.deepEqual(r.calls.map((c) => c.at), [2_000, 4_100, 17_100], "un solo programa");
});

test("regresión 1c: ocultar y volver con una consulta en curso no duplica el ciclo", async () => {
  const r = rig({ health: () => ({ hang: true }), abortDelayMs: 1_000 });
  r.w.start(); await r.advance(2_100);
  r.setHidden(true); r.setHidden(false);               // aborta y replanifica en el mismo instante
  await r.advance(30_000);
  assert.equal(r.maxInflight, 1);
  // Ocultar no reinicia la cuenta de intentos: 4,1 → corte 12,1 → rechazo 13,1 → +3 = 16,1
  // → corte 24,1 → rechazo 25,1 → +3 = 28,1. Un solo programa.
  assert.deepEqual(r.calls.map((c) => c.at), [2_000, 4_100, 16_100, 28_100]);
});

test("regresión 2: el plazo de 120 s corta la consulta en curso y rechaza una respuesta válida posterior", async () => {
  // Todo responde 503 al instante, salvo las consultas que empiezan a partir de 115 s:
  // ésas responden «listo» a los 7 s (dentro de su tiempo máximo de 8 s, fuera del plazo).
  const r = rig({ health: (n, at) => (at >= 115_000 ? Object.assign(OK(), { delay: 7_000 }) : { status: 503, json: {} }) });
  r.w.start(); await r.advance(400_000);
  const late = r.calls.find((c) => c.at >= 115_000);
  assert.ok(late, "hubo una consulta empezada antes del plazo");
  assert.equal(late.init.signal.aborted, true, "se abortó al vencer el plazo");
  assert.equal(late.settledAt, 120_000, "a los 120 s exactos");
  assert.equal(r.ready, 0, "no se acepta la respuesta de los 122 s");
  assert.equal(r.states[r.states.length - 1].state, "error");
  assert.equal(r.pendingTimers(), 0);
});

test("regresión 2b: una respuesta que llega justo al vencer el plazo tampoco cuenta", async () => {
  const r = rig({ health: (n, at) => (at >= 115_000 ? Object.assign(OK(), { delay: 120_000 - at }) : { status: 503, json: {} }) });
  r.w.start(); await r.advance(400_000);
  assert.equal(r.ready, 0); assert.equal(r.states[r.states.length - 1].state, "error");
});

test("el plazo puede continuar uno anterior (startedAt): no se reinicia al recargar", async () => {
  const r = rig();
  r.w.start(-100_000);                                  // la pantalla se mostró hace 100 s
  await r.advance(60_000);
  assert.ok(r.calls.every((c) => c.at <= 20_000), "sólo quedaban 20 s");
  assert.equal(r.states[r.states.length - 1].state, "error");
});
