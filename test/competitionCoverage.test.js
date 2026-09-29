// MON-003 · cobertura de Plus por competencia.
//
// Plus cubre el torneo completo de la quiniela —fases finales incluidas— y la
// frase que lo dice sale de UNA configuración del servidor
// (competitionCoverage.js), igual en Ajustes, en la oferta, en el paywall y en
// el checkout. Antes la oferta decía "18 jornadas" y el servidor cortaba a un
// Plus sin competencia ligada en la jornada 19: en una Liga MX, a mitad de la
// liguilla.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const C = require("../competitionCoverage");
const {
  DEFAULT_COMMERCIAL_CONFIG: cfg, buildFreeEntitlement, buildPlusEntitlement,
  buildManualGrantEntitlement, buildGrandfatheredEntitlement,
  checkLifecycleRoundConsumption, summarizePlan, buildUpgradeOffer, roundBudgetApplies,
} = require("../planLimits");
const D = require("../payments/paymentsDomain");
const { buildCheckoutParams } = require("../payments/stripeAdapter");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const coverageSrc = fs.readFileSync(path.join(ROOT, "competitionCoverage.js"), "utf8");

const LIGA_MX = C.coverageFor("thesportsdb", "4350");
const PREMIER = C.coverageFor("thesportsdb", "4328");
const UCL = C.coverageFor("thesportsdb", "4480");
const MANUAL = C.coverageFor(null, null);

// Lo que hace el servidor con los ajustes de la quiniela (server.js,
// plusCoverageOf): el campo del proveedor de hoy -> "thesportsdb" + id.
const plusCoverageOf = new Function("competitionCoverage",
  serverSrc.slice(serverSrc.indexOf("function plusCoverageOf(settings) {"),
    serverSrc.indexOf("async function checkoutModeFor(")) + "; return plusCoverageOf;")(C);

// ==== 1. la frase, por competencia ==========================================

test("COBERTURA · Liga MX: el torneo completo, incluida la liguilla", () => {
  assert.equal(LIGA_MX.known, true);
  assert.equal(LIGA_MX.format, C.FORMAT.LEAGUE_WITH_PLAYOFFS);
  assert.equal(C.plusCoverageText(50, LIGA_MX), "hasta 50 personas y el torneo completo, incluida la liguilla");
  assert.equal(buildUpgradeOffer(buildFreeEntitlement(cfg), cfg, { coverage: LIGA_MX }).coverageText,
    "hasta 50 personas y el torneo completo, incluida la liguilla");
});

test("COBERTURA · liga europea (Premier, La Liga, Bundesliga, Serie A, Ligue 1): el torneo completo", () => {
  for (const id of ["4328", "4335", "4331", "4332", "4334"]) {
    const c = C.coverageFor("thesportsdb", id);
    assert.equal(c.known, true, id);
    assert.equal(c.format, C.FORMAT.LEAGUE, id);
    assert.equal(C.plusCoverageText(50, c), "hasta 50 personas y el torneo completo", id);
  }
});

test("COBERTURA · Champions: el torneo completo, incluidas las eliminatorias", () => {
  assert.equal(UCL.format, C.FORMAT.LEAGUE_PHASE_AND_KNOCKOUT);
  assert.equal(C.plusCoverageText(50, UCL), "hasta 50 personas y el torneo completo, incluidas las eliminatorias");
});

test("COBERTURA · manual o desconocida: la frase genérica, sin fases ni cantidades inventadas", () => {
  for (const c of [MANUAL, C.coverageFor("thesportsdb", "9999999"), C.coverageFor("thesportsdb", ""),
    C.coverageFor("otro", "4350"), C.coverageFor("thesportsdb", "4350:2026"), C.coverageFor(null, "4350")]) {
    assert.equal(c.known, false);
    assert.equal(c.name, null);
    assert.equal(C.plusCoverageText(50, c), "hasta 50 personas y el torneo completo");
  }
  // Y lo que hace el servidor con una quiniela sin liga.
  assert.equal(plusCoverageOf({}).known, false);
  assert.equal(plusCoverageOf(undefined).known, false);
  assert.equal(plusCoverageOf({ sportsdbLeagueId: "4350" }).scope, "el torneo completo, incluida la liguilla");
  assert.equal(plusCoverageOf({ sportsdbLeagueId: "4480" }).scope, "el torneo completo, incluidas las eliminatorias");
});

test("COBERTURA · un número de jornadas sólo si está configurado Y es la competencia entera", () => {
  // Hoy ninguna competencia lo tiene: "el torneo completo" es siempre cierto.
  for (const [k, e] of Object.entries(C.COVERAGE_CATALOG)) assert.equal(e.roundCount, null, k);
  // La regla: sólo en una liga sin fases finales.
  assert.equal(C.scopePhrase({ format: C.FORMAT.LEAGUE, finalPhases: null, roundCount: 38 }), "el torneo completo (38 jornadas)");
  assert.equal(C.scopePhrase({ format: C.FORMAT.LEAGUE_WITH_PLAYOFFS, finalPhases: "incluida la liguilla", roundCount: 17 }),
    "el torneo completo, incluida la liguilla", "con liguilla el número NO es la competencia entera");
  assert.equal(C.scopePhrase({ format: C.FORMAT.LEAGUE_PHASE_AND_KNOCKOUT, finalPhases: null, roundCount: 8 }), "el torneo completo");
});

test("COBERTURA · sale de la configuración, NUNCA de los eventos de la API deportiva", () => {
  const code = coverageSrc.replace(/\/\/[^\n]*/g, "");
  assert.ok(!/require\(/.test(code), "puro: no importa proveedores ni nada con I/O");
  assert.ok(!/fetch|events|fixtures|http/i.test(code));
  assert.ok(Object.isFrozen(C.COVERAGE_CATALOG));
  for (const e of Object.values(C.COVERAGE_CATALOG)) assert.ok(Object.isFrozen(e));
});

test("COBERTURA · cada liga del selector tiene su entrada (MLS u otra nueva no puede entrar sin ella)", () => {
  const block = indexSrc.slice(indexSrc.indexOf("const SPORTSDB_LEAGUES = ["), indexSrc.indexOf("];", indexSrc.indexOf("const SPORTSDB_LEAGUES = [")));
  const ids = [...block.matchAll(/id: "([0-9]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 7);
  for (const id of ids) assert.equal(C.coverageFor("thesportsdb", id).known, true, `falta cobertura para ${id}`);
  // Y el procedimiento para la MLS está escrito donde vive el catálogo.
  assert.ok(coverageSrc.includes("MLS"));
  assert.ok(coverageSrc.includes("FORMAT.LEAGUE_WITH_PLAYOFFS"));
});

// ==== 2. el límite que aplica el servidor ====================================

test("LÍMITE · una regla: Plus nunca cuenta jornadas; Gratis siempre; especiales como antes", () => {
  const free = buildFreeEntitlement(cfg);
  assert.equal(roundBudgetApplies(free), true);
  assert.equal(roundBudgetApplies({ ...free, competitionIdentity: "4350:2026-2027" }), true, "una liga no saca de Gratis");
  assert.equal(roundBudgetApplies(buildPlusEntitlement(cfg)), false, "Plus sin competencia");
  assert.equal(roundBudgetApplies(buildPlusEntitlement(cfg, null, { competitionIdentity: "4350:x" })), false);
  const grant = buildManualGrantEntitlement(null, { participantLimit: 20, manualRoundLimit: 9, grantedBy: "platform:x" });
  assert.equal(roundBudgetApplies(grant), true, "MANUAL_GRANT conserva sus números");
  assert.equal(roundBudgetApplies({ ...grant, competitionIdentity: "4350:x" }), false);
  assert.equal(roundBudgetApplies(buildGrandfatheredEntitlement()), true);
  assert.equal(roundBudgetApplies(null), true, "sin entitlement: nunca ilimitado");
  // Gratis sigue en 7, con o sin liga.
  assert.equal(checkLifecycleRoundConsumption(free, cfg, 7, 1).allowed, false);
  // Y el Admin ve exactamente lo mismo que se aplica.
  assert.ok(fs.readFileSync(path.join(ROOT, "planLimits.js"), "utf8").includes("const roundsApply = roundBudgetApplies(entitlement);"));
});

const E1 = "ts:1:football:thesportsdb:4350:e1";
const E2 = "ts:1:football:thesportsdb:4350:e2";

test("LÍMITE · Liga MX: 17 jornadas + play-in + liguilla (ida y vuelta) sin tocar ningún tope", () => {
  for (const bound of ["4350:2026-2027", null]) {
    const plus = { ...buildPlusEntitlement(cfg, null, { competitionIdentity: bound }), scopeId: E1 };
    let consumed = 0;
    // Regular 17, play-in 1, cuartos ida/vuelta 2, semis 2, final 2 = 24; y margen.
    for (let n = 1; n <= 30; n++) {
      const r = checkLifecycleRoundConsumption(plus, cfg, consumed, 1, { currentScopeId: E1 });
      assert.equal(r.allowed, true, `jornada/fase ${n} (${bound ? "con" : "sin"} competencia ligada)`);
      consumed++;
    }
  }
});

test("LÍMITE · Champions: fase de liga + playoff + octavos..final, ida y vuelta, todo cubierto", () => {
  const plus = { ...buildPlusEntitlement(cfg, null, { competitionIdentity: "4480:2026-2027" }), scopeId: E1 };
  // 8 jornadas de fase de liga + 2 playoff + 2 octavos + 2 cuartos + 2 semis + 1 final = 17 — y una liga
  // europea son 38: ambas por encima o cerca del viejo 18, ninguna se corta.
  assert.equal(checkLifecycleRoundConsumption(plus, cfg, 16, 1, { currentScopeId: E1 }).allowed, true);
  assert.equal(checkLifecycleRoundConsumption(plus, cfg, 37, 1, { currentScopeId: E1 }).allowed, true);
});

test("LÍMITE · el alcance por ciclo se conserva: el Plus de un torneo no cubre el siguiente", () => {
  const plus = { ...buildPlusEntitlement(cfg), scopeId: E1 };
  const r = checkLifecycleRoundConsumption(plus, cfg, 0, 1, { currentScopeId: E2 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "entitlement_scope_mismatch");
  // Y el torneo nuevo arranca en Gratis (MON-002C): el reset sigue en el servidor.
  assert.ok(serverSrc.includes('freshEntitlement.reason = "Torneo nuevo: el plan anterior no se transfiere.";'));
});

// ==== 3. la misma frase en Ajustes, oferta, paywall y checkout ================

test("UNIFICADO · /plan, los dos paywalls y la compra usan la cobertura de la competencia seleccionada", () => {
  assert.equal((serverSrc.match(/coverage: plusCoverageOf\(mergedValue\.settings\),/g) || []).length, 2, "paywalls 402");
  assert.ok(serverSrc.includes("coverage: plusCoverageOf(meta.settings),"), "/plan (Ajustes, franja, hoja)");
  assert.ok(serverSrc.includes("coverageText: competitionCoverage.plusCoverageText(plus.participantLimit, plusCoverageOf(settings)),"),
    "la oferta del checkout, con los ajustes de ESA quiniela");
  assert.ok(serverSrc.includes("      coverageText: offer.coverageText,"), "y la compra congela ESA frase");
  // El resumen de un Plus lleva la misma frase que su oferta.
  const s = summarizePlan({ ...buildPlusEntitlement(cfg) }, cfg, { participantsUsed: 3, roundsUsed: 25 }, { coverage: LIGA_MX });
  assert.equal(s.coverage.text, "hasta 50 personas y el torneo completo, incluida la liguilla");
  assert.equal(s.coverage.scope, "el torneo completo, incluida la liguilla");
  assert.equal(s.rounds.applies, false);
  assert.equal(summarizePlan(buildFreeEntitlement(cfg), cfg, {}, { coverage: LIGA_MX }).coverage, null);
});

test("UNIFICADO · las pantallas pintan la frase del servidor, sin número de jornadas propio", () => {
  const pitch = indexSrc.slice(indexSrc.indexOf("function plusPitch(offer){"), indexSrc.indexOf("function plusPitch(offer){") + 400);
  assert.ok(pitch.includes("offer.coverageText"));
  assert.ok(!/jornadas/.test(pitch.replace(/\/\/[^\n]*/g, "")));
  assert.ok(indexSrc.includes("const unlocks = plusPitch(offer);"), "hoja / paywall");
  assert.ok(indexSrc.includes("const pitch = plusPitch(offer);"), "Ajustes (Gratis)");
  assert.ok(indexSrc.includes("`Tu quiniela tiene Plus: ${plan.coverage.text}.`"), "Ajustes (Plus)");
  assert.ok(indexSrc.includes("bits.push(`cubre ${esc(plan.coverage.scope)}`);"), "franja del Admin (Plus)");
});

test("UNIFICADO · checkout: la descripción del producto es la cobertura congelada en la compra", () => {
  const intent = D.makePurchaseIntent({ purchaseId: "p1", slug: "s", scopeId: E1, configVersion: 1,
    expectedAmountMinor: 19900, currency: "mxn", provider: "stripe", participantLimit: 50, manualRoundLimit: 18,
    coverageText: C.plusCoverageText(50, LIGA_MX) });
  assert.equal(intent.purchased.coverageText, "hasta 50 personas y el torneo completo, incluida la liguilla");
  const desc = D.productDescriptionForIntent(intent);
  assert.equal(desc, "Plus para esta quiniela: hasta 50 personas y el torneo completo, incluida la liguilla. Un solo pago.");
  const base = { amountMinor: 19900, currency: "mxn", productName: "QRACKS Plus", purchaseId: "p1", slug: "s",
    scopeId: E1, successUrl: "https://x/a/s", cancelUrl: "https://x/a/s", expiresAt: 1, attemptTag: "k" };
  assert.equal(buildCheckoutParams({ ...base, productDescription: desc })["line_items[0][price_data][product_data][description]"], desc);
  assert.ok(!("line_items[0][price_data][product_data][description]" in buildCheckoutParams(base)),
    "sin descripción congelada, el mismo cuerpo de siempre");
  // Basura no entra ni en la compra ni en la página de pago.
  for (const bad of ["", "   ", "<script>", "a\nb", "x".repeat(201), 42, null]) {
    const i = D.makePurchaseIntent({ purchaseId: "p2", slug: "s", scopeId: E1, configVersion: 1,
      expectedAmountMinor: 19900, currency: "mxn", provider: "stripe", participantLimit: 50, manualRoundLimit: 18, coverageText: bad });
    assert.equal(i.purchased.coverageText, null, JSON.stringify(bad));
    assert.equal(D.productDescriptionForIntent(i), null);
  }
});

test("UNIFICADO · la descripción es parámetro de la clave: se congela por intento y se hereda al repetir", () => {
  const at = "2026-09-29T10:00:00.000Z";
  assert.equal(D.creationAttemptsOf({ attempts: [{ seq: 1, at, idempotencyKey: "k", expiresAt: 1, description: "Plus para esta quiniela: x. Un solo pago." }] })[0].description,
    "Plus para esta quiniela: x. Un solo pago.");
  assert.equal(D.creationAttemptsOf({ attempts: [{ seq: 1, at, idempotencyKey: "k", expiresAt: 1 }] })[0].description, null,
    "una emisión anterior se repite sin descripción");
  assert.equal(D.creationAttemptsOf({ attempts: [{ seq: 1, at, idempotencyKey: "k", expiresAt: 1, description: "<b>" }] })[0].description, null);
  const rec = serverSrc.slice(serverSrc.indexOf("async function recordCreationAttempt(purchaseId, nowMs)"));
  assert.ok(rec.includes("description: d.from.description || null }"), "al repetir, la de la clave");
  assert.ok(rec.includes("description: paymentsDomain.productDescriptionForIntent(actual) };"), "al estrenar, la de la compra");
  assert.ok(rec.includes("...(x.description ? { description: x.description } : {})"), "se conserva al reescribir la fila");
  assert.ok(serverSrc.includes("productDescription: attempt.description || null,"), "y viaja al proveedor desde el intento");
});

test("UNIFICADO · una compra abierta que dice cubrir OTRA competencia no se reutiliza", () => {
  // Fix de copy dinámico: la página de pago de una compra abierta tiene que decir
  // la competencia de ESA quiniela. Si la quiniela cambió de competencia (manual ->
  // Liga MX es un cambio permitido), la compra vieja no se reutiliza: se sustituye
  // por el camino ya probado de C08. Una compra anterior a la frase no describe
  // nada en su página, así que no miente y sigue reutilizándose (sin forzar
  // sustituciones al desplegar).
  const fnSrc = serverSrc.slice(serverSrc.indexOf("function sameOffer(purchase, offer)"), serverSrc.indexOf("// Suelta el turno PROPIO."));
  const sameOffer = new Function(`${fnSrc}; return sameOffer;`)();
  const offer = { amountMinor: 19900, participantLimit: 50, manualRoundLimit: 18,
    coverageText: "hasta 50 personas y el torneo completo, incluida la liguilla" };
  const compra = (coverageText) => ({ expectedAmountMinor: 19900,
    purchased: { participantLimit: 50, manualRoundLimit: 18, coverageText } });
  assert.equal(sameOffer(compra(offer.coverageText), offer), true, "misma competencia: se reutiliza");
  assert.equal(sameOffer(compra("hasta 50 personas y el torneo completo"), offer), false, "otra competencia: no");
  assert.equal(sameOffer(compra(null), offer), true, "compra anterior sin frase: se reutiliza");
  assert.equal(sameOffer(compra(undefined), offer), true);
});

// ==== 4. Fix de copy dinámico: lo que se VE sale de la competencia de ESA quiniela ====
//
// Encontrado en la UI: "Plan Plus · 1 de 50 personas · cubre el torneo completo,
// incluida la liguilla" en una quiniela que no era de Liga MX. La frase venía del
// servidor, pero la competencia que el servidor leía la había escrito la pantalla
// de Ajustes: su selector no tenía "Sin definir" y caía en Liga MX (`|| "4350"`),
// así que "Guardar ajustes" convertía una quiniela manual en Liga MX.

// El camino entero: ajustes de la quiniela -> servidor (plusCoverageOf +
// summarizePlan) -> la línea que pinta la franja del Admin (planStatusHtml, el
// código real de public/index.html).
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const planStatusHtml = new Function("esc", "planOfferCtaHtml",
  indexSrc.slice(indexSrc.indexOf("  function planStatusHtml(plan){"), indexSrc.indexOf("  // MON-003. Qué da Plus, en UNA frase"))
  + "; return planStatusHtml;")(esc, () => "");
const plusPitch = new Function(
  indexSrc.slice(indexSrc.indexOf("  function plusPitch(offer){"), indexSrc.indexOf("  // MON-003. La puerta FIJA a la oferta Plus."))
  + "; return plusPitch;")();
function vistaDe(settings) {
  const cov = plusCoverageOf(settings);
  const plus = summarizePlan(buildPlusEntitlement(cfg), cfg, { participantsUsed: 1, roundsUsed: 3 }, { coverage: cov });
  const free = summarizePlan(buildFreeEntitlement(cfg), cfg, { participantsUsed: 1, roundsUsed: 1 }, { coverage: cov });
  return {
    franja: planStatusHtml(plus).replace(/<[^>]+>/g, ""),
    oferta: plusPitch(free.upgrade),
    ajustesPlus: `Tu quiniela tiene Plus: ${plus.coverage.text}.`,
  };
}

test("COPY DINÁMICO · 1. Liga MX -> \"incluida la liguilla\" (franja, oferta, Ajustes)", () => {
  const v = vistaDe({ sportsdbLeagueId: "4350" });
  assert.equal(v.franja, "Plan Plus · 1 de 50 personas · cubre el torneo completo, incluida la liguilla");
  assert.equal(v.oferta, "Con Plus: hasta 50 personas y el torneo completo, incluida la liguilla.");
  assert.match(v.ajustesPlus, /incluida la liguilla\.$/);
});

test("COPY DINÁMICO · 2. Premier (y el resto de ligas europeas) -> sin \"liguilla\"", () => {
  for (const id of ["4328", "4335", "4331", "4332", "4334"]) {
    const v = vistaDe({ sportsdbLeagueId: id });
    assert.equal(v.franja, "Plan Plus · 1 de 50 personas · cubre el torneo completo", id);
    assert.equal(v.oferta, "Con Plus: hasta 50 personas y el torneo completo.", id);
    for (const t of Object.values(v)) assert.ok(!/liguilla|eliminatorias/i.test(t), `${id}: ${t}`);
  }
});

test("COPY DINÁMICO · 3. Champions -> \"incluidas las eliminatorias\"", () => {
  const v = vistaDe({ sportsdbLeagueId: "4480" });
  assert.equal(v.franja, "Plan Plus · 1 de 50 personas · cubre el torneo completo, incluidas las eliminatorias");
  assert.equal(v.oferta, "Con Plus: hasta 50 personas y el torneo completo, incluidas las eliminatorias.");
  for (const t of Object.values(v)) assert.ok(!/liguilla/i.test(t), t);
});

test("COPY DINÁMICO · 4. manual o desconocida -> sin \"liguilla\"", () => {
  for (const settings of [{}, { sportsdbLeagueId: "" }, { sportsdbLeagueId: null }, undefined,
    { sportsdbLeagueId: "999999" }, { sportsdbLeagueId: "4350x" }]) {
    const v = vistaDe(settings);
    assert.equal(v.franja, "Plan Plus · 1 de 50 personas · cubre el torneo completo", JSON.stringify(settings));
    for (const t of Object.values(v)) assert.ok(!/liguilla|eliminatorias/i.test(t), `${JSON.stringify(settings)}: ${t}`);
  }
});

test("COPY DINÁMICO · el frontend no tiene ninguna frase de cobertura propia", () => {
  // Código de la pantalla, sin comentarios: ni "liguilla" ni "eliminatorias".
  const code = indexSrc.replace(/<!--[\s\S]*?-->/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => { const i = l.search(/(^|[^:])\/\//); return i === -1 ? l : l.slice(0, i + 1); }).join("\n");
  assert.ok(!/liguilla/i.test(code), "ningún 'liguilla' fuera de comentarios en public/index.html");
  assert.ok(!/eliminatorias/i.test(code), "ningún 'eliminatorias' fuera de comentarios");
  // Y en el servidor la frase sólo vive en el catálogo.
  for (const f of ["server.js", "planLimits.js", "platformState.js", "payments/paymentsDomain.js", "payments/stripeAdapter.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/incluida la liguilla|incluidas las eliminatorias/.test(src), f);
  }
});

test("COPY DINÁMICO · causa raíz: Ajustes ya no convierte una quiniela sin liga en Liga MX", () => {
  const sel = indexSrc.slice(indexSrc.indexOf('<select id="qz-sportsdb-league">'), indexSrc.indexOf("</select>", indexSrc.indexOf('<select id="qz-sportsdb-league">')));
  assert.ok(sel.includes('<option value="" ${meta.settings.sportsdbLeagueId ? "" : "selected"}>Sin definir</option>'));
  assert.ok(!sel.includes('|| "4350"'), "sin liga guardada no se preselecciona Liga MX");
  assert.ok(sel.includes('meta.settings.sportsdbLeagueId === l.id ? "selected" : ""'));
  // Guardar con "Sin definir" manda "" y el servidor lo trata como sin liga (no hay
  // cambio que bloquear y no se adopta ninguna competencia).
  assert.ok(indexSrc.includes('meta.settings.sportsdbLeagueId = document.getElementById("qz-sportsdb-league").value;'));
  assert.ok(serverSrc.includes("const leagueOrSeasonChanged = (oldLeagueId || null) !== (newLeagueId || null)"));
  assert.ok(serverSrc.includes("if (newLeagueId && !entry.entitlement.competitionIdentity) {"));
});

test("COPY DINÁMICO · el plan en memoria es de ESA quiniela y posterior a cualquier cambio", () => {
  const load = indexSrc.slice(indexSrc.indexOf("  async function loadPlan(opts){"), indexSrc.indexOf("  // ---------- MON-003: el pago ----------"));
  assert.ok(load.includes("if(planStateSlug !== SLUG){ planState = null; planStateSlug = SLUG; }"));
  assert.ok(load.includes("if(gen === planGen && slugAlPedir === SLUG){ planState = leido; return leido; }"),
    "una lectura de antes de invalidar no se cachea ni se entrega");
  assert.ok(indexSrc.includes("function invalidatePlan(){ planState = null; planGen++; }"));
});
