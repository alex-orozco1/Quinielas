// Pruebas LOCALES del ciclo de espera con reloj simulado (no son H-WAKE).
import test from "node:test";
import assert from "node:assert/strict";
import { createWaker, isHealthyPayload, WAKE_DEFAULTS } from "../edge/waker.mjs";

function rig({ health = () => ({ status: 503, json: { ok: false } }), slowMs = 0 } = {}) {
  let now = 0, seq = 0; const timers = new Map(); const calls = []; const states = []; let inflightNow = 0, maxInflight = 0;
  let hidden = false, online = true, ready = 0;
  class AC { constructor(){ this.signal = { aborted: false, listeners: [] }; } abort(){ this.signal.aborted = true; this.signal.listeners.forEach((f) => f()); } }
  const fakeFetch = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, at: now }); inflightNow++; maxInflight = Math.max(maxInflight, inflightNow);
    const done = (fn) => { inflightNow--; fn(); };
    init.signal.listeners.push(() => done(() => reject(new Error("aborted"))));
    const r = health(calls.length);
    const respond = () => { if (init.signal.aborted) return; done(() => resolve({ status: r.status, headers: { get: () => r.type || "application/json" }, json: async () => r.json })); };
    if (r.hang) return; // nunca responde: sólo el tiempo máximo lo corta
    setT(respond, slowMs);
  });
  function setT(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; }
  function clearT(id) { timers.delete(id); }
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    now = end; for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  const w = createWaker(Object.assign({}, WAKE_DEFAULTS, {
    fetch: fakeFetch, setTimeout: setT, clearTimeout: clearT, now: () => now, AbortController: AC,
    isHidden: () => hidden, isOnline: () => online, isHealthyPayload,
    onState: (s) => states.push(s), onReady: () => { ready++; },
  }));
  return { w, calls, states, advance, get ready() { return ready; }, get maxInflight() { return maxInflight; },
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
