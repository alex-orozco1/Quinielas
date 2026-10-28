// betsConcurrency.integration.test.js — MS2 · las preguntas de otro admin no se
// pierden (Technical QA, ronda 4, P1), en el servidor real con PostgreSQL:
//
//   pg_ctlcluster 16 main start
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/betsConcurrency.integration.test.js
//
// Sin QRACKS_TEST_DATABASE_URL, cada test sale como SKIPPED, con el motivo.
const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela, freshIp } = require("./helpers/realServer");

const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const pregunta = (id, label) => ({ id, label, scope: "jornada", points: 2 });
const copia = (v) => JSON.parse(JSON.stringify(v));

test.describe("preguntas: nadie pisa las de otro (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("A leyó antes; B guarda una pregunta; A escribe sin haberla visto: 409 bets_conflict, nada se escribe y la de B sigue. Tras releer, A guarda y quedan las dos", async () => {
    const q = await quiniela("bets-a");
    const a = await read(q);                         // A carga (por ejemplo, antes del aviso de contraseña)
    const b = await read(q);
    b.customBets = [pregunta("cb_bruno", "Pregunta de Bruno")];
    const rb = await write(q, b);
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    a.customBets = [...(a.customBets || []), pregunta("cb_ana", "Pregunta de Ana")];
    a.settings.entryFee = 50;
    const antes = await stored(q);
    const ra = await write(q, a);
    assert.equal(ra.status, 409);
    assert.equal(ra.body.error, "bets_conflict");
    assert.deepEqual(await stored(q), antes, "ni las preguntas ni la cuota de A se escribieron");
    const fresh = await read(q);
    fresh.customBets.push(pregunta("cb_ana", "Pregunta de Ana"));
    const ok = await write(q, fresh);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((await stored(q)).customBets.map((x) => x.id), ["cb_bruno", "cb_ana"]);
  });

  itest("un participante que se registra entre dos guardados de admin no le devuelve la revisión a la pestaña atrasada: la pregunta del otro admin sigue (Technical QA, ronda 4)", async () => {
    const q = await quiniela("bets-reg");
    const base = await read(q);                       // la quiniela ya tiene una pregunta
    base.customBets = [pregunta("cb_campeon", "¿Quién será campeón?")];
    assert.equal((await write(q, base)).status, 200);
    const ana = await read(q);                        // Ana abre Tus reglas
    const bruno = await read(q);
    bruno.customBets = [...(bruno.customBets || []), pregunta("cb_bruno", "Pregunta de Bruno")];
    assert.equal((await write(q, bruno)).status, 200);
    const revTrasBruno = (await stored(q)).betsRevision;
    const reg = await call("POST", "/api/self-register", { ip: freshIp(), body: { metaKey: q.metaKey, name: "Carla", pin: "5791", slug: q.slug } });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.ok((await stored(q)).betsRevision >= revTrasBruno, "registrarse no regresa la revisión");
    ana.settings.entryFee = 80;                       // Ana guarda la cuota con su copia vieja
    const ra = await write(q, ana);
    assert.deepEqual([ra.status, ra.body.error], [409, "bets_conflict"]);
    const s = await stored(q);
    assert.ok(s.customBets.some((x) => x.id === "cb_bruno"), "la pregunta de Bruno sigue");
    assert.ok(s.participants.some((p) => p.name === "Carla"), "y Carla también");
  });

  itest("la misma pestaña encadena guardados con la revisión que le devuelve el servidor; un reintento idéntico no es conflicto", async () => {
    const q = await quiniela("bets-b");
    const v = await read(q);
    v.customBets = [pregunta("cb_1", "Uno")];
    const r1 = await write(q, copia(v));
    assert.equal(r1.status, 200);
    assert.ok(Number.isInteger(r1.body.betsRevision));
    const repetido = await write(q, copia(v));       // la respuesta se perdió y se reintenta igual
    assert.equal(repetido.status, 200, "lo mismo que ya está no es un conflicto");
    v.betsRevision = r1.body.betsRevision;
    v.customBets.push(pregunta("cb_2", "Dos"));
    const r2 = await write(q, copia(v));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.betsRevision, r1.body.betsRevision + 1);
  });

  itest("una escritura sin `customBets` conserva las guardadas; una fila sin revisión adopta la primera escritura", async () => {
    const q = await quiniela("bets-c");
    const v = await read(q);
    v.customBets = [pregunta("cb_1", "Uno")];
    assert.equal((await write(q, copia(v))).status, 200);
    const sin = await read(q);
    delete sin.customBets;
    assert.equal((await write(q, sin)).status, 200);
    assert.deepEqual((await stored(q)).customBets.map((x) => x.id), ["cb_1"]);
    const raw = await stored(q);
    delete raw.betsRevision;                          // como una fila anterior a este cambio
    await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(raw)]);
    const viejo = await read(q);
    delete viejo.betsRevision;
    viejo.customBets.push(pregunta("cb_2", "Dos"));
    assert.equal((await write(q, viejo)).status, 200);
    assert.equal((await stored(q)).betsRevision, 1);
  });

  itest("publicar una jornada sin cierre válido es 400 invalid_value, no «el cierre ya pasó»", async () => {
    const q = await quiniela("bets-d");
    const v = await read(q);
    v.rounds.push({ id: "r_sincierre", number: 1, deadline: null, results: {}, resultsPublished: false, published: true, matches: [{ id: "m_sc1", teamA: "León", teamB: "Santos" }] });
    const r = await write(q, v);
    assert.deepEqual([r.status, r.body.error, r.body.field], [400, "invalid_value", "rounds.deadline"]);
  });
});
