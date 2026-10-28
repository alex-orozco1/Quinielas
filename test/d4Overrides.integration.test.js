// MS2 · D4-03 y D4-04 (revalidación de fcd61d9): las decisiones explícitas de
// la migración («ligar esta pregunta ambigua a esta jornada») se dan por
// pregunta Y por id de jornada, con lo que se revisó en el reporte; se
// revalidan bajo el candado de la fila al aplicar; una fecha inválida, una
// jornada que no es candidata o algo que cambió desde el reporte detienen ese
// caso sin escribir nada. El orden del arreglo nunca decide el vínculo.
// Además, el reporte separa las pendientes de su jornada con y sin rastro de
// una jornada borrada.
//
// PostgreSQL real; el script real para el código de salida.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela, databaseUrl } = require("./helpers/realServer");
const { runBetCloseMigration } = require("../betCloseMigration");

const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const raw = async (q) => (await dbQuery("SELECT value::text AS v FROM kv WHERE key = $1", [q.metaKey])).rows[0].v;
const putStored = (q, v) => dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const jornada = (id, number, deadline) => ({ id, number, deadline, results: {}, resultsPublished: false, published: true, matches: [{ id: "m_" + id, teamA: "A", teamB: "B" }] });
const t = (id, closesAtRound) => ({ id, label: "Pregunta " + id, scope: "temporada", points: 3, closesAtRound });
const pool = () => new (require("pg").Pool)({ connectionString: databaseUrl(), max: 2 });
async function run(opts) { const p = pool(); try { return await runBetCloseMigration(p, opts); } finally { await p.end(); } }
const entryOf = (result, q) => result.quinielas.find((x) => x.slug === q.slug);
const item = (result, q, betId) => entryOf(result, q).questions.find((i) => i.betId === betId);

// Una quiniela que ya cerró un torneo: su pregunta antigua es ambigua.
async function ambigua(tag, rounds) {
  const q = await quiniela(tag);
  const v = await stored(q);
  v.tournamentEpoch = 1;
  v.pastTournaments = [{ closedAt: enHoras(-500), standings: [], rounds: [jornada("r_" + tag + "old1", 1, enHoras(-600))], cycle: 1 }];
  v.rounds = rounds;
  v.customBets = [t("cb_" + tag, 1)];
  await putStored(q, v);
  return q;
}
// Lo que el reporte dice de un candidato, tal cual.
const decision = (cand) => ({ action: "link", roundId: cand.roundId, roundNumber: cand.number, roundDeadline: cand.deadline });

test.describe("D4-03/04 · decisiones explícitas de la migración (PostgreSQL)", () => {
  test.before(setup);
  test.after(teardown);

  itest("el reporte da los candidatos de cada ambigua (id, número, cierre, publicada), sin textos", async () => {
    const q = await ambigua("ovra", [jornada("r_ovra_b", 1, enHoras(30)), jornada("r_ovra_a", 1, enHoras(50))]);
    const r = await run({ apply: false });
    const i = item(r, q, "cb_ovra");
    assert.equal(i.category, "ambiguous");
    assert.deepEqual(i.candidates.map((c) => [c.roundId, c.number, c.published]).sort(), [["r_ovra_a", 1, true], ["r_ovra_b", 1, true]]);
    assert.ok(i.candidates.every((c) => typeof c.deadline === "string"));
    assert.equal(JSON.stringify(r).includes("Pregunta cb_"), false);
  });

  itest("D4-04 · ligar por id: el orden del arreglo no decide; invertido, la misma decisión liga a la misma jornada", async () => {
    for (const order of ["normal", "invertido"]) {
      const a = jornada("r_ovb" + order[0] + "_a", 1, enHoras(30)), b = jornada("r_ovb" + order[0] + "_b", 1, enHoras(50));
      const q = await ambigua("ovb" + order[0], order === "normal" ? [a, b] : [b, a]);
      const rep = await run({ apply: false });
      const cand = item(rep, q, "cb_ovb" + order[0]).candidates.find((c) => c.roundId === b.id);
      const res = await run({ apply: true, overrides: { [q.slug]: { ["cb_ovb" + order[0]]: decision(cand) } } });
      assert.equal(entryOf(res, q).applied, true);
      const bet = (await stored(q)).customBets[0];
      assert.deepEqual([bet.closesRoundId, bet.closesAt, bet.closeSource], [b.id, new Date(b.deadline).toISOString(), "migration_round"], order);
    }
  });

  itest("D4-04 · «link» sin id de jornada (la forma anterior) no decide nada: ese caso se detiene sin escribir", async () => {
    const q = await ambigua("ovc", [jornada("r_ovc_a", 1, enHoras(30)), jornada("r_ovc_b", 1, enHoras(50))]);
    const before = await raw(q);
    const res = await run({ apply: true, overrides: { [q.slug]: { cb_ovc: "link" } } });
    assert.deepEqual(entryOf(res, q).needsReview, [{ betId: "cb_ovc", reason: "override_needs_round_id" }]);
    assert.notEqual(entryOf(res, q).applied, true);
    assert.equal(await raw(q), before, "nada se escribió, ni la marca");
  });

  itest("D4-03 · una jornada candidata con fecha inválida: la decisión se rechaza sin escribir (nada de 1970)", async () => {
    const q = await ambigua("ovd", [jornada("r_ovd_a", 1, "no-es-una-fecha")]);
    const before = await raw(q);
    const rep = await run({ apply: false });
    const cand = item(rep, q, "cb_ovd").candidates[0];
    for (const o of [decision(cand), "link"]) {
      const res = await run({ apply: true, overrides: { [q.slug]: { cb_ovd: o } } });
      assert.equal(entryOf(res, q).needsReview.length, 1, JSON.stringify(o));
      assert.equal(await raw(q), before);
    }
    assert.ok(!(await raw(q)).includes("1970"));
    // Sin decisión, la ambigua se cierra por protección con el corte, como siempre.
    await run({ apply: true });
    const bet = (await stored(q)).customBets[0];
    assert.deepEqual([bet.closeSource, bet.closeFlag], ["migration_cutoff", "ambiguous"]);
    assert.ok(Date.parse(bet.closesAt) > Date.now() - 600e3);
  });

  itest("si algo cambió desde el reporte (bajo el candado, al aplicar), ese caso se detiene y pide revisión", async () => {
    const q = await ambigua("ove", [jornada("r_ove_a", 1, enHoras(30)), jornada("r_ove_b", 1, enHoras(50))]);
    const rep = await run({ apply: false });
    const cand = item(rep, q, "cb_ove").candidates.find((c) => c.roundId === "r_ove_b");
    // Después del reporte, el admin mueve esa jornada.
    const v = await stored(q);
    v.rounds.find((r) => r.id === "r_ove_b").deadline = enHoras(90);
    await putStored(q, v);
    const before = await raw(q);
    const res = await run({ apply: true, overrides: { [q.slug]: { cb_ove: decision(cand) } } });
    assert.deepEqual(entryOf(res, q).needsReview, [{ betId: "cb_ove", reason: "override_stale" }]);
    assert.equal(await raw(q), before);
    // Un id que no es candidato, o una pregunta que no es ambigua, tampoco.
    const res2 = await run({ apply: true, overrides: { [q.slug]: { cb_ove: { ...decision(cand), roundId: "r_ove_old1" } } } });
    assert.equal(entryOf(res2, q).needsReview[0].reason, "override_round_not_candidate");
    const res3 = await run({ apply: true, overrides: { [q.slug]: { cb_nadie: decision(cand) } } });
    assert.equal(entryOf(res3, q).needsReview[0].reason, "override_unknown_bet");
  });

  itest("el script: una decisión que no aplica termina con código 3 y no escribe ese caso; los demás sí se migran", async () => {
    const q = await ambigua("ovf", [jornada("r_ovf_a", 1, enHoras(30))]);
    const otra = await quiniela("ovfotra");
    const before = await raw(q);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qracks-ov-"));
    const file = path.join(dir, "overrides.json");
    fs.writeFileSync(file, JSON.stringify({ [q.slug]: { cb_ovf: "link" } }));
    const db = (await dbQuery("SELECT current_database() AS db")).rows[0].db;
    const out = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "bet-closes-migrate.js"), "--apply", "--database=" + db, "--overrides=" + file], { env: { ...process.env, DATABASE_URL: databaseUrl() }, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(out.status, 3, out.stderr);
    const res = JSON.parse(out.stdout);
    assert.equal(entryOf(res, q).needsReview[0].reason, "override_needs_round_id");
    assert.equal(await raw(q), before);
    assert.equal((await stored(otra)).betCloseMigration.version, 1, "la otra quiniela sí se migró");
  });

  itest("pendientes de su jornada: el reporte separa las que tienen rastro de una jornada borrada de las que no", async () => {
    const limpia = await quiniela("ovglimpia");
    const conRastro = await quiniela("ovgrastro");
    for (const q of [limpia, conRastro]) {
      const v = await stored(q);
      v.rounds = [jornada("r_" + q.slug.slice(3, 12) + "1", 1, enHoras(-5)), jornada("r_" + q.slug.slice(3, 12) + "2", 2, enHoras(40))];
      v.customBets = [t("cb_pend", 3)];
      await putStored(q, v);
    }
    // En la otra, un participante tiene pronósticos de una jornada que ya no existe.
    const pk = `quiniela:${conRastro.slug}:picks:${conRastro.beto.id}`;
    await dbQuery("INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [pk, JSON.stringify({ r_borrada3: { m_x: "A" } })]);
    const rep = await run({ apply: false });
    const a = item(rep, limpia, "cb_pend"), b = item(rep, conRastro, "cb_pend");
    assert.deepEqual([a.category, a.subcategory, a.evidence.deletedRoundTraces], ["pending_round", "sin_rastro_de_jornada_borrada", 0]);
    assert.deepEqual([b.category, b.subcategory, b.evidence.deletedRoundTraces], ["pending_round", "con_rastro_de_jornada_borrada", 1]);
    assert.equal(JSON.stringify(rep).includes("m_x"), false, "no expone los pronósticos");
    // Ninguna se toca: siguen como estaban hasta una decisión explícita.
    await run({ apply: true });
    assert.equal((await stored(conRastro)).customBets[0].closesAt, undefined);
  });
});
