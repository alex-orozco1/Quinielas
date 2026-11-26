// liguillaLigaMx.test.js — HOTFIX: la liguilla es EXCLUSIVA de Liga MX
// (TheSportsDB 4350), según la competencia guardada. Reglas puras del servidor
// (liguillaRules) y la regla compartida (liguillaScoring.isLigaMxSettings).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../liguillaScoring");
const R = require("../liguillaRules");

const NOW = "2026-11-20T00:00:00.000Z";
const RULES = { capture: "score", resultPoints: 1, exactBonus: 1 };
const LMX = "4350", PREMIER = "4328";
const match = (id) => ({ id, teamA: "Club " + id, teamB: "Rival " + id });
const regular = (id, n, over = {}) => ({ id, number: n, matches: [match("m" + id)], deadline: "2026-11-30T00:00:00Z", published: true, results: {}, ...over });
const lg = (id, n, over = {}) => ({ id, number: n, stage: "liguilla", phase: { round: "quarter", leg: "ida", source: "admin" }, matches: [match("a" + id), match("b" + id)], deadline: "2026-11-30T00:00:00Z", published: false, results: {}, ...over });
const meta = (league, over = {}) => ({ settings: { pointsPerCorrectPick: 1, ...(league === undefined ? {} : { sportsdbLeagueId: league }) }, rounds: [regular("r1", 1)], ...over });
const clone = (v) => JSON.parse(JSON.stringify(v));
function write(old, mutate, scopeId = "t1") {
  const merged = clone(old); mutate(merged);
  const out = R.applyLiguillaWrite({ oldValue: old, merged, scopeId, nowIso: NOW });
  return { out, merged };
}
const err = (w) => (w.out && w.out.ok === false ? [w.out.status, w.out.error] : "ok");

test("isLigaMxSettings: sólo la competencia guardada 4350; nada de respaldo", () => {
  assert.equal(L.LIGA_MX_LEAGUE_ID, "4350");
  for (const v of ["4350", 4350, " 4350 "]) assert.equal(L.isLigaMxSettings({ sportsdbLeagueId: v }), true, String(v));
  for (const v of ["4328", "43500", "", null, undefined, {}, ["4350"], true]) assert.equal(L.isLigaMxSettings({ sportsdbLeagueId: v }), false, JSON.stringify(v));
  for (const s of [null, undefined, {}, "4350", []]) assert.equal(L.isLigaMxSettings(s), false, JSON.stringify(s));
});

for (const [name, league] of [["Premier League", PREMIER], ["sin competencia", undefined], ["competencia vacía", ""]]) {
  test(`${name}: no se guardan reglas, no nace ni se publica liguilla, no se convierte una jornada`, () => {
    const old = meta(league);
    assert.deepEqual(err(write(old, (m) => { m.settings.liguilla = { ...RULES }; })), [409, "liguilla_not_available"], "reglas");
    assert.deepEqual(err(write(old, (m) => { m.rounds.push(lg("q1", 18)); })), [409, "liguilla_not_available"], "borrador nuevo");
    assert.deepEqual(err(write(old, (m) => { m.rounds.push(lg("q1", 18, { published: true })); })), [409, "liguilla_not_available"], "publicada nueva");
    const draft = meta(league, { rounds: [regular("r1", 1), regular("r2", 2, { published: false })] });
    assert.deepEqual(err(write(draft, (m) => { m.rounds[1].stage = "liguilla"; })), [409, "liguilla_not_available"], "cambiar el tipo");
    // La fase regular sigue igual.
    const ok = write(old, (m) => { m.rounds.push(regular("r2", 2)); m.rounds[0].results = { mr1: "A" }; m.rounds[0].resultsPublished = true; });
    assert.equal(err(ok), "ok");
    assert.equal(ok.merged.liguillaLocks, undefined);
  });
}

test("Liga MX: reglas, borrador, publicación y candado siguen funcionando", () => {
  const old = meta(LMX);
  const w1 = write(old, (m) => { m.settings.liguilla = { ...RULES }; m.rounds.push(lg("q1", 18)); });
  assert.equal(err(w1), "ok");
  const w2 = write(w1.merged, (m) => { m.rounds.find((r) => r.id === "q1").published = true; });
  assert.equal(err(w2), "ok");
  assert.deepEqual(w2.merged.liguillaLocks[0].rules, RULES);
  assert.deepEqual(w2.merged.rounds.find((r) => r.id === "q1").scoring, RULES);
});

test("datos históricos fuera de Liga MX: se conservan y se pueden leer y cerrar; nada nuevo", () => {
  // Una quiniela de otra competencia que ya tenía liguilla (anterior al hotfix).
  const old = meta(PREMIER, {
    settings: { pointsPerCorrectPick: 1, sportsdbLeagueId: PREMIER, liguilla: { ...RULES } },
    liguillaLocks: [{ scopeId: "t1", lockedAt: "2026-11-01T00:00:00Z", roundId: "q1", roundNumber: 18, rules: { ...RULES } }],
    liguillaPublished: { q1: { deadline: "2026-11-10T00:00:00Z", matchIds: ["aq1", "bq1"], scoring: { ...RULES } } },
    rounds: [regular("r1", 1), lg("q1", 18, { published: true, deadline: "2026-11-10T00:00:00Z", scoring: { ...RULES } }), lg("q2", 19)],
  });
  // Un guardado que no toca la liguilla pasa, y no borra ni cambia nada de ella.
  const plain = write(old, (m) => { m.groupName = "Otro nombre"; });
  assert.equal(err(plain), "ok");
  assert.deepEqual(plain.merged.settings.liguilla, RULES);
  assert.deepEqual(plain.merged.rounds.find((r) => r.id === "q1").scoring, RULES);
  assert.equal(plain.merged.rounds.find((r) => r.id === "q2").stage, "liguilla", "el borrador existente conserva su tipo");
  assert.deepEqual(plain.merged.liguillaLocks, old.liguillaLocks);
  // Los resultados de la jornada ya publicada se pueden capturar (cerrar lo empezado).
  const res = write(old, (m) => { Object.assign(m.rounds.find((r) => r.id === "q1"), { resultsPublished: true, results: { aq1: "A", bq1: "D" }, scores: { aq1: { a: 2, b: 1 }, bq1: { a: 0, b: 0 } }, matchStatus: {} }); });
  assert.equal(err(res), "ok");
  // Nada nuevo: ni publicar el borrador, ni cambiar reglas, ni otra jornada de liguilla.
  assert.deepEqual(err(write(old, (m) => { m.rounds.find((r) => r.id === "q2").published = true; })), [409, "liguilla_not_available"]);
  assert.deepEqual(err(write(old, (m) => { m.settings.liguilla = { capture: "score", resultPoints: 3, exactBonus: 1 }; })), [409, "liguilla_not_available"]);
  assert.deepEqual(err(write(old, (m) => { m.rounds.push(lg("q3", 20)); })), [409, "liguilla_not_available"]);
  // Ni la corrección de puntuación del propietario.
  const c = R.correctLiguillaRules({ value: old, scopeId: "t1", expected: RULES, next: { resultPoints: 2, exactBonus: 1 }, nowIso: NOW });
  assert.deepEqual([c.status, c.error], [409, "liguilla_not_available"]);
});

test("cambio de competencia: con liguilla en curso se bloquea en las dos direcciones y a «sin competencia»", () => {
  const conLg = meta(LMX, { settings: { sportsdbLeagueId: LMX, liguilla: { ...RULES } }, rounds: [regular("r1", 1), lg("q1", 18)] });
  assert.deepEqual(err(write(conLg, (m) => { m.settings.sportsdbLeagueId = PREMIER; })), [409, "liguilla_league_change_blocked"], "Liga MX → Premier");
  assert.deepEqual(err(write(conLg, (m) => { delete m.settings.sportsdbLeagueId; })), [409, "liguilla_league_change_blocked"], "Liga MX → sin competencia");
  const conCandado = meta(LMX, { liguillaLocks: [{ scopeId: "t1", rules: { ...RULES } }] });
  assert.deepEqual(err(write(conCandado, (m) => { m.settings.sportsdbLeagueId = PREMIER; })), [409, "liguilla_league_change_blocked"], "candado sin jornada en el tablero");
  const historico = meta(PREMIER, { rounds: [regular("r1", 1), lg("q1", 18)] });
  assert.deepEqual(err(write(historico, (m) => { m.settings.sportsdbLeagueId = LMX; })), [409, "liguilla_league_change_blocked"], "Premier con liguilla → Liga MX");
  // Un candado de un torneo anterior no impide cambiar en el torneo nuevo.
  const anterior = meta(LMX, { liguillaLocks: [{ scopeId: "t0", rules: { ...RULES } }] });
  assert.equal(err(write(anterior, (m) => { m.settings.sportsdbLeagueId = PREMIER; })), "ok");
  // Sin liguilla, el cambio no lo bloquea este módulo (lo decide la política comercial de siempre).
  assert.equal(err(write(meta(LMX), (m) => { m.settings.sportsdbLeagueId = PREMIER; })), "ok");
  assert.equal(err(write(meta(PREMIER), (m) => { m.settings.sportsdbLeagueId = LMX; })), "ok");
  assert.equal(err(write(meta(undefined), (m) => { m.settings.sportsdbLeagueId = LMX; })), "ok");
});

test("cambiar a Liga MX y estrenar liguilla en el MISMO guardado no se acepta; en el siguiente sí", () => {
  const prem = meta(PREMIER);
  assert.deepEqual(err(write(prem, (m) => { m.settings.sportsdbLeagueId = LMX; m.settings.liguilla = { ...RULES }; })), [409, "liguilla_not_available"]);
  assert.deepEqual(err(write(prem, (m) => { m.settings.sportsdbLeagueId = LMX; m.rounds.push(lg("q1", 18)); })), [409, "liguilla_not_available"]);
  const now = write(prem, (m) => { m.settings.sportsdbLeagueId = LMX; });
  assert.equal(err(now), "ok");
  assert.equal(err(write(now.merged, (m) => { m.settings.liguilla = { ...RULES }; })), "ok");
  // Al revés: salir de Liga MX y guardar reglas en la misma escritura tampoco.
  assert.deepEqual(err(write(meta(LMX), (m) => { m.settings.sportsdbLeagueId = PREMIER; m.settings.liguilla = { ...RULES }; })), [409, "liguilla_not_available"]);
});

test("UI: una sola regla (lgAvailable → isLigaMxSettings) decide tarjeta, editor, organizar, sugerencia y publicar", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const fn = src.slice(src.indexOf("function lgAvailable(){"), src.indexOf("function lgAvailable(){") + 200);
  assert.ok(fn.includes("LG.isLigaMxSettings(meta.settings)"), "usa la regla compartida con la competencia guardada");
  assert.ok(!/\|\|\s*"4350"/.test(fn), "sin respaldo 4350");
  assert.ok(src.includes("${lgAvailable() ? reglasLiguillaCardHtml(st.lg, unlocked, noPasswordYet) : ``}"), "tarjeta en Tus reglas");
  assert.ok(src.includes("if(lgAvailable()) wireReglasLiguilla(body, st.lg, repaint, saveProtected);"));
  assert.ok(src.includes('if(!lgAvailable() && !(editingRound && editingRound.stage === "liguilla")) return "";'), "editor de fase");
  assert.ok(src.includes('const liguilla = f.stage === "liguilla" && lgAvailable();'), "jornada nueva");
  assert.ok(src.includes("const lgTopCardsHtml = !lgAvailable() ? lgStagedHtml() :"), "organizar liguilla");
  assert.ok(src.includes('r.published === false && lgAvailable() ? " · ¿es de liguilla? márcala en Editar"'), "sugerencia en la lista");
  const gate = src.slice(src.indexOf("async function lgPublishGate(round){"), src.indexOf("async function lgPublishGate(round){") + 400);
  assert.ok(gate.includes("if(!lgAvailable()){ toast(ERROR_MESSAGES.liguilla_not_available"), "publicar no lleva a una configuración inexistente");
  assert.ok(src.includes('liguilla_not_available: "La liguilla sólo está disponible para quinielas de Liga MX."'));
  assert.ok(src.includes("liguilla_league_change_blocked:"));
});
