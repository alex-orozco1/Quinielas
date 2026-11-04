// liguillaSprint.integration.test.js — sprint de liguilla en el SERVIDOR REAL
// con PostgreSQL (D1–D7):
//
//   pg_ctlcluster 16 main start
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/liguillaSprint.integration.test.js
//
// El paso del tiempo (que una jornada cierre) se simula moviendo su cierre en
// la base, como en betCloses.integration.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela } = require("./helpers/realServer");
const L = require("../liguillaScoring");

const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value, headers) => call("POST", kvPath(q.slug), { headers: headers || { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const picksPath = (q, pid) => "/api/kv/" + encodeURIComponent(`quiniela:${q.slug}:picks:${pid}`);
const storedPicks = async (q, pid) => {
  const r = await dbQuery("SELECT value FROM kv WHERE key = $1", [`quiniela:${q.slug}:picks:${pid}`]);
  return r.rows.length ? r.rows[0].value : null;
};
const beto = (q) => ({ "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id });
const anaPin = (q) => ({ "X-Qracks-Auth": q.ana.pin, "X-Qracks-Participant": q.ana.id });
const matchPick = (q, who, body) => call("POST", `/api/quinielas/${q.slug}/picks/${who.id}/match`, {
  headers: { "X-Qracks-Auth": who.pin, "X-Qracks-Participant": who.id }, body,
});
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const RULES = { capture: "score", resultPoints: 1, exactBonus: 1 };
const s = (a, b) => ({ a, b });

function liguillaRound(tag, over = {}) {
  return {
    id: "r_lg" + tag, number: 18, deadline: enHoras(48), results: {}, resultsPublished: false, published: false,
    stage: "liguilla", phase: { round: "quarter", leg: "ida", source: "admin" },
    matches: [
      { id: "m_lg" + tag + "1", teamA: "Club A", teamB: "Club B" },
      { id: "m_lg" + tag + "2", teamA: "Club C", teamB: "Club D" },
    ],
    ...over,
  };
}
// Una quiniela con reglas de liguilla y una jornada de liguilla en borrador.
async function conLiguilla(tag, { rules = RULES, round } = {}) {
  const q = await quiniela(tag);
  const v = await read(q);
  if (rules) v.settings.liguilla = rules;
  v.rounds = [round || liguillaRound(tag)];
  const r = await write(q, v);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return q;
}
async function publicar(q, roundId) {
  const v = await read(q);
  v.rounds.find((r) => r.id === roundId).published = true;
  return write(q, v);
}
// Simula que llegó el cierre: mueve el deadline al pasado, directo en la base.
async function cerrar(q, roundId) {
  const v = await stored(q);
  v.rounds.find((r) => r.id === roundId).deadline = new Date(Date.now() - 60e3).toISOString();
  await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
}

test.describe("liguilla en el servidor real", () => {
  test.before(setup);
  test.after(teardown);

  itest("D1 · no se publica liguilla sin reglas; con reglas se publica, se fija el candado y la jornada lleva su copia", async () => {
    const q = await conLiguilla("sinreglas", { rules: null });
    const r = await publicar(q, "r_lgsinreglas");
    assert.deepEqual([r.status, r.body.error], [409, "liguilla_rules_required"]);
    assert.equal((await stored(q)).rounds[0].published, false, "nada se publicó");

    const q2 = await conLiguilla("conreglas");
    const ok = await publicar(q2, "r_lgconreglas");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const st = await stored(q2);
    assert.deepEqual(st.rounds[0].scoring, RULES);
    assert.equal(st.liguillaLocks.length, 1);
    assert.deepEqual(st.liguillaLocks[0].rules, RULES);
  });

  itest("D1 · con candado: cambiar reglas 409; borrar la jornada no lo quita; el cliente no puede escribir el candado", async () => {
    const q = await conLiguilla("candado");
    assert.equal((await publicar(q, "r_lgcandado")).status, 200);
    const v = await read(q);
    v.settings.liguilla = { capture: "score", resultPoints: 1, exactBonus: 3 };
    assert.deepEqual([(await write(q, v)).status, (await write(q, v)).body.error], [409, "liguilla_rules_locked"]);

    const sinJornada = await read(q);
    sinJornada.rounds = [];
    sinJornada.liguillaLocks = [];
    assert.equal((await write(q, sinJornada)).status, 200);
    const st = await stored(q);
    assert.equal(st.rounds.length, 0);
    assert.equal(st.liguillaLocks.length, 1, "el candado sigue aunque la jornada ya no exista");
    const otra = await read(q);
    otra.settings.liguilla = { capture: "result", resultPoints: 3, exactBonus: 0 };
    assert.equal((await write(q, otra)).body.error, "liguilla_rules_locked");
  });

  itest("D1 · empezar torneo sin cerrar: el tablero se conserva con sus reglas; el torneo nuevo empieza sin candado", async () => {
    const q = await conLiguilla("ciclo");
    assert.equal((await publicar(q, "r_lgciclo")).status, 200);
    const idx = (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value;
    const entry = idx.quinielas.find((x) => x.slug === q.slug);
    const nc = await call("POST", `/api/quinielas/${q.slug}/tournament/new-cycle`, { headers: { "X-Qracks-Auth": q.owner }, body: { expectedCycle: entry.tournamentScope.editionSeq } });
    assert.equal(nc.status, 200, JSON.stringify(nc.body));
    const v = await read(q);
    assert.equal(v.rounds.length, 1, "empezar sin cerrar conserva el tablero");
    v.settings.liguilla = { capture: "result", resultPoints: 2, exactBonus: 0 };
    const r = await write(q, v);
    assert.equal(r.status, 200, "el torneo nuevo no tiene candado: " + JSON.stringify(r.body));
    const st = await stored(q);
    assert.deepEqual(st.rounds[0].scoring, RULES, "la jornada anterior conserva sus reglas");
  });

  itest("D1 · cerrar el torneo archiva y despeja el tablero (como antes); el siguiente empieza sin candado", async () => {
    const q = await conLiguilla("cierre");
    assert.equal((await publicar(q, "r_lgcierre")).status, 200);
    const idx = (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value;
    const entry = idx.quinielas.find((x) => x.slug === q.slug);
    const close = await call("POST", `/api/quinielas/${q.slug}/tournament/close`, {
      headers: { "X-Qracks-Auth": q.owner },
      body: { expectedCycle: entry.tournamentScope.editionSeq, closeIntentId: "lgclose" + Date.now().toString(36), standings: [] },
    });
    assert.equal(close.status, 200, JSON.stringify(close.body));
    const v = await read(q);
    assert.equal(v.rounds.length, 0, "cerrar despeja el tablero");
    assert.ok(Array.isArray(v.pastTournaments) && v.pastTournaments.length === 1, "y archiva");
    v.settings.liguilla = { capture: "result", resultPoints: 2, exactBonus: 0 };
    assert.equal((await write(q, v)).status, 200);
  });

  itest("D1 · el admin con PIN (sin contraseña) no cambia las reglas de liguilla: se conservan las guardadas", async () => {
    const q = await conLiguilla("pinadmin");
    const v = await read(q);
    v.settings.liguilla = { capture: "result", resultPoints: 5, exactBonus: 0 };
    const r = await write(q, v, anaPin(q));
    assert.equal(r.status, 200);
    assert.equal(r.body.ruleFieldsKept, true);
    assert.deepEqual((await stored(q)).settings.liguilla, RULES);
  });

  itest("D5/D6 · no se publica con rival por definir; una jornada publicada como regular no pasa a liguilla", async () => {
    const round = liguillaRound("rival");
    round.matches.push({ id: "m_lgrival3", teamA: "Club E", teamB: "" });
    const q = await conLiguilla("rival", { round });
    const r = await publicar(q, "r_lgrival");
    assert.deepEqual([r.status, r.body.error, r.body.pending], [409, "liguilla_rival_pending", 1]);
    const v = await read(q);
    v.rounds = [{ ...liguillaRound("reg"), stage: undefined, phase: undefined, published: true }];
    assert.equal((await write(q, v)).status, 200);
    const w = await read(q);
    w.rounds[0].stage = "liguilla";
    assert.equal((await write(q, w)).body.error, "liguilla_stage_locked");
  });

  itest("PRONÓSTICO · por partido: se confirma, se relee igual, otro partido no lo toca, formatos inválidos 400", async () => {
    const q = await conLiguilla("pick");
    assert.equal((await publicar(q, "r_lgpick")).status, 200);
    const r1 = await matchPick(q, q.beto, { roundId: "r_lgpick", matchId: "m_lgpick1", value: s(2, 1), expected: null });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual(r1.body.value, s(2, 1));
    const r2 = await matchPick(q, q.beto, { roundId: "r_lgpick", matchId: "m_lgpick2", value: s(0, 0), expected: null });
    assert.equal(r2.status, 200);
    const mine = await call("GET", picksPath(q, q.beto.id), { headers: beto(q) });
    assert.deepEqual(mine.body.value.r_lgpick, { m_lgpick1: "A", m_lgpick2: "D", __score: { m_lgpick1: s(2, 1), m_lgpick2: s(0, 0) } });
    for (const bad of [{ a: -1, b: 0 }, { a: 2.5, b: 1 }, { a: "2", b: 1 }, { a: 31, b: 0 }, { a: 1 }]) {
      const r = await matchPick(q, q.beto, { roundId: "r_lgpick", matchId: "m_lgpick1", value: bad, expected: s(2, 1) });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const other = await call("POST", `/api/quinielas/${q.slug}/picks/${q.beto.id}/match`, {
      headers: anaPin(q), body: { roundId: "r_lgpick", matchId: "m_lgpick1", value: s(5, 0), expected: s(2, 1) },
    });
    assert.equal(other.status, 403, "nadie guarda por otro");
  });

  itest("OTRA SESIÓN · el mismo partido guardado desde otra sesión: 409 con lo guardado; nada se pisa", async () => {
    const q = await conLiguilla("sesion");
    assert.equal((await publicar(q, "r_lgsesion")).status, 200);
    assert.equal((await matchPick(q, q.beto, { roundId: "r_lgsesion", matchId: "m_lgsesion1", value: s(1, 1), expected: null })).status, 200);
    const late = await matchPick(q, q.beto, { roundId: "r_lgsesion", matchId: "m_lgsesion1", value: s(3, 0), expected: null });
    assert.deepEqual([late.status, late.body.error, late.body.current], [409, "pick_conflict", s(1, 1)]);
    assert.deepEqual((await storedPicks(q, q.beto.id)).r_lgsesion.__score.m_lgsesion1, s(1, 1));
  });

  itest("PESTAÑA ANTIGUA · un documento entero que cambia la liguilla se rechaza; uno que no la toca pasa", async () => {
    const q = await conLiguilla("vieja");
    assert.equal((await publicar(q, "r_lgvieja")).status, 200);
    assert.equal((await matchPick(q, q.beto, { roundId: "r_lgvieja", matchId: "m_lgvieja1", value: s(2, 1), expected: null })).status, 200);
    const doc = await storedPicks(q, q.beto.id);
    const viejo = JSON.parse(JSON.stringify(doc));
    viejo.r_lgvieja.m_lgvieja1 = "B";                      // la pestaña antigua sólo conoce 1X2
    const r = await call("POST", picksPath(q, q.beto.id), { headers: beto(q), body: { value: viejo } });
    assert.deepEqual([r.status, r.body.error], [409, "liguilla_pick_conflict"]);
    assert.deepEqual(await storedPicks(q, q.beto.id), doc, "nada cambió");
    const igual = await call("POST", picksPath(q, q.beto.id), { headers: beto(q), body: { value: doc } });
    assert.equal(igual.status, 200);
  });

  itest("PRIVACIDAD · antes del cierre nadie más ve el marcador (lectura individual, en lote y admin); después, todos", async () => {
    const q = await conLiguilla("priv");
    assert.equal((await publicar(q, "r_lgpriv")).status, 200);
    assert.equal((await matchPick(q, q.beto, { roundId: "r_lgpriv", matchId: "m_lgpriv1", value: s(4, 2), expected: null })).status, 200);
    const asAdmin = await call("GET", picksPath(q, q.beto.id), { headers: { "X-Qracks-Auth": q.owner } });
    assert.ok(!JSON.stringify(asAdmin.body.value).includes("4"), "el admin sólo sabe que hay pronóstico: " + JSON.stringify(asAdmin.body.value));
    assert.equal(asAdmin.body.value.r_lgpriv.__score, true);
    const anon = await call("GET", picksPath(q, q.beto.id));
    assert.deepEqual(anon.body.value, {});
    const asAna = await call("GET", picksPath(q, q.beto.id), { headers: anaPin(q) });
    assert.ok(!JSON.stringify(asAna.body.value).includes("4"));
    const batch = await call("POST", "/api/picks-batch", { headers: { "X-Qracks-Auth": q.owner }, body: { metaKey: q.metaKey, participantIds: [q.beto.id] } });
    assert.ok(!JSON.stringify(batch.body.picks).includes("\"a\":4"), JSON.stringify(batch.body));
    const batchAnon = await call("POST", "/api/picks-batch", { body: { metaKey: q.metaKey, participantIds: [q.beto.id] } });
    assert.deepEqual(batchAnon.body.picks[q.beto.id], {});
    await cerrar(q, "r_lgpriv");
    const after = await call("GET", picksPath(q, q.beto.id));
    assert.deepEqual(after.body.value.r_lgpriv.__score.m_lgpriv1, s(4, 2), "tras el cierre lo ven todos, como hoy");
  });

  itest("CIERRE · tarde: round_locked con el último pronóstico aceptado; lo guardado no cambia", async () => {
    const q = await conLiguilla("tarde");
    assert.equal((await publicar(q, "r_lgtarde")).status, 200);
    assert.equal((await matchPick(q, q.beto, { roundId: "r_lgtarde", matchId: "m_lgtarde1", value: s(2, 1), expected: null })).status, 200);
    await cerrar(q, "r_lgtarde");
    const r = await matchPick(q, q.beto, { roundId: "r_lgtarde", matchId: "m_lgtarde1", value: s(3, 1), expected: s(2, 1) });
    assert.deepEqual([r.status, r.body.error, r.body.current], [403, "round_locked", s(2, 1)]);
    assert.deepEqual((await storedPicks(q, q.beto.id)).r_lgtarde.__score.m_lgtarde1, s(2, 1));
  });

  itest("ESTADOS · publicación parcial con aplazado; luego su resultado; luego anulado y vuelta: sin doble conteo", async () => {
    const q = await conLiguilla("estados");
    assert.equal((await publicar(q, "r_lgestados")).status, 200);
    await matchPick(q, q.beto, { roundId: "r_lgestados", matchId: "m_lgestados1", value: s(2, 1), expected: null });
    await matchPick(q, q.beto, { roundId: "r_lgestados", matchId: "m_lgestados2", value: s(1, 1), expected: null });
    await cerrar(q, "r_lgestados");
    const pub = async (patch) => {
      const v = await read(q);
      Object.assign(v.rounds[0], { resultsPublished: true }, patch);
      return write(q, v);
    };
    const total = async () => {
      const st = await stored(q);
      return L.scoreRound(st.rounds[0], (await storedPicks(q, q.beto.id)).r_lgestados).total;
    };
    const hueco = await pub({ results: { m_lgestados1: "A" }, scores: { m_lgestados1: s(2, 1) } });
    assert.deepEqual([hueco.status, hueco.body.error], [400, "incomplete_results"], "un hueco sin estado no se publica");
    assert.equal((await pub({ results: { m_lgestados1: "A" }, scores: { m_lgestados1: s(2, 1) }, matchStatus: { m_lgestados2: "postponed" } })).status, 200);
    assert.equal(await total(), 2);
    const full = { results: { m_lgestados1: "A", m_lgestados2: "D" }, scores: { m_lgestados1: s(2, 1), m_lgestados2: s(1, 1) }, matchStatus: {} };
    assert.equal((await pub(full)).status, 200);
    assert.equal(await total(), 4);
    assert.equal((await pub({ results: { m_lgestados1: "A" }, scores: { m_lgestados1: s(2, 1) }, matchStatus: { m_lgestados2: "void" } })).status, 200);
    assert.equal(await total(), 2);
    assert.equal((await pub(full)).status, 200);
    assert.equal(await total(), 4, "anulado → resultado vuelve a 4, no a 6");
    const mal = await pub({ results: { m_lgestados1: "B", m_lgestados2: "D" }, scores: { m_lgestados1: s(2, 1), m_lgestados2: s(1, 1) } });
    assert.equal(mal.body.error, "liguilla_result_mismatch", "el 1X2 sale del marcador también en resultados");
  });

  itest("FASE REGULAR · los pronósticos 1X2 por la vía de siempre siguen igual", async () => {
    const q = await quiniela("regular");
    const v = await read(q);
    v.rounds = [{ id: "r_reg1", number: 1, deadline: enHoras(24), results: {}, resultsPublished: false, published: true, matches: [{ id: "m_reg1", teamA: "León", teamB: "Santos" }] }];
    assert.equal((await write(q, v)).status, 200);
    const r = await call("POST", picksPath(q, q.beto.id), { headers: beto(q), body: { value: { r_reg1: { m_reg1: "A" } } } });
    assert.equal(r.status, 200);
    const viaMatch = await matchPick(q, q.beto, { roundId: "r_reg1", matchId: "m_reg1", value: "B", expected: "A" });
    assert.equal(viaMatch.body.error, "not_liguilla");
  });

  itest("QA P1 · retirar y republicar una jornada de liguilla cerrada no la reabre; recrearla regular tampoco", async () => {
    const q = await conLiguilla("retirar");
    assert.equal((await publicar(q, "r_lgretirar")).status, 200);
    assert.equal((await matchPick(q, q.beto, { roundId: "r_lgretirar", matchId: "m_lgretirar1", value: s(1, 0), expected: null })).status, 200);
    await cerrar(q, "r_lgretirar");
    const st = await stored(q);
    st.liguillaPublished.r_lgretirar.deadline = st.rounds[0].deadline;   // el cierre ya pasó, también en el registro
    await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(st)]);
    const v = await read(q);
    v.rounds[0].published = false;
    assert.deepEqual([(await write(q, v)).status, (await write(q, v)).body.error], [409, "liguilla_unpublish_blocked"]);
    const w = await read(q);
    w.rounds = [];
    assert.equal((await write(q, w)).status, 200, "borrarla sigue permitido");
    const x = await read(q);
    x.rounds = [{ ...liguillaRound("retirar"), published: true, deadline: enHoras(48), stage: undefined, phase: undefined }];
    assert.equal((await write(q, x)).body.error, "liguilla_stage_locked");
    x.rounds[0].stage = "liguilla";
    assert.equal((await write(q, x)).body.error, "liguilla_round_closed");
    const late = await matchPick(q, q.beto, { roundId: "r_lgretirar", matchId: "m_lgretirar1", value: s(3, 3), expected: s(1, 0) });
    assert.notEqual(late.status, 200);
  });

  itest("QA P2 · los borradores de resultados (marcadores y estados) no se ven sin ser admin", async () => {
    const q = await conLiguilla("borr");
    assert.equal((await publicar(q, "r_lgborr")).status, 200);
    const v = await read(q);
    v.rounds[0].draftScores = { m_lgborr1: s(2, 0) }; v.rounds[0].draftMatchStatus = { m_lgborr2: "void" };
    assert.equal((await write(q, v)).status, 200);
    for (const headers of [beto(q), {}]) {
      const r = (await call("GET", kvPath(q.slug), { headers })).body.value.rounds[0];
      assert.equal(r.draftScores, undefined);
      assert.equal(r.draftMatchStatus, undefined);
    }
  });

  itest("PENDIENTES · colocar un partido pendiente sólo en un borrador; nada publicado se toca", async () => {
    const q = await conLiguilla("colocar");
    const v = await stored(q);
    v.stagedFixtures = [{ providerFixtureId: "9001", provider: "thesportsdb", kickoffAt: enHoras(50), home: { id: "h", name: "Club X" }, away: { id: "a", name: "Club Y" } }];
    await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
    const anon = await call("POST", `/api/quinielas/${q.slug}/staged/place`, { body: { identityKey: "thesportsdb|9001", roundId: "r_lgcolocar" } });
    assert.equal(anon.status, 403);
    const ok = await call("POST", `/api/quinielas/${q.slug}/staged/place`, { headers: { "X-Qracks-Auth": q.owner }, body: { identityKey: "thesportsdb|9001", roundId: "r_lgcolocar" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const st = await stored(q);
    assert.equal(st.stagedFixtures.length, 0);
    assert.ok(st.rounds[0].matches.some((m) => m.externalEventId === "9001" && m.teamA === "Club X"));
    assert.equal((await publicar(q, "r_lgcolocar")).status, 200);
    const st2 = await stored(q);
    st2.stagedFixtures = [{ providerFixtureId: "9002", provider: "thesportsdb", kickoffAt: enHoras(50), home: { id: "h2", name: "Club Z" }, away: { id: "a2", name: "Club W" } }];
    await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(st2)]);
    const pub = await call("POST", `/api/quinielas/${q.slug}/staged/place`, { headers: { "X-Qracks-Auth": q.owner }, body: { identityKey: "thesportsdb|9002", roundId: "r_lgcolocar" } });
    assert.deepEqual([pub.status, pub.body.error], [409, "round_not_draft"]);
  });
});
