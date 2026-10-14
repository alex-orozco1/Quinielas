// setupPublish.integration.test.js — MS2 · R1 y R2, en el servidor real:
// publicar una jornada cuyo cierre ya pasó mientras la pestaña esperaba, y dos
// admins que publican la misma jornada con reglas distintas.
//
// Usa el servidor real y una PostgreSQL local desechable (test/helpers/realServer.js):
//
//   pg_ctlcluster 16 main start
//   export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/setupPublish.integration.test.js
//
// Sin QRACKS_TEST_DATABASE_URL, cada test sale como SKIPPED, con el motivo.
//
// El reloj se controla con el tiempo real: cierres a uno o dos segundos y la
// fila de la quiniela bloqueada (withRowLocked) hasta que el cierre pasa, de
// modo que el servidor juzga la escritura en el momento en que de verdad corre.

const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, withRowLocked, call, kvPath, quiniela } = require("./helpers/realServer");

const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enMs = (ms) => new Date(Date.now() + ms).toISOString();
const enDias = (d) => new Date(Date.now() + d * 864e5).toISOString();
const jornada = (number, deadline, published = true) => ({ id: "r_pub" + number + "x", number, deadline, results: {}, resultsPublished: false, published,
  matches: [{ id: "m_pub" + number + "x", teamA: "León", teamB: "Santos" }] });
// Guarda directo en la base (sin pasar por las reglas de escritura): el estado de partida.
async function seed(q, mutate) {
  const v = await stored(q);
  mutate(v);
  await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
  return read(q);
}

test.describe("publicar con el cierre vencido (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("una jornada nueva cuyo cierre ya pasó cuando llega la escritura: 409 round_deadline_passed y nada se guarda", async () => {
    const q = await quiniela("pub-tarde");
    const v = await read(q);
    v.rounds.push(jornada(1, enMs(1200)));
    await sleep(1600);                                   // la pestaña esperó: el cierre ya pasó
    const antes = await stored(q);
    const r = await write(q, v);
    assert.deepEqual([r.status, r.body], [409, { error: "round_deadline_passed", roundNumber: 1 }]);
    assert.deepEqual(await stored(q), antes, "nada cambió");
  });

  itest("enviada antes del cierre pero ejecutada después (la fila estaba ocupada): se juzga al ejecutarse", async () => {
    const q = await quiniela("pub-lock");
    const v = await read(q);
    v.rounds.push(jornada(1, enMs(1500)));
    // La escritura sale antes del cierre y espera la fila, que se suelta
    // después del cierre (no se espera su respuesta dentro del bloqueo).
    let pending;
    await withRowLocked(q.metaKey, async () => {
      pending = write(q, v);
      await sleep(2000);
    });
    const r = await pending;
    assert.deepEqual([r.status, r.body.error], [409, "round_deadline_passed"]);
    assert.equal((await stored(q)).rounds.length, 0);
  });

  itest("una preparada (published:false) que se publica con el cierre vencido también se rechaza; con cierre futuro, se publica", async () => {
    const q = await quiniela("pub-preparada");
    let v = await seed(q, (x) => { x.rounds.push(jornada(12, enMs(-60e3), false), jornada(13, enDias(3), false)); });
    v.rounds.find((r) => r.number === 12).published = true;
    const tarde = await write(q, v);
    assert.deepEqual([tarde.status, tarde.body], [409, { error: "round_deadline_passed", roundNumber: 12 }]);
    assert.equal((await stored(q)).rounds.find((r) => r.number === 12).published, false);
    v = await read(q);
    v.rounds.find((r) => r.number === 13).published = true;
    const ok = await write(q, v);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await stored(q)).rounds.find((r) => r.number === 13).published, true);
  });

  itest("lo ya publicado no se toca: corregir partidos, publicar resultados y reabrir con el cierre vencido siguen funcionando", async () => {
    const q = await quiniela("pub-historia");
    let v = await seed(q, (x) => { x.rounds.push(jornada(1, enMs(-3600e3))); });
    // Corregir un partido de una jornada ya publicada y cerrada.
    v.rounds[0].matches[0].teamB = "Santos Laguna";
    let r = await write(q, v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Publicar sus resultados (histórico).
    v = await read(q);
    v.rounds[0].results = { m_pub1x: "A" };
    v.rounds[0].resultsPublished = true;
    r = await write(q, v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Reabrirla con un cierre nuevo.
    v = await read(q);
    v.rounds[0].resultsPublished = false;
    v.rounds[0].deadline = enDias(1);
    r = await write(q, v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await stored(q);
    assert.deepEqual([s.rounds[0].matches[0].teamB, s.rounds[0].published], ["Santos Laguna", true]);
  });
});

test.describe("dos admins publican la misma jornada (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("B publica primero sin penalización; la escritura de A (con penalización, sobre la copia vieja) se rechaza y no pisa lo de B", async () => {
    const q = await quiniela("pub-dos");
    const base = await seed(q, (x) => { x.rounds.push(jornada(12, enDias(3), false)); });
    // B: publica la J12 sin penalización.
    const b = JSON.parse(JSON.stringify(base));
    b.rounds[0].published = true;
    const rb = await write(q, b);
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    // A: la misma J12, con su propio cierre y penalización de 5 desde la J12,
    // sobre la copia de antes (el servidor compara el contenido del tablero:
    // un tablero distinto del guardado que no vio el de B es un conflicto).
    const a = JSON.parse(JSON.stringify(base));
    a.rounds[0].published = true;
    a.rounds[0].deadline = enDias(2);
    a.paymentPenalty = { enabled: true, startsAtRound: 12, pointsPerRound: 5 };
    const ra = await write(q, a);
    assert.deepEqual([ra.status, ra.body.error], [409, "rounds_conflict"]);
    const s = await stored(q);
    assert.equal(s.rounds[0].published, true, "la J12 quedó publicada (por B)");
    assert.ok(!(s.paymentPenalty && s.paymentPenalty.enabled), "la penalización de A no se guardó: el cliente debe decirlo, no celebrarlo");
  });
});
