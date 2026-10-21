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
      assert.equal(w.status, 409);
      assert.equal(w.body.error, dl === null ? "bet_close_locked" : "bet_close_legacy", "con null ya contaba como cerrada: no se reabre");
      if (dl === null) return;
      x = await read(q);
      x.rounds.find((r) => r.number === 1).deadline = nuevo;
      x.customBets[0].closesRoundId = "r_bdc" + tag + "1";
      const w2 = await write(q, x);
      assert.equal(w2.status, 200, JSON.stringify(w2.body));
      const bet = (await stored(q)).customBets[0];
      assert.deepEqual([bet.closesAt, bet.closesRoundId, bet.closeSource], [new Date(nuevo).toISOString(), "r_bdc" + tag + "1", "round"]);
    });
  });
}
