// UX-INFRA-001 · HTML de la pantalla de carga que sirve el Worker.
// Autocontenido: CSS y JS en línea, sin recursos externos. La única petición que
// hace la página es GET /api/health (requisito R1: no envía ni modifica pronósticos).

import { destinationFor, TITLES, TEXT, tipsFor } from "./copy.mjs";
import { isHealthyPayload, createWaker, createReloadGuard, WAKE_DEFAULTS, RELOAD_DEFAULTS } from "./waker.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function renderLoadingPage(requestUrl) {
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
      if (guard.tryReload(cycle.startedAt)) { window.location.reload(); return; }
      current = { state: "stuck" }; paint();
    }
  });
  document.addEventListener("visibilitychange", function(){ w.onVisibilityChange(); });
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
