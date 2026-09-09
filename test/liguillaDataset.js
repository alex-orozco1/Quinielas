// test/liguillaDataset.js — DATA-004 §10.
//
// Dataset de regresión SANITIZADO, con las FORMAS reales que DATA-004B observó
// en Liga MX season 25539. No contiene token, ni cabeceras, ni datos de cuenta,
// ni volcados innecesarios: sólo la estructura mínima para congelar el contrato
// que se demostró.
//
// Lo que reproduce, y por qué cada cosa está aquí:
//
//   - fixture de temporada regular CON round_id;
//   - fixtures de fase final SIN round_id (27 de 337 reales llegan así);
//   - ida y vuelta (leg "1/2" y "2/2") y partido único (leg "1/1");
//   - marcadores separados por fase, incluido el 2ND_HALF que ES el 1X2;
//   - FT, AET y FT_PEN;
//   - TBD sin participantes, y el mismo fixture ya resuelto;
//   - null / desconocido / malformado.
//
// Los ids de stage y fixture son los reales observados donde existían; los de
// equipo son sintéticos a propósito y están marcados como tales — DATA-004A
// dejó dicho que los ids de participante del registro original no eran creíbles,
// y una evidencia mixta etiquetada como real es peor que una sintética honesta.

const LIGA_MX = "743";
const SEASON = 25539;

// type_id observados. El 2 es el del 2ND_HALF y es LA señal aprobada.
const TYPE = Object.freeze({
  FIRST_HALF: 1, SECOND_HALF: 2, PENALTY_SHOOTOUT: 4,
  ET_FIRST_HALF: 5, ET_SECOND_HALF: 6, SECOND_HALF_ONLY: 7, CURRENT: 1525,
});

// state_id: 5 = terminado en los 90; 7 y 8 también son "terminado" para el
// ciclo de vida pero NO prueban nada sobre el tiempo reglamentario.
const STATE = Object.freeze({
  NOT_STARTED: 1, INPLAY: 2, FT: 5, AET: 7, FT_PEN: 8,
  POSTPONED: 10, CANCELLED: 12, SUSPENDED: 14, DELETED: 26,
});

const STAGES = Object.freeze([
  { id: 77476863, season_id: SEASON, type_id: 223, name: "Apertura", sort_order: 1, starting_at: "2025-07-11", ending_at: "2025-11-09" },
  { id: 77479151, season_id: SEASON, type_id: 224, name: "Apertura, Final", sort_order: 5, starting_at: "2025-12-12", ending_at: "2025-12-15" },
  { id: 77478869, season_id: SEASON, type_id: 224, name: "Apertura, Play In", sort_order: 2, starting_at: "2025-11-24", ending_at: "2025-11-24" },
  { id: 77478884, season_id: SEASON, type_id: 224, name: "Apertura, Quarter-finals", sort_order: 3, starting_at: "2025-11-27", ending_at: "2025-12-01" },
  { id: 77479071, season_id: SEASON, type_id: 224, name: "Apertura, Semi-finals", sort_order: 4, starting_at: "2025-12-04", ending_at: "2025-12-08" },
]);

// Participantes SINTÉTICOS. Marcados como tales a propósito (ver cabecera).
const team = (id, name) => ({ id, name, meta: { location: null } });
const home = (t) => ({ ...t, meta: { location: "home" } });
const away = (t) => ({ ...t, meta: { location: "away" } });
const TEAMS = Object.freeze({
  a: team(9001, "Club A"), b: team(9002, "Club B"),
  c: team(9003, "Club C"), d: team(9004, "Club D"),
});

// Un registro de marcador con la forma real: un objeto por lado y por fase.
function score(description, typeId, participants, h, a) {
  return [
    { id: Math.abs(hash(description + "h")), type_id: typeId, description,
      score: { participant_id: participants[0].id, goals: h, participant: "home" } },
    { id: Math.abs(hash(description + "a")), type_id: typeId, description,
      score: { participant_id: participants[1].id, goals: a, participant: "away" } },
  ];
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// Un fixture con la forma real de Sportmonks.
function fixture({ id, stage_id, round_id = null, leg = null, starting_at, state_id = STATE.NOT_STARTED, participants = [], scores = [] }) {
  return { id, league_id: Number(LIGA_MX), season_id: SEASON, stage_id, round_id, aggregate_id: null, leg, starting_at, state_id, participants, scores };
}

const pair = (h, a) => [home(h), away(a)];

// ---- los fixtures ----------------------------------------------------------

// Temporada regular: CON round_id.
const regular = (n, id, at) => fixture({
  id, stage_id: 77476863, round_id: 300000 + n, starting_at: at,
  state_id: STATE.FT, participants: pair(TEAMS.a, TEAMS.b),
  scores: [...score("1ST_HALF", TYPE.FIRST_HALF, pair(TEAMS.a, TEAMS.b), 1, 0),
           ...score("2ND_HALF", TYPE.SECOND_HALF, pair(TEAMS.a, TEAMS.b), 2, 1),
           ...score("CURRENT", TYPE.CURRENT, pair(TEAMS.a, TEAMS.b), 2, 1)],
});

// Play In: partido único, SIN round_id, leg "1/1".
const playIn = fixture({
  id: 19600001, stage_id: 77478869, round_id: null, leg: "1/1",
  starting_at: "2025-11-24 02:00:00", state_id: STATE.FT, participants: pair(TEAMS.c, TEAMS.d),
  scores: [...score("2ND_HALF", TYPE.SECOND_HALF, pair(TEAMS.c, TEAMS.d), 0, 1),
           ...score("CURRENT", TYPE.CURRENT, pair(TEAMS.c, TEAMS.d), 0, 1)],
});

// Cuartos: ida y vuelta, SIN round_id.
const qfIda = fixture({
  id: 19600010, stage_id: 77478884, round_id: null, leg: "1/2",
  starting_at: "2025-11-27 02:00:00", state_id: STATE.FT, participants: pair(TEAMS.a, TEAMS.b),
  scores: [...score("2ND_HALF", TYPE.SECOND_HALF, pair(TEAMS.a, TEAMS.b), 1, 1),
           ...score("CURRENT", TYPE.CURRENT, pair(TEAMS.a, TEAMS.b), 1, 1)],
});
const qfVuelta = fixture({
  id: 19600011, stage_id: 77478884, round_id: null, leg: "2/2",
  starting_at: "2025-12-01 02:00:00", state_id: STATE.FT, participants: pair(TEAMS.b, TEAMS.a),
  scores: [...score("2ND_HALF", TYPE.SECOND_HALF, pair(TEAMS.b, TEAMS.a), 2, 0),
           ...score("CURRENT", TYPE.CURRENT, pair(TEAMS.b, TEAMS.a), 2, 0)],
});

// Semifinal TODAVÍA sin rivales: el caso que la fase final produce siempre.
const sfTbd = fixture({
  id: 19600020, stage_id: 77479071, round_id: null, leg: "1/2",
  starting_at: "2025-12-04 02:00:00", state_id: STATE.NOT_STARTED, participants: [],
});
// El mismo fixture, ya resuelto. MISMO id: es el mismo partido.
const sfResuelta = fixture({
  id: 19600020, stage_id: 77479071, round_id: null, leg: "1/2",
  starting_at: "2025-12-04 02:00:00", state_id: STATE.NOT_STARTED, participants: pair(TEAMS.a, TEAMS.c),
});

// Final decidida en PENALES. El caso que define el contrato de scoring:
// 1-1 a los 90, 1-1 tras la prórroga, 5-4 en penales -> para QRACKS es EMPATE.
const finalPen = fixture({
  id: 19609342, stage_id: 77479151, round_id: null, leg: "2/2",
  starting_at: "2025-12-15 02:00:00", state_id: STATE.FT_PEN, participants: pair(TEAMS.a, TEAMS.c),
  scores: [
    ...score("1ST_HALF", TYPE.FIRST_HALF, pair(TEAMS.a, TEAMS.c), 0, 1),
    ...score("2ND_HALF", TYPE.SECOND_HALF, pair(TEAMS.a, TEAMS.c), 1, 1),
    ...score("2ND_HALF_ONLY", TYPE.SECOND_HALF_ONLY, pair(TEAMS.a, TEAMS.c), 1, 0),
    ...score("ET_1ST_HALF", TYPE.ET_FIRST_HALF, pair(TEAMS.a, TEAMS.c), 1, 1),
    ...score("ET_2ND_HALF", TYPE.ET_SECOND_HALF, pair(TEAMS.a, TEAMS.c), 1, 1),
    ...score("PENALTY_SHOOTOUT", TYPE.PENALTY_SHOOTOUT, pair(TEAMS.a, TEAMS.c), 5, 4),
    ...score("CURRENT", TYPE.CURRENT, pair(TEAMS.a, TEAMS.c), 1, 1),
  ],
});

// Final decidida en PRÓRROGA: 1-1 a los 90, 2-1 tras el tiempo extra.
const finalAet = fixture({
  id: 19609341, stage_id: 77479151, round_id: null, leg: "1/2",
  starting_at: "2025-12-12 02:00:00", state_id: STATE.AET, participants: pair(TEAMS.c, TEAMS.a),
  scores: [
    ...score("2ND_HALF", TYPE.SECOND_HALF, pair(TEAMS.c, TEAMS.a), 1, 1),
    ...score("ET_2ND_HALF", TYPE.ET_SECOND_HALF, pair(TEAMS.c, TEAMS.a), 2, 1),
    ...score("CURRENT", TYPE.CURRENT, pair(TEAMS.c, TEAMS.a), 2, 1),
  ],
});

// Envolturas con la forma que devuelve el cliente.
const seasonPayload = (stages = STAGES) => ({
  id: SEASON, name: "2025/2026", finished: false,
  starting_at: "2025-07-11", ending_at: "2026-05-31", stages,
});
const stagePayload = (stage, fixtures) => ({ ...stage, fixtures });

module.exports = {
  LIGA_MX, SEASON, TYPE, STATE, STAGES, TEAMS,
  fixture, score, pair, home, away,
  regular, playIn, qfIda, qfVuelta, sfTbd, sfResuelta, finalPen, finalAet,
  seasonPayload, stagePayload,
};
