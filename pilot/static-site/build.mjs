// UX-INFRA-001 · Alternativa Render Static Site · genera el sitio estático del piloto.
//   dist/index.html  pantalla de espera en modo estático (cualquier ruta, vía reescritura /* → /index.html)
//   dist/ip.html     comparación de la IP decidida: por el sitio estático y directo al servicio
// Se publica tal cual (sin build en Render). Uso: node pilot/static-site/build.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderLoadingPage } from "../edge/page.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const IP_PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>QRACKS · piloto IP</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px 16px;background:#F7F5EC;color:#10231C}main{max-width:560px;margin:0 auto}
h1{font-size:22px}.r{background:#fff;border-radius:12px;padding:14px;margin:12px 0}.ok{color:#2D6A4F;font-weight:700}.bad{color:#8A2A1F;font-weight:700}code{word-break:break-all}</style></head>
<body><main><h1>Piloto: ¿qué IP decide la app?</h1>
<p>Compara la IP que decidiría QRACKS al llegar por el sitio estático y al llegar directo al servicio. No se guarda nada.</p>
<div class="r" id="out">Consultando…</div></main>
<script>
(function(){
  "use strict";
  var e = function(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"})[c]; }); };
  var direct = new URLSearchParams(location.search).get("directo") || "";
  if (!/^https:\\/\\/[a-z0-9-]+\\.onrender\\.com$/.test(direct)) { document.getElementById("out").innerHTML = "Falta ?directo=https://&lt;servicio&gt;.onrender.com"; return; }
  function get(u, cred){ return fetch(u, { cache: "no-store", credentials: cred }).then(function(r){ return r.json(); }); }
  Promise.all([get("/api/client-ip", "same-origin"), get(direct + "/api/client-ip", "omit")]).then(function(v){
    var a = v[0].decided, b = v[1].decided, same = a.ip === b.ip && a.ip !== "unknown";
    document.getElementById("out").innerHTML =
      '<p class="' + (same ? "ok" : "bad") + '">' + (same ? "Coinciden" : "NO coinciden") + '</p>' +
      '<p>Por el sitio estático: <code>' + e(a.ip) + '</code> (' + e(a.via) + ')</p>' +
      '<p>Directo al servicio: <code>' + e(b.ip) + '</code> (' + e(b.via) + ')</p>';
  }).catch(function(x){ document.getElementById("out").textContent = "Error: " + x; });
})();
</script></body></html>
`;

export function build() {
  return { "index.html": renderLoadingPage("https://piloto.invalid/", { static: true }), "ip.html": IP_PAGE };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.join(here, "dist"); fs.mkdirSync(dir, { recursive: true });
  for (const [name, html] of Object.entries(build())) { fs.writeFileSync(path.join(dir, name), html); console.log(`${name} · ${html.length} bytes`); }
}
