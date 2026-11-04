// Pruebas LOCALES del Worker contra el servicio mínimo en este equipo.
// Simulan el arranque en frío reteniendo las respuestas. NO son H-WAKE: no
// sabemos aún qué devuelve Render de verdad a una subpetición mientras despierta.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { handle } from "../edge/worker.mjs";
import { createWakeService } from "../wake-service/server.mjs";

async function setup({ asleep }) {
  const svc = createWakeService({ asleep });
  const port = await svc.listen();
  const env = { ORIGIN: `http://127.0.0.1:${port}` };
  const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
  return { svc, env, ctx, waits };
}
const NAV = { "sec-fetch-mode": "navigate", accept: "text/html" };

test("origen despierto: la navegación pasa intacta (estado, Set-Cookie, cuerpo, ruta y parámetros)", async () => {
  const { svc, env, ctx, waits } = await setup({ asleep: false });
  try {
    const res = await handle(new Request("https://qracks.net/a/mi-q?qz_pago=pi_1&qz_sess=cs_2&ñ=1", { headers: NAV }), env, ctx, { timeoutMs: 500 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.headers.getSetCookie(), ["pilot_a=1; Path=/; HttpOnly", "pilot_b=2; Path=/"]);
    const body = await res.text();
    assert.ok(body.includes('id="app"'));
    assert.equal(svc.requests.length, 1);
    assert.equal(svc.requests[0].url, "/a/mi-q?qz_pago=pi_1&qz_sess=cs_2&%C3%B1=1");
    assert.equal(waits.length, 0);
  } finally { await svc.close(); }
});

test("origen dormido: la navegación recibe la pantalla (503, no-store) y la petición al origen sigue viva", async () => {
  const { svc, env, ctx, waits } = await setup({ asleep: true });
  try {
    const t0 = Date.now();
    const res = await handle(new Request("https://qracks.net/q/demo?qz_pago=pi_1&qz_sess=cs_2", { headers: NAV }), env, ctx, { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-robots-tag"), "noindex");
    const html = await res.text();
    assert.ok(html.includes("Estamos abriendo tu quiniela"));
    assert.equal(waits.length, 1, "waitUntil mantiene la petición que despierta al origen");
    assert.equal(svc.requests.length, 1);
    assert.equal(svc.requests[0].url, "/q/demo?qz_pago=pi_1&qz_sess=cs_2", "ruta y parámetros intactos");
    svc.wake(); await Promise.all(waits);
    assert.equal(svc.requests.length, 1, "sin reintentos");
  } finally { await svc.close(); }
});

test("HEAD de página dormida: 503 sin cuerpo", async () => {
  const { svc, env, ctx } = await setup({ asleep: true });
  try {
    const res = await handle(new Request("https://qracks.net/crear", { method: "HEAD", headers: NAV }), env, ctx, { timeoutMs: 200 });
    assert.equal(res.status, 503); assert.equal(res.body, null);
  } finally { await svc.close(); }
});

async function passthroughCase(name, request, check) {
  test(`origen dormido: ${name} NO recibe la pantalla, espera al origen y no se reintenta`, async () => {
    const { svc, env, ctx, waits } = await setup({ asleep: true });
    try {
      const p = handle(request(), env, ctx, { timeoutMs: 100 });
      let settled = false; p.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(settled, false, "no responde la pantalla a los 100 ms: espera al origen");
      svc.wake();
      const res = await p;
      assert.notEqual(res.status, 503);
      assert.ok(!(await res.clone().text()).includes("Esta pantalla no envía"));
      assert.equal(svc.requests.length, 1, "una sola petición al origen");
      assert.equal(waits.length, 0);
      await check(res, svc.requests[0]);
    } finally { await svc.close(); }
  });
}

const payload = Buffer.from(JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { x: "ñ".repeat(500) } }));
const sha = crypto.createHash("sha256").update(payload).digest("hex");

passthroughCase("GET /api/health (API)", () => new Request("https://qracks.net/api/health?x=1", { headers: { accept: "application/json" } }), async (res, seen) => {
  assert.equal(res.status, 200); assert.equal((await res.json()).ok, true); assert.equal(seen.url, "/api/health?x=1");
});
passthroughCase("GET /api/health aunque pida HTML", () => new Request("https://qracks.net/api/health", { headers: NAV }), async (res) => {
  assert.equal(res.status, 200);
});
passthroughCase("POST /api/eco (escritura)", () => new Request("https://qracks.net/api/eco?v=2", { method: "POST", headers: { "content-type": "application/json" }, body: payload }), async (res, seen) => {
  const j = await res.json(); assert.equal(j.bytes, payload.length); assert.equal(j.sha256, sha); assert.equal(seen.url, "/api/eco?v=2");
});
passthroughCase("webhook de Stripe (cuerpo crudo y firma)", () => new Request("https://qracks.net/api/payments/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" }, body: payload }), async (res, seen) => {
  const j = await res.json(); assert.equal(j.sha256, sha, "bytes idénticos"); assert.equal(j.signature, "t=1,v1=abc"); assert.equal(seen.headers["stripe-signature"], "t=1,v1=abc");
});
passthroughCase("POST a una ruta de página", () => new Request("https://qracks.net/q/demo", { method: "POST", headers: NAV, body: "a=1" }), async (res) => {
  assert.equal(res.status, 404);
});
passthroughCase("archivo estático", () => new Request("https://qracks.net/files/app.js", { headers: NAV }), async (res) => {
  assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "application/javascript");
});

test("redirección del origen: se entrega tal cual (no se sigue)", async () => {
  const { svc, env, ctx } = await setup({ asleep: false });
  try {
    const res = await handle(new Request("https://qracks.net/redir", { headers: NAV }), env, ctx, { timeoutMs: 500 });
    assert.equal(res.status, 302); assert.equal(res.headers.get("location"), "/q/demo?desde=redir");
  } finally { await svc.close(); }
});

test("origen caído: la API recibe el error una vez (sin reintento ni pantalla); la página recibe la pantalla", async () => {
  const env = { ORIGIN: "http://127.0.0.1:1" }; const waits = []; const ctx = { waitUntil: (p) => waits.push(p) };
  let calls = 0; const counting = (req) => { calls++; return fetch(req); };
  await assert.rejects(handle(new Request("https://qracks.net/api/health"), env, ctx, { fetch: counting }));
  assert.equal(calls, 1);
  const res = await handle(new Request("https://qracks.net/", { headers: NAV }), env, ctx, { fetch: counting, timeoutMs: 500 });
  assert.equal(res.status, 503); assert.ok((await res.text()).includes("Estamos abriendo QRACKS"));
  assert.equal(calls, 2);
});
