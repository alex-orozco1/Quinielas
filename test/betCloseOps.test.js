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
  const ok = ops.planRevert(plan.next, entry, before, NOW);
  assert.deepEqual(ok.next.customBets, before.customBets, "sin closesAt, closesRoundId, closeSource ni closeFlag");
  assert.equal(ok.next.betCloseMigration, undefined);
  assert.deepEqual(ok.reopens, []);
  const cerrado = { ...plan.next, customBets: [] };
  assert.deepEqual(ops.planRevert(cerrado, entry, before, NOW).reasons, ["y: ya_no_existe", "z: ya_no_existe"]);
  assert.deepEqual(ops.planRevert({ ...plan.next, betCloseMigration: { version: 1, cutoff: at(1) } }, entry, before, NOW).reasons, ["la_marca_no_es_la_de_esa_aplicacion"]);
  assert.deepEqual(ops.planRevert(plan.next, entry, null, NOW).reasons, ["falta_el_respaldo_de_antes_de_aplicar"]);
});

test("Technical QA · volver atrás no reabre una cerrada ni cambia un cierre si su jornada cambió después de aplicar; las cerradas por protección se reabren y se dicen", () => {
  // c: cerrada antes de migrar (J1 ya venció). o: abierta con la J2.
  const before = { tournamentEpoch: 0, rounds: [round("r_1", 1, at(-5)), round("r_2", 2, at(30))], customBets: [t("c", 1), t("o", 2)] };
  const plan = planBetCloseMigration(before, { nowMs: NOW, cutoffIso: CUT });
  const entry = { applied: true, cutoff: CUT, questions: plan.items };
  // Después de aplicar, el admin reabre la J1 (+72 h): deshacer reabriría «c».
  const reabierta = JSON.parse(JSON.stringify(plan.next));
  reabierta.rounds[0].deadline = at(72);
  assert.deepEqual(ops.planRevert(reabierta, entry, before, NOW).reasons, ["c: su_jornada_cambio_despues_de_aplicar"]);
  // Mueve la J2: «o» seguiría en silencio el cierre nuevo.
  const movida = JSON.parse(JSON.stringify(plan.next));
  movida.rounds[1].deadline = at(200);
  assert.deepEqual(ops.planRevert(movida, entry, before, NOW).reasons, ["o: su_jornada_cambio_despues_de_aplicar"]);
  // Una cerrada por protección (antes abierta por la lectura de siempre) se reabre al deshacer: se dice.
  const b2 = { tournamentEpoch: 0, rounds: [round("r_1", 1, at(10))], customBets: [t("p", 2), t("l", 7)] };
  b2.rounds.push(round("r_7a", 7, at(20)), round("r_7b", 7, at(40)));
  const plan2 = planBetCloseMigration(b2, { nowMs: NOW, cutoffIso: CUT });
  const r2 = ops.planRevert(plan2.next, { applied: true, cutoff: CUT, questions: plan2.items }, b2, NOW + 1000);
  assert.deepEqual(r2.reasons, []);
  assert.deepEqual(r2.reopens, ["p", "l"], "las dos cerradas por protección (p: vínculo perdido, l: ambigua) vuelven a abrirse; se dicen");
});

test("Technical QA · comprobar después: lo aplicado tiene que ser lo decidido, y una ligada con el cierre de su jornada en el respaldo", () => {
  const before = { tournamentEpoch: 1, pastTournaments: [{ rounds: [] }], rounds: [round("r_a", 1, at(10)), round("r_b", 1, at(20))], customBets: [t("x", 1)] };
  const cand = (id) => planBetCloseMigration(before, { nowMs: NOW, cutoffIso: CUT }).items[0].candidates.find((c) => c.roundId === id);
  const link = (id) => ({ action: "link", roundId: id, roundNumber: 1, roundDeadline: cand(id).deadline });
  // Se aplicó con «ra» aunque se decidió «rb».
  const plan = planBetCloseMigration(before, { nowMs: NOW, cutoffIso: CUT, overrides: { x: link("r_a") } });
  const row = (key, v) => ({ key, text: JSON.stringify(v) });
  const backup = { rows: [row("quiniela:s:meta", before)] }, after = { rows: [row("quiniela:s:meta", plan.next)] };
  const applied = { mode: "apply", quinielas: [{ slug: "s", key: "quiniela:s:meta", applied: true, cutoff: CUT, questions: plan.items }] };
  assert.equal(ops.verifyApply(backup, after, applied).ok, true, "sin las decisiones, lo de --apply cuadra consigo mismo");
  const v = ops.verifyApply(backup, after, applied, { s: { x: link("r_b") } });
  assert.deepEqual(v.problems, [{ slug: "s", diffs: ["customBets.x: no se aplicó lo decidido"] }]);
  assert.equal(ops.verifyApply(backup, after, applied, { s: { x: link("r_a") } }).ok, true);
  // Un closesAt de --apply que no es el de su jornada en el respaldo.
  const malo = JSON.parse(JSON.stringify(applied));
  malo.quinielas[0].questions[0].closesAt = at(11);
  assert.ok(ops.verifyApply(backup, after, malo).problems[0].diffs.includes("customBets.x.closesAt (no es el cierre de su jornada en el respaldo)"));
});

test("decisiones: la quiniela heredada (quiniela_meta_v1, sin slug) se decide por su key", () => {
  const m = { tournamentEpoch: 1, pastTournaments: [{ rounds: [] }], rounds: [round("r_a", 1, at(10))], customBets: [t("x", 1)] };
  const plan = planBetCloseMigration(m, { nowMs: NOW, cutoffIso: CUT });
  const dry = { mode: "report", totals: {}, quinielas: [{ slug: null, key: "quiniela_meta_v1", questions: plan.items }] };
  assert.deepEqual(ops.checkDecisions({ quiniela_meta_v1: { x: { action: "cutoff" } } }, dry).errors, []);
  assert.deepEqual(ops.checkDecisions({}, dry).errors.map((e) => [e.slug, e.reason]), [["quiniela_meta_v1", "ambigua_sin_decision"]]);
});

test("Technical QA · volver atrás con un respaldo equivocado: uno de después de aplicar no sirve, y una ligada nunca se reabre", () => {
  // c: cerrada antes de migrar (J1 vencida); la migración la liga.
  const before = { tournamentEpoch: 0, rounds: [round("r_1", 1, at(-5))], customBets: [t("c", 1)] };
  const plan = planBetCloseMigration(before, { nowMs: NOW, cutoffIso: CUT });
  const entry = { applied: true, cutoff: CUT, questions: plan.items };
  // El admin reabre la J1 después de aplicar; y alguien usa como «respaldo» una copia de ese momento.
  const now = JSON.parse(JSON.stringify(plan.next));
  now.rounds[0].deadline = at(72);
  assert.deepEqual(ops.planRevert(now, entry, now, NOW).reasons, ["el_respaldo_es_de_despues_de_aplicar"], "con la marca, no");
  const sinMarca = JSON.parse(JSON.stringify(now)); delete sinMarca.betCloseMigration;
  assert.deepEqual(ops.planRevert(now, entry, sinMarca, NOW).reasons, ["c: se_reabriria_y_no_la_cerro_la_proteccion"], "aun sin la marca, una ligada no se reabre");
});

test("Technical QA · comprobar después: una ambigua aplicada sin su decisión escrita es un problema", () => {
  const before = { tournamentEpoch: 1, pastTournaments: [{ rounds: [] }], rounds: [round("r_a", 1, at(10))], customBets: [t("x", 1)] };
  const plan = planBetCloseMigration(before, { nowMs: NOW, cutoffIso: CUT });
  const row = (key, v) => ({ key, text: JSON.stringify(v) });
  const applied = { mode: "apply", quinielas: [{ slug: "s", key: "quiniela:s:meta", applied: true, cutoff: CUT, questions: plan.items }] };
  const v = ops.verifyApply({ rows: [row("quiniela:s:meta", before)] }, { rows: [row("quiniela:s:meta", plan.next)] }, applied, {});
  assert.deepEqual(v.problems, [{ slug: "s", diffs: ["customBets.x: ambigua aplicada sin decisión escrita"] }]);
});
