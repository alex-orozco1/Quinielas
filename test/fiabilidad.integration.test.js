// fiabilidad.integration.test.js — sprint de fiabilidad (AUD-01 … AUD-04)
// contra el servidor real y una base PostgreSQL local desechable
// (test/helpers/realServer.js; sin ella, cada prueba sale como SKIPPED).
//
// AUD-01  Un pronóstico confirmado no se pierde: un envío viejo no pisa uno
//         nuevo, dos pestañas no se borran entre sí, y un documento que no
//         trae lo guardado (una lectura que falló) no lo borra.
// AUD-02  Cerrar el torneo exige que la tabla final salga de TODOS los
//         pronósticos guardados: sin esa base, o con una vieja, no se cierra.
// AUD-03  Los descuentos por no pagar del torneo cerrado se archivan con él y
//         no restan en el torneo nuevo.
// AUD-04  En una quiniela sin creatorId con contraseña de administrador, un
//         PIN de co-admin no cambia nombre, cuota ni puntos por API.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  itest, setup, teardown, dbQuery, freshIp, call, Browser, kvPath, quiniela,
} = require("./helpers/realServer");

const picksPath = (q, pid) => "/api/kv/" + encodeURIComponent(`quiniela:${q.slug}:picks:${pid}`);
const pinHeaders = (who) => ({ "X-Qracks-Auth": who.pin, "X-Qracks-Participant": who.id });
const ownerHeaders = (q) => ({ "X-Qracks-Auth": q.owner });
const storedMeta = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const storedPicks = async (q, pid) => {
  const r = await dbQuery("SELECT value FROM kv WHERE key = $1", [`quiniela:${q.slug}:picks:${pid}`]);
  return r.rows.length ? r.rows[0].value : null;
};
const putMeta = async (q, value) => dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(value)]);
const putPicks = async (q, pid, value) => dbQuery(
  "INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
  [`quiniela:${q.slug}:picks:${pid}`, JSON.stringify(value)]);

const inDays = (d) => new Date(Date.now() + d * 24 * 3600 * 1000).toISOString();
const matches = (rid) => [
  { id: rid + "-m1", teamA: "Halcones", teamB: "Toros" },
  { id: rid + "-m2", teamA: "Lobos", teamB: "Águilas" },
  { id: rid + "-m3", teamA: "Coyotes", teamB: "Jaguares" },
];

// Una quiniela con una jornada abierta (r1) publicada directamente en la fila.
async function withOpenRound(tag) {
  const q = await quiniela(tag);
  const m = await storedMeta(q);
  m.rounds = [{ id: "r1", number: 1, deadline: inDays(3), published: true, results: {}, resultsPublished: false, matches: matches("r1") }];
  await putMeta(q, m);
  return q;
}
const savePicks = (q, who, value, base, extra = {}) => call("POST", picksPath(q, who.id), {
  headers: pinHeaders(who), body: { value, ...(base !== undefined ? { base } : {}), ...extra },
});

test.describe("fiabilidad: guardado de pronósticos, cierre de torneo, descuentos y reglas (real server)", () => {
  test.before(setup);
  test.after(teardown);

  // ---------------------------------------------------------------- AUD-01
  itest("AUD-01 a · fuera de orden: un envío viejo que llega tarde no pisa el más reciente", async () => {
    const q = await withOpenRound("a01a");
    // La misma pestaña mandó dos guardados desde la misma base ({}): primero
    // m1=A, luego m1=B y m2=D. La red entrega el segundo antes.
    const newer = await savePicks(q, q.beto, { r1: { "r1-m1": "B", "r1-m2": "D" } }, {});
    assert.equal(newer.status, 200, JSON.stringify(newer.body));
    const older = await savePicks(q, q.beto, { r1: { "r1-m1": "A" } }, {});
    assert.notEqual(older.status, 200, "el envío viejo no se acepta como si fuera lo último");
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "B", "r1-m2": "D" } });
  });

  itest("AUD-01 b · dos pestañas: cada una guarda un partido distinto y se conservan los dos", async () => {
    const q = await withOpenRound("a01b");
    const tab1 = await savePicks(q, q.beto, { r1: { "r1-m1": "A" } }, {});
    const tab2 = await savePicks(q, q.beto, { r1: { "r1-m2": "B" } }, {});
    assert.equal(tab1.status, 200);
    assert.equal(tab2.status, 200, JSON.stringify(tab2.body));
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "A", "r1-m2": "B" } });
    assert.deepEqual(tab2.body.value, { r1: { "r1-m1": "A", "r1-m2": "B" } }, "la respuesta trae lo guardado, para que la pestaña lo adopte");
  });

  itest("AUD-01 b2 · dos pestañas, mismo partido distinto: conflicto explícito, nada se pisa", async () => {
    const q = await withOpenRound("a01b2");
    assert.equal((await savePicks(q, q.beto, { r1: { "r1-m1": "A" } }, {})).status, 200);
    const other = await savePicks(q, q.beto, { r1: { "r1-m1": "B" } }, {});
    assert.equal(other.status, 409);
    assert.equal(other.body.error, "picks_conflict");
    assert.deepEqual(other.body.value, { r1: { "r1-m1": "A" } }, "trae lo guardado");
    assert.deepEqual(other.body.conflicts, [{ roundId: "r1", field: "r1-m1" }]);
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "A" } });
    // Quien ya vio lo guardado sí puede cambiarlo.
    const again = await savePicks(q, q.beto, { r1: { "r1-m1": "B" } }, { r1: { "r1-m1": "A" } });
    assert.equal(again.status, 200);
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "B" } });
  });

  itest("AUD-01 c · una lectura inicial fallida (documento sin lo guardado) no borra los pronósticos anteriores", async () => {
    const q = await withOpenRound("a01c");
    await putPicks(q, q.beto.id, { r1: { "r1-m1": "A", "r1-m2": "D" } });
    // Una pestaña cuya lectura falló cree que no hay nada y elige m3. Sin base
    // (un cliente anterior) y con base vacía (la lectura fallida) el resultado
    // es el mismo: m1 y m2 se conservan.
    const legacy = await savePicks(q, q.beto, { r1: { "r1-m3": "B" } });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "A", "r1-m2": "D", "r1-m3": "B" } });
    const empty = await savePicks(q, q.beto, {}, {});
    assert.equal(empty.status, 200);
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "A", "r1-m2": "D", "r1-m3": "B" } }, "un documento vacío no es una instrucción de borrar");
  });

  itest("AUD-01 d · aislamiento: otro participante, otra quiniela o un PIN ajeno no escriben; quitar un pronóstico propio sí funciona", async () => {
    const q = await withOpenRound("a01d");
    await putPicks(q, q.beto.id, { r1: { "r1-m1": "A" } });
    const asAna = await call("POST", picksPath(q, q.beto.id), { headers: pinHeaders(q.ana), body: { value: { r1: { "r1-m1": "B" } }, base: { r1: { "r1-m1": "A" } } } });
    assert.equal(asAna.status, 403, "un PIN de otra persona no escribe pronósticos ajenos");
    const q2 = await withOpenRound("a01d2");
    const crossed = await call("POST", picksPath(q2, q.beto.id), { headers: pinHeaders(q.beto), body: { value: { r1: { "r1-m1": "B" } }, base: {} } });
    assert.notEqual(crossed.status, 200, "la sesión de una quiniela no escribe en otra");
    const removed = await savePicks(q, q.beto, { r1: {} }, { r1: { "r1-m1": "A" } });
    assert.equal(removed.status, 200);
    assert.deepEqual(await storedPicks(q, q.beto.id), {}, "quitar un pronóstico que se vio guardado lo quita");
  });

  itest("AUD-01 e · una jornada cerrada no se toca, con o sin base", async () => {
    const q = await withOpenRound("a01e");
    await putPicks(q, q.beto.id, { r1: { "r1-m1": "A" } });
    const m = await storedMeta(q);
    m.rounds[0].deadline = inDays(-1);
    await putMeta(q, m);
    const late = await savePicks(q, q.beto, { r1: { "r1-m1": "B" } }, { r1: { "r1-m1": "A" } });
    assert.equal(late.status, 403);
    assert.equal(late.body.error, "round_locked");
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "A" } });
  });

  // FIA-GPT-01: una petición sin base (pestaña de antes del despliegue) no
  // demuestra qué versión vio. Puede AGREGAR pronósticos que no existen, pero
  // nunca cambiar uno guardado: eso se rechaza (409 picks_reload_required),
  // sin escribir nada y sin éxito falso.
  itest("FIA-GPT-01 a · nueva y vieja: la pestaña nueva confirma B; la vieja (sin base) que arrastra A y elige otro partido no la pisa", async () => {
    const q = await withOpenRound("g01a");
    await putPicks(q, q.beto.id, { r1: { "r1-m1": "A" } });
    const fresh = await savePicks(q, q.beto, { r1: { "r1-m1": "B" } }, { r1: { "r1-m1": "A" } });
    assert.equal(fresh.status, 200);
    const old = await savePicks(q, q.beto, { r1: { "r1-m1": "A", "r1-m2": "D" } });
    assert.equal(old.status, 409, JSON.stringify(old.body));
    assert.deepEqual([old.body.error, old.body.reason], ["invalid_value", "picks_reload_required"], "un código que el cliente viejo muestra como «Recarga la página»");
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "B" } }, "el B confirmado sigue; nada se escribió");
  });

  itest("FIA-GPT-01 b · vieja y vieja: cada una agrega partidos nuevos; cambiar uno ya guardado exige recargar", async () => {
    const q = await withOpenRound("g01b");
    assert.equal((await savePicks(q, q.beto, { r1: { "r1-m1": "A" } })).status, 200);
    assert.equal((await savePicks(q, q.beto, { r1: { "r1-m2": "D" } })).status, 200, "la otra pestaña vieja agrega m2 sin borrar m1");
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "A", "r1-m2": "D" } });
    const change = await savePicks(q, q.beto, { r1: { "r1-m1": "B", "r1-m2": "D" } });
    assert.deepEqual([change.status, change.body.error, change.body.reason], [409, "invalid_value", "picks_reload_required"]);
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "A", "r1-m2": "D" } });
  });

  itest("FIA-GPT-01 c · vieja fuera de orden: el envío tardío con un valor distinto no pisa el que llegó antes", async () => {
    const q = await withOpenRound("g01c");
    assert.equal((await savePicks(q, q.beto, { r1: { "r1-m1": "B" } })).status, 200);
    const late = await savePicks(q, q.beto, { r1: { "r1-m1": "A" } });
    assert.deepEqual([late.status, late.body.error, late.body.reason], [409, "invalid_value", "picks_reload_required"]);
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "B" } });
  });

  itest("FIA-GPT-01 d · una pestaña vieja que sólo agrega (lo demás igual a lo guardado) sí guarda, sin borrar nada", async () => {
    const q = await withOpenRound("g01d");
    await putPicks(q, q.beto.id, { r1: { "r1-m1": "A", "r1-m2": "D" } });
    const add = await savePicks(q, q.beto, { r1: { "r1-m1": "A", "r1-m3": "B" } });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.deepEqual(await storedPicks(q, q.beto.id), { r1: { "r1-m1": "A", "r1-m2": "D", "r1-m3": "B" } });
  });

  // ---------------------------------------------------------------- AUD-02
  // Una jornada jugada (r1, resultados publicados) con pronósticos de los dos.
  async function playedTournament(tag, { penalty } = {}) {
    const q = await quiniela(tag);
    const m = await storedMeta(q);
    m.rounds = [{
      id: "r1", number: 1, deadline: inDays(-2), published: true, resultsPublished: true,
      results: { "r1-m1": "A", "r1-m2": "D", "r1-m3": "B" }, matches: matches("r1"),
    }];
    if (penalty) {
      m.paymentPenalty = { enabled: true, startsAtRound: 1, pointsPerRound: 2 };
      m.participants.find((p) => p.id === q.beto.id).penalizedRounds = { r1: 2 };
      m.participants.find((p) => p.id === q.ana.id).penalizedRounds = { r1: 0 };
    }
    await putMeta(q, m);
    await putPicks(q, q.beto.id, { r1: { "r1-m1": "A", "r1-m2": "D", "r1-m3": "A" } });
    await putPicks(q, q.ana.id, { r1: { "r1-m1": "B" } });
    return q;
  }
  const cycleOf = async (q) => (await call("GET", `/api/quinielas/${q.slug}/plan`, { headers: ownerHeaders(q) })).body.tournament.cycle;
  const snapshot = (q) => call("POST", `/api/quinielas/${q.slug}/admin-snapshot`, { headers: ownerHeaders(q), body: {} });
  const close = (q, body) => call("POST", `/api/quinielas/${q.slug}/tournament/close`, {
    headers: ownerHeaders(q), body: { closeIntentId: "it" + crypto.randomBytes(8).toString("hex"), ...body },
  });

  itest("AUD-02 a · una tabla vacía (la lectura de pronósticos falló) no cierra el torneo ni archiva un campeón", async () => {
    const q = await playedTournament("a02a");
    const before = await storedMeta(q);
    const r = await close(q, { expectedCycle: await cycleOf(q), standings: [] });
    assert.ok(r.status >= 400 && r.status < 500, "se rechaza: " + r.status + " " + JSON.stringify(r.body));
    const after = await storedMeta(q);
    assert.deepEqual(after.pastTournaments || [], before.pastTournaments || [], "nada se archiva");
    assert.equal(after.rounds.length, 1, "el tablero sigue");
  });

  itest("AUD-02 b · con la base completa y vigente se cierra, y el archivo coincide con lo guardado", async () => {
    const q = await playedTournament("a02b");
    const snap = await snapshot(q);
    assert.equal(snap.status, 200, JSON.stringify(snap.body));
    assert.equal(typeof snap.body.basis, "string");
    assert.deepEqual(Object.keys(snap.body.picks).sort(), [q.ana.id, q.beto.id].sort(), "trae a todos");
    const standings = [{ id: q.beto.id, name: "Beto", pts: 2 }, { id: q.ana.id, name: "Ana", pts: 0 }];
    const r = await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const archive = (await storedMeta(q)).pastTournaments.at(-1);
    assert.deepEqual(archive.champion, { name: "Beto", pts: 2 });
    assert.deepEqual(archive.standings.map((s) => s.name), ["Beto", "Ana"]);
  });

  itest("AUD-02 c · si los pronósticos o la meta cambian después de leer la base, no se cierra (409) y nada se archiva", async () => {
    const q = await playedTournament("a02c");
    const snap = await snapshot(q);
    await putPicks(q, q.ana.id, { r1: { "r1-m1": "A" } });
    const standings = [{ id: q.beto.id, name: "Beto", pts: 2 }, { id: q.ana.id, name: "Ana", pts: 0 }];
    const r = await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "close_basis_stale");
    assert.deepEqual((await storedMeta(q)).pastTournaments || [], []);
  });

  itest("AUD-02 d · una tabla que no lista exactamente a los participantes no se archiva", async () => {
    const q = await playedTournament("a02d");
    const snap = await snapshot(q);
    const r = await close(q, { expectedCycle: await cycleOf(q), standings: [{ id: q.beto.id, name: "Beto", pts: 2 }], basis: snap.body.basis });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "close_standings_incomplete");
    assert.deepEqual((await storedMeta(q)).pastTournaments || [], []);
  });

  itest("AUD-02 g · lo archivado usa los nombres guardados: una fila no se cae por un nombre raro y el campeón es el primero (Technical QA, H3)", async () => {
    const q = await playedTournament("a02g");
    const m = await storedMeta(q);
    m.participants.find((p) => p.id === q.beto.id).name = "   ";
    await putMeta(q, m);
    const snap = await snapshot(q);
    const standings = [{ id: q.beto.id, name: "   ", pts: 2 }, { id: q.ana.id, name: "Ana", pts: 0 }];
    const r = await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const archive = (await storedMeta(q)).pastTournaments.at(-1);
    assert.equal(archive.standings.length, 2, "nadie se cae");
    assert.deepEqual(archive.champion, { name: "Sin nombre", pts: 2 });
  });

  itest("AUD-02 e · una quiniela donde nadie pronosticó (carga vacía válida) sí se cierra", async () => {
    const q = await quiniela("a02e");
    const snap = await snapshot(q);
    assert.equal(snap.status, 200);
    const standings = (await storedMeta(q)).participants.map((p) => ({ id: p.id, name: p.name, pts: 0 }));
    const r = await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  itest("AUD-02 f · la base sólo la lee un admin: un participante no la obtiene", async () => {
    const q = await quiniela("a02f");
    const r = await call("POST", `/api/quinielas/${q.slug}/admin-snapshot`, { headers: pinHeaders(q.beto), body: {} });
    assert.equal(r.status, 403);
  });

  // ---------------------------------------------------------------- AUD-03
  itest("AUD-03 a · al cerrar, los descuentos del torneo se archivan con él y no quedan en el torneo nuevo", async () => {
    const q = await playedTournament("a03a", { penalty: true });
    const snap = await snapshot(q);
    const standings = [{ id: q.ana.id, name: "Ana", pts: 0 }, { id: q.beto.id, name: "Beto", pts: 0 }];
    assert.equal((await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis })).status, 200);
    const after = await storedMeta(q);
    const beto = after.participants.find((p) => p.id === q.beto.id);
    assert.deepEqual(beto.penalizedRounds || {}, {}, "el torneo nuevo empieza sin descuentos");
    assert.deepEqual(after.pastTournaments.at(-1).penalties, { [q.beto.id]: { r1: 2 }, [q.ana.id]: { r1: 0 } }, "el historial los conserva");
  });

  itest("AUD-03 b · una pestaña abierta antes del cierre no devuelve los descuentos archivados al torneo nuevo; los nuevos sí se guardan", async () => {
    const q = await playedTournament("a03b", { penalty: true });
    const stale = (await call("GET", kvPath(q.slug), { headers: ownerHeaders(q) })).body.value;
    const snap = await snapshot(q);
    const standings = [{ id: q.ana.id, name: "Ana", pts: 0 }, { id: q.beto.id, name: "Beto", pts: 0 }];
    assert.equal((await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis })).status, 200);
    // Torneo 2: una jornada nueva r2 y su descuento.
    const fresh = (await call("GET", kvPath(q.slug), { headers: ownerHeaders(q) })).body.value;
    fresh.participants.find((p) => p.id === q.beto.id).penalizedRounds = { r2: 2 };
    assert.equal((await call("POST", kvPath(q.slug), { headers: ownerHeaders(q), body: { value: fresh } })).status, 200);
    // La pestaña vieja guarda (trae r1:2 de antes del cierre).
    const wrote = await call("POST", kvPath(q.slug), { headers: ownerHeaders(q), body: { value: stale } });
    assert.ok(wrote.status < 500);
    const beto = (await storedMeta(q)).participants.find((p) => p.id === q.beto.id);
    assert.deepEqual(beto.penalizedRounds, { r2: 2 }, "sólo el descuento del torneo nuevo, una vez");
  });

  itest("AUD-03 c · una quiniela cerrada antes de la corrección: el descuento heredado sale del torneo en curso y pasa al historial (Product QA, H4)", async () => {
    const q = await quiniela("a03c");
    const m = await storedMeta(q);
    m.pastTournaments = [{ closedAt: inDays(-10), champion: null, standings: [], rounds: [{ id: "old1", number: 1 }], cycle: 1 }];
    m.rounds = [];
    m.participants.find((p) => p.id === q.beto.id).penalizedRounds = { old1: 2 };
    await putMeta(q, m);
    const view = (await call("GET", kvPath(q.slug), { headers: ownerHeaders(q) })).body.value;
    assert.equal((await call("POST", kvPath(q.slug), { headers: ownerHeaders(q), body: { value: view } })).status, 200);
    const after = await storedMeta(q);
    assert.deepEqual(after.participants.find((p) => p.id === q.beto.id).penalizedRounds, {});
    assert.deepEqual(after.pastTournaments[0].penalties, { [q.beto.id]: { old1: 2 } }, "se mueve al historial, no se tira");
  });

  itest("AUD-03 d · al historial sólo pasa lo que ya estaba guardado, nunca un valor que trae la petición", async () => {
    const q = await quiniela("a03d");
    const m = await storedMeta(q);
    m.pastTournaments = [{ closedAt: inDays(-10), champion: null, standings: [], rounds: [{ id: "old1", number: 1 }], cycle: 1 }];
    m.rounds = [];
    await putMeta(q, m);
    const view = (await call("GET", kvPath(q.slug), { headers: ownerHeaders(q) })).body.value;
    view.participants.find((p) => p.id === q.beto.id).penalizedRounds = { old1: 999 };
    assert.equal((await call("POST", kvPath(q.slug), { headers: ownerHeaders(q), body: { value: view } })).status, 200);
    const after = await storedMeta(q);
    assert.equal(after.pastTournaments[0].penalties, undefined, "el historial no acepta datos de la petición");
    assert.deepEqual(after.participants.find((p) => p.id === q.beto.id).penalizedRounds, {});
  });

  // FIA-GPT-03: el cierre archiva los descuentos que restaron en la tabla
  // final, también los que se calculaban en vivo (sin registro previo), una
  // sola vez y asociados a su torneo.
  itest("FIA-GPT-03 a · sin reconciliación previa: el cierre archiva el descuento que la tabla calculaba en vivo", async () => {
    const q = await playedTournament("g03a");
    const m = await storedMeta(q);
    m.paymentPenalty = { enabled: true, startsAtRound: 1, pointsPerRound: 2 };
    m.participants.forEach((p) => { p.paid = false; delete p.penalizedRounds; });
    await putMeta(q, m);
    const snap = await snapshot(q);
    const standings = [{ id: q.beto.id, name: "Beto", pts: 0 }, { id: q.ana.id, name: "Ana", pts: -2 }];
    assert.equal((await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis })).status, 200);
    const after = await storedMeta(q);
    assert.deepEqual(after.pastTournaments.at(-1).penalties, { [q.beto.id]: { r1: 2 }, [q.ana.id]: { r1: 2 } });
    after.participants.forEach((p) => assert.deepEqual(p.penalizedRounds || {}, {}, "el torneo nuevo empieza limpio"));
  });

  itest("FIA-GPT-03 b · exactamente una vez: lo registrado manda (exento 0 sigue en 0), quien pagó no tiene descuento en vivo, y un descuento de jornada borrada del torneo también se archiva", async () => {
    const q = await playedTournament("g03b");
    const m = await storedMeta(q);
    m.paymentPenalty = { enabled: true, startsAtRound: 1, pointsPerRound: 2 };
    const beto = m.participants.find((p) => p.id === q.beto.id), ana = m.participants.find((p) => p.id === q.ana.id);
    beto.paid = false; beto.penalizedRounds = { r1: 0, rx: 2 };       // r1 resuelto exento; rx, jornada borrada
    ana.paid = true; delete ana.penalizedRounds;
    m.rounds.push({ id: "r2", number: 2, deadline: inDays(-1), published: true, resultsPublished: false, results: {}, matches: matches("r2") });
    await putMeta(q, m);
    const snap = await snapshot(q);
    const standings = [{ id: q.ana.id, name: "Ana", pts: 0 }, { id: q.beto.id, name: "Beto", pts: -2 }];
    assert.equal((await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis })).status, 200);
    const arch = (await storedMeta(q)).pastTournaments.at(-1);
    assert.deepEqual(arch.penalties, { [q.beto.id]: { r1: 0, rx: 2, r2: 2 } }, "r1 como se registró, rx como se registró, r2 en vivo; Ana pagó");
  });

  itest("FIA-GPT-03 d · los descuentos se archivan a la hora de la lectura (standingsAt): una jornada que cierra después no agrega uno que la tabla no restó", async () => {
    const q = await playedTournament("g03d");
    const m = await storedMeta(q);
    m.paymentPenalty = { enabled: true, startsAtRound: 1, pointsPerRound: 2 };
    m.participants.forEach((p) => { p.paid = false; delete p.penalizedRounds; });
    const soon = new Date(Date.now() + 1500).toISOString();
    m.rounds.push({ id: "r2", number: 2, deadline: soon, published: true, resultsPublished: false, results: {}, matches: matches("r2") });
    await putMeta(q, m);
    const snap = await snapshot(q);                       // r2 todavía abierta
    await new Promise((r) => setTimeout(r, 2000));        // r2 cierra antes de confirmar
    const standings = [{ id: q.beto.id, name: "Beto", pts: 0 }, { id: q.ana.id, name: "Ana", pts: -2 }];
    assert.equal((await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis, standingsAt: snap.body.readAt })).status, 200);
    assert.deepEqual((await storedMeta(q)).pastTournaments.at(-1).penalties, { [q.beto.id]: { r1: 2 }, [q.ana.id]: { r1: 2 } }, "sin r2");
  });

  itest("FIA-GPT-03 c · penalización apagada: no restaba en la tabla, no se archiva como descuento, y el torneo nuevo empieza limpio", async () => {
    const q = await playedTournament("g03c", { penalty: true });
    const m = await storedMeta(q);
    m.paymentPenalty.enabled = false;
    await putMeta(q, m);
    const snap = await snapshot(q);
    const standings = [{ id: q.ana.id, name: "Ana", pts: 0 }, { id: q.beto.id, name: "Beto", pts: 0 }];
    assert.equal((await close(q, { expectedCycle: await cycleOf(q), standings, basis: snap.body.basis })).status, 200);
    const after = await storedMeta(q);
    assert.equal(after.pastTournaments.at(-1).penalties, undefined);
    after.participants.forEach((p) => assert.deepEqual(p.penalizedRounds || {}, {}));
  });

  // ---------------------------------------------------------------- AUD-04
  async function legacyWithPassword(tag) {
    const q = await quiniela(tag);
    const m = await storedMeta(q);
    delete m.creatorId;
    m.participants.find((p) => p.id === q.beto.id).isAdmin = true;
    await putMeta(q, m);
    assert.ok(m.settings.ownerPassword, "tiene contraseña de administrador");
    return q;
  }
  const rulesOf = (m) => ({ groupName: m.groupName, entryFee: m.settings.entryFee, points: m.settings.pointsPerCorrectPick });
  const writeAs = async (q, headers, mutate) => {
    const view = await call("GET", kvPath(q.slug), { headers });
    const value = view.body.value;
    mutate(value);
    return call("POST", kvPath(q.slug), { headers, body: { value } });
  };
  const changeRules = (m) => { m.groupName = "Otro nombre"; m.settings.entryFee = 999; m.settings.pointsPerCorrectPick = 7; };

  itest("AUD-04 a · sin creatorId y con contraseña: el PIN de un co-admin no cambia nombre, cuota ni puntos (y se le dice)", async () => {
    const q = await legacyWithPassword("a04a");
    const before = rulesOf(await storedMeta(q));
    const r = await writeAs(q, pinHeaders(q.beto), changeRules);
    assert.equal(r.status, 200, "el resto del guardado sigue funcionando");
    assert.equal(r.body.ruleFieldsKept, true);
    assert.deepEqual(rulesOf(await storedMeta(q)), before);
    assert.ok(!("creatorId" in (await storedMeta(q))), "no se infiere un creador");
  });

  itest("AUD-04 b · sin creatorId y con contraseña: con la contraseña sí se cambian; el co-admin con PIN sigue guardando jornadas", async () => {
    const q = await legacyWithPassword("a04b");
    const r = await writeAs(q, ownerHeaders(q), changeRules);
    assert.equal(r.status, 200);
    assert.deepEqual(rulesOf(await storedMeta(q)), { groupName: "Otro nombre", entryFee: 999, points: 7 });
    const round = await writeAs(q, pinHeaders(q.beto), (m) => { m.rounds.push({ id: "rx", number: 1, deadline: inDays(2), published: true, results: {}, resultsPublished: false, matches: matches("rx") }); });
    assert.equal(round.status, 200, JSON.stringify(round.body));
    assert.equal((await storedMeta(q)).rounds.length, 1);
  });

  itest("AUD-04 c · sin creatorId y sin contraseña: el admin con PIN sigue cambiando las reglas (como antes)", async () => {
    const q = await legacyWithPassword("a04c");
    const m = await storedMeta(q);
    delete m.settings.ownerPassword;
    await putMeta(q, m);
    const r = await writeAs(q, pinHeaders(q.beto), changeRules);
    assert.equal(r.status, 200);
    assert.deepEqual(rulesOf(await storedMeta(q)), { groupName: "Otro nombre", entryFee: 999, points: 7 });
  });
});
