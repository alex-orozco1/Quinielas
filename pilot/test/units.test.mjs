// Pruebas unitarias LOCALES de UX-INFRA-001 (no son H-WAKE, H-IP ni H-TLS).
import test from "node:test";
import assert from "node:assert/strict";
import { isHealthyPayload } from "../edge/waker.mjs";
import { isNavigation, originUrl } from "../edge/worker.mjs";
import { destinationFor, TITLES, tipsFor } from "../edge/copy.mjs";
import { renderLoadingPage } from "../edge/page.mjs";

test("salud: sólo el contrato actual de /api/health cuenta como «listo»", () => {
  const t = new Date().toISOString();
  assert.equal(isHealthyPayload(200, "application/json; charset=utf-8", { ok: true, time: t }), true);
  assert.equal(isHealthyPayload(200, "text/html", { ok: true, time: t }), false, "200 que no es JSON");
  assert.equal(isHealthyPayload(200, "application/json", null), false, "200 sin cuerpo JSON");
  assert.equal(isHealthyPayload(200, "application/json", { ok: "true", time: t }), false, "ok no es true");
  assert.equal(isHealthyPayload(200, "application/json", { ok: true }), false, "sin fecha");
  assert.equal(isHealthyPayload(200, "application/json", { ok: true, time: "ayer" }), false, "fecha inválida");
  assert.equal(isHealthyPayload(502, "application/json", { ok: true, time: t }), false, "no es 200");
  assert.equal(isHealthyPayload(304, "application/json", { ok: true, time: t }), false);
});

test("navegación: sólo GET/HEAD de página; nunca API, webhooks, archivos ni métodos que escriben", () => {
  const nav = (method, path, headers) => isNavigation(new Request("https://qracks.net" + path, { method, headers }));
  const html = { "sec-fetch-mode": "navigate", accept: "text/html" };
  assert.equal(nav("GET", "/q/demo?qz_pago=1", html), true);
  assert.equal(nav("HEAD", "/a/demo", { accept: "text/html" }), true, "sin Sec-Fetch-Mode, por Accept");
  assert.equal(nav("GET", "/", html), true);
  assert.equal(nav("GET", "/crear", html), true);
  assert.equal(nav("GET", "/api/health", html), false, "API");
  assert.equal(nav("GET", "/api", html), false);
  assert.equal(nav("POST", "/api/payments/stripe/webhook", { accept: "*/*" }), false, "webhook");
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(nav(m, "/q/demo", html), false, m);
  assert.equal(nav("GET", "/liguillaScoring.js", html), false, "archivo");
  assert.equal(nav("GET", "/logo.svg", { accept: "image/*" }), false, "archivo");
  assert.equal(nav("GET", "/q/demo", { "sec-fetch-mode": "cors", accept: "text/html" }), false, "fetch() de la app");
  assert.equal(nav("GET", "/q/demo", { accept: "application/json" }), false);
});

test("origen: el emulador sólo cambia el host; ruta, parámetros y fragmento se conservan", () => {
  const u = "https://qracks.net/a/mi-q?qz_pago=pi_1&qz_sess=cs_2&x=%C3%B1#f";
  assert.equal(originUrl(u, {}), u, "en Cloudflare: la misma URL");
  assert.equal(originUrl(u, { ORIGIN: "http://127.0.0.1:9" }), "http://127.0.0.1:9/a/mi-q?qz_pago=pi_1&qz_sess=cs_2&x=%C3%B1#f");
});

test("textos según el destino (sin cookies)", () => {
  assert.equal(destinationFor("/"), "inicio");
  assert.equal(destinationFor("/crear"), "crear");
  assert.equal(destinationFor("/q/abc"), "q");
  assert.equal(destinationFor("/a/abc"), "a");
  assert.equal(destinationFor("/panel-plataforma"), "inicio");
  assert.equal(TITLES.inicio, "Estamos abriendo QRACKS");
  assert.equal(TITLES.crear, "Estamos preparando el formulario para crear tu quiniela");
  assert.equal(TITLES.q, "Estamos abriendo tu quiniela");
  assert.equal(TITLES.a, "Estamos abriendo la administración de tu quiniela");
  assert.equal(tipsFor("q").length, 4);
  assert.equal(tipsFor("inicio").length, 6);
  assert.equal(tipsFor("a").length, 5);
  const all = JSON.stringify([tipsFor("q"), tipsFor("inicio")]);
  assert.ok(!/se guarda|liguilla|premio/i.test(all), "sin guardado confirmado, liguilla ni premios");
});

test("R1 / página: sólo consulta GET /api/health; no hay formularios ni otras peticiones; nada de la URL se imprime", () => {
  const html = renderLoadingPage("https://qracks.net/q/%3Cscript%3Ealert(1)%3C%2Fscript%3E?x=%3Cimg%20src%3Dx%3E&qz_pago=1");
  assert.ok(!/<form/i.test(html), "sin formularios");
  assert.ok(!/<script\s+src|<link\s+rel="stylesheet"|<img/i.test(html), "sin recursos externos");
  assert.ok(!/alert\(1\)|<img src=x>/.test(html), "la URL no se refleja");
  const fetchCalls = html.match(/\bfetch\s*\(/g) || [];
  assert.equal(fetchCalls.length, 1, "un solo fetch en la página");
  assert.ok(html.includes('"healthUrl":"/api/health"'));
  assert.ok(/method: "GET", cache: "no-store"/.test(html), "GET sin caché");
  assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(html));
  assert.ok(!/"method"\s*:\s*"(POST|PUT|PATCH|DELETE)"|method: "(POST|PUT|PATCH|DELETE)"/.test(html));
  assert.ok(html.includes("Esta pantalla no envía ni modifica tus pronósticos."));
  assert.ok(html.includes("Estamos abriendo tu quiniela"));
  assert.ok(html.includes("Volviste de la página de pago"), "aviso de pago con qz_pago");
  assert.ok(!renderLoadingPage("https://qracks.net/q/x?qz_pago=1&qz_pago_cancelado=1").includes("Volviste de la página de pago"));
});
