// UX-INFRA-001 · Servicio mínimo del piloto: sin base de datos, sin secretos,
// sin dependencias. Imita lo que el piloto necesita de QRACKS:
//   GET  /api/health   → { ok: true, time } (el mismo contrato que la app)
//   GET  /api/eco-ip   → las cabeceras de IP que llegan (para H-IP; un eco NO valida el limitador)
//   POST /api/eco      → bytes y sha256 del cuerpo recibido (comprueba que nadie lo toca)
//   POST /api/payments/stripe/webhook → igual que /api/eco (sólo simula la ruta)
//   GET  /files/app.js → un archivo estático
//   GET  cualquier otra ruta → HTML que muestra la ruta y los parámetros recibidos (escapados)
//
// Para las pruebas locales simula el arranque en frío: mientras `asleep`, las
// peticiones se RETIENEN (como hace Render al despertar) hasta wake().

import http from "node:http";
import crypto from "node:crypto";

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
        sha256: crypto.createHash("sha256").update(body).digest("hex") });
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
    if (req.method === "GET" && p === "/api/eco-ip") return json(res, 200, {
      cfConnectingIp: req.headers["cf-connecting-ip"] || null,
      xForwardedFor: req.headers["x-forwarded-for"] || null,
      trueClientIp: req.headers["true-client-ip"] || null,
      remoteAddress: req.socket.remoteAddress,
    });
    if (req.method === "POST" && (p === "/api/eco" || p === "/api/payments/stripe/webhook")) return json(res, 200, {
      bytes: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex"),
      signature: req.headers["stripe-signature"] || null,
    });
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
  svc.server.listen(port, () => console.log("wake-pilot listening on " + port));
}
