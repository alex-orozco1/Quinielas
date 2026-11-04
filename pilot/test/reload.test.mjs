// Riesgo 3 de la revisión de GPT (LOCAL, reloj simulado): /api/health responde bien
// pero la navegación sigue lenta o falla, así que el Worker vuelve a servir la
// pantalla tras cada recarga. Las recargas automáticas no deben reiniciar el plazo.
import test from "node:test";
import assert from "node:assert/strict";
import { createWaker, createReloadGuard, isHealthyPayload, WAKE_DEFAULTS, RELOAD_DEFAULTS } from "../edge/waker.mjs";

function memoryStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; }
const brokenStorage = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); }, removeItem() { throw new Error("SecurityError"); } };

// Simula N cargas de la pantalla en la misma pestaña. Cada carga crea su guard y su
// waker como lo hace page.mjs. /api/health responde «listo» tras `healthMs`; cada
// recarga cuesta `navMs` hasta que el Worker vuelve a servir la pantalla.
async function loop({ storage, healthMs = 300, navMs = 3_500, maxLoads = 50 }) {
  let now = 0; const healthCalls = []; const loads = [];
  for (let i = 0; i < maxLoads; i++) {
    const guard = createReloadGuard(Object.assign({ isReload: i > 0, storage, key: RELOAD_DEFAULTS.keyPrefix + "/q/demo", now: () => now }, RELOAD_DEFAULTS));
    const cycle = guard.begin();
    loads.push({ at: now, startedAt: cycle.startedAt });
    let outcome = null; const timers = [];
    const w = createWaker(Object.assign({}, WAKE_DEFAULTS, {
      fetch: (url, init) => { healthCalls.push(now); return new Promise((res) => timers.push({ at: now + healthMs, fn: () => res({ status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true, time: new Date(now).toISOString() }) }) })); },
      setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
      clearTimeout: (t) => { const k = timers.indexOf(t); if (k >= 0) timers.splice(k, 1); },
      now: () => now, AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
      isHidden: () => false, isOnline: () => true, isHealthyPayload,
      onState: (s) => { if (s.state === "error") outcome = "error"; },
      onReady: () => { outcome = guard.tryReload(cycle.startedAt) ? "reload" : "stuck"; },
    }));
    w.start(cycle.startedAt);
    while (!outcome && timers.length) {
      timers.sort((a, b) => a.at - b.at); const t = timers.shift(); now = t.at; t.fn();
      for (let k = 0; k < 30; k++) await Promise.resolve();
    }
    loads[loads.length - 1].outcome = outcome;
    if (outcome !== "reload") break;
    now += navMs;                     // la navegación vuelve a tardar y el Worker sirve la pantalla
  }
  return { loads, healthCalls, now };
}

test("riesgo 3: con /api/health bien y la navegación lenta, hay como mucho 3 recargas y después se detiene", async () => {
  const r = await loop({ storage: memoryStorage() });
  assert.equal(r.loads.length, RELOAD_DEFAULTS.maxReloads + 1, "1 carga + 3 recargas automáticas");
  assert.deepEqual(r.loads.map((l) => l.outcome), ["reload", "reload", "reload", "stuck"]);
  assert.ok(r.loads.every((l) => l.startedAt === 0), "todas las cargas continúan el mismo plazo");
  assert.ok(r.healthCalls.every((t) => t <= WAKE_DEFAULTS.budgetS * 1000), "ninguna consulta fuera de los 120 s");
});

for (const navMs of [50_000, 70_000]) {
  test(`riesgo 3: si cada recarga tarda ${navMs / 1000} s, el plazo compartido de 120 s se agota y termina en error`, async () => {
    const r = await loop({ storage: memoryStorage(), healthMs: 300, navMs });
    assert.ok(r.loads.length <= 4, `cargas: ${r.loads.length}`);
    assert.ok(r.loads.every((l) => l.startedAt === 0), "una recarga lenta no cuenta como visita nueva");
    assert.equal(r.loads[r.loads.length - 1].outcome, "error", "termina en error, sin otra recarga");
    assert.ok(r.healthCalls.every((t) => t <= 120_000));
  });
}

test("riesgo 3: sin sessionStorage no hay recarga automática (sólo el botón)", async () => {
  const r = await loop({ storage: brokenStorage });
  assert.deepEqual(r.loads.map((l) => l.outcome), ["stuck"]);
  const r2 = await loop({ storage: null });
  assert.deepEqual(r2.loads.map((l) => l.outcome), ["stuck"]);
});

test("guard: un registro viejo (otra visita) o corrupto no recorta el plazo; reset() repone el cupo", () => {
  const st = memoryStorage(); let now = 0;
  const mk = (isReload) => createReloadGuard(Object.assign({ isReload, storage: st, key: "k", now: () => now }, RELOAD_DEFAULTS));
  const g = mk(true);
  assert.deepEqual(mk(false).begin(), { startedAt: 0, reloads: 0 });
  assert.equal(g.tryReload(0), true); now = 5_000;
  assert.deepEqual(g.begin(), { startedAt: 0, reloads: 1 }, "recarga reciente: mismo plazo");
  st.setItem("k", JSON.stringify({ first: 0, last: 0, n: 1 }));
  assert.deepEqual(mk(false).begin(), { startedAt: 5_000, reloads: 0 }, "una navegación nueva no hereda el plazo");
  st.setItem("k", JSON.stringify({ first: 0, last: 0, n: 1 })); now = 601_000;
  assert.deepEqual(g.begin(), { startedAt: 601_000, reloads: 0 }, "más de 10 min después: visita nueva");
  st.setItem("k", "{no es json"); assert.equal(g.begin().reloads, 0);
  st.setItem("k", JSON.stringify({ first: now, last: now, n: 3 })); assert.equal(g.tryReload(now), false, "sin cupo");
  g.reset(); assert.equal(g.tryReload(now), true, "tras la acción de la persona, cupo nuevo");
});
