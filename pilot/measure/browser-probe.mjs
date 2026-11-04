// UX-INFRA-001 · H-WAKE · Caso en NAVEGADOR REAL (Chromium), en frío, a través del Worker.
//
// probe.mjs mide HTTP: estado, cabeceras y tiempos. NO demuestra que la pantalla
// reabra la app por JavaScript. Este caso sí: abre la URL en Chromium con el origen
// dormido y registra la pantalla, cada consulta a /api/health, las recargas y si la
// app aparece en la MISMA URL (ruta, parámetros y fragmento).
//
//   HWAKE_DIRECT=… HWAKE_WORKER=… node pilot/measure/browser-probe.mjs [--forzar]
// Usa HTTPS_PROXY si existe (sesión en la nube); nunca desactiva la verificación TLS.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { rawRequest } from "./probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN_IDLE_MS = 16 * 60 * 1000;

export async function runBrowserCase({ direct, worker, outDir = path.join(here, "out"), force = false, appTimeoutMs = 180_000, quietMs = 5_000, log = console.log, chromium = null }) {
  chromium = chromium || createRequire(import.meta.url)("playwright").chromium;
  const statePath = path.join(outDir, "estado.json");
  const st = (() => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } })();
  const idle = st.lastRequestAt ? Date.now() - st.lastRequestAt : Infinity;
  if (!force && idle < MIN_IDLE_MS) throw new Error(`sólo ${Math.round(idle / 60000)} min sin peticiones; hacen falta 16 (o --forzar)`);
  const touch = () => { const s = (() => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } })(); s.lastRequestAt = Date.now(); fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); return s; };

  const id = crypto.randomBytes(6).toString("hex");
  const pathQuery = `/a/mi-q?qz_pago=pi_1&qz_sess=cs_2&%C3%B1=1&probe=${id}`;
  const target = `${worker}${pathQuery}#arriba`;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy && worker.startsWith("https:") ? { proxy: { server: proxy } } : {});
  const t0 = Date.now(); const events = []; const out = { mode: "navegador", case: "navegador-worker", probe: id, idleMinBefore: idle === Infinity ? null : Math.round(idle / 60000), target: target.replace(worker, "") };
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("request", (r) => { touch(); events.push({ t: Date.now() - t0, kind: "request", type: r.resourceType(), method: r.method(), url: r.url().replace(worker, "") }); });
    page.on("response", (r) => events.push({ t: Date.now() - t0, kind: "response", type: r.request().resourceType(), status: r.status(), url: r.url().replace(worker, "") }));
    log(`navegador · probe=${id} · ${out.idleMinBefore ?? "sin registro"} min sin peticiones`);
    const first = await page.goto(target, { timeout: 60_000 });
    out.first = { status: first ? first.status() : null, ms: Date.now() - t0, h1: await page.locator("h1").first().textContent().catch(() => null) };
    log(`  primera respuesta ${out.first.status} en ${out.first.ms} ms · «${out.first.h1}»`);
    try { await page.waitForSelector("#app", { timeout: appTimeoutMs }); out.appAfterMs = Date.now() - t0; } catch { out.appAfterMs = null; }
    out.finalUrl = page.url().replace(worker, "");
    out.sameUrl = page.url() === target;
    out.seen = out.appAfterMs ? (await page.locator("#seen").textContent()).replace(/&amp;/g, "&") : null;
    out.originGotSameUrl = out.seen === pathQuery;
    out.finalH1 = await page.locator("h1").first().textContent().catch(() => null);
    const before = events.length; await page.waitForTimeout(quietMs);
    out.requestsAfterApp = events.slice(before).filter((e) => e.kind === "request").length;
    out.documents = events.filter((e) => e.kind === "request" && e.type === "document").length;
    out.healthChecks = events.filter((e) => e.kind === "response" && e.url.startsWith("/api/health")).map((e) => ({ t: e.t, status: e.status }));
    out.otherRequests = events.filter((e) => e.kind === "request" && e.type !== "document" && !e.url.startsWith("/api/health")).map((e) => e.method + " " + e.url);
    out.navigationType = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return n ? n.type : null; }).catch(() => null);
    out.screenshot = path.join(outDir, `navegador-${id}.png`);
    fs.mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: out.screenshot }).catch(() => { out.screenshot = null; });
    out.events = events;
  } finally { await browser.close(); }
  try { const r = await rawRequest(`${direct}/api/pilot-log?probe=${id}`, { headers: { accept: "application/json" }, timeoutMs: 60_000 }); const j = JSON.parse(r.body.toString("utf8")); out.serviceStartedAt = j.startedAt; out.originReceived = j.count; out.coldStartConfirmed = st.serviceStartedAt ? j.startedAt !== st.serviceStartedAt : null; const s = touch(); s.serviceStartedAt = j.startedAt; fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); } catch (e) { out.pilotLogError = String(e.code || e.message); }
  log(`  app ${out.appAfterMs ?? "NO"} ms · misma URL ${out.sameUrl} · el origen recibió la misma ruta ${out.originGotSameUrl} · documentos ${out.documents} · consultas de salud ${out.healthChecks?.length} · después de abrir ${out.requestsAfterApp}`);
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-navegador-worker.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2)); log(`→ ${file}`);
  return { file, data: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const direct = (process.env.HWAKE_DIRECT || "").replace(/\/$/, ""), worker = (process.env.HWAKE_WORKER || "").replace(/\/$/, "");
  if (!direct || !worker) { console.error("Faltan HWAKE_DIRECT o HWAKE_WORKER"); process.exit(2); }
  runBrowserCase({ direct, worker, force: process.argv.includes("--forzar") }).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
