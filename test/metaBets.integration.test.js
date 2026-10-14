// metaBets.integration.test.js — el cierre de las preguntas de torneo, en el
// servidor real: al crearlas y al contestarlas.
//
// Usa el servidor real y una PostgreSQL local desechable (test/helpers/realServer.js):
//
//   pg_ctlcluster 16 main start
//   export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/metaBets.integration.test.js
//
// Sin QRACKS_TEST_DATABASE_URL, cada test sale como SKIPPED, con el motivo.

const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, withRowLocked, call, kvPath, quiniela } = require("./helpers/realServer");

const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const answer = (q, who, betId, guess) => call("POST", "/api/submit-bet-answer", {
  ip: q.betoPhone.ip,
  headers: { "X-Qracks-Auth": who.pin, "X-Qracks-Participant": who.id },
  body: { metaKey: q.metaKey, participantId: who.id, betId, guess },
});
// Cambia, directo en la base, la fecha de cierre de una jornada guardada.
async function setDeadline(q, number, iso) {
  const v = await stored(q);
  v.rounds.find((r) => r.number === number).deadline = iso;
  await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
}

const enDias = (d) => new Date(Date.now() + d * 864e5).toISOString();
const jornada = (number, deadline) => ({ id: "r_bets" + number + "x", number, deadline, results: {}, resultsPublished: false, published: true,
  matches: [{ id: "m_bets" + number + "x", teamA: "León", teamB: "Santos" }] });
const campeon = (closesAtRound) => ({ id: "cb_campeonx1", label: "¿Qué equipo será campeón del torneo?", scope: "temporada", points: 5, closesAtRound });

test.describe("preguntas de torneo: el cierre (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("crear una de torneo sin cierre, o ligada a una jornada que no existe, responde 400 y no guarda nada", async () => {
    const q = await quiniela("bets-sin-cierre");
    const v = await read(q);
    v.rounds.push(jornada(12, enDias(3)));
    for (const [closesAtRound, reason] of [[null, "bet_close_required"], [13, "bet_close_required"]]) {
      const antes = await stored(q);
      const r = await write(q, { ...v, customBets: [campeon(closesAtRound)] });
      assert.deepEqual([r.status, r.body], [400, { error: reason, betId: "cb_campeonx1" }], String(closesAtRound));
      assert.deepEqual(await stored(q), antes, "nada cambió");
    }
    // Publicada en el mismo guardado que su jornada de cierre: sí.
    const ok = await write(q, { ...v, customBets: [campeon(12)] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await stored(q)).customBets[0].closesAtRound, 12);
  });

  itest("una pregunta antigua sin cierre se sigue pudiendo guardar sin tocarla", async () => {
    const q = await quiniela("bets-antigua");
    const v = await read(q);
    v.rounds.push(jornada(1, enDias(3)));
    const antigua = { id: "cb_antigua01", label: "Goleador", scope: "temporada", points: 3, closesAtRound: null };
    await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify({ ...(await stored(q)), customBets: [antigua] })]);
    const w = await read(q);
    w.rounds.push(jornada(1, enDias(3)));
    w.settings.entryFee = 100;
    const r = await write(q, w);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await stored(q)).customBets, [antigua]);
  });

  itest("una quiniela con el «goleador» antiguo sin migrar se sigue pudiendo guardar al mudarlo (cierre vencido o vacío)", async () => {
    const q = await quiniela("bets-goleador");
    for (const closesAtRound of [1, null]) {
      const base = await stored(q);
      delete base.customBetsMigrated;
      base.customBets = [];
      base.golScorerBet = { enabled: true, bonusPoints: 3, closesAtRound };
      base.rounds = [jornada(1, new Date(Date.now() - 864e5).toISOString())];
      await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(base)]);
      const v = await read(q);
      v.customBetsMigrated = true;
      v.customBets = [{ id: "cb_gol" + (closesAtRound || 0) + "abc", label: "Goleador de la liga", scope: "temporada", points: 3, closesAtRound }];
      const r = await write(q, v);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      // Y lo que el admin guarde después (la penalización, por ejemplo) también.
      const w = await read(q);
      w.paymentPenalty = { enabled: true, startsAtRound: 1, pointsPerRound: 1 };
      assert.equal((await write(q, w)).status, 200);
    }
  });

  itest("contestar antes del cierre guarda; después responde 403 bet_locked y la respuesta guardada no cambia", async () => {
    const q = await quiniela("bets-plazo");
    const v = await read(q);
    v.rounds.push(jornada(12, enDias(3)));
    v.customBets = [campeon(12)];
    assert.equal((await write(q, v)).status, 200);

    const r1 = await answer(q, q.beto, "cb_campeonx1", "Toluca");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const r2 = await answer(q, q.beto, "cb_campeonx1", "América");
    assert.equal(r2.status, 200, "se puede cambiar antes del cierre");
    const guardada = (s) => s.participants.find((p) => p.id === q.beto.id).customBetAnswers.cb_campeonx1.guess;
    assert.equal(guardada(await stored(q)), "América");

    await setDeadline(q, 12, new Date(Date.now() - 1000).toISOString());
    const r3 = await answer(q, q.beto, "cb_campeonx1", "Tigres");
    assert.deepEqual([r3.status, r3.body], [403, { error: "bet_locked" }]);
    assert.equal(guardada(await stored(q)), "América");
  });

  itest("cuenta la hora en que la respuesta llega al servidor, como en los pronósticos: si llega antes del cierre se guarda aunque espere su turno", async () => {
    const q = await quiniela("bets-carrera");
    const v = await read(q);
    v.rounds.push(jornada(12, enDias(3)));
    v.customBets = [campeon(12)];
    assert.equal((await write(q, v)).status, 200);
    assert.equal((await answer(q, q.beto, "cb_campeonx1", "Toluca")).status, 200);
    // La respuesta llega antes del cierre, pero la fila está bloqueada por otra
    // escritura y el cierre pasa mientras espera su turno. Igual que los picks
    // (NOW() de PostgreSQL es la hora de inicio de la transacción), cuenta la
    // hora de llegada: se guarda. Una que LLEGA después del cierre se rechaza
    // (prueba anterior).
    const closesAt = Date.now() + 1500;
    await setDeadline(q, 12, new Date(closesAt).toISOString());
    const { enviada } = await withRowLocked(q.metaKey, async () => {
      const enviada = answer(q, q.beto, "cb_campeonx1", "Tigres");
      assert.ok(Date.now() < closesAt, "se envió antes del cierre");
      await new Promise((ok) => setTimeout(ok, closesAt - Date.now() + 400));
      return { enviada }; // sin esperarla aquí: espera el candado que soltamos al salir
    });
    const r = await enviada;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await stored(q);
    assert.equal(s.participants.find((p) => p.id === q.beto.id).customBetAnswers.cb_campeonx1.guess, "Tigres");
    // Y ya cerrada, la siguiente se rechaza y no cambia nada.
    const tarde = await answer(q, q.beto, "cb_campeonx1", "Pumas");
    assert.deepEqual([tarde.status, tarde.body], [403, { error: "bet_locked" }]);
    assert.equal((await stored(q)).participants.find((p) => p.id === q.beto.id).customBetAnswers.cb_campeonx1.guess, "Tigres");
  });

  itest("quien entra después del cierre ve la pregunta cerrada pero puede jugar la jornada abierta", async () => {
    const q = await quiniela("bets-tarde");
    const v = await read(q);
    v.rounds.push(jornada(12, enDias(3)), jornada(13, enDias(10)));
    v.customBets = [campeon(12)];
    assert.equal((await write(q, v)).status, 200);
    await setDeadline(q, 12, new Date(Date.now() - 1000).toISOString());
    const r = await answer(q, q.beto, "cb_campeonx1", "Toluca");
    assert.deepEqual([r.status, r.body], [403, { error: "bet_locked" }]);
    const picks = await call("POST", "/api/kv/" + encodeURIComponent(`quiniela:${q.slug}:picks:${q.beto.id}`), {
      ip: q.betoPhone.ip, headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id },
      body: { value: { r_bets13x: { m_bets13x: "A" } } },
    });
    assert.equal(picks.status, 200, JSON.stringify(picks.body));
  });
});
