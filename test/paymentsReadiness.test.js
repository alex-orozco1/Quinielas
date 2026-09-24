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
  // Retorno a /a/: la ruta sale del intento (congelada con su clave): "a" para
  // intentos nuevos, "q" para los emitidos antes. Nada más puede ir ahí.
  assert.ok(mk.includes("`${base}/${returnRoute}/${encodeURIComponent(slug)}`"));
  assert.ok(mk.includes('const returnRoute = attempt.returnRoute === "a" ? "a" : "q";'));
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


test("RETORNO /a/ · la ruta de vuelta es parámetro de la clave: nueva para intentos nuevos, heredada al repetir", () => {
  const src = stripComments(SRC);
  const rec = cuerpoDe(src, "async function recordCreationAttempt(purchaseId, nowMs)");
  assert.ok(rec.includes('returnRoute: d.from.returnRoute === "a" ? "a" : "q" }'), "al repetir, la de la clave");
  assert.ok(rec.includes('inherited: null, tagged: true,\n          returnRoute: "a" };'), "al estrenar, /a/");
  assert.ok(rec.includes('...(x.returnRoute === "a" ? { returnRoute: "a" } : {})'), "y se conserva al reescribir la fila");
  const D = require("../payments/paymentsDomain");
  const at = "2026-09-24T10:00:00.000Z";
  assert.equal(D.creationAttemptsOf({ attempts: [{ seq: 1, at, idempotencyKey: "k", expiresAt: 1, returnRoute: "a" }] })[0].returnRoute, "a");
  assert.equal(D.creationAttemptsOf({ attempts: [{ seq: 1, at, idempotencyKey: "k", expiresAt: 1 }] })[0].returnRoute, "q",
    "un intento anterior vuelve a /q/, como se emitió");
  assert.equal(D.creationAttemptsOf({ attempts: [{ seq: 1, at, idempotencyKey: "k", expiresAt: 1, returnRoute: "../x" }] })[0].returnRoute, "q",
    "nada inventado entra en la URL");
  // /a/ la sirve el servidor sin caché ni indexación, y no concede nada.
  const ruta = SRC.slice(SRC.indexOf('app.get("/a/:slug"'));
  const cuerpo = ruta.slice(0, ruta.indexOf("\n});"));
  assert.ok(cuerpo.includes('"no-store"') && cuerpo.includes('"noindex, nofollow"'));
  assert.ok(!/session|isAdmin|cookie/i.test(cuerpo), "la ruta no decide permisos");
});

test("RETORNO /a/ · la pantalla: sin '¿Eres…?' sólo para una sesión de ADMIN que el servidor reconoce", () => {
  const ui = stripComments(INDEX);
  assert.ok(ui.includes('else if(pathParts[0] === "a" && pathParts[1]){ ROUTE = "quiniela"; SLUG = decodeURIComponent(pathParts[1]); ADMIN_ENTRY = true; }'));
  const r = cuerpoDe(ui, "async function render()");
  const atajo = r.slice(r.indexOf("if(ADMIN_ENTRY && session.isAdmin)"));
  assert.ok(atajo.startsWith('if(ADMIN_ENTRY && session.isAdmin){\n            await enterRestoredSession(session, "admin");'));
  assert.ok(r.indexOf("const session = await checkSession();") < r.indexOf("if(ADMIN_ENTRY && session.isAdmin)"),
    "la sesión la valida el servidor antes");
  assert.ok(r.includes("renderSessionConfirm(session);"), "cualquier otra sesión sigue preguntando");
  const enter = cuerpoDe(ui, "async function enterRestoredSession(session, tab)");
  assert.ok(enter.includes('activeTab = (tab === "admin" && currentUser.isAdmin) ? "admin" : "jornada";'),
    "Admin sólo si el participante ES admin");
  // Una vuelta que llega por /q/ (checkouts anteriores) pasa a /a/ sin recargar.
  assert.ok(ui.includes('if(qs.has("qz_pago") || qs.has("qz_pago_cancelado")){\n        ADMIN_ENTRY = true;'));
});

test("RETORNO /a/ · 'Pago completado' sólo con PLUS confirmado; mientras tanto, espera sin ofrecer otro pago", () => {
  const ui = stripComments(INDEX);
  const once = cuerpoDe(ui, "async function checkPurchaseOnce(purchaseId, sessionHint)");
  const completado = once.indexOf('"Pago completado. Tu quiniela ya tiene Plus."');
  assert.ok(completado !== -1);
  const antes = once.slice(0, completado);
  assert.ok(antes.includes("const plan = await loadPlan({ force: true });") && antes.includes('if(plan && plan.plan === "PLUS"){'),
    "el mensaje depende del plan recién leído del servidor");
  assert.ok(once.includes('return "paid_pending_plan";'), "pagado sin Plus confirmado: se sigue esperando");
  assert.equal((ui.match(/Pago completado\. Tu quiniela ya tiene Plus\./g) || []).length, 1, "un solo sitio lo dice");
  // Espera: el aviso de límite no vende, la hoja no tiene botón.
  const aviso = cuerpoDe(ui, "function planWarningHtml(plan)");
  assert.ok(aviso.includes("!awaitingPayment()"));
  const hoja = cuerpoDe(ui, "function showUpgradeSheet(upgrade, ctx)");
  assert.ok(hoja.includes('const mode = !offer ? null : esperando ? "awaiting"'));
  assert.ok(hoja.includes('${mode === "card" ? `<button'), "botón sólo en modo tarjeta (nunca en espera)");
  const espera = cuerpoDe(ui, "function paymentAwaitingHtml(plan)");
  assert.ok(!/<button/.test(espera) && /No hace falta pagar otra vez/.test(espera));
  // Una sola recuperación a la vez, y la espera sobrevive a recargar.
  const bucle = cuerpoDe(ui, "async function runCheckoutRecovery(purchaseId, sessionHint, opts)");
  assert.ok(bucle.includes("if(checkoutRecoveryActive) return;"));
  assert.ok(bucle.includes("writePendingPurchase(purchaseId, false, sessionHint, true);"));
  // Un checkout abierto y no pagado no deja la pantalla en espera.
  const vuelta = cuerpoDe(ui, "async function resolveCheckoutReturn()");
  assert.ok(vuelta.includes("{ quiet: !awaiting }"));
});

test("RETORNO /a/ · la etiqueta Plus del encabezado sale del plan del servidor, sólo para Admin", () => {
  const ui = stripComments(INDEX);
  const app = cuerpoDe(ui, "function renderApp()");
  assert.ok(app.includes('${currentUser.isAdmin ? `<span class="qz-plan-badge" id="qz-plan-badge" ${planState && planState.plan === "PLUS" ? "" : "hidden"}>★ Plus</span>` : ``}'));
  assert.ok(app.includes("if(currentUser.isAdmin) loadPlan().then(paintPlanBadge)"));
  const paint = cuerpoDe(ui, "function paintPlanBadge(plan)");
  assert.ok(paint.includes('el.hidden = !(plan && plan.plan === "PLUS");'));
  // Debajo del nombre; al lado en móvil si cabe.
  assert.ok(INDEX.includes("#quiniela-root .qz-brand-line{ display:flex; flex-direction:column;"));
  assert.ok(/@media \(max-width: 640px\)\{\s*#quiniela-root \.qz-brand-line\{ flex-direction:row; flex-wrap:wrap;/.test(INDEX));
  // El display de la etiqueta no puede anular `hidden` (en Gratis se veía).
  assert.ok(INDEX.includes("#quiniela-root .qz-plan-badge[hidden]{ display:none; }"));
});

test("RETORNO /a/ · la recuperación del pago no repinta la aplicación entera", () => {
  // Con /a/ el organizador vuelve DIRECTO a Admin, cuyas vistas se pintan de
  // forma asíncrona: un render() completo desde la recuperación les cambiaba el
  // DOM a medio pintar (TypeError en renderAdminRondas). Sólo se refresca lo que
  // depende del plan.
  const ui = stripComments(INDEX);
  for (const f of ["async function runCheckoutRecovery(purchaseId, sessionHint, opts)",
    "async function checkPurchaseOnce(purchaseId, sessionHint)"]) {
    const b = cuerpoDe(ui, f);
    assert.ok(!/\brender\(\)/.test(b), f + " no llama a render()");
    assert.ok(b.includes("refreshPlanSurfaces()"), f + " refresca la franja y la etiqueta");
  }
  const r = cuerpoDe(ui, "async function refreshPlanSurfaces()");
  assert.ok(r.includes("paintPlanBadge(plan)") && r.includes("renderPlanStrip()"));
});
