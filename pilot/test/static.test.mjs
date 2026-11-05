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

    svc.sleep(); setTimeout(() => svc.wake(), 2500);
    const dh = (await p.tests["dormido-http"](true)).data;
    assert.equal(dh.page.status, 200); assert.ok(dh.page.headersMs < 1000, "la página no espera al servicio"); assert.equal(dh.pass, true);

    svc.sleep(); setTimeout(() => svc.wake(), 1500);
    const dp = (await p.tests["dormido-post"](true)).data; assert.equal(dp.originReceived, 1); assert.equal(dp.pass, true);

    svc.sleep(); setTimeout(() => svc.wake(), 5000);
    const dn = (await p.tests["dormido-navegador"](true, { appTimeoutMs: 30_000, quietMs: 1_500 })).data;
    assert.equal(dn.pass, true, JSON.stringify({ ...dn, healthResponses: undefined }));
    assert.equal(dn.first.paymentNote, "Volviste de la página de pago. Cuando QRACKS abra, verás el estado de tu compra tal como lo registre el sistema.");
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
