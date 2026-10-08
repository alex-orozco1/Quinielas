// metaIds.integration.test.js — un id nuevo con marcado no entra en la meta;
// los de siempre, y los que ya estaban guardados, sí.
//
// Usa el servidor real y una PostgreSQL local desechable (test/helpers/realServer.js):
//
//   pg_ctlcluster 16 main start
//   export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/metaIds.integration.test.js
//
// Sin QRACKS_TEST_DATABASE_URL, cada test sale como SKIPPED, con el motivo.

const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela } = require("./helpers/realServer");

const MARCADO = 'm_1"><img src=x onerror=alert(1)>';
const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;

test.describe("ids de la meta (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("un partido, una jornada, un participante o una apuesta nuevos con marcado: 400 invalid_id y nada cambia", async () => {
    const q = await quiniela("ids");
    const antes = await stored(q);
    const deadline = new Date(Date.now() + 2 * 864e5).toISOString();
    const casos = {
      match: (v) => v.rounds.push({ id: "r_ok12345", number: 1, deadline, results: {}, resultsPublished: false, published: true, matches: [{ id: MARCADO, teamA: "A", teamB: "B" }] }),
      round: (v) => v.rounds.push({ id: MARCADO, number: 1, deadline, results: {}, resultsPublished: false, published: true, matches: [{ id: "m_ok12345", teamA: "A", teamB: "B" }] }),
      participant: (v) => v.participants.push({ id: MARCADO, name: "Zoe", isAdmin: false, paid: false, pin: null }),
      bet: (v) => { v.customBets = (v.customBets || []).concat([{ id: MARCADO, label: "X", scope: "temporada", points: 1 }]); },
    };
    for (const [kind, add] of Object.entries(casos)) {
      const v = await read(q); add(v);
      const r = await write(q, v);
      assert.deepEqual([r.status, r.body], [400, { error: "invalid_id", kind }], kind);
    }
    assert.deepEqual(await stored(q), antes, "la fila sigue intacta");
  });

  itest("un id que no es texto (una lista con marcado) tampoco entra: 400 invalid_id y nada cambia", async () => {
    const q = await quiniela("ids-lista");
    const antes = await stored(q);
    const deadline = new Date(Date.now() + 2 * 864e5).toISOString();
    const LISTA = [MARCADO];
    const casos = {
      match: (v) => v.rounds.push({ id: "r_ok12345", number: 1, deadline, results: {}, resultsPublished: false, published: true, matches: [{ id: LISTA, teamA: "A", teamB: "B" }] }),
      round: (v) => v.rounds.push({ id: LISTA, number: 1, deadline, results: {}, resultsPublished: false, published: true, matches: [{ id: "m_ok12345", teamA: "A", teamB: "B" }] }),
      participant: (v) => v.participants.push({ id: LISTA, name: "Zoe", isAdmin: false, paid: false, pin: null }),
      bet: (v) => { v.customBets = (v.customBets || []).concat([{ id: LISTA, label: "X", scope: "temporada", points: 1 }]); },
    };
    for (const [kind, add] of Object.entries(casos)) {
      const v = await read(q); add(v);
      const r = await write(q, v);
      assert.deepEqual([r.status, r.body], [400, { error: "invalid_id", kind }], kind);
    }
    assert.deepEqual(await stored(q), antes, "la fila sigue intacta");
  });

  itest("lo de siempre se guarda: una jornada con ids del navegador", async () => {
    const q = await quiniela("ok");
    const v = await read(q);
    v.rounds.push({ id: "r_k3j2h1g", number: 1, deadline: new Date(Date.now() + 2 * 864e5).toISOString(), results: {}, resultsPublished: false, published: true,
      matches: [{ id: "m_abc1234", teamA: "León", teamB: "Santos" }] });
    const r = await write(q, v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored(q)).rounds[0].matches[0].id, "m_abc1234");
  });

  itest("un id raro que YA estaba guardado no impide seguir guardando la quiniela", async () => {
    const q = await quiniela("legacy");
    // Datos antiguos, puestos directamente en la base (no por la API).
    const v0 = await stored(q);
    v0.rounds.push({ id: "r_legacy1", number: 1, deadline: new Date(Date.now() + 2 * 864e5).toISOString(), results: {}, resultsPublished: false, published: true,
      matches: [{ id: "m:legacy 1", teamA: "León", teamB: "Santos" }] });
    await dbQuery("UPDATE kv SET value = $2::jsonb WHERE key = $1", [q.metaKey, JSON.stringify(v0)]);
    const v = await read(q);
    v.rounds[0].matches[0].teamB = "Santos Laguna";
    const r = await write(q, v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored(q)).rounds[0].matches[0].teamB, "Santos Laguna");
  });
});
