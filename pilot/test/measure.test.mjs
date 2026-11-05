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

// ── Cloudflare simulado (sin red): protecciones de cloudflare.mjs ──────────────────
// API falsa: guarda cada llamada y responde según el estado de la «cuenta».
function fakeCloudflare({ existing = [], list = "ok" } = {}) {
  const workers = new Set(existing); const calls = [];
  const res = (status, j) => ({ status, body: Buffer.from(JSON.stringify(j)) });
  const request = async (url, init) => {
    const p = url.replace("https://api.cloudflare.com/client/v4", ""); calls.push({ method: init.method, path: p, headers: init.headers });
    const m = /^\/accounts\/acc\/workers\/scripts(?:\/([^/]+))?(\/subdomain)?$/.exec(p);
    if (!m) return res(404, { success: false, errors: [{ message: "ruta" }] });
    if (init.method === "GET" && !m[1]) {
      if (list === "error") return res(500, { success: false, errors: [{ code: 10000, message: "fallo" }] });
      if (list === "throw") throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      if (list === "notjson") return { status: 200, body: Buffer.from("<html>") };
      if (list === "noarray") return res(200, { success: true, result: null });
      if (list === "paged") return res(200, { success: true, result: [], result_info: { total_count: 5 } });
      return res(200, { success: true, result: [...workers].map((id) => ({ id })) });
    }
    if (init.method === "PUT" && m[1] && !m[2]) { workers.add(m[1]); return res(200, { success: true, result: { id: m[1] } }); }
    if (init.method === "POST" && m[2]) return res(200, { success: true, result: { enabled: true } });
    if (init.method === "DELETE" && m[1]) { workers.delete(m[1]); return res(200, { success: true, result: null }); }
    return res(400, { success: false, errors: [{ message: "no esperado" }] });
  };
  return { workers, calls, request, writes: () => calls.filter((c) => c.method !== "GET").map((c) => c.method + " " + c.path) };
}
async function cfWith(fake) {
  const { createCloudflare } = await import("../measure/cloudflare.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hwake-cf-"));
  return { dir, cf: createCloudflare({ accountId: "acc", outDir: dir, log: () => {}, request: fake.request }) };
}
const ORIGIN = "https://qracks-hwake-pilot.onrender.com";

test("Cloudflare: un Worker PREEXISTENTE con el mismo nombre no recibe PUT ni DELETE", async () => {
  const fake = fakeCloudflare({ existing: ["qracks-hwake-pilot", "otro-worker"] });
  const { dir, cf } = await cfWith(fake);
  try {
    await assert.rejects(cf.deploy(ORIGIN), /ya existe un Worker «qracks-hwake-pilot»/);
    const r = await cf.remove();
    assert.equal(r.deleted, 0);
    assert.deepEqual(fake.writes(), [], "ninguna escritura: ni PUT, ni POST, ni DELETE");
    assert.deepEqual([...fake.workers].sort(), ["otro-worker", "qracks-hwake-pilot"], "la cuenta queda igual");
    assert.ok(!fs.existsSync(path.join(dir, "recursos.json")), "no se registra lo que no se creó");
    assert.equal((await cf.status()).registered, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ["error", "throw", "notjson", "noarray", "paged"]) {
  test(`Cloudflare: si la consulta de existencia es inconclusa (${mode}), se detiene sin escribir`, async () => {
    const fake = fakeCloudflare({ list: mode });
    const { dir, cf } = await cfWith(fake);
    try {
      await assert.rejects(cf.deploy(ORIGIN), /detenido sin cambios: no pude confirmar/);
      assert.deepEqual(fake.writes(), []);
      assert.ok(!fs.existsSync(path.join(dir, "pilot-token")), "ni siquiera genera el token del piloto");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("Cloudflare: crea sólo si no existe, lo registra y el apagado borra sólo lo registrado", async () => {
  const fake = fakeCloudflare({ existing: ["otro-worker"] });
  const { dir, cf } = await cfWith(fake);
  try {
    await cf.deploy(ORIGIN);
    assert.deepEqual(fake.writes(), ["PUT /accounts/acc/workers/scripts/qracks-hwake-pilot", "POST /accounts/acc/workers/scripts/qracks-hwake-pilot/subdomain"]);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "recursos.json"), "utf8")).resources;
    assert.deepEqual(reg.map((r) => [r.kind, r.id, r.scope, r.state]), [["cloudflare-worker", "qracks-hwake-pilot", "acc", "creado"]]);
    assert.deepEqual(reg[0].history.map((h) => h.state), ["creando", "creado"], "se registró ANTES de crearlo");
    await assert.rejects(cf.deploy(ORIGIN), /ya existe/, "un segundo despliegue tampoco sobrescribe");
    const r = await cf.remove();
    assert.equal(r.deleted, 1);
    assert.deepEqual(fake.writes().filter((w) => w.startsWith("DELETE")), ["DELETE /accounts/acc/workers/scripts/qracks-hwake-pilot"]);
    assert.deepEqual([...fake.workers], ["otro-worker"], "el otro Worker sigue ahí");
    assert.equal((await cf.remove()).deleted, 0, "apagar dos veces no vuelve a borrar");
    assert.ok(fake.calls.every((c) => !Object.keys(c.headers).some((h) => h.toLowerCase() === "authorization")), "el token lo añade el proxy");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Cloudflare: si el Worker registrado ya no existe al apagar, no se envía DELETE", async () => {
  const fake = fakeCloudflare();
  const { dir, cf } = await cfWith(fake);
  try {
    await cf.deploy(ORIGIN); fake.workers.clear();
    assert.equal((await cf.remove()).deleted, 0);
    assert.ok(!fake.writes().some((w) => w.startsWith("DELETE")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Cloudflare: la subida lleva el bundle y las dos variables; nunca qracks.net como origen", async () => {
  const { buildUpload } = await import("../measure/cloudflare.mjs");
  const up = buildUpload({ code: "export default {}", origin: ORIGIN, pilotToken: "p" });
  assert.equal(up.metadata.main_module, "worker.mjs");
  assert.deepEqual(up.metadata.bindings.map((b) => [b.type, b.name]), [["plain_text", "ORIGIN"], ["secret_text", "PILOT_TOKEN"]]);
  assert.throws(() => buildUpload({ code: "", origin: "https://qracks.net", pilotToken: "p" }), /onrender\.com/);
});
