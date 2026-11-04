// UX-INFRA-001 · Lógica de espera de la pantalla de carga.
//
// Se ejecuta en el NAVEGADOR (page.mjs la incrusta con Function#toString) y en
// Node para las pruebas. Por eso las dos funciones son autocontenidas: no usan
// nada de fuera salvo lo que reciben en `o`.
//
// Reglas (propuesta v3 + revisión de GPT):
// - Una sola consulta a la vez, sin caché, con tiempo máximo por intento.
// - Termina al abrir la página, al abandonar la pestaña (pagehide), al ocultarse
//   (se pausa y sólo sigue si vuelve dentro del plazo) o al agotar el plazo total.
//   El plazo es de reloj de pared desde que se mostró la pantalla: ocultar y
//   volver no lo reinicia, así que la pantalla no mantiene despierto Render
//   indefinidamente. Sólo «Reintentar» abre un plazo nuevo, por acción del usuario.
// - «Listo» es el contrato actual de /api/health: 200, JSON, ok === true y una
//   fecha válida en `time`. Un 200 cualquiera no basta.

export function isHealthyPayload(status, contentType, body) {
  if (status !== 200) return false;
  if (!/^application\/json\b/i.test(String(contentType || ""))) return false;
  if (!body || typeof body !== "object" || body.ok !== true) return false;
  if (typeof body.time !== "string" || !body.time) return false;
  return Number.isFinite(Date.parse(body.time));
}

export const WAKE_DEFAULTS = Object.freeze({
  healthUrl: "/api/health",
  schedule: [2, 2, 3, 3, 5, 5], // segundos antes de cada intento
  after: 8,                     // después, cada 8 s
  budgetS: 120,                 // plazo total
  attemptTimeoutS: 8,           // tiempo máximo de cada consulta
  slowAfterS: 45,
});

export function createWaker(o) {
  let start = o.now(), attempt = 0, timer = null, inflight = null, attemptTimer = null;
  let finished = false;
  const elapsed = () => (o.now() - start) / 1000;
  const gap = (i) => (i < o.schedule.length ? o.schedule[i] : o.after);
  const emit = (state, extra) => o.onState(Object.assign({ state, elapsed: elapsed(), attempts: attempt }, extra || {}));

  function clearAll() {
    if (timer) { o.clearTimeout(timer); timer = null; }
    if (attemptTimer) { o.clearTimeout(attemptTimer); attemptTimer = null; }
    if (inflight) { const c = inflight; inflight = null; c.abort(); }
  }
  function finish(state) { finished = true; clearAll(); emit(state); }

  function plan() {
    if (finished) return;
    if (o.isHidden()) { clearAll(); emit("paused"); return; }
    if (!o.isOnline()) { clearAll(); emit("offline"); return; }
    const remaining = o.budgetS - elapsed();
    if (remaining <= 0) { finish("error"); return; }
    const wait = Math.min(gap(attempt), remaining);
    const nextAt = o.now() + wait * 1000;
    emit(elapsed() >= o.slowAfterS ? "slow" : "waiting", { nextAt });
    timer = o.setTimeout(run, wait * 1000);
  }

  async function run() {
    timer = null;
    if (finished) return;
    if (elapsed() >= o.budgetS) { finish("error"); return; }
    attempt++;
    const ctl = new o.AbortController();
    inflight = ctl;
    attemptTimer = o.setTimeout(() => ctl.abort(), o.attemptTimeoutS * 1000);
    let ok = false;
    try {
      const res = await o.fetch(o.healthUrl, {
        method: "GET", cache: "no-store", credentials: "omit", redirect: "error",
        headers: { Accept: "application/json" }, signal: ctl.signal,
      });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      ok = o.isHealthyPayload(res.status, res.headers.get("content-type"), body);
    } catch (e) {
      ok = false;
    } finally {
      if (attemptTimer) { o.clearTimeout(attemptTimer); attemptTimer = null; }
      if (inflight === ctl) inflight = null;
    }
    if (finished) return;
    if (ok) { finished = true; clearAll(); emit("ready"); o.onReady(); return; }
    plan();
  }

  return {
    start() { start = o.now(); attempt = 0; finished = false; plan(); },
    // «Reintentar»: sólo por acción del usuario abre un plazo nuevo.
    retry() { clearAll(); start = o.now(); attempt = 0; finished = false; plan(); },
    onVisibilityChange() {
      if (finished) return;
      if (o.isHidden()) { clearAll(); emit("paused"); }
      else if (!timer && !inflight) plan();
    },
    onOnline() { if (!finished && !timer && !inflight) plan(); },
    onOffline() { if (!finished) { clearAll(); emit("offline"); } },
    stop() { finished = true; clearAll(); }, // pagehide
    get attempts() { return attempt; },
    get finished() { return finished; },
  };
}
