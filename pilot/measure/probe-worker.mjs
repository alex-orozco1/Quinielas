// UX-INFRA-001 · H-WAKE · Worker de MEDICIÓN (sólo para workers.dev, nunca para qracks.net).
//
// Es el Worker del piloto (handle) más un único endpoint de medición:
//   GET /__pilot/probe?path=/q/demo&kind=nav|api   (cabecera x-pilot-token obligatoria)
// que hace UNA subpetición al origen (env.ORIGIN + path), sin seguir redirecciones,
// y devuelve en JSON lo que el Worker recibió de verdad: estado, cabeceras, tiempos,
// tamaño, sha256 y el comienzo del cuerpo. Con eso se define isRenderWakePage a
// partir de lo observado, sin adivinar.
//
// Límites: sólo pide a env.ORIGIN; `path` debe empezar por "/" y no puede ser una
// URL absoluta; sin token (secreto PILOT_TOKEN del Worker) responde 404.

import { handle } from "../edge/worker.mjs";

const PROBE_TIMEOUT_MS = 100_000;
const HEADERS = {
  nav: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 (qracks-hwake-probe)" },
  api: { accept: "application/json", "sec-fetch-mode": "cors", "user-agent": "Mozilla/5.0 (qracks-hwake-probe)" },
};

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b || a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export async function probe(request, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = deps.now || (() => Date.now());
  if (!sameToken(request.headers.get("x-pilot-token") || "", env.PILOT_TOKEN || "")) return new Response("not found", { status: 404 });
  const u = new URL(request.url);
  const path = u.searchParams.get("path") || "/";
  const kind = u.searchParams.get("kind") === "api" ? "api" : "nav";
  if (!path.startsWith("/") || path.startsWith("//")) return new Response("bad path", { status: 400 });
  const target = new URL(path, env.ORIGIN);
  if (target.origin !== new URL(env.ORIGIN).origin) return new Response("bad path", { status: 400 });
  const t0 = now(); const out = { target: target.pathname + target.search, kind, startedAt: new Date(t0).toISOString() };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(new Request(target.toString(), { method: "GET", headers: HEADERS[kind], redirect: "manual", signal: ctl.signal }));
    out.headersMs = now() - t0;
    out.status = res.status;
    out.headers = Object.fromEntries([...res.headers].map(([k, v]) => [k, v]));
    out.setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const buf = await res.arrayBuffer();
    out.totalMs = now() - t0;
    out.bytes = buf.byteLength;
    out.sha256 = await sha256Hex(buf);
    out.bodyStart = new TextDecoder().decode(buf.slice(0, 2000));
  } catch (e) {
    out.error = String(e && e.name || e); out.totalMs = now() - t0;
  } finally { clearTimeout(timer); }
  return new Response(JSON.stringify(out, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__pilot/probe") return probe(request, env);
    return handle(request, env, ctx);
  },
};
