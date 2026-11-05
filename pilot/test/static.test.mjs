// Prueba LOCAL de las HERRAMIENTAS del piloto Render Static Site (no es el piloto): el
// sitio generado, el emulador de reescrituras y static-probe.mjs. La IP local sale del
// socket y no hay proxy de Render: lo que importa aquí es que las pruebas funcionan.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "../static-site/build.mjs";
import { createWakeService } from "../wake-service/server.mjs";
import { createStaticEmulator } from "../dev/static-emulator.mjs";
import { createStaticProbe } from "../measure/static-probe.mjs";

let chromium = null; try { chromium = createRequire(import.meta.url)("playwright").chromium; } catch { chromium = null; }

test("sitio estático publicado (pilot/static-site/dist) coincide con el generador", () => {
  for (const [name, html] of Object.entries(build())) assert.equal(fs.readFileSync(new URL(`../static-site/dist/${name}`, import.meta.url), "utf8"), html, `regenerar: node pilot/static-site/build.mjs (${name})`);
});

test("herramientas del piloto estático en local: ip, cuerpo, cookies y casos en frío", { skip: !chromium && "sin Playwright" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-"));
  const svc = createWakeService(); const op = await svc.listen();
  const ss = createStaticEmulator({ dir: new URL("../static-site/dist/", import.meta.url).pathname, origin: `http://127.0.0.1:${op}` }); const sp = await ss.listen();
  const p = createStaticProbe({ staticBase: `http://127.0.0.1:${sp}`, direct: `http://127.0.0.1:${op}`, outDir: dir, log: () => {}, chromium });
  try {
    const ip = (await p.tests.ip()).data; assert.equal(ip.pass, true, JSON.stringify(ip));
    const body = (await p.tests.cuerpo()).data; assert.equal(body.pass, true, JSON.stringify(body.checks.filter((c) => !c.sha_ok || c.receivedTimes !== 1)));
    assert.equal(body.checks.length, 12);
    assert.equal((await p.tests["cookies-http"]()).data.pass, true);
    const cb = (await p.tests["cookies-navegador"]()).data; assert.equal(cb.pass, true, JSON.stringify(cb));

    // --forzar: la propiedad se comprueba, pero un caso forzado NUNCA aprueba como frío.
    svc.sleep(); svc.restart(); setTimeout(() => svc.wake(), 2500);
    const dh = (await p.tests["dormido-http"](true)).data;
    assert.equal(dh.page.status, 200); assert.ok(dh.page.headersMs < 1000, "la página no espera al servicio");
    assert.equal(dh.propertyPass, true); assert.equal(dh.forced, true); assert.equal(dh.cold, false); assert.equal(dh.pass, false);

    svc.sleep(); svc.restart(); setTimeout(() => svc.wake(), 5000);
    const dn = (await p.tests["dormido-navegador"](true, { appTimeoutMs: 30_000, quietMs: 1_500 })).data;
    assert.equal(dn.propertyPass, true, JSON.stringify({ ...dn, healthResponses: undefined })); assert.equal(dn.pass, false, "forzado");
    assert.equal(dn.first.paymentNote, "Volviste de la página de pago. Cuando QRACKS abra, verás el estado de tu compra tal como lo registre el sistema.");

    // Frío de verdad (simulado): ≥ 16 min sin peticiones según el registro, sin --forzar, y proceso nuevo.
    const st = JSON.parse(fs.readFileSync(path.join(dir, "estado.json"), "utf8")); st.lastRequestAt = Date.now() - 17 * 60 * 1000;
    fs.writeFileSync(path.join(dir, "estado.json"), JSON.stringify(st));
    svc.sleep(); svc.restart(); setTimeout(() => svc.wake(), 1500);
    const dp = (await p.tests["dormido-post"](false)).data;
    assert.equal(dp.originReceived, 1); assert.equal(dp.startedAtChanged, true); assert.equal(dp.idleConfirmed, true); assert.equal(dp.cold, true); assert.equal(dp.pass, true);
    await assert.rejects(p.tests["dormido-http"](false), /hacen falta 16/);
  } finally { svc.wake(); await ss.close(); await svc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("R1 en la página estática: sólo GET /api/health y una GET de continuación; sin formularios ni otras escrituras", () => {
  const html = build()["index.html"];
  assert.equal((html.match(/\bfetch\s*\(/g) || []).length, 2, "health + continuación");
  assert.ok(/method: "GET", cache: "no-store"/.test(html));
  assert.ok(/fetch\(CFG\.continueUrl \+ "\?path=" \+ encodeURIComponent\(location\.pathname \+ location\.search\), \{ method: "GET"/.test(html));
  assert.ok(!/<form|XMLHttpRequest|sendBeacon|WebSocket|EventSource|document\.cookie|localStorage/.test(html));
  assert.ok(!/location\.reload\(\)/.test(html.split("function continueApp")[1].split("document.addEventListener")[0]), "la continuación no recarga");
  assert.ok(html.includes("Esta pantalla no envía ni modifica tus pronósticos."));
});

// ── Regresiones negativas (falso positivo reproducido por GPT en 0520f3f) ─────────
// Un servicio falso: /api/health responde bien; lo demás según `mode`. Lo ausente o
// inconcluso nunca puede aprobar.
import http from "node:http";
function fakeService(mode) {
  const startedAt = new Date().toISOString();
  const send = (res, status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  const html503 = (res) => send(res, 503, "text/html; charset=utf-8", "<!doctype html><title>Service Unavailable</title><h1>503</h1>");
  const server = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/api/health") return send(res, 200, "application/json", { ok: true, time: new Date().toISOString() });
      if (u.pathname === "/api/client-ip") {
        if (mode.ip === "html503") return html503(res);
        if (mode.ip === "empty") return send(res, 200, "application/json", {});
        if (mode.ip === "unknown") return send(res, 200, "application/json", { decided: { ip: "unknown", via: "unknown" } });
        if (mode.ip === "garbage") return send(res, 200, "application/json", { decided: { ip: "no-es-ip", via: "socket" } });
        if (mode.ip === "text200") return send(res, 200, "text/plain", JSON.stringify({ decided: { ip: "198.51.100.1", via: "socket" } }));
      }
      if (u.pathname === "/api/pilot-log") {
        const id = u.searchParams.get("probe");
        if (mode.log === "html503") return html503(res);
        if (mode.log === "nullcount") return send(res, 200, "application/json", { probe: id, startedAt, count: null, requests: [] });
        if (mode.log === "stringcount") return send(res, 200, "application/json", { probe: id, startedAt, count: "1", requests: [{}] });
        if (mode.log === "mismatch") return send(res, 200, "application/json", { probe: id, startedAt, count: 1, requests: [] });
        if (mode.log === "nostart") return send(res, 200, "application/json", { probe: id, count: 0, requests: [] });
        if (mode.log === "otherprobe") return send(res, 200, "application/json", { probe: "otro", startedAt, count: 0, requests: [] });
      }
      if (u.pathname === "/api/pilot-cookie/set" || u.pathname === "/api/pilot-cookie/echo") return send(res, 200, "application/json", {});
      if (u.pathname.startsWith("/api/")) return html503(res);
      return send(res, 200, "text/html; charset=utf-8", "<!doctype html><h1>x</h1>");
    });
  });
  return { listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))), close: () => new Promise((r) => server.close(() => r())) };
}
async function withFake(mode, fn) {
  const f = fakeService(mode); const port = await f.listen(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-neg-"));
  const base = `http://127.0.0.1:${port}`;
  try { return await fn(createStaticProbe({ staticBase: base, direct: base, outDir: dir, log: () => {} }), dir); } finally { await f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const idle17 = (dir) => fs.writeFileSync(path.join(dir, "estado.json"), JSON.stringify({ lastRequestAt: Date.now() - 17 * 60 * 1000, serviceStartedAt: "2000-01-01T00:00:00.000Z" }));

test("negativa (GPT): HTML 503 en client-ip y en el registro → ip y dormido-post NO pasan", async () => {
  await withFake({ ip: "html503", log: "html503" }, async (p, dir) => {
    const ip = (await p.tests.ip()).data;
    assert.equal(ip.pass, false); assert.equal(ip.allValid, false);
    idle17(dir);   // aunque la inactividad cuadre, sin registro válido no hay frío ni conteo
    const post = (await p.tests["dormido-post"](false)).data;
    assert.equal(post.logValid, false); assert.equal(post.originReceived, null);
    assert.equal(post.propertyPass, false); assert.equal(post.cold, false); assert.equal(post.pass, false);
  });
});

for (const ipMode of ["empty", "unknown", "garbage", "text200"]) {
  test(`negativa: client-ip ${ipMode} → ip NO pasa`, async () => {
    await withFake({ ip: ipMode, log: "html503" }, async (p) => { const d = (await p.tests.ip()).data; assert.equal(d.pass, false); assert.equal(d.allValid, false); });
  });
}

for (const logMode of ["nullcount", "stringcount", "mismatch", "nostart", "otherprobe"]) {
  test(`negativa: registro ${logMode} → dormido-post, dormido-http y cuerpo NO pasan`, async () => {
    await withFake({ ip: "html503", log: logMode }, async (p, dir) => {
      idle17(dir); const post = (await p.tests["dormido-post"](false)).data;
      assert.equal(post.logValid, false); assert.equal(post.pass, false); assert.equal(post.propertyPass, false);
      idle17(dir); const dh = (await p.tests["dormido-http"](false)).data;
      assert.equal(dh.logValid, false); assert.equal(dh.pass, false);
      const body = (await p.tests.cuerpo()).data; assert.equal(body.pass, false); assert.equal(body.logValid, false);
    });
  });
}

test("negativa: cookies con JSON vacío y sin Set-Cookie → cookies-http NO pasa", async () => {
  await withFake({ ip: "html503", log: "html503" }, async (p) => { const d = (await p.tests["cookies-http"]()).data; assert.equal(d.tokenValid, false); assert.equal(d.pass, false); });
});
