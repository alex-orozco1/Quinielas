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

// Cada ciclo (start/retry/reanudar) y cada intento llevan un número de generación.
// Cancelar sube la generación: cualquier continuación de un ciclo o intento
// anterior (un aborto que rechaza tarde, un temporizador ya disparado) se descarta
// sin tocar temporizadores ni estado del nuevo. Cada intento guarda SU propio
// temporizador de tiempo máximo y sólo limpia el suyo.
export function createWaker(o) {
  let start = o.now(), attempt = 0, gen = 0, timer = null, cur = null;
  let finished = false;
  const elapsed = () => (o.now() - start) / 1000;
  const deadline = () => start + o.budgetS * 1000;
  const gap = (i) => (i < o.schedule.length ? o.schedule[i] : o.after);
  const emit = (state, extra) => o.onState(Object.assign({ state, elapsed: elapsed(), attempts: attempt }, extra || {}));

  function cancel() {
    gen++;
    if (timer) { o.clearTimeout(timer); timer = null; }
    if (cur) { const c = cur; cur = null; o.clearTimeout(c.timer); c.ctl.abort(); }
  }
  function finish(state) { finished = true; cancel(); emit(state); }

  function plan() {
    if (finished) return;
    if (o.isHidden()) { cancel(); emit("paused"); return; }
    if (!o.isOnline()) { cancel(); emit("offline"); return; }
    const remaining = o.budgetS - elapsed();
    if (remaining <= 0) { finish("error"); return; }
    const wait = Math.min(gap(attempt), remaining);
    const nextAt = o.now() + wait * 1000;
    emit(elapsed() >= o.slowAfterS ? "slow" : "waiting", { nextAt });
    const g = gen;
    timer = o.setTimeout(function () { if (g === gen) { timer = null; run(g); } }, wait * 1000);
  }

  async function run(g) {
    if (finished || g !== gen) return;
    const left = deadline() - o.now();
    if (left <= 0) { finish("error"); return; }
    attempt++;
    const ctl = new o.AbortController();
    const mine = { ctl: ctl, timer: null };
    cur = mine;
    // El tiempo máximo del intento nunca pasa del plazo global: al vencer, se aborta.
    mine.timer = o.setTimeout(function () { ctl.abort(); }, Math.min(o.attemptTimeoutS * 1000, left));
    let ok = false;
    try {
      const res = await o.fetch(o.healthUrl, {
        method: "GET", cache: "no-store", credentials: "omit", redirect: "error",
        headers: { Accept: "application/json" }, signal: ctl.signal,
      });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      ok = !ctl.signal.aborted && o.isHealthyPayload(res.status, res.headers.get("content-type"), body);
    } catch (e) {
      ok = false;
    }
    o.clearTimeout(mine.timer);                 // sólo el temporizador de ESTE intento
    if (g !== gen || cur !== mine) return;      // continuación antigua: se descarta
    cur = null;
    if (finished) return;
    if (o.now() >= deadline()) { finish("error"); return; } // fuera de plazo: no cuenta
    if (ok) { finished = true; cancel(); emit("ready"); o.onReady(); return; }
    plan();
  }

  function begin(at) { cancel(); start = typeof at === "number" ? at : o.now(); attempt = 0; finished = false; plan(); }
  return {
    // start(at): `at` permite continuar un plazo ya empezado (recargas automáticas).
    start(at) { begin(at); },
    // «Reintentar»: sólo por acción del usuario abre un plazo nuevo.
    retry() { begin(); },
    onVisibilityChange() {
      if (finished) return;
      if (o.isHidden()) { cancel(); emit("paused"); }
      else if (!timer && !cur) plan();
    },
    onOnline() { if (!finished && !timer && !cur) plan(); },
    onOffline() { if (!finished) { cancel(); emit("offline"); } },
    stop() { finished = true; cancel(); }, // pagehide
    get attempts() { return attempt; },
    get finished() { return finished; },
    get startedAt() { return start; },
  };
}

// Límite de recargas automáticas (riesgo 3 de la revisión de GPT): /api/health
// puede responder bien mientras la navegación a la página sigue lenta o falla; el
// Worker vuelve a servir esta pantalla y, sin límite, cada recarga abriría un
// plazo nuevo: un ciclo indefinido que mantiene despierto Render.
//
// El estado vive en sessionStorage de ESTA pestaña (no es una cookie: no viaja al
// servidor), por ruta y parámetros. Guarda cuándo empezó el plazo y cuántas
// recargas automáticas van. Una recarga continúa el mismo plazo de 120 s y hay
// como mucho `maxReloads`; después sólo la persona puede volver a intentarlo.
// Un registro sólo vale si ESTA carga es una recarga (`isReload`, del tipo de
// navegación del navegador) y la última fue hace menos de `windowS`; una
// navegación nueva siempre abre un plazo nuevo. Si sessionStorage no está
// disponible, NO hay recarga automática: la pantalla ofrece un botón.
export const RELOAD_DEFAULTS = Object.freeze({ maxReloads: 3, windowS: 600, keyPrefix: "qracks_espera_v1:" });

export function createReloadGuard(o) {
  function read() {
    try {
      const raw = o.storage && o.storage.getItem(o.key);
      const r = raw ? JSON.parse(raw) : null;
      if (r && typeof r.first === "number" && typeof r.last === "number" && typeof r.n === "number") return r;
    } catch (e) {}
    return null;
  }
  function write(r) {
    try { o.storage.setItem(o.key, JSON.stringify(r)); return read() !== null; } catch (e) { return false; }
  }
  function reset() { try { o.storage.removeItem(o.key); } catch (e) {} }
  return {
    // Al mostrarse la pantalla: ¿continúa un plazo de una recarga automática reciente?
    begin() {
      const r = read(), now = o.now();
      if (o.isReload && r && now >= r.last && now - r.last <= o.windowS * 1000 && now >= r.first) return { startedAt: r.first, reloads: r.n };
      reset();
      return { startedAt: now, reloads: 0 };
    },
    // Antes de recargar sola: true si queda cupo y se pudo registrar; si no, false.
    tryReload(startedAt) {
      const r = read();
      const n = r && r.first === startedAt ? r.n : 0;
      if (n >= o.maxReloads) return false;
      return write({ first: startedAt, last: o.now(), n: n + 1 });
    },
    reset: reset,
  };
}
