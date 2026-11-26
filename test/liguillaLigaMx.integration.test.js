// liguillaLigaMx.integration.test.js — HOTFIX: liguilla sólo en Liga MX, en el
// SERVIDOR REAL con PostgreSQL (API directa, sin la interfaz).
//
//   pg_ctlcluster 16 main start
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/liguillaLigaMx.integration.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela } = require("./helpers/realServer");

const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value, headers) => call("POST", kvPath(q.slug), { headers: headers || { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const putStored = (q, v) => dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const RULES = { capture: "score", resultPoints: 1, exactBonus: 1 };
const LMX = "4350", PREMIER = "4328";
const regular = (id, n) => ({ id, number: n, deadline: enHoras(24), results: {}, resultsPublished: false, published: true, matches: [{ id: "m" + id, teamA: "León", teamB: "Santos" }] });
const lg = (id, n, over = {}) => ({
  id, number: n, deadline: enHoras(48), results: {}, resultsPublished: false, published: false,
  stage: "liguilla", phase: { round: "quarter", leg: "ida", source: "admin" },
  matches: [{ id: id + "_1", teamA: "Club A", teamB: "Club B" }, { id: id + "_2", teamA: "Club C", teamB: "Club D" }], ...over,
});
const correct = (q, rules) => call("POST", `/api/quinielas/${q.slug}/liguilla/rules`, { headers: { "X-Qracks-Auth": q.owner }, body: { expected: { resultPoints: 1, exactBonus: 1 }, rules } });
const errOf = (r) => [r.status, r.body && r.body.error];

test.describe("HOTFIX · liguilla sólo en Liga MX (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  for (const [name, league] of [["Premier League", PREMIER], ["LaLiga", "4335"], ["sin competencia", null]]) {
    itest(`${name}: la API rechaza reglas, jornadas, publicación y corrección de liguilla; la fase regular sigue`, async () => {
      const q = await quiniela("lmx-" + (league || "none"), league ? { league } : {});
      const antes = JSON.stringify(await stored(q));
      let v = await read(q);
      v.settings.liguilla = { ...RULES };
      assert.deepEqual(errOf(await write(q, v)), [409, "liguilla_not_available"], "reglas");
      v = await read(q);
      v.rounds = [lg("q1", 18)];
      assert.deepEqual(errOf(await write(q, v)), [409, "liguilla_not_available"], "borrador de liguilla");
      v = await read(q);
      v.rounds = [lg("q1", 18, { published: true })];
      v.liguillaLocks = [{ scopeId: "x", rules: RULES }];
      assert.deepEqual(errOf(await write(q, v)), [409, "liguilla_not_available"], "publicar con candado inventado");
      assert.deepEqual(errOf(await correct(q, { resultPoints: 2, exactBonus: 1 })), [409, "liguilla_not_available"], "corrección");
      assert.equal(JSON.stringify(await stored(q)), antes, "nada cambió");
      // Jornadas regulares: igual que siempre.
      v = await read(q);
      v.rounds = [regular("r1", 1)];
      const ok = await write(q, v);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const st = await stored(q);
      assert.equal(st.rounds.length, 1);
      assert.equal(st.liguillaLocks, undefined);
      assert.equal(st.settings.liguilla, undefined);
    });
  }

  itest("Liga MX conserva todo: reglas, publicar, candado y corrección del propietario", async () => {
    const q = await quiniela("lmx-ok", { league: LMX });
    let v = await read(q);
    v.settings.liguilla = { ...RULES };
    v.rounds = [lg("q1", 18)];
    assert.equal((await write(q, v)).status, 200);
    v = await read(q);
    v.rounds[0].published = true;
    const pub = await write(q, v);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.deepEqual((await stored(q)).liguillaLocks[0].rules, RULES);
    const c = await correct(q, { resultPoints: 3, exactBonus: 2 });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal((await stored(q)).rounds[0].scoring.resultPoints, 3);
  });

  itest("sin competencia → Liga MX (primera vez): después sí hay liguilla; en el mismo guardado no", async () => {
    const q = await quiniela("lmx-first");
    let v = await read(q);
    v.settings.sportsdbLeagueId = LMX;
    v.settings.liguilla = { ...RULES };
    assert.deepEqual(errOf(await write(q, v)), [409, "liguilla_not_available"]);
    v = await read(q);
    v.settings.sportsdbLeagueId = LMX;
    const set = await write(q, v);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    v = await read(q);
    v.settings.liguilla = { ...RULES };
    v.rounds = [lg("q1", 18)];
    assert.equal((await write(q, v)).status, 200);
  });

  itest("cambio de competencia con liguilla en curso: Liga MX → Premier y → sin competencia, bloqueados; nada se pierde", async () => {
    const q = await quiniela("lmx-change", { league: LMX });
    let v = await read(q);
    v.settings.liguilla = { ...RULES };
    v.rounds = [lg("q1", 18)];
    assert.equal((await write(q, v)).status, 200);
    const antes = JSON.stringify(await stored(q));
    for (const next of [PREMIER, null]) {
      v = await read(q);
      if (next) v.settings.sportsdbLeagueId = next; else delete v.settings.sportsdbLeagueId;
      assert.deepEqual(errOf(await write(q, v)), [409, "liguilla_league_change_blocked"], String(next));
    }
    assert.equal(JSON.stringify(await stored(q)), antes);
  });

  itest("histórico: Premier con liguilla previa al hotfix — se lee, pronostica y cierra; nada nuevo ni corrección", async () => {
    const q = await quiniela("lmx-hist", { league: PREMIER });
    // Datos anteriores al hotfix, puestos directo en la base (no hay otra vía ya).
    const st0 = await stored(q);
    st0.settings.liguilla = { ...RULES };
    st0.rounds = [lg("q1", 18, { published: true, scoring: { ...RULES } }), lg("q2", 19)];
    st0.liguillaPublished = { q1: { deadline: st0.rounds[0].deadline, matchIds: ["q1_1", "q1_2"], scoring: { ...RULES } } };
    const idx = (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value;
    const scopeId = idx.quinielas.find((x) => x.slug === q.slug).tournamentScope.id;
    st0.liguillaLocks = [{ scopeId, lockedAt: new Date().toISOString(), roundId: "q1", roundNumber: 18, rules: { ...RULES } }];
    await putStored(q, st0);
    // El participante lo sigue viendo y pronosticando la jornada ya publicada.
    const asBeto = await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id } });
    assert.equal(asBeto.status, 200);
    assert.equal(asBeto.body.value.rounds.find((r) => r.id === "q1").stage, "liguilla");
    const pick = await call("POST", `/api/quinielas/${q.slug}/picks/${q.beto.id}/match`, {
      headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id }, body: { roundId: "q1", matchId: "q1_1", value: { a: 2, b: 1 }, expected: null },
    });
    assert.equal(pick.status, 200, JSON.stringify(pick.body));
    // Un guardado ajeno a la liguilla pasa y la conserva.
    let v = await read(q);
    v.groupName = "Nombre nuevo";
    assert.equal((await write(q, v)).status, 200);
    const st1 = await stored(q);
    assert.deepEqual(st1.settings.liguilla, RULES);
    assert.equal(st1.rounds.find((r) => r.id === "q2").stage, "liguilla");
    // Lo nuevo, no: publicar el borrador, cambiar reglas, corregir, ni cambiar de competencia.
    v = await read(q);
    v.rounds.find((r) => r.id === "q2").published = true;
    assert.deepEqual(errOf(await write(q, v)), [409, "liguilla_not_available"]);
    v = await read(q);
    v.settings.liguilla = { capture: "score", resultPoints: 4, exactBonus: 1 };
    assert.deepEqual(errOf(await write(q, v)), [409, "liguilla_not_available"]);
    assert.deepEqual(errOf(await correct(q, { resultPoints: 2, exactBonus: 1 })), [409, "liguilla_not_available"]);
    v = await read(q);
    v.settings.sportsdbLeagueId = LMX;
    const ch = await write(q, v);
    assert.ok(ch.status === 409 || ch.status === 403, JSON.stringify(ch.body));
    assert.equal((await stored(q)).settings.sportsdbLeagueId, PREMIER);
  });

  itest("Technical QA P2-2: sin competencia con liguilla en curso → declarar Liga MX desbloquea; Premier no", async () => {
    const q = await quiniela("lmx-none-lg");
    const st0 = await stored(q);
    st0.settings.liguilla = { ...RULES };
    st0.rounds = [lg("q1", 18)];
    await putStored(q, st0);
    let v = await read(q);
    v.settings.sportsdbLeagueId = PREMIER;
    assert.deepEqual(errOf(await write(q, v)), [409, "liguilla_league_change_blocked"]);
    v = await read(q);
    v.settings.sportsdbLeagueId = 4350;
    const ok = await write(q, v);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await stored(q)).settings.sportsdbLeagueId, "4350", "normalizada");
    v = await read(q);
    v.rounds[0].published = true;
    const pub = await write(q, v);
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    v = await read(q);
    v.settings.sportsdbLeagueId = ["4350"];
    assert.deepEqual(errOf(await write(q, v)), [400, "invalid_value"]);
  });
});
