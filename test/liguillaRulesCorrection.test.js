// liguillaRulesCorrection.test.js — HOTFIX: corregir la puntuación de liguilla
// ya fijada (liguillaRules.correctLiguillaRules) sin servidor.
const test = require("node:test");
const assert = require("node:assert/strict");
const LR = require("../liguillaRules");
const L = require("../liguillaScoring");

const SCORE = { capture: "score", resultPoints: 1, exactBonus: 1 };
const NOW = "2026-11-20T12:00:00.000Z";

function doc() {
  return {
    settings: { liguilla: { ...SCORE }, pointsPerCorrectPick: 1 },
    liguillaLocks: [{ scopeId: "t1", lockedAt: "2026-11-01T00:00:00.000Z", roundId: "q1", roundNumber: 18, rules: { ...SCORE } }],
    liguillaPublished: {
      q1: { deadline: "2026-11-02T00:00:00.000Z", matchIds: ["a"], scoring: { ...SCORE } },
      old: { deadline: "2026-05-02T00:00:00.000Z", matchIds: ["z"], scoring: { capture: "result", resultPoints: 3, exactBonus: 0 } },
    },
    rounds: [
      { id: "r1", number: 1, published: true, resultsPublished: true, results: { m1: "A" }, matches: [{ id: "m1" }] },
      { id: "q1", number: 18, stage: "liguilla", deadline: "2026-11-02T00:00:00.000Z", published: true, resultsPublished: true, scoring: { ...SCORE },
        results: { a: "A" }, scores: { a: { a: 2, b: 1 } }, matches: [{ id: "a", teamA: "X", teamB: "Y" }] },
      { id: "q2", number: 19, stage: "liguilla", deadline: "2026-11-25T00:00:00.000Z", published: true, resultsPublished: false, scoring: { ...SCORE },
        results: {}, matches: [{ id: "b", teamA: "X", teamB: "Y" }] },
      { id: "q3", number: 20, stage: "liguilla", published: false, results: {}, matches: [{ id: "c" }] },
      // De otro torneo (fuera de alcance), con las mismas reglas.
      { id: "qx", number: 17, stage: "liguilla", deadline: "2026-05-02T00:00:00.000Z", published: true, resultsPublished: false, scoring: { ...SCORE }, results: {}, matches: [] },
    ],
    customBets: [{ id: "b1", points: 3 }],
    participants: [{ id: "p1", penalizedRounds: { r1: true } }],
  };
}
const run = (over = {}) => LR.correctLiguillaRules({
  value: doc(), scopeId: "t1", scopeRoundIds: new Set(["q1", "q2", "q3"]),
  expected: { resultPoints: 1, exactBonus: 1 }, next: { resultPoints: 2, exactBonus: 3 },
  actor: { participantId: "p1" }, nowIso: NOW, ...over,
});

test("corrección compatible: candado, configuración, copias de las jornadas del torneo y su registro, todo junto", () => {
  const out = run();
  assert.equal(out.ok, true);
  const NEW = { capture: "score", resultPoints: 2, exactBonus: 3 };
  const v = out.value;
  assert.deepEqual(v.liguillaLocks[0].rules, NEW);
  assert.equal(v.liguillaLocks[0].lockedAt, "2026-11-01T00:00:00.000Z", "la fecha del candado no cambia");
  assert.deepEqual(v.settings.liguilla, NEW);
  assert.deepEqual(v.rounds.find((r) => r.id === "q1").scoring, NEW);
  assert.deepEqual(v.rounds.find((r) => r.id === "q2").scoring, NEW);
  assert.equal(v.rounds.find((r) => r.id === "q3").scoring, undefined, "el borrador no lleva copia");
  assert.deepEqual(v.rounds.find((r) => r.id === "qx").scoring, SCORE, "fuera del torneo en curso no se toca");
  assert.deepEqual(v.liguillaPublished.q1.scoring, NEW);
  assert.deepEqual(v.liguillaPublished.old.scoring, { capture: "result", resultPoints: 3, exactBonus: 0 });
  assert.deepEqual(out.entry, { at: NOW, scopeId: "t1", by: { participantId: "p1", via: "admin_password" }, from: SCORE, to: NEW, rounds: ["q1", "q2"] });
  assert.deepEqual(v.liguillaRulesHistory, [out.entry]);
});

test("integridad: resultados, marcadores, fase regular, preguntas y penalizaciones quedan idénticos; la entrada no se muta", () => {
  const before = doc();
  const out = run();
  const strip = (d) => {
    const c = JSON.parse(JSON.stringify(d));
    delete c.liguillaLocks; delete c.liguillaPublished; delete c.liguillaRulesHistory; delete c.settings.liguilla;
    c.rounds.forEach((r) => delete r.scoring);
    return c;
  };
  assert.deepEqual(strip(out.value), strip(before));
  const input = doc();
  LR.correctLiguillaRules({ value: input, scopeId: "t1", scopeRoundIds: null, expected: SCORE, next: { resultPoints: 2, exactBonus: 1 }, nowIso: NOW });
  assert.deepEqual(input, doc(), "el documento leído no se modifica (rollback seguro)");
});

test("los puntos de la jornada con resultados cambian según las reglas nuevas", () => {
  const out = run();
  const q1 = out.value.rounds.find((r) => r.id === "q1");
  const picks = { a: "A", __score: { a: { a: 2, b: 1 } } };
  const pts = (round) => L.scoreMatch({ rules: L.roundRules(round), pick: "A", pickScore: { a: 2, b: 1 }, result: "A", resultScore: { a: 2, b: 1 }, status: "played", published: true }).total;
  assert.equal(pts(doc().rounds[1]), 2);
  assert.equal(pts(q1), 5);
  assert.ok(picks);
});

test("rechazos: sin candado, reglas esperadas viejas, cambio de forma, iguales, inválidas", () => {
  const noLock = doc(); noLock.liguillaLocks = [];
  assert.deepEqual(pick(LR.correctLiguillaRules({ value: noLock, scopeId: "t1", expected: SCORE, next: { resultPoints: 2, exactBonus: 1 }, nowIso: NOW })), [409, "liguilla_not_locked"]);
  const stale = run({ expected: { resultPoints: 3, exactBonus: 1 } });
  assert.deepEqual([...pick(stale), stale.current], [409, "liguilla_rules_changed", SCORE]);
  assert.deepEqual(pick(run({ expected: undefined })), [409, "liguilla_rules_changed"]);
  assert.deepEqual(pick(run({ next: { resultPoints: 2, exactBonus: 0 } })), [409, "liguilla_capture_change_blocked"], "quitar el bono cambia la captura");
  assert.deepEqual(pick(run({ next: { resultPoints: 1, exactBonus: 1 } })), [400, "liguilla_rules_unchanged"]);
  assert.deepEqual(pick(run({ next: { resultPoints: 0, exactBonus: 1 } })), [400, "liguilla_rules_result_required"]);
  assert.deepEqual(pick(run({ next: { resultPoints: "2", exactBonus: 1 } })), [400, "liguilla_rules_invalid"]);
  assert.deepEqual(pick(run({ next: { resultPoints: 2, exactBonus: 1, capture: "result" } })), [400, "liguilla_rules_invalid"]);
  const result = doc();
  result.liguillaLocks[0].rules = { capture: "result", resultPoints: 3, exactBonus: 0 };
  assert.deepEqual(pick(LR.correctLiguillaRules({ value: result, scopeId: "t1", expected: { resultPoints: 3, exactBonus: 0 }, next: { resultPoints: 3, exactBonus: 2 }, nowIso: NOW })),
    [409, "liguilla_capture_change_blocked"], "activar el bono cambia la captura");
});
function pick(r) { return [r.status, r.error]; }

test("legado (sin torneo): se corrigen las jornadas publicadas con las reglas vigentes", () => {
  const d = doc(); d.liguillaLocks[0].scopeId = LR.LEGACY_SCOPE;
  const out = LR.correctLiguillaRules({ value: d, scopeId: null, scopeRoundIds: null, expected: SCORE, next: { resultPoints: 2, exactBonus: 1 }, nowIso: NOW });
  assert.equal(out.ok, true);
  assert.deepEqual(out.entry.rounds, ["q1", "q2", "qx"]);
  assert.deepEqual(out.entry.by, { via: "admin_password" });
});

test("el historial lo escribe sólo el servidor y se limita a 50 entradas", () => {
  const d = doc();
  d.liguillaRulesHistory = Array.from({ length: 50 }, (_, i) => ({ at: "x" + i }));
  const out = LR.correctLiguillaRules({ value: d, scopeId: "t1", expected: SCORE, next: { resultPoints: 2, exactBonus: 1 }, nowIso: NOW });
  assert.equal(out.value.liguillaRulesHistory.length, 50);
  assert.equal(out.value.liguillaRulesHistory[0].at, "x1");

  const merged = JSON.parse(JSON.stringify(out.value));
  merged.liguillaRulesHistory = [];
  const w = LR.applyLiguillaWrite({ oldValue: out.value, merged, scopeId: "t1", nowIso: NOW });
  assert.notEqual(w && w.ok, false, JSON.stringify(w));
  assert.equal(merged.liguillaRulesHistory.length, 50, "un guardado normal no lo borra");
  const m2 = JSON.parse(JSON.stringify(doc()));
  m2.liguillaRulesHistory = [{ at: "inventada" }];
  LR.applyLiguillaWrite({ oldValue: doc(), merged: m2, scopeId: "t1", nowIso: NOW });
  assert.equal(m2.liguillaRulesHistory, undefined, "ni lo inventa");
});

test("pestaña atrasada: trae las reglas anteriores a la corrección → se conservan las vigentes; otras reglas siguen 409", () => {
  const out = run();
  const stale = JSON.parse(JSON.stringify(out.value));
  stale.settings.liguilla = { ...SCORE };
  const w = LR.applyLiguillaWrite({ oldValue: out.value, merged: stale, scopeId: "t1", nowIso: NOW });
  assert.notEqual(w && w.ok, false, JSON.stringify(w));
  assert.deepEqual(stale.settings.liguilla, { capture: "score", resultPoints: 2, exactBonus: 3 });
  const other = JSON.parse(JSON.stringify(out.value));
  other.settings.liguilla = { capture: "score", resultPoints: 5, exactBonus: 1 };
  const w2 = LR.applyLiguillaWrite({ oldValue: out.value, merged: other, scopeId: "t1", nowIso: NOW });
  assert.deepEqual([w2.status, w2.error], [409, "liguilla_rules_locked"]);
  const scoped = JSON.parse(JSON.stringify(out.value));
  scoped.rounds.find((r) => r.id === "q1").scoring = { ...SCORE };
  LR.applyLiguillaWrite({ oldValue: out.value, merged: scoped, scopeId: "t1", nowIso: NOW });
  assert.deepEqual(scoped.rounds.find((r) => r.id === "q1").scoring, { capture: "score", resultPoints: 2, exactBonus: 3 }, "la copia de la jornada publicada no vuelve atrás");
});
