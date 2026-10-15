// MS2 · D4 con el servidor real (PostgreSQL): una pregunta del torneo cerrada no
// se reabre por ningún camino; antes de cerrar, su cierre sólo cambia de forma
// explícita; al cerrar el torneo se cierra y se archiva con sus respuestas y
// aciertos, y el torneo nuevo no la cuenta ni la recibe de vuelta.
//
// Los seis caminos que la reabrían (reproducidos antes de D4 en esta rama y en
// main d0baf06): A borrar su jornada, B renumerarla, C mover su cierre más
// tarde, D cambiarle la jornada a la pregunta, E cerrar el torneo, F la J1 del
// torneo siguiente. Más el cambio de tipo y los clientes que no conocen los
// campos nuevos.

const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela, Browser, freshIp } = require("./helpers/realServer");

const read = async (q, auth) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": auth || q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const putStored = (q, v) => dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
const answer = (q, betId, guess) => call("POST", "/api/submit-bet-answer", {
  ip: q.betoPhone.ip,
  headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id },
  body: { metaKey: q.metaKey, participantId: q.beto.id, betId, guess },
});
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const jornada = (tag, number, deadline) => ({ id: "r_d4" + tag + number, number, deadline, results: {}, resultsPublished: false, published: true,
  matches: [{ id: "m_d4" + tag + number, teamA: "León", teamB: "Santos" }] });
const BET = "cb_d4campeon";
const campeon = (closesAtRound) => ({ id: BET, label: "¿Qué equipo será campeón del torneo?", scope: "temporada", points: 5, closesAtRound });
async function closeTournament(q) {
  const idx = (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value;
  const entry = idx.quinielas.find((x) => x.slug === q.slug);
  return call("POST", `/api/quinielas/${q.slug}/tournament/close`, {
    headers: { "X-Qracks-Auth": q.owner },
    body: { expectedCycle: entry.tournamentScope.editionSeq, closeIntentId: "d4close" + Date.now().toString(36), standings: [] },
  });
}

// Una pregunta NUEVA (creada por la API, con su cierre propio) que ya cerró con
// la J1: se crea con la J1 abierta, Beto responde, y el reloj llega al cierre
// (directo en la base: la J1 y la pregunta llegan a esa hora).
async function nuevaCerrada(tag) {
  const q = await quiniela(tag);
  const v = await read(q);
  v.rounds = [jornada(tag, 1, enHoras(24)), jornada(tag, 2, enHoras(72))];
  v.customBets = [campeon(1)];
  const w = await write(q, v);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const s = await stored(q);
  const bet = s.customBets[0];
  assert.equal(bet.closesRoundId, "r_d4" + tag + "1", "ligada por id");
  assert.equal(bet.closesAt, new Date(s.rounds[0].deadline).toISOString(), "con el cierre de su jornada");
  assert.equal(bet.closeSource, "round");
  assert.equal(bet.epoch, 0);
  assert.equal((await answer(q, BET, "América")).status, 200);
  const past = enHoras(-1);
  s.rounds[0].deadline = past;
  s.customBets[0].closesAt = past;
  await putStored(q, s);
  const locked = await answer(q, BET, "Toluca");
  assert.deepEqual([locked.status, locked.body], [403, { error: "bet_locked" }], "ya cerró");
  return q;
}
// Una pregunta ANTIGUA (guardada antes de D4, sin migrar: sin closesAt) que ya
// cerró con la J1 por número.
async function antiguaCerrada(tag) {
  const q = await quiniela(tag);
  const v = await stored(q);
  v.rounds = [jornada(tag, 1, enHoras(-1)), jornada(tag, 2, enHoras(72))];
  v.customBets = [campeon(1)];
  await putStored(q, v);
  const locked = await answer(q, BET, "Toluca");
  assert.deepEqual([locked.status, locked.body], [403, { error: "bet_locked" }], "ya cerró");
  return q;
}
const guess = async (q) => {
  const p = (await stored(q)).participants.find((x) => x.id === q.beto.id);
  return p.customBetAnswers && p.customBetAnswers[BET] ? p.customBetAnswers[BET].guess : null;
};

test.describe("D4 · una pregunta cerrada no se reabre (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  for (const [kind, make] of [["nueva", nuevaCerrada], ["antigua sin migrar", antiguaCerrada]]) {
    const own = kind === "nueva";
    itest(`${kind} · A: eliminar su jornada ${own ? "se guarda y la pregunta sigue cerrada" : "se rechaza (la reabriría) y no cambia nada"}`, async () => {
      const q = await make(own ? "an" : "aa");
      const before = await stored(q);
      const v = await read(q);
      v.rounds = v.rounds.filter((r) => r.number !== 1);
      const w = await write(q, v);
      if (own) assert.equal(w.status, 200, JSON.stringify(w.body));
      else {
        assert.deepEqual([w.status, w.body], [409, { error: "bet_close_locked", betId: BET }]);
        assert.deepEqual((await stored(q)).rounds, before.rounds, "nada se escribió");
      }
      assert.deepEqual([(await answer(q, BET, "Cruz Azul")).status], [403]);
    });

    itest(`${kind} · B: renumerar su jornada ${own ? "no la toca (va por id)" : "se rechaza"}`, async () => {
      const q = await make(own ? "bn" : "ba");
      const v = await read(q);
      v.rounds.find((r) => r.number === 1).number = 20;
      const w = await write(q, v);
      assert.equal(w.status, own ? 200 : 409, JSON.stringify(w.body));
      assert.equal((await answer(q, BET, "Cruz Azul")).status, 403);
    });

    itest(`${kind} · C: mover más tarde el cierre de su jornada ${own ? "no mueve el de la pregunta" : "se rechaza"}`, async () => {
      const q = await make(own ? "cn" : "ca");
      const closesAt = (await stored(q)).customBets[0].closesAt;
      const v = await read(q);
      v.rounds.find((r) => r.number === 1).deadline = enHoras(24);
      const w = await write(q, v);
      assert.equal(w.status, own ? 200 : 409, JSON.stringify(w.body));
      assert.equal((await stored(q)).customBets[0].closesAt, closesAt, "su cierre no se movió");
      assert.equal((await answer(q, BET, "Cruz Azul")).status, 403);
      // Ni pidiéndolo: mover el cierre de una cerrada es 409.
      if (own) {
        const x = await read(q);
        x.customBets[0].closesAt = x.rounds.find((r) => r.number === 1).deadline;
        assert.deepEqual([(await write(q, x)).status], [409]);
      }
    });

    itest(`${kind} · D: cambiarle la jornada, el tipo o el vínculo por API: 409 bet_close_locked y nada cambia`, async () => {
      const q = await make(own ? "dn" : "da");
      const before = JSON.stringify((await stored(q)).customBets);
      for (const change of [
        (b) => { b.closesAtRound = 2; },
        (b) => { b.scope = "jornada"; },
        (b) => { b.closesRoundId = "r_d4" + (own ? "dn" : "da") + "2"; },
        (b) => { b.closesAt = enHoras(48); },
        (b) => { b.closesAt = null; },
      ]) {
        const v = await read(q);
        change(v.customBets[0]);
        const w = await write(q, v);
        assert.deepEqual([w.status, w.body], [409, { error: "bet_close_locked", betId: BET }], change.toString());
      }
      assert.equal(JSON.stringify((await stored(q)).customBets), before);
      assert.equal((await answer(q, BET, "Cruz Azul")).status, 403);
    });

    itest(`${kind} · E y F: cerrar el torneo la archiva cerrada; la J1 del torneo nuevo (otro id) no la toca, y no vuelve con su id`, async () => {
      const tag = own ? "en" : "ea";
      const q = await make(tag);
      const c = await closeTournament(q);
      assert.equal(c.status, 200, JSON.stringify(c.body));
      const s = await stored(q);
      assert.deepEqual(s.customBets, [], "el torneo nuevo empieza sin preguntas");
      const arch = s.pastTournaments[s.pastTournaments.length - 1];
      const b = arch.customBets.find((x) => x.id === BET);
      assert.ok(b && Date.parse(b.closesAt) <= Date.now(), "archivada cerrada");
      if (own) assert.equal(b.closeSource, "round", "conserva el cierre que ya tenía");
      else assert.deepEqual([b.closeSource, b.closeFlag], ["tournament_end", "closed_by_round"], "sin cierre propio: el del fin del torneo, y que ya había cerrado por su jornada");
      assert.equal((await answer(q, BET, "Cruz Azul")).status, 404, "ya no es una pregunta del torneo activo");
      // F: el torneo nuevo publica su J1 (otro id, mismo número).
      const v = await read(q);
      v.rounds = [jornada(tag + "nuevo", 1, enHoras(48))];
      assert.equal((await write(q, v)).status, 200);
      assert.equal((await answer(q, BET, "Pumas")).status, 404);
      // El id archivado no vuelve, ni ligado a la J1 nueva.
      const x = await read(q);
      x.customBets = [campeon(1)];
      assert.deepEqual([(await write(q, x)).status, (await write(q, x)).body.error], [409, "bet_retired"]);
      // J1 actual frente a J1 archivada: una pregunta nueva se liga a la nueva, por id.
      const y = await read(q);
      y.customBets = [{ ...campeon(1), id: "cb_d4otra" + tag }];
      assert.equal((await write(q, y)).status, 200);
      const now = (await stored(q)).customBets[0];
      assert.equal(now.closesRoundId, "r_d4" + tag + "nuevo1");
      assert.equal(now.epoch, 1, "pertenece al torneo nuevo");
      assert.notEqual(arch.rounds.find((r) => r.number === 1) ? arch.rounds.find((r) => r.number === 1).id : null, now.closesRoundId);
    });
  }

  itest("una pregunta quitada no vuelve con el mismo id (409 bet_retired)", async () => {
    const q = await quiniela("d4quitar");
    const v = await read(q);
    v.rounds = [jornada("qt", 1, enHoras(24))];
    v.customBets = [campeon(1)];
    assert.equal((await write(q, v)).status, 200);
    const w = await read(q);
    w.customBets = [];
    assert.equal((await write(q, w)).status, 200);
    assert.deepEqual((await stored(q)).retiredBetIds, [BET]);
    const x = await read(q);
    x.customBets = [campeon(1)];
    const r = await write(q, x);
    assert.deepEqual([r.status, r.body], [409, { error: "bet_retired", betId: BET }]);
  });

  itest("abierta · editar su jornada no mueve su cierre; moverlo es explícito y sólo a la hora de su jornada", async () => {
    const q = await quiniela("d4abierta");
    const v = await read(q);
    v.rounds = [jornada("ab", 1, enHoras(24)), jornada("ab", 2, enHoras(72))];
    v.customBets = [campeon(1)];
    assert.equal((await write(q, v)).status, 200);
    const first = (await stored(q)).customBets[0].closesAt;
    // Editar la J1 (otra hora) sin decir nada de la pregunta: conserva su cierre.
    const a = await read(q);
    const later = enHoras(30);
    a.rounds[0].deadline = later;
    assert.equal((await write(q, a)).status, 200);
    assert.equal((await stored(q)).customBets[0].closesAt, first, "no se movió solo");
    // Pedirlo a otra hora que no es la de su jornada: 400.
    const b = await read(q);
    b.customBets[0].closesAt = enHoras(40);
    assert.deepEqual([(await write(q, b)).status, (await write(q, b)).body.error], [400, "bet_close_invalid"]);
    // Pedirlo a la hora de su jornada: sí.
    const c = await read(q);
    c.customBets[0].closesAt = c.rounds[0].deadline;
    assert.equal((await write(q, c)).status, 200);
    assert.equal(Date.parse((await stored(q)).customBets[0].closesAt), Date.parse(later));
    // Ligarla a otra jornada abierta (por id): toma su cierre.
    const d = await read(q);
    d.customBets[0].closesRoundId = d.rounds[1].id;
    assert.equal((await write(q, d)).status, 200);
    const now = (await stored(q)).customBets[0];
    assert.deepEqual([now.closesRoundId, now.closesAtRound, Date.parse(now.closesAt)], [d.rounds[1].id, 2, Date.parse(d.rounds[1].deadline)]);
    // Borrar su jornada: conserva su cierre (no queda abierta para siempre).
    const e = await read(q);
    e.rounds = e.rounds.filter((r) => r.number !== 2);
    assert.equal((await write(q, e)).status, 200);
    assert.equal((await stored(q)).customBets[0].closesAt, now.closesAt);
    assert.equal((await answer(q, BET, "Toluca")).status, 200, "abierta hasta su cierre");
  });

  itest("un cliente que no conoce los campos nuevos los omite: se conservan; si los manda distintos, se juzgan", async () => {
    const q = await quiniela("d4viejo");
    const v = await read(q);
    v.rounds = [jornada("vj", 1, enHoras(24))];
    v.customBets = [campeon(1)];
    assert.equal((await write(q, v)).status, 200);
    const keep = (await stored(q)).customBets[0];
    // Un cliente anterior reconstruye la pregunta con sus campos de siempre.
    const a = await read(q);
    a.customBets = [{ id: BET, label: "¿Quién será campeón?", scope: "temporada", points: 7, closesAtRound: 1 }];
    const w = await write(q, a);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const after = (await stored(q)).customBets[0];
    assert.deepEqual([after.label, after.points], ["¿Quién será campeón?", 7], "su edición se guarda");
    for (const f of ["closesAt", "closesRoundId", "closeSource", "epoch"]) assert.deepEqual(after[f], keep[f], f + " se conserva");
    // Lo que un cliente diga de los campos que pone el servidor no cuenta.
    const b = await read(q);
    Object.assign(b.customBets[0], { closeSource: "none", epoch: 99, closeFlag: "lost_link" });
    assert.equal((await write(q, b)).status, 200);
    const again = (await stored(q)).customBets[0];
    assert.deepEqual([again.closeSource, again.epoch, again.closeFlag], [keep.closeSource, keep.epoch, undefined]);
    // Borrarlos explícitamente no se acepta.
    const c = await read(q);
    c.customBets[0].closesAt = null;
    assert.deepEqual([(await write(q, c)).status], [400]);
    const d = await read(q);
    d.customBets[0].closesRoundId = null;
    assert.deepEqual([(await write(q, d)).status], [400]);
    assert.equal((await stored(q)).customBets[0].closesAt, keep.closesAt);
  });

  itest("una pregunta de torneo nueva nace con cierre: sin jornada, o con una que ya cerró, 400", async () => {
    const q = await quiniela("d4nace");
    // La J1 ya cerró (guardada así); la J2 sigue abierta.
    const base = await stored(q);
    base.rounds = [jornada("nc", 1, enHoras(-1)), jornada("nc", 2, enHoras(24))];
    await putStored(q, base);
    const v = await read(q);
    v.customBets = [campeon(null)];
    assert.deepEqual([(await write(q, v)).body.error], ["bet_close_required"]);
    v.customBets = [campeon(1)];
    assert.deepEqual([(await write(q, v)).body.error], ["bet_close_past"]);
    v.customBets = [{ ...campeon(null), closesRoundId: "r_d4nc2" }];
    assert.equal((await write(q, v)).status, 200, "por id también");
    // Lo que mande en closesAt una pregunta nueva no cuenta: es el de su jornada.
    const w = await read(q);
    w.customBets.push({ id: "cb_d4forja", label: "¿Goleador?", scope: "temporada", points: 3, closesAtRound: 2, closesAt: enHoras(500), closeSource: "none" });
    assert.equal((await write(q, w)).status, 200);
    const forja = (await stored(q)).customBets.find((b) => b.id === "cb_d4forja");
    assert.deepEqual([Date.parse(forja.closesAt), forja.closeSource], [Date.parse(w.rounds[1].deadline), "round"]);
  });

  itest("cerrar el torneo: las abiertas se cierran a esa hora; respuestas y aciertos pasan al archivo y ya no cuentan en el torneo nuevo", async () => {
    const q = await quiniela("d4archivo");
    const v = await read(q);
    v.rounds = [jornada("ar", 1, enHoras(24))];
    v.customBets = [campeon(1), { id: "cb_d4penal", label: "¿Habrá penal?", scope: "jornada", points: 2 }];
    assert.equal((await write(q, v)).status, 200);
    assert.equal((await answer(q, BET, "América")).status, 200);
    // El admin marca el acierto (como en Tus reglas: escribe `correct`).
    const g = await read(q);
    g.participants.find((p) => p.id === q.beto.id).customBetAnswers[BET].correct = true;
    g.rounds[0].customBetResults = { cb_d4penal: { [q.beto.id]: true } };
    assert.equal((await write(q, g)).status, 200);
    const before = Date.now();
    const c = await closeTournament(q);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const s = await stored(q);
    const arch = s.pastTournaments[s.pastTournaments.length - 1];
    const temporada = arch.customBets.find((b) => b.id === BET);
    assert.equal(temporada.closeSource, "tournament_end", "archivar no sustituye cerrar");
    assert.ok(Date.parse(temporada.closesAt) >= before - 1000 && Date.parse(temporada.closesAt) <= Date.now());
    assert.ok(arch.customBets.some((b) => b.id === "cb_d4penal"), "las de jornada también se archivan");
    assert.deepEqual(arch.betAnswers[q.beto.id][BET], { guess: "América", correct: true }, "respuesta y acierto, en el archivo");
    assert.equal(arch.rounds[0].customBetResults.cb_d4penal[q.beto.id], true, "el acierto por jornada sigue en su jornada archivada");
    const beto = s.participants.find((p) => p.id === q.beto.id);
    assert.ok(!beto.customBetAnswers || !beto.customBetAnswers[BET], "ya no está en el torneo activo");
    assert.deepEqual(s.customBets, []);
    // Un participante ve su propia respuesta archivada; la de otros, sólo si acertó.
    const asBeto = (await call("GET", kvPath(q.slug), { ip: q.betoPhone.ip, headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id } })).body.value;
    assert.deepEqual(asBeto.pastTournaments.at(-1).betAnswers[q.beto.id][BET], { guess: "América", correct: true });
    const asAna = (await call("GET", kvPath(q.slug), { ip: q.anaPhone.ip, headers: { "X-Qracks-Auth": q.ana.pin, "X-Qracks-Participant": q.ana.id } })).body.value;
    assert.ok(asAna.pastTournaments, "Ana ve el historial");
  });

  itest("antigua sin migrar y abierta: borrar o renumerar su jornada no le cambia el cierre en silencio (409); fijarlo es explícito", async () => {
    const q = await quiniela("d4legab");
    const v = await stored(q);
    v.rounds = [jornada("la", 1, enHoras(24)), jornada("la", 2, enHoras(72))];
    v.customBets = [campeon(1)];
    await putStored(q, v);
    const del = await read(q);
    del.rounds = del.rounds.filter((r) => r.number !== 1);
    assert.deepEqual([(await write(q, del)).status, (await write(q, del)).body], [409, { error: "bet_close_legacy", betId: BET }]);
    const ren = await read(q);
    ren.rounds.find((r) => r.number === 1).number = 20;
    ren.rounds.find((r) => r.number === 2).number = 1;
    assert.equal((await write(q, ren)).body.error, "bet_close_legacy", "otra jornada no toma su número");
    assert.deepEqual((await stored(q)).rounds.map((r) => r.number), [1, 2], "nada se escribió");
    // Borrarla fijando el cierre que tiene hoy (lo que hace la pantalla): se guarda y lo conserva.
    const keep = await read(q);
    const deadline = keep.rounds[0].deadline;
    keep.rounds = keep.rounds.filter((r) => r.number !== 1);
    keep.customBets[0].closesAt = deadline;
    assert.equal((await write(q, keep)).status, 200);
    const b = (await stored(q)).customBets[0];
    assert.deepEqual([b.closesAt, b.closesRoundId, b.closeSource], [new Date(deadline).toISOString(), "r_d4la1", "round"]);
    assert.equal((await answer(q, BET, "Toluca")).status, 200, "sigue abierta hasta su cierre de siempre");
  });

  itest("el «goleador» de antes: su respuesta sólo la ven su autor y el admin, también archivada (Technical QA, heredado)", async () => {
    const q = await quiniela("d4gol");
    const v = await stored(q);
    v.golScorerBet = { enabled: true, bonusPoints: 3, closesAtRound: null };
    v.customBetsMigrated = false;
    const beto = v.participants.find((p) => p.id === q.beto.id);
    beto.golScorerGuess = "Henry Martín (secreto)";
    beto.golScorerCorrect = true;
    await putStored(q, v);
    // Caro, otra participante (Ana es la creadora: admin, la ve como debe).
    const caroPhone = Browser(freshIp());
    const reg = caroPhone.take(await call("POST", "/api/self-register", { ip: caroPhone.ip, body: { metaKey: q.metaKey, name: "Caro", pin: "1357", slug: q.slug } }));
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const caro = reg.body.participant.id;
    const asAna = () => call("GET", kvPath(q.slug), { ip: caroPhone.ip, headers: { "X-Qracks-Auth": "1357", "X-Qracks-Participant": caro } });
    const asBeto = () => call("GET", kvPath(q.slug), { ip: q.betoPhone.ip, headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id } });
    const anon = () => call("GET", kvPath(q.slug));
    const betoIn = (r) => r.body.value.participants.find((p) => p.id === q.beto.id);
    for (const r of [await asAna(), await anon()]) {
      assert.equal(r.status, 200);
      assert.equal(betoIn(r).golScorerGuess, undefined, "otros no la ven");
      assert.equal(betoIn(r).golScorerCorrect, true, "el acierto sí, como `.correct`");
    }
    assert.equal(betoIn(await asBeto()).golScorerGuess, "Henry Martín (secreto)");
    assert.equal((await read(q)).participants.find((p) => p.id === q.beto.id).golScorerGuess, "Henry Martín (secreto)", "el admin la ve");
    // Al cerrar el torneo pasa al archivo, sale del participante y se enmascara con su forma.
    assert.equal((await closeTournament(q)).status, 200);
    const s = await stored(q);
    assert.equal(s.participants.find((p) => p.id === q.beto.id).golScorerGuess, undefined);
    assert.deepEqual(s.pastTournaments.at(-1).legacyScorerBet.answers[q.beto.id], { guess: "Henry Martín (secreto)", correct: true });
    assert.deepEqual((await asAna()).body.value.pastTournaments.at(-1).legacyScorerBet.answers[q.beto.id], { correct: true }, "Caro");
    assert.deepEqual((await anon()).body.value.pastTournaments.at(-1).legacyScorerBet.answers[q.beto.id], { correct: true });
    assert.deepEqual((await asBeto()).body.value.pastTournaments.at(-1).legacyScorerBet.answers[q.beto.id], { guess: "Henry Martín (secreto)", correct: true });
  });

  itest("la respuesta se juzga con el cierre propio y el reloj de la base, no con la jornada", async () => {
    const q = await quiniela("d4reloj");
    const v = await read(q);
    v.rounds = [jornada("rl", 1, enHoras(24))];
    v.customBets = [campeon(1)];
    assert.equal((await write(q, v)).status, 200);
    // Su jornada ya «cerró» en la base, pero la pregunta conserva su cierre: abierta.
    const s = await stored(q);
    s.rounds[0].deadline = enHoras(-1);
    await putStored(q, s);
    assert.equal((await answer(q, BET, "América")).status, 200);
    // Y al revés: la jornada abierta, la pregunta cerrada.
    const t = await stored(q);
    t.rounds[0].deadline = enHoras(48);
    t.customBets[0].closesAt = enHoras(-1);
    await putStored(q, t);
    assert.equal((await answer(q, BET, "Toluca")).status, 403);
  });
});
