// MS2 · D4 — betCloseMigration.js, la parte pura: cómo se clasifica cada
// pregunta antigua y qué se le escribe, sólo con evidencia. La ejecución contra
// PostgreSQL está en betCloseMigration.integration.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { classifyLegacyBet, planBetCloseMigration, alreadyMigrated } = require("../betCloseMigration");

const NOW = Date.parse("2026-10-15T18:00:00Z");
const CUT = new Date(NOW).toISOString();
const at = (h) => new Date(NOW + h * 3600e3).toISOString();
const round = (id, number, h) => ({ id, number, deadline: at(h), matches: [] });
const t = (id, closesAtRound, extra) => ({ id, label: "q " + id, scope: "temporada", points: 3, closesAtRound, ...extra });

test("un solo ciclo (nunca cerró un torneo) y una jornada con ese número: se liga a ella, abierta o cerrada", () => {
  const meta = { tournamentEpoch: 0, rounds: [round("r_1", 1, -2), round("r_2", 2, 48)], customBets: [t("a", 1), t("b", 2)] };
  const plan = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT });
  const [a, b] = plan.next.customBets;
  assert.deepEqual([a.closesAt, a.closesRoundId, a.closeSource], [at(-2), "r_1", "migration_round"], "su cierre real queda fijo");
  assert.deepEqual([b.closesAt, b.closesRoundId, b.closeSource], [at(48), "r_2", "migration_round"], "abierta: lo mismo que ya veía");
  assert.deepEqual(plan.items.map((i) => [i.betId, i.category, i.action]), [["a", "linked_closed", "ligada"], ["b", "linked_open", "ligada"]]);
});

test("sin evidencia no se recupera nada: el número de una jornada actual o archivada no prueba que sea la suya", () => {
  const past = { closedAt: at(-500), rounds: [round("r_old1", 1, -600), round("r_old3", 3, -550)], cycle: 1 };
  const meta = { tournamentEpoch: 1, pastTournaments: [past], rounds: [round("r_new1", 1, 48)],
    customBets: [t("amb", 1), t("lost", 3), t("gone", 9)],
    participants: [{ id: "p", customBetAnswers: { amb: { guess: "x", correct: true } } }] };
  const plan = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT });
  const by = Object.fromEntries(plan.next.customBets.map((b) => [b.id, b]));
  assert.deepEqual([by.amb.closesAt, by.amb.closeSource, by.amb.closeFlag, by.amb.closesRoundId], [CUT, "migration_cutoff", "ambiguous", undefined],
    "la J1 actual (r_new1) no es la J1 archivada (r_old1): no se liga a ninguna, se cierra por protección con el corte");
  assert.deepEqual([by.lost.closesAt, by.lost.closeFlag], [CUT, "lost_link"]);
  assert.deepEqual([by.gone.closesAt, by.gone.closeFlag], [CUT, "lost_link"]);
  const items = Object.fromEntries(plan.items.map((i) => [i.betId, i]));
  assert.equal(items.lost.evidence.numberInArchive, true, "se reporta, no se usa como prueba");
  assert.equal(items.amb.pointsUnattributed, true, "sus aciertos cuentan hoy y no se sabe de qué torneo son: se reporta");
  assert.deepEqual(plan.next.participants, meta.participants, "ninguna respuesta ni acierto cambia");
  // Con una decisión explícita (por id de jornada, con lo del reporte), una ambigua se liga a esa jornada.
  assert.deepEqual(items.amb.candidates, [{ roundId: "r_new1", number: 1, deadline: at(48), published: true }]);
  const decision = { action: "link", roundId: "r_new1", roundNumber: 1, roundDeadline: at(48) };
  const linked = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT, overrides: { amb: decision } }).next.customBets[0];
  assert.deepEqual([linked.closesRoundId, linked.closesAt, linked.closeSource], ["r_new1", at(48), "migration_round"]);
  // «link» a secas (la forma anterior) ya no decide nada: no se escribe esa quiniela.
  const old = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT, overrides: { amb: "link" } });
  assert.deepEqual([old.next, old.needsReview], [null, [{ betId: "amb", reason: "override_needs_round_id" }]]);
});

test("ligada a una jornada que todavía no se crea (un solo ciclo, número mayor que todas): se reporta y sigue abierta, no se cierra por protección", () => {
  const meta = { rounds: [round("r_1", 1, -5), round("r_2", 2, 20)], customBets: [t("fut", 7)] };
  const plan = planBetCloseMigration({ ...meta, customBets: [t("fut", 7)] }, { nowMs: NOW, cutoffIso: CUT });
  assert.deepEqual(plan.next.customBets[0], t("fut", 7), "sin tocar");
  assert.deepEqual([plan.items[0].category, plan.items[0].action, plan.items[0].evidence.maxRoundNumber], ["pending_round", "sin_cambio_pendiente", 2]);
  // Con un torneo ya cerrado, el mismo número puede ser de aquel torneo: no basta.
  const withArchive = { ...meta, tournamentEpoch: 1, pastTournaments: [{ rounds: [round("r_o7", 7, -900)] }], customBets: [t("fut", 7)] };
  assert.equal(planBetCloseMigration(withArchive, { nowMs: NOW, cutoffIso: CUT }).items[0].category, "lost_link");
  // Un número menor que el de alguna jornada actual sí es un vínculo perdido.
  const lower = { rounds: [round("r_1", 1, -5), round("r_3", 3, 20)], customBets: [t("x", 2)] };
  assert.equal(planBetCloseMigration(lower, { nowMs: NOW, cutoffIso: CUT }).items[0].category, "lost_link");
});

test("un número repetido también es ambiguo, aunque nunca se haya cerrado un torneo", () => {
  const meta = { rounds: [round("r_a", 4, 10), round("r_b", 4, 20)], customBets: [t("x", 4)] };
  assert.equal(classifyLegacyBet(meta.customBets[0], meta).category, "ambiguous");
});

test("sin cierre: «Sin cierre», sin fecha; las de jornada y las que ya tienen su cierre no se tocan", () => {
  const ownBet = t("o", 1, { closesAt: at(5), closesRoundId: "r_1", closeSource: "round", epoch: 0 });
  const meta = { rounds: [round("r_1", 1, 5)], customBets: [t("n", null), ownBet, { id: "j", scope: "jornada", label: "j", points: 1 }] };
  const plan = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT });
  assert.deepEqual(plan.next.customBets, [{ ...t("n", null), closeSource: "none" }, ownBet, meta.customBets[2]]);
  assert.deepEqual(plan.items.map((i) => [i.category, i.action]), [["no_close", "sin_cierre"], ["own_close", "sin_cambio"], ["round_question", "sin_cambio"]]);
});

test("la marca: el corte es el del reloj de la base, se guarda una vez y una quiniela marcada no se vuelve a tocar", () => {
  const meta = { rounds: [], customBets: [t("gone", 2)] };
  const first = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT });
  assert.deepEqual(first.next.betCloseMigration, { version: 1, cutoff: CUT, appliedAt: CUT });
  assert.equal(alreadyMigrated(first.next), true);
  const again = planBetCloseMigration(first.next, { nowMs: NOW + 864e5, cutoffIso: at(24) });
  assert.deepEqual([again.migrated, again.next], [true, null], "el corte no se mueve");
  assert.equal(alreadyMigrated(meta), false);
});

test("la migración sella con la misma composición que stampMetaWrite() del servidor", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const mig = fs.readFileSync(path.join(__dirname, "..", "betCloseMigration.js"), "utf8");
  const body = "return stampBetsRevision(stampRoundsRevision(stampMetaRevisions(doc, oldValue), oldValue), oldValue);";
  assert.ok(server.includes("function stampMetaWrite(doc, oldValue) {\n  " + body));
  assert.ok(mig.includes("function stampMetaWrite(doc, oldValue) {\n  " + body));
});

test("los scripts: el reporte no escribe (READ ONLY) y aplicar exige --apply y el nombre de la base", () => {
  const run = fs.readFileSync(path.join(__dirname, "..", "betCloseMigration.js"), "utf8");
  assert.ok(run.includes('if (!apply) await client.query("BEGIN TRANSACTION READ ONLY");'));
  assert.ok(run.includes('FOR UPDATE" : ""}'), "aplicar bloquea la fila");
  const report = fs.readFileSync(path.join(__dirname, "..", "scripts", "bet-closes-report.js"), "utf8");
  assert.ok(report.includes("runBetCloseMigration(pool, { apply: false })") && !report.includes("apply: true"));
  const migrate = fs.readFileSync(path.join(__dirname, "..", "scripts", "bet-closes-migrate.js"), "utf8");
  assert.ok(migrate.includes('if (arg("database") !== db)'));
});

test("D4-03 · una decisión sobre una jornada con fecha inválida se rechaza: no se escribe nada (nada de 1970)", () => {
  const meta = { tournamentEpoch: 1, pastTournaments: [{ rounds: [round("r_old1", 1, -900)] }], rounds: [{ id: "r_a", number: 1, deadline: "no-es-una-fecha", matches: [] }], customBets: [t("x", 1)] };
  const plan = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT, overrides: { x: { action: "link", roundId: "r_a", roundNumber: 1, roundDeadline: "no-es-una-fecha" } } });
  assert.deepEqual([plan.next, plan.needsReview], [null, [{ betId: "x", reason: "override_round_invalid_deadline" }]]);
  assert.ok(!JSON.stringify(plan).includes("1970"));
  // Sin decisión: cierre por protección con el corte (no una fecha inventada).
  const def = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT }).next.customBets[0];
  assert.deepEqual([def.closesAt, def.closeSource, def.closeFlag], [CUT, "migration_cutoff", "ambiguous"]);
});

test("D4-04 · la decisión liga a la jornada por su id; el orden del arreglo no cambia el resultado; lo que no cuadra pide revisión", () => {
  const a = round("r_a", 1, 30), b = round("r_b", 1, 50);
  const meta = (rounds) => ({ rounds, customBets: [t("x", 1)] });
  const dec = { action: "link", roundId: "r_b", roundNumber: 1, roundDeadline: b.deadline };
  for (const rounds of [[a, b], [b, a]]) {
    const out = planBetCloseMigration(meta(rounds), { nowMs: NOW, cutoffIso: CUT, overrides: { x: dec } }).next.customBets[0];
    assert.deepEqual([out.closesRoundId, out.closesAt], ["r_b", b.deadline]);
  }
  const review = (o, m = meta([a, b])) => planBetCloseMigration(m, { nowMs: NOW, cutoffIso: CUT, overrides: o }).needsReview;
  assert.deepEqual(review({ x: "link" }), [{ betId: "x", reason: "override_needs_round_id" }]);
  assert.deepEqual(review({ x: { ...dec, roundId: "r_zz" } }), [{ betId: "x", reason: "override_round_not_candidate" }]);
  assert.deepEqual(review({ x: { ...dec, roundDeadline: at(51) } }), [{ betId: "x", reason: "override_stale" }]);
  assert.deepEqual(review({ x: { ...dec, roundNumber: 2 } }), [{ betId: "x", reason: "override_stale" }]);
  assert.deepEqual(review({ x: { action: "cutoff" } }), [{ betId: "x", reason: "override_invalid" }]);
  assert.deepEqual(review({ nadie: dec }), [{ betId: "nadie", reason: "override_unknown_bet" }]);
  // Una que no es ambigua (ligada con evidencia) no admite decisión.
  assert.deepEqual(review({ x: dec }, { rounds: [b], customBets: [t("x", 1)] }), [{ betId: "x", reason: "override_not_applicable" }]);
  // Ya migrada: la decisión no se aplica y se dice.
  assert.deepEqual(review({ x: dec }, { ...meta([a, b]), betCloseMigration: { version: 1 } }), [{ betId: "x", reason: "already_migrated" }]);
});

test("pendientes de su jornada: el reporte separa con y sin rastro de una jornada borrada; ninguna se toca", () => {
  const meta = { rounds: [round("r_1", 1, -5), round("r_2", 2, 20)], customBets: [t("p", 4)] };
  const sin = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT, traces: { orphanRoundIds: 0 } });
  const con = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT, traces: { orphanRoundIds: 2 } });
  assert.deepEqual([sin.items[0].subcategory, sin.items[0].evidence.deletedRoundTraces, sin.items[0].evidence.gapFromMax], ["sin_rastro_de_jornada_borrada", 0, 2]);
  assert.deepEqual([con.items[0].subcategory, con.items[0].evidence.deletedRoundTraces], ["con_rastro_de_jornada_borrada", 2]);
  assert.deepEqual([sin.next.customBets[0], con.next.customBets[0]], [t("p", 4), t("p", 4)]);
});
