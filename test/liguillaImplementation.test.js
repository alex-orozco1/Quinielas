// DATA-004 — Liga MX Liguilla, implementación.
//
// Los 50 casos adversariales del ticket, numerados igual, más el contrato de
// scoring y la agrupación de fase final. El dataset (test/liguillaDataset.js)
// reproduce las FORMAS reales que DATA-004B observó en season 25539.
//
// Las dos cosas que estos tests existen para impedir:
//
//   1. Que un fixture de fase final desaparezca. 27 de 337 llegan sin round_id;
//      descartarlos borraba la Liguilla entera sin error y sin aviso.
//   2. Que el 1X2 salga de un marcador que incluya prórroga o penales. No falla
//      ruidosamente: produce un resultado plausible y equivocado, se publica, y
//      le paga a la persona equivocada.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const D = require("./liguillaDataset");
const { planCompetitionSync, DIAGNOSTIC, fromDomainEvent: syncFromDomain } = require("../competitionSync");
const { outcomeFromRegulation, buildScoreContract, SCORE_PHASE } = require("../scoreContract");
const line = (phase, side, goals) => ({ phase, side, goals });
const both = (phase, h, a) => [line(phase, "home", h), line(phase, "away", a)];
const sportmonks = require("../providers/sportmonksAdapter");
const sportsDataProvider = require("../sportsDataProvider");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .split("\n").map((line) => {
      for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === "/" && line[i + 1] === "/" && line[i - 1] !== ":") return line.slice(0, i);
      }
      return line;
    }).join("\n");
}

// ---- el puente: payload real -> lo que consume el sync ---------------------

function stagesOf(list = D.STAGES) {
  return sportmonks.toStages({
    stages: list,
    instances: [{ instanceKey: "Apertura", id: "inst-apertura" }, { instanceKey: null, id: "inst-apertura" }],
    providerCompetitionId: D.LIGA_MX,
  });
}
function toSyncFixtures(rawFixtures, stageList = D.STAGES) {
  const stages = stagesOf(stageList);
  const nameById = new Map(stages.map((s) => [s.id, s.name]));
  return sportmonks.toEvents({ fixtures: rawFixtures, stages })
    .map((e) => sportsDataProvider.fromDomainEvent(e, nameById))
    .map((ev) => ({
      providerFixtureId: ev.externalEventId, providerRoundId: ev.round,
      stageId: ev.stageId, stageName: ev.stageName, kickoffAt: ev.dateTime,
      home: ev.participants[0].externalId || ev.participants[0].name ? { id: ev.participants[0].externalId, name: ev.participants[0].name } : null,
      away: ev.participants[1].externalId || ev.participants[1].name ? { id: ev.participants[1].externalId, name: ev.participants[1].name } : null,
      leg: ev.leg, status: ev.status,
    }));
}
const plan = (raws, opts = {}) => planCompetitionSync({
  provider: "sportmonks", existingRounds: [], existingStaged: [],
  fixtures: toSyncFixtures(raws, opts.stages), ...opts,
});
const eventOf = (raw) => sportmonks.toEvents({ fixtures: [raw], stages: stagesOf() })[0];
const roundOf = (matches, over = {}) => ({
  id: "r_1", number: 1, published: false, resultsPublished: false, results: {},
  deadline: "2025-11-27T02:00:00.000Z", provider: "sportmonks", externalRoundId: null,
  matches, ...over,
});
const asMatch = (fx, i = 0) => ({
  id: "m_" + i, externalEventId: String(fx.id), externalProvider: "sportmonks",
  teamA: (fx.participants[0] && fx.participants[0].name) || "",
  teamB: (fx.participants[1] && fx.participants[1].name) || "",
  externalHomeId: fx.participants[0] ? String(fx.participants[0].id) : null,
  externalAwayId: fx.participants[1] ? String(fx.participants[1].id) : null,
  kickoffAt: new Date(fx.starting_at.replace(" ", "T") + "Z").toISOString(),
});

// ==== 1-5 · importación: regular, knockout, legs, dataset mixto =============

test("CASO 1 · fixture regular CON round se importa como siempre", () => {
  const r = plan([D.regular(1, 19500001, "2025-07-11 02:00:00")]);
  assert.equal(r.newRounds.length, 1);
  assert.equal(r.newRounds[0].externalRoundId, "300001");
  assert.equal(r.newRounds[0].number, 300001);
  assert.equal(r.stagedFixtures.length, 0);
});

test("CASO 2 · fixture knockout SIN round entra igual, sin inventarle una", () => {
  const r = plan([D.finalPen]);
  assert.equal(r.newRounds.length, 1, "27 de 337 llegan así: descartarlos borraba la Liguilla");
  assert.equal(r.newRounds[0].externalRoundId, null, "no se fabrica una ronda que el proveedor no dio");
  assert.equal(r.newRounds[0].syncGroupKey, "stage:sportmonks:stage:77479151:leg:2");
  assert.equal(r.newRounds[0].matches[0].externalEventId, "19609342");
  assert.equal(r.diagnostics.length, 0, "no es un error");
});

test("CASO 3 · ida y vuelta son DOS jornadas, no una", () => {
  // Mismo stage, legs distintos y una semana de diferencia: son dos días de
  // partidos, y las votaciones cierran por separado.
  const r = plan([D.qfIda, D.qfVuelta]);
  assert.equal(r.newRounds.length, 2);
  assert.deepEqual(r.newRounds.map((x) => x.matches[0].externalEventId), ["19600010", "19600011"]);
  assert.notEqual(r.newRounds[0].syncGroupKey, r.newRounds[1].syncGroupKey);
  assert.ok(r.newRounds[0].deadline < r.newRounds[1].deadline, "y en orden cronológico");
});

test("CASO 4 · un knockout a partido único (leg 1/1) es una jornada normal", () => {
  const r = plan([D.playIn]);
  assert.equal(r.newRounds.length, 1);
  assert.equal(r.newRounds[0].matches.length, 1);
  assert.equal(r.newRounds[0].syncGroupKey, "stage:sportmonks:stage:77478869:leg:1");
});

test("CASO 5 · 27 fixtures sin round dentro de un dataset mixto: ninguno se pierde", () => {
  const regulars = [];
  for (let n = 1; n <= 17; n++) regulars.push(D.regular(n, 19500000 + n, `2025-07-${String(10 + n).padStart(2, "0")} 02:00:00`));
  const knockouts = [];
  for (let i = 0; i < 27; i++) {
    knockouts.push(D.fixture({
      id: 19700000 + i, stage_id: [77478869, 77478884, 77479071, 77479151][i % 4],
      round_id: null, leg: i % 2 === 0 ? "1/2" : "2/2",
      starting_at: `2025-11-${String(24 + (i % 5)).padStart(2, "0")} 02:00:00`,
      state_id: D.STATE.NOT_STARTED, participants: D.pair(D.TEAMS.a, D.TEAMS.b),
    }));
  }
  const r = plan([...regulars, ...knockouts]);
  const imported = new Set();
  for (const rd of r.newRounds) for (const m of rd.matches) imported.add(m.externalEventId);
  for (const k of knockouts) assert.ok(imported.has(String(k.id)), `el fixture ${k.id} no puede desaparecer`);
  assert.equal(imported.size, 17 + 27, "44 fixtures entran, ninguno se queda fuera");
  assert.equal(r.stagedFixtures.length, 0);
  const numbers = r.newRounds.map((x) => x.number);
  assert.equal(new Set(numbers).size, numbers.length, "y ninguna jornada comparte número con otra");
});

// ==== 6-11 · idempotencia, concurrencia, orden, horarios ===================

function applyPlanToRounds(rounds, planResult) {
  // Simula lo que hace el servidor: asignar ids y persistir.
  const next = rounds.map((r) => ({ ...r, matches: r.matches.map((m) => ({ ...m })) }));
  planResult.newRounds.forEach((nr, i) => {
    next.push({ ...nr, id: "r_new_" + i + "_" + nr.number, matches: nr.matches.map((m, j) => ({ id: `m_${i}_${j}_${m.externalEventId}`, ...m })) });
  });
  const byId = new Map(next.map((r) => [r.id, r]));
  for (const add of planResult.matchAdditions) {
    const r = byId.get(add.roundId);
    if (r) r.matches.push({ id: "m_add_" + add.match.externalEventId, ...add.match });
  }
  for (const upd of planResult.matchUpdates) {
    const r = byId.get(upd.roundId);
    const m = r && r.matches.find((x) => x.id === upd.matchId);
    if (m) Object.assign(m, upd.changes);
  }
  return next;
}
const allMatchIds = (rounds) => rounds.flatMap((r) => r.matches.map((m) => m.externalEventId));

test("CASO 6 · el mismo sync dos veces no duplica nada", () => {
  const raws = [D.playIn, D.qfIda, D.qfVuelta, D.finalPen];
  const first = plan(raws);
  const stored = applyPlanToRounds([], first);
  const second = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures(raws) });
  assert.equal(second.newRounds.length, 0);
  assert.equal(second.matchAdditions.length, 0);
  assert.equal(second.matchUpdates.length, 0);
  assert.equal(second.stagedFixtures.length, 0);
});

test("CASO 7 · diez syncs idénticos dejan exactamente el mismo estado", () => {
  const raws = [D.playIn, D.qfIda, D.qfVuelta, D.finalPen];
  let rounds = applyPlanToRounds([], plan(raws));
  const shape = () => JSON.stringify(rounds.map((r) => ({ n: r.number, k: r.syncGroupKey, m: r.matches.map((x) => x.externalEventId).sort() })));
  const first = shape();
  for (let i = 0; i < 9; i++) {
    rounds = applyPlanToRounds(rounds, planCompetitionSync({ provider: "sportmonks", existingRounds: rounds, fixtures: toSyncFixtures(raws) }));
  }
  assert.equal(shape(), first, "diez veces y sigue igual");
  assert.equal(new Set(allMatchIds(rounds)).size, allMatchIds(rounds).length, "ningún partido repetido");
});

test("CASO 8 · dos planificaciones concurrentes sobre el mismo estado proponen lo mismo", () => {
  // El servidor las serializa con el lock de fila; lo que esta prueba fija es
  // que el plan en sí es determinista, así que el ganador da igual.
  const raws = [D.qfIda, D.qfVuelta];
  const a = plan(raws), b = plan(raws);
  assert.deepEqual(JSON.stringify(a.newRounds), JSON.stringify(b.newRounds));
});

test("CASO 9 · el calendario al revés produce el MISMO resultado", () => {
  const forward = plan([D.playIn, D.qfIda, D.qfVuelta, D.finalPen]);
  const backward = plan([D.finalPen, D.qfVuelta, D.qfIda, D.playIn]);
  const shape = (r) => r.newRounds.map((x) => [x.number, x.syncGroupKey, x.matches.map((m) => m.externalEventId)]);
  assert.deepEqual(shape(forward), shape(backward));
  // Y en orden cronológico: con el orden de llegada, la Final quedaba primera.
  assert.deepEqual(shape(forward).map((x) => x[2][0]), ["19600001", "19600010", "19600011", "19609342"]);
});

test("CASO 10 · varios fixtures a la misma hora se ordenan de forma determinista", () => {
  const at = "2025-11-27 02:00:00";
  const mk = (id) => D.fixture({ id, stage_id: 77478884, round_id: null, leg: "1/2", starting_at: at, participants: D.pair(D.TEAMS.a, D.TEAMS.b) });
  const one = plan([mk(19600099), mk(19600011), mk(19600055)]);
  const two = plan([mk(19600055), mk(19600099), mk(19600011)]);
  assert.deepEqual(one.newRounds[0].matches.map((m) => m.externalEventId), two.newRounds[0].matches.map((m) => m.externalEventId));
  assert.equal(one.newRounds.length, 1, "misma hora, mismo stage y leg: una jornada");
});

test("CASO 11 · un cambio de horario actualiza el partido y NO mueve el cierre", () => {
  const stored = [roundOf([asMatch(D.qfIda)], { syncGroupKey: "stage:sportmonks:stage:77478884:leg:1", deadline: "2025-11-27T02:00:00.000Z" })];
  const movido = { ...D.qfIda, starting_at: "2025-11-29 02:00:00" };
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([movido]) });
  assert.equal(r.newRounds.length, 0, "no nace un partido nuevo");
  assert.deepEqual(Object.keys(r.matchUpdates[0].changes), ["kickoffAt"]);
  assert.equal(stored[0].deadline, "2025-11-27T02:00:00.000Z", "el cierre es de QRACKS y no se toca");
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.KICKOFF_PAST_DEADLINE), "pero se avisa");
});

// ==== 12-17 · TBD, participantes, identidad ================================

test("CASO 12 · un cruce sin rivales todavía entra en la jornada, sin inventarlos", () => {
  const r = plan([D.sfTbd]);
  assert.equal(r.newRounds.length, 1);
  const m = r.newRounds[0].matches[0];
  assert.equal(m.teamA, ""); assert.equal(m.teamB, "");
  assert.equal(m.externalHomeId, null); assert.equal(m.externalAwayId, null);
  assert.equal(m.externalEventId, "19600020", "pero su identidad sí existe");
  assert.equal(eventOf(D.sfTbd).tbdState, "pending");
});

test("CASO 13 · con un solo participante conocido tampoco se inventa el otro", () => {
  const medio = D.fixture({ id: 19600021, stage_id: 77479071, round_id: null, leg: "1/2",
    starting_at: "2025-12-04 02:00:00", participants: [D.home(D.TEAMS.a)] });
  const r = plan([medio]);
  const m = r.newRounds[0].matches[0];
  assert.equal(m.teamA, "Club A");
  assert.equal(m.teamB, "", "el rival sigue sin saberse, y así se queda");
  assert.equal(eventOf(medio).tbdState, "pending");
});

test("CASO 14 · TBD -> dos participantes actualiza el MISMO partido", () => {
  const stored = [roundOf([asMatch(D.sfTbd)], { syncGroupKey: "stage:sportmonks:stage:77479071:leg:1" })];
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([D.sfResuelta]) });
  assert.equal(r.newRounds.length, 0, "no nace una segunda jornada");
  assert.equal(r.matchAdditions.length, 0, "ni un segundo partido");
  assert.equal(r.matchUpdates.length, 1);
  assert.equal(r.matchUpdates[0].changes.teamA, "Club A");
  assert.equal(r.matchUpdates[0].changes.teamB, "Club C");
  assert.equal(eventOf(D.sfResuelta).tbdState, "resolved");
});

test("CASO 15 · un cambio de local/visitante se aplica sobre el mismo partido", () => {
  const stored = [roundOf([asMatch(D.qfIda)], { syncGroupKey: "stage:sportmonks:stage:77478884:leg:1" })];
  const invertido = { ...D.qfIda, participants: D.pair(D.TEAMS.b, D.TEAMS.a) };
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([invertido]) });
  assert.equal(r.matchUpdates.length, 1);
  assert.equal(r.matchUpdates[0].changes.teamA, "Club B");
  assert.equal(r.matchUpdates[0].matchId, "m_0", "el mismo partido, no otro");
});

test("CASO 16 · un fixture con id desconocido pero muy parecido a otro es OTRO partido", () => {
  // Mismos equipos, mismo stage, mismo minuto. Sólo cambia el id. DATA-004B
  // dejó SIN PROBAR que Sportmonks conserve el id al resolver un TBD, así que
  // fusionarlos "porque parecen el mismo" es cómo se pierde un partido.
  const stored = [roundOf([asMatch(D.qfIda)], { syncGroupKey: "stage:sportmonks:stage:77478884:leg:1" })];
  const gemelo = { ...D.qfIda, id: 19600999 };
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([gemelo]) });
  assert.equal(r.matchUpdates.length, 0, "no se toca el existente");
  assert.equal(r.matchAdditions.length, 1, "se añade como partido nuevo, visible");
  assert.equal(r.matchAdditions[0].match.externalEventId, "19600999");
});

test("CASO 17 · un fixture que desaparece del proveedor NO se borra", () => {
  const stored = [roundOf([asMatch(D.qfIda, 0), asMatch(D.qfVuelta, 1)], { syncGroupKey: "stage:sportmonks:stage:77478884:leg:1" })];
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([D.qfIda]) });
  assert.equal(stored[0].matches.length, 2, "sigue habiendo dos partidos");
  assert.ok(!JSON.stringify(r).includes("delete"), "el plan no propone borrar nada");
  assert.equal(r.matchUpdates.length, 0);
});

// ==== 18-20 · estados del partido =========================================

test("CASO 18-20 · cancelado, pospuesto y suspendido/desconocido se mapean sin adivinar", () => {
  const st = (state_id) => eventOf(D.fixture({ id: 19600030 + state_id, stage_id: 77478884, round_id: null, starting_at: "2025-11-27 02:00:00", state_id, participants: D.pair(D.TEAMS.a, D.TEAMS.b) }));
  assert.equal(st(D.STATE.CANCELLED).status, "cancelled");
  assert.equal(st(D.STATE.POSTPONED).status, "postponed");
  assert.equal(st(D.STATE.SUSPENDED).status, "unknown", "14 no está documentado: no se adivina");
  assert.equal(st(D.STATE.DELETED).status, "unknown");
  assert.equal(st(D.STATE.NOT_STARTED).status, "scheduled");
  assert.equal(st(D.STATE.INPLAY).status, "live");
  // Y un partido cancelado o pospuesto se sigue importando: es información del
  // calendario, no un error.
  const r = plan([D.fixture({ id: 19600040, stage_id: 77478884, round_id: null, starting_at: "2025-11-27 02:00:00", state_id: D.STATE.POSTPONED, participants: D.pair(D.TEAMS.a, D.TEAMS.b) })]);
  assert.equal(r.newRounds.length, 1);
});

// ==== 21-31 · EL CONTRATO DE SCORING ======================================

const reg = (raw) => eventOf(raw).regulationScore;
const outcome = (raw, homeIsTeamA = true) => outcomeFromRegulation(eventOf(raw).regulationScore, homeIsTeamA);

test("CASO 21 · FT normal: el 1X2 sale del marcador a 90'", () => {
  const raw = D.regular(1, 19500001, "2025-07-11 02:00:00");
  assert.deepEqual(reg(raw), { home: 2, away: 1 });
  assert.equal(outcome(raw), "A");
});

test("CASO 22-24 · empate, local y visitante a 90'", () => {
  const mk = (h, a) => D.fixture({ id: 19600050 + h * 10 + a, stage_id: 77478884, round_id: null,
    starting_at: "2025-11-27 02:00:00", state_id: D.STATE.FT, participants: D.pair(D.TEAMS.a, D.TEAMS.b),
    scores: [...D.score("2ND_HALF", D.TYPE.SECOND_HALF, D.pair(D.TEAMS.a, D.TEAMS.b), h, a),
             ...D.score("CURRENT", D.TYPE.CURRENT, D.pair(D.TEAMS.a, D.TEAMS.b), h, a)] });
  assert.equal(outcome(mk(1, 1)), "D");
  assert.equal(outcome(mk(2, 0)), "A");
  assert.equal(outcome(mk(0, 2)), "B");
  // Y respetando el orden teamA/teamB del tablero cuando el local es el visitante.
  assert.equal(outcome(mk(2, 0), false), "B");
});

test("CASO 25 · empate a 90' con ganador en la PRÓRROGA -> EMPATE", () => {
  assert.deepEqual(reg(D.finalAet), { home: 1, away: 1 }, "los 90 minutos, no el 2-1 final");
  assert.deepEqual(eventOf(D.finalAet).score, { home: 2, away: 1 }, "el final se conserva para mostrar");
  assert.equal(outcome(D.finalAet), "D");
});

test("CASO 26 · empate a 90' con ganador en PENALES -> EMPATE", () => {
  assert.deepEqual(reg(D.finalPen), { home: 1, away: 1 });
  assert.deepEqual(eventOf(D.finalPen).penaltyScore, { home: 5, away: 4 }, "los penales se preservan");
  assert.equal(outcome(D.finalPen), "D", "una Final ganada en penales es EMPATE para QRACKS");
});

test("CASO 26b · 2ND_HALF_ONLY es una trampa, y no se cae en ella", () => {
  // En la Final: 0-1 al descanso, 1-1 a los 90. "2ND_HALF_ONLY" es 1-0 (los
  // goles DENTRO del segundo tiempo). Tomarlo como marcador de regulación daría
  // LOCAL en vez de EMPATE.
  assert.equal(sportmonks.scorePhaseOf("2ND_HALF_ONLY", D.TYPE.SECOND_HALF_ONLY), "partial");
  assert.deepEqual(reg(D.finalPen), { home: 1, away: 1 }, "y no {1,0}");
});

test("CASO 27 · sin 2ND_HALF no se sugiere nada, aunque haya CURRENT", () => {
  const sinReg = { ...D.finalPen, scores: D.score("CURRENT", D.TYPE.CURRENT, D.pair(D.TEAMS.a, D.TEAMS.c), 3, 1) };
  assert.equal(reg(sinReg), null);
  assert.equal(outcome(sinReg), null);
});

test("CASO 28 · 2ND_HALF duplicado y contradictorio -> null", () => {
  const dup = { ...D.finalPen, scores: [
    ...D.score("2ND_HALF", D.TYPE.SECOND_HALF, D.pair(D.TEAMS.a, D.TEAMS.c), 1, 1),
    ...D.score("2ND_HALF", D.TYPE.SECOND_HALF, D.pair(D.TEAMS.a, D.TEAMS.c), 2, 1),
  ] };
  assert.equal(reg(dup), null, "elegir uno sería un primer-gana silencioso");
});

test("CASO 29 · SÓLO CURRENT: sirve si el estado prueba los 90, y sólo entonces", () => {
  const soloCurrent = (state_id) => D.fixture({ id: 19600060 + state_id, stage_id: 77478884, round_id: null,
    starting_at: "2025-11-27 02:00:00", state_id, participants: D.pair(D.TEAMS.a, D.TEAMS.b),
    scores: D.score("CURRENT", D.TYPE.CURRENT, D.pair(D.TEAMS.a, D.TEAMS.b), 2, 1) });
  assert.deepEqual(reg(soloCurrent(D.STATE.FT)), { home: 2, away: 1 }, "FT: no hubo nada después de los 90");
  assert.equal(reg(soloCurrent(D.STATE.AET)), null, "AET: ese marcador puede incluir la prórroga");
  assert.equal(reg(soloCurrent(D.STATE.FT_PEN)), null);
  assert.equal(reg(soloCurrent(D.STATE.INPLAY)), null, "en juego no hay resultado que sugerir");
});

test("CASO 30 · sólo final/ET disponible -> null", () => {
  const soloEt = { ...D.finalAet, scores: [
    ...D.score("ET_2ND_HALF", D.TYPE.ET_SECOND_HALF, D.pair(D.TEAMS.c, D.TEAMS.a), 2, 1),
    ...D.score("CURRENT", D.TYPE.CURRENT, D.pair(D.TEAMS.c, D.TEAMS.a), 2, 1),
  ] };
  assert.equal(reg(soloEt), null, "no se reconstruye 90' restando la prórroga");
});

test("CASO 31 · marcadores malformados -> null, nunca un número inventado", () => {
  const malos = [
    [{ id: 1, type_id: D.TYPE.SECOND_HALF, description: "2ND_HALF", score: { participant_id: D.TEAMS.a.id, goals: "dos", participant: "home" } }],
    [{ id: 1, type_id: D.TYPE.SECOND_HALF, description: "2ND_HALF", score: { participant_id: D.TEAMS.a.id, goals: -1, participant: "home" } }],
    [{ id: 1, type_id: D.TYPE.SECOND_HALF, description: "2ND_HALF", score: null }],
    [null],
    "no soy un array",
  ];
  for (const scores of malos) {
    const raw = { ...D.finalPen, scores };
    assert.equal(reg(raw), null, `esperaba null para ${JSON.stringify(scores).slice(0, 60)}`);
  }
});

test("CASO 31b · señales contradictorias entre description y type_id -> null", () => {
  const mentiroso = { ...D.finalPen, scores: [
    { id: 1, type_id: 999, description: "2ND_HALF", score: { participant_id: D.TEAMS.a.id, goals: 1, participant: "home" } },
    { id: 2, type_id: 999, description: "2ND_HALF", score: { participant_id: D.TEAMS.c.id, goals: 1, participant: "away" } },
  ] };
  assert.equal(reg(mentiroso), null, "si las dos señales no coinciden, una de las dos miente");
});

// ==== 32-35 · trabajo del Admin y de los participantes ====================

test("CASO 32-33 · un resultado ya capturado y una jornada publicada no se pisan", () => {
  const stored = [roundOf([asMatch(D.qfIda)], {
    syncGroupKey: "stage:sportmonks:stage:77478884:leg:1",
    published: true, resultsPublished: true, results: { m_0: "A" },
  })];
  const otro = { ...D.qfIda, participants: D.pair(D.TEAMS.c, D.TEAMS.d) };
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([otro]) });
  assert.equal(r.matchUpdates.length, 0, "cambiar los equipos reescribiría el sentido de los picks ya puntuados");
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.LOCKED_BY_RESULTS));
  assert.equal(stored[0].results.m_0, "A");
});

test("CASO 34 · un partido nuevo no se cuela en una jornada ya cerrada", () => {
  const stored = [roundOf([asMatch(D.qfIda)], {
    syncGroupKey: "stage:sportmonks:stage:77478884:leg:1", published: true,
    deadline: "2025-11-27T02:00:00.000Z",
  })];
  const nuevo = D.fixture({ id: 19600777, stage_id: 77478884, round_id: null, leg: "1/2",
    starting_at: "2025-11-27 04:00:00", participants: D.pair(D.TEAMS.c, D.TEAMS.d) });
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored,
    fixtures: toSyncFixtures([nuevo]), now: Date.parse("2025-12-01T00:00:00Z") });
  assert.equal(r.matchAdditions.length, 0, "pedir un pronóstico que nadie pudo hacer no es una opción");
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.ROUND_ALREADY_CLOSED));
  assert.equal(r.stagedFixtures.length, 1, "pero el partido no se pierde");
});

test("CASO 34b · en una jornada ABIERTA sí se añade", () => {
  const stored = [roundOf([asMatch(D.qfIda)], {
    syncGroupKey: "stage:sportmonks:stage:77478884:leg:1", published: true,
    deadline: "2026-11-27T02:00:00.000Z",
  })];
  const nuevo = D.fixture({ id: 19600778, stage_id: 77478884, round_id: null, leg: "1/2",
    starting_at: "2025-11-27 04:00:00", participants: D.pair(D.TEAMS.c, D.TEAMS.d) });
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored,
    fixtures: toSyncFixtures([nuevo]), now: Date.parse("2025-11-20T00:00:00Z") });
  assert.equal(r.newRounds.length, 0, "va a la jornada que ya existe, no funda otra");
  assert.equal(r.matchAdditions.length, 1);
  assert.equal(r.matchAdditions[0].roundId, "r_1");
});

test("CASO 35 · los picks existentes no los toca nada de esto", () => {
  // El plan sólo describe cambios sobre campos del proveedor. Los picks viven en
  // otra fila y ninguna operación del sync los menciona.
  const stored = [roundOf([asMatch(D.sfTbd)], { syncGroupKey: "stage:sportmonks:stage:77479071:leg:1", published: true })];
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([D.sfResuelta]) });
  const touched = new Set(r.matchUpdates.flatMap((u) => Object.keys(u.changes)));
  for (const forbidden of ["id", "results", "resultsPublished", "published", "deadline"]) {
    assert.ok(!touched.has(forbidden), `el sync no puede tocar ${forbidden}`);
  }
  assert.equal(r.matchUpdates[0].matchId, "m_0", "y el id del partido no cambia, así que el pick sigue apuntando a él");
});

// ==== 41 · monetización ===================================================

test("CASO 41 · la fase final vive en el MISMO Tournament Scope", () => {
  // La prueba de verdad es que nada del sync toca la identidad comercial: no
  // hay ciclo nuevo, ni entitlement, ni scope en todo el camino de importación.
  const sync = stripComments(serverSrc.slice(serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"')));
  const body = sync.slice(0, sync.indexOf("\n});"));
  assert.ok(!/buildNextScope|advanceTournamentCycle|editionSeq\s*\+/.test(body),
    "importar la fase final no puede mover el ciclo comercial");
  assert.ok(!/applyEntitlementGrant|buildPlusEntitlement/.test(body), "ni conceder plan");
  assert.ok(!/recordConsumption/.test(body), "ni consumir jornadas: importar no cobra, publicar sí");
});

// ==== 44-50 · datos parciales y cosas que cambian de nombre ===============

test("CASO 44 · si el proveedor devuelve sólo algunos stages, lo que llegó se importa", () => {
  const parcial = D.STAGES.filter((s) => s.id !== 77479151);
  const r = plan([D.qfIda, D.finalPen], { stages: parcial });
  // El fixture de la Final referencia un stage que no vino: se importa igual,
  // porque su identidad es el fixture, no el stage.
  const ids = r.newRounds.flatMap((x) => x.matches.map((m) => m.externalEventId));
  assert.ok(ids.includes("19600010"));
  assert.ok(ids.includes("19609342") || r.stagedFixtures.some((f) => f.providerFixtureId === "19609342"),
    "no puede desaparecer por venir sin su stage");
});

test("CASO 45 · un fixture que el proveedor omite temporalmente vuelve sin duplicarse", () => {
  const raws = [D.qfIda, D.qfVuelta];
  const rounds = applyPlanToRounds([], plan(raws));
  // Desaparece...
  const sin = planCompetitionSync({ provider: "sportmonks", existingRounds: rounds, fixtures: toSyncFixtures([D.qfIda]) });
  assert.equal(sin.newRounds.length, 0);
  assert.equal(allMatchIds(rounds).length, 2, "sigue estando");
  // ...y vuelve.
  const vuelve = planCompetitionSync({ provider: "sportmonks", existingRounds: rounds, fixtures: toSyncFixtures(raws) });
  assert.equal(vuelve.newRounds.length, 0);
  assert.equal(vuelve.matchAdditions.length, 0, "no se añade una segunda copia");
});

test("CASO 46-48 · cambian nombres de stage, temporada o equipo: la identidad no se mueve", () => {
  const renombrado = D.STAGES.map((s) => s.id === 77478884 ? { ...s, name: "Apertura, Cuartos de Final (MX)" } : s);
  const base = plan([D.qfIda]);
  const conNombreNuevo = plan([D.qfIda], { stages: renombrado });
  assert.equal(base.newRounds[0].syncGroupKey, conNombreNuevo.newRounds[0].syncGroupKey,
    "la clave de agrupación no puede depender de un nombre");
  assert.notEqual(base.newRounds[0].phaseLabel, conNombreNuevo.newRounds[0].phaseLabel,
    "la etiqueta SÍ cambia: es sólo para mostrar");
  // Cambiar el nombre de un equipo actualiza el texto, no la identidad.
  const stored = [roundOf([asMatch(D.qfIda)], { syncGroupKey: "stage:sportmonks:stage:77478884:leg:1" })];
  const equipoRenombrado = { ...D.qfIda, participants: D.pair({ ...D.TEAMS.a, name: "Club A FC" }, D.TEAMS.b) };
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([equipoRenombrado]) });
  assert.equal(r.matchUpdates.length, 1);
  assert.equal(r.matchUpdates[0].changes.teamA, "Club A FC");
  assert.equal(r.matchUpdates[0].changes.externalHomeId, undefined, "el id no cambió, así que no se reescribe");
});

test("CASO 49-50 · leg null y aggregate_id null no rompen nada", () => {
  const sinLeg = D.fixture({ id: 19600800, stage_id: 77478884, round_id: null, leg: null,
    starting_at: "2025-11-27 02:00:00", participants: D.pair(D.TEAMS.a, D.TEAMS.b) });
  const e = eventOf(sinLeg);
  assert.equal(e.leg, null);
  assert.equal(e.aggregateKey, null, "aggregate_id no es identidad de nada");
  const r = plan([sinLeg]);
  assert.equal(r.newRounds.length, 1, "sin leg se agrupa por stage y ventana temporal");
  assert.equal(r.newRounds[0].syncGroupKey, "stage:sportmonks:stage:77478884:leg:none");
});

// ==== el camino Sportmonks completo, con cliente inyectado ================

test("EXTREMO A EXTREMO · la temporada real entra completa por el camino Sportmonks", async () => {
  const byStage = new Map([
    [77476863, [D.regular(1, 19500001, "2025-07-11 02:00:00"), D.regular(2, 19500002, "2025-07-18 02:00:00")]],
    [77478869, [D.playIn]],
    [77478884, [D.qfIda, D.qfVuelta]],
    [77479071, [D.sfTbd]],
    [77479151, [D.finalAet, D.finalPen]],
  ]);
  const client = {
    async getSeasonWithStages() { return D.seasonPayload(); },
    async getStageFixtures(stageId) {
      const list = byStage.get(Number(stageId));
      if (!list) throw new Error("stage no cubierto por el plan");
      return D.stagePayload(D.STAGES.find((s) => s.id === Number(stageId)), list);
    },
  };
  const events = await sportsDataProvider.getSportmonksSeasonEvents({ seasonId: D.SEASON, competitionId: D.LIGA_MX, client });
  assert.equal(events.length, 8, "los ocho fixtures llegan al producto");
  assert.ok(events.every((e) => e.externalEventId), "todos con identidad");
  assert.ok(events.some((e) => e.round == null), "y los de fase final sin ronda, como en la realidad");

  const r = planCompetitionSync({
    provider: "sportmonks", existingRounds: [],
    fixtures: events.map((ev) => ({
      providerFixtureId: ev.externalEventId, providerRoundId: ev.round, stageId: ev.stageId,
      stageName: ev.stageName, kickoffAt: ev.dateTime, leg: ev.leg, status: ev.status,
      home: ev.participants[0].name ? { id: ev.participants[0].externalId, name: ev.participants[0].name } : null,
      away: ev.participants[1].name ? { id: ev.participants[1].externalId, name: ev.participants[1].name } : null,
    })),
  });
  const imported = r.newRounds.flatMap((x) => x.matches.map((m) => m.externalEventId));
  assert.equal(imported.length, 8, "y los ocho quedan dentro de una jornada");
  assert.equal(new Set(imported).size, 8);
  assert.equal(r.stagedFixtures.length, 0);
  const numbers = r.newRounds.map((x) => x.number);
  assert.equal(new Set(numbers).size, numbers.length, "sin números repetidos");
  // El 1X2 de la Final por penales, extremo a extremo.
  const finalEvent = events.find((e) => e.externalEventId === "19609342");
  assert.deepEqual(finalEvent.regulationScore, { home: 1, away: 1 });
  assert.equal(outcomeFromRegulation(finalEvent.regulationScore, true), "D");
});

test("EXTREMO A EXTREMO · un stage que el plan no cubre no tumba la importación", () => {
  // Se comprueba sobre el código: el bucle por stages captura y continúa.
  const src = stripComments(fs.readFileSync(path.join(__dirname, "..", "sportsDataProvider.js"), "utf8"));
  const at = src.indexOf("async function getSportmonksSeasonEvents");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.ok(/catch \(err\) \{\s*continue;/.test(body),
    "perder toda la temporada porque un stage falla es la pérdida silenciosa que este ticket combate");
});

// ==== proveedor: opt-in explícito =========================================

test("PROVEEDOR · sin configuración explícita, nada cambia para las quinielas de hoy", () => {
  const src = stripComments(serverSrc);
  const fn = src.slice(src.indexOf("function providerOf(meta)"), src.indexOf("function providerOf(meta)") + 300);
  assert.ok(fn.includes('return SUPPORTED_PROVIDERS.includes(p) ? p : "thesportsdb"'),
    "el default es el de siempre: ninguna quiniela existente cambia de comportamiento");
  assert.ok(!/sportsdbSeason.*sportmonks|name.*includes.*Liga MX/i.test(src),
    "ninguna heurística sobre nombres puede elegir proveedor");
});

test("HALLAZGO · el horario de Sportmonks se normaliza en el puente, o cada sync inventa un cambio", () => {
  // Encontrado escribiendo el CASO 17. Sportmonks manda "2025-12-15 02:00:00":
  // sin T y sin zona. Sin normalizar, `new Date()` lo lee como hora LOCAL —el
  // partido se movía— y además, como lo guardado sí es ISO, cada sync veía un
  // cambio de horario inexistente y proponía la misma actualización para
  // siempre.
  assert.equal(sportsDataProvider.normalizeProviderTimestamp("2025-12-15 02:00:00"), "2025-12-15T02:00:00.000Z");
  assert.equal(sportsDataProvider.normalizeProviderTimestamp("basura"), null, "una fecha ilegible es null, no un NaN disfrazado");
  const [ev] = toSyncFixtures([D.finalPen]);
  assert.equal(ev.kickoffAt, "2025-12-15T02:00:00.000Z");
  // Y la prueba que importa: dos syncs seguidos no proponen nada.
  const stored = [roundOf([asMatch(D.finalPen)], { syncGroupKey: "stage:sportmonks:stage:77479151:leg:2" })];
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([D.finalPen]) });
  assert.equal(r.matchUpdates.length, 0, "sin cambios reales, cero actualizaciones");
});

// ==== Admin UX (§6) ========================================================

test("UX · el Admin entiende qué pasó sin una sola palabra técnica", () => {
  const ui = stripComments(indexSrc);
  const at = ui.indexOf("const SYNC_DIAGNOSTIC_COPY");
  assert.ok(at !== -1, "cada motivo tiene que tener su frase");
  const block = ui.slice(at, ui.indexOf("const SYNC_BENIGN", at));
  // Se revisan las FRASES, no las claves: los códigos son nombres internos que
  // el usuario nunca ve.
  const frases = [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(frases.length >= 10, "cada motivo tiene que tener su frase");
  for (const frase of frases) {
    for (const jerga of ["round_id", "stage_id", "fixture", "JSON", "provider", "regulationScore", "null", "2ND_HALF", "stage"]) {
      assert.ok(!frase.toLowerCase().includes(jerga.toLowerCase()), `el copy no puede decir "${jerga}": ${frase}`);
    }
  }
  // Y todos los códigos que el servidor emite tienen frase.
  const codes = [...stripComments(fs.readFileSync(path.join(__dirname, "..", "competitionSync.js"), "utf8"))
    .matchAll(/^\s+[A-Z_]+: "([a-z_]+)",/gm)].map((m) => m[1]);
  for (const c of codes) assert.ok(block.includes(c + ":"), `falta el mensaje para ${c}`);
});

test("UX · lo normal no se presenta como alarma", () => {
  const ui = stripComments(indexSrc);
  assert.ok(ui.includes("const SYNC_BENIGN = new Set"), "hay motivos que son informativos, no problemas");
  assert.ok(/reasons = \[\.\.\.new Set/.test(ui),
    "un motivo por línea, no un partido por línea: diez sin horario son UNA cosa que revisar");
  assert.ok(ui.includes("pendiente${pendientes===1?\"\":\"s\"} de rival"),
    "un cruce sin rival se dice en una línea, sin dramatizar");
});

test("UX · la etiqueta de fase se muestra, pero nunca es identidad", () => {
  const ui = stripComments(indexSrc);
  assert.ok(ui.includes("r.phaseLabel ?"), "si el proveedor la manda, se muestra");
  const sync = stripComments(fs.readFileSync(path.join(__dirname, "..", "competitionSync.js"), "utf8"));
  assert.ok(!/groupKeyOf[\s\S]{0,400}stageName/.test(sync), "y jamás entra en la clave de agrupación");
  assert.ok(!/phaseLabel[^\n]*(===|includes|match)/.test(sync), "ni en ninguna decisión");
});

test("UX · el import reporta también los partidos agregados a jornadas existentes", () => {
  const ui = stripComments(indexSrc);
  assert.ok(ui.includes("data.addedMatches > 0"),
    "un sync que agregó tres partidos a la jornada de Cuartos no puede decir 'no hay nada nuevo'");
});

test("UX · tras importar, la pestaña trae el estado nuevo antes de repintar", () => {
  // Encontrado en el navegador real, no en un test: el import lo hace el
  // servidor, y sin refrescar, la pestaña repintaba desde su copia vieja. El
  // Admin importaba la Liguilla entera y no veía ni una jornada nueva.
  const ui = stripComments(indexSrc);
  const at = ui.indexOf("data.createdRounds > 0 || data.updatedMatches > 0 || data.addedMatches > 0){");
  assert.ok(at !== -1);
  const block = ui.slice(at, at + 700);
  assert.ok(block.includes("await getMeta({ owner: adminOrOwnerCred() })"), "hay que traer lo que el servidor importó");
  assert.ok(block.includes("Object.assign(meta, fresh)"));
  assert.ok(block.includes("await renderAdmin("), "y esperar al repintado, que es asíncrono");
  const statusAt = ui.indexOf("const statusEl = document.getElementById(\"qz-sync-status\")");
  assert.ok(statusAt > at, "el mensaje se escribe DESPUÉS de repintar, o se borra solo");
});

test("UX · renderAdmin devuelve la promesa de su sub-render", () => {
  const ui = stripComments(indexSrc);
  assert.ok(ui.includes("async function renderAdmin(main){"));
  assert.ok(ui.includes('if(adminSubTab==="rondas") return renderAdminRondas(body);'),
    "sin devolverla, quien escriba algo después del repintado lo ve desaparecer");
});

test("ADVERSARIAL · un partido que llega tarde entra en SU ventana, no funda una duplicada", () => {
  // Encontrado revisando el propio diseño. El mismo stage y leg jugados en dos
  // semanas son dos jornadas y comparten clave estructural. Si el dueño se
  // buscara sólo por clave, el segundo partido de la primera semana habría
  // aterrizado en la jornada equivocada; si la clave llevara un índice de
  // ventana, no habría encontrado ninguna y habría fundado una tercera.
  const semana1 = D.fixture({ id: 19601001, stage_id: 77478884, round_id: null, leg: "1/2",
    starting_at: "2025-11-27 02:00:00", participants: D.pair(D.TEAMS.a, D.TEAMS.b) });
  const semana2 = D.fixture({ id: 19601002, stage_id: 77478884, round_id: null, leg: "1/2",
    starting_at: "2025-12-11 02:00:00", participants: D.pair(D.TEAMS.c, D.TEAMS.d) });
  const first = plan([semana1, semana2]);
  assert.equal(first.newRounds.length, 2, "dos ventanas, dos jornadas");
  assert.equal(first.newRounds[0].syncGroupKey, first.newRounds[1].syncGroupKey, "y comparten clave");

  const stored = applyPlanToRounds([], first);
  // Ahora llega un tercer partido, en la ventana de la PRIMERA jornada.
  const tardio = D.fixture({ id: 19601003, stage_id: 77478884, round_id: null, leg: "1/2",
    starting_at: "2025-11-28 02:00:00", participants: D.pair(D.TEAMS.a, D.TEAMS.c) });
  const second = planCompetitionSync({ provider: "sportmonks", existingRounds: stored,
    fixtures: toSyncFixtures([semana1, semana2, tardio]) });
  assert.equal(second.newRounds.length, 0, "no funda una tercera jornada");
  assert.equal(second.matchAdditions.length, 1);
  const destino = stored.find((r) => r.id === second.matchAdditions[0].roundId);
  assert.equal(destino.number, first.newRounds[0].number, "y aterriza en la jornada de SU semana");
});

// ==== QA Correction 01 — fail-closed del contrato de scoring ===============
//
// Dos P1 encontrados por el QA independiente sobre el commit 7235ccd:
//
//   P1-A · una línea de marcador sin clasificar marcaba el fixture como
//          ambiguo y aun así se devolvía el marcador de regulación si existía.
//          El contrato decía "ante algo que no entendemos, no se puntúa" y el
//          código no lo cumplía.
//   P1-B · "2ND_HALF" sin type_id 2 se convertía en el marcador que puntúa. El
//          contrato aprobado exige las DOS señales.
//
// Los dos comparten la misma consecuencia: un payload retorcido acababa
// produciendo un 1X2. Y un 1X2 equivocado no falla ruidosamente — se publica y
// le paga a la persona equivocada.

const smLine = (description, typeId, h, a) => ([
  { id: 1, type_id: typeId, description, score: { participant_id: D.TEAMS.a.id, goals: h, participant: "home" } },
  { id: 2, type_id: typeId, description, score: { participant_id: D.TEAMS.c.id, goals: a, participant: "away" } },
]);
const conScores = (scores, state_id = D.STATE.FT) => D.fixture({
  id: 19690001, stage_id: 77479151, round_id: null, leg: "2/2",
  starting_at: "2025-12-15 02:00:00", state_id,
  participants: D.pair(D.TEAMS.a, D.TEAMS.c), scores,
});
const regDe = (scores, state_id) => eventOf(conScores(scores, state_id)).regulationScore;

test("QA01 · 1 — 2ND_HALF con type_id 2 sigue siendo válido", () => {
  assert.deepEqual(regDe(smLine("2ND_HALF", 2, 2, 1)), { home: 2, away: 1 });
  assert.equal(outcomeFromRegulation(regDe(smLine("2ND_HALF", 2, 2, 1)), true), "A");
});

test("QA01 · 2 — 2ND_HALF SIN type_id -> null", () => {
  const sinTipo = smLine("2ND_HALF", undefined, 2, 1).map((r) => { const { type_id, ...rest } = r; return rest; });
  assert.equal(regDe(sinTipo), null, "una sola señal no autoriza a puntuar");
});

test("QA01 · 3 — 2ND_HALF con type_id malformado -> null", () => {
  for (const malo of ["2", 2.5, NaN, Infinity, null, true, {}, []]) {
    assert.equal(regDe(smLine("2ND_HALF", malo, 2, 1)), null, `type_id ${JSON.stringify(malo)} no puede autorizar`);
  }
});

test("QA01 · 4 — 2ND_HALF con type_id distinto de 2 -> null", () => {
  for (const otro of [1, 3, 7, 1525]) {
    assert.equal(regDe(smLine("2ND_HALF", otro, 2, 1)), null, `type_id ${otro} contradice la descripción`);
  }
});

test("QA01 · 5 — type_id 2 con OTRA descripción -> null", () => {
  for (const desc of ["CURRENT", "1ST_HALF", "ET", "2ND_HALF_ONLY", "ALGO_NUEVO"]) {
    assert.equal(regDe(smLine(desc, 2, 2, 1)), null, `"${desc}" con type_id 2 es una contradicción`);
  }
});

test("QA01 · 6 — type_id 2 SIN descripción -> null", () => {
  const sinDesc = smLine("2ND_HALF", 2, 2, 1).map((r) => { const { description, ...rest } = r; return rest; });
  assert.equal(regDe(sinDesc), null);
  assert.equal(regDe(smLine(null, 2, 2, 1)), null);
  assert.equal(regDe(smLine("", 2, 2, 1)), null);
});

test("QA01 · 7 — regulación válida + una línea DESCONOCIDA -> null", () => {
  // El caso exacto del P1-A: el 2ND_HALF es impecable, pero hay algo más en el
  // marcador que no sabemos leer. Si no entendemos el payload entero, no
  // sabemos qué partido estamos puntuando.
  const c = buildScoreContract({
    lines: [...both(SCORE_PHASE.REGULATION, 2, 1), ...both(SCORE_PHASE.UNKNOWN, 9, 9)],
    regulationComplete: true,
  });
  assert.equal(c.ambiguous, true);
  assert.equal(c.regulation, null, "ambiguo tiene que significar 'no puntúes esto', también aquí");
  assert.equal(outcomeFromRegulation(c.regulation, true), null);
  // Y por el camino real del adapter.
  assert.equal(regDe([...smLine("2ND_HALF", 2, 2, 1), ...smLine("FASE_NUEVA", 4242, 9, 9)]), null);
});

test("QA01 · 8 — regulación válida + un registro MALFORMADO -> null", () => {
  for (const basura of [null, "no soy un objeto", 42, []]) {
    assert.equal(regDe([...smLine("2ND_HALF", 2, 2, 1), basura]), null,
      `un registro ${JSON.stringify(basura)} junto a la regulación tiene que bloquear`);
  }
  // Y un `score` interno que no es objeto.
  assert.equal(regDe([...smLine("2ND_HALF", 2, 2, 1), { id: 9, type_id: 4, description: "PENALTY_SHOOTOUT", score: "5-4" }]), null);
});

test("QA01 · 9 — regulación válida + un lado irresoluble -> null", () => {
  // Un registro que no se puede atribuir a local ni a visitante. Si es de
  // penales y lo ignoráramos, perderíamos la señal de que hubo penales.
  const huerfano = { id: 9, type_id: 4, description: "PENALTY_SHOOTOUT", score: { participant_id: 999999, goals: 5 } };
  assert.equal(regDe([...smLine("2ND_HALF", 2, 1, 1), huerfano]), null);
  const sinLado = { id: 9, type_id: 4, description: "PENALTY_SHOOTOUT", score: { goals: 5 } };
  assert.equal(regDe([...smLine("2ND_HALF", 2, 1, 1), sinLado]), null);
});

test("QA01 · 10 — FT normal sigue funcionando", () => {
  const raw = D.regular(1, 19500001, "2025-07-11 02:00:00");
  assert.deepEqual(reg(raw), { home: 2, away: 1 });
  assert.equal(outcome(raw), "A");
});

test("QA01 · 11 — AET sigue usando los 90 minutos", () => {
  assert.deepEqual(reg(D.finalAet), { home: 1, away: 1 });
  assert.equal(outcome(D.finalAet), "D", "no el 2-1 tras la prórroga");
});

test("QA01 · 12 — FT_PEN sigue usando los 90 minutos", () => {
  assert.deepEqual(reg(D.finalPen), { home: 1, away: 1 });
  assert.deepEqual(eventOf(D.finalPen).penaltyScore, { home: 5, away: 4 });
  assert.equal(outcome(D.finalPen), "D", "no el 5-4 de los penales");
});

test("QA01 · 13 — 2ND_HALF_ONLY nunca produce regulación", () => {
  assert.equal(sportmonks.scorePhaseOf("2ND_HALF_ONLY", D.TYPE.SECOND_HALF_ONLY), "partial");
  assert.equal(regDe(smLine("2ND_HALF_ONLY", D.TYPE.SECOND_HALF_ONLY, 1, 0)), null);
  // Y su presencia junto al 2ND_HALF real no estorba: es una fase reconocida.
  assert.deepEqual(reg(D.finalPen), { home: 1, away: 1 });
});

test("QA01 · 14 — CURRENT por sí solo nunca produce regulación", () => {
  assert.equal(regDe(smLine("CURRENT", D.TYPE.CURRENT, 3, 1), D.STATE.AET), null);
  assert.equal(regDe(smLine("CURRENT", D.TYPE.CURRENT, 3, 1), D.STATE.FT_PEN), null);
  // El ÚNICO caso en que el marcador final vale como reglamentario: el estado
  // prueba que el partido terminó dentro de los 90 y no hay rastro de nada más.
  assert.deepEqual(regDe(smLine("CURRENT", D.TYPE.CURRENT, 3, 1), D.STATE.FT), { home: 3, away: 1 });
});

test("QA01 · extra — evidencia de regulación ROTA no cae al marcador final", () => {
  // Encontrado revisando este mismo arreglo. Un 2ND_HALF duplicado y
  // contradictorio dejaba `explicitRegulation` en null; con estado FT y un
  // CURRENT presente, el camino de respaldo lo usaba igualmente. Donde hay
  // evidencia de los 90 y está rota, deducirla del final es tapar el problema.
  const c = buildScoreContract({
    lines: [...both(SCORE_PHASE.REGULATION, 1, 1), line(SCORE_PHASE.REGULATION, "home", 2), ...both(SCORE_PHASE.FINAL, 3, 0)],
    regulationComplete: true,
  });
  assert.equal(c.regulation, null);
  assert.ok(c.reasons.includes("duplicate_conflict"));
  // Sin NINGUNA afirmación sobre los 90, el respaldo sí sigue vivo.
  const d = buildScoreContract({ lines: both(SCORE_PHASE.FINAL, 3, 0), regulationComplete: true });
  assert.deepEqual(d.regulation, { home: 3, away: 0 });
});

test("QA01 · el contrato sigue siendo provider-agnostic", () => {
  // La exigencia de doble señal es de Sportmonks y vive en SU adapter.
  // scoreContract no sabe qué es un type_id, y TheSportsDB no tiene ninguno.
  const src = stripComments(fs.readFileSync(path.join(__dirname, "..", "scoreContract.js"), "utf8"));
  assert.ok(!/type_id|sportmonks|2ND_HALF|thesportsdb/i.test(src),
    "scoreContract no puede conocer el vocabulario de ningún proveedor");
  // Y TheSportsDB sigue puntuando por su estado, sin type_id de ninguna clase.
  const raw = (status) => ({ idEvent: "1", idLeague: "4350", intRound: "17", strStatus: status,
    strHomeTeam: "A", strAwayTeam: "B", idHomeTeam: "1", idAwayTeam: "2",
    intHomeScore: "2", intAwayScore: "1", strTimestamp: "2026-08-01T02:00:00" });
  assert.deepEqual(sportsDataProvider.normalizeEvent(raw("FT"), "thesportsdb").regulationScore, { home: 2, away: 1 });
  assert.equal(sportsDataProvider.normalizeEvent(raw("PEN"), "thesportsdb").regulationScore, null);
});

// ==== QA Correction 02 — la identidad lleva proveedor =======================
//
// El contrato siempre dijo `provider + providerFixtureId`, y el sync usaba sólo
// el id. Dos proveedores reparten el mismo número: en cuanto TheSportsDB y
// Sportmonks conviven, un `123` de uno podía ACTUALIZAR el `123` del otro,
// conservando el id interno del partido y con él los picks del partido
// equivocado. Corrupción silenciosa, y de la peor: todo sigue pareciendo bien.

const smFx = (id, over = {}) => ({
  provider: "sportmonks", providerFixtureId: String(id), providerRoundId: null,
  stageId: "sportmonks:stage:77478884", stageName: "Quarter-finals",
  kickoffAt: "2025-11-27T02:00:00.000Z", leg: { number: 1, total: 2 }, status: "scheduled",
  home: { id: "9001", name: "Sportmonks Local" }, away: { id: "9002", name: "Sportmonks Visita" }, ...over,
});
// La ronda 9 y no la 1: en un lote mixto (artificial — una quiniela usa un solo
// proveedor por sync) la jornada 1 se la lleva quien llegue antes por kickoff, y
// la regla de "una jornada existente con ese número siempre gana" taparía lo que
// estas pruebas miden, que es la identidad.
const tsdbFx = (id, over = {}) => ({
  provider: "thesportsdb", providerFixtureId: String(id), providerRoundId: "9",
  stageId: null, stageName: null,
  kickoffAt: "2026-08-01T02:00:00.000Z", leg: null, status: "scheduled",
  home: { id: "1", name: "TSDB Local" }, away: { id: "2", name: "TSDB Visita" }, ...over,
});
const roundCon = (matches, over = {}) => ({
  id: "r_x", number: 1, published: false, resultsPublished: false, results: {},
  deadline: "2026-08-01T00:00:00.000Z", provider: "thesportsdb", externalRoundId: "1",
  matches, ...over,
});
const planCon = (args) => planCompetitionSync({ provider: "sportmonks", existingRounds: [], existingStaged: [], ...args });

test("QA02 · 1 — Sportmonks 123 dos veces = el MISMO partido", () => {
  const first = planCon({ fixtures: [smFx(123)] });
  const stored = applyPlanToRounds([], first);
  const second = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: [smFx(123)] });
  assert.equal(second.newRounds.length, 0);
  assert.equal(second.matchAdditions.length, 0);
  assert.equal(second.matchUpdates.length, 0, "idempotente");
});

test("QA02 · 2 — TheSportsDB 123 y Sportmonks 123 son partidos DISTINTOS", () => {
  const stored = [roundCon([{ id: "m_TSDB", externalEventId: "123", externalProvider: "thesportsdb",
    teamA: "TSDB Local", teamB: "TSDB Visita", externalHomeId: "1", externalAwayId: "2",
    kickoffAt: "2026-08-01T02:00:00.000Z" }])];
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: [smFx(123)] });
  assert.equal(r.matchUpdates.length, 0, "el partido de TheSportsDB no se toca");
  assert.equal(stored[0].matches[0].teamA, "TSDB Local");
  const nace = r.newRounds.length + r.matchAdditions.length;
  assert.ok(nace >= 1, "el de Sportmonks entra como partido propio");
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.CROSS_PROVIDER_ID),
    "y se avisa, porque vistos desde fuera se parecen");
});

test("QA02 · 3 — el mismo id de dos proveedores en un lote NO se deduplica entre sí", () => {
  const r = planCon({ fixtures: [smFx(123), tsdbFx(123)] });
  const ids = r.newRounds.flatMap((x) => x.matches.map((m) => `${m.externalProvider}|${m.externalEventId}`));
  assert.equal(ids.length, 2, "dos partidos, no uno repetido");
  assert.deepEqual(ids.sort(), ["sportmonks|123", "thesportsdb|123"]);
  assert.ok(!r.diagnostics.some((d) => d.code === DIAGNOSTIC.DUPLICATE_FIXTURE_ID),
    "no es un duplicado: son identidades distintas");
});

test("QA02 · 4 — un Sportmonks 123 en espera no lo actualiza un TheSportsDB 123", () => {
  const staged = [{ providerFixtureId: "123", provider: "sportmonks", providerRoundId: null,
    stageId: null, kickoffAt: null, home: null, away: null, leg: null, status: "scheduled" }];
  const r = planCompetitionSync({ provider: "thesportsdb", existingRounds: [], existingStaged: staged,
    fixtures: [tsdbFx(123)] });
  assert.equal(r.stagedUpdates.length, 0, "el pendiente de Sportmonks no se toca");
  assert.equal(r.promotedStagedIds.length, 0);
  assert.equal(r.newRounds.length, 1, "el de TheSportsDB es su propio partido");
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.CROSS_PROVIDER_ID));
});

test("QA02 · 5 — una jornada con TheSportsDB 123 no la actualiza un Sportmonks 123", () => {
  // La reproducción exacta del P1: antes, esto reescribía los equipos del
  // partido de TheSportsDB conservando su id interno — y con él, sus picks.
  const stored = [roundCon([{ id: "m_INTERNO", externalEventId: "123", externalProvider: "thesportsdb",
    teamA: "Necaxa", teamB: "Atlante", externalHomeId: "1", externalAwayId: "2",
    kickoffAt: "2026-08-01T02:00:00.000Z" }], { published: true, deadline: "2030-01-01T00:00:00.000Z" })];
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: [smFx(123)] });
  assert.ok(!r.matchUpdates.some((u) => u.matchId === "m_INTERNO"),
    "el id interno del partido de TheSportsDB no puede aparecer en una actualización de Sportmonks");
  assert.equal(stored[0].matches[0].teamA, "Necaxa", "sus equipos siguen siendo los suyos");
});

test("QA02 · 6 — misma jornada, mismo proveedor, mismo id -> actualización correcta", () => {
  const stored = [roundCon([{ id: "m_SM", externalEventId: "123", externalProvider: "sportmonks",
    teamA: "Por definir", teamB: "Por definir", externalHomeId: null, externalAwayId: null,
    kickoffAt: "2025-11-27T02:00:00.000Z" }], { provider: "sportmonks", externalRoundId: null,
    syncGroupKey: "stage:sportmonks:stage:77478884:leg:1" })];
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: [smFx(123)] });
  assert.equal(r.matchUpdates.length, 1);
  assert.equal(r.matchUpdates[0].matchId, "m_SM");
  assert.equal(r.matchUpdates[0].changes.teamA, "Sportmonks Local");
});

test("QA02 · 7 — un TBD de Sportmonks resuelto por su propia identidad conserva el partido y sus picks", () => {
  const stored = [roundCon([{ id: "m_TBD", externalEventId: "19600020", externalProvider: "sportmonks",
    teamA: "", teamB: "", externalHomeId: null, externalAwayId: null,
    kickoffAt: "2025-12-04T02:00:00.000Z" }], { provider: "sportmonks", externalRoundId: null,
    syncGroupKey: "stage:sportmonks:stage:77479071:leg:1", published: true, deadline: "2030-01-01T00:00:00.000Z" })];
  const r = planCompetitionSync({ provider: "sportmonks", existingRounds: stored, fixtures: toSyncFixtures([D.sfResuelta]) });
  assert.equal(r.newRounds.length, 0);
  assert.equal(r.matchAdditions.length, 0);
  assert.equal(r.matchUpdates.length, 1);
  assert.equal(r.matchUpdates[0].matchId, "m_TBD", "el mismo partido, así que el pick sigue apuntando a él");
  assert.equal(r.matchUpdates[0].changes.teamA, "Club A");
});

test("QA02 · 8 — un partido heredado sin proveedor se atribuye por la jornada que lo importó", () => {
  // Vínculo persistido e inequívoco: el sync que creó la jornada dejó su propio
  // nombre en ella. No es una heurística, es un dato que ya estaba guardado.
  const stored = [roundCon([{ id: "m_LEGACY", externalEventId: "123",
    teamA: "Por definir", teamB: "Por definir", kickoffAt: "2026-08-01T02:00:00.000Z" }])];
  const r = planCompetitionSync({ provider: "thesportsdb", existingRounds: stored, fixtures: [tsdbFx(123)] });
  assert.equal(r.matchUpdates.length, 1, "se reconoce como el mismo partido");
  assert.equal(r.matchUpdates[0].matchId, "m_LEGACY");
  assert.equal(r.matchUpdates[0].changes.externalProvider, "thesportsdb",
    "y GANA su proveedor, para que la identidad sobreviva a una recarga");
  assert.ok(!r.diagnostics.some((d) => d.code === DIAGNOSTIC.UNATTRIBUTABLE_FIXTURE));
});

test("QA02 · 9 — un partido heredado sin proveedor demostrable NO se actualiza por el id", () => {
  // Ni el partido ni su jornada dicen de dónde vino. Adivinarlo por coincidencia
  // de número es exactamente lo que corrompe.
  const stored = [roundCon([{ id: "m_HUERFANO", externalEventId: "123",
    teamA: "Necaxa", teamB: "Atlante", kickoffAt: "2026-08-01T02:00:00.000Z" }], { provider: undefined })];
  const r = planCompetitionSync({ provider: "thesportsdb", existingRounds: stored, fixtures: [tsdbFx(123)] });
  assert.ok(!r.matchUpdates.some((u) => u.matchId === "m_HUERFANO"), "no se toca");
  assert.equal(stored[0].matches[0].teamA, "Necaxa", "ni se fusiona, ni se borra, ni se sobreescribe");
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.UNATTRIBUTABLE_FIXTURE), "se reporta");
});

test("QA02 · 10 — diez reintentos, cero duplicados", () => {
  const fixtures = [smFx(123), smFx(456, { kickoffAt: "2025-11-28T02:00:00.000Z" }), tsdbFx(123)];
  let rounds = applyPlanToRounds([], planCon({ fixtures }));
  const huella = () => rounds.flatMap((r) => r.matches.map((m) => `${m.externalProvider}|${m.externalEventId}`)).sort().join(",");
  const inicial = huella();
  for (let i = 0; i < 10; i++) {
    rounds = applyPlanToRounds(rounds, planCompetitionSync({ provider: "sportmonks", existingRounds: rounds, fixtures }));
  }
  assert.equal(huella(), inicial, "diez veces y el mismo estado");
  const ids = rounds.flatMap((r) => r.matches.map((m) => `${m.externalProvider}|${m.externalEventId}`));
  assert.equal(new Set(ids).size, ids.length, "ninguna identidad repetida");
  assert.equal(ids.length, 3);
});

test("QA02 · 11 — dos planificaciones concurrentes proponen exactamente lo mismo", () => {
  const fixtures = [smFx(123), tsdbFx(123)];
  const a = planCon({ fixtures });
  const b = planCon({ fixtures });
  assert.equal(JSON.stringify(a.newRounds), JSON.stringify(b.newRounds));
});

test("QA02 · 12 — la identidad sobrevive a una recarga: va persistida en el partido", () => {
  const r = planCon({ fixtures: [smFx(123)] });
  const m = r.newRounds[0].matches[0];
  assert.equal(m.externalProvider, "sportmonks", "el proveedor se guarda JUNTO al id externo");
  assert.equal(m.externalEventId, "123");
  // Y lo mismo para lo que queda en espera.
  const s = planCompetitionSync({ provider: "sportmonks", existingRounds: [],
    fixtures: [smFx(789, { stageId: null, providerRoundId: null })] });
  assert.equal(s.stagedFixtures[0].provider, "sportmonks");
  // Un round-trip por JSON —que es lo que hace la base— no pierde nada.
  const revivido = JSON.parse(JSON.stringify(r.newRounds[0]));
  const otra = planCompetitionSync({ provider: "sportmonks",
    existingRounds: [{ ...revivido, id: "r_revivido", matches: revivido.matches.map((x, i) => ({ id: "m_" + i, ...x })) }],
    fixtures: [smFx(123)] });
  assert.equal(otra.matchUpdates.length, 0, "tras recargar sigue siendo el mismo partido");
  assert.equal(otra.newRounds.length, 0);
});

test("QA02 · 13 — TheSportsDB sigue funcionando igual", () => {
  const r = planCompetitionSync({ provider: "thesportsdb", existingRounds: [], fixtures: [tsdbFx(1), tsdbFx(2)] });
  assert.equal(r.newRounds.length, 1);
  assert.equal(r.newRounds[0].externalRoundId, "9");
  assert.equal(r.newRounds[0].matches.length, 2);
  assert.ok(r.newRounds[0].matches.every((m) => m.externalProvider === "thesportsdb"));
});

test("QA02 · 14 — Sportmonks sigue funcionando igual", () => {
  const r = plan([D.playIn, D.qfIda, D.qfVuelta, D.finalPen]);
  assert.equal(r.newRounds.length, 4);
  assert.ok(r.newRounds.every((x) => x.matches.every((m) => m.externalProvider === "sportmonks")));
  assert.equal(r.stagedFixtures.length, 0);
});

test("QA02 · 15 — FT / AET / FT_PEN siguen puntuando por los 90 minutos", () => {
  assert.deepEqual(reg(D.regular(1, 19500001, "2025-07-11 02:00:00")), { home: 2, away: 1 });
  assert.deepEqual(reg(D.finalAet), { home: 1, away: 1 });
  assert.deepEqual(reg(D.finalPen), { home: 1, away: 1 });
  assert.equal(outcome(D.finalPen), "D");
});

test("QA02 · 16 — el camino de resultados también exige la identidad completa", () => {
  const src = stripComments(serverSrc);
  assert.ok(src.includes("const matchProvider = match.externalProvider || round.provider || null;"),
    "el proveedor del partido se resuelve antes de buscar su evento");
  assert.ok(src.includes("findMatchingEvent(events, match, round.deadline, matchProvider)"));
  const sdp = stripComments(fs.readFileSync(path.join(__dirname, "..", "sportsDataProvider.js"), "utf8"));
  assert.ok(sdp.includes('e.externalEventId === String(match.externalEventId) && e.provider === resolvedProvider'),
    "un evento de un proveedor no puede contestar por el partido de otro");
});

test("QA02 · la clave de identidad es inyectiva, o no hay clave", () => {
  // Un nombre de proveedor con el separador dentro rompería la inyectividad y
  // dos partidos distintos podrían colisionar. Ante eso, no hay identidad.
  const r = planCompetitionSync({ provider: "mal|formado", existingRounds: [],
    fixtures: [{ ...smFx(123), provider: "mal|formado" }] });
  assert.equal(r.newRounds.length, 0);
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.MISSING_FIXTURE_ID));
});

test("QA02 · un fixture sin proveedor hereda el del sync, y sin ninguno falla cerrado", () => {
  const conHerencia = planCompetitionSync({ provider: "sportmonks", existingRounds: [],
    fixtures: [{ ...smFx(123), provider: null }] });
  assert.equal(conHerencia.newRounds[0].matches[0].externalProvider, "sportmonks",
    "un lote siempre viene de una importación concreta");
  const sinNada = planCompetitionSync({ provider: null, existingRounds: [],
    fixtures: [{ ...smFx(123), provider: null }] });
  assert.equal(sinNada.newRounds.length, 0);
  assert.ok(sinNada.diagnostics.some((d) => d.code === DIAGNOSTIC.MISSING_FIXTURE_ID));
});
