// MS2 · D4-01 (revalidación de fcd61d9): el «goleador» de antes (golScorerBet)
// no se reabre al mudarlo a las preguntas nuevas, ni editándolo antes de
// mudarlo. Su cierre y su estado son los del dato que guarda el servidor; una
// pregunta cerrada sigue cerrada y su acierto no se lleva a otra con otro plazo.
// La mudanza legítima (ensureCustomBets, con el cierre que ya tenía) se acepta.
//
// Servidor real + PostgreSQL. Cada caso se corre sin y con la marca de la
// migración de cierres (betCloseMigration versión 1).

const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela } = require("./helpers/realServer");

const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const putStored = (q, v) => dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
const answer = (q, betId, guess) => call("POST", "/api/submit-bet-answer", {
  ip: q.betoPhone.ip,
  headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id },
  body: { metaKey: q.metaKey, participantId: q.beto.id, betId, guess },
});
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const jornada = (tag, number, deadline) => ({ id: "r_gs" + tag + number, number, deadline, results: {}, resultsPublished: false, published: true,
  matches: [{ id: "m_gs" + tag + number, teamA: "León", teamB: "Santos" }] });
const GOL = "cb_golmudado";

// Una quiniela con el «goleador» de antes sin mudar: cierra con la J1 (ya
// cerrada, o abierta en los controles); Beto respondió y tiene el acierto.
async function conGoleador(tag, { j1 = -2, closesAtRound = 1, migrated = false } = {}) {
  const q = await quiniela(tag);
  const v = await stored(q);
  v.rounds = [jornada(tag, 1, enHoras(j1)), jornada(tag, 2, enHoras(72))];
  v.customBets = [];
  v.customBetsMigrated = false;
  v.golScorerBet = { enabled: true, bonusPoints: 3, closesAtRound };
  const beto = v.participants.find((p) => p.id === q.beto.id);
  beto.golScorerGuess = "Henry Martín";
  beto.golScorerCorrect = true;
  if (migrated) v.betCloseMigration = { version: 1, cutoff: enHoras(-1), appliedAt: enHoras(-1) };
  await putStored(q, v);
  return q;
}
// Lo que hace ensureCustomBets en el cliente, con el cierre que se le pida.
async function mudar(q, closesAtRound, extra) {
  const v = await read(q);
  v.customBetsMigrated = true;
  v.customBets = [{ id: GOL, label: "Goleador de la liga", scope: "temporada", points: 3, closesAtRound }];
  const beto = v.participants.find((p) => p.id === q.beto.id);
  beto.customBetAnswers = { [GOL]: { guess: beto.golScorerGuess || "Henry Martín", correct: true } };
  delete beto.golScorerGuess;
  if (extra) extra(v);
  return write(q, v);
}

test.describe("D4-01 · el «goleador» de antes no se reabre (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  for (const migrated of [false, true]) {
    const tag = migrated ? "m" : "s";
    const label = migrated ? "con migración aplicada" : "sin migración";

    itest(`${label} · mudarlo cerrado pidiendo una jornada abierta: 409 y no se escribe; la respuesta sigue rechazada`, async () => {
      const q = await conGoleador("gsa" + tag, { migrated });
      const before = JSON.stringify(await stored(q));
      const w = await mudar(q, 2);
      assert.deepEqual([w.status, w.body.error, w.body.betId], [409, "bet_close_locked", GOL]);
      assert.equal(JSON.stringify(await stored(q)), before, "nada se escribió");
      assert.equal((await answer(q, GOL, "Otro")).status, 404, "no se mudó: no hay pregunta que responder");
    });

    itest(`${label} · mudarlo cerrado y, en el mismo guardado, borrar su jornada: 409`, async () => {
      const q = await conGoleador("gsb" + tag, { migrated });
      const w = await mudar(q, 1, (v) => { v.rounds = v.rounds.filter((r) => r.number !== 1); });
      assert.equal(w.status, 409);
      assert.equal(w.body.error, "bet_close_locked");
    });

    itest(`${label} · editar antes el cierre del goleador (J1 ya cerró → J2) no se acepta, y mudarlo después tampoco reabre`, async () => {
      const q = await conGoleador("gsc" + tag, { migrated });
      const v = await read(q);
      v.golScorerBet = { ...v.golScorerBet, closesAtRound: 2 };
      const w = await write(q, v);
      assert.deepEqual([w.status, w.body.error], [409, "bet_close_locked"]);
      assert.equal((await stored(q)).golScorerBet.closesAtRound, 1, "su cierre sigue siendo la J1");
      assert.equal((await mudar(q, 2)).status, 409);
      // Tampoco se puede encender, apagar o crear por la API: es un dato antiguo.
      const x = await read(q);
      x.golScorerBet = { ...x.golScorerBet, bonusPoints: 9 };
      assert.equal((await write(q, x)).status, 409);
    });

    itest(`${label} · control: la mudanza legítima (el cierre que ya tenía) se acepta; sigue cerrada y su acierto se conserva`, async () => {
      const q = await conGoleador("gsd" + tag, { migrated });
      const w = await mudar(q, 1);
      assert.equal(w.status, 200, JSON.stringify(w.body));
      const s = await stored(q);
      const bet = s.customBets.find((b) => b.id === GOL);
      assert.equal(bet.closesAtRound, 1);
      assert.deepEqual(s.participants.find((p) => p.id === q.beto.id).customBetAnswers[GOL], { guess: "Henry Martín", correct: true });
      assert.equal((await answer(q, GOL, "Otro")).status, 403, "cerrada");
      // Y después ya no se le cambia la jornada.
      const x = await read(q);
      x.customBets[0].closesAtRound = 2;
      assert.equal((await write(q, x)).body.error, "bet_close_locked");
    });

    itest(`${label} · control: abierta, la mudanza legítima se acepta y se puede seguir respondiendo hasta su cierre`, async () => {
      const q = await conGoleador("gse" + tag, { migrated, j1: 24 });
      assert.equal((await mudar(q, 1)).status, 200);
      assert.equal((await answer(q, GOL, "Otro")).status, 200);
      // Mudarla pidiendo otra jornada distinta de la que tenía no se acepta, ni abierta.
      const q2 = await conGoleador("gsf" + tag, { migrated, j1: 24 });
      assert.equal((await mudar(q2, 2)).status, 409);
    });

    itest(`${label} · control: sin jornada de cierre, se muda sin cierre (como estaba)`, async () => {
      const q = await conGoleador("gsg" + tag, { migrated, closesAtRound: null });
      assert.equal((await mudar(q, null)).status, 200);
      assert.equal((await answer(q, GOL, "Otro")).status, 200);
    });
  }
});
