// MS2 · D4 — la operación de la migración de cierres, de punta a punta, con los
// scripts reales sobre PostgreSQL: inventario de sólo lectura, respaldo
// verificable, decisiones cotejadas contra el ensayo (un exit 0 no basta),
// aplicar, comprobar después y volver atrás sólo lo que nadie cambió.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { itest, setup, teardown, dbQuery, quiniela, databaseUrl } = require("./helpers/realServer");
const ops = require("../betCloseOps");

const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const putStored = (q, v) => dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
const allRows = async () => (await dbQuery("SELECT key, md5(value::text) AS m, updated_at FROM kv ORDER BY key")).rows.map((r) => `${r.key}:${r.m}:${r.updated_at && r.updated_at.toISOString()}`).join("|");
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const jornada = (id, number, deadline, extra) => ({ id, number, deadline, results: {}, resultsPublished: false, published: true, matches: [{ id: "m_" + id, teamA: "A", teamB: "B" }], ...extra });
const t = (id, closesAtRound, extra) => ({ id, label: "TEXTO-PRIVADO " + id, scope: "temporada", points: 3, closesAtRound, ...extra });

let dir;
const file = (name, data) => { const f = path.join(dir, name); if (data !== undefined) fs.writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data)); return f; };
function script(name, args) {
  const out = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", name), ...args], { env: { ...process.env, DATABASE_URL: databaseUrl() }, encoding: "utf8" });
  return { status: out.status, json: out.stdout.trim() ? JSON.parse(out.stdout) : null, stderr: out.stderr };
}
const dbName = async () => (await dbQuery("SELECT current_database() AS db")).rows[0].db;

test.describe("D4 · operación de la migración: inventario, respaldo, decisiones, aplicar, comprobar y volver atrás (PostgreSQL)", () => {
  test.before(async () => { await setup(); dir = fs.mkdtempSync(path.join(os.tmpdir(), "qracks-ops-")); });
  test.after(async () => { fs.rmSync(dir, { recursive: true, force: true }); await teardown(); });

  let qa, qb, qc;
  itest("preparar: tres quinielas con cada caso", async () => {
    // qa: un solo ciclo. Ligada abierta (J1), jornada «pendiente» (J2, abierta
    // por la lectura de siempre), jornada null (J3, cerrada), pendiente de su
    // jornada (J9), sin cierre; y el «goleador» de antes sin convertir.
    qa = await quiniela("opsa");
    let v = await stored(qa);
    v.rounds = [jornada("r_opsa1", 1, enHoras(30)), jornada("r_opsa2", 2, "pendiente", { published: false }), jornada("r_opsa3", 3, null, { published: false })];
    v.customBets = [t("cb_lig", 1), t("cb_pend", 2), t("cb_nul", 3), t("cb_j9", 9), t("cb_sin", null)];
    v.customBetsMigrated = false;
    v.golScorerBet = { enabled: true, bonusPoints: 3, closesAtRound: 1 };
    const beto = v.participants.find((p) => p.id === qa.beto.id);
    beto.golScorerGuess = "RESPUESTA-PRIVADA";
    beto.golScorerCorrect = true;
    beto.customBetAnswers = { cb_lig: { guess: "OTRA-PRIVADA", correct: true } };
    await putStored(qa, v);
    // qb: ya cerró un torneo; su antigua es ambigua con dos candidatas.
    qb = await quiniela("opsb");
    v = await stored(qb);
    v.tournamentEpoch = 1;
    v.pastTournaments = [{ closedAt: enHoras(-500), standings: [], rounds: [], cycle: 1 }];
    v.rounds = [jornada("r_opsb_a", 1, enHoras(20)), jornada("r_opsb_b", 1, enHoras(40))];
    v.customBets = [t("cb_amb", 1)];
    v.customBetsMigrated = true;
    await putStored(qb, v);
    // qc: ya migrada; quedó una pendiente de su jornada sin cierre propio.
    qc = await quiniela("opsc");
    v = await stored(qc);
    v.rounds = [jornada("r_opsc1", 1, enHoras(10))];
    v.customBets = [t("cb_qc9", 9)];
    v.customBetsMigrated = true;
    v.betCloseMigration = { version: 1, cutoff: enHoras(-24), appliedAt: enHoras(-24) };
    await putStored(qc, v);
  });

  itest("inventario: las excepciones que el reporte no detalla, sin escribir y sin textos", async () => {
    const before = await allRows();
    const r = script("bet-closes-inventory.js", []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await allRows(), before, "nada cambió (valores ni updated_at)");
    const by = Object.fromEntries(r.json.quinielas.map((q) => [q.slug, q]));
    assert.deepEqual(by[qa.slug].legacyScorer, { enabled: true, closesAtRound: 1, state: "abierta", roundId: "r_opsa1", answers: 1, hits: 1 });
    assert.deepEqual(by[qa.slug].unreadableDeadline.map((x) => [x.betId, x.state, x.deadlineKind]),
      [["cb_pend", "fecha_ilegible_abierta", "texto"], ["cb_nul", "fecha_ilegible_cerrada", "null"]]);
    assert.deepEqual(by[qc.slug].withoutOwnClose.map((x) => [x.betId, x.category, x.state]), [["cb_qc9", "pending_round", "jornada_no_existe"]]);
    assert.equal(by[qb.slug], undefined, "una ambigua por candidatas la detalla el reporte, no el inventario");
    const s = JSON.stringify(r.json);
    assert.ok(!/PRIVAD/.test(s), "ni preguntas ni respuestas");
    assert.ok(r.json.totals.unreadableDeadline.byState.fecha_ilegible_abierta >= 1);
  });

  let backup;
  itest("respaldo verificable: cada fila con su md5; cotejado contra un resumen de la base; un cambio se detecta", async () => {
    const e = script("bet-closes-inventory.js", ["--export"]);
    assert.equal(e.status, 0, e.stderr);
    backup = e.json;
    const sum = script("bet-closes-inventory.js", ["--summary"]);
    const ok = script("bet-closes-check.js", ["backup", "--backup=" + file("respaldo.json", backup), "--summary=" + file("resumen.json", sum.json)]);
    assert.equal(ok.status, 0, JSON.stringify(ok.json));
    assert.deepEqual([ok.json.ok, ok.json.changedSince], [true, []]);
    const roto = JSON.parse(JSON.stringify(backup));
    roto.rows[0].text = roto.rows[0].text.slice(0, -2) + "}";
    const bad = script("bet-closes-check.js", ["backup", "--backup=" + file("roto.json", roto)]);
    assert.equal(bad.status, 3);
    assert.equal(bad.json.errors[0].reason, "md5_no_cuadra");
  });

  let overridesFile, decisions;
  itest("decisiones: por slug exacto; el ensayo con ellas se coteja entrada por entrada; un slug mal escrito o una ambigua sin decidir fallan aunque el ensayo salga con 0", async () => {
    const rep = script("bet-closes-migrate.js", []);
    assert.equal(rep.status, 0);
    const amb = rep.json.quinielas.find((q) => q.slug === qb.slug).questions.find((i) => i.betId === "cb_amb");
    const cand = amb.candidates.find((c) => c.roundId === "r_opsb_b");
    decisions = {
      [qb.slug]: { cb_amb: { action: "link", roundId: cand.roundId, roundNumber: cand.number, roundDeadline: cand.deadline } },
      [qa.slug]: { cb_pend: { action: "cutoff" }, cb_nul: { action: "cutoff" } },
    };
    const ov = script("bet-closes-check.js", ["overrides", "--decisions=" + file("decisiones.json", decisions)]);
    overridesFile = file("overrides.json", ov.json);
    assert.deepEqual(Object.keys(ov.json), [qb.slug], "sólo los «link» van al script de migración");
    const ensayo = script("bet-closes-migrate.js", ["--overrides=" + overridesFile]);
    assert.equal(ensayo.status, 0);
    const chk = script("bet-closes-check.js", ["decisions", "--decisions=" + file("decisiones.json", decisions), "--dry-run=" + file("ensayo.json", ensayo.json)]);
    assert.equal(chk.status, 0, JSON.stringify(chk.json));
    assert.equal(chk.json.decided, 3);
    // Un slug mal escrito: el ensayo lo ignora y sale con 0; la comprobación no.
    const typo = { ...decisions, [qb.slug + "x"]: decisions[qb.slug] };
    delete typo[qb.slug];
    const ensayo2 = script("bet-closes-migrate.js", ["--overrides=" + file("ov2.json", ops.toOverrides(typo))]);
    assert.equal(ensayo2.status, 0, "el runner no lo nota");
    const chk2 = script("bet-closes-check.js", ["decisions", "--decisions=" + file("typo.json", typo), "--dry-run=" + file("ensayo2.json", ensayo2.json)]);
    assert.equal(chk2.status, 3);
    assert.deepEqual(chk2.json.errors.map((e) => e.reason).sort(), ["ambigua_sin_decision", "slug_no_existe_en_el_ensayo"]);
    // La key completa en vez del slug, también.
    const key = { [qb.metaKey]: decisions[qb.slug] };
    assert.equal(ops.checkDecisions(key, ensayo.json).errors[0].reason, "usa_el_slug_no_la_key");
  });

  let aplicado;
  itest("aplicar y comprobar: preguntas, fechas, respuestas y aciertos cuadran con lo que dijo el ensayo", async () => {
    const r = script("bet-closes-migrate.js", ["--apply", "--database=" + (await dbName()), "--overrides=" + overridesFile]);
    assert.equal(r.status, 0, r.stderr);
    aplicado = r.json;
    const after = script("bet-closes-inventory.js", ["--export"]);
    const v = script("bet-closes-check.js", ["verify", "--backup=" + file("respaldo.json", backup), "--after=" + file("despues.json", after.json), "--applied=" + file("aplicado.json", aplicado), "--decisions=" + file("decisiones.json", decisions)]);
    assert.equal(v.status, 0, JSON.stringify(v.json));
    assert.ok(v.json.checked >= 2);
    // Si una respuesta o un cierre no cuadran, se dice dónde (sin valores).
    const mal = JSON.parse(JSON.stringify(after.json));
    const row = mal.rows.find((x) => x.key === qa.metaKey);
    const m = JSON.parse(row.text);
    m.participants.find((p) => p.id === qa.beto.id).customBetAnswers.cb_lig.correct = false;
    m.customBets.find((b) => b.id === "cb_pend").closesAt = enHoras(5);
    row.text = JSON.stringify(m);
    const v2 = ops.verifyApply(backup, mal, aplicado);
    assert.equal(v2.ok, false);
    const diffs = v2.problems.find((p) => p.slug === qa.slug).diffs;
    assert.ok(diffs.includes("participants (respuestas, aciertos u otros datos)"));
    assert.ok(diffs.includes("customBets.cb_pend.closesAt"));
    assert.ok(!JSON.stringify(v2).includes("PRIVAD"));
  });

  itest("Technical QA · volver atrás con una jornada reabierta después de aplicar: la cerrada no se reabre (pide revisión)", async () => {
    const q = await quiniela("opsd");
    const v = await stored(q);
    v.rounds = [jornada("r_opsd1", 1, enHoras(-5)), jornada("r_opsd2", 2, enHoras(30))];
    v.customBets = [t("cb_c", 1)];
    v.customBetsMigrated = true;
    await putStored(q, v);
    const bk = script("bet-closes-inventory.js", ["--export"]).json;
    const ap = script("bet-closes-migrate.js", ["--apply", "--database=" + (await dbName())]).json;
    const after = await stored(q);
    after.rounds[0].deadline = enHoras(72);   // el admin reabre la J1
    await putStored(q, after);
    const r = script("bet-closes-revert.js", ["--applied=" + file("ap-d.json", ap), "--backup=" + file("bk-d.json", bk), "--apply", "--database=" + (await dbName())]);
    assert.equal(r.status, 3);
    assert.deepEqual(r.json.quinielas.find((x) => x.slug === q.slug).needsReview, ["cb_c: su_jornada_cambio_despues_de_aplicar"]);
    assert.equal((await stored(q)).customBets[0].closeSource, "migration_round", "sigue cerrada con su cierre de la migración");
  });

  itest("volver atrás: sólo lo que la migración escribió y nadie cambió; lo cambiado después se deja y pide revisión", async () => {
    // Después de aplicar, el admin de qb movió el cierre de su pregunta.
    const vb = await stored(qb);
    vb.customBets[0].closesAt = enHoras(60);
    await putStored(qb, vb);
    const appliedFile = file("aplicado.json", aplicado);
    const backupFile = file("respaldo.json", backup);
    const before = await allRows();
    const dry = script("bet-closes-revert.js", ["--applied=" + appliedFile, "--backup=" + backupFile]);
    assert.equal(dry.status, 3);
    assert.equal(await allRows(), before, "sin --apply no escribe");
    const by = Object.fromEntries(dry.json.quinielas.map((q) => [q.slug, q]));
    assert.equal(by[qa.slug].wouldRevert, true, JSON.stringify(by[qa.slug]));
    assert.deepEqual(by[qa.slug].reopens, ["cb_pend"], "la de fecha ilegible abierta, cerrada por protección, se reabre: se dice");
    assert.deepEqual(by[qb.slug].needsReview, ["cb_amb: cambio_despues_de_aplicar"]);
    const r = script("bet-closes-revert.js", ["--applied=" + appliedFile, "--backup=" + backupFile, "--apply", "--database=" + (await dbName())]);
    assert.equal(r.status, 3);
    // qa vuelve a lo del respaldo (salvo los sellos de revisión); qb no se tocó.
    const back = JSON.parse(backup.rows.find((x) => x.key === qa.metaKey).text);
    const now = await stored(qa);
    assert.deepEqual(now.customBets, back.customBets);
    assert.equal(now.betCloseMigration, undefined);
    assert.deepEqual(now.participants.map((p) => [p.id, p.customBetAnswers || null, p.golScorerGuess || null]), back.participants.map((p) => [p.id, p.customBetAnswers || null, p.golScorerGuess || null]));
    assert.ok(now.betsRevision > back.betsRevision || back.betsRevision === undefined, "avanzó la revisión");
    assert.equal((await stored(qb)).customBets[0].closesAt, vb.customBets[0].closesAt);
    // Otra vez: ya no hay nada que volver atrás en qa.
    const again = script("bet-closes-revert.js", ["--applied=" + appliedFile, "--backup=" + backupFile, "--apply", "--database=" + (await dbName())]);
    assert.deepEqual(again.json.quinielas.find((q) => q.slug === qa.slug).needsReview, ["la_marca_no_es_la_de_esa_aplicacion"]);
    // Sin --database, nada.
    const noDb = script("bet-closes-revert.js", ["--applied=" + appliedFile, "--backup=" + backupFile, "--apply"]);
    assert.equal(noDb.status, 2);
    assert.equal(script("bet-closes-revert.js", ["--applied=" + appliedFile]).status, 2, "sin el respaldo, nada");
    const sinBase = { ...aplicado }; delete sinBase.database;
    assert.equal(script("bet-closes-revert.js", ["--applied=" + file("sinbase.json", sinBase), "--backup=" + backupFile]).status, 2, "una salida sin su base, nada");
  });
});
