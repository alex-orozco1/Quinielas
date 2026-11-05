// UX-INFRA-001 · Servicio mínimo del piloto: sin base de datos, sin secretos,
// sin dependencias. Imita lo que el piloto necesita de QRACKS:
//   GET  /api/health   → { ok: true, time } (el mismo contrato que la app)
//   GET  /api/eco-ip   → las cabeceras de IP que llegan (para H-IP; un eco NO valida el limitador)
//   POST /api/eco      → bytes y sha256 del cuerpo recibido (comprueba que nadie lo toca)
//   POST /api/payments/stripe/webhook → igual que /api/eco (sólo simula la ruta)
//   GET  /files/app.js → un archivo estático
//   GET  /api/client-ip → la IP que decidiría la app (clientIp.js) y las cabeceras de IP recibidas
//   POST /api/pilot-cookie/set · GET /api/pilot-cookie/echo · POST /api/pilot-cookie/clear
//   GET  /api/pilot-app?path=… → «continuación» de la app tras despertar (la pantalla estática)
//   POST|PUT|PATCH|DELETE /api/eco → método, ruta, query, tipo, bytes, sha256 y firma recibidos
//   GET  /api/pilot-log?probe=<id> → qué peticiones con ese `probe` llegaron (método, ruta,
//        bytes, sha256, si traía firma). Para contar que una API/POST llegó UNA sola vez.
//   GET  cualquier otra ruta → HTML que muestra la ruta y los parámetros recibidos (escapados)
//
// Para las pruebas locales simula el arranque en frío: mientras `asleep`, las
// peticiones se RETIENEN (como hace Render al despertar) hasta wake().

import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";

// La MISMA decisión de IP que la app (clientIp.js de la raíz del repo). En Render,
// RENDER=true elige la fuente «render»: CF-Connecting-IP y, si falta, la entrada
// tercera desde la derecha de X-Forwarded-For.
const clientIp = createRequire(import.meta.url)("../../clientIp.js");
const IP_SOURCE = clientIp.resolveSource(process.env);
const IP_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "true-client-ip", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto", "via"];
// Cookies de prueba con los MISMOS atributos que la sesión de la app (server.js:183).
const COOKIE_SESSION = "qracks_session_piloto", COOKIE_VISIBLE = "qz_piloto_visible";
function parseCookies(h) { const out = {}; String(h || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return out; }

const STARTED_AT = new Date().toISOString(); // cambia en cada arranque: delata un arranque en frío
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function createWakeService({ asleep = false, holdPages = false } = {}) {
  const requests = [];
  let waiting = [], heldPages = [];
  let sleeping = asleep, holding = holdPages;
  // `holdPages`: /api/* responde, pero las páginas quedan retenidas (navegación lenta).
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, bytes: body.length,
        sha256: crypto.createHash("sha256").update(body).digest("hex"), at: new Date().toISOString() });
      if (requests.length > 1000) requests.splice(0, requests.length - 1000);
      const respond = () => route(req, res, body);
      const isPage = (req.method === "GET" || req.method === "HEAD") && !req.url.startsWith("/api/");
      if (sleeping) waiting.push(respond);
      else if (holding && isPage) heldPages.push(respond);
      else respond();
    });
  });
  function route(req, res, body) {
    const url = new URL(req.url, "http://local");
    const p = url.pathname;
    if (req.method === "GET" && p === "/api/health") return json(res, 200, { ok: true, time: new Date().toISOString() });
    if (req.method === "GET" && p === "/api/pilot-log") {
      const id = url.searchParams.get("probe") || "";
      const seen = id ? requests.filter((r) => { const q = new URL(r.url, "http://local"); return q.pathname !== "/api/pilot-log" && q.searchParams.get("probe") === id; }) : [];
      return json(res, 200, { probe: id, startedAt: STARTED_AT, count: seen.length,
        requests: seen.map((r) => ({ method: r.method, url: r.url, bytes: r.bytes, sha256: r.sha256, signature: Boolean(r.headers["stripe-signature"]), at: r.at })) });
    }
    if (req.method === "GET" && p === "/api/eco-ip") return json(res, 200, {
      cfConnectingIp: req.headers["cf-connecting-ip"] || null,
      xForwardedFor: req.headers["x-forwarded-for"] || null,
      trueClientIp: req.headers["true-client-ip"] || null,
      remoteAddress: req.socket.remoteAddress,
    });
    if ((p === "/api/eco" && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) || (req.method === "POST" && p === "/api/payments/stripe/webhook")) return json(res, 200, {
      method: req.method, path: p, query: url.search, contentType: req.headers["content-type"] || null,
      contentEncoding: req.headers["content-encoding"] || null,
      bytes: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex"),
      signature: req.headers["stripe-signature"] || null,
    });
    if (req.method === "GET" && p === "/api/client-ip") {
      // CORS sólo aquí, sin credenciales: la página de IP compara esta ruta directa con la del sitio estático.
      res.setHeader("access-control-allow-origin", "*");
      const seen = {}; IP_HEADERS.forEach((h) => { if (req.headers[h] != null) seen[h] = req.headers[h]; });
      return json(res, 200, { decided: clientIp.clientIpInfo(req, IP_SOURCE), source: IP_SOURCE, headers: seen, remoteAddress: req.socket.remoteAddress });
    }
    if (req.method === "POST" && p === "/api/pilot-cookie/set") {
      const token = crypto.randomBytes(12).toString("hex");
      res.setHeader("set-cookie", [
        `${COOKIE_SESSION}=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
        `${COOKIE_VISIBLE}=1; Path=/; Max-Age=31536000; Secure; SameSite=Lax`,
      ]);
      return json(res, 200, { set: [COOKIE_SESSION, COOKIE_VISIBLE], token });
    }
    if (req.method === "GET" && p === "/api/pilot-cookie/echo") {
      const c = parseCookies(req.headers.cookie);
      return json(res, 200, { session: c[COOKIE_SESSION] || null, visible: c[COOKIE_VISIBLE] || null, names: Object.keys(c).sort() });
    }
    if (req.method === "POST" && p === "/api/pilot-cookie/clear") {
      res.setHeader("set-cookie", [`${COOKIE_SESSION}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, `${COOKIE_VISIBLE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`]);
      return json(res, 200, { cleared: true });
    }
    if (req.method === "GET" && p === "/api/pilot-app") return json(res, 200, { seen: url.searchParams.get("path") || null, startedAt: STARTED_AT });
    if (req.method === "GET" && p === "/files/app.js") {
      res.writeHead(200, { "content-type": "application/javascript", "cache-control": "public, max-age=3600" });
      return res.end("console.log('app');");
    }
    if (req.method === "GET" && p === "/redir") { res.writeHead(302, { location: "/q/demo?desde=redir" }); return res.end(); }
    if (req.method === "GET" || req.method === "HEAD") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": ["pilot_a=1; Path=/; HttpOnly", "pilot_b=2; Path=/"] });
      return res.end(req.method === "HEAD" ? undefined : `<!doctype html><title>app</title><h1 id="app">app</h1><pre id="seen">${esc(req.url)}</pre>`);
    }
    return json(res, 404, { error: "not_found" });
  }
  function json(res, status, obj) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); }
  return {
    server, requests,
    sleep() { sleeping = true; },
    wake() { sleeping = false; const w = waiting; waiting = []; w.forEach((f) => f()); },
    holdPages(v) { holding = v; if (!v) { const h = heldPages; heldPages = []; h.forEach((f) => f()); } },
    listen(port = 0) { return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server.address().port))); },
    close() { this.wake(); this.holdPages(false); return new Promise((r) => server.close(() => r())); },
  };
}

// Arranque directo (p. ej. en el piloto externo): `node pilot/wake-service/server.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const svc = createWakeService();
  const port = Number(process.env.PORT || 3000);
  svc.server.listen(port, () => console.log(`wake-pilot listening on ${port} startedAt=${STARTED_AT}`));
}
