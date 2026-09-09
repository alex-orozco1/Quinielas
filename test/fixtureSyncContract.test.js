// DATA-004C — Sports Domain + Sync Foundation.
//
// LO QUE ESTE ARCHIVO FIJA, Y POR QUÉ IMPORTA
//
// 1. IDENTIDAD. La sincronización se clava en provider + providerFixtureId.
//    Antes se clavaba en externalRoundId, y 27 de los 337 fixtures reales de
//    Liga MX 2025/26 llegan con round_id null: para ellos NO HABÍA CLAVE. Quitar
//    el descarte sin cambiar la clave habría duplicado jornadas en cada sync.
//
// 2. SIN RONDA NO ES UN ERROR. Es la fase final. Un fixture sin ronda se
//    conserva; no se descarta y no se le inventa un número de jornada.
//
// 3. EL MARCADOR QUE PUNTÚA ES EL DE 90 MINUTOS. Una Final que termina 1-1 y se
//    define 5-4 en penales es un EMPATE para QRACKS. Derivar el 1X2 del
//    marcador final no falla ruidosamente: paga a la persona equivocada.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { planCompetitionSync, fromProviderEvent, fromDomainEvent, DIAGNOSTIC } = require("../competitionSync");
const { buildScoreContract, outcomeFromRegulation, SCORE_PHASE } = require("../scoreContract");
const domain = require("../sportsDomain");
const sportmonks = require("../providers/sportmonksAdapter");
const sportsDataProvider = require("../sportsDataProvider");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const syncSrc = fs.readFileSync(path.join(__dirname, "..", "competitionSync.js"), "utf8");

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === "/" && line[i + 1] === "/" && line[i - 1] !== ":") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

// Un evento en la forma que produce sportsDataProvider (el camino vivo).
const ev = (o) => ({
  provider: "thesportsdb",
  externalEventId: o.id,
  round: "round" in o ? o.round : "1",
  stageId: o.stageId === undefined ? "stage-regular" : o.stageId,
  stageName: o.stageName || null,
  leg: o.leg || null,
  dateTime: o.at === undefined ? "2026-08-01T02:00:00Z" : o.at,
  participants: [
    { role: "home", externalId: o.homeId === undefined ? "h1" : o.homeId, name: o.home === undefined ? "Local" : o.home },
    { role: "away", externalId: o.awayId === undefined ? "a1" : o.awayId, name: o.away === undefined ? "Visita" : o.away },
  ],
});
const plan = (args) => planCompetitionSync({ provider: "thesportsdb", ...args });
// Un partido guardado por el código actual lleva su proveedor: es la mitad de
// la identidad. Los helpers lo reflejan para que las pruebas midan el estado
// estable, no el momento del backfill.
const withProvider = (m) => (m && m.externalEventId && !m.externalProvider ? { ...m, externalProvider: "thesportsdb" } : m);
const roundOf = (fixtures, over = {}) => ({
  id: "r_1", number: 1, published: true, resultsPublished: false, results: {},
  deadline: "2026-08-01T00:00:00Z", provider: "thesportsdb", externalRoundId: "1",
  matches: (fixtures || []).map(withProvider), ...over,
});

// ==== 1. Identidad e idempotencia ==========================================

test("IDENTIDAD: un fixture nuevo se crea una sola vez", () => {
  const r = plan({ existingRounds: [], events: [ev({ id: "fx1" })] });
  assert.equal(r.newRounds.length, 1);
  assert.equal(r.newRounds[0].matches.length, 1);
  assert.equal(r.newRounds[0].matches[0].externalEventId, "fx1");
});

test("IDENTIDAD: el mismo providerFixtureId no duplica, ni siquiera en otra ronda", () => {
  // El mismo partido reaparece bajo una etiqueta de ronda distinta: sigue
  // siendo el mismo partido. Con la clave vieja (externalRoundId) esto habría
  // creado una jornada nueva con el partido repetido dentro.
  const existing = [roundOf([{ id: "m_1", externalEventId: "fx1", teamA: "Local", teamB: "Visita", kickoffAt: "2026-08-01T02:00:00Z" }])];
  const r = plan({ existingRounds: existing, events: [ev({ id: "fx1", round: "9" })] });
  assert.equal(r.newRounds.length, 0, "no puede nacer una jornada nueva para un fixture ya conocido");
  assert.ok(!r.stagedFixtures.some((f) => f.providerFixtureId === "fx1"));
});

test("IDEMPOTENCIA: un resync idéntico no produce ningún cambio", () => {
  const events = [ev({ id: "fx1" }), ev({ id: "fx2", at: "2026-08-01T04:00:00Z" })];
  const first = plan({ existingRounds: [], events });
  const stored = [roundOf(first.newRounds[0].matches.map((m, i) => ({ id: "m_" + i, ...m })))];
  const second = plan({ existingRounds: stored, events });
  assert.equal(second.newRounds.length, 0);
  assert.equal(second.matchUpdates.length, 0, "sin cambios reales no se emite ninguna actualización");
  assert.equal(second.stagedFixtures.length, 0);
  assert.equal(second.diagnostics.length, 0);
});

test("IDEMPOTENCIA: metadata modificada ACTUALIZA el mismo fixture, no crea otro", () => {
  const stored = [roundOf([{ id: "m_1", externalEventId: "fx1", teamA: "Por definir", teamB: "Por definir", kickoffAt: "2026-08-01T02:00:00Z" }])];
  const r = plan({ existingRounds: stored, events: [ev({ id: "fx1", home: "Toluca", away: "Tigres" })] });
  assert.equal(r.newRounds.length, 0);
  assert.equal(r.matchUpdates.length, 1);
  assert.equal(r.matchUpdates[0].roundId, "r_1");
  assert.equal(r.matchUpdates[0].matchId, "m_1");
  assert.equal(r.matchUpdates[0].changes.teamA, "Toluca");
  assert.equal(r.matchUpdates[0].changes.teamB, "Tigres");
});

test("IDENTIDAD: fixtures distintos nunca colisionan por metadata parecida", () => {
  // Mismos equipos, misma hora, ids distintos: son dos partidos.
  const events = [
    ev({ id: "fxA", home: "Toluca", away: "Tigres", at: "2026-08-01T02:00:00Z" }),
    ev({ id: "fxB", home: "Toluca", away: "Tigres", at: "2026-08-01T02:00:00Z" }),
  ];
  const r = plan({ existingRounds: [], events });
  assert.equal(r.newRounds[0].matches.length, 2);
  assert.deepEqual(r.newRounds[0].matches.map((m) => m.externalEventId).sort(), ["fxA", "fxB"]);
});

test("IDENTIDAD: un fixture sin id NO se descarta en silencio", () => {
  const r = plan({ existingRounds: [], events: [ev({ id: null }), ev({ id: "fx2" })] });
  assert.equal(r.newRounds[0].matches.length, 1);
  assert.equal(r.diagnostics.filter((d) => d.code === DIAGNOSTIC.MISSING_FIXTURE_ID).length, 1);
  assert.equal(r.skippedEvents, 1);
});

test("IDENTIDAD: un id repetido DENTRO del mismo lote se reporta, no se duplica", () => {
  const r = plan({ existingRounds: [], events: [ev({ id: "fx1" }), ev({ id: "fx1" })] });
  assert.equal(r.newRounds[0].matches.length, 1);
  assert.equal(r.diagnostics.filter((d) => d.code === DIAGNOSTIC.DUPLICATE_FIXTURE_ID).length, 1);
});

test("IDENTIDAD: no existe emparejamiento difuso en ninguna parte del planificador", () => {
  // DATA-004B dejó SIN PROBAR que Sportmonks conserve fixture.id al resolver un
  // TBD. Ante eso, unir por equipos/fecha no es una ayuda: es fusionar dos
  // partidos distintos en silencio.
  const src = stripComments(syncSrc);
  assert.ok(!/teamA\s*===\s*|levenshtein|similarity|fuzzy/i.test(src),
    "el planificador no puede emparejar por parecido de equipos");
  assert.ok(!/kickoffAt\s*===\s*[^;]*&&[^;]*team/i.test(src));
});

// ==== 2. Fixtures sin ronda ================================================

test("SIN RONDA: el fixture SÍ se convierte en jornada, sin inventar una ronda del proveedor", () => {
  // DATA-004 Paso C. La señal estructural es stage + leg, nunca un nombre.
  const r = plan({ existingRounds: [], events: [ev({ id: "fxK", round: null, stageId: "st-final", leg: { number: 1, total: 2 }, at: "2026-12-01T02:00:00Z" })] });
  assert.equal(r.stagedFixtures.length, 0, "ya no se queda esperando");
  assert.equal(r.newRounds.length, 1);
  assert.equal(r.newRounds[0].matches[0].externalEventId, "fxK");
  assert.equal(r.newRounds[0].externalRoundId, null, "no se inventa una ronda del proveedor que no existe");
  assert.equal(r.newRounds[0].syncGroupKey, "stage:st-final:leg:1", "la clave es estructural");
  assert.equal(r.newRounds[0].published, false, "preparada, no publicada");
});

test("SIN RONDA: no es un error — cero diagnósticos por esa causa", () => {
  const r = plan({ existingRounds: [], events: [ev({ id: "fxK", round: null })] });
  assert.equal(r.diagnostics.length, 0);
  assert.equal(r.skippedEvents, 0);
});

test("SIN RONDA: el resync no lo duplica", () => {
  const e = [ev({ id: "fxK", round: null })];
  const first = plan({ existingRounds: [], events: e });
  const second = plan({ existingRounds: [], existingStaged: first.stagedFixtures, events: e });
  assert.equal(second.stagedFixtures.length, 0);
  assert.equal(second.stagedUpdates.length, 0);
});

test("SIN RONDA: mezclado con jornadas normales, ninguna de las dos se pierde", () => {
  const r = plan({
    existingRounds: [],
    events: [
      ev({ id: "a", round: "1" }),
      ev({ id: "b", round: null, stageId: "st-final", at: "2026-12-01T02:00:00Z" }),
      ev({ id: "c", round: "2", at: "2026-08-08T02:00:00Z" }),
    ],
  });
  assert.deepEqual(r.newRounds.map((x) => x.number).sort((x, y) => x - y), [1, 2, 3]);
  assert.equal(r.stagedFixtures.length, 0);
  const knockout = r.newRounds.find((x) => x.externalRoundId === null);
  assert.equal(knockout.number, 3, "la fase final va después de la regular, por kickoff");
  assert.equal(knockout.matches[0].externalEventId, "b");
});

// ==== 3. TBD ================================================================

test("TBD: un fixture sin equipos entra en la jornada sin que se inventen rivales", () => {
  const r = plan({
    existingRounds: [],
    events: [ev({ id: "fxT", round: null, stageId: "st-cuartos", home: null, away: null, homeId: null, awayId: null, at: "2026-12-01T02:00:00Z" })],
  });
  assert.equal(r.newRounds.length, 1, "un cruce sin rival todavía es un partido de la jornada");
  const m = r.newRounds[0].matches[0];
  assert.equal(m.teamA, "", "ningún equipo inventado");
  assert.equal(m.teamB, "");
  assert.equal(m.externalHomeId, null);
  assert.equal(m.externalEventId, "fxT", "y su identidad sí está");
});

test("TBD: al resolverse, ACTUALIZA el mismo partido por su id — no nace otro", () => {
  const tbd = ev({ id: "fxT", round: null, stageId: "st-cuartos", home: null, away: null, homeId: null, awayId: null, at: "2026-12-01T02:00:00Z" });
  const first = plan({ existingRounds: [], events: [tbd] });
  const stored = [roundOf(first.newRounds[0].matches.map((m, i) => ({ id: "m_" + i, ...m })), {
    externalRoundId: null, syncGroupKey: first.newRounds[0].syncGroupKey, published: false,
  })];
  const second = plan({
    existingRounds: stored,
    events: [ev({ id: "fxT", round: null, stageId: "st-cuartos", home: "Toluca", away: "Tigres", homeId: "10", awayId: "20", at: "2026-12-01T02:00:00Z" })],
  });
  assert.equal(second.newRounds.length, 0, "no nace una segunda jornada");
  assert.equal(second.matchAdditions.length, 0, "ni un segundo partido");
  assert.equal(second.matchUpdates.length, 1);
  assert.equal(second.matchUpdates[0].changes.teamA, "Toluca");
  assert.equal(second.matchUpdates[0].changes.externalHomeId, "10");
});

test("TBD: un payload posterior SIN equipos nunca borra los que ya se sabían", () => {
  const known = [{ providerFixtureId: "fxT", providerRoundId: null, stageId: "s1", kickoffAt: "2026-12-01T02:00:00Z",
    home: { id: "10", name: "Toluca" }, away: { id: "20", name: "Tigres" }, leg: null, status: "scheduled", provider: "thesportsdb" }];
  const r = plan({ existingRounds: [], existingStaged: known,
    events: [ev({ id: "fxT", round: null, home: null, away: null, homeId: null, awayId: null, at: "2026-12-01T02:00:00Z" })] });
  assert.equal(r.stagedUpdates.length, 0, "'todavía no se sabe' no puede pisar 'ya se sabe'");
});

test("TBD: el dominio expone el estado explícitamente, derivado de los competidores", () => {
  const pending = domain.makeEvent({ provider: "sportmonks", providerEventId: "1",
    competitors: [{ role: "home", providerCompetitorId: "10" }, { role: "away", providerCompetitorId: null }] });
  const resolved = domain.makeEvent({ provider: "sportmonks", providerEventId: "2",
    competitors: [{ role: "home", providerCompetitorId: "10" }, { role: "away", providerCompetitorId: "20" }] });
  assert.equal(pending.tbdState, "pending");
  assert.equal(resolved.tbdState, "resolved");
});

// ==== 4. Ordenamiento =======================================================

test("ORDEN: el orden de llegada del proveedor NO cambia el resultado", () => {
  const a = ev({ id: "a", round: "Cuartos", at: "2026-11-27T02:00:00Z" });
  const b = ev({ id: "b", round: "Semifinal", at: "2026-12-04T02:00:00Z" });
  const c = ev({ id: "c", round: "Final", at: "2026-12-11T02:00:00Z" });
  const forward = plan({ existingRounds: [], events: [a, b, c] });
  const backward = plan({ existingRounds: [], events: [c, b, a] });
  const shuffled = plan({ existingRounds: [], events: [b, c, a] });
  const shape = (r) => r.newRounds.map((x) => [x.number, x.externalRoundId]);
  assert.deepEqual(shape(forward), shape(backward));
  assert.deepEqual(shape(forward), shape(shuffled));
  // Y el orden es CRONOLÓGICO: con el orden de llegada, entregar el calendario
  // al revés dejaba la Final como jornada 1.
  assert.deepEqual(shape(forward), [[1, "Cuartos"], [2, "Semifinal"], [3, "Final"]]);
});

test("ORDEN: los empates de kickoff se desempatan de forma determinística", () => {
  const same = "2026-08-01T02:00:00Z";
  const one = plan({ existingRounds: [], events: [ev({ id: "zzz", at: same }), ev({ id: "aaa", at: same })] });
  const two = plan({ existingRounds: [], events: [ev({ id: "aaa", at: same }), ev({ id: "zzz", at: same })] });
  assert.deepEqual(one.newRounds[0].matches.map((m) => m.externalEventId), ["aaa", "zzz"]);
  assert.deepEqual(one.newRounds[0].matches, two.newRounds[0].matches);
});

test("ORDEN: un fixture sin kickoff no se pierde, pero tampoco entra en una jornada", () => {
  // Una jornada necesita un cierre y el cierre se siembra del kickoff. Sin
  // fecha no se inventa una: el partido se conserva aparte, con motivo.
  const r = plan({ existingRounds: [],
    events: [ev({ id: "sinfecha", round: null, stageId: "st-final", at: null }),
             ev({ id: "confecha", round: null, stageId: "st-final", at: "2026-12-01T02:00:00Z" })] });
  assert.deepEqual(r.stagedFixtures.map((f) => f.providerFixtureId), ["sinfecha"]);
  assert.equal(r.newRounds.length, 1);
  assert.deepEqual(r.newRounds[0].matches.map((m) => m.externalEventId), ["confecha"]);
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.MISSING_KICKOFF && d.providerFixtureId === "sinfecha"));
});

// ==== 5. Marcadores: FT / AET / FT_PEN / ambiguo ============================

const line = (phase, side, goals) => ({ phase, side, goals });
const both = (phase, h, a) => [line(phase, "home", h), line(phase, "away", a)];

test("SCORE FT: con el estado que prueba regulación, el marcador final vale como reglamentario", () => {
  const c = buildScoreContract({ lines: both(SCORE_PHASE.FINAL, 2, 1), regulationComplete: true });
  assert.deepEqual(c.regulation, { home: 2, away: 1 });
  assert.equal(outcomeFromRegulation(c.regulation, true), "A");
});

test("SCORE AET: la prórroga NO altera el 1X2 de regulación", () => {
  const c = buildScoreContract({
    lines: [...both(SCORE_PHASE.REGULATION, 1, 1), ...both(SCORE_PHASE.EXTRA_TIME, 2, 1), ...both(SCORE_PHASE.FINAL, 2, 1)],
    regulationComplete: false,
  });
  assert.deepEqual(c.regulation, { home: 1, away: 1 }, "el 1X2 sale de los 90 minutos");
  assert.deepEqual(c.final, { home: 2, away: 1 }, "y el final se conserva para mostrar");
  assert.equal(outcomeFromRegulation(c.regulation, true), "D", "empate, aunque uno ganara en la prórroga");
});

test("SCORE FT_PEN: se conserva el marcador de penales Y el 1X2 sigue siendo el de 90'", () => {
  const c = buildScoreContract({
    lines: [...both(SCORE_PHASE.REGULATION, 1, 1), ...both(SCORE_PHASE.PENALTY, 5, 4), ...both(SCORE_PHASE.FINAL, 1, 1)],
    regulationComplete: false,
  });
  assert.deepEqual(c.penalty, { home: 5, away: 4 }, "los penales se preservan");
  assert.deepEqual(c.regulation, { home: 1, away: 1 }, "pero no tocan la regulación");
  assert.equal(outcomeFromRegulation(c.regulation, true), "D", "una Final ganada en penales es EMPATE para QRACKS");
});

test("SCORE ambiguo: sin evidencia de regulación, null — jamás una reconstrucción", () => {
  // Terminó en penales pero no vino el marcador de los 90: no se resta, no se
  // deduce, no se inventa.
  const c = buildScoreContract({
    lines: [...both(SCORE_PHASE.FINAL, 3, 1), ...both(SCORE_PHASE.PENALTY, 5, 4)],
    regulationComplete: false,
  });
  assert.equal(c.regulation, null);
  assert.equal(outcomeFromRegulation(c.regulation, true), null);
  assert.ok(c.reasons.includes("penalties_present"));
});

test("SCORE: una fase que el adapter no supo clasificar vuelve el fixture ambiguo", () => {
  const c = buildScoreContract({ lines: [...both(SCORE_PHASE.FINAL, 2, 1), ...both(SCORE_PHASE.UNKNOWN, 9, 9)], regulationComplete: true });
  assert.equal(c.ambiguous, true);
  assert.equal(c.regulation, null, "ante algo que no entendemos, no se puntúa");
});

test("SCORE: registros duplicados y contradictorios descartan la fase entera", () => {
  const c = buildScoreContract({
    lines: [...both(SCORE_PHASE.REGULATION, 2, 1), line(SCORE_PHASE.REGULATION, "home", 3)],
    regulationComplete: true,
  });
  assert.equal(c.regulation, null, "elegir uno sería un primer-gana silencioso");
  assert.ok(c.reasons.includes("duplicate_conflict"));
});

test("SCORE: duplicados IDÉNTICOS no son contradicción", () => {
  const c = buildScoreContract({
    lines: [...both(SCORE_PHASE.REGULATION, 2, 1), ...both(SCORE_PHASE.REGULATION, 2, 1)],
    regulationComplete: true,
  });
  assert.deepEqual(c.regulation, { home: 2, away: 1 });
});

test("SCORE: una fase a medias (sólo un lado) no produce marcador", () => {
  const c = buildScoreContract({ lines: [line(SCORE_PHASE.REGULATION, "home", 2)], regulationComplete: true });
  assert.equal(c.regulation, null);
});

test("SCORE: sin registros, todo null y motivo explícito", () => {
  const c = buildScoreContract({ lines: [], regulationComplete: true });
  assert.equal(c.regulation, null);
  assert.equal(c.final, null);
  assert.ok(c.reasons.includes("no_score_records"));
});

test("SCORE: `regulationComplete` null NUNCA autoriza usar el final como reglamentario", () => {
  // No saber no es lo mismo que saber que sí. Es el candado que impide que un
  // proveedor sin señal de estado produzca 1X2 inventados.
  const c = buildScoreContract({ lines: both(SCORE_PHASE.FINAL, 2, 1), regulationComplete: null });
  assert.equal(c.regulation, null);
});

test("SCORE: el 1X2 respeta el orden teamA/teamB del tablero", () => {
  const reg = { home: 2, away: 1 };
  assert.equal(outcomeFromRegulation(reg, true), "A", "local es teamA -> gana A");
  assert.equal(outcomeFromRegulation(reg, false), "B", "local es teamB -> gana B");
  assert.equal(outcomeFromRegulation({ home: 1, away: 1 }, false), "D");
});

// ==== 6. Adapters: la forma real del proveedor =============================

const smParticipants = [
  { id: 1001, name: "Tigres", meta: { location: "home" } },
  { id: 1002, name: "Toluca", meta: { location: "away" } },
];
// type_id reales: 2 es el de 2ND_HALF, la señal aprobada en DATA-004. El resto
// usa un id distinto de 2, que es lo único que importa para el cruce.
const SM_TYPE_ID = { "2ND_HALF": 2, "1ST_HALF": 1, CURRENT: 1525, ET: 5, PENALTY_SHOOTOUT: 4, "2ND_HALF_ONLY": 7, ET_1ST_HALF: 5, ET_2ND_HALF: 6 };
const smScore = (description, h, a) => ([
  { id: 1, type_id: SM_TYPE_ID[description] ?? 99, description, score: { participant_id: 1001, goals: h, participant: "home" } },
  { id: 2, type_id: SM_TYPE_ID[description] ?? 99, description, score: { participant_id: 1002, goals: a, participant: "away" } },
]);
const smStages = () => sportmonks.toStages({
  stages: [{ id: 77479151, season_id: 25539, type_id: 224, name: "Apertura, Final", sort_order: 5 }],
  instances: [{ instanceKey: "Apertura", id: "i1" }],
  providerCompetitionId: "743",
});
const smEvent = (state_id, scores) => sportmonks.toEvents({
  fixtures: [{ id: 19609342, stage_id: 77479151, round_id: null, aggregate_id: null, leg: "2/2",
    starting_at: "2025-12-15 02:00:00", state_id, participants: smParticipants, scores }],
  stages: smStages(),
})[0];

test("SPORTMONKS: la Final real (round_id null, leg 2/2) normaliza con marcador reglamentario", () => {
  const e = smEvent(8, [...smScore("2ND_HALF", 1, 1), ...smScore("PENALTY_SHOOTOUT", 5, 4), ...smScore("CURRENT", 1, 1)]);
  assert.equal(e.providerRoundId, null, "round_id null no invalida nada");
  assert.deepEqual(e.leg, { number: 2, total: 2 });
  assert.deepEqual(e.regulationScore, { home: 1, away: 1 });
  assert.deepEqual(e.penaltyScore, { home: 5, away: 4 });
  assert.equal(outcomeFromRegulation(e.regulationScore, true), "D");
});

test("SPORTMONKS: el estado crudo sobrevive como campo de primera clase", () => {
  // `status` colapsa 5, 7 y 8 en "finished" y borra justo la distinción que el
  // marcador a 90' necesita (DATA-004B §8).
  for (const state of [5, 7, 8]) {
    const e = smEvent(state, smScore("CURRENT", 2, 1));
    assert.equal(e.status, "finished");
    assert.equal(e.providerStatusRaw, String(state));
  }
});

test("SPORTMONKS: sólo el estado de FT autoriza usar el final como reglamentario", () => {
  assert.deepEqual(smEvent(5, smScore("CURRENT", 2, 1)).regulationScore, { home: 2, away: 1 });
  assert.equal(smEvent(7, smScore("CURRENT", 2, 1)).regulationScore, null, "AET no prueba los 90'");
  assert.equal(smEvent(8, smScore("CURRENT", 2, 1)).regulationScore, null, "FT_PEN tampoco");
});

test("SPORTMONKS: un registro cuyo lado no se puede atribuir vuelve el fixture ambiguo", () => {
  const e = smEvent(5, [{ id: 9, description: "PENALTY_SHOOTOUT", score: { participant_id: 999999, goals: 5 } },
                        ...smScore("CURRENT", 1, 1)]);
  assert.equal(e.regulationScore, null, "un registro de penales sin atribuir no puede quedar ignorado");
});

test("SPORTMONKS: una descripción desconocida nunca se adivina", () => {
  assert.equal(sportmonks.scorePhaseOf("ALGO_NUEVO", 99), SCORE_PHASE.UNKNOWN);
  assert.equal(sportmonks.scorePhaseOf(null, 99), SCORE_PHASE.UNKNOWN);
  // QA Correction 01 (P1-B): la fase que AUTORIZA a puntuar exige las dos
  // señales. Sin type_id 2, "2ND_HALF" ya no basta.
  assert.equal(sportmonks.scorePhaseOf("2nd_half", 2), SCORE_PHASE.REGULATION, "case-insensitive");
  assert.equal(sportmonks.scorePhaseOf("2ND_HALF"), SCORE_PHASE.UNKNOWN, "sin type_id no se autoriza nada");
  assert.equal(sportmonks.scorePhaseOf("CURRENT", 1525), SCORE_PHASE.FINAL, "el marcador 'actual' NO es prueba de regulación");
});

test("SPORTMONKS: el conjunto de estados que prueban regulación es exactamente {5}", () => {
  // Un estado de más aquí produce un 1X2 plausible y equivocado; uno de menos
  // sólo produce un null que pide captura manual.
  assert.deepEqual([...sportmonks.SPORTMONKS_REGULATION_COMPLETE_STATES], [5]);
  assert.equal(sportmonks.regulationCompleteFromState(5), true);
  assert.equal(sportmonks.regulationCompleteFromState(7), false);
  assert.equal(sportmonks.regulationCompleteFromState(8), false);
  assert.equal(sportmonks.regulationCompleteFromState(1), null, "no saber no autoriza nada");
  assert.equal(sportmonks.regulationCompleteFromState("5"), null, "un string no es el estado");
});

test("THESPORTSDB: AET y PEN dejan de producir un 1X2 — el riesgo R8, cerrado", () => {
  const raw = (status) => ({ idEvent: "1", idLeague: "4350", intRound: "17", strStatus: status,
    strHomeTeam: "A", strAwayTeam: "B", idHomeTeam: "1", idAwayTeam: "2",
    intHomeScore: "2", intAwayScore: "1", strTimestamp: "2026-08-01T02:00:00" });
  const ft = sportsDataProvider.normalizeEvent(raw("FT"), "thesportsdb");
  assert.deepEqual(ft.regulationScore, { home: 2, away: 1 });
  for (const s of ["AET", "PEN"]) {
    const e = sportsDataProvider.normalizeEvent(raw(s), "thesportsdb");
    assert.equal(e.status, "finished", "sigue siendo un partido terminado para el ciclo de vida");
    assert.deepEqual(e.score, { home: 2, away: 1 }, "y su marcador final se conserva");
    assert.equal(e.regulationScore, null, `${s} no puede alimentar un 1X2`);
  }
});

test("THESPORTSDB: un estado desconocido tampoco autoriza el 1X2", () => {
  assert.equal(sportsDataProvider.tsdbRegulationComplete("NS"), null);
  assert.equal(sportsDataProvider.tsdbRegulationComplete(null), null);
  assert.equal(sportsDataProvider.tsdbRegulationComplete("ft"), true, "case-insensitive");
});

// ==== 7. Diagnósticos =======================================================

test("DIAGNÓSTICO: un kickoff malformado se reporta en vez de desaparecer", () => {
  const r = plan({ existingRounds: [], events: [ev({ id: "fx1", at: "no-es-una-fecha" })] });
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.MALFORMED_KICKOFF && d.providerFixtureId === "fx1"));
});

test("DIAGNÓSTICO: un fixture con ronda pero sin kickoff se conserva, con motivo", () => {
  const r = plan({ existingRounds: [], events: [ev({ id: "fx1", at: null })] });
  assert.equal(r.newRounds.length, 0, "sin kickoff no se puede sembrar un cierre");
  assert.equal(r.stagedFixtures.length, 1, "pero el partido no se pierde");
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.MISSING_KICKOFF));
});

test("DIAGNÓSTICO: cada motivo trae el fixture al que se refiere", () => {
  const r = plan({ existingRounds: [], events: [ev({ id: "fx1", at: "basura" }), ev({ id: "fx1" })] });
  for (const d of r.diagnostics) {
    assert.ok(typeof d.code === "string" && d.code, "todo diagnóstico tiene código");
    assert.ok("providerFixtureId" in d, "y a qué fixture se refiere");
  }
});

test("DIAGNÓSTICO: `round_id = null` NO aparece nunca como motivo", () => {
  const r = plan({ existingRounds: [], events: [ev({ id: "a", round: null }), ev({ id: "b", round: null })] });
  assert.equal(r.diagnostics.length, 0);
  assert.ok(!Object.values(DIAGNOSTIC).some((c) => /round.*null|missing_round/.test(c)),
    "no puede existir siquiera un código para eso");
});

// ==== 8. Estado local de QRACKS: lo que una actualización nunca toca ========

test("UPDATE: los campos de QRACKS jamás se sobrescriben", () => {
  const stored = [roundOf(
    [{ id: "m_1", externalEventId: "fx1", teamA: "Viejo", teamB: "Otro", kickoffAt: "2026-08-01T02:00:00Z" }],
    { results: { m_1: "A" }, published: true, deadline: "2026-08-01T00:00:00Z" }
  )];
  const r = plan({ existingRounds: stored, events: [ev({ id: "fx1", home: "Nuevo", away: "Otro" })] });
  const changed = Object.keys(r.matchUpdates[0].changes);
  for (const forbidden of ["id", "results", "resultsPublished", "published", "deadline", "number"]) {
    assert.ok(!changed.includes(forbidden), `una actualización no puede tocar ${forbidden}`);
  }
});

test("UPDATE: con resultados publicados, los equipos NO se reescriben — se avisa", () => {
  const stored = [roundOf(
    [{ id: "m_1", externalEventId: "fx1", teamA: "Toluca", teamB: "Tigres", kickoffAt: "2026-08-01T02:00:00Z" }],
    { resultsPublished: true, results: { m_1: "A" } }
  )];
  const r = plan({ existingRounds: stored, events: [ev({ id: "fx1", home: "Otro", away: "Distinto" })] });
  assert.equal(r.matchUpdates.length, 0, "cambiar los equipos bajo un resultado ya puntuado reescribiría el sentido de los picks");
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.LOCKED_BY_RESULTS));
});

test("UPDATE: un kickoff que se pasa del cierre se avisa, pero el cierre no se mueve", () => {
  // El partido está guardado exactamente como llega, salvo la hora: así el
  // único cambio posible es el kickoff.
  const stored = [roundOf(
    [{ id: "m_1", externalEventId: "fx1", teamA: "Local", teamB: "Visita",
       externalHomeId: "h1", externalAwayId: "a1", kickoffAt: "2026-08-01T02:00:00Z" }],
    { deadline: "2026-08-01T00:00:00Z" }
  )];
  const r = plan({ existingRounds: stored, events: [ev({ id: "fx1", at: "2026-08-20T02:00:00Z" })] });
  assert.deepEqual(Object.keys(r.matchUpdates[0].changes), ["kickoffAt"]);
  assert.equal(stored[0].deadline, "2026-08-01T00:00:00Z", "el cierre de la jornada no se toca");
  assert.ok(r.diagnostics.some((d) => d.code === DIAGNOSTIC.KICKOFF_PAST_DEADLINE));
});

test("UPDATE: un payload parcial no vacía un partido que estaba completo", () => {
  const stored = [roundOf([{ id: "m_1", externalEventId: "fx1", teamA: "Toluca", teamB: "Tigres", kickoffAt: "2026-08-01T02:00:00Z" }])];
  const r = plan({ existingRounds: stored, events: [ev({ id: "fx1", home: null, away: null, homeId: null, awayId: null, at: null })] });
  assert.equal(r.matchUpdates.length, 0);
});

test("PUREZA: planCompetitionSync no muta sus entradas", () => {
  const stored = [roundOf([{ id: "m_1", externalEventId: "fx1", teamA: "Viejo", teamB: "Otro", kickoffAt: "2026-08-01T02:00:00Z" }])];
  const events = [ev({ id: "fx1", home: "Nuevo" }), ev({ id: "fx2", round: null })];
  const snapshot = JSON.stringify({ stored, events });
  plan({ existingRounds: stored, events });
  assert.equal(JSON.stringify({ stored, events }), snapshot);
});

// ==== 9. Conversores de forma ==============================================

test("CONVERSORES: las dos formas internas producen la misma SyncFixture", () => {
  const fromProvider = fromProviderEvent({
    externalEventId: "77", round: null, dateTime: "2025-12-15T02:00:00Z", stageId: "s1",
    participants: [{ role: "home", externalId: "10", name: "Toluca" }, { role: "away", externalId: "20", name: "Tigres" }],
  });
  const fromDomainShape = fromDomainEvent(domain.makeEvent({
    provider: "sportmonks", providerEventId: "77", providerRoundId: null, stageId: "s1",
    startsAt: "2025-12-15T02:00:00Z",
    competitors: [{ role: "home", providerCompetitorId: "10", name: "Toluca" }, { role: "away", providerCompetitorId: "20", name: "Tigres" }],
  }));
  assert.equal(fromProvider.providerFixtureId, fromDomainShape.providerFixtureId);
  assert.equal(fromProvider.providerRoundId, null);
  assert.equal(fromDomainShape.providerRoundId, null);
  assert.deepEqual(fromProvider.home, fromDomainShape.home);
  assert.deepEqual(fromProvider.away, fromDomainShape.away);
});

// ==== 10. Cableado en servidor y navegador =================================

test("SERVER: el sync aplica actualizaciones campo a campo, nunca reemplaza el partido", () => {
  const src = stripComments(serverSrc);
  const at = src.indexOf("for (const upd of matchUpdates)");
  assert.ok(at !== -1, "el update path tiene que existir en el endpoint");
  const block = src.slice(at, at + 500);
  assert.ok(block.includes("Object.assign(match, upd.changes)"), "sólo los campos que cambiaron");
  assert.ok(!/matches\[\w+\]\s*=\s*\{/.test(block), "nunca reemplazar el objeto partido entero");
});

test("SERVER: los fixtures en staging son propiedad del servidor (lección de HOTFIX-001)", () => {
  const merge = stripComments(serverSrc.slice(serverSrc.indexOf("function mergeProtectedMetaFields(")));
  assert.ok(merge.includes("merged.stagedFixtures = Array.isArray(oldValue && oldValue.stagedFixtures)"),
    "tomarlos del request dejaría que una pestaña atrasada borrara una importación que nunca vio");
});

test("SERVER: cualquier escritura del sync sella la revisión del tablero", () => {
  const sync = stripComments(serverSrc.slice(serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"')));
  assert.ok(sync.includes("stampRoundsRevision(meta, boardBeforeImport)"));
  const before = sync.indexOf("const boardBeforeImport");
  assert.ok(before !== -1 && before < sync.indexOf("Object.assign(match, upd.changes)"),
    "la foto previa se toma ANTES de aplicar nada");
});

test("SERVER: el 1X2 sale exclusivamente del marcador reglamentario", () => {
  const fn = stripComments(serverSrc.slice(serverSrc.indexOf("function buildRoundSuggestions(")));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(body.includes("outcomeFromRegulation(hit.regulationScore"), "una sola fuente para el resultado");
  assert.ok(!/hit\.score\.home\s*>\s*hit\.score\.away/.test(body),
    "derivar el 1X2 del marcador final es exactamente el bug que este ticket cierra");
  assert.ok(body.includes("unscorable.push"), "y lo no puntuable se reporta, no desaparece");
});

test("SERVER: la respuesta del sync reporta lo que hizo además de crear jornadas", () => {
  const sync = stripComments(serverSrc.slice(serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"')));
  for (const field of ["updatedMatches", "stagedFixtures: stagedCreated", "diagnostics"]) {
    assert.ok(sync.includes(field), `la respuesta debe incluir ${field}`);
  }
});

test("UI: el Admin se entera de los partidos actualizados y de los guardados sin jornada", () => {
  const ui = stripComments(indexSrc);
  assert.ok(ui.includes("data.updatedMatches > 0"), "un sync que actualizó cruces TBD no puede decir 'no hay nada nuevo'");
  assert.ok(ui.includes("data.stagedFixtures > 0"));
  assert.ok(/data\.diagnostics/.test(ui), "y los motivos de revisión se muestran");
});

test("UI: un partido definido en penales explica por qué hay que capturarlo a mano", () => {
  const ui = stripComments(indexSrc);
  assert.ok(ui.includes("penalties_present"), "el motivo llega desde el servidor");
  const at = ui.indexOf("const UNSCORABLE_COPY");
  const block = ui.slice(at, at + 900);
  assert.ok(/90 minutos/.test(block), "el copy explica la regla de producto");
  for (const jerga of ["regulationScore", "null", "state_id", "AET", "FT_PEN"]) {
    assert.ok(!block.includes(jerga), `el copy no puede decir "${jerga}"`);
  }
});

// ==== 11. Hallazgos del QA adversarial de este mismo ticket ================

test("ADVERSARIAL: el cierre de torneo limpia el staging junto con el tablero", () => {
  // Encontrado ejecutando la sonda contra Postgres real: los fixtures en
  // staging sobrevivían al cierre, así que podían convertirse en jornada
  // DENTRO del ciclo siguiente y cargarse a SU presupuesto — la misma fuga que
  // MON-002C cerró para el tablero, reabierta por un campo nuevo.
  const close = stripComments(serverSrc.slice(serverSrc.indexOf('app.post("/api/quinielas/:slug/tournament/close"')));
  const at = close.indexOf("meta.rounds = [];");
  assert.ok(at !== -1);
  assert.ok(close.slice(at, at + 400).includes("meta.stagedFixtures = [];"),
    "el staging pertenece al torneo que se cierra y se limpia con él");
});

test("ADVERSARIAL: un fixture que ya vive en una jornada no puede quedar además en staging", () => {
  const sync = stripComments(serverSrc.slice(serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"')));
  assert.ok(sync.includes("const inRounds = new Set(plan.promotedStagedIds.map(String))"),
    "la misma identidad en dos sitios dejaría uno huérfano para siempre; los recién promovidos cuentan igual");
  assert.ok(sync.includes("!inRounds.has(String(f.providerFixtureId))"));
});

test("ADVERSARIAL: un fixture que estaba en espera se PROMUEVE a jornada cuando ya se puede colocar", () => {
  // DATA-004 cambió esta regla respecto de DATA-004C: entonces se quedaba en
  // espera; ahora, en cuanto hay señal con la que agruparlo, se coloca. Quedarse
  // en espera para siempre era una pérdida silenciosa con otro nombre.
  const known = [{ providerFixtureId: "fxT", providerRoundId: null, stageId: null,
    kickoffAt: null, home: null, away: null, leg: null, status: "scheduled", provider: "thesportsdb" }];
  const r = plan({ existingRounds: [], existingStaged: known,
    events: [ev({ id: "fxT", round: "18", at: "2026-12-01T02:00:00Z" })] });
  assert.equal(r.newRounds.length, 1, "ya se puede colocar, así que se coloca");
  assert.equal(r.newRounds[0].number, 18);
  assert.deepEqual(r.promotedStagedIds, ["fxT"], "y deja de estar en espera");
  assert.equal(r.stagedFixtures.length, 0);
});

test("ADVERSARIAL: un participante no recibe los fixtures en staging", () => {
  // Son fase final importada y NO publicada: la misma clase de información que
  // las jornadas preparadas, que ya se filtran. Un participante no debe
  // recibirlos por el cable.
  const src = stripComments(serverSrc);
  const at = src.indexOf("clone.rounds = clone.rounds.filter((r) => r.published !== false);");
  assert.ok(at !== -1);
  assert.ok(src.slice(at, at + 400).includes("delete clone.stagedFixtures;"));
});

test("ADVERSARIAL: si el vocabulario de fases estuviera mal leído, falla cerrado", () => {
  // El contrato descansa en una suposición: que la "fase de regulación" del
  // proveedor es el marcador ACUMULADO a los 90 minutos y no, por ejemplo, los
  // goles de un solo tiempo. Este candado la vuelve autovalidante: en un
  // partido que terminó en los 90, regulación y final son el mismo marcador, y
  // si no coinciden lo que falló es la premisa, no el partido.
  const c = buildScoreContract({
    lines: [...both(SCORE_PHASE.REGULATION, 1, 0), ...both(SCORE_PHASE.FINAL, 2, 1)],
    regulationComplete: true,
  });
  assert.equal(c.regulation, null, "ante una contradicción se deja de puntuar, no se elige un lado");
  assert.ok(c.reasons.includes("phase_contradiction"));
  assert.equal(outcomeFromRegulation(c.regulation, true), null);
});

test("ADVERSARIAL: el candado NO se dispara cuando el partido sí pasó de los 90", () => {
  // Aquí la diferencia entre regulación y final es LEGÍTIMA: la metieron en la
  // prórroga. El candado sólo aplica cuando el proveedor afirma que no la hubo.
  const c = buildScoreContract({
    lines: [...both(SCORE_PHASE.REGULATION, 1, 1), ...both(SCORE_PHASE.EXTRA_TIME, 2, 1), ...both(SCORE_PHASE.FINAL, 2, 1)],
    regulationComplete: false,
  });
  assert.deepEqual(c.regulation, { home: 1, away: 1 });
  assert.ok(!c.reasons.includes("phase_contradiction"));
});
