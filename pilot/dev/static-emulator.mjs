// Emulador LOCAL de un sitio estático con reescrituras, al estilo de Render:
//   /api/*  → se reenvía al origen (misma ruta y query), sin seguir redirecciones
//   archivo existente → se sirve
//   cualquier otra ruta → /index.html
// SÓLO para pruebas locales. No reproduce el proxy de Render (IP, cabeceras, tiempos):
// eso es justo lo que mide el piloto externo.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export function createStaticEmulator({ dir, origin }) {
  const o = new URL(origin);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://local");
    if (u.pathname === "/api" || u.pathname.startsWith("/api/")) {
      const headers = Object.assign({}, req.headers); delete headers.host;
      const up = http.request({ host: o.hostname, port: o.port, method: req.method, path: req.url, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on("error", () => { res.writeHead(502, { "content-type": "text/plain" }); res.end("bad gateway"); });
      req.pipe(up); return;
    }
    const file = path.join(dir, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ""));
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dir, "index.html");
    res.writeHead(200, { "content-type": target.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream", "cache-control": "no-cache" });
    res.end(fs.readFileSync(target));
  });
  return {
    server,
    listen(port = 0) { return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server.address().port))); },
    close() { server.closeAllConnections?.(); return new Promise((r) => server.close(() => r())); },
  };
}
