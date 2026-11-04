// Prueba LOCAL de punta a punta en Chromium: emulador del Worker + servicio mínimo
// dormido en este equipo. Demuestra el comportamiento de la PANTALLA, no H-WAKE.
// Se salta si no hay Playwright disponible.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createWakeService } from "../wake-service/server.mjs";
import { createEmulator } from "../dev/emulator.mjs";

let chromium = null;
try { chromium = createRequire(import.meta.url)("playwright").chromium; } catch (e) { chromium = null; }

test("pantalla en el navegador: misma URL al abrir, sólo GET /api/health sin caché, y nada después", { skip: !chromium && "sin Playwright" }, async () => {
  const svc = createWakeService({ asleep: true });
  const originPort = await svc.listen();
  const emu = createEmulator({ origin: `http://127.0.0.1:${originPort}`, timeoutMs: 500 });
  const port = await emu.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const fromPage = [];
    page.on("request", (r) => { if (r.resourceType() !== "document") fromPage.push({ method: r.method(), url: r.url(), headers: r.headers() }); });
    const target = `http://127.0.0.1:${port}/a/mi-q?qz_pago=pi_1&qz_sess=cs_2#arriba`;
    await page.goto(target);
    assert.equal(await page.locator("h1").textContent(), "Estamos abriendo la administración de tu quiniela");
    assert.ok((await page.locator("body").textContent()).includes("Volviste de la página de pago"));
    assert.ok((await page.locator("body").textContent()).includes("Esta pantalla no envía ni modifica tus pronósticos."));
    await page.waitForTimeout(4500);                       // dos intentos (2 s y 4 s) contra el origen dormido
    assert.ok((await page.locator(".meta").textContent()).includes("Próximo intento en"));
    svc.wake();                                            // el origen «despierta»
    await page.waitForSelector("#app", { timeout: 15000 }); // la app real aparece
    assert.equal(page.url(), target, "misma URL: ruta, parámetros y fragmento");
    const seen = await page.locator("#seen").textContent();
    assert.equal(seen, "/a/mi-q?qz_pago=pi_1&qz_sess=cs_2", "el origen recibió la ruta y los parámetros intactos");
    const health = fromPage.filter((r) => r.url.includes("/api/health"));
    // El 1.er intento (2 s) queda retenido por el origen dormido y, con una sola consulta
    // a la vez, no sale otra hasta que responde o vence su tiempo máximo (8 s).
    assert.equal(health.length, 1, "una sola consulta en curso mientras el origen retiene la respuesta");
    assert.ok(fromPage.every((r) => r.method === "GET" && new URL(r.url).pathname === "/api/health"), "la pantalla no hizo otras peticiones");
    // Sin caché: cada consulta de la página llegó al origen (cache: "no-store" lo fijan las pruebas unitarias).
    assert.equal(svc.requests.filter((r) => r.url.startsWith("/api/health")).length, health.length, "ninguna consulta salió de caché");
    const before = fromPage.length;
    await page.waitForTimeout(3000);
    assert.equal(fromPage.length, before, "al abrir la página ya no se consulta más");
    // Pausa con teclado en «Mientras tanto»: otra pestaña, origen dormido otra vez.
    svc.sleep();
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p2.goto(`http://127.0.0.1:${port}/q/demo`);
    await p2.waitForSelector("#pause", { state: "visible", timeout: 8000 });
    await p2.focus("#pause"); await p2.keyboard.press("Enter");
    assert.equal(await p2.getAttribute("#pause", "aria-pressed"), "true");
    const t1 = await p2.locator(".tip h2").textContent(); await p2.waitForTimeout(8000);
    assert.equal(await p2.locator(".tip h2").textContent(), t1, "en pausa no cambia");
    await p2.keyboard.press("Space");
    assert.equal(await p2.getAttribute("#pause", "aria-pressed"), "false");
    await p2.screenshot({ path: process.env.PILOT_SHOT || "/dev/null" }).catch(() => {});
  } finally {
    await browser.close(); svc.wake(); await emu.close(); await svc.close();
  }
});

test("pantalla en el navegador: /api/health responde pero la página no abre → como mucho 3 recargas y botón", { skip: !chromium && "sin Playwright" }, async () => {
  const svc = createWakeService({ holdPages: true });
  const originPort = await svc.listen();
  const emu = createEmulator({ origin: `http://127.0.0.1:${originPort}`, timeoutMs: 500 });
  const port = await emu.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const docs = [], health = [];
    page.on("request", (r) => {
      if (r.resourceType() === "document") docs.push(r.url());
      else if (r.url().includes("/api/health")) health.push(Date.now());
    });
    const target = `http://127.0.0.1:${port}/q/demo?x=1#f`;
    await page.goto(target);
    await page.waitForSelector("#again", { timeout: 30000 });
    assert.equal(await page.locator("h1").textContent(), "QRACKS ya responde, pero la página no terminó de abrir");
    assert.equal(docs.length, 4, "la carga inicial + 3 recargas automáticas");
    assert.ok(docs.every((u) => u === target.replace("#f", "")), "siempre la misma URL");
    const h = health.length, d = docs.length;
    await page.waitForTimeout(6000);
    assert.equal(health.length, h, "ya no consulta");
    assert.equal(docs.length, d, "ya no recarga sola");
    // Sólo la persona vuelve a intentarlo; ahora la página sí abre.
    svc.holdPages(false);
    await page.click("#again");
    await page.waitForSelector("#app", { timeout: 15000 });
    assert.equal(page.url(), target);
  } finally {
    await browser.close(); svc.holdPages(false); await emu.close(); await svc.close();
  }
});
