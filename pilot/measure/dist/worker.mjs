// UX-INFRA-001 · Worker de medición H-WAKE (generado por pilot/dev/bundle.mjs; no editar a mano)
// ── edge/copy.mjs ──
// UX-INFRA-001 · Textos de la pantalla de carga (propuesta v3, revisión de GPT).
// El texto depende sólo del DESTINO (la ruta). Nada de la URL se imprime en la
// página: sólo se elige uno de estos textos fijos. La app comprueba después la
// existencia de la quiniela y los permisos.

function destinationFor(pathname) {
  const p = String(pathname || "/");
  if (p === "/crear" || p.startsWith("/crear/")) return "crear";
  if (/^\/q\/[^/]+/.test(p)) return "q";
  if (/^\/a\/[^/]+/.test(p)) return "a";
  return "inicio";
}

const TITLES = Object.freeze({
  inicio: "Estamos abriendo QRACKS",
  crear: "Estamos preparando el formulario para crear tu quiniela",
  q: "Estamos abriendo tu quiniela",
  a: "Estamos abriendo la administración de tu quiniela",
});

const TEXT = Object.freeze({
  auto: "La página se abrirá automáticamente cuando esté disponible.",
  slowTitle: "Está tardando más de lo normal",
  slowBody: "Seguimos intentando. La página se abrirá automáticamente cuando esté disponible.",
  errorTitle: "No pudimos abrir QRACKS después de 2 minutos. Puedes reintentar.",
  offlineTitle: "Sin conexión a internet",
  offlineBody: "Tu dispositivo no tiene conexión. Volveremos a intentar cuando regrese.",
  pausedBody: "La pestaña está en segundo plano: retomamos al volver, dentro del plazo de 2 minutos.",
  safe: "Esta pantalla no envía ni modifica tus pronósticos.",
  payment: "Volviste de la página de pago. Cuando QRACKS abra, verás el estado de tu compra tal como lo registre el sistema.",
  stuckTitle: "QRACKS ya responde, pero la página no terminó de abrir",
  stuckBody: "Intentamos abrirla varias veces. Puedes volver a intentarlo cuando quieras.",
  openAgain: "Abrir de nuevo",
  retry: "Reintentar",
  retryNow: "Reintentar ahora",
  meanwhile: "Mientras tanto",
  pause: "Pausar",
  resume: "Reanudar",
});

const PARTICIPANT = [
  ["🏆", "Consulta tu posición después de publicar resultados", "Cuando el organizador publica los resultados de una jornada, la tabla muestra tu lugar y tus puntos."],
  ["🔍", "Consulta resultados y pronósticos de jornadas anteriores", "En el historial ves qué pronosticó cada quien en las jornadas ya cerradas y cuántos puntos sumó."],
  ["❓", "Más que partidos", "Tu quiniela puede incluir preguntas extra, como si habrá penales. Las califica el organizador."],
  ["📱", "Entras con tu nombre y tu PIN", "Sin descargar apps ni crear cuentas: desde el celular o la compu, con el enlace de tu quiniela."],
];
const ORGANIZER = [
  ["🔗", "Arma tu quiniela y compártela con un enlace", "Tus amigos entran desde el enlace, sin descargar nada."],
  ["📱", "Entran con su nombre y un PIN", "Sin apps ni cuentas: desde el celular o la compu."],
  ["⭐", "Preguntas y puntos extra", "Además de los partidos, agrega preguntas como si habrá penales. Tú decides cuántos puntos valen y tú calificas quién acertó."],
  ["💵", "Registra las cuotas del grupo", "Marca quién ya cubrió su cuota y, si quieres, resta puntos a quien no. QRACKS sólo lleva el registro: no cobra ni custodia ese dinero."],
  ["🏆", "Puntos y tabla al publicar resultados", "Cuando publicas los resultados de una jornada, QRACKS calcula los puntos y la tabla para todos."],
  ["🚀", "¿Van por todo el torneo? QRACKS Plus", "Con Plus tu quiniela cubre el torneo completo y admite más personas. Se activa desde Admin, cuando lo necesites."],
];

function tipsFor(dest) {
  if (dest === "q") return PARTICIPANT;
  if (dest === "a") return ORGANIZER.slice(1);
  return ORGANIZER;
}

// ── edge/waker.mjs ──
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

function isHealthyPayload(status, contentType, body) {
  if (status !== 200) return false;
  if (!/^application\/json\b/i.test(String(contentType || ""))) return false;
  if (!body || typeof body !== "object" || body.ok !== true) return false;
  if (typeof body.time !== "string" || !body.time) return false;
  return Number.isFinite(Date.parse(body.time));
}

const WAKE_DEFAULTS = Object.freeze({
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
function createWaker(o) {
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
const RELOAD_DEFAULTS = Object.freeze({ maxReloads: 3, windowS: 600, keyPrefix: "qracks_espera_v1:" });

function createReloadGuard(o) {
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

// ── edge/page.mjs ──
// UX-INFRA-001 · HTML de la pantalla de carga que sirve el Worker.
// Autocontenido: CSS y JS en línea, sin recursos externos. La única petición que
// hace la página es GET /api/health (requisito R1: no envía ni modifica pronósticos).



const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// opts.static: versión para un SITIO ESTÁTICO (alternativa Render Static Site). Se genera
// una sola vez y sirve cualquier ruta: el texto del destino y el aviso de pago se eligen
// en el navegador (sólo entre textos fijos), y al estar listo NO recarga: continúa
// pidiendo `continueUrl` (en la app real sería seguir con boot()).
function renderLoadingPage(requestUrl, opts = {}) {
  const url = new URL(requestUrl);
  const dest = destinationFor(url.pathname);
  const fromPayment = url.searchParams.has("qz_pago") && !url.searchParams.has("qz_pago_cancelado");
  // Sólo valores fijos (nada que venga de la URL) pasan al script.
  const { payment, ...text } = TEXT;
  if (fromPayment) text.payment = payment;
  const cfg = {
    title: TITLES[dest], text, tips: tipsFor(dest), payment: fromPayment,
    wake: WAKE_DEFAULTS, reload: RELOAD_DEFAULTS,
  };
  if (opts.static) {
    Object.assign(cfg, { static: true, continueUrl: opts.continueUrl || "/api/pilot-app", titles: TITLES,
      tipsByDest: { inicio: tipsFor("inicio"), crear: tipsFor("crear"), q: tipsFor("q"), a: tipsFor("a") } });
    cfg.text = Object.assign({}, TEXT); cfg.payment = false;
  }
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>QRACKS</title>
<meta property="og:title" content="QRACKS">
<meta property="og:description" content="Quinielas entre amigos.">
<style>
:root{--pd:#0F2E22;--pl:#2D6A4F;--chalk:#F7F5EC;--paper:#fff;--gold:#D6A73C;--ink:#10231C;--soft:#4B5B53;--err:#8A2A1F}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{font-family:Manrope,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:radial-gradient(circle at 50% 0%,var(--pl),var(--pd) 70%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
.card{width:100%;max-width:460px;background:var(--paper);border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);display:grid;grid-template-columns:1fr}
.status{padding:28px 24px 24px}.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.mark{width:34px;height:34px;border-radius:9px;background:var(--pd);display:grid;place-items:center;color:var(--gold);font-weight:800;font-size:18px}
.word{font-weight:800;letter-spacing:.08em;color:var(--pd);font-size:18px}
h1{font-size:24px;line-height:1.2;margin:0 0 10px}p{margin:0 0 12px;line-height:1.5;color:var(--soft);font-size:15px}
.bar{height:6px;border-radius:99px;background:var(--chalk);overflow:hidden;margin:18px 0 12px;position:relative}
.bar:after{content:"";position:absolute;inset:0;width:35%;border-radius:99px;background:var(--gold);animation:s 1.4s ease-in-out infinite}
@keyframes s{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}
.meta,.safe{font-size:13px;color:var(--soft)}.safe{margin-top:10px}
.note{margin-top:16px;padding:12px 14px;border-radius:12px;background:#FFF6E0;border:1px solid #F0D99A;font-size:14px;line-height:1.45}
.btn{appearance:none;border:0;border-radius:12px;background:var(--pd);color:#fff;font:inherit;font-weight:700;font-size:16px;padding:14px 18px;width:100%;margin-top:18px;cursor:pointer;min-height:48px}
.btn:focus-visible,.pause:focus-visible{outline:3px solid var(--gold);outline-offset:2px}.err h1{color:var(--err)}
.tips{display:none;background:var(--pd);color:#fff;padding:24px}.card.withTips .tips{display:flex;flex-direction:column}
.kicker{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);font-weight:800;margin-bottom:14px}
.tip .icon{width:44px;height:44px;border-radius:12px;background:rgba(214,167,60,.16);display:grid;place-items:center;font-size:22px;margin-bottom:12px}
.tip h2{font-size:19px;line-height:1.3;margin:0 0 8px;color:#fff}.tip p{color:rgba(255,255,255,.82);font-size:15px;margin:0}
.nav{display:flex;align-items:center;gap:12px;margin-top:18px}.dots{display:flex;gap:6px;flex:1}
.dots span{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.3)}.dots span.on{background:var(--gold);width:20px;border-radius:99px}
.pause{appearance:none;border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;border-radius:10px;font:inherit;font-size:13px;padding:8px 12px;min-height:40px;cursor:pointer}
@media (prefers-reduced-motion:reduce){.bar:after{animation:none;width:100%;opacity:.45}}
@media (min-width:900px){body{padding:48px}.card{max-width:720px;border-radius:28px;min-height:min(560px,70vh)}
.status{padding:48px 52px 44px;display:flex;flex-direction:column;justify-content:center}h1{font-size:34px}p{font-size:18px}
.meta,.safe{font-size:15px}.card.withTips{max-width:1160px;grid-template-columns:1.05fr 1fr}.tips{padding:48px;justify-content:center}.tip h2{font-size:26px}.tip p{font-size:18px}}
</style>
</head>
<body>
<main class="card" id="card">
  <section class="status" id="status" role="status" aria-live="polite">
    <div class="brand"><span class="mark" aria-hidden="true">Q</span><span class="word">QRACKS</span></div>
    <h1 id="title">${esc(cfg.title)}</h1><p id="body">${esc(TEXT.auto)}</p>
    <noscript><p>Vuelve a cargar esta página en unos segundos.</p></noscript>
  </section>
  <aside class="tips" id="tips" aria-label="${esc(TEXT.meanwhile)}">
    <div class="kicker">${esc(TEXT.meanwhile)}</div><div id="tip"></div>
    <div class="nav"><div class="dots" id="dots" aria-hidden="true"></div>
      <button type="button" class="pause" id="pause" aria-pressed="false">${esc(TEXT.pause)}</button></div>
  </aside>
</main>
<script>
(function(){
  "use strict";
  var CFG = ${cfgJson};
  var isHealthyPayload = ${isHealthyPayload.toString()};
  var createWaker = ${createWaker.toString()};
  var createReloadGuard = ${createReloadGuard.toString()};
  var T = CFG.text, $ = function(id){ return document.getElementById(id); };
  if (CFG.static) {
    // Sitio estático: el destino y el aviso de pago salen de la URL, pero sólo eligen textos fijos.
    var destinationFor = ${destinationFor.toString()};
    var dest = destinationFor(location.pathname), qs = new URLSearchParams(location.search);
    CFG.title = CFG.titles[dest]; CFG.tips = CFG.tipsByDest[dest];
    CFG.payment = qs.has("qz_pago") && !qs.has("qz_pago_cancelado");
    $("title").textContent = CFG.title;
  }
  var e = function(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"})[c]; }); };
  var brand = '<div class="brand"><span class="mark" aria-hidden="true">Q</span><span class="word">QRACKS</span></div>';
  var note = CFG.payment ? '<div class="note">' + e(T.payment) + '</div>' : '';
  var safe = '<p class="safe">' + e(T.safe) + '</p>';
  // Límite de recargas: una recarga automática continúa el MISMO plazo (no lo reinicia).
  var store = null; try { store = window.sessionStorage; } catch (x) { store = null; }
  var navType = ""; try { var nav = performance.getEntriesByType("navigation")[0]; navType = nav ? nav.type : ""; } catch (x) {}
  var guard = createReloadGuard({ isReload: navType === "reload", storage: store, key: CFG.reload.keyPrefix + location.pathname + location.search,
    now: function(){ return Date.now(); }, maxReloads: CFG.reload.maxReloads, windowS: CFG.reload.windowS });
  var cycle = guard.begin();
  var current = { state: "waiting", elapsed: 0 }, shownAt = cycle.startedAt;
  function paint(){
    var s = current, h;
    var secs = Math.floor((Date.now() - shownAt) / 1000);
    if (s.state === "stuck") h = brand + '<h1>' + e(T.stuckTitle) + '</h1><p>' + e(T.stuckBody) + '</p><button class="btn" id="again" type="button">' + e(T.openAgain) + '</button>' + safe;
    else if (s.state === "error") h = '<div class="err">' + brand + '<h1>' + e(T.errorTitle) + '</h1><button class="btn" id="retry" type="button">' + e(T.retry) + '</button>' + safe + '</div>';
    else if (s.state === "offline") h = brand + '<h1>' + e(T.offlineTitle) + '</h1><p>' + e(T.offlineBody) + '</p><button class="btn" id="retry" type="button">' + e(T.retryNow) + '</button>' + safe;
    else {
      var slow = s.state === "slow";
      var next = s.nextAt ? Math.max(1, Math.ceil((s.nextAt - Date.now()) / 1000)) : null;
      var meta = s.state === "paused" ? e(T.pausedBody) : 'Llevamos ' + secs + ' s' + (next ? ' · Próximo intento en ' + next + ' s' : ' · Consultando…');
      h = brand + '<h1>' + e(slow ? T.slowTitle : CFG.title) + '</h1><p>' + e(slow ? T.slowBody : T.auto) + '</p><div class="bar" aria-hidden="true"></div><div class="meta">' + meta + '</div>' + safe;
    }
    var html = h + note;
    if ($("status").innerHTML !== html) $("status").innerHTML = html;
    // Sólo una acción de la persona abre un plazo nuevo y repone el cupo de recargas.
    var r = $("retry"); if (r && !r.onclick) r.onclick = function(){ guard.reset(); w.retry(); cycle = { startedAt: w.startedAt, reloads: 0 }; shownAt = cycle.startedAt; };
    var a = $("again"); if (a && !a.onclick) a.onclick = function(){ guard.reset(); window.location.reload(); };
  }
  var w = createWaker({
    fetch: window.fetch.bind(window), setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    now: function(){ return Date.now(); }, AbortController: window.AbortController,
    isHidden: function(){ return document.visibilityState === "hidden"; },
    isOnline: function(){ return navigator.onLine !== false; },
    isHealthyPayload: isHealthyPayload,
    healthUrl: CFG.wake.healthUrl, schedule: CFG.wake.schedule, after: CFG.wake.after,
    budgetS: CFG.wake.budgetS, attemptTimeoutS: CFG.wake.attemptTimeoutS, slowAfterS: CFG.wake.slowAfterS,
    onState: function(s){ current = s; paint(); },
    // Recarga la MISMA URL (ruta, parámetros y fragmento) sin entrada nueva en el historial.
    // No location.replace(href): con un #fragmento sería una navegación dentro del mismo
    // documento y no volvería a pedir la página (encontrado en la prueba local).
    // Sólo si queda cupo de recargas automáticas y se pudo registrar; si no, botón.
    onReady: function(){
      if (CFG.static) { continueApp(); return; }
      if (guard.tryReload(cycle.startedAt)) { window.location.reload(); return; }
      current = { state: "stuck" }; paint();
    }
  });
${cfg.static ? `  // Sitio estático: sin recarga. Una sola petición GET de continuación con la ruta y los
  // parámetros actuales; la URL de la barra no cambia.
  function continueApp(){
    var ctl = new AbortController(); var t = setTimeout(function(){ ctl.abort(); }, 15000);
    fetch(CFG.continueUrl + "?path=" + encodeURIComponent(location.pathname + location.search), { method: "GET", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: ctl.signal })
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(j){ clearTimeout(t); document.body.innerHTML = '<main id="app"><h1>app</h1><pre id="seen">' + e(j.seen == null ? "" : j.seen) + '</pre></main>'; })
      .catch(function(){ clearTimeout(t); current = { state: "error" }; paint(); });
  }
` : ""}  document.addEventListener("visibilitychange", function(){ w.onVisibilityChange(); });
  window.addEventListener("online", function(){ w.onOnline(); });
  window.addEventListener("offline", function(){ w.onOffline(); });
  window.addEventListener("pagehide", function(){ w.stop(); });
  setInterval(paint, 500);
  w.start(cycle.startedAt);

  // «Mientras tanto»: a los 5 s, 7 s visibles por beneficio; pausa con ratón, toque o teclado.
  var tips = CFG.tips, idx = 0, visible = 0, hover = false, paused = false, last = Date.now(), shown = false;
  function tip(){
    $("tip").innerHTML = '<div class="tip"><div class="icon" aria-hidden="true">' + tips[idx][0] + '</div><h2>' + e(tips[idx][1]) + '</h2><p>' + e(tips[idx][2]) + '</p></div>';
    $("dots").innerHTML = tips.map(function(_, k){ return '<span class="' + (k === idx ? 'on' : '') + '"></span>'; }).join("");
  }
  $("tips").addEventListener("mouseenter", function(){ hover = true; });
  $("tips").addEventListener("mouseleave", function(){ hover = false; });
  $("pause").addEventListener("click", function(){ paused = !paused; this.textContent = paused ? T.resume : T.pause; this.setAttribute("aria-pressed", String(paused)); });
  setInterval(function(){
    var now = Date.now(), dt = now - last; last = now;
    var st = current.state;
    if (!shown && now - shownAt >= 5000 && st !== "error" && st !== "offline" && st !== "stuck") { shown = true; $("card").classList.add("withTips"); tip(); }
    if (shown && (st === "error" || st === "offline" || st === "stuck")) { shown = false; $("card").classList.remove("withTips"); }
    if (shown && !hover && !paused) { visible += dt; if (visible >= 7000) { visible = 0; idx = (idx + 1) % tips.length; tip(); } }
  }, 250);
})();
</script>
</body>
</html>`;
}

// ── edge/worker.mjs ──
// UX-INFRA-001 · Cloudflare Worker delante de QRACKS (sólo para el piloto; no desplegado).
//
// Solo actúa en NAVEGACIONES (GET/HEAD de una página). Todo lo demás —API,
// webhooks, archivos y cualquier método que escribe— se reenvía tal cual, una
// sola vez y sin reintentos. Ojo: en producción /api/* además se excluye con una
// ruta SIN Worker, pero eso no la saca del proxy de Cloudflare (ver H-IP / H-TLS).
//
// En una navegación pide al origen la MISMA URL y espera hasta ORIGIN_TIMEOUT_MS.
// Si llega la respuesta de la app, la entrega intacta (estado, cabeceras,
// Set-Cookie, cuerpo). Si no, sirve la pantalla de carga y deja viva la petición
// al origen (waitUntil) para que despierte.


const ORIGIN_TIMEOUT_MS = 3000;
const FILE_RE = /\/[^/]+\.[A-Za-z0-9]{1,8}$/;   // /logo.svg, /liguillaScoring.js, /robots.txt…
const BODYLESS = new Set(["GET", "HEAD"]);

function isApiPath(pathname) { return pathname === "/api" || pathname.startsWith("/api/"); }

function isNavigation(request) {
  if (!BODYLESS.has(request.method)) return false;
  const { pathname } = new URL(request.url);
  if (isApiPath(pathname) || FILE_RE.test(pathname)) return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return /\btext\/html\b/i.test(request.headers.get("accept") || "");
}

// H-WAKE: cómo distinguir la página de arranque de Render de una respuesta de la
// app SÓLO se sabrá midiendo en el piloto externo. Hasta entonces no se adivina:
// nada se clasifica como «página de Render».
function isRenderWakePage(_response) { return false; }

// URL hacia el origen. En Cloudflare es la misma URL (env.ORIGIN vacío); en el
// emulador local se cambia sólo el host, conservando ruta, parámetros y fragmento.
function originUrl(requestUrl, env) {
  if (!env || !env.ORIGIN) return requestUrl;
  const u = new URL(requestUrl), o = new URL(env.ORIGIN);
  u.protocol = o.protocol; u.host = o.host;
  return u.toString();
}

function forward(request, env, fetchImpl) {
  let headers = request.headers;
  if (env && env.ORIGIN) {
    // Sólo en el emulador local: Host y cabeceras de conexión son del salto anterior.
    headers = new Headers(request.headers);
    ["host", "connection", "keep-alive", "transfer-encoding", "content-length"].forEach((h) => headers.delete(h));
  }
  const init = { method: request.method, headers, redirect: "manual" };
  if (!BODYLESS.has(request.method)) { init.body = request.body; init.duplex = "half"; }
  return fetchImpl(new Request(originUrl(request.url, env), init));
}

function loadingResponse(request) {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": "5",
    "x-robots-tag": "noindex",
  };
  const body = request.method === "HEAD" ? null : renderLoadingPage(request.url);
  return new Response(body, { status: 503, headers });
}

async function handle(request, env, ctx, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const timeoutMs = deps.timeoutMs ?? ORIGIN_TIMEOUT_MS;
  // Paso directo, una sola vez: el error del origen (si lo hay) llega igual al cliente.
  if (!isNavigation(request)) return forward(request, env, fetchImpl);

  const toOrigin = forward(request, env, fetchImpl);
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); });
  const first = await Promise.race([toOrigin.then((r) => r, () => null), timeout]);
  clearTimeout(timer);
  if (first && !isRenderWakePage(first)) return first;
  if (first && first.body) first.body.cancel().catch(() => {});
  // La petición sigue para despertar al origen; su respuesta se descarta.
  ctx.waitUntil(toOrigin.then((r) => (r.body ? r.body.cancel() : null), () => null).catch(() => null));
  return loadingResponse(request);
}



// ── measure/probe-worker.mjs ──
// UX-INFRA-001 · H-WAKE · Worker de MEDICIÓN (sólo para workers.dev, nunca para qracks.net).
//
// Es el Worker del piloto (handle) más un único endpoint de medición:
//   GET /__pilot/probe?path=/q/demo&kind=nav|api   (cabecera x-pilot-token obligatoria)
// que hace UNA subpetición al origen (env.ORIGIN + path), sin seguir redirecciones,
// y devuelve en JSON lo que el Worker recibió de verdad: estado, cabeceras, tiempos,
// tamaño, sha256 y el comienzo del cuerpo. Con eso se define isRenderWakePage a
// partir de lo observado, sin adivinar.
//
// Límites: sólo pide a env.ORIGIN; `path` debe empezar por "/" y no puede ser una
// URL absoluta; sin token (secreto PILOT_TOKEN del Worker) responde 404.


const PROBE_TIMEOUT_MS = 100_000;
const HEADERS = {
  nav: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 (qracks-hwake-probe)" },
  api: { accept: "application/json", "sec-fetch-mode": "cors", "user-agent": "Mozilla/5.0 (qracks-hwake-probe)" },
};

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b || a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export async function probe(request, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = deps.now || (() => Date.now());
  if (!sameToken(request.headers.get("x-pilot-token") || "", env.PILOT_TOKEN || "")) return new Response("not found", { status: 404 });
  const u = new URL(request.url);
  const path = u.searchParams.get("path") || "/";
  const kind = u.searchParams.get("kind") === "api" ? "api" : "nav";
  if (!path.startsWith("/") || path.startsWith("//")) return new Response("bad path", { status: 400 });
  const target = new URL(path, env.ORIGIN);
  if (target.origin !== new URL(env.ORIGIN).origin) return new Response("bad path", { status: 400 });
  const t0 = now(); const out = { target: target.pathname + target.search, kind, startedAt: new Date(t0).toISOString() };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(new Request(target.toString(), { method: "GET", headers: HEADERS[kind], redirect: "manual", signal: ctl.signal }));
    out.headersMs = now() - t0;
    out.status = res.status;
    out.headers = Object.fromEntries([...res.headers].map(([k, v]) => [k, v]));
    out.setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const buf = await res.arrayBuffer();
    out.totalMs = now() - t0;
    out.bytes = buf.byteLength;
    out.sha256 = await sha256Hex(buf);
    out.bodyStart = new TextDecoder().decode(buf.slice(0, 2000));
  } catch (e) {
    out.error = String(e && e.name || e); out.totalMs = now() - t0;
  } finally { clearTimeout(timer); }
  return new Response(JSON.stringify(out, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__pilot/probe") return probe(request, env);
    return handle(request, env, ctx);
  },
};
