// metaNumbers.integration.test.js — los números de la meta que se pintan para
// todos sólo cambian a números; lo de siempre, y lo que ya estaba guardado, sí
// se sigue guardando.
//
// Usa el servidor real y una PostgreSQL local desechable (test/helpers/realServer.js):
//
//   pg_ctlcluster 16 main start
//   export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/metaNumbers.integration.test.js
//
// Sin QRACKS_TEST_DATABASE_URL, cada test sale como SKIPPED, con el motivo.

const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela } = require("./helpers/realServer");

const MARCADO = '<img src=x onerror="alert(1)">';
const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;

// Una jornada, una apuesta y la penalización, guardadas por la API como lo hace el navegador.
async function conTodo(tag) {
  const q = await quiniela(tag);
  const v = await read(q);
  v.rounds.push({ id: "r_num1234", number: 1, deadline: new Date(Date.now() + 2 * 864e5).toISOString(), results: {}, resultsPublished: false, published: true,
    matches: [{ id: "m_num1234", teamA: "León", teamB: "Santos" }] });
  // Cierra con la jornada 1, que existe y no ha cerrado (metaBets.js).
  v.customBets = [{ id: "cb_num1234", label: "Campeón", scope: "temporada", points: 3, closesAtRound: 1 }];
  v.paymentPenalty = { enabled: true, startsAtRound: 2, pointsPerRound: 1 };
  v.settings.entryFee = 150;
  v.settings.pointsPerCorrectPick = 2;
  const r = await write(q, v);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return q;
}

test.describe("números de la meta (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("un número que llega como texto con marcado: 400 invalid_number, con el campo, y nada cambia", async () => {
    const q = await conTodo("nums");
    const antes = await stored(q);
    const casos = {
      "rounds.number": (v) => { v.rounds[0].number = MARCADO; },
      "customBets.points": (v) => { v.customBets[0].points = MARCADO; },
      "customBets.closesAtRound": (v) => { v.customBets[0].closesAtRound = MARCADO; },
      "settings.entryFee": (v) => { v.settings.entryFee = MARCADO; },
      "settings.pointsPerCorrectPick": (v) => { v.settings.pointsPerCorrectPick = MARCADO; },
      "paymentPenalty.startsAtRound": (v) => { v.paymentPenalty.startsAtRound = MARCADO; },
      "paymentPenalty.pointsPerRound": (v) => { v.paymentPenalty.pointsPerRound = MARCADO; },
      "golScorerBet.bonusPoints": (v) => { v.golScorerBet = { enabled: true, bonusPoints: MARCADO }; },
    };
    for (const [field, set] of Object.entries(casos)) {
      const v = await read(q); set(v);
      const r = await write(q, v);
      assert.deepEqual([r.status, r.body], [400, { error: "invalid_number", field }], field);
    }
    // También en una jornada nueva.
    const v = await read(q);
    v.rounds.push({ id: "r_new1234", number: [MARCADO], deadline: new Date(Date.now() + 3 * 864e5).toISOString(), results: {}, resultsPublished: false, published: true,
      matches: [{ id: "m_new1234", teamA: "Toluca", teamB: "Pachuca" }] });
    const r = await write(q, v);
    assert.deepEqual([r.status, r.body], [400, { error: "invalid_number", field: "rounds.number" }]);
    assert.deepEqual(await stored(q), antes, "la fila sigue intacta");
  });

  itest("lo de siempre se guarda: jornada, apuesta, cuota, puntos y penalización como números", async () => {
    const q = await conTodo("nums-ok");
    const v = await read(q);
    v.settings.entryFee = 200;
    v.settings.pointsPerCorrectPick = 1.5;
    v.customBets[0].points = 0;
    // El cierre de una pregunta de torneo ya no se puede quitar (metaBets.js);
    // aquí se queda en la jornada 1.
    v.paymentPenalty.startsAtRound = null;
    const r = await write(q, v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await stored(q);
    assert.deepEqual([s.settings.entryFee, s.settings.pointsPerCorrectPick, s.customBets[0].points, s.customBets[0].closesAtRound, s.paymentPenalty.startsAtRound],
      [200, 1.5, 0, 1, null]);
  });

  itest("un número raro que YA estaba guardado no impide seguir guardando la quiniela", async () => {
    const q = await conTodo("nums-legacy");
    // Datos antiguos, puestos directamente en la base (no por la API).
    const v0 = await stored(q);
    v0.settings.entryFee = "150 MXN";
    v0.rounds[0].number = "1";
    v0.customBets[0].points = "3";
    await dbQuery("UPDATE kv SET value = $2::jsonb WHERE key = $1", [q.metaKey, JSON.stringify(v0)]);
    const v = await read(q);
    v.groupName = "Otro nombre";
    v.rounds[0].matches[0].teamB = "Santos Laguna";
    const r = await write(q, v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await stored(q);
    assert.deepEqual([s.groupName, s.rounds[0].matches[0].teamB, s.settings.entryFee, s.rounds[0].number], ["Otro nombre", "Santos Laguna", "150 MXN", "1"]);
  });
});
