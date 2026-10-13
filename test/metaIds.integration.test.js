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
const plant = (key, value) => dbQuery("INSERT INTO kv (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, JSON.stringify(value)]);
const picksPath = (q, pid) => "/api/kv/" + encodeURIComponent(`quiniela:${q.slug}:picks:${pid}`);
// Ana con su PIN: admin, pero sin la contraseña del dueño.
const asAdminPin = (q) => ({ ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, headers: { "X-Qracks-Auth": q.ana.pin, "X-Qracks-Participant": q.ana.id } });

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

  itest("una jornada con id numérico nueva no entra: 400 invalid_id", async () => {
    const q = await quiniela("ids-num");
    const v = await read(q);
    v.rounds.push({ id: 77, number: 1, deadline: new Date(Date.now() + 2 * 864e5).toISOString(), results: {}, resultsPublished: false, published: true, matches: [{ id: "m_ok12345", teamA: "A", teamB: "B" }] });
    const r = await write(q, v);
    assert.deepEqual([r.status, r.body], [400, { error: "invalid_id", kind: "round" }]);
  });

  itest("una jornada ABIERTA heredada con id numérico no deja ver los picks de nadie", async () => {
    const q = await quiniela("ids-num-legacy");
    const v0 = await stored(q);
    v0.rounds.push({ id: 77, number: 1, deadline: new Date(Date.now() + 2 * 864e5).toISOString(), results: {}, resultsPublished: false, published: true, matches: [{ id: "m_a1", teamA: "A", teamB: "B" }] });
    await plant(q.metaKey, v0);
    await plant(`quiniela:${q.slug}:picks:${q.beto.id}`, { 77: { m_a1: "B" } });
    const anon = await call("GET", picksPath(q, q.beto.id));
    assert.deepEqual([anon.status, anon.body.value], [200, {}], "sin sesión no ve nada de una jornada abierta");
    const owner = await call("GET", picksPath(q, q.beto.id), { headers: { "X-Qracks-Auth": q.owner } });
    assert.deepEqual(owner.body.value, { 77: { m_a1: true } }, "el dueño sólo sabe que Beto ya votó");
    const beto = await call("GET", picksPath(q, q.beto.id), { ip: q.betoPhone.ip, cookie: q.betoPhone.cookie });
    assert.deepEqual(beto.body.value, { 77: { m_a1: "B" } }, "Beto ve lo suyo");
  });

  itest("un participante con id `__proto__` no entra, y uno heredado así no deja nombrar admins sin la contraseña del dueño", async () => {
    const q = await quiniela("ids-proto");
    const nuevo = await read(q);
    nuevo.participants.push({ id: "__proto__", name: "X", isAdmin: false, paid: false, pin: null });
    assert.deepEqual((await write(q, nuevo)).body, { error: "invalid_id", kind: "participant" });
    // Heredado, puesto directo en la base: el `oldById` del guardado ya no lo toma por su prototipo.
    const v0 = await stored(q);
    v0.participants.push({ id: "__proto__", name: "X", isAdmin: false, paid: false, pin: null, p_evil001: { isAdmin: true } });
    await plant(q.metaKey, v0);
    const antes = await stored(q);
    const v = (await call("GET", kvPath(q.slug), asAdminPin(q))).body.value;
    v.participants = v.participants.filter((p) => p.id !== "__proto__");
    v.participants.push({ id: "p_evil001", name: "Evil", isAdmin: true, paid: false, pin: null });
    const r = await call("POST", kvPath(q.slug), { ...asAdminPin(q), body: { value: v } });
    assert.deepEqual([r.status, r.body], [403, { error: "owner_password_required" }], "es un admin nuevo: hace falta la contraseña del dueño");
    const despues = await stored(q);
    assert.ok(!despues.participants.some((p) => p.id === "p_evil001" && p.isAdmin === true), "nadie quedó como admin sin la contraseña del dueño");
    assert.deepEqual(despues, antes, "la fila sigue intacta");
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
