// MON-003 Correction 10 — el contrato de entorno de Payments.
//
// Una sola evaluación (assessReadiness + combineReadiness) decide READY /
// DISABLED / MISCONFIGURED. Estos tests la ejercen con entornos inyectados —
// nunca con el entorno real de la máquina— y comprueban que todos los caminos
// del servidor la usan a ELLA y a nada más.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const A = require("../payments/stripeAdapter");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const ADAPTER = fs.readFileSync(path.join(__dirname, "..", "payments", "stripeAdapter.js"), "utf8");
const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => {
    const i = l.indexOf("//");
    if (i === -1) return l;
    const antes = l.slice(0, i);
    if ((antes.match(/["'`]/g) || []).length % 2) return l;
    return antes;
  }).join("\n");
}
function cuerpoDe(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at !== -1, `ancla inexistente: ${marker}`);
  const abre = src.indexOf("{", at);
  let d = 0;
  for (let i = abre; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (d === 0) return src.slice(at, i + 1); }
  }
  throw new Error("sin cerrar: " + marker);
}

const SK = "sk_test_51Abc", SK_LIVE = "sk_live_51Abc", WH = "whsec_AbC123";
const SANDBOX = "https://qracks-mon003-sandbox.onrender.com", PROD = "https://qracks.net";
const R = (env) => A.assessReadiness(env);
const S = A.PAYMENTS_STATE;

test("C10 · A — ninguna variable de Stripe: DISABLED (desactivación deliberada)", () => {
  const r = R({});
  assert.equal(r.state, S.DISABLED);
  assert.deepEqual(r.problems, []);
  // PUBLIC_BASE_URL sola tampoco es intención de cobrar.
  assert.equal(R({ PUBLIC_BASE_URL: SANDBOX }).state, S.DISABLED);
  // Y cadenas vacías son ausencia, no intención.
  assert.equal(R({ STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", PUBLIC_BASE_URL: "" }).state, S.DISABLED);
  // Una base inválida sin credenciales no bloquea nada, pero se avisa.
  const aviso = R({ PUBLIC_BASE_URL: "qracks.net" });
  assert.equal(aviso.state, S.DISABLED);
  assert.ok(aviso.warnings.includes("invalid:PUBLIC_BASE_URL:unparseable"));
});

test("C10 · B/C/D/E — cualquier combinación parcial es MISCONFIGURED, con el nombre de lo que falta", () => {
  const casos = [
    ["B sólo la clave", { STRIPE_SECRET_KEY: SK }, ["missing:STRIPE_WEBHOOK_SECRET", "missing:PUBLIC_BASE_URL"]],
    ["C sólo el secreto del webhook", { STRIPE_WEBHOOK_SECRET: WH }, ["missing:STRIPE_SECRET_KEY", "missing:PUBLIC_BASE_URL"]],
    ["D claves sin URL", { STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WH }, ["missing:PUBLIC_BASE_URL"]],
    ["E URL + clave", { STRIPE_SECRET_KEY: SK, PUBLIC_BASE_URL: SANDBOX }, ["missing:STRIPE_WEBHOOK_SECRET"]],
    ["E URL + secreto", { STRIPE_WEBHOOK_SECRET: WH, PUBLIC_BASE_URL: SANDBOX }, ["missing:STRIPE_SECRET_KEY"]],
  ];
  for (const [etq, env, faltan] of casos) {
    const r = R(env);
    assert.equal(r.state, S.MISCONFIGURED, etq);
    assert.deepEqual(r.problems.slice().sort(), faltan.slice().sort(), etq);
    assert.equal(A.isConfigured(env), false, etq);
  }
});

test("C10 · F — las tres válidas: READY, con origen normalizado y URL de webhook", () => {
  const r = R({ STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WH, PUBLIC_BASE_URL: SANDBOX });
  assert.equal(r.state, S.READY);
  assert.equal(r.mode, "test");
  assert.equal(r.baseUrl, SANDBOX);
  assert.equal(r.webhookUrl, SANDBOX + "/api/payments/stripe/webhook");
  assert.equal(A.isConfigured({ STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WH, PUBLIC_BASE_URL: SANDBOX }), true);
  // Espacios alrededor de un valor válido no lo invalidan (Render los conserva).
  assert.equal(R({ STRIPE_SECRET_KEY: " " + SK + "\n", STRIPE_WEBHOOK_SECRET: WH + " ", PUBLIC_BASE_URL: " " + PROD }).state, S.READY);
});

test("C10 · G — PUBLIC_BASE_URL inválida o peligrosa: MISCONFIGURED", () => {
  const base = { STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WH };
  const malas = [
    ["qracks.net", "unparseable"], ["ftp://qracks.net", "not_http_or_https"],
    ["http://qracks.net", "http_only_for_localhost"], ["https://user:pw@qracks.net", "has_credentials"],
    ["https://qracks.net/app", "has_path"], ["https://qracks.net//", "has_path"],
    ["https://qracks.net/?next=evil", "has_query_or_fragment"], ["https://qracks.net/#x", "has_query_or_fragment"],
    ["https://qracks.net?", "has_query_or_fragment"], ["javascript:alert(1)", "not_http_or_https"],
  ];
  for (const [url, motivo] of malas) {
    const r = R({ ...base, PUBLIC_BASE_URL: url });
    assert.equal(r.state, S.MISCONFIGURED, url);
    assert.ok(r.problems.includes("invalid:PUBLIC_BASE_URL:" + motivo), url + " -> " + JSON.stringify(r.problems));
    assert.equal(r.baseUrl, null, "nunca se usa una base inválida");
  }
  // Local con claves test: permitido (desarrollo). Con claves live: no.
  assert.equal(R({ ...base, PUBLIC_BASE_URL: "http://localhost:3000" }).state, S.READY);
  const vivo = R({ STRIPE_SECRET_KEY: SK_LIVE, STRIPE_WEBHOOK_SECRET: WH, PUBLIC_BASE_URL: "http://localhost:3000" });
  assert.equal(vivo.state, S.MISCONFIGURED);
  assert.ok(vivo.problems.includes("invalid:PUBLIC_BASE_URL:live_key_needs_public_https"));
  // En blanco (sólo espacios) no es "ausente": alguien pegó mal.
  assert.ok(R({ ...base, PUBLIC_BASE_URL: "   " }).problems.includes("blank:PUBLIC_BASE_URL"));
});

test("C10 · H/I/J — el origen de vuelta: sandbox al sandbox, producción a producción, sin '//'", () => {
  const env = (url) => ({ STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WH, PUBLIC_BASE_URL: url });
  assert.equal(R(env(SANDBOX)).baseUrl, SANDBOX);
  assert.equal(R(env(PROD)).baseUrl, PROD);
  assert.equal(R(env(PROD + "/")).baseUrl, PROD, "la barra final se normaliza");
  assert.equal(R(env("HTTPS://QRACKS.NET")).baseUrl, PROD, "el host se normaliza");
  assert.equal(R(env("https://qracks.net:443")).baseUrl, PROD, "el puerto por defecto se quita");
  for (const u of [SANDBOX, PROD, PROD + "/"]) {
    const b = R(env(u)).baseUrl;
    assert.ok(!/\/$/.test(b), "sin barra final: " + b);
    assert.ok(!(b + "/q/liga").slice(8).includes("//"), "sin // accidental");
  }
  // El servidor construye las URLs con ESE origen, y con nada del navegador.
  const mk = stripComments(cuerpoDe(SRC, "async function createSessionFor(intent, slug)"));
  assert.ok(mk.includes("const base = readiness.baseUrl;"));
  assert.ok(mk.includes('throw new Error("payments_not_ready")'), "sin readiness lista no se emite");
  assert.ok(!/req\.|get\(["']host|x-forwarded/i.test(mk), "nada de la petición");
  assert.ok(mk.includes("`${base}/q/${encodeURIComponent(slug)}`"));
  assert.ok(mk.includes("?qz_pago=${encodeURIComponent(intent.id)}&qz_sess={CHECKOUT_SESSION_ID}"));
  assert.ok(mk.includes("?qz_pago_cancelado=1"));
  // Ningún dominio de producción fijo en el código de PAGOS: ni en el adaptador,
  // ni en la creación de la sesión, ni en el checkout. (El único `qracks.net` del
  // servidor es el og:url canónico de las previsualizaciones de enlace, anterior
  // a MON-003: no es una URL de vuelta y no redirige a nadie.)
  assert.ok(!/qracks\.net/.test(stripComments(ADAPTER)), "adaptador");
  assert.ok(!/qracks\.net/.test(mk), "createSessionFor");
  const co = stripComments(SRC).slice(stripComments(SRC).indexOf('app.post("/api/quinielas/:slug/checkout"'));
  assert.ok(!/qracks\.net/.test(co.slice(0, co.indexOf("\n});"))), "checkout");
  const fuera = (stripComments(SRC).match(/qracks\.net/g) || []).length;
  assert.equal(fuera, 1, "sólo el og:url de previsualización");
});

test("C10 · credenciales con forma de OTRA credencial: MISCONFIGURED; formato desconocido: aviso", () => {
  const ok = { STRIPE_WEBHOOK_SECRET: WH, PUBLIC_BASE_URL: PROD };
  assert.ok(R({ ...ok, STRIPE_SECRET_KEY: "pk_test_123" }).problems.includes("malformed:STRIPE_SECRET_KEY:looks_like_publishable_key"));
  assert.ok(R({ ...ok, STRIPE_SECRET_KEY: WH }).problems.some((p) => p.startsWith("malformed:STRIPE_SECRET_KEY:looks_like_webhook_secret")));
  assert.ok(R({ ...ok, STRIPE_SECRET_KEY: "sk_test_a b" }).problems.includes("malformed:STRIPE_SECRET_KEY:contains_whitespace"));
  assert.ok(R({ STRIPE_SECRET_KEY: SK, PUBLIC_BASE_URL: PROD, STRIPE_WEBHOOK_SECRET: SK }).problems.includes("malformed:STRIPE_WEBHOOK_SECRET:looks_like_api_key"));
  assert.ok(R({ STRIPE_SECRET_KEY: SK, PUBLIC_BASE_URL: PROD, STRIPE_WEBHOOK_SECRET: "   " }).problems.includes("blank:STRIPE_WEBHOOK_SECRET"));
  // Formato desconocido: no bloquea (no es contrato), avisa, y el proveedor decide.
  const raro = R({ ...ok, STRIPE_SECRET_KEY: "key_nueva_formato" });
  assert.equal(raro.state, S.READY);
  assert.ok(raro.warnings.includes("unrecognized_format:STRIPE_SECRET_KEY"));
  assert.equal(raro.mode, "unknown");
  // Restringidas: válidas.
  assert.equal(R({ ...ok, STRIPE_SECRET_KEY: "rk_live_x" }).mode, "live");
});

test("C10 · el proveedor: sólo una respuesta DEFINITIVA empeora el estado", () => {
  const listo = R({ STRIPE_SECRET_KEY: SK, STRIPE_WEBHOOK_SECRET: WH, PUBLIC_BASE_URL: PROD });
  assert.equal(A.combineReadiness(listo, { status: "pending", livemode: null }).state, S.READY);
  assert.equal(A.combineReadiness(listo, { status: "ok", livemode: false }).state, S.READY);
  const rech = A.combineReadiness(listo, { status: "rejected", livemode: null });
  assert.equal(rech.state, S.MISCONFIGURED);
  assert.ok(rech.problems.includes("provider_rejected:STRIPE_SECRET_KEY"));
  const caido = A.combineReadiness(listo, { status: "unreachable", livemode: null });
  assert.equal(caido.state, S.READY, "Stripe caído al arrancar no rompe un despliegue correcto");
  assert.ok(caido.warnings.includes("provider_unreachable_at_startup"));
  // Clave test que Stripe dice live (o al revés): no se sabe qué se está cobrando.
  assert.equal(A.combineReadiness(listo, { status: "ok", livemode: true }).state, S.MISCONFIGURED);
  // Live confirmado por Stripe con base local: nunca.
  const loc = R({ STRIPE_SECRET_KEY: "key_x", STRIPE_WEBHOOK_SECRET: WH, PUBLIC_BASE_URL: "http://localhost:3000" });
  assert.equal(loc.state, S.READY);
  assert.equal(A.combineReadiness(loc, { status: "ok", livemode: true }).state, S.MISCONFIGURED);
  // Lo que no está listo no mejora por nada que diga el proveedor.
  assert.equal(A.combineReadiness(R({ STRIPE_SECRET_KEY: SK }), { status: "ok", livemode: false }).state, S.MISCONFIGURED);
});

test("C10 · K — /plan, /checkout, webhook, reconciliación y arranque leen UNA readiness", () => {
  const src = stripComments(SRC);
  // Ni un solo uso suelto del booleano viejo en el servidor.
  assert.ok(!/isConfigured\(/.test(src), "el servidor no usa isConfigured");
  const lectores = (src.match(/paymentsReadiness\(\)/g) || []).length;
  assert.ok(lectores >= 6, "lectores de la readiness: " + lectores);
  assert.ok(cuerpoDe(src, "async function checkoutModeFor(slug, scopeId)").includes("paymentsReadiness().state"));
  const co = src.slice(src.indexOf('app.post("/api/quinielas/:slug/checkout"'));
  assert.ok(co.slice(0, 3000).includes("const readiness = paymentsReadiness();"));
  assert.ok(co.slice(0, 3000).includes('return res.status(503).json({ error: "payments_misconfigured" });'));
  const wh = src.slice(src.indexOf("app.post(STRIPE_WEBHOOK_PATH, async"));
  const antesDeFirma = wh.slice(0, wh.indexOf("verifyWebhookSignature("));
  assert.ok(antesDeFirma.includes("paymentsReadiness()"), "el webhook comprueba la readiness antes de nada");
  assert.ok(antesDeFirma.includes("readiness.state !== stripeAdapter.PAYMENTS_STATE.READY"));
  const rec = src.slice(src.indexOf('app.get("/api/quinielas/:slug/checkout/:purchaseId"'));
  assert.ok(rec.slice(0, 4000).includes("paymentsReadiness().state === stripeAdapter.PAYMENTS_STATE.READY"));
  // Arranque: se registra el estado al escuchar, y se comprueba la clave.
  const start = cuerpoDe(src, "async function start(retriesLeft)");
  assert.ok(start.includes('logPaymentsReadiness("startup")'));
  // La clave se comprueba ANTES de escuchar: la línea de arranque es definitiva.
  assert.ok(start.indexOf("await checkPaymentsProvider()") !== -1
    && start.indexOf("await checkPaymentsProvider()") < start.indexOf("app.listen("));
  // Y el webhook usa el MISMO path que anuncia la readiness.
  assert.ok(src.includes("const STRIPE_WEBHOOK_PATH = stripeAdapter.WEBHOOK_PATH;"));
});

test("C10 · el diagnóstico nunca lleva valores de credenciales", () => {
  const diag = stripComments(cuerpoDe(SRC, "function paymentsDiagnostic()"));
  assert.ok(!/secretKey|webhookSecret|readConfig|STRIPE_SECRET_KEY\b(?!:)/.test(diag.replace(/"[^"]*"/g, "")));
  const log = stripComments(cuerpoDe(SRC, "function logPaymentsReadiness(when)"));
  assert.ok(!/secretKey|webhookSecret|readConfig|process\.env/.test(log));
  // La evaluación devuelve sólo nombres de variable y motivos.
  const r = R({ STRIPE_SECRET_KEY: "sk_test_SECRETO", STRIPE_WEBHOOK_SECRET: "whsec_SECRETO", PUBLIC_BASE_URL: "http://x" });
  assert.ok(!JSON.stringify(r).includes("SECRETO"));
  const c = A.combineReadiness(r, { status: "rejected", livemode: null });
  assert.ok(!JSON.stringify(c).includes("SECRETO"));
  // El endpoint del panel exige la credencial de plataforma.
  const ep = SRC.slice(SRC.indexOf('app.get("/api/platform/payments-readiness"'));
  assert.ok(ep.slice(0, 600).includes("verifyPassword(providedPlatformAuth, platformHash)"));
});

test("C10 · la UI: mal configurado no es 'sin pasarela' ni ofrece contacto", () => {
  const sheet = stripComments(cuerpoDe(INDEX, "function showUpgradeSheet(upgrade, ctx)"));
  const howTo = sheet.slice(sheet.indexOf("const howTo ="), sheet.indexOf("return new Promise"));
  const un = howTo.slice(howTo.indexOf('mode === "unavailable"'), howTo.indexOf('mode === "blocked"'));
  assert.ok(/no está disponible en este momento/.test(un));
  assert.ok(!/Escr[ií]benos|contact/.test(un));
  assert.ok(sheet.includes('${mode === "card" ? `<button'), "botón sólo con tarjeta");
  assert.ok(INDEX.includes('e503 === "payments_misconfigured" ? "payments_misconfigured"'));
  const t = sheet.slice(sheet.indexOf('motivo === "payments_misconfigured"'));
  assert.ok(!/Escr[ií]benos/.test(t.slice(0, 200)));
});
