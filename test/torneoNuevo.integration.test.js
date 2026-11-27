// torneoNuevo.integration.test.js — P1 · empezar un torneo nuevo deja el
// tablero VACÍO, en el SERVIDOR REAL con PostgreSQL.
//
//   pg_ctlcluster 16 main start
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/torneoNuevo.integration.test.js
//
// Cerrar ("closed") y empezar sin cierre formal ("interrupted") son la misma
// operación atómica: archivo + tablero vacío + pronósticos borrados + pagos,
// descuentos y preguntas reiniciados + reglas de liguilla archivadas +
// competencia a confirmar + ciclo nuevo. Un interrumpido nunca tiene campeón.
const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela, closeWithSnapshot } = require("./helpers/realServer");

const own = (q) => ({ "X-Qracks-Auth": q.owner });
const read = async (q) => (await call("GET", kvPath(q.slug), { headers: own(q) })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: own(q), body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const picksRows = async (q) => Number((await dbQuery("SELECT count(*) FROM kv WHERE key LIKE $1", [`quiniela:${q.slug}:picks:%`])).rows[0].count);
const entryOf = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value.quinielas.find((x) => x.slug === q.slug);
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const RULES = { capture: "score", resultPoints: 1, exactBonus: 1 };
const intentId = (t) => t + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pickAs = (q, who, value) => call("POST", "/api/kv/" + encodeURIComponent(`quiniela:${q.slug}:picks:${who.id}`), {
  headers: { "X-Qracks-Auth": who.pin, "X-Qracks-Participant": who.id }, body: { value },
});

// Torneo jugado: r1 regular publicada con resultados (Beto acertó), r2 publicada
// abierta, r3 borrador; partidos pendientes de colocar; Beto pagó; descuentos.
async function jugado(tag, { league = null, liguilla = false } = {}) {
  const q = await quiniela(tag, league ? { league } : {});
  let v = await read(q);
  v.rounds = [
    { id: "r1", number: 1, deadline: enHoras(24), results: {}, resultsPublished: false, published: true, matches: [{ id: "m1", teamA: "León", teamB: "Santos" }] },
    { id: "r2", number: 2, deadline: enHoras(48), results: {}, resultsPublished: false, published: true, matches: [{ id: "m2", teamA: "Pumas", teamB: "Toluca" }] },
    { id: "r3", number: 3, deadline: enHoras(72), results: {}, resultsPublished: false, published: false, matches: [{ id: "m3", teamA: "Atlas", teamB: "Chivas" }] },
  ];
  if (liguilla) {
    v.settings.liguilla = { ...RULES };
    v.rounds.push({ id: "q1", number: 18, deadline: enHoras(96), results: {}, resultsPublished: false, published: false, stage: "liguilla",
      phase: { round: "quarter", leg: "ida", source: "admin" }, matches: [{ id: "x1", teamA: "Club A", teamB: "Club B" }] });
  }
  assert.equal((await write(q, v)).status, 200);
  if (liguilla) {
    v = await read(q); v.rounds.find((r) => r.id === "q1").published = true;
    const p = await write(q, v); assert.equal(p.status, 200, JSON.stringify(p.body));
  }
  assert.equal((await pickAs(q, q.beto, { r1: { m1: "A" }, r2: { m2: "D" } })).status, 200);
  // r1 cierra y se publican sus resultados; Beto pagó; partidos pendientes.
  const st = await stored(q);
  st.rounds.find((r) => r.id === "r1").deadline = new Date(Date.now() - 60e3).toISOString();
  st.stagedFixtures = [{ providerFixtureId: "f9", teamA: "X", teamB: "Y", kickoffAt: enHoras(200) }];
  await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(st)]);
  v = await read(q);
  Object.assign(v.rounds.find((r) => r.id === "r1"), { results: { m1: "A" }, resultsPublished: true });
  v.participants.find((p) => p.id === q.beto.id).paid = true;
  const w = await write(q, v); assert.equal(w.status, 200, JSON.stringify(w.body));
  return q;
}
const standingsOf = (st, q) => [{ id: q.beto.id, name: "Beto", pts: 1 }, { id: st.participants.find((p) => p.id !== q.beto.id).id, name: "Ana", pts: 0 }];
async function terminar(q, kind, extra = {}) {
  const e = await entryOf(q);
  return closeWithSnapshot(q.slug, own(q), {
    expectedCycle: e.tournamentScope.editionSeq, closeIntentId: extra.closeIntentId || intentId(kind),
    // Sin tabla explícita, el helper la arma como la pantalla (standings.js).
    interrupt: kind === "interrupted", standings: extra.standings, ...extra.body,
  });
}
// Lo que tiene que quedar SIEMPRE al empezar un torneo nuevo.
async function tableroVacio(q, cycleBefore) {
  const st = await stored(q);
  assert.deepEqual(st.rounds, [], "cero jornadas activas (también borradores)");
  assert.deepEqual(st.stagedFixtures, [], "sin partidos pendientes de colocar");
  assert.equal(await picksRows(q), 0, "pronósticos individuales reiniciados");
  assert.ok(st.participants.length >= 2 && st.participants.every((p) => p.paid === false), "participantes conservados; nadie pagado");
  assert.ok(st.participants.every((p) => !p.penalizedRounds || Object.keys(p.penalizedRounds).length === 0), "descuentos reiniciados");
  assert.deepEqual(st.customBets || [], [], "preguntas extra reiniciadas");
  assert.equal(st.settings.liguilla, undefined, "liguilla sin configurar");
  assert.equal(st.settings.sportsdbLeagueId, undefined, "competencia por confirmar");
  const e = await entryOf(q);
  assert.equal(e.tournamentScope.editionSeq, cycleBefore + 1, "un solo ciclo nuevo");
  assert.equal(e.entitlement.plan, "FREE", "el plan anterior no se transfiere");
  return st;
}

test.describe("P1 · torneo nuevo con el tablero vacío (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("Liga MX con liguilla → interrumpido → torneo nuevo de Premier: sin campeón, tabla al interrumpir, nada activo", async () => {
    const q = await jugado("tn-lmx", { league: "4350", liguilla: true });
    const c0 = (await entryOf(q)).tournamentScope.editionSeq;
    assert.equal(await picksRows(q), 1);
    const r = await terminar(q, "interrupted");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.kind, r.body.champion], ["interrupted", null]);
    const st = await tableroVacio(q, c0);
    assert.equal(st.pastTournaments.length, 1);
    const past = st.pastTournaments[0];
    assert.equal(past.kind, "interrupted");
    assert.equal(past.champion, null, "nunca un campeón inventado");
    assert.equal(past.standings, null, "nunca tabla final");
    assert.deepEqual(past.interruptedStandings.map((x) => [x.name, x.pts]), [["Beto", 1], ["Ana", 0]], "tabla al interrumpir");
    assert.ok(Date.parse(past.interruptedAt) > Date.now() - 120e3, "fecha de interrupción");
    assert.deepEqual(past.rounds.map((x) => x.id).sort(), ["q1", "r1", "r2"], "publicadas al historial; el borrador no");
    assert.deepEqual(past.rounds.find((x) => x.id === "r1").results, { m1: "A" }, "con sus resultados");
    assert.deepEqual(past.liguillaRules, RULES, "reglas de liguilla con su torneo");
    assert.equal(st.liguillaLocks.length, 1, "el candado anterior queda asociado a su ciclo");
    assert.equal(st.settings.previousCompetition.sportsdbLeagueId, "4350", "la competencia anterior, como sugerencia");
    // El organizador elige Premier: permitido aunque el anterior tuvo liguilla.
    const v = await read(q);
    v.settings.sportsdbLeagueId = "4328"; delete v.settings.previousCompetition;
    const w = await write(q, v);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal((await stored(q)).settings.sportsdbLeagueId, "4328");
    // Participantes y anónimos leen el historial.
    const asBeto = (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id } })).body.value;
    assert.equal(asBeto.pastTournaments[0].kind, "interrupted");
    assert.equal(asBeto.pastTournaments[0].rounds.length, 3);
  });

  itest("torneo regular cerrado formalmente → campeón y tabla final; el torneo nuevo puede ser Liga MX con liguilla", async () => {
    const q = await jugado("tn-reg");
    const c0 = (await entryOf(q)).tournamentScope.editionSeq;
    const r = await terminar(q, "closed");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.kind, r.body.champion], ["closed", { name: "Beto", pts: 1 }]);
    const st = await tableroVacio(q, c0);
    const past = st.pastTournaments[0];
    assert.deepEqual([past.kind, past.champion, past.standings.length], ["closed", { name: "Beto", pts: 1 }, 2]);
    assert.equal(past.interruptedStandings, undefined);
    assert.equal(st.settings.previousCompetition, undefined, "sin competencia anterior, no hay sugerencia");
    let v = await read(q);
    v.settings.sportsdbLeagueId = "4350";
    assert.equal((await write(q, v)).status, 200);
    v = await read(q);
    v.settings.liguilla = { ...RULES };
    v.rounds = [{ id: "n1", number: 18, deadline: enHoras(24), results: {}, resultsPublished: false, published: true, stage: "liguilla",
      phase: { round: "quarter", leg: "ida", source: "admin" }, matches: [{ id: "nm1", teamA: "A", teamB: "B" }] }];
    const w = await write(q, v);
    assert.equal(w.status, 200, JSON.stringify(w.body));
  });

  itest("interrumpido sin actividad: no se crea una entrada vacía; igual queda el tablero vacío", async () => {
    const q = await quiniela("tn-vacio");
    let v = await read(q);
    v.rounds = [{ id: "d1", number: 1, deadline: enHoras(24), results: {}, resultsPublished: false, published: false, matches: [{ id: "dm", teamA: "A", teamB: "B" }] }];
    assert.equal((await write(q, v)).status, 200);
    const c0 = (await entryOf(q)).tournamentScope.editionSeq;
    const r = await terminar(q, "interrupted");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await tableroVacio(q, c0);
    assert.equal((st.pastTournaments || []).length, 0, "sin entrada vacía en el historial");
  });

  itest("dos pestañas a la vez y reintentos: un solo torneo nuevo, un solo archivo; la misma intención responde lo mismo", async () => {
    const q = await jugado("tn-conc");
    const c0 = (await entryOf(q)).tournamentScope.editionSeq;
    const [a, b] = await Promise.all([terminar(q, "interrupted"), terminar(q, "interrupted")]);
    const statuses = [a.status, b.status].sort();
    assert.ok(statuses[0] === 200 && (statuses[1] === 409 || statuses[1] === 400), JSON.stringify([a.body, b.body]));
    const st = await stored(q);
    assert.equal(st.pastTournaments.length, 1, "un solo archivo");
    assert.equal((await entryOf(q)).tournamentScope.editionSeq, c0 + 1, "un solo ciclo");
    // La respuesta perdida: la misma intención otra vez → lo que pasó, sin otro torneo.
    const id = intentId("replay");
    const q2 = await jugado("tn-replay");
    const c2 = (await entryOf(q2)).tournamentScope.editionSeq;
    const first = await terminar(q2, "interrupted", { closeIntentId: id });
    assert.equal(first.status, 200);
    const again = await call("POST", `/api/quinielas/${q2.slug}/tournament/new-cycle`, { headers: own(q2), body: { expectedCycle: c2, closeIntentId: id, standings: [], basis: "0".repeat(64) } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.replayed, again.body.kind], [true, "interrupted"]);
    assert.equal((await entryOf(q2)).tournamentScope.editionSeq, c2 + 1, "no se creó otro");
    assert.equal((await stored(q2)).pastTournaments.length, 1);
  });

  itest("si la validación falla, no se borra nada ni se avanza: tabla vieja, incompleta, sin huella o cliente anterior", async () => {
    const q = await jugado("tn-fail");
    const e = await entryOf(q);
    const c0 = e.tournamentScope.editionSeq;
    // Cliente con la versión anterior: sólo expectedCycle.
    const old = await call("POST", `/api/quinielas/${q.slug}/tournament/new-cycle`, { headers: own(q), body: { expectedCycle: c0 } });
    assert.deepEqual([old.status, old.body.error], [400, "invalid_close_intent"]);
    // Sin huella.
    const nob = await call("POST", `/api/quinielas/${q.slug}/tournament/new-cycle`, { headers: own(q), body: { expectedCycle: c0, closeIntentId: intentId("nob"), standings: [] } });
    assert.deepEqual([nob.status, nob.body.error], [400, "close_basis_required"]);
    // Tabla incompleta.
    const inc = await terminar(q, "interrupted", { standings: [{ id: q.beto.id, name: "Beto", pts: 1 }] });
    assert.deepEqual([inc.status, inc.body.error], [400, "close_standings_incomplete"]);
    // Huella vieja: algo cambió entre la lectura y el envío.
    const snap = await call("POST", `/api/quinielas/${q.slug}/admin-snapshot`, { headers: own(q), body: {} });
    const chg = await read(q);
    chg.participants.find((p) => p.id === q.beto.id).paid = false;   // un pago cambia la huella
    assert.equal((await write(q, chg)).status, 200);
    const stale = await call("POST", `/api/quinielas/${q.slug}/tournament/new-cycle`, { headers: own(q),
      body: { expectedCycle: c0, closeIntentId: intentId("stale"), standings: standingsOf(await stored(q), q), basis: snap.body.basis } });
    assert.deepEqual([stale.status, stale.body.error], [409, "close_basis_stale"]);
    const after = await stored(q);
    assert.equal(after.rounds.length, 3, "nada se archivó ni se vació");
    assert.equal((after.pastTournaments || []).length, 0);
    assert.equal(await picksRows(q), 1, "ningún pronóstico se borró");
    assert.equal((await entryOf(q)).tournamentScope.editionSeq, c0, "el torneo no avanzó");
  });

  itest("una pestaña del torneo anterior no repone jornadas, competencia ni reglas de liguilla", async () => {
    // Con jornadas, la pestaña vieja ya choca con rounds_conflict y no escribe.
    const q = await jugado("tn-stale", { league: "4350", liguilla: true });
    const pre = await read(q);
    assert.equal((await terminar(q, "interrupted")).status, 200);
    pre.groupName = "Desde la pestaña vieja";
    const w = await write(q, pre);
    assert.deepEqual([w.status, w.body.error], [409, "rounds_conflict"]);
    // Sin jornadas (el tablero ya estaba vacío) su guardado SÍ pasa: lo de la
    // competencia y la liguilla lo decide lo guardado, no esa pestaña.
    const q2 = await quiniela("tn-stale2", { league: "4350" });
    let v = await read(q2);
    v.settings.liguilla = { ...RULES };
    assert.equal((await write(q2, v)).status, 200);
    const pre2 = await read(q2);
    assert.equal((await terminar(q2, "interrupted")).status, 200);
    pre2.groupName = "Desde la pestaña vieja";
    const w2 = await write(q2, pre2);
    assert.equal(w2.status, 200, JSON.stringify(w2.body));
    const st = await stored(q2);
    assert.equal(st.groupName, "Desde la pestaña vieja", "el resto del guardado sí aplica");
    assert.deepEqual(st.rounds, []);
    assert.equal(st.settings.sportsdbLeagueId, undefined, "la competencia sigue por confirmar");
    assert.equal(st.settings.liguilla, undefined, "las reglas archivadas no vuelven");
    assert.equal(st.settings.previousCompetition.sportsdbLeagueId, "4350");
  });

  itest("Technical QA P1: sólo la contraseña de administrador termina el torneo; un PIN de admin (co-admin o creadora) no", async () => {
    const q = await jugado("tn-pin");
    let v = await read(q);
    v.participants.find((p) => p.id === q.beto.id).isAdmin = true;   // Beto co-admin
    assert.equal((await write(q, v)).status, 200);
    const c0 = (await entryOf(q)).tournamentScope.editionSeq;
    const before = JSON.stringify(await stored(q));
    const st = await stored(q);
    for (const [name, headers] of [
      ["PIN del co-admin", { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id }],
      ["PIN de la creadora", { "X-Qracks-Auth": q.ana.pin, "X-Qracks-Participant": q.ana.id }],
    ]) {
      for (const interrupt of [true, false]) {
        const r = await closeWithSnapshot(q.slug, headers, { expectedCycle: c0, closeIntentId: intentId("pin"), interrupt, standings: standingsOf(st, q) });
        assert.deepEqual([r.status, r.body.error], [403, "tournament_owner_password_required"], name + " " + JSON.stringify(r.body));
      }
    }
    assert.equal(JSON.stringify(await stored(q)), before, "nada cambió");
    assert.equal(await picksRows(q), 1, "ningún pronóstico se borró");
    assert.equal((await entryOf(q)).tournamentScope.editionSeq, c0);
    const ok = await terminar(q, "interrupted");
    assert.equal(ok.status, 200, "con la contraseña de administrador sí: " + JSON.stringify(ok.body));
  });

  itest("Technical QA P2: una tabla con puntos que no salen de los pronósticos se rechaza y no se borra nada", async () => {
    const q = await jugado("tn-tabla");
    const st = await stored(q);
    const c0 = (await entryOf(q)).tournamentScope.editionSeq;
    const ana = st.participants.find((p) => p.id !== q.beto.id);
    for (const interrupt of [true, false]) {
      const r = await closeWithSnapshot(q.slug, own(q), { expectedCycle: c0, closeIntentId: intentId("forge"), interrupt,
        standings: [{ id: ana.id, name: "Ana", pts: 999 }, { id: q.beto.id, name: "Beto", pts: 0 }] });
      assert.deepEqual([r.status, r.body.error], [409, "close_standings_mismatch"], JSON.stringify(r.body));
    }
    assert.equal(await picksRows(q), 1, "ningún pronóstico se borró");
    assert.equal((await stored(q)).rounds.length, 3);
    assert.equal((await entryOf(q)).tournamentScope.editionSeq, c0);
    // La tabla verdadera (la de standings.js) sí pasa y queda archivada.
    const ok = await terminar(q, "closed", { standings: [{ id: q.beto.id, name: "Beto", pts: 1 }, { id: ana.id, name: "Ana", pts: 0 }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.champion, { name: "Beto", pts: 1 });
  });

  itest("Technical QA P2 (587d1d8): jornada con resultados y cierre en el futuro → error que la nombra, nada cambia; con la fecha corregida, se cierra", async () => {
    const q = await jugado("tn-open");
    // Datos antiguos: r1 con resultados publicados, y su cierre vuelve al futuro.
    const m = await stored(q);
    m.rounds.find((r) => r.id === "r1").deadline = enHoras(240);
    await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(m)]);
    const c0 = (await entryOf(q)).tournamentScope.editionSeq;
    for (const kind of ["interrupted", "closed"]) {
      const r = await terminar(q, kind);
      assert.deepEqual([r.status, r.body.error, r.body.roundNumber], [409, "close_round_results_open", 1], JSON.stringify(r.body));
    }
    assert.equal(await picksRows(q), 1, "ningún pronóstico se borró");
    assert.equal((await stored(q)).rounds.length, 3);
    assert.equal((await entryOf(q)).tournamentScope.editionSeq, c0);
    // La salida que indica el mensaje (Technical QA P2 de db5bb9f): el
    // organizador edita esa jornada y le pone un cierre que ya pasó — por la
    // API normal, como el editor de Jornadas (que lo permite con resultados).
    const v2 = await read(q);
    v2.rounds.find((r) => r.id === "r1").deadline = new Date(Date.now() - 60e3).toISOString();
    const moved = await write(q, v2);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const ok = await terminar(q, "closed");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.champion, { name: "Beto", pts: 1 });
  });

  itest("Product: la regla de descuentos por no pagar NO pasa al torneo nuevo; queda en el archivo con sus descuentos", async () => {
    for (const kind of ["interrupted", "closed"]) {
      const q = await jugado("tn-pen-" + kind[0]);
      // Regla activa desde la Jornada 1, 2 puntos; Ana no ha pagado y ya tiene un descuento registrado.
      const m = await stored(q);
      m.paymentPenalty = { enabled: true, startsAtRound: 1, pointsPerRound: 2 };
      const ana = m.participants.find((p) => p.id !== q.beto.id);
      ana.penalizedRounds = { r1: 2 };
      await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(m)]);
      const r = await terminar(q, kind);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const st = await stored(q);
      assert.equal(st.paymentPenalty, undefined, "el torneo nuevo empieza sin regla de descuentos (desactivada, sin puntos)");
      assert.ok(st.participants.every((p) => !p.penalizedRounds || Object.keys(p.penalizedRounds).length === 0), "sin descuentos acumulados");
      const past = st.pastTournaments[0];
      assert.deepEqual(past.paymentPenaltyRules, { enabled: true, startsAtRound: 1, pointsPerRound: 2 }, "la regla queda en el archivo");
      assert.equal(past.penalties[ana.id].r1, 2, "y los descuentos históricos también");
      // Un guardado normal del organizador no la revive sola: hay que configurarla otra vez.
      const v = await read(q);
      v.groupName = "Otra";
      assert.equal((await write(q, v)).status, 200);
      assert.equal((await stored(q)).paymentPenalty, undefined);
    }
  });

  itest("Product: el cierre formal sin resultados publicados se bloquea; «sin cierre formal» sí funciona", async () => {
    const q = await quiniela("tn-nores");
    let v = await read(q);
    v.rounds = [{ id: "p1", number: 1, deadline: enHoras(24), results: {}, resultsPublished: false, published: true, matches: [{ id: "pm", teamA: "A", teamB: "B" }] }];
    assert.equal((await write(q, v)).status, 200);
    const c0 = (await entryOf(q)).tournamentScope.editionSeq;
    const r = await terminar(q, "closed");
    assert.deepEqual([r.status, r.body.error], [409, "close_requires_results"], JSON.stringify(r.body));
    assert.equal((await entryOf(q)).tournamentScope.editionSeq, c0, "no avanzó");
    assert.equal((await stored(q)).rounds.length, 1, "nada se archivó ni se vació");
    const ok = await terminar(q, "interrupted");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const st = await stored(q);
    assert.deepEqual([st.rounds.length, st.pastTournaments[0].kind, st.pastTournaments[0].champion], [0, "interrupted", null]);
  });
});
