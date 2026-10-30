// Sprint de liguilla (D1–D7): pruebas puras de puntos, reglas del servidor,
// pronósticos por partido, marcador sin tanda y organización de ida y vuelta.
// Las pruebas contra PostgreSQL real están en liguillaSprint.integration.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");

const L = require("../liguillaScoring");
const R = require("../liguillaRules");
const { buildScoreContract, SCORE_PHASE } = require("../scoreContract");
const { planCompetitionSync, phaseFromFixture } = require("../competitionSync");
const D = require("./liguillaDataset");
const sportmonks = require("../providers/sportmonksAdapter");

const line = (phase, side, goals) => ({ phase, side, goals });
const both = (phase, h, a) => [line(phase, "home", h), line(phase, "away", a)];

const RULES_BOTH = { capture: "score", resultPoints: 1, exactBonus: 1 };
const RULES_EXACT_ONLY = { capture: "score", resultPoints: 0, exactBonus: 1 };
const RULES_RESULT_ONLY = { capture: "score", resultPoints: 1, exactBonus: 0 };
const s = (a, b) => ({ a, b });
const score = (rules, pick, real) => L.scoreMatch({
  rules, pickScore: pick, pick: L.outcomeOfScore(pick), result: L.outcomeOfScore(real), resultScore: real,
  status: null, published: true,
}).total;

// ---- puntos: la tabla aprobada en las tres combinaciones ------------------

test("PUNTOS · tabla aprobada: resultado 1 + bono 1, sólo exacto, sólo resultado", () => {
  const cases = [
    // real,   pronóstico, ambos, sólo exacto, sólo resultado
    [s(2, 1), s(3, 1), 1, 0, 1],
    [s(2, 1), s(2, 1), 2, 1, 1],
    [s(1, 1), s(2, 2), 1, 0, 1],
    [s(1, 1), s(1, 1), 2, 1, 1],
    [s(2, 1), s(0, 1), 0, 0, 0],
  ];
  for (const [real, pick, both, exact, result] of cases) {
    assert.equal(score(RULES_BOTH, pick, real), both, `ambos ${JSON.stringify([real, pick])}`);
    assert.equal(score(RULES_EXACT_ONLY, pick, real), exact, `sólo exacto ${JSON.stringify([real, pick])}`);
    assert.equal(score(RULES_RESULT_ONLY, pick, real), result, `sólo resultado ${JSON.stringify([real, pick])}`);
  }
});

test("PUNTOS · resultado 1 + bono 3: un exacto vale 4 y el desglose dice base y bono", () => {
  const out = L.scoreMatch({ rules: { capture: "score", resultPoints: 1, exactBonus: 3 },
    pickScore: s(2, 1), pick: "A", result: "A", resultScore: s(2, 1), published: true });
  assert.deepEqual({ base: out.base, bonus: out.bonus, total: out.total, resultHit: out.resultHit, exactHit: out.exactHit },
    { base: 1, bonus: 3, total: 4, resultHit: true, exactHit: true });
});

test("PUNTOS · con marcador, el 1X2 sale de los goles aunque el pick guardado diga otra cosa", () => {
  const out = L.scoreMatch({ rules: RULES_BOTH, pickScore: s(1, 1), pick: "A", result: "A", resultScore: s(2, 1), published: true });
  assert.equal(out.total, 0, "un 1–1 no es victoria de A");
});

test("PUNTOS · captura 1X2: acierto de empate suma, no hay bono", () => {
  const rules = { capture: "result", resultPoints: 2, exactBonus: 0 };
  assert.equal(L.scoreMatch({ rules, pick: "D", result: "D", published: true }).total, 2);
  assert.equal(L.scoreMatch({ rules, pick: "A", result: "D", published: true }).total, 0);
});

test("ESTADOS · pendiente, aplazado y anulado no califican; vacío no es 0–0", () => {
  for (const status of ["pending", "postponed", "void"]) {
    const out = L.scoreMatch({ rules: RULES_BOTH, pickScore: s(0, 0), pick: "D", result: null, resultScore: null, status, published: true });
    assert.equal(out.total, 0);
    assert.equal(out.state, status === "pending" ? "pending" : status === "postponed" ? "postponed" : "void");
  }
  const nopick = L.scoreMatch({ rules: RULES_BOTH, pickScore: null, pick: null, result: "D", resultScore: s(0, 0), published: true });
  assert.equal(nopick.total, 0, "sin pronóstico no se lee como 0–0 acertado");
  assert.equal(nopick.exactHit, false);
});

test("ESTADOS · transiciones recalculan sin doble conteo (pendiente→resultado, aplazado→resultado, resultado→anulado, anulado→resultado)", () => {
  const round = (matchStatus, results, scores) => ({
    id: "r1", stage: "liguilla", resultsPublished: true, scoring: RULES_BOTH,
    matches: [{ id: "m1" }, { id: "m2" }], matchStatus, results, scores,
  });
  const picks = { m1: "A", m2: "D", __score: { m1: s(2, 1), m2: s(1, 1) } };
  const states = [
    round({ m2: "pending" }, { m1: "A" }, { m1: s(2, 1) }),
    round({}, { m1: "A", m2: "D" }, { m1: s(2, 1), m2: s(1, 1) }),
    round({ m2: "void" }, { m1: "A" }, { m1: s(2, 1) }),
    round({}, { m1: "A", m2: "D" }, { m1: s(2, 1), m2: s(1, 1) }),
    round({ m2: "postponed" }, { m1: "A" }, { m1: s(2, 1) }),
    round({}, { m1: "A", m2: "D" }, { m1: s(2, 1), m2: s(1, 1) }),
  ];
  const totals = states.map((r) => L.scoreRound(r, picks).total);
  assert.deepEqual(totals, [2, 4, 2, 4, 2, 4], "cada estado da lo mismo cada vez: nada se acumula");
  const voided = L.scoreRound(states[2], picks);
  assert.equal(voided.voided, 1);
  assert.equal(voided.resultHits, 1, "el anulado no cuenta como acierto ni como fallo");
});

test("REGLAS · combinaciones imposibles y límites", () => {
  assert.equal(L.validateRules({ capture: "result", resultPoints: 1, exactBonus: 1 }).ok, false, "sin marcador no hay bono");
  assert.equal(L.validateRules({ capture: "score", resultPoints: 0, exactBonus: 0 }).reason, "liguilla_rules_no_prize");
  assert.equal(L.validateRules({ capture: "score", resultPoints: 100, exactBonus: 0 }).ok, false);
  assert.equal(L.validateRules({ capture: "score", resultPoints: 1.5, exactBonus: 0 }).ok, false);
  assert.equal(L.validateRules({ capture: "x", resultPoints: 1 }).ok, false);
  assert.deepEqual(L.validateRules({ capture: "result", resultPoints: 2 }).rules, { capture: "result", resultPoints: 2, exactBonus: 0 });
});

test("GOLES · enteros de 0 a 30, los dos lados, nada más", () => {
  for (const bad of [{ a: -1, b: 0 }, { a: 2.5, b: 1 }, { a: "2", b: 1 }, { a: 31, b: 0 }, { a: 1 }, { a: 1, b: null }, { a: 1, b: 1, c: 1 }, null, "2-1"]) {
    assert.equal(L.isScore(bad), false, JSON.stringify(bad));
  }
  assert.equal(L.isScore({ a: 0, b: 30 }), true);
});

test("FASE · etiqueta «Cuartos de final · Ida»; sin dato no se inventa", () => {
  assert.equal(L.phaseLabel({ round: "quarter", leg: "ida", source: "admin" }), "Cuartos de final · Ida");
  assert.equal(L.phaseLabel({ round: "semi", leg: "vuelta", source: "provider" }), "Semifinal · Vuelta");
  assert.equal(L.phaseLabel({ round: "final", leg: null, source: "admin" }), "Final");
  assert.equal(L.phaseLabel(null), null);
  assert.equal(L.validPhase({ round: "octavos", leg: null, source: "admin" }), false);
});

// ---- marcador sin tanda (prórroga y penales) -------------------------------

test("MARCADOR · terminado en los 90: el marcador final sin tanda es el de los 90", () => {
  const c = buildScoreContract({ lines: [...both(SCORE_PHASE.REGULATION, 2, 1), ...both(SCORE_PHASE.FINAL, 2, 1)], regulationComplete: true });
  assert.deepEqual({ ...c.finalWithoutShootout }, { home: 2, away: 1 });
});

test("MARCADOR · prórroga 1–1 → 2–1: sin prueba de que excluye la tanda, no se sugiere (captura manual)", () => {
  const c = buildScoreContract({ lines: [...both(SCORE_PHASE.REGULATION, 1, 1), ...both(SCORE_PHASE.EXTRA_TIME, 2, 1), ...both(SCORE_PHASE.FINAL, 2, 1)], regulationComplete: false });
  assert.equal(c.finalWithoutShootout, null);
  assert.deepEqual({ ...c.regulation }, { home: 1, away: 1 }, "el 1X2 regular no cambia");
});

test("MARCADOR · 1–1 y penales 5–4: nunca se suman goles de tanda; sin sugerencia", () => {
  const c = buildScoreContract({ lines: [...both(SCORE_PHASE.REGULATION, 1, 1), ...both(SCORE_PHASE.PENALTY, 5, 4), ...both(SCORE_PHASE.FINAL, 1, 1)], regulationComplete: false });
  assert.equal(c.finalWithoutShootout, null);
});

test("MARCADOR · TheSportsDB sólo da un marcador final: con AET o PEN no hay sugerencia", () => {
  const sdp = require("../sportsDataProvider");
  const ev = (st) => sdp.normalizeEvent({ idEvent: "1", intHomeScore: "2", intAwayScore: "1", strStatus: st }, "thesportsdb");
  assert.deepEqual({ ...ev("FT").finalWithoutShootout }, { home: 2, away: 1 });
  assert.equal(ev("AET").finalWithoutShootout, null);
  assert.equal(ev("PEN").finalWithoutShootout, null);
});

test("MARCADOR · Sportmonks: FT da marcador, AET y FT_PEN no (dataset con formas reales)", () => {
  const stages = sportmonks.toStages({ stages: D.STAGES, instances: [{ instanceKey: "Apertura", id: "i" }, { instanceKey: null, id: "i" }], providerCompetitionId: D.LIGA_MX });
  const evOf = (fx) => sportmonks.toEvents({ fixtures: [fx], stages })[0];
  assert.ok(evOf(D.qfIda).finalWithoutShootout, "terminó en los 90");
  assert.equal(evOf(D.finalAet).finalWithoutShootout, null, "prórroga: captura manual");
  assert.equal(evOf(D.finalPen).finalWithoutShootout, null, "penales: captura manual");
  assert.deepEqual({ ...evOf(D.finalPen).regulationScore }, { home: 1, away: 1 }, "el 1X2 regular sigue en 90'");
});

// ---- servidor: reglas, candado, publicación --------------------------------

const NOW = "2026-11-20T00:00:00.000Z";
const match = (id, a = "Club " + id, b = "Rival " + id) => ({ id, teamA: a, teamB: b });
function meta(over = {}) {
  return {
    settings: { pointsPerCorrectPick: 1, liguilla: { ...RULES_BOTH } },
    rounds: [
      { id: "r17", number: 17, matches: [match("m0")], deadline: "2026-11-01T00:00:00Z", published: true, resultsPublished: true, results: { m0: "A" } },
      { id: "r18", number: 18, stage: "liguilla", phase: { round: "quarter", leg: "ida", source: "admin" }, matches: [match("m1"), match("m2")], deadline: "2026-11-27T01:00:00Z", published: false, results: {} },
    ],
    ...over,
  };
}
const clone = (v) => JSON.parse(JSON.stringify(v));
function publish(doc, id) { const d = clone(doc); d.rounds.find((r) => r.id === id).published = true; return d; }
const apply = (oldValue, merged, scopeId = "scope-1") => {
  const m = clone(merged);
  const out = R.applyLiguillaWrite({ oldValue, merged: m, scopeId, nowIso: NOW });
  return { out, merged: m };
};

test("D1 · publicar la primera jornada de liguilla fija las reglas del torneo y copia las reglas en la jornada", () => {
  const old = meta();
  const { out, merged } = apply(old, publish(old, "r18"));
  assert.equal(out.ok, true);
  assert.equal(merged.liguillaLocks.length, 1);
  assert.deepEqual(merged.liguillaLocks[0].rules, RULES_BOTH);
  assert.equal(merged.liguillaLocks[0].scopeId, "scope-1");
  assert.deepEqual(merged.rounds.find((r) => r.id === "r18").scoring, RULES_BOTH);
  assert.equal(merged.rounds.find((r) => r.id === "r17").scoring, undefined, "la jornada regular no recibe reglas de liguilla");
});

test("D1 · no se puede publicar una jornada de liguilla sin reglas", () => {
  const old = meta({ settings: { pointsPerCorrectPick: 1 } });
  const { out } = apply(old, publish(old, "r18"));
  assert.equal(out.error, "liguilla_rules_required");
  assert.equal(out.status, 409);
});

test("D1 · con el candado puesto no se cambian modalidad ni puntos", () => {
  const old = apply(meta(), publish(meta(), "r18")).merged;
  const next = clone(old); next.settings.liguilla = { capture: "score", resultPoints: 1, exactBonus: 3 };
  assert.equal(apply(old, next).out.error, "liguilla_rules_locked");
  const cleared = clone(old); delete cleared.settings.liguilla;
  assert.equal(apply(old, cleared).out.error, "liguilla_rules_locked");
});

test("D1 · el candado no se elude borrando la jornada, cambiándole la fase, ni enviando otro candado", () => {
  const old = apply(meta(), publish(meta(), "r18")).merged;
  const deleted = clone(old); deleted.rounds = deleted.rounds.filter((r) => r.id !== "r18");
  const a = apply(old, deleted);
  assert.equal(a.out.ok, true);
  assert.equal(a.merged.liguillaLocks.length, 1, "borrar la jornada no quita el candado");
  const changeRules = clone(a.merged); changeRules.settings.liguilla = { capture: "result", resultPoints: 3, exactBonus: 0 };
  assert.equal(apply(a.merged, changeRules).out.error, "liguilla_rules_locked");
  const stageChange = clone(old); stageChange.rounds.find((r) => r.id === "r18").stage = undefined;
  assert.equal(apply(old, stageChange).out.error, "liguilla_stage_locked");
  const forged = clone(old); forged.liguillaLocks = []; forged.settings.liguilla = { capture: "result", resultPoints: 3, exactBonus: 0 };
  assert.equal(apply(old, forged).out.error, "liguilla_rules_locked", "un candado enviado por el cliente no cuenta");
  const forgedScoring = clone(old); forgedScoring.rounds.find((r) => r.id === "r18").scoring = { capture: "score", resultPoints: 9, exactBonus: 9 };
  const f = apply(old, forgedScoring);
  assert.deepEqual(f.merged.rounds.find((r) => r.id === "r18").scoring, RULES_BOTH, "la copia de reglas es del servidor");
});

test("D1 · un torneo nuevo empieza sin candado; las jornadas anteriores conservan sus reglas", () => {
  const old = apply(meta(), publish(meta(), "r18")).merged;
  const next = clone(old); next.settings.liguilla = { capture: "result", resultPoints: 2, exactBonus: 0 };
  const { out, merged } = apply(old, next, "scope-2");
  assert.equal(out.ok, true);
  assert.deepEqual(merged.rounds.find((r) => r.id === "r18").scoring, RULES_BOTH);
});

test("D5 · una jornada publicada como regular no se convierte en liguilla", () => {
  const old = meta();
  const next = clone(old); next.rounds.find((r) => r.id === "r17").stage = "liguilla";
  assert.equal(apply(old, next).out.error, "liguilla_stage_locked");
});

test("D6 · un borrador con rival por definir se guarda, pero no se publica", () => {
  const old = meta();
  old.rounds.find((r) => r.id === "r18").matches.push({ id: "m3", teamA: "Club A", teamB: "" });
  const draft = clone(old); draft.rounds.find((r) => r.id === "r18").phase = { round: "quarter", leg: "vuelta", source: "admin" };
  assert.equal(apply(old, draft).out.ok, true);
  const { out, merged } = apply(old, publish(old, "r18"));
  assert.equal(out.error, "liguilla_rival_pending");
  assert.equal(out.pending, 1);
  assert.equal(merged.liguillaLocks, undefined, "una publicación rechazada no fija nada");
});

test("D2 · resultados parciales: cada partido con resultado o con estado explícito", () => {
  const old = apply(meta(), publish(meta(), "r18")).merged;
  const withResults = (patch) => { const d = clone(old); Object.assign(d.rounds.find((r) => r.id === "r18"), { resultsPublished: true }, patch); return d; };
  assert.equal(apply(old, withResults({ results: { m1: "A" }, scores: { m1: s(2, 1) }, matchStatus: { m2: "postponed" } })).out.ok, true);
  assert.equal(apply(old, withResults({ results: { m1: "A" }, scores: { m1: s(2, 1) } })).out.error, "incomplete_results", "un hueco sin estado no se publica");
  assert.equal(apply(old, withResults({ results: { m1: "B", m2: "D" }, scores: { m1: s(2, 1), m2: s(0, 0) } })).out.error, "liguilla_result_mismatch");
  assert.equal(apply(old, withResults({ results: { m1: "A", m2: "D" }, scores: { m1: s(2, 1), m2: { a: 31, b: 31 } } })).out.error, "invalid_score");
  assert.equal(apply(old, withResults({ results: { m1: "A", m2: "D" }, scores: { m1: s(2, 1), m2: s(0, 0) }, matchStatus: { m2: "void" } })).out.error, "liguilla_result_with_status");
  assert.equal(apply(old, withResults({ results: {}, scores: {}, matchStatus: { m1: "pending", m2: "pending" } })).out.error, "incomplete_results", "sin nada resuelto no hay qué publicar");
  assert.equal(apply(old, withResults({ results: {}, scores: {}, matchStatus: { m1: "void", m2: "postponed" } })).out.ok, true);
});

test("FASE REGULAR · nada de marcadores ni estados fuera de la liguilla", () => {
  const old = meta();
  const next = clone(old); next.rounds.find((r) => r.id === "r17").matchStatus = { m0: "void" };
  assert.equal(apply(old, next).out.error, "invalid_value");
});

// ---- pronósticos por partido --------------------------------------------

const published = () => apply(meta(), publish(meta(), "r18")).merged;
const BEFORE = Date.parse("2026-11-26T00:00:00Z");
const AFTER = Date.parse("2026-11-27T01:00:01Z");

test("PRONÓSTICO · dos números se guardan; el 1X2 se deduce", () => {
  const out = R.applyMatchPick({ meta: published(), picksDoc: {}, roundId: "r18", matchId: "m1", value: s(2, 1), expected: null, nowMs: BEFORE });
  assert.equal(out.ok, true);
  assert.deepEqual(out.doc.r18, { m1: "A", __score: { m1: s(2, 1) } });
});

test("PRONÓSTICO · formatos inválidos se rechazan igual que en la interfaz", () => {
  for (const v of [{ a: -1, b: 0 }, { a: 2.5, b: 1 }, { a: "2", b: 1 }, { a: 31, b: 0 }, { a: 1 }, "A", null]) {
    const out = R.applyMatchPick({ meta: published(), picksDoc: {}, roundId: "r18", matchId: "m1", value: v, expected: null, nowMs: BEFORE });
    assert.equal(out.ok, false, JSON.stringify(v));
    assert.equal(out.status, 400);
  }
});

test("PRONÓSTICO · otra sesión guardó antes: 409 con lo guardado, nada se pisa", () => {
  const doc = { r18: { m1: "D", __score: { m1: s(1, 1) } } };
  const out = R.applyMatchPick({ meta: published(), picksDoc: doc, roundId: "r18", matchId: "m1", value: s(2, 1), expected: null, nowMs: BEFORE });
  assert.equal(out.error, "pick_conflict");
  assert.deepEqual(out.current, s(1, 1));
  const ok = R.applyMatchPick({ meta: published(), picksDoc: doc, roundId: "r18", matchId: "m1", value: s(2, 1), expected: s(1, 1), nowMs: BEFORE });
  assert.equal(ok.ok, true);
});

test("PRONÓSTICO · guardar otro partido no toca el ya guardado", () => {
  const doc = { r18: { m1: "D", __score: { m1: s(1, 1) } } };
  const out = R.applyMatchPick({ meta: published(), picksDoc: doc, roundId: "r18", matchId: "m2", value: s(0, 2), expected: null, nowMs: BEFORE });
  assert.deepEqual(out.doc.r18.__score, { m1: s(1, 1), m2: s(0, 2) });
});

test("PRONÓSTICO · tarde: round_locked con el último aceptado", () => {
  const doc = { r18: { m1: "A", __score: { m1: s(2, 1) } } };
  const out = R.applyMatchPick({ meta: published(), picksDoc: doc, roundId: "r18", matchId: "m1", value: s(3, 1), expected: s(2, 1), nowMs: AFTER });
  assert.equal(out.error, "round_locked");
  assert.deepEqual(out.current, s(2, 1));
});

test("PRONÓSTICO · borrador sin publicar o jornada regular: no por esta vía", () => {
  assert.equal(R.applyMatchPick({ meta: meta(), picksDoc: {}, roundId: "r18", matchId: "m1", value: s(1, 0), expected: null, nowMs: BEFORE }).error, "round_locked");
  assert.equal(R.applyMatchPick({ meta: published(), picksDoc: {}, roundId: "r17", matchId: "m0", value: "A", expected: null, nowMs: BEFORE }).error, "not_liguilla");
});

test("PESTAÑA ANTIGUA · un documento entero que cambia la liguilla se rechaza; uno que la deja igual pasa", () => {
  const m = published();
  const stored = { r17: { m0: "A" }, r18: { m1: "A", __score: { m1: s(2, 1) } } };
  const oldTab = clone(stored); oldTab.r18.m1 = "B";
  assert.equal(R.validateLiguillaPicksWrite(m, stored, oldTab).ok, false);
  const stale = clone(stored); stale.r18.__score.m1 = s(3, 1);
  assert.equal(R.validateLiguillaPicksWrite(m, stored, stale).ok, false, "otra sesión guardó: no se pisa en silencio");
  const regularOnly = clone(stored); regularOnly.r17.m0 = "B";
  assert.equal(R.validateLiguillaPicksWrite(m, stored, regularOnly).ok, true, "la fase regular sigue igual que hoy");
});

// ---- sync: ida y vuelta, reimportación ------------------------------------

const NOWMS = Date.parse("2026-11-01T00:00:00Z");
const fx = (id, at, extra = {}) => ({ providerFixtureId: id, providerRoundId: "125", stageId: null, kickoffAt: at,
  home: { id: "h" + id, name: "Club " + id }, away: { id: "a" + id, name: "Rival " + id }, leg: null, status: "scheduled", provider: "thesportsdb", ...extra });
const asMatch = (f, i) => ({ id: "x" + f.providerFixtureId, externalEventId: f.providerFixtureId, externalProvider: "thesportsdb",
  teamA: f.home.name, teamB: f.away.name, externalHomeId: f.home.id, externalAwayId: f.away.id, kickoffAt: f.kickoffAt });
function organized(ida, vuelta) {
  const base = { published: false, resultsPublished: false, provider: "thesportsdb", syncGroupKey: "round:125", externalRoundId: "125", stage: "liguilla", results: {} };
  return [
    { ...base, id: "rI", number: 18, deadline: ida[0].kickoffAt, matches: ida.map(asMatch), phase: { round: "quarter", leg: "ida", source: "admin" } },
    { ...base, id: "rV", number: 19, deadline: vuelta[0].kickoffAt, matches: vuelta.map(asMatch), phase: { round: "quarter", leg: "vuelta", source: "admin" } },
  ];
}
const plan = (rounds, fixtures, staged = []) => planCompetitionSync({ provider: "thesportsdb", existingRounds: rounds, existingStaged: staged, fixtures, nowMs: NOWMS });

for (const days of [2, 3]) {
  test(`IDA/VUELTA · separadas por ${days} días: reimportar no crea, no añade y no mueve nada`, () => {
    const ida = [fx("1", "2026-11-26T01:00:00Z"), fx("2", "2026-11-27T01:00:00Z")];
    const vuelta = [fx("3", new Date(Date.parse("2026-11-27T01:00:00Z") + days * 86400000).toISOString()),
                    fx("4", new Date(Date.parse("2026-11-28T01:00:00Z") + days * 86400000).toISOString())];
    const p = plan(organized(ida, vuelta), [...ida, ...vuelta]);
    assert.equal(p.newRounds.length, 0);
    assert.equal(p.matchAdditions.length, 0);
    assert.equal(p.matchUpdates.length, 0);
    assert.equal(p.stagedFixtures.length, 0);
  });
}

test("IDA/VUELTA · reimportación ambigua: un partido nuevo con sólo la fecha va a pendientes, nunca a la ida", () => {
  const ida = [fx("1", "2026-11-26T01:00:00Z")];
  const vuelta = [fx("3", "2026-11-29T01:00:00Z")];
  const nuevo = fx("9", "2026-11-29T03:00:00Z");
  const p = plan(organized(ida, vuelta), [...ida, ...vuelta, nuevo]);
  assert.equal(p.matchAdditions.length, 0, "comportamiento anterior: caía en la ida");
  assert.equal(p.newRounds.length, 0);
  assert.deepEqual(p.stagedFixtures.map((f) => f.providerFixtureId), ["9"]);
  assert.ok(p.diagnostics.some((d) => d.code === "ambiguous_placement"));
});

test("IDA/VUELTA · sin fecha también va a pendientes", () => {
  const ida = [fx("1", "2026-11-26T01:00:00Z")];
  const vuelta = [fx("3", "2026-11-29T01:00:00Z")];
  const p = plan(organized(ida, vuelta), [...ida, ...vuelta, fx("9", null)]);
  assert.deepEqual(p.stagedFixtures.map((f) => f.providerFixtureId), ["9"]);
  assert.equal(p.matchAdditions.length, 0);
});

test("IDA/VUELTA · cambio de fecha de un partido conocido: se queda en su jornada aunque quede más cerca de la otra", () => {
  const ida = [fx("1", "2026-11-26T01:00:00Z")];
  const vuelta = [fx("3", "2026-11-29T01:00:00Z")];
  const moved = fx("1", "2026-11-29T02:00:00Z");
  const p = plan(organized(ida, vuelta), [moved, ...vuelta]);
  assert.equal(p.matchAdditions.length, 0);
  assert.equal(p.stagedFixtures.length, 0);
  assert.deepEqual(p.matchUpdates.map((u) => [u.roundId, u.changes.kickoffAt]), [["rI", "2026-11-29T02:00:00Z"]]);
  assert.ok(p.diagnostics.some((d) => d.code === "kickoff_past_deadline"), "si pasa del cierre, sólo se avisa");
});

test("IDA/VUELTA · una sola ubicación posible por clave: se añade a esa jornada", () => {
  const ida = [fx("1", "2026-11-26T01:00:00Z")];
  const rounds = organized(ida, [fx("3", "2026-11-29T01:00:00Z")]).slice(0, 1);
  const p = plan(rounds, [...ida, fx("2", "2026-11-26T03:00:00Z")]);
  assert.deepEqual(p.matchAdditions.map((a) => [a.roundId, a.match.externalEventId]), [["rI", "2"]]);
});

test("IDA/VUELTA · jornada publicada: nada se añade ni se mueve", () => {
  const rounds = organized([fx("1", "2026-11-26T01:00:00Z")], [fx("3", "2026-11-29T01:00:00Z")]);
  rounds.forEach((r) => { r.published = true; r.deadline = "2026-10-01T00:00:00Z"; });
  const p = plan([rounds[0]], [fx("1", "2026-11-26T01:00:00Z"), fx("2", "2026-11-26T02:00:00Z")]);
  assert.equal(p.matchAdditions.length, 0);
  assert.deepEqual(p.stagedFixtures.map((f) => f.providerFixtureId), ["2"]);
});

test("FASE · el proveedor la da sin duda (Sportmonks): fase y leg en la jornada nueva; si no, nada", () => {
  assert.deepEqual(phaseFromFixture({ stageName: "Quarter-finals", leg: { number: 2, total: 2 } }), { round: "quarter", leg: "vuelta", source: "provider" });
  assert.deepEqual(phaseFromFixture({ stageName: "Final", leg: { number: 1, total: 1 } }), { round: "final", leg: "unico", source: "provider" });
  assert.equal(phaseFromFixture({ stageName: "Play In", leg: null }), null);
  const f = (id, at, leg) => ({ providerFixtureId: id, providerRoundId: null, stageId: "77478884", stageName: "Quarter-finals", kickoffAt: at,
    home: { id: "h" + id, name: "H" + id }, away: { id: "a" + id, name: "A" + id }, leg, status: "scheduled", provider: "sportmonks" });
  const p = planCompetitionSync({ provider: "sportmonks", existingRounds: [], existingStaged: [], nowMs: NOWMS,
    fixtures: [f("1", "2026-11-26T01:00:00Z", { number: 1, total: 2 }), f("2", "2026-11-28T01:00:00Z", { number: 2, total: 2 })] });
  assert.deepEqual(p.newRounds.map((r) => [r.phase.leg, r.matches[0].leg]), [["ida", { number: 1, total: 2 }], ["vuelta", { number: 2, total: 2 }]]);
  assert.equal(p.newRounds[0].stage, undefined, "la jornada no se vuelve liguilla sola");
});

test("FASE · la fase que indicó el Admin no la toca un sync posterior", () => {
  const rounds = organized([fx("1", "2026-11-26T01:00:00Z")], [fx("3", "2026-11-29T01:00:00Z")]);
  const before = JSON.stringify(rounds.map((r) => r.phase));
  plan(rounds, [fx("1", "2026-11-26T01:00:00Z", { stageName: "Semi-finals" })]);
  assert.equal(JSON.stringify(rounds.map((r) => r.phase)), before);
});
