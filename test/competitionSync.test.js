// AUTO-001 — Tests for competitionSync.js (planCompetitionSync).
// Run with: node --test test/

const test = require("node:test");
const assert = require("node:assert/strict");
const { planCompetitionSync } = require("../competitionSync");

function ev({ round = "1", externalEventId, homeName = "Home", awayName = "Away", homeId = "h1", awayId = "a1", dateTime }) {
  return {
    provider: "thesportsdb",
    externalEventId: externalEventId || null,
    round,
    dateTime: dateTime || null,
    participants: [
      { role: "home", externalId: homeId, name: homeName },
      { role: "away", externalId: awayId, name: awayName },
    ],
  };
}

// ---- Import: grouping ----

test("groups events into rounds by provider round label", () => {
  const events = [
    ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" }),
    ev({ round: "1", externalEventId: "e2", dateTime: "2026-08-02T00:00:00Z" }),
    ev({ round: "2", externalEventId: "e3", dateTime: "2026-08-08T00:00:00Z" }),
  ];
  const { newRounds, skippedEvents } = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(newRounds.length, 2);
  assert.equal(skippedEvents, 0);
  const r1 = newRounds.find((r) => r.externalRoundId === "1");
  const r2 = newRounds.find((r) => r.externalRoundId === "2");
  assert.equal(r1.matches.length, 2);
  assert.equal(r2.matches.length, 1);
});

test("numeric round label becomes the round's natural number", () => {
  const events = [ev({ round: "17", externalEventId: "e1", dateTime: "2026-11-01T00:00:00Z" })];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(newRounds[0].number, 17);
  assert.equal(newRounds[0].externalRoundId, "17"); // original string form preserved
});

test("non-numeric round label falls back to next sequential number, string preserved as externalRoundId", () => {
  const events = [ev({ round: "Final", externalEventId: "e1", dateTime: "2026-12-01T00:00:00Z" })];
  const { newRounds } = planCompetitionSync({
    existingRounds: [{ number: 5, provider: "thesportsdb", externalRoundId: "5" }],
    events, provider: "thesportsdb",
  });
  assert.equal(newRounds[0].number, 6); // next after existing max (5)
  assert.equal(newRounds[0].externalRoundId, "Final");
});

test("events with no round at all are never guessed into a round — counted as skipped", () => {
  const events = [
    ev({ round: null, externalEventId: "e1" }),
    ev({ round: "1", externalEventId: "e2", dateTime: "2026-08-01T00:00:00Z" }),
  ];
  const { newRounds, skippedEvents } = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(skippedEvents, 1);
  assert.equal(newRounds.length, 1);
  assert.equal(newRounds[0].matches.length, 1);
});

// ---- externalEventId / participant data persisted ----

test("externalEventId, externalHomeId, externalAwayId, kickoffAt are persisted on each match", () => {
  const events = [ev({
    round: "1", externalEventId: "e1", homeId: "h100", awayId: "a200",
    homeName: "Necaxa", awayName: "Atlante", dateTime: "2026-08-01T01:00:00Z",
  })];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  const m = newRounds[0].matches[0];
  assert.equal(m.externalEventId, "e1");
  assert.equal(m.externalHomeId, "h100");
  assert.equal(m.externalAwayId, "a200");
  assert.equal(m.teamA, "Necaxa");
  assert.equal(m.teamB, "Atlante");
  assert.equal(m.kickoffAt, "2026-08-01T01:00:00Z");
});

test("deadline is seeded from the earliest kickoff in the round, not the latest or an average", () => {
  const events = [
    ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-02T00:00:00Z" }),
    ev({ round: "1", externalEventId: "e2", dateTime: "2026-08-01T00:00:00Z" }), // earliest
    ev({ round: "1", externalEventId: "e3", dateTime: "2026-08-03T00:00:00Z" }),
  ];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(newRounds[0].deadline, new Date("2026-08-01T00:00:00Z").toISOString());
});

test("new rounds always come out with published:false and resultsPublished:false", () => {
  const events = [ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" })];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(newRounds[0].published, false);
  assert.equal(newRounds[0].resultsPublished, false);
  assert.deepEqual(newRounds[0].results, {});
});

// ---- Idempotency (BLOQUEANTE) ----

test("second sync with the exact same events creates zero duplicates", () => {
  const events = [
    ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" }),
    ev({ round: "1", externalEventId: "e2", dateTime: "2026-08-02T00:00:00Z" }),
  ];
  const first = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(first.newRounds.length, 1);

  // Simulate persistence: the round from the first sync now "exists".
  const existingRounds = [{ number: 1, provider: "thesportsdb", externalRoundId: "1", matches: first.newRounds[0].matches }];
  const second = planCompetitionSync({ existingRounds, events, provider: "thesportsdb" });
  assert.equal(second.newRounds.length, 0, "re-syncing the same events must not recreate the round");
});

test("second sync with one brand-new round only adds the new one, existing round untouched", () => {
  const existingRounds = [{ number: 1, provider: "thesportsdb", externalRoundId: "1", matches: [{ id: "m1" }] }];
  const events = [
    ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" }), // round 1 already exists — must be ignored
    ev({ round: "2", externalEventId: "e2", dateTime: "2026-08-08T00:00:00Z" }), // brand new
  ];
  const { newRounds } = planCompetitionSync({ existingRounds, events, provider: "thesportsdb" });
  assert.equal(newRounds.length, 1);
  assert.equal(newRounds[0].externalRoundId, "2");
});

test("an existing round with manual edits (extra/renamed matches) is never touched or overwritten", () => {
  const manuallyEditedMatches = [{ id: "m1", teamA: "Equipo Editado A Mano", teamB: "Otro Editado" }];
  const existingRounds = [{ number: 1, provider: "thesportsdb", externalRoundId: "1", matches: manuallyEditedMatches, published: true, resultsPublished: true, results: { m1: "A" } }];
  const events = [ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" })]; // provider still reports round 1
  const { newRounds } = planCompetitionSync({ existingRounds, events, provider: "thesportsdb" });
  assert.equal(newRounds.length, 0);
  // existingRounds itself must be untouched (planCompetitionSync never mutates inputs)
  assert.deepEqual(existingRounds[0].matches, manuallyEditedMatches);
  assert.equal(existingRounds[0].resultsPublished, true);
  assert.deepEqual(existingRounds[0].results, { m1: "A" });
});

test("duplicate externalEventId within the same batch is deduplicated, not double-added", () => {
  const events = [
    ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" }),
    ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" }), // duplicate
  ];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(newRounds[0].matches.length, 1);
});

test("does not mutate its inputs", () => {
  const existingRounds = [{ number: 1, provider: "thesportsdb", externalRoundId: "1" }];
  const events = [ev({ round: "2", externalEventId: "e1", dateTime: "2026-08-08T00:00:00Z" })];
  const existingSnapshot = JSON.parse(JSON.stringify(existingRounds));
  const eventsSnapshot = JSON.parse(JSON.stringify(events));
  planCompetitionSync({ existingRounds, events, provider: "thesportsdb" });
  assert.deepEqual(existingRounds, existingSnapshot);
  assert.deepEqual(events, eventsSnapshot);
});

// ---- Defensive edge cases ----

test("a round whose only events have no usable kickoff date is skipped defensively, not guessed", () => {
  const events = [ev({ round: "1", externalEventId: "e1", dateTime: null })];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.equal(newRounds.length, 0);
});

test("a round already occupying that number from a DIFFERENT provider still blocks a duplicate (number collision wins over provider identity)", () => {
  // FIX 1 (QA): "cualquier round" — this is intentionally not scoped to
  // provider === "thesportsdb". Whatever already holds a given round number
  // wins, full stop.
  const existingRounds = [{ number: 1, provider: "some-other-provider", externalRoundId: "1" }];
  const events = [ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" })];
  const { newRounds } = planCompetitionSync({ existingRounds, events, provider: "thesportsdb" });
  assert.equal(newRounds.length, 0);
});

// ---- FIX 1 (QA): number collision protects manual/legacy rounds too ----

test("FIX 1: manual rounds 1-3 + provider returning rounds 1-17 -> only creates 4-17", () => {
  const existingRounds = [
    { id: "r1", number: 1, matches: [{ id: "m1", teamA: "A", teamB: "B" }] }, // manual — no provider, no externalRoundId
    { id: "r2", number: 2, matches: [{ id: "m2", teamA: "C", teamB: "D" }] },
    { id: "r3", number: 3, matches: [{ id: "m3", teamA: "E", teamB: "F" }] },
  ];
  const events = [];
  for (let n = 1; n <= 17; n++) {
    events.push(ev({ round: String(n), externalEventId: "e" + n, dateTime: `2026-08-${String(n).padStart(2, "0")}T00:00:00Z` }));
  }
  const { newRounds } = planCompetitionSync({ existingRounds, events, provider: "thesportsdb" });
  assert.equal(newRounds.length, 14, "should create exactly rounds 4-17, not 1-17");
  const numbers = newRounds.map((r) => r.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [4,5,6,7,8,9,10,11,12,13,14,15,16,17]);
  assert.ok(!numbers.includes(1) && !numbers.includes(2) && !numbers.includes(3));
});

test("FIX 1: the existing manual round object is left structurally identical (not merged, not annotated)", () => {
  const manualRound = { id: "r1", number: 1, matches: [{ id: "m1", teamA: "Equipo Manual", teamB: "Otro Equipo" }], deadline: "2026-08-01T00:00:00.000Z", results: {}, resultsPublished: false };
  const snapshot = JSON.parse(JSON.stringify(manualRound));
  const existingRounds = [manualRound];
  const events = [ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" })];
  planCompetitionSync({ existingRounds, events, provider: "thesportsdb" });
  assert.deepEqual(manualRound, snapshot, "the manual round must not gain provider/externalRoundId or any other field");
  assert.equal(manualRound.provider, undefined);
  assert.equal(manualRound.externalRoundId, undefined);
});

test("FIX 1: re-sync after the first import still creates zero duplicates against the manual rounds", () => {
  const manualRounds = [{ id: "r1", number: 1, matches: [] }, { id: "r2", number: 2, matches: [] }];
  const events = [
    ev({ round: "1", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" }),
    ev({ round: "2", externalEventId: "e2", dateTime: "2026-08-08T00:00:00Z" }),
    ev({ round: "3", externalEventId: "e3", dateTime: "2026-08-15T00:00:00Z" }),
  ];
  const first = planCompetitionSync({ existingRounds: manualRounds, events, provider: "thesportsdb" });
  assert.equal(first.newRounds.length, 1); // only round 3 is new
  const afterFirstSync = [...manualRounds, ...first.newRounds.map((r) => ({ id: "r_new", ...r }))];
  const second = planCompetitionSync({ existingRounds: afterFirstSync, events, provider: "thesportsdb" });
  assert.equal(second.newRounds.length, 0, "second sync must create nothing new");
});

test("FIX 1: a numeric collision never produces two rounds with the same number", () => {
  const existingRounds = [{ number: 5, matches: [] }]; // manual, no provider tag
  const events = [ev({ round: "5", externalEventId: "e1", dateTime: "2026-08-01T00:00:00Z" })];
  const { newRounds } = planCompetitionSync({ existingRounds, events, provider: "thesportsdb" });
  const allNumbers = [...existingRounds.map((r) => r.number), ...newRounds.map((r) => r.number)];
  const uniqueNumbers = new Set(allNumbers);
  assert.equal(allNumbers.length, uniqueNumbers.size, "no two rounds may end up sharing the same number");
  assert.equal(newRounds.length, 0);
});

// ---- AUTO-001.1: Legacy Competition Backfill ----
// Root cause investigation (this ticket): reproduced end-to-end against a
// real running server + real Postgres + the real sportsDataProvider/
// competitionSync pipeline (network mocked, everything else untouched).
// Finding: the backend ALREADY performs this backfill correctly — FIX 1's
// number-collision protection (added in the prior hotfix) is exactly the
// mechanism that makes "existing rounds always win" safe for legacy data
// too, since it doesn't care whether the collision came from a manual
// round, a legacy round, or a different provider. No production code
// change was needed for the backfill mechanism itself; these tests lock
// that guarantee in explicitly under the AUTO-001.1 framing, since no test
// previously used legacy-shaped (provider-less, resultsPublished mixed)
// existing rounds as its starting point.

function legacyRound(number, resultsPublished) {
  return {
    id: "r_legacy_j" + number, number,
    matches: [{ id: "m_j" + number, teamA: "EquipoA" + number, teamB: "EquipoB" + number }],
    deadline: `2026-07-${String(number).padStart(2, "0")}T01:00:00.000Z`,
    results: resultsPublished ? { ["m_j" + number]: "A" } : {},
    resultsPublished,
    // deliberately no `published`, `provider`, `externalRoundId` — exactly
    // how a round created before AUTO-001 looks.
  };
}

test("AUTO-001.1 #1/#3: legacy J1-J5 + provider J1-J17 -> creates only J6-J17, all published:false", () => {
  const legacyRounds = [1, 2, 3, 4, 5].map((n) => legacyRound(n, n <= 3));
  const events = [];
  for (let n = 1; n <= 17; n++) events.push(ev({ round: String(n), externalEventId: "e" + n, dateTime: "2026-08-01T00:00:00Z" }));
  const { newRounds } = planCompetitionSync({ existingRounds: legacyRounds, events, provider: "thesportsdb" });
  assert.deepEqual(newRounds.map((r) => r.number).sort((a, b) => a - b), [6,7,8,9,10,11,12,13,14,15,16,17]);
  assert.ok(newRounds.every((r) => r.published === false), "every backfilled round must start published:false");
});

test("AUTO-001.1 #2: legacy J1-J5 remain byte-for-byte identical after backfill (no ids/matches/picks/results/deadline touched)", () => {
  const legacyRounds = [1, 2, 3, 4, 5].map((n) => legacyRound(n, n <= 3));
  const snapshot = JSON.parse(JSON.stringify(legacyRounds));
  const events = [];
  for (let n = 1; n <= 17; n++) events.push(ev({ round: String(n), externalEventId: "e" + n, dateTime: "2026-08-01T00:00:00Z" }));
  planCompetitionSync({ existingRounds: legacyRounds, events, provider: "thesportsdb" });
  assert.deepEqual(legacyRounds, snapshot);
});

test("AUTO-001.1 #4: re-sync after backfill creates zero additional duplicates", () => {
  const legacyRounds = [1, 2, 3, 4, 5].map((n) => legacyRound(n, n <= 3));
  const events = [];
  for (let n = 1; n <= 17; n++) events.push(ev({ round: String(n), externalEventId: "e" + n, dateTime: "2026-08-01T00:00:00Z" }));
  const first = planCompetitionSync({ existingRounds: legacyRounds, events, provider: "thesportsdb" });
  assert.equal(first.newRounds.length, 12);
  const afterBackfill = [...legacyRounds, ...first.newRounds.map((r) => ({ id: "r_" + r.number, ...r }))];
  const second = planCompetitionSync({ existingRounds: afterBackfill, events, provider: "thesportsdb" });
  assert.equal(second.newRounds.length, 0);
});
