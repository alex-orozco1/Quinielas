// FIX round_number_taken — una ronda numérica del proveedor nunca pierde partidos.
//
// Producción, Liga MX 2026-2027, quiniela "ejemplo": TheSportsDB entregó 153
// eventos en 17 rondas y QRACKS guardó 149. La ronda 7 traía partidos separados
// por más de 4 días; la primera importación la partía en 5 ventanas de tiempo,
// la primera creaba la Jornada 7 y las otras 4 se descartaban con
// `round_number_taken` sin ir a ningún sitio. La Jornada 7 quedó con 5 de 9.

const test = require("node:test");
const assert = require("node:assert/strict");
const { planCompetitionSync, DIAGNOSTIC } = require("../competitionSync");

const DAY = 864e5;
const T0 = Date.parse("2026-07-10T02:00:00Z");

function ev({ id, round, at, stageId = "stage-regular", home = "h", away = "a" }) {
  return {
    provider: "thesportsdb", externalEventId: String(id), round: round == null ? null : String(round),
    stageId, dateTime: new Date(at).toISOString(),
    participants: [{ role: "home", externalId: home + id, name: "Local " + id },
                   { role: "away", externalId: away + id, name: "Visita " + id }],
  };
}

// Un torneo de 17 rondas x 9 partidos (153). `postponedRound` reparte 4 de sus
// 9 partidos en fechas separadas entre sí por 6 días — la forma exacta que
// produjo los 4 warnings en producción.
function ligaMx({ postponedRound = null } = {}) {
  const events = [];
  let id = 2000000;
  for (let r = 1; r <= 17; r++) {
    for (let m = 0; m < 9; m++) {
      let t = T0 + (r - 1) * 7 * DAY + (m % 3) * DAY + m * 3600e3;
      if (r === postponedRound && m >= 5) t = T0 + (r - 1) * 7 * DAY + 2 * DAY + (m - 4) * 6 * DAY;
      events.push(ev({ id: id++, round: r, at: t }));
    }
  }
  return events;
}

const placedIds = (plan) => plan.newRounds.flatMap((r) => r.matches.map((m) => m.externalEventId))
  .concat(plan.matchAdditions.map((a) => a.match.externalEventId));
const stagedIds = (plan) => plan.stagedFixtures.map((f) => f.providerFixtureId);
const withIds = (plan) => plan.newRounds.map((r, i) => ({ id: "r" + i, ...r }));

// Ninguna jornada, ningún staging, ningún duplicado: cada evento acaba en
// exactamente un sitio.
function assertConserved(events, plan, existingIds = []) {
  const all = [...placedIds(plan), ...stagedIds(plan), ...existingIds];
  assert.equal(new Set(all).size, all.length, "ningún partido en dos sitios");
  for (const e of events) {
    assert.ok(all.includes(e.externalEventId), `el evento ${e.externalEventId} desapareció`);
  }
}

// ---- 1. la ronda del proveedor es la jornada --------------------------------

test("ROUND:N · 9 partidos con huecos de más de 4 días quedan los 9 en la misma jornada", () => {
  const events = ligaMx({ postponedRound: 7 }).filter((e) => e.round === "7");
  const gaps = events.map((e) => Date.parse(e.dateTime)).sort((a, b) => a - b)
    .map((t, i, a) => (i ? t - a[i - 1] : 0));
  assert.ok(gaps.filter((g) => g > 4 * DAY).length >= 4, "el caso de prueba sí tiene huecos > 4 días");
  const plan = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(plan.newRounds.length, 1);
  assert.equal(plan.newRounds[0].number, 7);
  assert.equal(plan.newRounds[0].matches.length, 9);
  assert.deepEqual(plan.diagnostics, []);
  // El cierre sigue siendo el primer partido de la ronda.
  const earliest = Math.min(...events.map((e) => Date.parse(e.dateTime)));
  assert.equal(plan.newRounds[0].deadline, new Date(earliest).toISOString());
});

test("ROUND:N · el caso exacto de producción: 153 eventos -> 153 partidos, Jornada 7 con 9, cero round_number_taken", () => {
  const events = ligaMx({ postponedRound: 7 });
  assert.equal(events.length, 153);
  const plan = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(plan.newRounds.length, 17);
  assert.equal(placedIds(plan).length, 153, "nunca 149");
  assert.equal(plan.stagedFixtures.length, 0);
  assert.deepEqual(plan.newRounds.map((r) => r.matches.length), Array(17).fill(9));
  assert.equal(plan.newRounds.find((r) => r.number === 7).matches.length, 9);
  assert.equal(plan.diagnostics.filter((d) => d.code === DIAGNOSTIC.ROUND_NUMBER_TAKEN).length, 0);
  assertConserved(events, plan);
});

// ---- 2. una Jornada N que ya existe por otra causa -------------------------

test("JORNADA MANUAL · Jornada 7 creada a mano: se respeta y los 9 partidos van a staging, con su id", () => {
  const events = ligaMx({ postponedRound: 7 });
  const manual = { id: "manual7", number: 7, matches: [{ id: "m1", teamA: "A mano", teamB: "Otro" }] };
  const snapshot = JSON.parse(JSON.stringify(manual));
  const plan = planCompetitionSync({ existingRounds: [manual], events, provider: "thesportsdb" });
  assert.deepEqual(manual, snapshot, "la jornada manual no se toca");
  assert.equal(plan.newRounds.length, 16, "nunca una segunda Jornada 7");
  assert.ok(!plan.newRounds.some((r) => r.number === 7));
  const r7 = events.filter((e) => e.round === "7").map((e) => e.externalEventId).sort();
  assert.deepEqual(stagedIds(plan).sort(), r7, "los 9 de la ronda 7, en staging");
  const notes = plan.diagnostics.filter((d) => d.code === DIAGNOSTIC.ROUND_NUMBER_TAKEN);
  assert.equal(notes.length, 9, "un diagnóstico por partido");
  assert.deepEqual(notes.map((d) => d.providerFixtureId).sort(), r7, "cada uno con su providerFixtureId");
  assert.ok(notes.every((d) => d.detail === "7"));
  assertConserved(events, plan);
});

test("JORNADA MANUAL · el siguiente sync no duplica el staging; si la jornada manual se borra, la ronda se crea con sus 9", () => {
  const events = ligaMx({ postponedRound: 7 });
  const manual = { id: "manual7", number: 7, matches: [] };
  const first = planCompetitionSync({ existingRounds: [manual], events, provider: "thesportsdb" });
  const rounds = [manual, ...withIds(first)];
  const staged = first.stagedFixtures;
  const second = planCompetitionSync({ existingRounds: rounds, existingStaged: staged, events, provider: "thesportsdb" });
  assert.equal(second.newRounds.length, 0);
  assert.equal(second.stagedFixtures.length, 0, "no se vuelven a guardar");
  assert.equal(second.stagedUpdates.length, 0, "nada cambió");
  assert.equal(second.matchAdditions.length, 0);
  // Sin la jornada manual, la ronda 7 se crea entera desde staging.
  const third = planCompetitionSync({ existingRounds: rounds.filter((r) => r !== manual), existingStaged: staged, events, provider: "thesportsdb" });
  assert.equal(third.newRounds.length, 1);
  assert.equal(third.newRounds[0].number, 7);
  assert.equal(third.newRounds[0].matches.length, 9);
  assert.equal(third.promotedStagedIds.length, 9);
});

test("JORNADA DE OTRO ORIGEN · el número ocupado tampoco hace desaparecer partidos", () => {
  const events = ligaMx().filter((e) => e.round === "1");
  // Sin clave de ronda (heredada o de otro proveedor sin externalRoundId): no
  // puede recibirlos automáticamente -> staging.
  const ajena = planCompetitionSync({
    existingRounds: [{ id: "x", number: 1, provider: "otro", matches: [] }],
    events, provider: "thesportsdb",
  });
  assert.equal(ajena.newRounds.length, 0);
  assert.equal(ajena.stagedFixtures.length, 9);
  assertConserved(events, ajena);
  // Con la MISMA clave de ronda (`externalRoundId: "1"`) la jornada existente
  // es la dueña y los recibe — comportamiento previo, sin cambios. Tampoco se
  // pierde ninguno.
  const misma = planCompetitionSync({
    existingRounds: [{ id: "y", number: 1, provider: "otro", externalRoundId: "1", matches: [] }],
    events, provider: "thesportsdb",
  });
  assert.equal(misma.newRounds.length, 0);
  assert.equal(misma.matchAdditions.length, 9);
  assertConserved(events, misma);
});

// ---- 3. primera importación y syncs siguientes coinciden -------------------

test("CONSISTENCIA · importar todo de una vez = importar sin los aplazados y traerlos después", () => {
  const events = ligaMx({ postponedRound: 7 });
  const r7 = events.filter((e) => e.round === "7").map((e) => e.externalEventId);
  const postponed = r7.slice(5);

  const once = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  const j7Once = once.newRounds.find((r) => r.number === 7).matches.map((m) => m.externalEventId).sort();

  // Primero llegan los 149 sin los aplazados; después, el calendario completo.
  const partial = events.filter((e) => !postponed.includes(e.externalEventId));
  const first = planCompetitionSync({ existingRounds: [], events: partial, provider: "thesportsdb" });
  const rounds = withIds(first);
  const later = planCompetitionSync({ existingRounds: rounds, events, provider: "thesportsdb" });
  assert.equal(later.newRounds.length, 0);
  const j7 = rounds.find((r) => r.number === 7);
  assert.ok(later.matchAdditions.every((a) => a.roundId === j7.id), "los aplazados van a SU Jornada 7");
  const j7Later = [...j7.matches.map((m) => m.externalEventId), ...later.matchAdditions.map((a) => a.match.externalEventId)].sort();
  assert.deepEqual(j7Later, j7Once, "misma asignación por los dos caminos");
});

test("CONSISTENCIA · un re-sync idéntico tras la primera importación no cambia nada", () => {
  const events = ligaMx({ postponedRound: 7 });
  const first = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  const again = planCompetitionSync({ existingRounds: withIds(first), events, provider: "thesportsdb" });
  assert.equal(again.newRounds.length, 0);
  assert.equal(again.matchAdditions.length, 0);
  assert.equal(again.matchUpdates.length, 0);
  assert.equal(again.stagedFixtures.length, 0);
  assert.deepEqual(again.diagnostics, []);
});

// ---- 4. regresión de importaciones normales --------------------------------

test("REGRESIÓN · Liga MX normal: 17 jornadas de 9, numeradas 1..17, cero diagnósticos", () => {
  const events = ligaMx();
  const plan = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.deepEqual(plan.newRounds.map((r) => r.number), Array.from({ length: 17 }, (_, i) => i + 1));
  assert.deepEqual(plan.newRounds.map((r) => r.matches.length), Array(17).fill(9));
  assert.deepEqual(plan.diagnostics, []);
});

test("REGRESIÓN · sin ronda del proveedor (fase final por stage) se sigue partiendo por ventanas", () => {
  const base = T0 + 20 * 7 * DAY;
  const events = [
    ev({ id: 1, round: null, stageId: "cuartos", at: base }),
    ev({ id: 2, round: null, stageId: "cuartos", at: base + DAY }),
    ev({ id: 3, round: null, stageId: "cuartos", at: base + 7 * DAY }),
    ev({ id: 4, round: null, stageId: "cuartos", at: base + 8 * DAY }),
  ];
  const plan = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(plan.newRounds.length, 2, "dos semanas, dos jornadas — como antes");
  assert.deepEqual(plan.newRounds.map((r) => r.matches.length), [2, 2]);
});

test("REGRESIÓN · temporada regular + liguilla sin ronda: 17 numeradas y la liguilla a continuación", () => {
  const base = T0 + 18 * 7 * DAY;
  const events = [...ligaMx(),
    ev({ id: 9001, round: null, stageId: "cuartos", at: base }),
    ev({ id: 9002, round: null, stageId: "cuartos", at: base + 3 * DAY }),
  ];
  const plan = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(plan.newRounds.length, 18);
  assert.equal(plan.newRounds.find((r) => r.externalRoundId == null).number, 18);
  assertConserved(events, plan);
});

test("REGRESIÓN · una fase sin ronda que empieza ANTES no le quita el número a una ronda del proveedor", () => {
  // Sin la reserva, el grupo sin ronda (antes por kickoff) tomaba el número 1 y
  // la ronda 1 del proveedor se quedaba sin sitio.
  const events = [
    ev({ id: 1, round: null, stageId: "previa", at: T0 - 10 * DAY }),
    ...ligaMx().filter((e) => Number(e.round) <= 2),
  ];
  const plan = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  const byExt = Object.fromEntries(plan.newRounds.map((r) => [r.externalRoundId == null ? "previa" : r.externalRoundId, r.number]));
  assert.equal(byExt["1"], 1);
  assert.equal(byExt["2"], 2);
  assert.equal(byExt.previa, 3, "la fase sin ronda toma el siguiente número libre");
  assert.equal(plan.stagedFixtures.length, 0);
  assert.deepEqual(plan.diagnostics, []);
  assertConserved(events, plan);
});

// ---- 5. conservación: 153 entran, 153 salen (colocados o en staging) --------

test("CONSERVACIÓN · 153 eventos -> 153 colocados o explícitamente en staging, en todos los escenarios", () => {
  const scenarios = [
    { name: "limpio", events: ligaMx(), existing: [] },
    { name: "J7 aplazada", events: ligaMx({ postponedRound: 7 }), existing: [] },
    { name: "J1 aplazada", events: ligaMx({ postponedRound: 1 }), existing: [] },
    { name: "J17 aplazada", events: ligaMx({ postponedRound: 17 }), existing: [] },
    { name: "J7 aplazada + J7 manual", events: ligaMx({ postponedRound: 7 }), existing: [{ id: "m7", number: 7, matches: [] }] },
    { name: "J1..J5 heredadas", events: ligaMx(), existing: [1, 2, 3, 4, 5].map((n) => ({ id: "l" + n, number: n, matches: [] })) },
  ];
  for (const s of scenarios) {
    const plan = planCompetitionSync({ existingRounds: s.existing, events: s.events, provider: "thesportsdb" });
    const total = placedIds(plan).length + stagedIds(plan).length;
    assert.equal(total, 153, `${s.name}: ${total} de 153`);
    assertConserved(s.events, plan);
    // Todo lo que fue a staging trae su motivo, con el partido identificado.
    for (const id of stagedIds(plan)) {
      assert.ok(plan.diagnostics.some((d) => d.providerFixtureId === id), `${s.name}: ${id} en staging sin motivo`);
    }
  }
});
