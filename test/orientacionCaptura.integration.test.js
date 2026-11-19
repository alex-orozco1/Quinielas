// Orientación del admin, contra el servidor real con PostgreSQL: el conteo de
// jornadas de ESTE torneo con resultados publicados, que decide si se muestra
// el aviso grande «Captura los resultados» (primeras 4 jornadas de cada torneo).
const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela, PLATFORM_PASSWORD } = require("./helpers/realServer");

const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const plan = (q, headers) => call("GET", `/api/quinielas/${q.slug}/plan`, { headers: headers || { "X-Qracks-Auth": q.owner } });
const counted = async (q) => {
  const r = await plan(q);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.tournament && r.body.tournament.resultsRounds;
};
const entryOf = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value.quinielas.find((x) => x.slug === q.slug);
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const round = (n) => ({ id: "r" + n, number: n, deadline: enHoras(48), published: true, results: {}, resultsPublished: false, matches: [{ id: "m" + n, teamA: "Local " + n, teamB: "Visita " + n }] });

async function conJornadas(tag, numbers) {
  const q = await quiniela(tag);
  const g = await call("POST", `/api/platform/quinielas/${q.slug}/entitlement`, { headers: { "X-Qracks-Platform-Auth": PLATFORM_PASSWORD }, body: { plan: "PLUS", grantId: "it-" + tag } });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const v = await read(q);
  v.rounds = numbers.map(round);
  const w = await write(q, v);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  return q;
}
// Cierra las jornadas (plazo vencido) directamente en la base, como el paso del tiempo.
async function cerrar(q) {
  const v = (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
  v.rounds.forEach((r) => { r.deadline = new Date(Date.now() - 60e3).toISOString(); });
  await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
}
async function publicarResultados(q, id, result = "A") {
  const v = await read(q);
  const r = v.rounds.find((x) => x.id === id);
  r.results = { ["m" + id.slice(1)]: result };
  r.resultsPublished = true;
  const w = await write(q, v);
  assert.equal(w.status, 200, JSON.stringify(w.body));
}

test.describe("orientación: jornadas del torneo con resultados publicados", () => {
  test.before(setup);
  test.after(teardown);

  itest("empieza en la J15: 0, 3, 4 y 5; corregir no suma; borrar no resta; recargar da lo mismo", async () => {
    const q = await conJornadas("conteo", [15, 16, 17, 18, 19]);
    await cerrar(q);
    assert.equal(await counted(q), 0, "sin resultados publicados");
    await publicarResultados(q, "r15");
    await publicarResultados(q, "r16");
    await publicarResultados(q, "r17");
    assert.equal(await counted(q), 3, "la J15 es la primera gestionada, no la decimoquinta");
    await publicarResultados(q, "r17", "B"); // corrección
    assert.equal(await counted(q), 3, "una corrección no cuenta otra vez");
    await publicarResultados(q, "r18");
    assert.equal(await counted(q), 4);
    // Borrar una jornada con resultados no reinicia ni baja el conteo.
    const v = await read(q);
    v.rounds = v.rounds.filter((r) => r.id !== "r15");
    assert.equal((await write(q, v)).status, 200);
    assert.equal(await counted(q), 4, "borrar la J15 no lo baja");
    await publicarResultados(q, "r19");
    assert.equal(await counted(q), 5);
    assert.equal(await counted(q), 5, "otra lectura (otro dispositivo) da lo mismo");
    // El registro es del servidor: la meta no puede traerlo.
    const intento = await read(q);
    intento.resultsRoundIdsByScope = { x: [] };
    await write(q, intento);
    assert.equal(await counted(q), 5);
    assert.equal("resultsRoundIdsByScope" in (await read(q)), false, "no se guarda en la meta");
  });

  itest("torneo nuevo (sin cerrar el anterior): vuelve a cero aunque las jornadas viejas sigan en el tablero", async () => {
    const q = await conJornadas("ciclo", [1, 2, 3, 4, 5]);
    await cerrar(q);
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) await publicarResultados(q, id);
    assert.equal(await counted(q), 5);
    const entry = await entryOf(q);
    const nc = await call("POST", `/api/quinielas/${q.slug}/tournament/new-cycle`, { headers: { "X-Qracks-Auth": q.owner }, body: { expectedCycle: entry.tournamentScope.editionSeq } });
    assert.equal(nc.status, 200, JSON.stringify(nc.body));
    assert.equal(await counted(q), 0, "el torneo nuevo empieza en cero");
    // Corregir un resultado del torneo anterior (sigue en el tablero) no cuenta en el nuevo.
    await publicarResultados(q, "r5", "B");
    assert.equal(await counted(q), 0);
    const v = await read(q);
    v.rounds.push(round(6));
    assert.equal((await write(q, v)).status, 200);
    await cerrar(q);
    await publicarResultados(q, "r6");
    assert.equal(await counted(q), 1, "su primera jornada");
  });

  itest("cerrar (archivar) el torneo: el siguiente vuelve a cero", async () => {
    const q = await conJornadas("archivo", [1, 2]);
    await cerrar(q);
    await publicarResultados(q, "r1");
    await publicarResultados(q, "r2");
    assert.equal(await counted(q), 2);
    const entry = await entryOf(q);
    const c = await require("./helpers/realServer").closeWithSnapshot(q.slug, { "X-Qracks-Auth": q.owner },
      { expectedCycle: entry.tournamentScope.editionSeq, closeIntentId: "itclose" + Date.now().toString(36) });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal((await read(q)).rounds.length, 0, "el tablero se despejó");
    assert.equal(await counted(q), 0);
  });

  itest("quiniela anterior a este registro: arranca de lo que hay hoy en su torneo, sin inventar jornadas", async () => {
    const q = await conJornadas("antigua", [1, 2, 3]);
    await cerrar(q);
    await publicarResultados(q, "r1");
    await publicarResultados(q, "r2");
    // Simula una quiniela de antes: sin el registro.
    const idx = (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value;
    delete idx.quinielas.find((x) => x.slug === q.slug).resultsRoundIdsByScope;
    await dbQuery("UPDATE kv SET value = $1 WHERE key = 'platform_index'", [JSON.stringify(idx)]);
    assert.equal(await counted(q), 2, "las que hoy tienen resultados publicados");
  });

  itest("un participante no lee el conteo (el plan es sólo del admin)", async () => {
    const q = await conJornadas("permiso", [1]);
    const r = await plan(q, { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id });
    assert.equal(r.status, 403);
  });
});
