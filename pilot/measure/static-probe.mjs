// UX-INFRA-001 · Alternativa Render Static Site · pruebas del piloto aislado.
//
//   SS_STATIC=https://<sitio>.onrender.com SS_DIRECT=https://<servicio>.onrender.com \
//   node pilot/measure/static-probe.mjs <prueba> [--forzar]
//
// Pruebas (cada una responde a UNA pregunta del piloto):
//   ip                 1. IP decidida por la app (clientIp.js) por el sitio estático = directa, y
//                         cabeceras falsificadas (CF-Connecting-IP, X-Forwarded-For, …) sin efecto
//   cuerpo             3. POST/PUT/PATCH/DELETE y webhook simulado: método, query, tipo, bytes,
//                         sha256 y firma de prueba intactos; cada petición llega UNA vez
//   cookies-http       2. Set-Cookie (dos, con los atributos de la sesión) pasa la reescritura
//   cookies-navegador  2. en Chromium: HttpOnly invisible a JS, se envía, sobrevive a recargar, se borra
//   dormido-http       4. (en frío) la página estática responde sin esperar al servicio; qué devuelve
//                         la reescritura de /api con el servicio dormido; una petición no se duplica
//   dormido-post       3+4. (en frío) un POST con el servicio dormido llega como mucho una vez e intacto
//   dormido-navegador  4. (en frío) Chromium: pantalla al instante y continuación SIN recarga, misma URL
//   resumen
// Usa HTTPS_PROXY si existe; nunca desactiva TLS. Sin Stripe real: la firma es un valor fijo de prueba.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { rawRequest } from "./probe.mjs";
import { isHealthyPayload } from "../edge/waker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN_IDLE_MS = 16 * 60 * 1000;
export const SPOOF = { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.8", "true-client-ip": "203.0.113.9", "x-real-ip": "203.0.113.10", forwarded: "for=203.0.113.11" };
const SIGNATURE = "t=1,v1=piloto-sin-secreto";
const NAV = { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 (qracks-static-probe)" };
const JSONH = { accept: "application/json", "user-agent": "qracks-static-probe" };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const payload = (kb) => Buffer.from(JSON.stringify({ id: "evt_piloto", type: "pilot.eco", data: { x: "ñ".repeat(Math.max(1, Math.floor((kb * 1024) / 2))) } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Validación: lo ausente, mal formado o inconcluso NUNCA aprueba ─────────────
const isJsonResp = (r) => Boolean(r && r.status === 200 && /^application\/json\b/i.test(String(r.headers && r.headers["content-type"] || "")) && r.json && typeof r.json === "object");
// Query: compara parámetros, valores y multiplicidad. «identica» (mismo texto), «reordenada»
// (mismos pares nombre=valor con la misma multiplicidad, otro orden) o «cambiada» (falta,
// sobra o cambia algún par). Sólo «cambiada» es pérdida o cambio de datos.
export function compareQuery(sent, received) {
  if (typeof received !== "string") return { verdict: "cambiada", reason: "sin query recibida" };
  if (sent === received) return { verdict: "identica" };
  const pairs = (q) => [...new URLSearchParams(q)].map(([k, v]) => JSON.stringify([k, v]));
  const count = (list) => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const a = count(pairs(sent)), b = count(pairs(received));
  const missing = [...a].filter(([k, n]) => (b.get(k) || 0) < n).map(([k]) => JSON.parse(k));
  const extra = [...b].filter(([k, n]) => (a.get(k) || 0) < n).map(([k]) => JSON.parse(k));
  return missing.length || extra.length ? { verdict: "cambiada", missing, extra } : { verdict: "reordenada" };
}

// Una clave de IP como la de clientIp.js: IPv4, o el /64 de una IPv6 ("a:b:c:d::/64").
export function isValidIpKey(ip) {
  if (typeof ip !== "string" || !ip || ip === "unknown") return false;
  return net.isIP(ip) === 4 || /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::\/64$/.test(ip);
}
const VIA = new Set(["cf-connecting-ip", "xff-3rd-from-right", "socket"]);
// Respuesta de /api/client-ip válida: 200, JSON, decided.ip válida y una regla conocida.
export function validClientIp(r) {
  return isJsonResp(r) && r.json.decided && isValidIpKey(r.json.decided.ip) && (VIA.has(r.json.decided.via) || /^xff-\d+-from-right$/.test(r.json.decided.via)) ? r.json.decided : null;
}
// Registro de /api/pilot-log válido para ESTE probe: 200, JSON, count entero = requests.length y startedAt fecha.
export function validPilotLog(r, id) {
  if (!isJsonResp(r)) return null;
  const j = r.json;
  if (j.probe !== id || !Number.isInteger(j.count) || j.count < 0 || !Array.isArray(j.requests) || j.requests.length !== j.count) return null;
  if (typeof j.startedAt !== "string" || !Number.isFinite(Date.parse(j.startedAt))) return null;
  return j;
}

export function createStaticProbe({ staticBase, direct, outDir = path.join(here, "out", "static"), log = console.log, chromium = null }) {
  const statePath = path.join(outDir, "estado.json");
  const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } };
  const writeState = (s) => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); };
  const touch = () => { const s = readState(); s.lastRequestAt = Date.now(); writeState(s); };

  async function req(label, url, init = {}) {
    const rec = { label, method: init.method || "GET", url: url.replace(/^https?:\/\/[^/]+/, ""), host: new URL(url).host, at: new Date().toISOString() }; touch();
    try {
      const r = await rawRequest(url, init);
      const { "set-cookie": sc, ...rest } = r.headers;
      Object.assign(rec, { status: r.status, headersMs: r.headersMs, totalMs: r.totalMs, headers: rest, setCookie: sc || [], bytes: r.body.length, bodyStart: r.body.subarray(0, 600).toString("utf8") });
      try { rec.json = JSON.parse(r.body.toString("utf8")); } catch { /* no es JSON */ }
      const h1 = /<h1[^>]*>([^<]*)<\/h1>/.exec(r.body.toString("utf8")); rec.h1 = h1 ? h1[1] : null;
    } catch (e) { rec.error = String(e.code || e.message); }
    log(`  ${label.padEnd(34)} ${String(rec.status ?? rec.error).padEnd(10)} ${String(rec.headersMs ?? "-").padStart(6)} ms`);
    return rec;
  }
  const healthy = (r) => isHealthyPayload(r.status, r.headers && r.headers["content-type"], r.json);
  async function untilAwake(base, maxMs = 180_000) {
    const t0 = Date.now(), tries = [];
    while (Date.now() - t0 < maxMs) {
      const r = await req("salud (espera)", `${base}/api/health`, { headers: JSONH, timeoutMs: 60_000 });
      tries.push({ t: Date.now() - t0, status: r.status, error: r.error, contentType: r.headers && r.headers["content-type"], headersMs: r.headersMs, healthy: healthy(r), bodyStart: healthy(r) ? undefined : (r.bodyStart || "").slice(0, 200) });
      if (healthy(r)) return { awakeAfterMs: Date.now() - t0, tries };
      await sleep(2000);
    }
    return { awakeAfterMs: null, tries };
  }
  const pilotLog = async (id) => validPilotLog(await req(`registro ${id}`, `${direct}/api/pilot-log?probe=${id}`, { headers: JSONH }), id);
  // Línea base del proceso actual (antes de dejarlo dormir): sin ella, ningún caso en frío aprueba.
  async function baseline() { const lg = await pilotLog("base"); if (lg) { const s = readState(); s.serviceStartedAt = lg.startedAt; writeState(s); } return lg; }
  function coldGate(force) {
    const st = readState(); const idle = st.lastRequestAt ? Date.now() - st.lastRequestAt : Infinity;
    if (!force && idle < MIN_IDLE_MS) throw new Error(`sólo ${Math.round(idle / 60000)} min sin peticiones; hacen falta 16 (o --forzar)`);
    return { st, idleMin: idle === Infinity ? null : Math.round(idle / 60000), idleConfirmed: idle !== Infinity && idle >= MIN_IDLE_MS, forced: Boolean(force) };
  }
  // Frío confirmado = (a) ≥ 16 min sin peticiones, sin --forzar, y (b) startedAt nuevo respecto
  // a una línea base válida. La tercera señal (logs de Render) la revisa Claude con list_logs.
  async function confirmCold(gate, out) {
    const lg = await pilotLog("frio");
    out.serviceStartedAt = lg ? lg.startedAt : null;
    out.previousStartedAt = gate.st.serviceStartedAt || null;
    out.startedAtChanged = Boolean(lg && gate.st.serviceStartedAt && lg.startedAt !== gate.st.serviceStartedAt);
    out.idleConfirmed = gate.idleConfirmed; out.forced = gate.forced;
    out.cold = Boolean(out.startedAtChanged && gate.idleConfirmed && !gate.forced);
    out.renderLogs = "pendiente: Claude cruza startedAt con list_logs [Render API]";
    const s = readState(); if (lg) s.serviceStartedAt = lg.startedAt; writeState(s);
  }
  function save(name, data) {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2)); log(`→ ${file} · ${data.pass === true ? "PASA" : data.pass === false ? "FALLA" : "observación"}`); return { file, data };
  }
  async function browser() {
    chromium = chromium || createRequire(import.meta.url)("playwright").chromium;
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    return chromium.launch(proxy && staticBase.startsWith("https:") ? { proxy: { server: proxy } } : {});
  }

  const tests = {
    async ip() {
      await untilAwake(direct); await baseline();
      const raw = {};
      for (const [who, base] of [["estatico", staticBase], ["directo", direct]]) {
        raw[who] = await req(`${who} client-ip`, `${base}/api/client-ip`, { headers: JSONH });
        raw[who + "Falsificado"] = await req(`${who} client-ip falsificado`, `${base}/api/client-ip`, { headers: { ...JSONH, ...SPOOF } });
      }
      const d = Object.fromEntries(Object.entries(raw).map(([k, r]) => [k, validClientIp(r)]));
      const out = { test: "ip", responses: Object.fromEntries(Object.entries(raw).map(([k, r]) => [k, { status: r.status, contentType: r.headers && r.headers["content-type"], json: r.json || null, error: r.error }])), decided: d };
      out.allValid = Object.values(d).every(Boolean);
      const forged = (ip) => /^203\.0\.113\./.test(ip);
      out.sameAsDirect = out.allValid && d.estatico.ip === d.directo.ip;
      out.spoofIgnored = out.allValid && [d.estaticoFalsificado, d.directoFalsificado].every((x) => !forged(x.ip) && x.ip === d.directo.ip);
      out.pass = Boolean(out.allValid && out.sameAsDirect && out.spoofIgnored);
      out.note = "Una sola red de origen (la de esta sesión). «Por visitante» exige además M3: «Coinciden» en dos redes y una clave de visitante distinta entre ellas.";
      return save("ip", out);
    },
    async cuerpo() {
      await untilAwake(direct); await baseline(); const id = crypto.randomBytes(6).toString("hex"); const checks = [];
      const cases = [
        ["POST", "/api/eco", payload(20), "application/json; charset=utf-8", {}],
        ["PUT", "/api/eco", payload(20), "application/json", {}],
        ["PATCH", "/api/eco", payload(2), "text/plain; charset=utf-8", {}],
        ["DELETE", "/api/eco", payload(1), "application/json", {}],
        ["POST", "/api/eco", payload(900), "application/json", {}],
        ["POST", "/api/payments/stripe/webhook", payload(20), "application/json; charset=utf-8", { "stripe-signature": SIGNATURE }],
      ];
      for (const [base, via] of [[staticBase, "estatico"], [direct, "directo"]]) {
        for (const [n, [method, p, body, ct, extra]] of cases.entries()) {
          const q = `?probe=${id}&via=${via}&n=${n}&%C3%B1=1`;
          const r = await req(`${via} ${method} ${p} ${Math.round(body.length / 1024)} KB`, base + p + q, { method, body, headers: { ...JSONH, "content-type": ct, ...extra } });
          const ok = isJsonResp(r); const j = ok ? r.json : {};
          checks.push({ via, n, method, path: p, kb: Math.round(body.length / 1024), status: r.status, validResponse: ok,
            method_ok: ok && j.method === method, path_ok: ok && j.path === p, query: ok ? compareQuery(q, j.query) : { verdict: "cambiada", reason: "respuesta no válida" }, contentType_ok: ok && j.contentType === ct,
            bytes_ok: ok && j.bytes === body.length, sha_ok: ok && j.sha256 === sha(body),
            signature_ok: ok && (extra["stripe-signature"] ? j.signature === SIGNATURE : j.signature === null), expectSha: sha(body) });
        }
      }
      const lg = await pilotLog(id);
      for (const c of checks) {
        c.query_ok = c.query.verdict !== "cambiada";
        const recs = lg ? lg.requests.filter((q) => { const k = new URL(q.url, "http://x").searchParams; return k.get("via") === c.via && k.get("n") === String(c.n); }) : null;
        c.receivedTimes = recs ? recs.length : null;   // null = sin registro válido: nunca aprueba
        c.originIntact = Boolean(recs && recs.length === 1 && recs[0].method === c.method && recs[0].sha256 === c.expectSha);
      }
      const pass = Boolean(lg) && checks.every((c) => c.status === 200 && c.validResponse && c.method_ok && c.path_ok && c.query_ok && c.contentType_ok && c.bytes_ok && c.sha_ok && c.signature_ok && c.receivedTimes === 1 && c.originIntact);
      const queryVerdicts = checks.reduce((m, c) => { m[c.via + ":" + c.query.verdict] = (m[c.via + ":" + c.query.verdict] || 0) + 1; return m; }, {});
      return save("cuerpo", { test: "cuerpo", probe: id, logValid: Boolean(lg), queryVerdicts, checks, pass });
    },
    async "cookies-http"() {
      await untilAwake(direct);
      const set = await req("estatico POST cookie/set", `${staticBase}/api/pilot-cookie/set`, { method: "POST", headers: JSONH });
      const token = isJsonResp(set) && /^[0-9a-f]{24}$/.test(String(set.json.token)) ? set.json.token : null;
      const sc = set.setCookie || [];
      const attrs = (c) => ({ name: c.split("=")[0], httpOnly: /;\s*HttpOnly/i.test(c), secure: /;\s*Secure/i.test(c), lax: /;\s*SameSite=Lax/i.test(c), path: /;\s*Path=\//i.test(c), maxAge: /;\s*Max-Age=31536000/i.test(c), domain: /;\s*Domain=/i.test(c) });
      const cookieHeader = sc.map((c) => c.split(";")[0]).join("; ");
      const echo = await req("estatico GET cookie/echo", `${staticBase}/api/pilot-cookie/echo`, { headers: { ...JSONH, cookie: cookieHeader } });
      const a = sc.map(attrs); const sess = a.find((x) => x.name === "qracks_session_piloto"); const vis = a.find((x) => x.name === "qz_piloto_visible");
      const out = { test: "cookies-http", status: set.status, tokenValid: Boolean(token), setCookieCount: sc.length, attributes: a, echo: isJsonResp(echo) ? echo.json : null };
      out.pass = Boolean(token && sc.length === 2 && sess && vis && sess.httpOnly && !vis.httpOnly && a.every((x) => x.secure && x.lax && x.path && x.maxAge && !x.domain)
        && out.echo && out.echo.session === token && out.echo.visible === "1");
      return save("cookies-http", out);
    },
    async "cookies-navegador"() {
      await untilAwake(direct);
      const b = await browser(); const out = { test: "cookies-navegador" };
      try {
        const ctx = await b.newContext(); const page = await ctx.newPage();
        out.pageStatus = (await page.goto(`${staticBase}/q/demo`)).status();
        const call = (u, m) => page.evaluate(([u, m]) => fetch(u, { method: m, credentials: "same-origin", cache: "no-store" })
          .then((r) => r.text().then((t) => { let j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, type: r.headers.get("content-type"), json: j }; })), [u, m]);
        const ok = (x) => x && x.status === 200 && /^application\/json\b/i.test(String(x.type)) && x.json && typeof x.json === "object";
        const set = await call("/api/pilot-cookie/set", "POST");
        const token = ok(set) && /^[0-9a-f]{24}$/.test(String(set.json.token)) ? set.json.token : null;
        out.tokenValid = Boolean(token);
        out.documentCookie = await page.evaluate(() => document.cookie);
        const e1 = await call("/api/pilot-cookie/echo", "GET");
        const host = new URL(staticBase).hostname;
        out.stored = (await ctx.cookies()).filter((c) => c.name.startsWith("qracks_") || c.name.startsWith("qz_")).map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, path: c.path }));
        await page.reload(); const e2 = await call("/api/pilot-cookie/echo", "GET");
        const cl = await call("/api/pilot-cookie/clear", "POST"); const e3 = await call("/api/pilot-cookie/echo", "GET");
        out.echo = [e1, e2, e3].map((x) => (ok(x) ? x.json : null)); out.clearOk = ok(cl);
        const sess = out.stored.find((c) => c.name === "qracks_session_piloto");
        out.pass = Boolean(token && out.pageStatus === 200 && out.echo.every(Boolean) && out.clearOk
          && !out.documentCookie.includes("qracks_session_piloto") && out.documentCookie.includes("qz_piloto_visible=1")
          && out.echo[0].session === token && out.echo[1].session === token && out.echo[2].session === null
          && sess && sess.httpOnly && sess.secure && sess.sameSite === "Lax" && sess.domain === host);
      } finally { await b.close(); }
      return save("cookies-navegador", out);
    },
    async "dormido-http"(force) {
      const gate = coldGate(force); const id = crypto.randomBytes(6).toString("hex");
      const out = { test: "dormido-http", idleMinBefore: gate.idleMin, probe: id };
      out.page = await req("estatico GET /q/demo (página)", `${staticBase}/q/demo?probe=${id}`, { headers: NAV });
      out.firstApi = await req("estatico GET /api/health (dormido)", `${staticBase}/api/health?probe=${id}`, { headers: JSONH, timeoutMs: 120_000 });
      out.wake = await untilAwake(staticBase);
      const lg = await pilotLog(id);
      out.logValid = Boolean(lg);
      out.originReceivedFirstApi = lg ? lg.count : null;
      await confirmCold(gate, out);
      out.propertyPass = Boolean(out.page.status === 200 && out.wake.awakeAfterMs !== null && lg && Number.isInteger(lg.count) && lg.count <= 1);
      out.pass = Boolean(out.propertyPass && out.cold);
      return save("dormido-http", out);
    },
    async "dormido-post"(force) {
      const gate = coldGate(force); const id = crypto.randomBytes(6).toString("hex"); const body = payload(20);
      const out = { test: "dormido-post", idleMinBefore: gate.idleMin, probe: id };
      out.first = await req("estatico POST webhook (dormido)", `${staticBase}/api/payments/stripe/webhook?probe=${id}`, { method: "POST", body, headers: { ...JSONH, "content-type": "application/json", "stripe-signature": SIGNATURE }, timeoutMs: 120_000 });
      out.wake = await untilAwake(direct);
      const lg = await pilotLog(id);
      out.logValid = Boolean(lg);
      out.originReceived = lg ? lg.count : null; out.originRequests = lg ? lg.requests : null;
      await confirmCold(gate, out);
      const answered = isJsonResp(out.first);
      out.answeredByOrigin = answered;
      out.intactInResponse = answered ? out.first.json.sha256 === sha(body) && out.first.json.signature === SIGNATURE && out.first.json.method === "POST" : null;
      out.intactAtOrigin = lg ? lg.requests.every((q) => q.method === "POST" && q.sha256 === sha(body) && q.signature === true) : false;
      out.lost = lg ? lg.count === 0 : null;   // observación: el webhook no llegó (Stripe reintentaría)
      out.propertyPass = Boolean(lg && lg.count <= 1 && out.intactAtOrigin && (answered ? out.intactInResponse && lg.count === 1 : true));
      out.pass = Boolean(out.propertyPass && out.cold);
      return save("dormido-post", out);
    },
    async "dormido-navegador"(force, { appTimeoutMs = 180_000, quietMs = 5_000 } = {}) {
      const gate = coldGate(force); const id = crypto.randomBytes(6).toString("hex");
      const pathQuery = `/a/mi-q?qz_pago=pi_1&qz_sess=cs_2&%C3%B1=1&probe=${id}`; const target = `${staticBase}${pathQuery}#arriba`;
      const out = { test: "dormido-navegador", idleMinBefore: gate.idleMin, probe: id, target: pathQuery + "#arriba" };
      const b = await browser(); const t0 = Date.now(); const ev = [];
      try {
        const page = await b.newPage({ viewport: { width: 390, height: 844 } });
        page.on("request", (r) => { touch(); ev.push({ t: Date.now() - t0, k: "req", type: r.resourceType(), m: r.method(), u: r.url().replace(staticBase, "") }); });
        page.on("response", (r) => ev.push({ t: Date.now() - t0, k: "res", type: r.request().resourceType(), s: r.status(), u: r.url().replace(staticBase, "") }));
        const first = await page.goto(target, { timeout: 30_000 });
        out.first = { status: first ? first.status() : null, ms: Date.now() - t0, h1: await page.locator("h1").first().textContent().catch(() => null),
          paymentNote: await page.locator(".note").first().textContent().catch(() => null) };
        try { await page.waitForSelector("#app", { timeout: appTimeoutMs }); out.appAfterMs = Date.now() - t0; } catch { out.appAfterMs = null; }
        out.sameUrl = page.url() === target;
        out.seen = out.appAfterMs ? await page.locator("#seen").textContent() : null;
        out.originGotSameUrl = out.seen === pathQuery;
        out.navigationType = await page.evaluate(() => (performance.getEntriesByType("navigation")[0] || {}).type || null);
        const before = ev.length; await page.waitForTimeout(quietMs);
        out.requestsAfterApp = ev.slice(before).filter((x) => x.k === "req").length;
        out.documents = ev.filter((x) => x.k === "req" && x.type === "document").length;
        out.healthResponses = ev.filter((x) => x.k === "res" && x.u.startsWith("/api/health")).map((x) => ({ t: x.t, s: x.s }));
        out.otherRequests = ev.filter((x) => x.k === "req" && x.type !== "document" && !x.u.startsWith("/api/health") && !x.u.startsWith("/api/pilot-app")).map((x) => x.m + " " + x.u);
        fs.mkdirSync(outDir, { recursive: true }); out.screenshot = path.join(outDir, `navegador-${id}.png`); await page.screenshot({ path: out.screenshot }).catch(() => { out.screenshot = null; });
      } finally { await b.close(); }
      await confirmCold(gate, out);
      out.propertyPass = Boolean(out.first.status === 200 && out.first.h1 === "Estamos abriendo la administración de tu quiniela" && out.appAfterMs && out.sameUrl && out.originGotSameUrl
        && out.navigationType === "navigate" && out.documents === 1 && out.requestsAfterApp === 0 && out.otherRequests.length === 0);
      out.pass = Boolean(out.propertyPass && out.cold);
      return save("dormido-navegador", out);
    },
  };
  function summary() {
    if (!fs.existsSync(outDir)) return 0;
    const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json") && f !== "estado.json").sort();
    for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8")); log(`${f}: ${d.test} · ${d.pass ? "PASA" : "FALLA"}${d.cold !== undefined ? " · propiedad " + d.propertyPass + " · frío " + d.cold + (d.forced ? " (forzado: nunca aprueba)" : "") : ""}`); }
    return files.length;
  }
  return { tests, summary, untilAwake };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name] = process.argv.slice(2);
  const staticBase = (process.env.SS_STATIC || "").replace(/\/$/, ""), direct = (process.env.SS_DIRECT || "").replace(/\/$/, "");
  const p = createStaticProbe({ staticBase, direct });
  (async () => {
    if (name === "resumen") return p.summary();
    if (!staticBase || !direct) { console.error("Faltan SS_STATIC o SS_DIRECT"); process.exit(2); }
    if (!p.tests[name]) { console.error(`Uso: node pilot/measure/static-probe.mjs ${Object.keys(p.tests).join(" | ")} | resumen [--forzar]`); process.exit(2); }
    const r = await p.tests[name](process.argv.includes("--forzar")); if (r.data.pass === false) process.exitCode = 3;
  })().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
