// liguillaRulesCorrection.integration.test.js — HOTFIX: el propietario corrige
// la puntuación de liguilla ya fijada, en el SERVIDOR REAL con PostgreSQL.
//
//   pg_ctlcluster 16 main start
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/liguillaRulesCorrection.integration.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela: quinielaBase, Browser, freshIp } = require("./helpers/realServer");
// La liguilla es sólo de Liga MX: estas quinielas guardan esa competencia.
const quiniela = (tag) => quinielaBase(tag, { league: "4350" });
const L = require("../liguillaScoring");

const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value, headers) => call("POST", kvPath(q.slug), { headers: headers || { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const storedPicks = async (q, pid) => {
  const r = await dbQuery("SELECT value FROM kv WHERE key = $1", [`quiniela:${q.slug}:picks:${pid}`]);
  return r.rows.length ? r.rows[0].value : null;
};
const matchPick = (q, who, body) => call("POST", `/api/quinielas/${q.slug}/picks/${who.id}/match`, {
  headers: { "X-Qracks-Auth": who.pin, "X-Qracks-Participant": who.id }, body,
});
const correct = (q, headers, body, extra = {}) => call("POST", `/api/quinielas/${q.slug}/liguilla/rules`, { headers, body, ...extra });
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const RULES = { capture: "score", resultPoints: 1, exactBonus: 1 };
const s = (a, b) => ({ a, b });
const EXP = { resultPoints: 1, exactBonus: 1 };

function lgRound(id, number, published = false) {
  return {
    id, number, deadline: enHoras(48), results: {}, resultsPublished: false, published,
    stage: "liguilla", phase: { round: "quarter", leg: "ida", source: "admin" },
    matches: [{ id: id + "_1", teamA: "Club A", teamB: "Club B" }, { id: id + "_2", teamA: "Club C", teamB: "Club D" }],
  };
}
async function cerrar(q, ids) {
  const v = await stored(q);
  v.rounds.filter((r) => ids.includes(r.id)).forEach((r) => { r.deadline = new Date(Date.now() - 60e3).toISOString(); });
  await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
}

// Quiniela completa: J1 regular con resultados, una pregunta extra, una
// penalización; liguilla «ida» publicada con resultados, «vuelta» publicada sin
// resultados y «semi» en borrador. Beto pronosticó todo.
async function escenario(tag, { results = true } = {}) {
  const q = await quiniela(tag);
  let v = await read(q);
  v.settings.liguilla = { ...RULES };
  v.rounds = [
    { id: "r1", number: 1, deadline: enHoras(24), results: {}, resultsPublished: false, published: true, matches: [{ id: "m1", teamA: "León", teamB: "Santos" }] },
    lgRound("ida", 18), lgRound("vta", 19), lgRound("semi", 20),
  ];
  assert.equal((await write(q, v)).status, 200);
  v = await read(q);
  v.rounds.find((r) => r.id === "ida").published = true;
  v.rounds.find((r) => r.id === "vta").published = true;
  const w = await write(q, v);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  // Pronósticos de Beto: regular por kv, liguilla por partido.
  const picksKey = "/api/kv/" + encodeURIComponent(`quiniela:${q.slug}:picks:${q.beto.id}`);
  const bh = { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id };
  const rp = await call("POST", picksKey, { headers: bh, body: { value: { r1: { m1: "A" } } } });
  assert.equal(rp.status, 200, JSON.stringify(rp.body));
  for (const [rid, mid, val] of [["ida", "ida_1", s(2, 1)], ["ida", "ida_2", s(0, 0)], ["vta", "vta_1", s(1, 0)]]) {
    const r = await matchPick(q, q.beto, { roundId: rid, matchId: mid, value: val, expected: null });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  if (results) {
    await cerrar(q, ["r1", "ida"]);
    v = await read(q);
    Object.assign(v.rounds.find((r) => r.id === "r1"), { results: { m1: "A" }, resultsPublished: true });
    Object.assign(v.rounds.find((r) => r.id === "ida"), {
      resultsPublished: true, results: { ida_1: "A", ida_2: "D" }, scores: { ida_1: s(2, 1), ida_2: s(1, 1) }, matchStatus: {},
    });
    v.customBets = [{ id: "cb1", question: "¿Campeón?", type: "text", points: 3, answer: "León" }];
    v.participants.find((p) => p.id === q.beto.id).penalizedRounds = { r1: true };
    const r = await write(q, v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return q;
}
// Lo que la corrección NO puede tocar, tal cual está en la base.
async function intocable(q) {
  const st = await stored(q);
  return {
    rounds: st.rounds.map((r) => { const c = { ...r }; delete c.scoring; return c; }),
    customBets: st.customBets, participants: st.participants,
    picks: await storedPicks(q, q.beto.id), points: st.settings.pointsPerCorrectPick,
  };
}
const total = async (q, rid) => L.scoreRound((await stored(q)).rounds.find((r) => r.id === rid), (await storedPicks(q, q.beto.id))[rid]).total;

test.describe("HOTFIX · corregir la puntuación de liguilla", () => {
  test.before(setup);
  test.after(teardown);

  itest("propietario: cambia puntos base y bono; jornadas del torneo, candado, configuración y historial en una escritura", async () => {
    const q = await escenario("ok");
    assert.equal(await total(q, "ida"), 3, "antes: 2 (exacto) + 1 (resultado)");
    const antes = await intocable(q);
    const rev0 = (await stored(q)).roundsRevision;
    const r = await correct(q, { "X-Qracks-Auth": q.owner }, { expected: EXP, rules: { resultPoints: 3, exactBonus: 2 } }, { cookie: q.anaPhone.cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.ok, r.body.rules, r.body.rounds], [true, { capture: "score", resultPoints: 3, exactBonus: 2 }, 2]);
    const st = await stored(q);
    const NEW = { capture: "score", resultPoints: 3, exactBonus: 2 };
    assert.deepEqual(st.rounds.find((x) => x.id === "ida").scoring, NEW);
    assert.deepEqual(st.rounds.find((x) => x.id === "vta").scoring, NEW);
    assert.equal(st.rounds.find((x) => x.id === "semi").scoring, undefined);
    assert.deepEqual(st.liguillaLocks[0].rules, NEW);
    assert.deepEqual(st.settings.liguilla, NEW);
    assert.deepEqual(st.liguillaPublished.ida.scoring, NEW);
    assert.equal(st.liguillaRulesHistory.length, 1);
    const h = st.liguillaRulesHistory[0];
    assert.deepEqual([h.from, h.to, h.by, h.rounds.sort()], [RULES, NEW, { participantId: q.ana.id, via: "admin_password" }, ["ida", "vta"]]);
    assert.ok(Date.parse(h.at) > Date.now() - 60e3);
    assert.notEqual(st.roundsRevision, rev0, "las pestañas abiertas se enteran (rounds_conflict)");
    assert.deepEqual(await intocable(q), antes, "pronósticos, resultados, fase regular, preguntas y penalización intactos");
    assert.equal(await total(q, "ida"), 3 * 2 + 2, "después: 3+3 por resultado + 2 por exacto");
    // Lo que ve el cliente: la meta leída trae el candado nuevo.
    const meta = await read(q);
    assert.deepEqual(meta.liguillaLock.rules, NEW);
    // Una jornada publicada después hereda las reglas corregidas.
    const v = await read(q);
    v.rounds.find((x) => x.id === "semi").published = true;
    assert.equal((await write(q, v)).status, 200);
    assert.deepEqual((await stored(q)).rounds.find((x) => x.id === "semi").scoring, NEW);
  });

  itest("permisos: sin contraseña, PIN de participante, PIN del admin, co-admin, sesión y contraseña equivocada → 403 y nada cambia", async () => {
    const q = await escenario("perm", { results: false });
    const v = await read(q);
    v.participants.find((p) => p.id === q.beto.id).isAdmin = true;   // Beto co-admin
    assert.equal((await write(q, v)).status, 200);
    const antes = JSON.stringify(await stored(q));
    const body = { expected: EXP, rules: { resultPoints: 2, exactBonus: 1 } };
    const intentos = [
      ["sin cabecera", {}, {}],
      ["PIN del co-admin", { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id }, {}],
      ["PIN de la creadora", { "X-Qracks-Auth": q.ana.pin, "X-Qracks-Participant": q.ana.id }, {}],
      ["sólo la cookie de sesión de la creadora", {}, { cookie: q.anaPhone.cookie }],
      ["sólo la cookie del co-admin", {}, { cookie: q.betoPhone.cookie }],
      ["contraseña equivocada", { "X-Qracks-Auth": "no-es-" + q.owner }, {}],
      ["contraseña de plataforma", { "X-Qracks-Platform-Auth": "solo-local-prueba" }, {}],
    ];
    for (const [name, headers, extra] of intentos) {
      const r = await correct(q, headers, body, extra);
      assert.deepEqual([r.status, r.body.error], [403, "wrong_admin_password"], name + ": " + JSON.stringify(r.body));
    }
    assert.equal(JSON.stringify(await stored(q)), antes, "la fila no cambió en ningún intento");
    const no = await call("POST", `/api/quinielas/no-existe-${Date.now()}/liguilla/rules`, { headers: { "X-Qracks-Auth": q.owner }, body });
    assert.equal(no.status, 404);
  });

  itest("validación en el servidor: cambio de forma, iguales, inválidas, sin candado, reglas esperadas viejas", async () => {
    const q = await escenario("val", { results: false });
    const own = { "X-Qracks-Auth": q.owner };
    const antes = JSON.stringify(await stored(q));
    const casos = [
      [{ expected: EXP, rules: { resultPoints: 2, exactBonus: 0 } }, 409, "liguilla_capture_change_blocked"],
      [{ expected: EXP, rules: { resultPoints: 1, exactBonus: 1 } }, 400, "liguilla_rules_unchanged"],
      [{ expected: EXP, rules: { resultPoints: 0, exactBonus: 1 } }, 400, "liguilla_rules_result_required"],
      [{ expected: EXP, rules: { resultPoints: -1, exactBonus: 1 } }, 400, "liguilla_rules_invalid"],
      [{ expected: EXP, rules: { resultPoints: 2.5, exactBonus: 1 } }, 400, "liguilla_rules_invalid"],
      [{ expected: EXP, rules: "3" }, 400, "liguilla_rules_invalid"],
      [{ expected: EXP }, 400, "liguilla_rules_invalid"],
      [{ expected: { resultPoints: 2, exactBonus: 1 }, rules: { resultPoints: 3, exactBonus: 1 } }, 409, "liguilla_rules_changed"],
      [{ rules: { resultPoints: 3, exactBonus: 1 } }, 409, "liguilla_rules_changed"],
    ];
    for (const [body, status, error] of casos) {
      const r = await correct(q, own, body);
      assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify(body));
    }
    assert.equal(JSON.stringify(await stored(q)), antes);
    const sin = await quiniela("sincandado");
    const r = await correct(sin, { "X-Qracks-Auth": sin.owner }, { expected: EXP, rules: { resultPoints: 2, exactBonus: 1 } });
    assert.deepEqual([r.status, r.body.error], [409, "liguilla_not_locked"]);
  });

  itest("concurrencia: dos correcciones a la vez con las mismas reglas esperadas → una gana, la otra 409 y ve las vigentes", async () => {
    const q = await escenario("conc", { results: false });
    const own = { "X-Qracks-Auth": q.owner };
    const [a, b] = await Promise.all([
      correct(q, own, { expected: EXP, rules: { resultPoints: 2, exactBonus: 1 } }),
      correct(q, own, { expected: EXP, rules: { resultPoints: 5, exactBonus: 4 } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([a.body, b.body]));
    const won = a.status === 200 ? a : b, lost = a.status === 200 ? b : a;
    assert.equal(lost.body.error, "liguilla_rules_changed");
    assert.deepEqual(lost.body.current, won.body.rules);
    const st = await stored(q);
    assert.deepEqual(st.liguillaLocks[0].rules, won.body.rules);
    assert.equal(st.liguillaRulesHistory.length, 1);
  });

  itest("API directa: un guardado normal no escribe historial ni copias de reglas; una pestaña atrasada sigue guardando", async () => {
    const q = await escenario("api", { results: false });
    const pre = await read(q);   // pestaña abierta antes de la corrección
    const r = await correct(q, { "X-Qracks-Auth": q.owner }, { expected: EXP, rules: { resultPoints: 2, exactBonus: 3 } });
    assert.equal(r.status, 200);
    const NEW = { capture: "score", resultPoints: 2, exactBonus: 3 };
    // Intento directo de reescribir copias, candado e historial.
    const v = await read(q);
    v.liguillaRulesHistory = [];
    v.liguillaLocks = [{ scopeId: "x", rules: RULES }];
    v.rounds.find((x) => x.id === "ida").scoring = RULES;
    v.liguillaPublished = {};
    const w = await write(q, v);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    let st = await stored(q);
    assert.equal(st.liguillaRulesHistory.length, 1);
    assert.deepEqual(st.liguillaLocks[0].rules, NEW);
    assert.deepEqual(st.rounds.find((x) => x.id === "ida").scoring, NEW);
    assert.deepEqual(st.liguillaPublished.ida.scoring, NEW);
    // Cambiar las reglas por la vía normal sigue bloqueado.
    const v2 = await read(q);
    v2.settings.liguilla = { capture: "score", resultPoints: 9, exactBonus: 1 };
    assert.deepEqual([(await write(q, v2)).status], [409]);
    // La pestaña atrasada que guarda el tablero completo recibe rounds_conflict
    // (como siempre) y se refresca. Cuando su guardado ya pasa la revisión del
    // tablero pero aún trae las reglas anteriores, no falla ni las revierte.
    pre.groupName = "Nombre nuevo";
    const stale = await write(q, pre);
    assert.deepEqual([stale.status, stale.body.error], [409, "rounds_conflict"]);
    pre.roundsRevision = (await read(q)).roundsRevision;
    const ws = await write(q, pre);
    assert.equal(ws.status, 200, JSON.stringify(ws.body));
    st = await stored(q);
    assert.equal(st.groupName, "Nombre nuevo");
    assert.deepEqual(st.settings.liguilla, NEW, "no vuelve a las reglas anteriores");
  });

  itest("participante: la meta que lee refleja las reglas nuevas en su jornada y el historial no expone credenciales", async () => {
    const q = await escenario("part");
    assert.equal((await correct(q, { "X-Qracks-Auth": q.owner }, { expected: EXP, rules: { resultPoints: 2, exactBonus: 1 } })).status, 200);
    const asBeto = (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id } })).body.value;
    assert.deepEqual(asBeto.rounds.find((r) => r.id === "ida").scoring, { capture: "score", resultPoints: 2, exactBonus: 1 });
    assert.equal(asBeto.liguillaRulesHistory, undefined, "el participante no recibe la auditoría");
    const anon = (await call("GET", kvPath(q.slug))).body.value;
    assert.equal(anon.liguillaRulesHistory, undefined, "una lectura sin credencial tampoco");
    assert.equal((await read(q)).liguillaRulesHistory.length, 1, "el propietario sí");
    assert.equal(L.scoreRound(asBeto.rounds.find((r) => r.id === "ida"), (await storedPicks(q, q.beto.id)).ida).total, 2 * 2 + 1);
  });

  itest("Technical QA P2: la jornada que fijó el candado en un ciclo nuevo, con un id del ciclo anterior, también se corrige", async () => {
    const q = await quiniela("p2ciclo");
    let v = await read(q);
    v.settings.liguilla = { ...RULES };
    v.rounds = [{ id: "r1", number: 1, deadline: enHoras(24), results: {}, resultsPublished: false, published: true, matches: [{ id: "m1", teamA: "León", teamB: "Santos" }] }];
    assert.equal((await write(q, v)).status, 200);
    v = await read(q); v.rounds[0].published = false;
    assert.equal((await write(q, v)).status, 200);
    const idx = (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value;
    const entry = idx.quinielas.find((x) => x.slug === q.slug);
    const nc = await call("POST", `/api/quinielas/${q.slug}/tournament/new-cycle`, { headers: { "X-Qracks-Auth": q.owner }, body: { expectedCycle: entry.tournamentScope.editionSeq } });
    assert.equal(nc.status, 200, JSON.stringify(nc.body));
    v = await read(q);
    Object.assign(v.rounds[0], { stage: "liguilla", number: 18, phase: { round: "quarter", leg: "ida", source: "admin" }, published: true });
    const w = await write(q, v);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const before = await stored(q);
    assert.equal(before.liguillaLocks.find((l) => l.roundId === "r1") != null, true);
    const r = await correct(q, { "X-Qracks-Auth": q.owner }, { expected: EXP, rules: { resultPoints: 3, exactBonus: 2 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.rounds, 1);
    const st = await stored(q);
    const NEW = { capture: "score", resultPoints: 3, exactBonus: 2 };
    assert.ok(L.sameRules(st.rounds[0].scoring, NEW), JSON.stringify(st.rounds[0].scoring));
    assert.ok(L.sameRules(st.liguillaPublished.r1.scoring, NEW));
    assert.deepEqual(st.liguillaRulesHistory[0].rounds, ["r1"]);
  });
});
