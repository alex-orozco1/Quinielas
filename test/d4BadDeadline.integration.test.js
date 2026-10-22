// MS2 · D4 (Technical QA sobre d4af509): una jornada con un cierre ilegible
// (null o «pendiente») que nadie toca cuenta como sin cambios. Antes, una
// pregunta antigua ligada a ella bloqueaba cualquier guardado del admin
// (409 bet_close_legacy) y la mudanza automática del «goleador» se rechazaba
// para siempre (la pestaña lo reintentaba sin fin). La protección sigue igual
// cuando sí cambia: mover ese cierre sin elegir es 409; ligarla por id, sí.
//
// Servidor real + PostgreSQL.

const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela } = require("./helpers/realServer");

const read = async (q) => (await call("GET", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner } })).body.value;
const write = (q, value) => call("POST", kvPath(q.slug), { headers: { "X-Qracks-Auth": q.owner }, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const putStored = (q, v) => dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(v)]);
const answer = (q, betId, guess) => call("POST", "/api/submit-bet-answer", {
  ip: q.betoPhone.ip,
  headers: { "X-Qracks-Auth": q.beto.pin, "X-Qracks-Participant": q.beto.id },
  body: { metaKey: q.metaKey, participantId: q.beto.id, betId, guess },
});
const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const jornada = (id, number, deadline, published = false) => ({ id, number, deadline, results: {}, resultsPublished: false, published,
  matches: [{ id: "m_" + id, teamA: "A", teamB: "B" }] });

for (const [nombre, dl] of [["null", null], ["«pendiente»", "pendiente"]]) {
  const tag = dl === null ? "n" : "p";
  test.describe(`D4 · una jornada con cierre ${nombre} que nadie toca no bloquea nada (servidor real)`, () => {
    test.before(setup);
    test.after(teardown);

    itest("una pregunta antigua ligada a ella no bloquea guardar la cuota ni el nombre", async () => {
      const q = await quiniela("bdl" + tag);
      const v = await stored(q);
      v.rounds = [jornada("r_bdl" + tag + "1", 1, dl), jornada("r_bdl" + tag + "3", 3, enHoras(48), true)];
      v.customBets = [{ id: "cb_old", label: "Antigua", scope: "temporada", points: 1, closesAtRound: 1 }];
      v.customBetsMigrated = true;
      await putStored(q, v);
      let x = await read(q); x.settings.entryFee = 10;
      const w1 = await write(q, x);
      assert.equal(w1.status, 200, JSON.stringify(w1.body));
      x = await read(q); x.groupName = "Otro nombre";
      assert.equal((await write(q, x)).status, 200);
      assert.equal((await stored(q)).customBets[0].closesAtRound, 1, "la pregunta sigue como estaba");
    });

    itest("la mudanza del «goleador» ligado a ella entra a la primera, sin reabrir nada", async () => {
      const q = await quiniela("bdg" + tag);
      const v = await stored(q);
      v.rounds = [jornada("r_bdg" + tag + "1", 1, dl), jornada("r_bdg" + tag + "2", 2, enHoras(72), true)];
      v.customBets = []; v.customBetsMigrated = false;
      v.golScorerBet = { enabled: true, bonusPoints: 3, closesAtRound: 1 };
      await putStored(q, v);
      const x = await read(q);
      x.customBetsMigrated = true;
      x.customBets = [{ id: "cb_gol", label: "Goleador de la liga", scope: "temporada", points: 3, closesAtRound: 1 }];
      const w = await write(q, x);
      assert.equal(w.status, 200, JSON.stringify(w.body));
      // Lo mismo que leía antes: con null la jornada cuenta como cerrada; con un texto, abierta.
      assert.equal((await answer(q, "cb_gol", "Otro")).status, dl === null ? 403 : 200);
    });

    itest("control: cambiarle ese cierre sin elegir sigue siendo 409; ligar la pregunta por id a la jornada, no", async () => {
      const q = await quiniela("bdc" + tag);
      const v = await stored(q);
      v.rounds = [jornada("r_bdc" + tag + "1", 1, dl), jornada("r_bdc" + tag + "3", 3, enHoras(48), true)];
      v.customBets = [{ id: "cb_old", label: "Antigua", scope: "temporada", points: 1, closesAtRound: 1 }];
      v.customBetsMigrated = true;
      await putStored(q, v);
      const nuevo = enHoras(30);
      let x = await read(q);
      x.rounds.find((r) => r.number === 1).deadline = nuevo;
      const w = await write(q, x);
      if (dl === null) {
        // Con null ya contaba como cerrada (como antes de D4): ponerle cierre a
        // su jornada no la reabre; queda cerrada por protección desde ahora.
        assert.equal(w.status, 200, JSON.stringify(w.body));
        const bet = (await stored(q)).customBets[0];
        assert.deepEqual([bet.closeSource, bet.closeFlag], ["protective", "no_valid_close"]);
        assert.ok(Math.abs(Date.parse(bet.closesAt) - Date.now()) < 120e3, "a esta hora, no 1970 ni la fecha nueva");
        assert.equal((await answer(q, "cb_old", "Otro")).status, 403);
        return;
      }
      assert.deepEqual([w.status, w.body.error], [409, "bet_close_legacy"], "mover el cierre de una abierta sin elegir, no");
      x = await read(q);
      x.rounds.find((r) => r.number === 1).deadline = nuevo;
      x.customBets[0].closesRoundId = "r_bdc" + tag + "1";
      const w2 = await write(q, x);
      assert.equal(w2.status, 200, JSON.stringify(w2.body));
      const bet = (await stored(q)).customBets[0];
      assert.deepEqual([bet.closesAt, bet.closesRoundId, bet.closeSource], [new Date(nuevo).toISOString(), "r_bdc" + tag + "1", "round"]);
    });

    itest("borrar esa jornada: con null la pregunta sigue cerrada (por protección); con un texto, sigue abierta, sin cierre todavía", async () => {
      const q = await quiniela("bdd" + tag);
      const v = await stored(q);
      v.rounds = [jornada("r_bdd" + tag + "1", 1, dl), jornada("r_bdd" + tag + "3", 3, enHoras(48), true)];
      v.customBets = [{ id: "cb_old", label: "Antigua", scope: "temporada", points: 1, closesAtRound: 1 }];
      v.customBetsMigrated = true;
      await putStored(q, v);
      const x = await read(q);
      x.rounds = x.rounds.filter((r) => r.number !== 1);
      const w = await write(q, x);
      assert.equal(w.status, 200, JSON.stringify(w.body));
      const bet = (await stored(q)).customBets[0];
      if (dl === null) {
        assert.equal(bet.closeSource, "protective");
        assert.equal((await answer(q, "cb_old", "Otro")).status, 403);
      } else {
        assert.deepEqual([bet.closesAt, bet.closeSource, bet.closesAtRound], [undefined, undefined, 1], "sin tocar");
        assert.equal((await answer(q, "cb_old", "Otro")).status, 200);
      }
    });
  });
}

// Un cierre guardado como número (ms) sí es un cierre real: así lo lee
// betCloseState y así lo leía main (new Date(número)). Borrar o renumerar su
// jornada no le quita el cierre en silencio a una antigua abierta (Technical QA
// sobre 7adcee5); conservarlo de forma explícita, sí; y una cerrada guarda su
// hora real, no una por protección.
test.describe("D4 · una jornada con cierre numérico es un cierre real (servidor real)", () => {
  test.before(setup);
  test.after(teardown);
  const preparar = async (tag, ms) => {
    const q = await quiniela("bdm" + tag);
    const v = await stored(q);
    v.rounds = [jornada("r_bdm" + tag + "1", 1, ms), jornada("r_bdm" + tag + "3", 3, enHoras(48), true)];
    v.customBets = [{ id: "cb_old", label: "Antigua", scope: "temporada", points: 1, closesAtRound: 1 }];
    v.customBetsMigrated = true;
    await putStored(q, v);
    return q;
  };

  itest("abierta: borrar o renumerar su jornada sin elegir es 409; conservar su cierre (la hora real) y borrarla, 200", async () => {
    const ms = Date.now() + 30 * 3600e3;
    const q = await preparar("a", ms);
    let x = await read(q);
    x.rounds = x.rounds.filter((r) => r.number !== 1);
    assert.deepEqual([(await write(q, x)).status], [409]);
    x = await read(q);
    x.rounds.find((r) => r.number === 1).number = 7;
    const w = await write(q, x);
    assert.deepEqual([w.status, w.body.error], [409, "bet_close_legacy"]);
    assert.equal((await stored(q)).customBets[0].closesAt, undefined, "nada cambió");
    x = await read(q);
    x.rounds = x.rounds.filter((r) => r.number !== 1);
    x.customBets[0].closesAt = new Date(ms).toISOString();
    const w2 = await write(q, x);
    assert.equal(w2.status, 200, JSON.stringify(w2.body));
    const bet = (await stored(q)).customBets[0];
    assert.deepEqual([bet.closesAt, bet.closeSource], [new Date(ms).toISOString(), "round"]);
    assert.equal((await answer(q, "cb_old", "Otro")).status, 200, "sigue abierta hasta su hora");
  });

  itest("cerrada: al editar su jornada guarda su hora real (no una por protección) y sigue cerrada", async () => {
    const ms = Date.now() - 5 * 3600e3;
    const q = await preparar("c", ms);
    let x = await read(q);
    x.rounds.find((r) => r.number === 1).deadline = enHoras(30);
    assert.deepEqual([(await write(q, x)).status], [409], "sin conservar su cierre, no");
    x = await read(q);
    x.rounds.find((r) => r.number === 1).deadline = enHoras(30);
    x.customBets[0].closesAt = new Date(ms).toISOString();
    const w = await write(q, x);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const bet = (await stored(q)).customBets[0];
    assert.deepEqual([bet.closesAt, bet.closeSource], [new Date(ms).toISOString(), "round"]);
    assert.equal((await answer(q, "cb_old", "Otro")).status, 403);
  });
});

// Technical QA sobre e9c1f5b: un cierre guardado en otra forma que new Date()
// lee (un arreglo) también es un cierre real, y pasar de un texto a otra forma
// no cuenta como «sin cambios».
test.describe("D4 · un cierre en otra forma (arreglo) es real, y cambiar de forma es un cambio (servidor real)", () => {
  test.before(setup);
  test.after(teardown);
  itest("borrar la jornada con cierre en arreglo es 409; pasar su texto a un arreglo, también", async () => {
    const iso = enHoras(30);
    const q = await quiniela("bdr");
    const v = await stored(q);
    v.rounds = [jornada("r_bdr1", 1, [iso]), jornada("r_bdr3", 3, enHoras(48), true)];
    v.customBets = [{ id: "cb_old", label: "Antigua", scope: "temporada", points: 1, closesAtRound: 1 }];
    v.customBetsMigrated = true;
    await putStored(q, v);
    let x = await read(q);
    x.rounds = x.rounds.filter((r) => r.number !== 1);
    assert.equal((await write(q, x)).status, 409);
    const v2 = await stored(q);
    v2.rounds[0].deadline = iso;
    await putStored(q, v2);
    x = await read(q);
    x.rounds[0].deadline = [iso];
    const w = await write(q, x);
    assert.deepEqual([w.status, w.body.error], [409, "bet_close_legacy"]);
  });
});
