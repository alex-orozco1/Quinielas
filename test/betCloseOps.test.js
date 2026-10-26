// MS2 · D4 — betCloseOps.js, la parte pura: inventario, decisiones, respaldo,
// comprobación después de aplicar y vuelta atrás. La operación de punta a punta
// sobre PostgreSQL está en betCloseOps.integration.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const ops = require("../betCloseOps");
const { planBetCloseMigration } = require("../betCloseMigration");

const NOW = Date.parse("2026-10-15T18:00:00Z");
const CUT = new Date(NOW).toISOString();
const at = (h) => new Date(NOW + h * 3600e3).toISOString();
const round = (id, number, deadline) => ({ id, number, deadline, matches: [] });
const t = (id, closesAtRound, extra) => ({ id, label: "q " + id, scope: "temporada", points: 3, closesAtRound, ...extra });

test("inventario: un cierre numérico o en arreglo es legible; el goleador apagado o sin su jornada se reporta tal cual", () => {
  const m = { rounds: [round("r_1", 1, NOW + 3600e3), round("r_2", 2, [at(5)]), round("r_3", 3, "pendiente")],
    customBets: [t("a", 1), t("b", 2), t("c", 3)], golScorerBet: { enabled: false, closesAtRound: "7" },
    participants: [{ id: "p", golScorerGuess: "  " }] };
  const inv = ops.inventoryOf(m, NOW);
  assert.deepEqual(inv.unreadableDeadline.map((x) => x.betId), ["c"], "sólo la de texto ilegible");
  assert.deepEqual(inv.legacyScorer, { enabled: false, closesAtRound: 7, state: "jornada_no_existe", roundId: null, answers: 0, hits: 0 });
  assert.equal(ops.inventoryOf({ rounds: [round("r_1", 1, at(3))], customBets: [t("a", 1)], customBetsMigrated: true }, NOW), null, "sin excepciones: nada");
});

test("decisiones: un candidato que cambió, una decisión que no es link ni cutoff o una pregunta que no es ambigua son errores", () => {
  const m = { tournamentEpoch: 1, pastTournaments: [{ rounds: [] }], rounds: [round("r_a", 1, at(10)), round("r_b", 1, at(20))], customBets: [t("x", 1)] };
  const plan = planBetCloseMigration(m, { nowMs: NOW, cutoffIso: CUT });
  const dry = { mode: "report", totals: { needsReview: 0 }, quinielas: [{ slug: "s", questions: plan.items, alreadyMigrated: false }] };
  const cand = plan.items[0].candidates.find((c) => c.roundId === "r_b");
  // El ensayo sin el override: la decisión link no se aplicó.
  const link = { s: { x: { action: "link", roundId: "r_b", roundNumber: 1, roundDeadline: cand.deadline } } };
  assert.deepEqual(ops.checkDecisions(link, dry).errors.map((e) => e.reason), ["el_ensayo_no_aplico_la_decision"]);
  assert.deepEqual(ops.checkDecisions({ s: { x: { ...link.s.x, roundDeadline: at(21) } } }, dry).errors.map((e) => e.reason), ["candidato_cambiado"]);
  assert.deepEqual(ops.checkDecisions({ s: { x: "link" } }, dry).errors.map((e) => e.reason), ["decision_invalida"]);
  assert.deepEqual(ops.checkDecisions({ s: { x: { action: "cutoff" } } }, dry).errors, []);
  assert.deepEqual(ops.checkDecisions({ s: { x: { action: "cutoff" } } }, { ...dry, totals: { needsReview: 1 } }).errors.map((e) => e.reason), ["el_ensayo_tiene_needsReview"]);
  const lig = { rounds: [round("r_1", 1, at(10))], customBets: [t("y", 1)] };
  const dry2 = { mode: "report", totals: {}, quinielas: [{ slug: "s", questions: planBetCloseMigration(lig, { nowMs: NOW, cutoffIso: CUT }).items }] };
  assert.deepEqual(ops.checkDecisions({ s: { y: { action: "cutoff" } } }, dry2).errors.map((e) => e.reason), ["pregunta_no_es_ambigua"]);
});

test("comprobar después: el `rev` de un participante (sello) no cuenta; cualquier otro cambio del participante, sí", () => {
  const before = { rounds: [round("r_1", 1, at(10))], customBets: [t("y", 1)], participants: [{ id: "p", name: "N", customBetAnswers: { y: { guess: "g", correct: true } } }] };
  const plan = planBetCloseMigration(before, { nowMs: NOW, cutoffIso: CUT });
  const entry = { applied: true, cutoff: CUT, questions: plan.items };
  const after = JSON.parse(JSON.stringify(plan.next));
  after.participants[0].rev = 0;
  after.betsRevision = 1;
  assert.deepEqual(ops.verifyQuiniela(before, after, entry), []);
  after.participants[0].name = "M";
  assert.deepEqual(ops.verifyQuiniela(before, after, entry), ["participants (respuestas, aciertos u otros datos)"]);
  after.participants[0].name = "N";
  after.customBets[0].label = "otra";
  assert.deepEqual(ops.verifyQuiniela(before, after, entry), ["customBets.y (texto, tipo, puntos o jornada)"]);
});

test("volver atrás: no toca una quiniela si cerraron el torneo o quitaron la pregunta después de aplicar", () => {
  const before = { rounds: [round("r_1", 1, at(10))], customBets: [t("y", 1), t("z", null)] };
  const plan = planBetCloseMigration(before, { nowMs: NOW, cutoffIso: CUT });
  const entry = { applied: true, cutoff: CUT, questions: plan.items };
  const ok = ops.planRevert(plan.next, entry);
  assert.deepEqual(ok.next.customBets, before.customBets, "sin closesAt, closesRoundId, closeSource ni closeFlag");
  assert.equal(ok.next.betCloseMigration, undefined);
  const cerrado = { ...plan.next, customBets: [] };
  assert.deepEqual(ops.planRevert(cerrado, entry).reasons, ["y: ya_no_existe", "z: ya_no_existe"]);
  assert.deepEqual(ops.planRevert({ ...plan.next, betCloseMigration: { version: 1, cutoff: at(1) } }, entry).reasons, ["la_marca_no_es_la_de_esa_aplicacion"]);
});
