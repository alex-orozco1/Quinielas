// UX-INFRA-001 · H-WAKE · Medición contra el servicio mínimo en Render y el Worker en workers.dev.
//
// Se ejecuta desde una máquina con salida a *.onrender.com y *.workers.dev (Node ≥ 18):
//   HWAKE_DIRECT=https://<servicio>.onrender.com \
//   HWAKE_WORKER=https://<worker>.<cuenta>.workers.dev \
//   HWAKE_TOKEN=<el mismo valor que el secreto PILOT_TOKEN del Worker> \
//   node pilot/measure/probe.mjs <modo> [caso]
//
// Modos:
//   despierto          matriz de base con el origen despierto (3 repeticiones)
//   dormido <caso>     UN caso en frío; exige ≥ 16 min sin peticiones (registro local) salvo --forzar
//   resumen            tabla de todas las observaciones guardadas
// Casos en frío: directo-nav, worker-sub-nav, worker-sub-api, worker-nav, worker-post,
//   worker-webhook, worker-head
//
// Guarda cada corrida en pilot/measure/out/<fecha>-<modo>[-<caso>].json. El token nunca
// se guarda ni se imprime. «Arranque en frío» se confirma si cambia `startedAt` del
// servicio (/api/pilot-log): cada arranque de proceso tiene uno nuevo.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { isHealthyPayload } from "../edge/waker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const COLD_CASES = ["directo-nav", "worker-sub-nav", "worker-sub-api", "worker-nav", "worker-post", "worker-webhook", "worker-head"];
const NAV = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 (qracks-hwake-probe)" };
const API = { accept: "application/json", "user-agent": "qracks-hwake-probe" };
const PAYLOAD = Buffer.from(JSON.stringify({ id: "evt_pilot", type: "pilot.eco", data: { x: "ñ".repeat(10000) } }));
const PAYLOAD_SHA = crypto.createHash("sha256").update(PAYLOAD).digest("hex");
const SIGNATURE = "t=1,v1=piloto-sin-secreto";   // valor fijo de prueba: el servicio mínimo no verifica firmas
const MIN_IDLE_MS = 16 * 60 * 1000;
const MAX_WAIT_MS = 180_000;

// node:http(s) y no fetch(): el fetch de Node REEMPLAZA `sec-fetch-mode` por «cors», y
// entonces el Worker nunca vería una navegación (encontrado en la prueba local).
// Aquí las cabeceras salen tal cual y los tiempos se toman de los eventos del socket.
// Si hay HTTPS_PROXY (p. ej. el proxy de una sesión en la nube), el HTTPS va por un túnel
// CONNECT con verificación TLS normal (CA del sistema más NODE_EXTRA_CA_CERTS); nunca se desactiva.
function proxyFor(u) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p || u.protocol !== "https:") return null;
  const no = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (no.some((n) => n === u.hostname || (n.startsWith(".") && u.hostname.endsWith(n)) || (n.startsWith("*.") && u.hostname.endsWith(n.slice(1))))) return null;
  return new URL(p);
}
function tunnelAgent(u, proxy) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (opts, cb) => {
    const auth = proxy.username ? { "proxy-authorization": "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64") } : {};
    const target = `${u.hostname}:${u.port || 443}`;
    const c = http.request({ host: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: target, headers: Object.assign({ host: target }, auth) });
    c.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return cb(Object.assign(new Error(`proxy CONNECT ${res.statusCode}`), { code: "PROXY_" + res.statusCode })); }
      cb(null, tls.connect({ socket, servername: u.hostname }));
    });
    c.on("error", cb); c.end();
  };
  return agent;
}

export function rawRequest(url, { method = "GET", headers = {}, body = null, timeoutMs = MAX_WAIT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const lib = u.protocol === "https:" ? https : http; const t0 = Date.now();
    const proxy = proxyFor(u);
    const rq = lib.request(u, { method, agent: proxy ? tunnelAgent(u, proxy) : undefined, headers: Object.assign({}, headers, body ? { "content-length": body.length } : {}) }, (res) => {
      const headersMs = Date.now() - t0; const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, headersMs, totalMs: Date.now() - t0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    rq.setTimeout(timeoutMs, () => rq.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    rq.on("error", reject);
    if (body) rq.write(body);
    rq.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomBytes(6).toString("hex");
const withProbe = (p, id) => p + (p.includes("?") ? "&" : "?") + "probe=" + id;

export function createProbe({ direct, worker, token, outDir = path.join(here, "out"), requestImpl = rawRequest, log = console.log }) {
  const statePath = path.join(outDir, "estado.json");
  const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } };
  const writeState = (s) => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); };
  const touch = () => { const s = readState(); s.lastRequestAt = Date.now(); writeState(s); };

  async function req(label, url, init = {}) {
    const t0 = Date.now(); const rec = { label, method: init.method || "GET", url: url.replace(/^https?:\/\/[^/]+/, ""), host: new URL(url).host, at: new Date(t0).toISOString() };
    touch();
    try {
      const res = await requestImpl(url, init);
      rec.headersMs = res.headersMs; rec.status = res.status;
      const { "set-cookie": sc, ...rest } = res.headers; rec.headers = rest; rec.setCookie = sc || [];
      const buf = res.body;
      rec.totalMs = res.totalMs; rec.bytes = buf.length;
      rec.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      rec.bodyStart = buf.subarray(0, 1500).toString("utf8");
      const text = buf.toString("utf8");
      const h1 = /<h1[^>]*>([^<]*)<\/h1>/.exec(text); rec.h1 = h1 ? h1[1] : null;
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text); rec.title = title ? title[1] : null;
      const seen = /<pre id="seen">([^<]*)<\/pre>/.exec(text); rec.seenRaw = seen ? seen[1] : null;
      try { rec.json = JSON.parse(buf.toString("utf8")); } catch { /* no es JSON */ }
    } catch (e) { rec.error = String(e && (e.code || e.name) || e); rec.totalMs = Date.now() - t0; }
    log(`  ${rec.label.padEnd(26)} ${String(rec.status ?? rec.error).padEnd(14)} cabeceras ${String(rec.headersMs ?? "-").padStart(6)} ms · total ${String(rec.totalMs).padStart(6)} ms`);
    return rec;
  }
  const healthy = (r) => isHealthyPayload(r.status, r.headers && r.headers["content-type"], r.json);
  const pilotLog = (base, id) => req(`registro ${id}`, `${base}/api/pilot-log?probe=${id}`, { headers: API }).then((r) => r.json || null);
  async function untilAwake(base) {
    const t0 = Date.now(); const tries = [];
    while (Date.now() - t0 < MAX_WAIT_MS) {
      const r = await req("salud (espera)", `${base}/api/health`, { headers: Object.assign({ "cache-control": "no-store" }, API) });
      tries.push({ at: r.at, status: r.status, error: r.error, headersMs: r.headersMs, healthy: healthy(r), contentType: r.headers && r.headers["content-type"] });
      if (healthy(r)) return { awakeAfterMs: Date.now() - t0, tries };
      await sleep(2000);
    }
    return { awakeAfterMs: null, tries };
  }
  const seenOf = (r) => (r.seenRaw == null ? null : r.seenRaw.replace(/&amp;/g, "&"));
  const probeVia = (p, kind) => req(`worker-sub ${kind} ${p.split("?")[0]}`, `${worker}/__pilot/probe?kind=${kind}&path=${encodeURIComponent(p)}`, { headers: { "x-pilot-token": token, ...API } });

  // Cada caso: la PRIMERA petición es la que se mide (en frío, es la que despierta al origen).
  const CASES = {
    "directo-nav": async (id) => { const p = withProbe("/q/demo", id); return { first: await req("directo GET /q/demo", direct + p, { headers: NAV }), base: direct, expectSeen: p }; },
    "worker-sub-nav": async (id) => { const p = withProbe("/q/demo", id); const r = await probeVia(p, "nav"); return { first: r, base: worker }; },
    "worker-sub-api": async (id) => { const r = await probeVia(withProbe("/api/health", id), "api"); return { first: r, base: worker }; },
    "worker-nav": async (id) => {
      const p = withProbe("/a/mi-q?qz_pago=pi_1&qz_sess=cs_2&%C3%B1=1", id);
      const first = await req("worker GET /a/…", worker + p, { headers: NAV });
      first.isLoadingPage = first.h1 === "Estamos abriendo la administración de tu quiniela";
      return { first, base: worker, again: p, expectSeen: p };
    },
    "worker-post": async (id) => {
      const first = await req("worker POST /api/eco", `${worker}/api/eco?probe=${id}`, { method: "POST", headers: { ...API, "content-type": "application/json" }, body: PAYLOAD });
      first.shaMatches = first.json ? first.json.sha256 === PAYLOAD_SHA : null; return { first, base: worker, expectOnce: true };
    },
    "worker-webhook": async (id) => {
      const first = await req("worker POST webhook", `${worker}/api/payments/stripe/webhook?probe=${id}`, { method: "POST", headers: { ...API, "content-type": "application/json", "stripe-signature": SIGNATURE }, body: PAYLOAD });
      first.shaMatches = first.json ? first.json.sha256 === PAYLOAD_SHA : null; first.signatureMatches = first.json ? first.json.signature === SIGNATURE : null;
      return { first, base: worker, expectOnce: true };
    },
    "worker-head": async (id) => ({ first: await req("worker HEAD /crear", worker + withProbe("/crear", id), { method: "HEAD", headers: NAV }), base: worker }),
  };

  async function cold(name, { force = false } = {}) {
    if (!CASES[name]) throw new Error(`caso desconocido: ${name}. Casos: ${COLD_CASES.join(", ")}`);
    const st = readState(); const idle = st.lastRequestAt ? Date.now() - st.lastRequestAt : Infinity;
    if (!force && idle < MIN_IDLE_MS) throw new Error(`sólo ${Math.round(idle / 60000)} min sin peticiones; hacen falta 16 (o --forzar)`);
    const id = newId(); log(`dormido · ${name} · probe=${id} · ${idle === Infinity ? "sin registro previo" : Math.round(idle / 60000) + " min sin peticiones"}`);
    const c = await CASES[name](id);
    const wake = await untilAwake(c.base);
    const out = { mode: "dormido", case: name, probe: id, idleMinBefore: idle === Infinity ? null : Math.round(idle / 60000), first: c.first, wake };
    if (c.again) { const r = await req("worker GET (otra vez)", worker + c.again, { headers: NAV }); out.again = r; out.seen = seenOf(r); out.urlPreserved = out.seen === c.expectSeen; }
    else if (c.expectSeen) { out.seen = seenOf(c.first); out.urlPreserved = out.seen === null ? null : out.seen === c.expectSeen; }
    const lg = await pilotLog(direct, id);
    out.originReceived = lg ? lg.count : null; out.originRequests = lg ? lg.requests : null; out.serviceStartedAt = lg ? lg.startedAt : null;
    out.coldStartConfirmed = lg && st.serviceStartedAt ? lg.startedAt !== st.serviceStartedAt : null;
    if (c.expectOnce) out.exactlyOnce = out.originReceived === 1;
    const s2 = readState(); if (lg) s2.serviceStartedAt = lg.startedAt; writeState(s2);
    return save(`dormido-${name}`, out);
  }

  async function awake({ reps = 3 } = {}) {
    log("despierto · matriz de base"); const runs = [];
    const w0 = await untilAwake(direct); const lg0 = await pilotLog(direct, "x");
    for (let i = 0; i < reps; i++) {
      const id = newId(); const r = { probe: id, items: [] };
      const add = (x) => { r.items.push(x); return x; };
      for (const [base, who] of [[direct, "directo"], [worker, "worker"]]) {
        add(await req(`${who} GET /api/health`, `${base}/api/health?probe=${id}`, { headers: API }));
        const p = withProbe(`/a/mi-q?qz_pago=pi_1&qz_sess=cs_2&%C3%B1=1&via=${who}`, id);
        const nav = add(await req(`${who} GET /a/…`, base + p, { headers: NAV })); nav.seen = seenOf(nav); nav.urlPreserved = nav.seen === p;
        const post = add(await req(`${who} POST /api/eco`, `${base}/api/eco?probe=${id}&via=${who}`, { method: "POST", headers: { ...API, "content-type": "application/json" }, body: PAYLOAD })); post.shaMatches = post.json ? post.json.sha256 === PAYLOAD_SHA : null;
        const wh = add(await req(`${who} POST webhook`, `${base}/api/payments/stripe/webhook?probe=${id}&via=${who}`, { method: "POST", headers: { ...API, "content-type": "application/json", "stripe-signature": SIGNATURE }, body: PAYLOAD }));
        wh.shaMatches = wh.json ? wh.json.sha256 === PAYLOAD_SHA : null; wh.signatureMatches = wh.json ? wh.json.signature === SIGNATURE : null;
        add(await req(`${who} HEAD /crear`, base + withProbe("/crear", id), { method: "HEAD", headers: NAV }));
        add(await req(`${who} GET /files/app.js`, base + withProbe("/files/app.js", id), { headers: NAV }));
        add(await req(`${who} GET /redir`, base + withProbe("/redir", id), { headers: NAV }));
        add(await req(`${who} GET /api/eco-ip`, `${base}/api/eco-ip?probe=${id}`, { headers: API }));
      }
      r.subNav = await probeVia(withProbe("/q/demo", id), "nav");
      r.subApi = await probeVia(withProbe("/api/health", id), "api");
      const lg = await pilotLog(direct, id);
      r.originRequests = lg ? lg.requests : null;
      // Cada POST (directo y por Worker) debe llegar exactamente una vez.
      const posts = (lg ? lg.requests : []).filter((q) => q.method === "POST");
      r.postsOnce = ["directo", "worker"].every((v) => ["/api/eco", "/api/payments/stripe/webhook"].every((pp) => posts.filter((q) => q.url.startsWith(pp) && q.url.includes(`via=${v}`)).length === 1));
      runs.push(r);
    }
    const st = readState(); if (lg0) st.serviceStartedAt = lg0.startedAt; writeState(st);
    return save("despierto", { mode: "despierto", wakeBefore: w0, runs });
  }

  function save(name, data) {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2)); log(`→ ${file}`); return { file, data };
  }

  function summary() {
    const rows = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => /-(despierto|dormido-.+)\.json$/.test(f)).sort() : [];
    for (const f of rows) {
      const d = JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8"));
      if (d.mode === "dormido") {
        const r = d.first; const h = r.headers || {};
        log(`${f}\n  ${d.case}: ${r.status ?? r.error} · cabeceras ${r.headersMs ?? "-"} ms · total ${r.totalMs} ms · tipo ${h["content-type"] || r.headers?.["content-type"] || "-"}`
          + ` · despierto tras ${d.wake.awakeAfterMs ?? "NO"} ms · en frío ${d.coldStartConfirmed} · llegó al origen ${d.originReceived} vez/veces`
          + (d.urlPreserved != null ? ` · URL intacta ${d.urlPreserved}` : "") + (d.exactlyOnce != null ? ` · una sola vez ${d.exactlyOnce}` : ""));
        const sub = r.status === 200 && r.json && r.json.status !== undefined ? r.json : null; // respuesta del endpoint de medición
        if (sub) log(`    (subpetición del Worker) ${sub.status ?? sub.error} · ${sub.headersMs ?? "-"} ms · ${sub.headers?.["content-type"] || "-"} · ${String(sub.bodyStart || "").slice(0, 120).replace(/\s+/g, " ")}`);
      } else log(`${f}\n  despierto: ${d.runs.length} repeticiones · POST una vez: ${d.runs.map((x) => x.postsOnce).join(",")}`);
    }
    return rows.length;
  }
  return { cold, awake, summary, req };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, name] = process.argv.slice(2);
  const tokFile = path.join(here, "out/pilot-token");
  const direct = (process.env.HWAKE_DIRECT || "").replace(/\/$/, ""), worker = (process.env.HWAKE_WORKER || "").replace(/\/$/, "");
  const token = process.env.HWAKE_TOKEN || (fs.existsSync(tokFile) ? fs.readFileSync(tokFile, "utf8").trim() : "");
  const p = createProbe({ direct, worker, token });
  const need = () => { if (!direct || !worker || !token) { console.error("Faltan HWAKE_DIRECT, HWAKE_WORKER o HWAKE_TOKEN"); process.exit(2); } };
  (async () => {
    if (mode === "resumen") return p.summary();
    need();
    if (mode === "despierto") return p.awake();
    if (mode === "dormido") return p.cold(name, { force: process.argv.includes("--forzar") });
    console.error("Uso: node pilot/measure/probe.mjs despierto | dormido <caso> [--forzar] | resumen"); process.exit(2);
  })().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
