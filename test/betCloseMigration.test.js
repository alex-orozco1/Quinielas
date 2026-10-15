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
  // Con una decisión explícita, una ambigua se liga a esa jornada.
  const linked = planBetCloseMigration(meta, { nowMs: NOW, cutoffIso: CUT, overrides: { amb: "link" } }).next.customBets[0];
  assert.deepEqual([linked.closesRoundId, linked.closesAt, linked.closeSource], ["r_new1", at(48), "migration_round"]);
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
