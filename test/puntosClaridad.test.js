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
  assert.ok(lgHist.includes('"Partidos " + lgPts(t.match.pts)'));
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

// ---- una carga fallida no es cero --------------------------------------------
test("carga fallida de pronósticos: se marca como fallida (no como cero) y se recupera al volver a cargar", async () => {
  const src = fn("async function ensureAllPicksLoaded()");
  const make = new Function("fetch", "meta", "console", `
    let allPicksCache = { viejo: {} }, allPicksLoadFailed = false, allPicksLoadInFlight = null;
    const currentUser = null, currentUserPinCache = null;
    function adminOrOwnerCred(){ return null; }
    function setAuthHeaders(){}
    function currentMetaKey(){ return "k"; }
    ${src}
    return { run: ensureAllPicksLoaded, state: () => ({ allPicksCache, allPicksLoadFailed }) };`);
  let mode = "500";
  const fetchStub = async () => mode === "throw" ? Promise.reject(new Error("red"))
    : mode === "500" ? { ok: false, status: 500, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ picks: { u: { r1: { a: "A" } } } }) };
  const m = make(fetchStub, { participants: [{ id: "u" }] }, { error() {} });
  await m.run();
  assert.deepEqual(m.state(), { allPicksCache: {}, allPicksLoadFailed: true });
  mode = "ok"; await m.run();
  assert.deepEqual(m.state(), { allPicksCache: { u: { r1: { a: "A" } } }, allPicksLoadFailed: false });
  mode = "throw"; await m.run();
  assert.equal(m.state().allPicksLoadFailed, true);
  // La Tabla y el Historial no pintan puntos con una carga fallida.
  const tabla = fn("async function renderTabla(main)");
  assert.ok(tabla.indexOf("if(allPicksLoadFailed){") < tabla.indexOf("const list = standingsList();"));
  assert.ok(tabla.includes("No pudimos cargar los pronósticos para calcular la tabla."));
  const hist = fn("function renderHistDetail(round)");
  assert.ok(hist.indexOf("if(allPicksLoadFailed){") < hist.indexOf("if(isLg(round)){"));
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
