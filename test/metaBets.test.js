// metaBets.test.js — el cierre de las preguntas de torneo nuevas.

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBetClosures } = require("../metaBets");

const NOW = Date.parse("2026-10-14T18:00:00Z");
const ronda = (number, deadline) => ({ id: "r_" + number + "abcdef", number, deadline, published: true, matches: [] });
const FUTURA = "2026-10-20T02:00:00.000Z";
const PASADA = "2026-10-10T02:00:00.000Z";
const meta = (customBets, rounds = [ronda(12, FUTURA), ronda(11, PASADA)]) => ({ rounds, customBets });
const torneo = (extra) => ({ id: "cb_campeon01", label: "¿Qué equipo será campeón del torneo?", scope: "temporada", points: 5, ...extra });
const check = (next, prev) => validateBetClosures(next, prev, NOW);

test("preguntas · una de torneo nueva cierra con una jornada que existe y no ha cerrado", () => {
  assert.deepEqual(check(meta([torneo({ closesAtRound: 12 })]), meta([])), { ok: true });
});

test("preguntas · una de torneo nueva sin cierre, o con una jornada que no existe, se rechaza", () => {
  for (const closesAtRound of [undefined, null, 0, 13, 1.5, "12", -1]) {
    assert.deepEqual(check(meta([torneo({ closesAtRound })]), meta([])),
      { ok: false, reason: "bet_close_required", betId: "cb_campeon01" }, String(closesAtRound));
  }
});

test("preguntas · una de torneo nueva ligada a una jornada que ya cerró nacería cerrada: se rechaza", () => {
  assert.deepEqual(check(meta([torneo({ closesAtRound: 11 })]), meta([])),
    { ok: false, reason: "bet_close_past", betId: "cb_campeon01" });
  const sinFecha = meta([torneo({ closesAtRound: 12 })], [ronda(12, "no es fecha")]);
  assert.equal(check(sinFecha, meta([])).reason, "bet_close_past");
});

test("preguntas · las ya guardadas que no cambian de cierre se respetan, aunque no tengan uno válido", () => {
  for (const closesAtRound of [null, undefined, 40, 11]) {
    const antes = meta([torneo({ closesAtRound })]);
    const ahora = meta([torneo({ closesAtRound, points: 8, label: "Campeón" })]);
    assert.deepEqual(check(ahora, antes), { ok: true }, String(closesAtRound));
  }
});

test("preguntas · cambiar el cierre de una guardada, o volverla de torneo, exige un cierre válido", () => {
  const antes = meta([torneo({ closesAtRound: 12 })]);
  assert.equal(check(meta([torneo({ closesAtRound: null })]), antes).reason, "bet_close_required");
  assert.equal(check(meta([torneo({ closesAtRound: 11 })]), antes).reason, "bet_close_past");
  const deJornada = meta([torneo({ scope: "jornada", closesAtRound: null })]);
  assert.equal(check(meta([torneo({ closesAtRound: null })]), deJornada).reason, "bet_close_required");
  assert.deepEqual(check(meta([torneo({ closesAtRound: 12 })]), deJornada), { ok: true });
});

test("preguntas · las de cada jornada no llevan cierre propio: cierran con cada jornada", () => {
  const jornada = { id: "cb_goleador1", label: "¿Qué jugador anotará al menos un gol en esta jornada?", scope: "jornada", points: 3, closesAtRound: null };
  assert.deepEqual(check(meta([jornada]), meta([])), { ok: true });
});

test("preguntas · sin preguntas, o con formas raras, no hay nada que juzgar aquí", () => {
  assert.deepEqual(check({ rounds: [] }, {}), { ok: true });
  assert.deepEqual(check({ customBets: [null, "x", 3] }, {}), { ok: true });
});

test("preguntas · la mudanza única del «goleador» antiguo se respeta tal cual (datos viejos, no una pregunta nueva)", () => {
  const prev = { golScorerBet: { enabled: true, bonusPoints: 3, closesAtRound: 11 }, rounds: [ronda(11, PASADA)] };
  const goleador = (closesAtRound) => ({ id: "cb_migrado1", label: "Goleador de la liga", scope: "temporada", points: 3, closesAtRound });
  for (const closesAtRound of [11, null]) {
    assert.deepEqual(check({ ...prev, customBetsMigrated: true, customBets: [goleador(closesAtRound)] }, prev), { ok: true }, String(closesAtRound));
  }
  // Sólo esa: otra pregunta nueva en el mismo guardado sigue necesitando cierre.
  const otra = torneo({ id: "cb_otra00001", closesAtRound: null });
  assert.equal(check({ ...prev, customBetsMigrated: true, customBets: [goleador(11), otra] }, prev).betId, "cb_otra00001");
  // Ya migrada antes (otra pestaña): una segunda mudanza es una pregunta nueva.
  assert.equal(check({ ...prev, customBetsMigrated: true, customBets: [goleador(11)] }, { ...prev, customBetsMigrated: true }).reason, "bet_close_past");
  // Sin goleador activo no hay nada que mudar.
  assert.equal(check({ customBetsMigrated: true, customBets: [goleador(null)], rounds: [] }, { golScorerBet: { enabled: false } }).reason, "bet_close_required");
});
