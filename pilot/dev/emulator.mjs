// Emulador LOCAL del Worker: un servidor Node que pasa cada petición por
// handle() de worker.mjs, con un ctx.waitUntil que guarda las promesas.
// Sirve sólo para pruebas locales; no es Cloudflare ni prueba H-WAKE/H-IP/H-TLS.

import http from "node:http";
import { Readable } from "node:stream";
import { handle } from "../edge/worker.mjs";

// `entry` (opcional): otro punto de entrada tipo Worker, p. ej. el de medición.
export function createEmulator({ origin, timeoutMs, entry, env: extraEnv } = {}) {
  const waitUntils = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = `http://${req.headers.host}${req.url}`;
      const init = { method: req.method, headers: req.headers };
      if (req.method !== "GET" && req.method !== "HEAD") { init.body = Readable.toWeb(req); init.duplex = "half"; }
      const request = new Request(url, init);
      const ctx = { waitUntil: (p) => { waitUntils.push(p); } };
      const env = Object.assign({ ORIGIN: origin }, extraEnv || {});
      const response = entry ? await entry(request, env, ctx) : await handle(request, env, ctx, { timeoutMs });
      const headers = {};
      response.headers.forEach((v, k) => { if (k !== "set-cookie" && k !== "content-length" && k !== "transfer-encoding") headers[k] = v; });
      const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(response.status, headers);
      if (response.body && req.method !== "HEAD") { for await (const chunk of response.body) res.write(chunk); }
      res.end();
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" }); res.end("emulator: " + e.message);
    }
  });
  return {
    server, waitUntils,
    listen(port = 0) { return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server.address().port))); },
    close() { return new Promise((r) => server.close(() => r())); },
  };
}
