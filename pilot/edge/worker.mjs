// UX-INFRA-001 · Cloudflare Worker delante de QRACKS (sólo para el piloto; no desplegado).
//
// Solo actúa en NAVEGACIONES (GET/HEAD de una página). Todo lo demás —API,
// webhooks, archivos y cualquier método que escribe— se reenvía tal cual, una
// sola vez y sin reintentos. Ojo: en producción /api/* además se excluye con una
// ruta SIN Worker, pero eso no la saca del proxy de Cloudflare (ver H-IP / H-TLS).
//
// En una navegación pide al origen la MISMA URL y espera hasta ORIGIN_TIMEOUT_MS.
// Si llega la respuesta de la app, la entrega intacta (estado, cabeceras,
// Set-Cookie, cuerpo). Si no, sirve la pantalla de carga y deja viva la petición
// al origen (waitUntil) para que despierte.

import { renderLoadingPage } from "./page.mjs";

export const ORIGIN_TIMEOUT_MS = 3000;
const FILE_RE = /\/[^/]+\.[A-Za-z0-9]{1,8}$/;   // /logo.svg, /liguillaScoring.js, /robots.txt…
const BODYLESS = new Set(["GET", "HEAD"]);

export function isApiPath(pathname) { return pathname === "/api" || pathname.startsWith("/api/"); }

export function isNavigation(request) {
  if (!BODYLESS.has(request.method)) return false;
  const { pathname } = new URL(request.url);
  if (isApiPath(pathname) || FILE_RE.test(pathname)) return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return /\btext\/html\b/i.test(request.headers.get("accept") || "");
}

// H-WAKE: cómo distinguir la página de arranque de Render de una respuesta de la
// app SÓLO se sabrá midiendo en el piloto externo. Hasta entonces no se adivina:
// nada se clasifica como «página de Render».
export function isRenderWakePage(_response) { return false; }

// URL hacia el origen. En Cloudflare es la misma URL (env.ORIGIN vacío); en el
// emulador local se cambia sólo el host, conservando ruta, parámetros y fragmento.
export function originUrl(requestUrl, env) {
  if (!env || !env.ORIGIN) return requestUrl;
  const u = new URL(requestUrl), o = new URL(env.ORIGIN);
  u.protocol = o.protocol; u.host = o.host;
  return u.toString();
}

function forward(request, env, fetchImpl) {
  let headers = request.headers;
  if (env && env.ORIGIN) {
    // Sólo en el emulador local: Host y cabeceras de conexión son del salto anterior.
    headers = new Headers(request.headers);
    ["host", "connection", "keep-alive", "transfer-encoding", "content-length"].forEach((h) => headers.delete(h));
  }
  const init = { method: request.method, headers, redirect: "manual" };
  if (!BODYLESS.has(request.method)) { init.body = request.body; init.duplex = "half"; }
  return fetchImpl(new Request(originUrl(request.url, env), init));
}

export function loadingResponse(request) {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": "5",
    "x-robots-tag": "noindex",
  };
  const body = request.method === "HEAD" ? null : renderLoadingPage(request.url);
  return new Response(body, { status: 503, headers });
}

export async function handle(request, env, ctx, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const timeoutMs = deps.timeoutMs ?? ORIGIN_TIMEOUT_MS;
  // Paso directo, una sola vez: el error del origen (si lo hay) llega igual al cliente.
  if (!isNavigation(request)) return forward(request, env, fetchImpl);

  const toOrigin = forward(request, env, fetchImpl);
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); });
  const first = await Promise.race([toOrigin.then((r) => r, () => null), timeout]);
  clearTimeout(timer);
  if (first && !isRenderWakePage(first)) return first;
  if (first && first.body) first.body.cancel().catch(() => {});
  // La petición sigue para despertar al origen; su respuesta se descarta.
  ctx.waitUntil(toOrigin.then((r) => (r.body ? r.body.cancel() : null), () => null).catch(() => null));
  return loadingResponse(request);
}

export default { fetch: (request, env, ctx) => handle(request, env, ctx) };
