// MS2 · D4 — la migración de cierres contra PostgreSQL y el servidor real:
// el reporte no escribe nada; aplicarla deja a cada pregunta antigua en su
// categoría sin tocar respuestas ni aciertos; es idempotente (otra pasada, un
// reinicio del servidor o dos instancias a la vez no mueven el corte); convive
// con escrituras concurrentes; y después de aplicarla los seis caminos ya no
// reabren las preguntas antiguas.

const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers/realServer");
const { itest, setup, teardown, dbQuery, withRowLocked, call, kvPath, quiniela, startServer, stopServer, databaseUrl } = H;
const { runBetCloseMigration } = require("../betCloseMigration");

const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const raw = async (q) => (await dbQuery("SELECT value::text AS v, updated_at FROM kv WHERE key = $1", [q.metaKey])).rows[0];
const putStored = (q, v) => dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const answer = (q, betId, guess) => call("POST", "/api/submit-bet-answer", {
  ip: q.betoPhone.ip,
  headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id },
  body: { metaKey: q.metaKey, participantId: q.beto.id, betId, guess },
});
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const jornada = (id, number, deadline) => ({ id, number, deadline, results: {}, resultsPublished: false, published: true, matches: [{ id: "m_" + id, teamA: "León", teamB: "Santos" }] });
const t = (id, closesAtRound) => ({ id, label: "Pregunta " + id, scope: "temporada", points: 3, closesAtRound });
const pool = () => new (require("pg").Pool)({ connectionString: databaseUrl(), max: 2 });
async function run(opts) { const p = pool(); try { return await runBetCloseMigration(p, opts); } finally { await p.end(); } }
const entryOf = (result, q) => result.quinielas.find((x) => x.slug === q.slug);

// Una quiniela de un solo ciclo con una pregunta de cada clase, y respuestas.
async function unCiclo(tag) {
  const q = await quiniela(tag);
  const v = await stored(q);
  v.rounds = [jornada("r_" + tag + "1", 1, enHoras(-2)), jornada("r_" + tag + "2", 2, enHoras(48))];
  v.customBets = [t("cb_" + tag + "cerr", 1), t("cb_" + tag + "abie", 2), t("cb_" + tag + "perd", 9), t("cb_" + tag + "sinc", null),
    { id: "cb_" + tag + "jorn", label: "¿Penal?", scope: "jornada", points: 1 }];
  const beto = v.participants.find((p) => p.id === q.beto.id);
  beto.customBetAnswers = { ["cb_" + tag + "cerr"]: { guess: "América", correct: true }, ["cb_" + tag + "perd"]: { guess: "Toluca", correct: null } };
  await putStored(q, v);
  return q;
}
// Una quiniela que ya cerró un torneo: su J1 actual es OTRA jornada (otro id)
// que la J1 archivada.
async function conArchivo(tag) {
  const q = await quiniela(tag);
  const v = await stored(q);
  v.tournamentEpoch = 1;
  v.pastTournaments = [{ closedAt: enHoras(-500), champion: null, standings: [], rounds: [jornada("r_" + tag + "old1", 1, enHoras(-600)), jornada("r_" + tag + "old3", 3, enHoras(-550))], cycle: 1 }];
  v.rounds = [jornada("r_" + tag + "new1", 1, enHoras(48))];
  v.customBets = [t("cb_" + tag + "amb", 1), t("cb_" + tag + "arch", 3)];
  const beto = v.participants.find((p) => p.id === q.beto.id);
  beto.customBetAnswers = { ["cb_" + tag + "amb"]: { guess: "Pumas", correct: true } };
  await putStored(q, v);
  return q;
}

test.describe("D4 · migración de cierres (PostgreSQL + servidor real)", () => {
  test.before(setup);
  test.after(teardown);
  let A, B, applied;

  itest("el reporte es de sólo lectura: lista categorías e ids y no cambia ni una fila", async () => {
    A = await unCiclo("mga");
    B = await conArchivo("mgb");
    const before = [await raw(A), await raw(B)];
    const report = await run({ apply: false });
    assert.equal(report.mode, "report");
    assert.deepEqual([await raw(A), await raw(B)], before, "ni el valor ni updated_at cambian");
    const a = entryOf(report, A), b = entryOf(report, B);
    assert.deepEqual(a.questions.map((i) => [i.betId, i.category, i.action]), [
      ["cb_mgacerr", "linked_closed", "ligada"], ["cb_mgaabie", "linked_open", "ligada"], ["cb_mgaperd", "lost_link", "cerrada_por_proteccion"],
      ["cb_mgasinc", "no_close", "sin_cierre"], ["cb_mgajorn", "round_question", "sin_cambio"]]);
    assert.deepEqual(b.questions.map((i) => [i.betId, i.category, !!i.pointsUnattributed]), [["cb_mgbamb", "ambiguous", true], ["cb_mgbarch", "lost_link", false]]);
    assert.equal(JSON.stringify(report).includes("Pregunta cb_"), false, "sin textos de preguntas");
    assert.equal(JSON.stringify(report).includes("América"), false, "sin respuestas");
    // Una escritura dentro del reporte la rechazaría PostgreSQL (READ ONLY).
    const p = pool(); const c = await p.connect();
    try {
      await c.query("BEGIN TRANSACTION READ ONLY");
      await assert.rejects(c.query("UPDATE kv SET value = value WHERE key = $1", [A.metaKey]), /read-only/);
    } finally { await c.query("ROLLBACK"); c.release(); await p.end(); }
  });

  itest("aplicar: cada pregunta en su categoría, con el corte del reloj de la base; respuestas y aciertos intactos", async () => {
    const answersBefore = [JSON.stringify((await stored(A)).participants), JSON.stringify((await stored(B)).participants)];
    const t0 = Date.now();
    applied = await run({ apply: true });
    const a = await stored(A), b = await stored(B);
    const cut = a.betCloseMigration.cutoff;
    assert.ok(Date.parse(cut) >= t0 - 5000 && Date.parse(cut) <= Date.now() + 1000, "el corte es ahora, no una fecha futura ni histórica");
    const by = Object.fromEntries(a.customBets.map((x) => [x.id, x]));
    assert.deepEqual([by.cb_mgacerr.closesRoundId, by.cb_mgacerr.closesAt, by.cb_mgacerr.closeSource], ["r_mga1", new Date(a.rounds[0].deadline).toISOString(), "migration_round"]);
    assert.deepEqual([by.cb_mgaabie.closesRoundId, by.cb_mgaabie.closeSource], ["r_mga2", "migration_round"]);
    assert.deepEqual([by.cb_mgaperd.closesAt, by.cb_mgaperd.closeFlag], [cut, "lost_link"]);
    assert.deepEqual([by.cb_mgasinc.closesAt, by.cb_mgasinc.closeSource], [undefined, "none"]);
    const bb = Object.fromEntries(b.customBets.map((x) => [x.id, x]));
    assert.deepEqual([bb.cb_mgbamb.closeFlag, bb.cb_mgbamb.closesRoundId], ["ambiguous", undefined], "la J1 actual no es la archivada: no se liga");
    assert.deepEqual([JSON.stringify(a.participants), JSON.stringify(b.participants)], answersBefore, "ni una respuesta ni un acierto cambia");
    assert.ok(a.betsRevision > 0, "las pestañas abiertas antes saben que las preguntas cambiaron");
  });

  itest("idempotente: otra pasada, un reinicio del servidor y otra pasada después no cambian nada (el corte no se mueve)", async () => {
    const snap = [await raw(A), await raw(B)];
    const again = await run({ apply: true });
    assert.equal(entryOf(again, A).alreadyMigrated, true);
    assert.deepEqual([(await raw(A)).v, (await raw(B)).v], [snap[0].v, snap[1].v]);
    await stopServer();
    await startServer();
    assert.deepEqual([(await raw(A)).v, (await raw(B)).v], [snap[0].v, snap[1].v], "arrancar no migra ni mueve el corte");
    await run({ apply: true });
    assert.deepEqual([(await raw(A)).v, (await raw(B)).v], [snap[0].v, snap[1].v]);
  });

  itest("dos instancias a la vez: cada quiniela se migra una sola vez", async () => {
    const C = await unCiclo("mgc");
    const [r1, r2] = await Promise.all([run({ apply: true }), run({ apply: true })]);
    const c1 = entryOf(r1, C), c2 = entryOf(r2, C);
    assert.deepEqual([!!c1.applied, !!c2.applied].sort(), [false, true], "una la aplica, la otra la encuentra migrada");
    const cut = (await stored(C)).betCloseMigration.cutoff;
    assert.equal((c1.applied ? c1 : c2).cutoff, cut);
  });

  itest("con escrituras concurrentes: la respuesta que espera el candado y la migración entran las dos", async () => {
    const D = await unCiclo("mgd");
    const { pending } = await withRowLocked(D.metaKey, async () => {
      const ans = answer(D, "cb_mgdabie", "Cruz Azul");      // espera el candado
      const mig = run({ apply: true });                     // también
      await new Promise((r) => setTimeout(r, 600));
      return { pending: Promise.all([ans, mig]) };
    });
    const [ans] = await pending;
    assert.equal(ans.status, 200, JSON.stringify(ans.body));
    const d = await stored(D);
    assert.equal(d.participants.find((p) => p.id === D.beto.id).customBetAnswers.cb_mgdabie.guess, "Cruz Azul");
    assert.equal(d.betCloseMigration.version, 1);
    assert.equal(d.customBets.find((x) => x.id === "cb_mgdabie").closeSource, "migration_round");
  });

  itest("después: las antiguas ya no se reabren (A–D) ni aceptan respuestas fuera de plazo; «Sin cierre» sigue abierta y se puede ligar", async () => {
    // A: borrar la J1 de la que cerró: se guarda y sigue cerrada.
    const v = await read(A);
    v.rounds = v.rounds.filter((r) => r.number !== 1);
    assert.equal((await write(A, v)).status, 200);
    assert.equal((await answer(A, "cb_mgacerr", "Tigres")).status, 403);
    // D: cambiarle la jornada: 409.
    const w = await read(A);
    w.customBets.find((x) => x.id === "cb_mgacerr").closesAtRound = 2;
    assert.equal((await write(A, w)).body.error, "bet_close_locked");
    // La que perdió su jornada y la ambigua: cerradas.
    assert.equal((await answer(A, "cb_mgaperd", "x")).status, 403);
    assert.equal((await answer(B, "cb_mgbamb", "x")).status, 403);
    // La abierta y la «Sin cierre» siguen abiertas.
    assert.equal((await answer(A, "cb_mgaabie", "León")).status, 200);
    assert.equal((await answer(A, "cb_mgasinc", "León")).status, 200);
    // Ligar la «Sin cierre» a una jornada abierta es un cambio explícito permitido.
    const x = await read(A);
    x.customBets.find((b) => b.id === "cb_mgasinc").closesAtRound = 2;
    assert.equal((await write(A, x)).status, 200);
    assert.equal((await stored(A)).customBets.find((b) => b.id === "cb_mgasinc").closeSource, "round");
    // Un cliente anterior que omite los campos nuevos no los borra.
    const y = await read(A);
    y.customBets = y.customBets.map(({ id, label, scope, points, closesAtRound }) => ({ id, label, scope, points, closesAtRound }));
    assert.equal((await write(A, y)).status, 200);
    assert.equal((await stored(A)).customBets.find((b) => b.id === "cb_mgaperd").closeFlag, "lost_link");
    // La marca la escribe sólo el servidor.
    const z = await read(A);
    delete z.betCloseMigration;
    assert.equal((await write(A, z)).status, 200);
    assert.equal((await stored(A)).betCloseMigration.version, 1);
  });

  itest("una ambigua se liga sólo con una decisión explícita por pregunta (overrides)", async () => {
    const E = await conArchivo("mge");
    await run({ apply: true, overrides: { [E.slug]: { cb_mgeamb: "link" } } });
    const e = (await stored(E)).customBets;
    assert.deepEqual([e[0].closesRoundId, e[0].closeSource], ["r_mgenew1", "migration_round"]);
    assert.equal(e[1].closeFlag, "lost_link", "la otra, sin decisión, por protección");
  });
});
