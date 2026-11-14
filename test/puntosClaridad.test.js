// Sprint «Puntos y resultados claros» (AUD-10, AUD-11, AUD-12 y desglose).
//
// Las funciones de puntos se extraen del public/index.html real y se comparan
// contra:
//   1. las funciones ORIGINALES de main 6ef81ce (copia literal en
//      test/fixtures/scoringMain6ef81ce.js), con cientos de quinielas
//      sintéticas al azar (semilla fija), y
//   2. valores esperados calculados a mano, independientes de ambas.
// Así el desglose no puede contar distinto que la Tabla, y la Tabla sigue
// contando lo mismo que antes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const LG = require("../liguillaScoring.js");
const ORIG = require("./fixtures/scoringMain6ef81ce.js");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFrom(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  const braceStart = source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}
const fn = (sig) => extractFrom(indexSrc, sig);

const NOW = Date.parse("2026-11-10T12:00:00Z");
const PAST = "2026-10-01T00:00:00Z";
const FUTURE = "2026-12-20T00:00:00Z";
const IS_LG = 'function isLg(r){ return !!(LG && r && r.stage === "liguilla"); }';

const NEW_SIGS = [
  "function isRoundLocked(round)",
  "function isRoundEligibleForPenalty(round, penalty)",
  "function customBetParts(participantId, participantMap, cutoffRoundNumber)",
  "function customBetPointsFor(participantId, participantMap, cutoffRoundNumber)",
  "function penaltyParts(p, cutoffRoundNumber)",
  "function penaltyPointsFor(p, cutoffRoundNumber)",
  "function roundMatchScore(r, roundPicks)",
  "function pointsFor(participantId, participantMap, cutoffRoundNumber)",
  "function penaltyFor(participantId, participantMap)",
  "function standingsList()",
  "function computeDenseRanks(list)",
  "function sumValues(o)",
  "function pointsBreakdown(participantId, participantMap)",
  "function roundTotalParts(participantId, round, roundPicks, participantMap)",
  "function signedPts(n)",
  "function ptsText(n)",
];
const NEW_SRC = NEW_SIGS.map(fn).join("\n");
const EXPORTS = "pointsFor, customBetPointsFor, penaltyPointsFor, penaltyFor, standingsList, computeDenseRanks";
function newModel(meta, picks) {
  return new Function("meta", "allPicksCache", "LG", "serverNow",
    `${NEW_SRC}\n${IS_LG}\nreturn { ${EXPORTS}, pointsBreakdown, roundTotalParts, roundMatchScore, signedPts, ptsText };`)(meta, picks, LG, () => NOW);
}
function origModel(meta, picks) {
  return new Function("meta", "allPicksCache", "LG", "serverNow",
    `${ORIG.source}\n${IS_LG}\nreturn { ${EXPORTS}, previousRanks };`)(meta, picks, LG, () => NOW);
}

// ---- la copia del original es fiel ----------------------------------------
test("la copia de main 6ef81ce es idéntica al original (si git tiene ese commit)", (t) => {
  let orig;
  try {
    orig = execFileSync("git", ["show", `${ORIG.sha}:public/index.html`], { cwd: path.join(__dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    t.skip("este checkout no tiene el commit 6ef81ce");
    return;
  }
  assert.equal(ORIG.signatures.map((s) => "  " + extractFrom(orig, s)).join("\n\n"), ORIG.source);
});

// ---- generador de quinielas sintéticas (semilla fija) ----------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function randomQuiniela(seed) {
  const R = rng(seed);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const chance = (p) => R() < p;
  const OUT = ["A", "D", "B"];
  const nRounds = 1 + Math.floor(R() * 6);
  const nPeople = 1 + Math.floor(R() * 6);
  const people = Array.from({ length: nPeople }, (_, i) => ({ id: "p" + i, name: "Persona " + i, paid: chance(0.4) }));
  const rounds = [];
  for (let n = 1; n <= nRounds; n++) {
    const lg = chance(0.3);
    const nm = 1 + Math.floor(R() * 4);
    const matches = Array.from({ length: nm }, (_, k) => ({ id: `m${n}_${k}`, teamA: "Uno", teamB: "Dos" }));
    const published = chance(0.85) ? (chance(0.5) ? true : undefined) : false;
    const resultsPublished = published !== false && chance(0.7);
    const r = { id: "r" + n, number: n, deadline: chance(0.8) ? PAST : FUTURE, matches, results: {}, resultsPublished };
    if (published !== undefined) r.published = published;
    if (lg) {
      const bonus = chance(0.5) ? 1 + Math.floor(R() * 3) : 0;
      r.stage = "liguilla";
      r.scoring = { resultPoints: 1 + Math.floor(R() * 3), exactBonus: bonus };
      r.scores = {};
      r.matchStatus = {};
    }
    matches.forEach((m) => {
      if (lg && chance(0.15)) { r.matchStatus[m.id] = pick(["pending", "postponed", "void"]); return; }
      if (chance(0.8)) {
        if (lg) { const sc = { a: Math.floor(R() * 3), b: Math.floor(R() * 3) }; r.scores[m.id] = sc; r.results[m.id] = LG.outcomeOfScore(sc); }
        else r.results[m.id] = pick(OUT);
      }
    });
    rounds.push(r);
  }
  const customBets = [];
  const nBets = Math.floor(R() * 4);
  for (let b = 0; b < nBets; b++) customBets.push({ id: "b" + b, label: "Pregunta " + b, scope: chance(0.5) ? "jornada" : "temporada", points: 1 + Math.floor(R() * 10) });
  rounds.forEach((r) => {
    customBets.filter((b) => b.scope === "jornada").forEach((b) => {
      if (chance(0.6)) { r.customBetResults = r.customBetResults || {}; r.customBetResults[b.id] = {}; people.forEach((p) => { if (chance(0.5)) r.customBetResults[b.id][p.id] = chance(0.8); }); }
    });
  });
  people.forEach((p) => {
    customBets.filter((b) => b.scope === "temporada").forEach((b) => { if (chance(0.6)) { p.customBetAnswers = p.customBetAnswers || {}; p.customBetAnswers[b.id] = { guess: "x", correct: chance(0.5) ? true : (chance(0.5) ? false : null) }; } });
    if (chance(0.6)) {
      p.penalizedRounds = {};
      rounds.forEach((r) => { if (chance(0.4)) p.penalizedRounds[r.id] = pick([0, 1, 2, 3]); });
      if (chance(0.4)) p.penalizedRounds["rBorrada" + Math.floor(R() * 3)] = pick([0, 1, 2]);
      if (chance(0.3)) p.penalizedRounds.rArchivada = 2;
    }
  });
  const meta = {
    settings: chance(0.2) ? {} : { pointsPerCorrectPick: pick([1, 3, 5]) },
    participants: people, rounds, customBets,
    paymentPenalty: chance(0.7) ? { enabled: chance(0.8), startsAtRound: pick([null, 1, 2, 3]), pointsPerRound: pick([undefined, 1, 2]) } : undefined,
    pastTournaments: chance(0.5) ? [{ rounds: [{ id: "rArchivada" }] }] : [],
  };
  const picks = {};
  people.forEach((p) => {
    if (chance(0.1)) return; // sin ningún pronóstico
    picks[p.id] = {};
    rounds.forEach((r) => {
      if (chance(0.15)) return;
      const rp = {};
      r.matches.forEach((m) => {
        if (chance(0.15)) return;
        if (r.stage === "liguilla" && r.scoring.exactBonus) { const sc = { a: Math.floor(R() * 3), b: Math.floor(R() * 3) }; rp.__score = rp.__score || {}; rp.__score[m.id] = sc; rp[m.id] = LG.outcomeOfScore(sc); }
        else rp[m.id] = pick(OUT);
      });
      picks[p.id][r.id] = rp;
    });
  });
  return { meta, picks };
}

test("las funciones de siempre dan EXACTAMENTE lo mismo que en main 6ef81ce (400 quinielas al azar, todos los cortes)", () => {
  let checks = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const { meta, picks } = randomQuiniela(seed);
    const N = newModel(meta, picks), O = origModel(meta, picks);
    const map = new Map(meta.participants.map((p) => [p.id, p]));
    const cutoffs = [null, ...meta.rounds.map((r) => r.number), 0, 99];
    for (const p of meta.participants) {
      for (const c of cutoffs) {
        assert.deepEqual(N.pointsFor(p.id, map, c), O.pointsFor(p.id, map, c), `seed ${seed} ${p.id} corte ${c}`);
        assert.deepEqual(N.pointsFor(p.id, undefined, c), O.pointsFor(p.id, undefined, c));
        assert.equal(N.customBetPointsFor(p.id, map, c), O.customBetPointsFor(p.id, map, c));
        assert.equal(N.penaltyPointsFor(p, c), O.penaltyPointsFor(p, c));
        checks++;
      }
      assert.equal(N.penaltyFor(p.id, map), O.penaltyFor(p.id, map));
    }
    assert.deepEqual(N.standingsList(), O.standingsList(), `seed ${seed}`);
  }
  assert.ok(checks > 1000, `comprobaciones: ${checks}`);
});

test("el desglose suma el mismo total que la Tabla de main 6ef81ce, y el total del torneo = suma de los totales de jornada + preguntas del torneo − descuentos de jornadas eliminadas", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { meta, picks } = randomQuiniela(seed);
    const N = newModel(meta, picks), O = origModel(meta, picks);
    const map = new Map(meta.participants.map((p) => [p.id, p]));
    const official = new Map(O.standingsList().map((p) => [p.id, p.pts]));
    for (const p of meta.participants) {
      const b = N.pointsBreakdown(p.id, map);
      assert.equal(b.total, official.get(p.id), `seed ${seed} ${p.id}`);
      assert.equal(b.base + b.bonus, b.matchPts);
      assert.equal(b.matchPts + b.roundQuestions + b.tournamentQuestions - b.roundDiscounts - b.deletedDiscounts, b.total);
      let sumRounds = 0;
      for (const r of meta.rounds) sumRounds += N.roundTotalParts(p.id, r, (picks[p.id] || {})[r.id], map).total;
      assert.equal(sumRounds + b.tournamentQuestions - b.deletedDiscounts, b.total, `seed ${seed} ${p.id}: jornadas`);
    }
  }
});

// ---- valores esperados calculados a mano ----------------------------------
function anaQuiniela() {
  // Ana, J5: acierta 2 de 3 a 3 pts = 6; pregunta de la jornada +5;
  // descuento por no pagar −1 → Total Jornada 5: 10. Además pregunta del
  // torneo +10 y descuento de una jornada eliminada −1 → total del torneo 19.
  const r5 = { id: "r5", number: 5, deadline: PAST, published: true, resultsPublished: true,
    matches: [{ id: "a", teamA: "Uno", teamB: "Dos" }, { id: "b", teamA: "Tres", teamB: "Cuatro" }, { id: "c", teamA: "Cinco", teamB: "Seis" }],
    results: { a: "A", b: "D", c: "B" }, customBetResults: { bj: { ana: true, beto: false } } };
  const meta = {
    settings: { pointsPerCorrectPick: 3 },
    participants: [
      { id: "ana", name: "Ana", paid: false, penalizedRounds: { r5: 1, rBorrada: 1 }, customBetAnswers: { bt: { guess: "x", correct: true } } },
      { id: "beto", name: "Beto", paid: true, penalizedRounds: { r5: 0 } },
    ],
    rounds: [r5],
    customBets: [{ id: "bj", label: "¿Quién anota?", scope: "jornada", points: 5 }, { id: "bt", label: "Campeón", scope: "temporada", points: 10 }],
    paymentPenalty: { enabled: true, startsAtRound: 1, pointsPerRound: 1 },
  };
  const picks = { ana: { r5: { a: "A", b: "D", c: "A" } }, beto: { r5: { a: "B", b: "D", c: "B" } } };
  return { meta, picks };
}

test("ejemplo de Ana: Total Jornada 5 = 10 y total del torneo = 19, con cada parte con su nombre", () => {
  const { meta, picks } = anaQuiniela();
  const N = newModel(meta, picks), O = origModel(meta, picks);
  const map = new Map(meta.participants.map((p) => [p.id, p]));
  const t = N.roundTotalParts("ana", meta.rounds[0], picks.ana.r5, map);
  assert.equal(t.match.hits, 2);
  assert.equal(t.match.pts, 6);
  assert.equal(t.questions, 5);
  assert.equal(t.discount, 1);
  assert.equal(t.total, 10);
  const b = N.pointsBreakdown("ana", map);
  assert.deepEqual(
    { base: b.base, hits: b.hits, bonus: b.bonus, roundQuestions: b.roundQuestions, tournamentQuestions: b.tournamentQuestions, roundDiscounts: b.roundDiscounts, deletedDiscounts: b.deletedDiscounts, total: b.total },
    { base: 6, hits: 2, bonus: 0, roundQuestions: 5, tournamentQuestions: 10, roundDiscounts: 1, deletedDiscounts: 1, total: 19 });
  assert.equal(O.pointsFor("ana", map).pts, 19, "la Tabla de main dice lo mismo");
  // Beto: 2 aciertos (6), pagó, sin preguntas → 6 en la jornada y en el torneo.
  assert.equal(N.roundTotalParts("beto", meta.rounds[0], picks.beto.r5, map).total, 6);
  assert.equal(N.pointsBreakdown("beto", map).total, 6);
});

test("regular a 5 puntos: 3 aciertos = 15; sin pronóstico = 0; un partido sin resultado no cuenta", () => {
  const r = { id: "r1", number: 1, deadline: PAST, resultsPublished: true,
    matches: ["a", "b", "c", "d"].map((id) => ({ id, teamA: "X", teamB: "Y" })), results: { a: "A", b: "B", c: "D" } };
  const meta = { settings: { pointsPerCorrectPick: 5 }, participants: [{ id: "u", name: "U" }, { id: "v", name: "V" }], rounds: [r], customBets: [] };
  const picks = { u: { r1: { a: "A", b: "B", c: "D", d: "A" } } };
  const N = newModel(meta, picks);
  const s = N.roundMatchScore(r, picks.u.r1);
  assert.deepEqual({ pts: s.pts, hits: s.hits, played: s.played }, { pts: 15, hits: 3, played: 3 });
  assert.equal(N.pointsBreakdown("v").total, 0);
  assert.equal(N.roundTotalParts("v", r, undefined).total, 0);
});

test("liguilla con bono: exacto (2+1) + resultado (2) + fallo = base 4, bono 1, total 5; aplazado y anulado no cuentan", () => {
  const r = { id: "q1", number: 1, deadline: PAST, resultsPublished: true, stage: "liguilla", scoring: { resultPoints: 2, exactBonus: 1 },
    matches: ["m1", "m2", "m3", "m4", "m5"].map((id) => ({ id, teamA: "X", teamB: "Y" })),
    results: { m1: "A", m2: "B", m3: "D" }, scores: { m1: { a: 2, b: 1 }, m2: { a: 0, b: 1 }, m3: { a: 1, b: 1 } },
    matchStatus: { m4: "postponed", m5: "void" } };
  const meta = { settings: { pointsPerCorrectPick: 3 }, participants: [{ id: "u", name: "U" }], rounds: [r], customBets: [] };
  const sc = { m1: { a: 2, b: 1 }, m2: { a: 1, b: 3 }, m3: { a: 2, b: 0 }, m4: { a: 1, b: 0 }, m5: { a: 0, b: 0 } };
  const picks = { u: { q1: { __score: sc, m1: "A", m2: "B", m3: "A", m4: "A", m5: "D" } } };
  const N = newModel(meta, picks);
  const b = N.pointsBreakdown("u");
  assert.deepEqual({ base: b.base, bonus: b.bonus, hits: b.hits, exact: b.exact, total: b.total, lgBonusRule: b.lgBonusRule }, { base: 4, bonus: 1, hits: 2, exact: 1, total: 5, lgBonusRule: true });
  assert.equal(N.roundTotalParts("u", r, picks.u.q1).total, 5);
});

test("liguilla sin bono a 3 pts: 2 aciertos = 6, bono 0", () => {
  const r = { id: "q1", number: 1, deadline: PAST, resultsPublished: true, stage: "liguilla", scoring: { resultPoints: 3, exactBonus: 0 },
    matches: ["m1", "m2", "m3"].map((id) => ({ id, teamA: "X", teamB: "Y" })), results: { m1: "A", m2: "D", m3: "B" }, scores: {} };
  const meta = { participants: [{ id: "u", name: "U" }], rounds: [r], customBets: [] };
  const picks = { u: { q1: { m1: "A", m2: "D", m3: "A" } } };
  const b = newModel(meta, picks).pointsBreakdown("u");
  assert.deepEqual({ base: b.base, bonus: b.bonus, hits: b.hits, total: b.total, lgBonusRule: b.lgBonusRule }, { base: 6, bonus: 0, hits: 2, total: 6, lgBonusRule: false });
});

test("preguntas que cuentan ANTES de publicar resultados: suman en el torneo y en esa jornada, aunque sus partidos aún no", () => {
  const r6 = { id: "r6", number: 6, deadline: PAST, published: true, resultsPublished: false, matches: [{ id: "a", teamA: "X", teamB: "Y" }], results: {}, customBetResults: { bj: { u: true } } };
  const meta = { settings: { pointsPerCorrectPick: 3 }, participants: [{ id: "u", name: "U", paid: true }], rounds: [r6], customBets: [{ id: "bj", label: "P", scope: "jornada", points: 5 }] };
  const N = newModel(meta, {});
  assert.equal(N.pointsBreakdown("u").roundQuestions, 5);
  assert.equal(N.pointsBreakdown("u").total, 5);
  const t = N.roundTotalParts("u", r6, undefined);
  assert.deepEqual({ match: t.match.pts, questions: t.questions, total: t.total }, { match: 0, questions: 5, total: 5 });
  // Una jornada preparada (published:false) nunca da puntos de preguntas.
  r6.published = false;
  assert.equal(newModel(meta, {}).pointsBreakdown("u").total, 0);
});

test("descuentos: en vivo para quien no ha pagado, separados de los de jornadas eliminadas; archivados no restan; total negativo y cero", () => {
  const rounds = [1, 2].map((n) => ({ id: "r" + n, number: n, deadline: PAST, published: true, resultsPublished: true, matches: [{ id: "a", teamA: "X", teamB: "Y" }], results: { a: "A" } }));
  const meta = {
    settings: { pointsPerCorrectPick: 1 },
    participants: [
      { id: "neg", name: "Neg", paid: false, penalizedRounds: { r1: 2, rVieja: 2, rArch: 5 } }, // r2 en vivo: 2
      { id: "cero", name: "Cero", paid: true, penalizedRounds: { r1: 0, r2: 0 } },
    ],
    rounds, customBets: [], paymentPenalty: { enabled: true, startsAtRound: 1, pointsPerRound: 2 },
    pastTournaments: [{ rounds: [{ id: "rArch" }] }],
  };
  const picks = { neg: { r1: { a: "B" }, r2: { a: "B" } }, cero: { r1: { a: "B" }, r2: { a: "D" } } };
  const N = newModel(meta, picks), O = origModel(meta, picks);
  const b = N.pointsBreakdown("neg");
  assert.deepEqual({ roundDiscounts: b.roundDiscounts, deletedDiscounts: b.deletedDiscounts, total: b.total }, { roundDiscounts: 4, deletedDiscounts: 2, total: -6 });
  assert.equal(O.pointsFor("neg").pts, -6);
  assert.equal(N.roundTotalParts("neg", rounds[1], picks.neg.r2).discount, 2, "descuento en vivo de J2");
  assert.equal(N.ptsText(-6), "−6 pts");
  assert.equal(N.signedPts(-2), "−2");
  assert.equal(N.signedPts(5), "+5");
  assert.equal(N.signedPts(0), "0");
  assert.equal(N.ptsText(1), "1 pt");
  assert.equal(N.pointsBreakdown("cero").total, 0);
  // Penalización apagada: no resta nada (como siempre).
  meta.paymentPenalty.enabled = false;
  assert.equal(newModel(meta, picks).pointsBreakdown("neg").total, 0);
});

test("empates: misma posición en la Tabla (posición densa), como en main", () => {
  const r = { id: "r1", number: 1, deadline: PAST, resultsPublished: true, matches: [{ id: "a", teamA: "X", teamB: "Y" }, { id: "b", teamA: "X", teamB: "Y" }], results: { a: "A", b: "B" } };
  const meta = { settings: { pointsPerCorrectPick: 3 }, participants: ["x", "y", "z"].map((id) => ({ id, name: id })), rounds: [r], customBets: [] };
  const picks = { x: { r1: { a: "A", b: "B" } }, y: { r1: { a: "A", b: "B" } }, z: { r1: { a: "A" } } };
  const N = newModel(meta, picks);
  const list = N.standingsList();
  assert.deepEqual(list.map((p) => p.pts), [6, 6, 3]);
  assert.deepEqual(N.computeDenseRanks(list), [1, 1, 2]);
});

// ---- AUD-11: el movimiento ficticio -----------------------------------------
test("AUD-11 · main 6ef81ce inventaba movimientos (previousRanks ignoraba preguntas y descuentos); ya no se muestra ninguna flecha", () => {
  // Dos jornadas. Uno gana por partidos en J1; Dos tiene una pregunta de J2.
  // La «jornada pasada» de main sólo veía partidos: Dos aparecía «subiendo»
  // por algo que no era la jornada pasada.
  const rounds = [1, 2].map((n) => ({ id: "r" + n, number: n, deadline: PAST, published: true, resultsPublished: true, matches: [{ id: "a", teamA: "X", teamB: "Y" }], results: { a: "A" } }));
  rounds[0].customBetResults = { bj: { dos: true } };
  const meta = { settings: { pointsPerCorrectPick: 1 }, participants: [{ id: "uno", name: "Uno" }, { id: "dos", name: "Dos" }], rounds, customBets: [{ id: "bj", label: "P", scope: "jornada", points: 5 }] };
  const picks = { uno: { r1: { a: "A" }, r2: { a: "B" } }, dos: { r1: { a: "B" }, r2: { a: "B" } } };
  const O = origModel(meta, picks);
  // Tabla: Dos 5 (pregunta de J1) > Uno 1. «Antes de J2» según main: Uno 1, Dos 0
  // → Dos «sube» aunque en J1 ya iba primero con su pregunta.
  assert.deepEqual(O.previousRanks(), { uno: 1, dos: 2 }, "reproducción del defecto en main");
  assert.equal(O.standingsList()[0].id, "dos");
  // Ahora: sin cálculo de movimiento y con la explicación.
  assert.ok(!indexSrc.includes("function previousRanks("), "no queda el cálculo del movimiento");
  const tabla = fn("async function renderTabla(main)");
  assert.ok(!/[▲▼]/.test(tabla), "sin flechas");
  assert.ok(tabla.includes('const NO_MOVE = "Comparación con la jornada anterior no disponible";'));
  assert.ok(tabla.includes('<span class="muted" title="${NO_MOVE}">—</span>'));
  assert.ok(tabla.includes("— = ${NO_MOVE}</p>"), "la leyenda lo explica");
  assert.ok(!tabla.includes("movimiento desde la jornada pasada"));
});

// ---- AUD-10: aciertos bajo «Pts» en el Historial ----------------------------
test("AUD-10 · el Historial regular cierra con «Total jornada» (puntos) y deja los aciertos aparte", () => {
  const hist = fn("function renderHistDetail(round)");
  assert.ok(hist.includes('<th scope="col" style="text-align:center;">Total jornada</th>'));
  assert.ok(!hist.includes(">Pts</th>"), "ya no hay columna «Pts» que en realidad eran aciertos");
  assert.ok(!hist.includes("<td style=\"font-weight:700;text-align:center;\">${p.correct}</td>"), "ya no se pinta el número de aciertos como puntos");
  assert.ok(hist.includes("roundTotalParts(p.id, round, picks, participantMap)"), "el total sale del cálculo compartido");
  assert.ok(hist.includes('sub(p.correct + " acierto" + (p.correct === 1 ? "" : "s"))'), "los aciertos se nombran como aciertos");
  // Liguilla: el total de la nombre-celda es el de la jornada, no el de partidos.
  const lgHist = fn("function renderLiguillaHistDetail(detail, round)");
  assert.ok(lgHist.includes('<span class="lg-h-total">${esc(ptsText(t.total))}</span>'));
  assert.ok(lgHist.includes('const parts = t.questions || t.discount ? ["Partidos " + lgPts(t.match.pts)] : [];'));
  assert.ok(hist.includes('sub("hasta ahora")'), "con partidos sin resultado, el total es «hasta ahora»");
});

test("Jugados: el subtotal de partidos se llama así y aparte va «Total de esta jornada»", () => {
  const reg = fn("function renderRoundPlayed(box, round)");
  assert.ok(reg.includes("por partidos</span>"));
  assert.ok(reg.includes("const roundTotal = roundTotalHtml(round, roundPicks, currentUser.id, waiting > 0);"));
  const lg = fn("function renderLiguillaPlayed(box, round)");
  assert.ok(lg.includes("por partidos</span>"));
  assert.ok(lg.includes("const roundTotal = roundTotalHtml(round, rp, currentUser.id, partial);"));
  const rt = fn("function roundTotalHtml(round, roundPicks, participantId, partial)");
  assert.ok(rt.includes("Total de esta jornada"));
  assert.ok(rt.includes("roundTotalParts(participantId, round, roundPicks)"));
});

// ---- AUD-12: pagos que no existen en la imagen ------------------------------
function fakeCanvasRun(src, meta, list) {
  const texts = [];
  const ctx = new Proxy({}, { get: (_, k) => k === "fillText" ? (t) => texts.push(String(t)) : k === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => {}, set: () => true });
  const document = { createElement: () => ({ getContext: () => ctx }) };
  const paymentsTracked = new Function("meta", `${fn("function paymentsTracked()")}\nreturn paymentsTracked;`)(meta);
  const draw = new Function("meta", "document", "currentRoundContext", "roundTitle", "paymentsTracked",
    `${fn("function computeDenseRanks(list)")}\n${src}\nreturn drawResultsCardCanvas;`)(meta, document, () => null, () => "", paymentsTracked);
  draw(list);
  return texts;
}
test("AUD-12 · la imagen compartida sólo muestra pagos si la quiniela lleva pagos (igual que la Tabla)", () => {
  const newSrc = fn("function drawResultsCardCanvas(list)");
  const origSrc = extractFrom(ORIG.source, "function drawResultsCardCanvas(list)");
  const list = [{ id: "a", name: "Ana", pts: 6, paid: false }, { id: "b", name: "Beto", pts: 6, paid: false }, { id: "c", name: "Ceci", pts: 3, paid: true }];
  // Sin cuota, sin penalización y sin nadie marcado: no hay pagos que mostrar.
  const sinPagos = { groupName: "G", settings: { entryFee: 0 }, participants: list.map((p) => ({ ...p, paid: false })) };
  const listSin = list.map((p) => ({ ...p, paid: false }));
  const before = fakeCanvasRun(origSrc, sinPagos, listSin);
  assert.ok(before.includes("PAGO") && before.includes("❌"), "reproducción del defecto en main: la imagen inventaba pagos pendientes");
  const after = fakeCanvasRun(newSrc, sinPagos, listSin);
  assert.ok(!after.includes("PAGO") && !after.includes("❌") && !after.includes("✅"), JSON.stringify(after));
  // Con cuota y todos pagados: la columna sale (main la escondía).
  const todos = list.map((p) => ({ ...p, paid: true }));
  const conCuota = { groupName: "G", settings: { entryFee: 100 }, participants: todos };
  assert.ok(!fakeCanvasRun(origSrc, conCuota, todos).includes("PAGO"), "reproducción: main la escondía si todos pagaron");
  const t2 = fakeCanvasRun(newSrc, conCuota, todos);
  assert.ok(t2.includes("PAGO") && t2.filter((x) => x === "✅").length === 3);
  // Mismos puntos y posiciones que la Tabla (empate en 1.º).
  assert.deepEqual(after.filter((x) => /^\d+$/.test(x)), ["1", "6", "1", "6", "2", "3"]);
});

// ---- una carga fallida o incompleta no es cero ---------------------------------
// ensureAllPicksLoaded() real, con su validador real, y fetch simulado.
function makeLoader(participants, serverParticipants) {
  const src = fn("function picksBatchFromResponse(body, requestedIds)") + "\n" + fn("async function ensureAllPicksLoaded()");
  const calls = [], metaReads = [];
  let reply = null;
  // La meta actual del servidor: por omisión, la misma que tiene la página.
  let serverMeta = () => ({ found: true, value: { participants: serverParticipants || participants } });
  const fetchStub = async (url, opts) => { calls.push(JSON.parse(opts.body)); return reply(); };
  const m = new Function("fetch", "meta", "console", "kvGet", `
    let allPicksCache = { viejo: { r1: { a: "A" } } }, allPicksLoadFailed = false, allPicksLoadInFlight = null;
    const currentUser = null, currentUserPinCache = null;
    function adminOrOwnerCred(){ return null; }
    function setAuthHeaders(){}
    function currentMetaKey(){ return "quiniela:x:meta"; }
    ${src}
    return { run: ensureAllPicksLoaded, state: () => ({ allPicksCache, allPicksLoadFailed }) };`)(fetchStub, { participants }, { error() {} }, async (key) => { metaReads.push(key); return serverMeta(); });
  return { ...m, calls, metaReads, set: (fnReply) => { reply = fnReply; }, setServerMeta: (f) => { serverMeta = f; } };
}
const ok200 = (body) => () => ({ ok: true, status: 200, json: async () => body });
const PEOPLE = [{ id: "u" }, { id: "v" }];

test("carga · fallo HTTP (500/404) y de red: se marca como fallida, sin datos viejos ni ceros", async () => {
  const L = makeLoader(PEOPLE);
  for (const r of [() => ({ ok: false, status: 500, json: async () => ({ error: "server_error" }) }), () => ({ ok: false, status: 404, json: async () => ({}) }), () => Promise.reject(new Error("red"))]) {
    L.set(r); await L.run();
    assert.deepEqual(L.state(), { allPicksCache: {}, allPicksLoadFailed: true });
  }
});

test("carga · un 200 no basta: forma inválida o respuesta incompleta = carga fallida", async () => {
  const bad = [
    {}, { picks: { u: {}, v: {} } }, { ok: false, picks: { u: {}, v: {} } }, { ok: true }, { ok: true, picks: null }, { ok: true, picks: [] },
    { ok: true, picks: { u: { r1: { a: "A" } } } },            // falta v
    { ok: true, picks: { u: {}, v: null } },                    // v no es objeto
    { ok: true, picks: { u: {}, v: [] } },
    { ok: true, picks: { u: {}, V: {} } },                      // otro id (v sigue en el servidor)
    null, "texto",
  ];
  for (const body of bad) {
    const L = makeLoader(PEOPLE);
    L.set(ok200(body)); await L.run();
    assert.deepEqual(L.state(), { allPicksCache: {}, allPicksLoadFailed: true }, JSON.stringify(body));
  }
  const L = makeLoader(PEOPLE);
  L.set(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("no es JSON"); } }));
  await L.run();
  assert.equal(L.state().allPicksLoadFailed, true, "200 con un cuerpo que no es JSON");
});

test("carga · quien no pronosticó llega como {} y es una entrada válida (no es una carga incompleta)", async () => {
  const L = makeLoader([{ id: "u" }, { id: "v" }, { id: "u" }]); // un id repetido en la meta: se pide una vez
  L.set(ok200({ ok: true, picks: { u: { r1: { a: "A" } }, v: {} } }));
  await L.run();
  assert.deepEqual(L.state(), { allPicksCache: { u: { r1: { a: "A" } }, v: {} }, allPicksLoadFailed: false });
  // Se pide lo mismo de siempre (el servidor decide qué se ve de cada quien).
  assert.deepEqual(L.calls[0], { metaKey: "quiniela:x:meta", participantIds: ["u", "v", "u"] });
  // Quiniela sin participantes: { ok:true, picks:{} } es completa.
  const E = makeLoader([]);
  E.set(ok200({ ok: true, picks: {} })); await E.run();
  assert.deepEqual(E.state(), { allPicksCache: {}, allPicksLoadFailed: false });
});

test("carga · se recupera: falla → completa → falla otra vez (sin quedarse con lo de antes)", async () => {
  const L = makeLoader(PEOPLE);
  L.set(ok200({ ok: true, picks: { u: {} } })); await L.run();
  assert.equal(L.state().allPicksLoadFailed, true);
  L.set(ok200({ ok: true, picks: { u: { r1: { a: "B" } }, v: {} } })); await L.run();
  assert.deepEqual(L.state(), { allPicksCache: { u: { r1: { a: "B" } }, v: {} }, allPicksLoadFailed: false });
  L.set(() => ({ ok: false, status: 503, json: async () => ({}) })); await L.run();
  assert.deepEqual(L.state(), { allPicksCache: {}, allPicksLoadFailed: true });
});

test("carga · meta desactualizada: falta alguien que el servidor ya no tiene (lo borró otro dispositivo) → carga válida, como en main", async () => {
  // La página cree que hay u, v y w; en el servidor, w ya no existe: no viene.
  const L = makeLoader([{ id: "u" }, { id: "v" }, { id: "w" }], [{ id: "u" }, { id: "v" }]);
  L.set(ok200({ ok: true, picks: { u: { r1: { a: "A" } }, v: {} } }));
  await L.run();
  assert.deepEqual(L.state(), { allPicksCache: { u: { r1: { a: "A" } }, v: {} }, allPicksLoadFailed: false });
  assert.deepEqual(L.metaReads, ["quiniela:x:meta"], "se confirma con la meta actual del servidor");
  // Si w sigue en el servidor y tampoco viene al repetir la consulta, la respuesta está incompleta.
  const I = makeLoader([{ id: "u" }, { id: "v" }, { id: "w" }]);
  I.set(ok200({ ok: true, picks: { u: {}, v: {} } })); await I.run();
  assert.deepEqual(I.state(), { allPicksCache: {}, allPicksLoadFailed: true });
  assert.equal(I.calls.length, 2, "se repite la consulta una sola vez");
  // Sin poder leer la meta actual (404, error HTTP o de red): no se da por buena.
  for (const f of [() => ({ found: false }), () => { throw new Error("kv get failed: HTTP 500"); }]) {
    const X = makeLoader([{ id: "u" }, { id: "w" }], [{ id: "u" }]);
    X.set(ok200({ ok: true, picks: { u: {} } })); X.setServerMeta(f); await X.run();
    assert.equal(X.state().allPicksLoadFailed, true);
  }
  // Respuesta completa: no hace falta leer la meta.
  const C = makeLoader([{ id: "u" }]);
  C.set(ok200({ ok: true, picks: { u: {} } })); await C.run();
  assert.deepEqual(C.metaReads, []);
});

test("carga · carrera: alguien entra justo después de la consulta (el admin lo agregó) → se repite una vez y la carga es válida, como en main", async () => {
  // La página ya tiene a w (alta optimista); la 1.ª consulta llegó antes que
  // el guardado y no lo trae; la meta actual del servidor ya lo tiene.
  const L = makeLoader([{ id: "u" }, { id: "w" }], [{ id: "u" }, { id: "w" }]);
  let n = 0;
  L.set(() => { n++; return ok200(n === 1 ? { ok: true, picks: { u: { r1: { a: "A" } } } } : { ok: true, picks: { u: { r1: { a: "A" } }, w: {} } })(); });
  await L.run();
  assert.deepEqual(L.state(), { allPicksCache: { u: { r1: { a: "A" } }, w: {} }, allPicksLoadFailed: false });
  assert.equal(L.calls.length, 2);
  // Si la 2.ª respuesta trae una forma inválida, la carga falla (no se mezcla con la 1.ª).
  const B = makeLoader([{ id: "u" }, { id: "w" }]);
  let m = 0;
  B.set(() => { m++; return ok200(m === 1 ? { ok: true, picks: { u: {} } } : { ok: true, picks: { u: [], w: {} } })(); });
  await B.run();
  assert.deepEqual(B.state(), { allPicksCache: {}, allPicksLoadFailed: true });
  // Y si la 2.ª es un error HTTP, también.
  const H = makeLoader([{ id: "u" }, { id: "w" }]);
  let k = 0;
  H.set(() => { k++; return k === 1 ? ok200({ ok: true, picks: { u: {} } })() : { ok: false, status: 500, json: async () => ({}) }; });
  await H.run();
  assert.equal(H.state().allPicksLoadFailed, true);
});

test("carga · la respuesta real del servidor cumple el contrato que valida el navegador", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = extractFrom(server, 'app.post("/api/picks-batch", async (req, res) =>');
  assert.ok(route.includes("if (raw == null) { picks[pid] = {}; continue; }"), "quien no pronosticó llega como {}");
  assert.ok(route.includes("res.json({ ok: true, picks });"));
  assert.ok(route.includes(".slice(0, 2000)"), "mismo tope que el navegador");
});

test("Tabla, Historial y Solo ver: con la carga fallida no se calcula ni se pinta una clasificación", () => {
  const tabla = fn("async function renderTabla(main)");
  const gT = tabla.indexOf("if(allPicksLoadFailed){");
  assert.ok(gT !== -1 && gT < tabla.indexOf("const list = standingsList();"), "la guarda existe y va antes de calcular");
  assert.ok(tabla.includes("No pudimos cargar los pronósticos para calcular la tabla."));
  const hist = fn("function renderHistDetail(round)");
  const gH = hist.indexOf("if(allPicksLoadFailed){");
  assert.ok(gH !== -1 && gH < hist.indexOf("if(isLg(round)){"), "la guarda existe y va antes de pintar");
});

test("Solo ver · con la carga fallida: aviso y reintento («Cargando…» en el botón, foco), sin tabla; al reintentar con la carga completa, la clasificación vuelve", async () => {
  const src = fn("async function retryPicksLoad(btn, rerender, landing)") + "\n" + fn("async function renderSpectatorView()");
  let failNext = true, loads = 0;
  const focused = [];
  // DOM mínimo: el botón del aviso es un objeto con lo que usa retryPicksLoad.
  const makeBtn = () => {
    const attrs = {}, kids = [];
    const parent = { querySelector: (sel) => kids.find((k) => k.className === sel.slice(1)) || null };
    const b = { id: "qz-spectator-retry", isConnected: true, textContent: "Volver a intentar", listeners: {}, parentElement: parent,
      getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: (k) => { delete attrs[k]; },
      addEventListener(ev, f) { this.listeners[ev] = f; }, matches: () => true, focus() { focused.push("#retry"); }, before(el) { kids.push(el); } };
    return { b, kids };
  };
  let cur = null;
  const root = { set innerHTML(v) { this._h = v; if (cur) cur.b.isConnected = false; cur = v.includes('id="qz-spectator-retry"') ? makeBtn() : null; }, get innerHTML() { return this._h; },
    querySelector: (sel) => ({ sel, matches: () => false, setAttribute() {}, focus() { focused.push(sel); } }) };
  const document = { getElementById: (id) => (id === "qz-spectator-retry" && cur ? cur.b : null),
    createElement: () => ({ className: "", textContent: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) };
  const state = {};
  const view = new Function("root", "document", "ensureAllPicksLoaded", "standingsList", "state", `
    const meta = { groupName: "Liga <b>", settings: { entryFee: 0 }, participants: [{ id: "u", name: "Ana", paid: false }], rounds: [] };
    const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const feeSummaryHtml = () => ({ feeDisplay: "$0", recaudadoDisplay: "$0" });
    ${fn("function computeDenseRanks(list)")}
    let allPicksLoadFailed;
    Object.defineProperty(state, "failed", { set(v) { allPicksLoadFailed = v; } });
    ${src}
    return renderSpectatorView;`)(root, document, async () => { loads++; state.failed = failNext; }, () => [{ id: "u", name: "Ana", pts: -7, isAdmin: false }], state);
  await view();
  assert.match(root.innerHTML, /No pudimos cargar los pronósticos para calcular la tabla\./);
  assert.match(root.innerHTML, /role="alert"/);
  assert.doesNotMatch(root.innerHTML, /<table|Recaudado/);
  // Reintento que vuelve a fallar: el aviso se queda, el botón dice «Cargando…»
  // mientras tanto, y luego vuelve con una nota y con el foco.
  const first = cur;
  const p1 = first.b.listeners.click();
  assert.equal(first.b.textContent, "Cargando…");
  assert.equal(first.b.getAttribute("aria-disabled"), "true");
  await first.b.listeners.click(); // un segundo toque mientras carga no hace nada
  await p1;
  assert.equal(cur, first, "el aviso no se repintó");
  assert.equal(first.b.textContent, "Volver a intentar");
  assert.equal(first.b.getAttribute("aria-disabled"), null);
  assert.match(first.kids[0].textContent, /Lo intentamos de nuevo y todavía no se pudo/);
  assert.equal(first.kids[0].attrs.role, "status");
  assert.deepEqual(focused, ["#retry"]);
  assert.equal(loads, 2, "1 carga inicial + 1 del reintento (el toque doble no carga)");
  // Reintento con la carga completa: vuelve la clasificación y el foco a su título.
  failNext = false;
  await first.b.listeners.click();
  assert.match(root.innerHTML, /<table/);
  assert.match(root.innerHTML, /<td style="text-align:center;font-weight:700;">−7<\/td>/);
  assert.doesNotMatch(root.innerHTML, /No pudimos cargar/);
  assert.deepEqual(focused, ["#retry", ".qz-main .section-title"]);
});

test("Gráfica · con una carga posterior fallida (p. ej. el Excel) no dibuja posiciones; Tabla e Historial usan el mismo reintento", () => {
  const chart = fn("function renderProgressChart(orderedList)");
  assert.ok(chart.indexOf("if(allPicksLoadFailed){") !== -1 && chart.indexOf("if(allPicksLoadFailed){") < chart.indexOf("progressData()"));
  const tabla = fn("async function renderTabla(main)");
  assert.ok(tabla.includes('retryPicksLoad(retryBtn, () => renderTabla(main), () => main.querySelector("[data-bd]"))'));
  const hist = fn("function renderHistDetail(round)");
  assert.ok(hist.includes('retryPicksLoad(retryBtn, () => { if(detail.isConnected) renderHistDetail(round); }, () => detail.querySelector("h3"))'));
  assert.ok(hist.indexOf("window.scrollTo({ top: Math.max(0, top)") !== -1 && hist.indexOf("window.scrollTo({ top: Math.max(0, top)") < hist.indexOf("if(isLg(round)){"), "el aviso se lleva a la vista");
});

// ---- Excel (XLSX simulado: no es el generador real) ---------------------------
async function runExcel({ metaOver, failed }) {
  const sheets = {}, written = [], toasts = [];
  const XLSX = { utils: { book_new: () => ({}), json_to_sheet: (rows) => rows, aoa_to_sheet: (aoa) => ({ aoa }), book_append_sheet: (wb, rows, name) => { sheets[name] = rows; } }, writeFile: (wb, f) => written.push(f) };
  const meta = { groupName: "Liga", settings: { entryFee: 0 }, rounds: [], customBets: [],
    participants: [{ id: "a", name: "Ana", paid: true, pts: 9 }, { id: "b", name: "Beto", paid: true, pts: 4 }], ...metaOver };
  const run = new Function("XLSX", "meta", "toast", "failed", `
    let allPicksCache = {}, allPicksLoadFailed = false;
    async function ensureXLSXLoaded(){}
    async function ensureAllPicksLoaded(){ allPicksLoadFailed = failed; }
    function standingsList(){ return meta.participants.slice(); }
    function pointsFor(id){ return { pts: meta.participants.find(p => p.id === id).pts }; }
    function isLg(){ return false; }
    ${fn("function computeDenseRanks(list)")}
    ${fn("function paymentsTracked()")}
    ${fn("async function exportExcel()")}
    return exportExcel;`)(XLSX, meta, (m) => toasts.push(m), failed);
  await run();
  return { sheets, written, toasts };
}
test("Excel · con la carga fallida o incompleta no se descarga nada ni se anuncia éxito (tampoco la hoja «Pagos»)", async () => {
  const r = await runExcel({ failed: true });
  assert.deepEqual(r.written, []);
  assert.deepEqual(Object.keys(r.sheets), []);
  assert.ok(!r.toasts.some((t) => /Listo|descargó/.test(t)), JSON.stringify(r.toasts));
  assert.ok(r.toasts.includes("No pudimos cargar todos los pronósticos, así que no se generó el Excel. Vuelve a intentarlo."));
});
test("Excel · hoja Tabla: «Pagó» según paymentsTracked(), igual que la app y la imagen", async () => {
  // Sin seguimiento (sin cuota, sin penalización, nadie marcado): sin «Pagó».
  const sin = await runExcel({ metaOver: { participants: [{ id: "a", name: "Ana", paid: false, pts: 9 }, { id: "b", name: "Beto", paid: false, pts: 4 }] } });
  assert.deepEqual(sin.sheets.Tabla, [{ "#": 1, Participante: "Ana", Puntos: 9 }, { "#": 2, Participante: "Beto", Puntos: 4 }]);
  assert.deepEqual(sin.written, ["quiniela_Liga.xlsx"]);
  assert.ok(sin.toasts.includes("✅ Listo, tu Excel se descargó."));
  // Hoja «Pagos» sin seguimiento: se queda, sólo con el aviso; nadie «No pagó».
  assert.deepEqual(sin.sheets.Pagos, { aoa: [["Esta quiniela no lleva registro de pagos"]] });
  // Con cuota y todos pagados: la columna se conserva.
  const todos = await runExcel({ metaOver: { settings: { entryFee: 100 } } });
  assert.deepEqual(todos.sheets.Tabla.map((r) => r["Pagó"]), ["Sí", "Sí"]);
  assert.deepEqual(todos.sheets.Pagos, [{ Participante: "Ana", Cuota: 100, "Pagó": "Sí" }, { Participante: "Beto", Cuota: 100, "Pagó": "Sí" }], "con seguimiento y todos pagados, la hoja «Pagos» conserva los pagos reales");
  // Seguimiento sólo por penalización (cuota 0): también.
  const pen = await runExcel({ metaOver: { paymentPenalty: { enabled: true, startsAtRound: 1 }, participants: [{ id: "a", name: "Ana", paid: false, pts: 9 }, { id: "b", name: "Beto", paid: true, pts: 4 }] } });
  assert.deepEqual(pen.sheets.Tabla.map((r) => r["Pagó"]), ["No", "Sí"]);
  assert.deepEqual(pen.sheets.Pagos.map((r) => r["Pagó"]), ["No", "Sí"], "con seguimiento, «No» es un pago pendiente real");
  // Nada más cambia de forma: mismas hojas y mismas columnas de puntos.
  assert.deepEqual(Object.keys(todos.sheets), ["Tabla", "Jornada detalle", "Estadísticas", "Pagos"]);
});

// ---- Gráfica de evolución: aviso visible, fórmula igual -----------------------
test("Gráfica · aviso visible y accesible (también en móvil) que manda a la Tabla; la fórmula no cambia", (t) => {
  const tabla = fn("async function renderTabla(main)");
  assert.ok(tabla.includes('<p class="qz-chart-note" id="qz-chart-note">Esta gráfica se calcula con los datos actuales y puede no coincidir con la Tabla, sobre todo si hay descuentos de jornadas que el admin eliminó. La clasificación vigente es la de la Tabla de posiciones.</p>'));
  assert.ok(tabla.includes('<div id="qz-chart-svg" role="group" aria-label="Gráfica de evolución de posiciones" aria-describedby="qz-chart-note"'));
  assert.ok(!/@media[^{]*\{[^}]*qz-chart-note[^}]*display:\s*none/.test(indexSrc), "no se oculta en pantallas angostas");
  let orig;
  try { orig = execFileSync("git", ["show", `${ORIG.sha}:public/index.html`], { cwd: path.join(__dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { t.skip("este checkout no tiene el commit 6ef81ce"); return; }
  assert.equal(fn("function progressData()"), extractFrom(orig, "function progressData()"), "misma fórmula de la gráfica");
  // renderProgressChart: igual que main salvo la guarda de carga fallida (no
  // dibuja posiciones sin pronósticos).
  const guard = fn("function renderProgressChart(orderedList)").match(/\n    \/\/ Si una carga posterior falló[\s\S]*?\n    \}\n/);
  assert.ok(guard && guard[0].includes("if(allPicksLoadFailed){"), "la guarda existe");
  assert.equal(fn("function renderProgressChart(orderedList)").replace(guard[0], "\n"), extractFrom(orig, "function renderProgressChart(orderedList)"));
});

// ---- Tabla: «Ver desglose» -----------------------------------------------------
test("Tabla · cada fila tiene «Ver desglose» con aria-expanded/aria-controls y su detalle oculto debajo", () => {
  const tabla = fn("async function renderTabla(main)");
  assert.ok(tabla.includes('<button type="button" class="qz-bd-btn" data-bd="${i}" aria-expanded="false" aria-controls="qz-bd-${i}">Ver desglose'));
  assert.ok(tabla.includes('<tr class="qz-bd-row" id="qz-bd-${i}" hidden>'));
  assert.ok(tabla.includes("Total del torneo"));
  for (const line of ["Puntos base por partidos", "Bono por marcador exacto", "Preguntas de jornada", "Preguntas del torneo", "Descuentos por no pagar", "Descuentos de jornadas eliminadas"]) {
    assert.ok(tabla.includes(line), line);
  }
  // El desglose sólo lleva cantidades: nada de respuestas ni pronósticos.
  const bd = tabla.slice(tabla.indexOf("function breakdownHtml(p){"), tabla.indexOf("main.innerHTML = `", tabla.indexOf("function breakdownHtml(p){")));
  assert.ok(!/guess|customBetAnswers|allPicksCache|__extra/.test(bd), "no lee respuestas ni pronósticos");
  const bk = fn("function pointsBreakdown(participantId, participantMap)");
  assert.ok(!/guess|__extra/.test(bk));
});

test("un id de jornada como «constructor» o «toString» no hereda nada: el total sigue siendo un número", () => {
  const rounds = ["constructor", "toString"].map((id, i) => ({ id, number: i + 1, deadline: PAST, published: true, resultsPublished: true, matches: [{ id: "a", teamA: "X", teamB: "Y" }], results: { a: "A" } }));
  const meta = { settings: { pointsPerCorrectPick: 3 }, participants: [{ id: "u", name: "U", paid: true }], rounds, customBets: [] };
  const picks = { u: { constructor: { a: "A" }, toString: { a: "B" } } };
  const N = newModel(meta, picks);
  assert.deepEqual(rounds.map((r) => N.roundTotalParts("u", r, picks.u[r.id]).total), [3, 0]);
  assert.equal(N.pointsBreakdown("u").total, 3);
});

// ---- Reglas: no se quita una pregunta con respuestas desconocidas -------------
function reglasCard(state) {
  const src = ["function betAnswerCount(bet)", "function betAnswersUnknown(bet)", "function betHitCount(bet)", "function reglasBetCardHtml(bet, i, all)"].map(fn).join("\n");
  const constLine = indexSrc.match(/\n  const BET_ANSWERS_UNKNOWN_MSG = "[^"]+";/)[0];
  return new Function("meta", "allPicksCache", "allPicksLoadFailed", `
    const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const pointsWord = (n) => Number(n) === 1 ? "punto" : "puntos";
    const scopeLabel = (s) => s === "jornada" ? "Cada jornada" : "Todo el torneo";
    const betCloseInfo = () => ({ kind: "jornada" });
    const betCloseLine = () => "Cierra con cada jornada";
    ${constLine}
    ${src}
    return { card: (bet, i, all) => reglasBetCardHtml(bet, i, all), unknown: betAnswersUnknown, count: betAnswerCount };`)(state.meta, state.picks, state.failed);
}
const RG_META = {
  participants: [{ id: "beto", name: "Beto", customBetAnswers: { bt: { guess: "Toros" } } }, { id: "diego", name: "Diego" }],
  rounds: [{ id: "r5", number: 5, customBetResults: { bj: { beto: true } } }],
  customBets: [{ id: "bj", label: "¿Quién anota?", scope: "jornada", points: 5 }, { id: "bv", label: "¿Rojas?", scope: "jornada", points: 2 }, { id: "bt", label: "Campeón", scope: "temporada", points: 10 }],
};
const RG_PICKS = { beto: { r5: { __extra: { bj: "Halcones" } } }, diego: { r5: { __extra: { bj: "Toros" } } } };

test("Reglas · con la carga fallida, una pregunta de jornada no dice «Sin respuestas»: avisa, ofrece reintento y «Quitar» queda bloqueado", () => {
  const R = reglasCard({ meta: RG_META, picks: {}, failed: true });
  const [bj, bv, bt] = RG_META.customBets;
  const html = R.card(bj, 0, RG_META.customBets);
  assert.match(html, /Respuestas sin cargar/);
  assert.doesNotMatch(html, /Sin respuestas todavía/);
  assert.match(html, /<p id="qz-rb-unk-bj">No pudimos cargar las respuestas\. Vuelve a intentarlo antes de quitar esta pregunta\.<\/p>/);
  assert.match(html, /<div class="qz-picks-loadfail qz-rb-unknown" role="alert">/, "el primer aviso se anuncia");
  assert.match(html, /data-rb-retry="bj">Volver a intentar<\/button>/);
  assert.match(html, /data-rb-del="bj" aria-disabled="true" aria-describedby="qz-rb-unk-bj">Quitar/);
  assert.doesNotMatch(R.card(bv, 1, RG_META.customBets), /role="alert"/, "sólo un aviso con role=alert");
  // Las del torneo vienen en la meta: no dependen de la carga.
  assert.equal(R.unknown(bt), false);
  // Una antigua sin tipo cuenta sus respuestas en los pronósticos (como betAnswerCount): también se protege.
  assert.equal(R.unknown({ id: "old", label: "Antigua", points: 1 }), true);
  const tHtml = R.card(bt, 2, RG_META.customBets);
  assert.match(tHtml, /1 respuesta</);
  assert.doesNotMatch(tHtml, /aria-disabled|No pudimos cargar/);
});

test("Reglas · con la carga completa: conteos verdaderos; una entrada vacía válida sigue siendo «Sin respuestas todavía»", () => {
  const R = reglasCard({ meta: RG_META, picks: RG_PICKS, failed: false });
  const [bj, bv] = RG_META.customBets;
  const a = R.card(bj, 0, RG_META.customBets);
  assert.match(a, /2 respuestas</);
  assert.match(a, /1 acierto marcado/);
  assert.doesNotMatch(a, /aria-disabled|No pudimos cargar/);
  // Nadie respondió de verdad (entradas {} válidas): se puede quitar.
  const E = reglasCard({ meta: RG_META, picks: { beto: {}, diego: {} }, failed: false });
  const b = E.card(bv, 1, RG_META.customBets);
  assert.match(b, /Sin respuestas todavía/);
  assert.doesNotMatch(b, /aria-disabled|No pudimos cargar/);
});

test("Reglas · «Quitar» comprueba al ejecutar (antes de preguntar y antes de escribir), no sólo por el aspecto del botón", () => {
  const r = fn("async function renderAdminReglas(body, opts)");
  const h = r.slice(r.indexOf('body.querySelectorAll("[data-rb-del]")'));
  const g1 = h.indexOf("if(betAnswersUnknown(bet)){ toast(BET_ANSWERS_UNKNOWN_MSG, 6000); return; }");
  const conf = h.indexOf("await qzConfirm(");
  const g2 = h.indexOf("if(betAnswersUnknown(bet)){ toast(BET_ANSWERS_UNKNOWN_MSG, 6000); return; }", g1 + 1);
  const write = h.indexOf("await setMetaWithError(meta)");
  const mutate = h.indexOf("meta.customBets = meta.customBets.filter");
  assert.ok(g1 !== -1 && g1 < conf, "antes de la confirmación");
  assert.ok(g2 !== -1 && conf < g2 && g2 < mutate && mutate < write, "y antes de tocar la meta y escribir");
  assert.ok(r.includes('retryPicksLoad(btn, () => renderAdminReglas(body, { quick: true })'), "el reintento sólo lee y repinta");
});

// ---- Reglas: no se cambia el tipo de una pregunta con respuestas sin cargar ----
function reglasForm(state) {
  const src = ["function betAnswerCount(bet)", "function betAnswersUnknown(bet)", "function betScopeKind(scope)", "function reglasBetFormHtml(f)"].map(fn).join("\n");
  const consts = [/\n  const BET_TYPE_LOCKED_MSG = "[^"]+";/, /\n  const EXTRA_CUSTOM_KEY = "[^"]+";/, /\n  const EXTRA_TEXT_MAX = \d+;/].map((re) => indexSrc.match(re)[0]).join("");
  return new Function("meta", "allPicksCache", "allPicksLoadFailed", `
    const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const scopeLabel = (s) => s === "temporada" ? "Una vez por torneo" : "Cada jornada";
    const scopeHelp = () => "";
    const extraTemplate = () => null;
    const EXTRA_TEMPLATES = [];
    const closableRounds = () => [];
    const betCloseFixed = () => false;
    const betCloseInfo = () => ({ kind: "none" });
    const betCloseLine = () => "";
    const sameInstantMs = () => false;
    const fmtWhenTz = (x) => String(x);
    ${consts}
    ${src}
    return reglasBetFormHtml;`)(state.meta, state.picks, state.failed);
}
const TP_META = {
  participants: [{ id: "beto", name: "Beto" }, { id: "diego", name: "Diego" }],
  rounds: [{ id: "r5", number: 5, customBetResults: { bj: { beto: true } } }],
  customBets: [{ id: "bj", label: "¿Quién anota?", scope: "jornada", points: 5 }, { id: "bv", label: "¿Rojas?", scope: "jornada", points: 2 }, { id: "bl", label: "Antigua", points: 4 }, { id: "bt", label: "Campeón", scope: "temporada", points: 10 }],
};
const formOf = (id) => ({ id, template: "custom", text: "x", scope: id === "bt" ? "temporada" : "temporada", points: "5", closes: "" });

test("Reglas · tipo con respuestas sin cargar: selector deshabilitado, aviso con reintento y el formulario vuelve al tipo original", () => {
  const render = reglasForm({ meta: TP_META, picks: {}, failed: true });
  for (const id of ["bj", "bv"]) {
    const f = formOf(id); // el formulario traía «temporada» (p. ej. abierto antes del fallo)
    const html = render(f);
    assert.match(html, /<fieldset class="qz-scope" disabled aria-describedby="qz-rb-type-lock">/, id);
    assert.match(html, /<p id="qz-rb-type-lock">Carga las respuestas antes de cambiar el tipo de pregunta\.<\/p>/);
    assert.match(html, /id="qz-rb-form-retry">Volver a intentar<\/button>/);
    assert.match(html, /value="jornada" checked/, "se ve el tipo original");
    assert.equal(f.scope, "jornada", "y es el que queda en el formulario");
    assert.doesNotMatch(html, /ya hay respuestas/, "no se afirma nada sobre las respuestas");
  }
  // Antigua sin tipo: la app la trata como «Cada jornada»; se bloquea y su tipo sigue sin definir.
  const fl = formOf("bl");
  const hl = render(fl);
  assert.match(hl, /<fieldset class="qz-scope" disabled/);
  assert.match(hl, /value="jornada" checked/);
  assert.equal(fl.scope, undefined, "no se le asigna un tipo");
  // La del torneo no depende de la carga: no se bloquea por esto.
  assert.doesNotMatch(render(formOf("bt")), /Carga las respuestas|disabled aria-describedby/);
});

test("Reglas · tipo con la carga correcta: con respuestas, la restricción de siempre; sin respuestas, se puede cambiar", () => {
  const render = reglasForm({ meta: TP_META, picks: { beto: { r5: { __extra: { bj: "A", bl: "B" } } }, diego: {} }, failed: false });
  const hj = render(formOf("bj"));
  assert.match(hj, /<fieldset class="qz-scope" disabled >/);
  assert.match(hj, /No se puede cambiar el tipo porque ya hay respuestas\./);
  assert.doesNotMatch(hj, /Carga las respuestas/);
  const fv = formOf("bv");
  const hv = render(fv);
  assert.match(hv, /<fieldset class="qz-scope"  >/, "habilitado");
  assert.match(hv, /value="temporada" checked/, "conserva lo que eligió el admin");
  assert.equal(fv.scope, "temporada");
  assert.match(render(formOf("bl")), /ya hay respuestas/, "la antigua con 1 respuesta mantiene su restricción");
});

test("Reglas · el guardado comprueba el tipo al empezar y otra vez después de la confirmación, antes de tocar la meta", () => {
  const r = fn("async function renderAdminReglas(body, opts)");
  const h = r.slice(r.indexOf('if(saveForm) saveForm.addEventListener("click", async () => {'));
  const g1 = h.indexOf("if(typeChangeBlocked()){ blockTypeChange(); return; }");
  const conf = h.indexOf("await qzConfirm(");
  const g2 = h.indexOf("if(typeChangeBlocked()){ blockTypeChange(); return; }", g1 + 1);
  const keep2 = h.indexOf("if(editingBet && betAnswersUnknown(editingBet)) scope = editingBet.scope;");
  const mutate = h.indexOf("editingBet.scope = scope;");
  const write = h.indexOf("await setMetaWithError(meta, { betsEdited: true })");
  assert.ok(g1 !== -1 && g1 < conf, "antes de la confirmación");
  assert.ok(g2 !== -1 && conf < g2 && g2 < keep2 && keep2 < mutate && mutate < write, "y después, antes de cambiar la meta y escribir");
  assert.ok(h.includes("let scope = editingBet && betAnswersUnknown(editingBet) ? editingBet.scope"), "con respuestas sin cargar se conserva el tipo exacto");
  // El selector tampoco acepta el cambio aunque se quite el bloqueo del HTML.
  assert.ok(r.includes('if(formTypeLocked()){ toast(BET_TYPE_LOCKED_MSG, 6000); repaint(); return; }'));
});
