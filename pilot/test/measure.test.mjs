// Prueba LOCAL de las HERRAMIENTAS de medición H-WAKE (no es H-WAKE): el bundle de un
// solo archivo funciona como Worker, el endpoint de medición exige token, y probe.mjs
// registra estado, tiempos, URL y conteo en el origen. Origen y «Worker» son locales.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundle } from "../dev/bundle.mjs";
import { createWakeService } from "../wake-service/server.mjs";
import { createEmulator } from "../dev/emulator.mjs";
import { createProbe } from "../measure/probe.mjs";

test("herramientas H-WAKE en local: bundle, endpoint con token, matriz despierta y casos en frío", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hwake-"));
  const file = path.join(dir, "worker.mjs"); fs.writeFileSync(file, bundle());
  const W = (await import(file)).default;
  const svc = createWakeService(); const op = await svc.listen();
  const emu = createEmulator({ origin: `http://127.0.0.1:${op}`, entry: (r, env, ctx) => W.fetch(r, env, ctx), env: { PILOT_TOKEN: "tok-local" } });
  const ep = await emu.listen();
  const base = `http://127.0.0.1:${ep}`;
  try {
    assert.equal((await fetch(`${base}/__pilot/probe?path=/`)).status, 404, "sin token: 404");
    assert.equal((await fetch(`${base}/__pilot/probe?path=//evil.example/`, { headers: { "x-pilot-token": "tok-local" } })).status, 400);
    const p = createProbe({ direct: `http://127.0.0.1:${op}`, worker: base, token: "tok-local", outDir: path.join(dir, "out"), log: () => {} });

    const { data: a } = await p.awake({ reps: 1 });
    const run = a.runs[0];
    assert.equal(run.postsOnce, true, "cada POST llegó una sola vez");
    assert.ok(run.items.filter((x) => x.urlPreserved !== undefined).every((x) => x.urlPreserved), "URL intacta, directo y por Worker");
    assert.ok(run.items.filter((x) => x.shaMatches !== undefined).every((x) => x.shaMatches), "cuerpos idénticos");
    assert.equal(run.subNav.json.status, 200); assert.ok(run.subNav.json.headersMs >= 0);
    assert.ok(!JSON.stringify(a).includes("tok-local"), "el token no se guarda");

    svc.sleep(); setTimeout(() => svc.wake(), 1000);
    const { data: post } = await p.cold("worker-post", { force: true });
    assert.equal(post.exactlyOnce, true); assert.equal(post.first.shaMatches, true); assert.ok(post.wake.awakeAfterMs !== null);

    svc.sleep(); setTimeout(() => svc.wake(), 4500);
    const { data: nav } = await p.cold("worker-nav", { force: true });
    assert.equal(nav.first.status, 503); assert.equal(nav.first.isLoadingPage, true);
    assert.equal(nav.urlPreserved, true, "tras despertar, la misma URL llega al origen: ");

    await assert.rejects(p.cold("worker-head"), /hacen falta 16/, "sin --forzar exige 16 min sin peticiones");
    assert.ok(p.summary() >= 3);
  } finally { svc.wake(); await emu.close(); await svc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("el bundle publicado (pilot/measure/dist/worker.mjs) coincide con el código fuente", () => {
  const dist = fs.readFileSync(new URL("../measure/dist/worker.mjs", import.meta.url), "utf8");
  assert.equal(dist, bundle(), "regenerar con: node pilot/dev/bundle.mjs");
});

test("caso en navegador (local): con el origen dormido, la pantalla reabre la app por JavaScript en la misma URL", async (t) => {
  let chromium = null; try { chromium = (await import("node:module")).createRequire(import.meta.url)("playwright").chromium; } catch { return t.skip("sin Playwright"); }
  const { runBrowserCase } = await import("../measure/browser-probe.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hwake-b-"));
  const svc = createWakeService({ asleep: true }); const op = await svc.listen();
  const emu = createEmulator({ origin: `http://127.0.0.1:${op}`, timeoutMs: 500 }); const ep = await emu.listen();
  try {
    setTimeout(() => svc.wake(), 5000);
    const { data } = await runBrowserCase({ direct: `http://127.0.0.1:${op}`, worker: `http://127.0.0.1:${ep}`, outDir: dir, force: true, appTimeoutMs: 30_000, quietMs: 2_000, log: () => {}, chromium });
    assert.equal(data.first.status, 503); assert.equal(data.first.h1, "Estamos abriendo la administración de tu quiniela");
    assert.ok(data.appAfterMs > 0, "la app apareció"); assert.equal(data.sameUrl, true); assert.equal(data.originGotSameUrl, true);
    assert.equal(data.requestsAfterApp, 0); assert.deepEqual(data.otherRequests, []);
    assert.equal(data.navigationType, "reload", "la abrió la recarga por JavaScript");
  } finally { svc.wake(); await emu.close(); await svc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Cloudflare (simulado, sin red): la subida lleva el bundle y las dos variables; nunca Authorization", async () => {
  const { buildUpload, createCloudflare } = await import("../measure/cloudflare.mjs");
  const up = buildUpload({ code: "export default {}", origin: "https://qracks-hwake-pilot.onrender.com", pilotToken: "p" });
  assert.equal(up.metadata.main_module, "worker.mjs");
  assert.deepEqual(up.metadata.bindings.map((b) => [b.type, b.name]), [["plain_text", "ORIGIN"], ["secret_text", "PILOT_TOKEN"]]);
  assert.ok(up.body.toString().includes('filename="worker.mjs"'));
  assert.throws(() => buildUpload({ code: "", origin: "https://qracks.net", pilotToken: "p" }), /onrender\.com/, "nunca qracks.net como origen");
  const sent = [];
  const cf = createCloudflare({ accountId: "acc", log: () => {}, request: async (url, init) => { sent.push({ url, init }); return { status: 200, body: Buffer.from(JSON.stringify({ success: true, result: [] })) }; } });
  await cf.status(); await cf.remove();
  assert.deepEqual(sent.map((s) => s.init.method + " " + s.url.replace("https://api.cloudflare.com/client/v4", "")), ["GET /accounts/acc/workers/scripts", "DELETE /accounts/acc/workers/scripts/qracks-hwake-pilot"]);
  assert.ok(sent.every((s) => !Object.keys(s.init.headers).some((h) => h.toLowerCase() === "authorization")), "el token lo añade el proxy");
});
