// Sprint «Orientación de resultados»: el aviso de una jornada cerrada sin
// resultados, por plan y por lo que respondió el proveedor. Hoy QRACKS no
// consulta resultados por su cuenta: el aviso nunca dice «Esperando
// resultados» y sólo aparece cuando hay algo que hacer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
function fn(signature) {
  const start = html.indexOf(signature);
  assert.ok(start >= 0, "no encontré " + signature);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error("sin cierre: " + signature);
}
const block = html.slice(html.indexOf("  const CAPTURE_ORIENTATION_ROUNDS = 4;"), html.indexOf("  function wireResultsNotice(container){"));

const past = new Date(Date.now() - 3600e3).toISOString();
const R = (n, extra) => ({ id: "r" + n, number: n, deadline: past, published: true, resultsPublished: false, matches: [{ id: "m" + n + "a" }, { id: "m" + n + "b" }, { id: "m" + n + "c" }], ...extra });

function harness({ plan = { plan: "PLUS", tournament: { resultsRounds: 9 } }, league = "4350", rounds = [R(15), R(16)], lookup, isAdmin = true, planThrows = false } = {}) {
  let lookups = 0;
  const fetchCalls = [];
  const meta = { settings: { ...(league != null ? { sportsdbLeagueId: league } : {}) }, rounds, customBets: [], participants: [] };
  const api = new Function("meta", "currentUser", "loadPlan", "fetch", "SLUG", "setAuthHeaders", "adminOrOwnerCred", "isRoundLocked", "roundTitle", "customBetsLocked", "sportsDataFailureMessage", "esc",
    `${block}\nreturn { resultsNoticeInfo, resultsNoticeHtml, classifyRoundLookup };`)(
    meta, { isAdmin },
    async () => { if (planThrows) throw new Error("x"); return plan; },
    async (url) => { lookups++; fetchCalls.push(url); const d = typeof lookup === "function" ? lookup() : lookup; if (d === "throw") throw new Error("red"); return { ok: d && d.__status ? false : true, json: async () => d }; },
    "q1", (h) => h, () => "cred",
    (r) => new Date(r.deadline).getTime() < Date.now(), (r) => "Jornada " + r.number, () => false,
    (s) => (s ? "Proveedor caído (" + s + ")." : "No pudimos completar esta acción automáticamente. Puedes continuar manualmente."),
    (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
  return { ...api, lookups: () => lookups, fetchCalls };
}
const ok = (results, unscorable = {}) => ({ ok: true, reliabilityState: null, results, unscorable });
const sug = (...ids) => ids.map((matchId) => ({ matchId, result: "A", score: "1-0" }));

test("Gratis: captura manual durante las primeras 4 jornadas del torneo; después, sin aviso; nunca consulta al proveedor", async () => {
  for (const [n, shown] of [[0, true], [3, true], [4, false], [7, false]]) {
    const h = harness({ plan: { plan: "FREE", tournament: { resultsRounds: n } } });
    const info = await h.resultsNoticeInfo();
    assert.equal(!!info, shown, `${n} jornadas`);
    if (info) {
      assert.equal(info.kind, "manual");
      assert.equal(info.title, "Jornada 15 ya cerró", "nombra la jornada pendiente más antigua");
      assert.equal(info.roundId, "r15", "y el botón abre esa misma");
      assert.deepEqual(info.actions.map((a) => a.label), ["Capturar resultados"]);
    }
    assert.equal(h.lookups(), 0, "Gratis no consulta al proveedor desde Jornada");
  }
});

test("plan sin leer: se comporta como Gratis (orienta, sin consultar)", async () => {
  const h = harness({ planThrows: true });
  const info = await h.resultsNoticeInfo();
  assert.equal(info.kind, "manual");
  assert.equal(h.lookups(), 0);
});

test("Plus sin competencia guardada: captura manual siempre que haya una jornada cerrada sin resultados", async () => {
  const h = harness({ league: null, plan: { plan: "PLUS", tournament: { resultsRounds: 20 } } });
  const info = await h.resultsNoticeInfo();
  assert.equal(info.kind, "manual");
  assert.equal(h.lookups(), 0);
});

test("Plus con competencia: todos los marcadores → «Resultados disponibles» con «Revisar resultados» y «Capturar manualmente»", async () => {
  const h = harness({ lookup: ok({ r15: sug("m15a", "m15b", "m15c"), r16: [] }) });
  const info = await h.resultsNoticeInfo();
  assert.equal(info.kind, "available");
  assert.equal(info.title, "Resultados disponibles");
  assert.match(info.text, /^Jornada 15: el proveedor ya tiene los marcadores de todos los partidos\. Revísalos y publícalos\./);
  assert.deepEqual(info.actions.map((a) => [a.id, a.label, !!a.primary]), [["review", "Revisar resultados", true], ["manual", "Capturar manualmente", false]]);
  assert.equal(info.roundId, "r15");
  assert.equal(h.fetchCalls[0], "/api/quinielas/q1/sports-results", "el endpoint de lectura que ya existe");
});

test("Plus con competencia: faltan marcadores o hay dudas → «Hay resultados por revisar» con cuántos partidos", async () => {
  const partial = await harness({ lookup: ok({ r15: sug("m15a") }) }).resultsNoticeInfo();
  assert.equal(partial.kind, "review");
  assert.equal(partial.title, "Hay resultados por revisar");
  assert.match(partial.text, /^Jornada 15: 2 partidos requieren tu atención/);
  const doubt = await harness({ lookup: ok({ r15: sug("m15a", "m15b") }, { r15: [{ matchId: "m15c", reason: "extra_time_or_penalties" }] }) }).resultsNoticeInfo();
  assert.equal(doubt.kind, "review");
  assert.match(doubt.text, /^Jornada 15: 1 partido requiere tu atención/);
  const onlyDoubts = await harness({ lookup: ok({ r15: [] }, { r15: [{ matchId: "m15a", reason: "orientation_not_proven" }] }) }).resultsNoticeInfo();
  assert.equal(onlyDoubts.kind, "review", "un partido encontrado pero dudoso también requiere atención");
  assert.match(onlyDoubts.text, /3 partidos requieren/);
});

test("Plus con competencia: sin nada del proveedor → sin aviso (nunca «Esperando resultados»), salvo la orientación de las primeras jornadas", async () => {
  const later = await harness({ lookup: ok({ r15: [] }) }).resultsNoticeInfo();
  assert.equal(later, null);
  const early = await harness({ plan: { plan: "PLUS", tournament: { resultsRounds: 1 } }, lookup: ok({ r15: [] }) }).resultsNoticeInfo();
  assert.equal(early.kind, "manual");
  assert.match(early.text, /El proveedor todavía no tiene marcadores de esta jornada/);
  assert.doesNotMatch(block, /["`]Esperando resultados/, "el aviso no finge una consulta en segundo plano");
});

test("Plus con competencia: si el proveedor falla se dice, con «Capturar manualmente»; el fallo se recuerda sólo un minuto", async () => {
  for (const lookup of ["throw", { ok: false, reliabilityState: "provider_timeout" }, { __status: 500 }, null, "x"]) {
    const h = harness({ lookup });
    const info = await h.resultsNoticeInfo();
    assert.equal(info.kind, "error", JSON.stringify(lookup));
    assert.equal(info.title, "No pudimos consultar los resultados");
    assert.match(info.text, /^Jornada 15: /);
    assert.deepEqual(info.actions.map((a) => a.label), ["Capturar manualmente"]);
    await h.resultsNoticeInfo();
    assert.equal(h.lookups(), 1, "volver a Jornada enseguida no vuelve a consultar");
  }
  assert.match(block, /const RESULTS_LOOKUP_FAIL_TTL_MS = 60 \* 1000;/);
  assert.match(block, /const RESULTS_LOOKUP_TIMEOUT_MS = 6000;/, "la consulta tiene su propio tiempo límite");
});

test("competencia/temporada que el proveedor no tiene: captura manual (como la manda el servidor real: ok:false), y se recuerda", async () => {
  const h = harness({ lookup: { ok: false, reliabilityState: "competition_not_supported", results: {} } });
  const info = await h.resultsNoticeInfo();
  assert.equal(info.kind, "manual", "no es un fallo del proveedor");
  assert.equal(info.title, "Jornada 15 ya cerró");
  await h.resultsNoticeInfo();
  assert.equal(h.lookups(), 1);
});

test("una respuesta con forma inesperada no rompe Jornada", async () => {
  for (const results of [{ r15: "x" }, { r15: null }, { r15: [null, 3, { matchId: "m15a" }] }, "x", null]) {
    const info = await harness({ lookup: { ok: true, reliabilityState: null, results } }).resultsNoticeInfo();
    assert.ok(info === null || ["review", "available"].includes(info.kind), JSON.stringify(results));
  }
});

test("Plus: una respuesta buena se reutiliza unos minutos (no una consulta por visita)", async () => {
  const h = harness({ lookup: ok({ r15: sug("m15a") }) });
  await h.resultsNoticeInfo(); await h.resultsNoticeInfo(); await h.resultsNoticeInfo();
  assert.equal(h.lookups(), 1);
  assert.match(block, /const RESULTS_LOOKUP_TTL_MS = 3 \* 60 \* 1000;/);
});

test("sin aviso: participante, sin jornadas cerradas, jornada con resultados, borrador o jornada abierta", async () => {
  assert.equal(await harness({ isAdmin: false }).resultsNoticeInfo(), null);
  const fut = new Date(Date.now() + 3600e3).toISOString();
  assert.equal(await harness({ rounds: [R(15, { deadline: fut })] }).resultsNoticeInfo(), null, "abierta");
  assert.equal(await harness({ rounds: [R(15, { resultsPublished: true })] }).resultsNoticeInfo(), null, "con resultados");
  assert.equal(await harness({ rounds: [R(15, { published: false })] }).resultsNoticeInfo(), null, "borrador");
});

test("el aviso es discreto (no es «Siguiente paso»), escapa su texto y el botón lleva la jornada exacta", async () => {
  const h = harness({ lookup: ok({ r15: sug("m15a") }) });
  const out = h.resultsNoticeHtml({ kind: "review", roundId: 'r"15', title: "<b>t</b>", text: "x<y", actions: [{ id: "review", label: "Revisar resultados", primary: true }, { id: "manual", label: "Capturar manualmente" }] });
  assert.match(out, /<section class="qz-note qz-note--review"/);
  assert.doesNotMatch(out, /qz-next|Siguiente paso|btn-gold/);
  assert.match(out, /&lt;b&gt;t&lt;\/b&gt;/);
  assert.match(out, /data-results-go="review" data-round="r&quot;15">Revisar resultados<\/button>/);
  assert.match(out, /class="qz-linkbtn" data-results-go="manual" data-round="r&quot;15">Capturar manualmente<\/button>/, "la captura manual es secundaria");
  const wire = fn("function wireResultsNotice(container)");
  assert.ok(wire.includes("renderAdminResultados._target = b.dataset.round;"), "abre la jornada que nombra el aviso");
  assert.ok(wire.includes('if(b.dataset.resultsGo === "review" && memo && memo.ok){'), "al revisar, con las sugerencias ya recibidas");
  assert.ok(wire.includes("renderAdminResultados._bulkCache = null;"), "la captura manual no arrastra sugerencias de antes");
});

test("Jornada no espera al proveedor: se pinta y el aviso entra en su hueco; publicar olvida lo consultado", () => {
  const jornada = html.slice(html.indexOf('${screenHeaderHtml("jornada", "Jornada", inviteBtnHtml, !!nextStep)}'), html.indexOf('<div id="qz-pending-banner">'));
  assert.ok(jornada.includes('<div id="qz-results-note-slot"></div>'));
  assert.doesNotMatch(html, /await resultsNoticeInfo\(\)/, "nadie espera el aviso antes de pintar");
  assert.ok(html.includes("resultsNoticeInfo().then(info => {"));
  assert.equal((html.match(/invalidatePlan\(\); forgetResultsLookup\(\);/g) || []).length, 2, "fase regular y liguilla");
});

test("liguilla: «Revisar resultados» muestra en su formulario las sugerencias ya recibidas", () => {
  const lg = fn("function renderLiguillaResultados(");
  assert.ok(lg.includes("const bulkLg = editing && renderAdminResultados._bulkCache && renderAdminResultados._bulkCache[round.id];"));
  assert.ok(lg.includes("if(Array.isArray(bulkLg)) applyLgSuggestions("));
});
