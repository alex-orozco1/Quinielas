// DATA-003 — Sports Data Layer.
// Pure-mapper tests against RECORDED payloads. No live API, no token, ever.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const domain = require("../sportsDomain");
const { CAPABILITIES, assertImplementsContract, hasCapability } = require("../providers/providerContract");
const { resolveProvider, listProviders } = require("../providers/providerRegistry");
const sportmonks = require("../providers/sportmonksAdapter");
const { planCompetitionSync } = require("../competitionSync");

// ---- Recorded Sportmonks fixtures (Liga MX 743, season 25539 "2025/2026") --
const SEASON = { id: 25539, name: "2025/2026", finished: true, starting_at: "2025-07-11", ending_at: "2026-05-31" };
const STAGES = [
  { id: 77479101, season_id: 25539, type_id: 223, name: "Apertura",                   sort_order: 1, finished: true,  is_current: false, starting_at: "2025-07-11", ending_at: "2025-11-16" },
  { id: 77479110, season_id: 25539, type_id: 224, name: "Apertura - Reclasificación", sort_order: 2, finished: true,  is_current: false, starting_at: "2025-11-19", ending_at: "2025-11-22" },
  { id: 77479120, season_id: 25539, type_id: 224, name: "Apertura, Play In",          sort_order: 3, finished: true,  is_current: false, starting_at: "2025-11-19", ending_at: "2025-11-22" },
  { id: 77479130, season_id: 25539, type_id: 224, name: "Apertura, Quarter-finals",   sort_order: 4, finished: true,  is_current: false, starting_at: "2025-11-26", ending_at: "2025-11-30" },
  { id: 77479140, season_id: 25539, type_id: 224, name: "Apertura, Semi-finals",      sort_order: 5, finished: true,  is_current: false, starting_at: "2025-12-03", ending_at: "2025-12-07" },
  { id: 77479151, season_id: 25539, type_id: 224, name: "Apertura, Final",            sort_order: 6, finished: true,  is_current: false, starting_at: "2025-12-11", ending_at: "2025-12-14" },
  { id: 77479200, season_id: 25539, type_id: 223, name: "Clausura",                   sort_order: 7, finished: true,  is_current: false, starting_at: "2026-01-09", ending_at: "2026-04-26" },
  { id: 77479230, season_id: 25539, type_id: 224, name: "Clausura - Quarter-finals",  sort_order: 8, finished: true,  is_current: false, starting_at: "2026-04-29", ending_at: "2026-05-03" },
  { id: 77479240, season_id: 25539, type_id: 224, name: "Clausura - Semi-finals",     sort_order: 9, finished: true,  is_current: false, starting_at: "2026-05-06", ending_at: "2026-05-10" },
  { id: 77479250, season_id: 25539, type_id: 224, name: "Clausura - Final",           sort_order: 10, finished: true, is_current: false, starting_at: "2026-05-21", ending_at: "2026-05-24" },
];
// The real Apertura Final: round_id null, aggregate_id null, identity in leg.
const FINAL_FIXTURES = [
  { id: 19001, stage_id: 77479151, round_id: null, aggregate_id: null, leg: "1/2", starting_at: "2025-12-11 02:00:00", state_id: 5,
    participants: [{ id: 1, name: "Tigres UANL", meta: { location: "home" } }, { id: 2, name: "Toluca", meta: { location: "away" } }] },
  { id: 19002, stage_id: 77479151, round_id: null, aggregate_id: null, leg: "2/2", starting_at: "2025-12-14 02:00:00", state_id: 5,
    participants: [{ id: 2, name: "Toluca", meta: { location: "home" } }, { id: 1, name: "Tigres UANL", meta: { location: "away" } }] },
];

function buildSportmonks() {
  const competition = sportmonks.toCompetition({ id: 743, name: "Liga MX" });
  const instances = sportmonks.toCompetitionInstances({ season: SEASON, stages: STAGES, competitionId: competition.id });
  const stages = sportmonks.toStages({ stages: STAGES, instances });
  return { competition, instances, stages };
}

// ==== 1. Contract & registry ==============================================

test("both adapters implement the SportsProvider contract", () => {
  listProviders().forEach((k) => assert.ok(assertImplementsContract(resolveProvider(k))));
  assert.deepEqual(listProviders().sort(), ["sportmonks", "thesportsdb"]);
});

test("an unknown provider fails loudly -- never silently defaults to one", () => {
  assert.throws(() => resolveProvider("nope"), /Unknown sports data provider/);
});

test("capabilities are DECLARED, not guessed: TheSportsDB honestly reports it has no stages/finished/legs", () => {
  const tsdb = resolveProvider("thesportsdb");
  [CAPABILITIES.STAGES, CAPABILITIES.FINISHED_SIGNAL, CAPABILITIES.LEGS,
   CAPABILITIES.AGGREGATES, CAPABILITIES.MULTI_INSTANCE_SEASONS]
    .forEach((c) => assert.equal(hasCapability(tsdb, c), false, `must not claim ${c}`));
  const sm = resolveProvider("sportmonks");
  [CAPABILITIES.STAGES, CAPABILITIES.FINISHED_SIGNAL, CAPABILITIES.LEGS,
   CAPABILITIES.AGGREGATES, CAPABILITIES.MULTI_INSTANCE_SEASONS]
    .forEach((c) => assert.equal(hasCapability(sm, c), true, `must support ${c}`));
});

// ==== 5. Apertura & Clausura share a provider season, are distinct instances

test("EVIDENCE 5: one Sportmonks season (25539) yields TWO CompetitionInstances -- Apertura and Clausura", () => {
  const { instances } = buildSportmonks();
  const keys = instances.map((i) => i.instanceKey).sort();
  assert.deepEqual(keys, ["Apertura", "Clausura"]);
  instances.forEach((i) => assert.equal(i.providerSeasonId, "25539", "both share the same provider season"));
});

test("EVIDENCE 5: the two instances have DIFFERENT domain ids despite the shared provider season", () => {
  const { instances } = buildSportmonks();
  assert.notEqual(instances[0].id, instances[1].id);
  assert.equal(new Set(instances.map((i) => i.id)).size, 2);
});

test("CompetitionInstance is explicitly NOT equal to provider season", () => {
  const { instances } = buildSportmonks();
  assert.ok(instances.length > 1, "a provider season can contain more than one tournament");
});

test("all 10 real Liga MX stages map to the correct instance, with phase names preserved", () => {
  const { instances, stages } = buildSportmonks();
  const byKey = new Map(instances.map((i) => [i.id, i.instanceKey]));
  const apertura = stages.filter((s) => byKey.get(s.instanceId) === "Apertura").map((s) => s.name);
  const clausura = stages.filter((s) => byKey.get(s.instanceId) === "Clausura").map((s) => s.name);
  assert.equal(apertura.length, 6);
  assert.equal(clausura.length, 4);
  assert.ok(apertura.includes("Final") && apertura.includes("Play In") && apertura.includes("Reclasificación"));
  assert.ok(clausura.includes("Final") && !clausura.includes("Play In"), "Clausura genuinely had no Play In -- never assumed");
});

test("instance derivation is a GENERIC string rule -- no Liga MX, Apertura or league_id hardcoded in the adapter", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "providers", "sportmonksAdapter.js"), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  ["743", "\"Apertura\"", "'Apertura'", "\"Clausura\"", "'Clausura'", "Play In"]
    .forEach((needle) => assert.ok(!code.includes(needle), `adapter logic must not hardcode ${needle}`));
});

test("a normal European league (no separator in stage names) collapses to exactly ONE instance", () => {
  const comp = sportmonks.toCompetition({ id: 8, name: "Premier League" });
  const stages = [{ id: 1, name: "Regular Season", sort_order: 1, finished: false, starting_at: "2026-08-01", ending_at: "2027-05-30" }];
  const instances = sportmonks.toCompetitionInstances({ season: { id: 25580, name: "2026/2027" }, stages, competitionId: comp.id });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].instanceKey, "Regular Season");
});

// ==== 4. Sportmonks knockout fixture: null round_id / null aggregate_id / legs

test("EVIDENCE 4: the real Apertura Final normalizes with round_id null, aggregate null, and legs 1/2 + 2/2", () => {
  const { stages } = buildSportmonks();
  const events = sportmonks.toEvents({ fixtures: FINAL_FIXTURES, stages });
  assert.equal(events.length, 2);
  events.forEach((e) => {
    assert.equal(e.providerRoundId, null, "round_id is genuinely null and must not be invented");
    assert.equal(e.aggregateKey, null, "aggregate_id is genuinely null and must not be invented");
    assert.ok(e.stageId, "identity comes from the stage instead");
  });
  assert.deepEqual(events.map((e) => e.leg).sort(), ["1/2", "2/2"]);
});

test("EVIDENCE 4: both Final legs resolve to the SAME stage and the SAME CompetitionInstance", () => {
  const { instances, stages } = buildSportmonks();
  const events = sportmonks.toEvents({ fixtures: FINAL_FIXTURES, stages });
  assert.equal(events[0].stageId, events[1].stageId);
  assert.equal(events[0].instanceId, events[1].instanceId);
  const apertura = instances.find((i) => i.instanceKey === "Apertura");
  assert.equal(events[0].instanceId, apertura.id);
});

test("a fixture WITH a round_id still maps it through unchanged (round is optional, not forbidden)", () => {
  const { stages } = buildSportmonks();
  const [e] = sportmonks.toEvents({
    fixtures: [{ id: 500, stage_id: 77479101, round_id: 274733, aggregate_id: 991, leg: null,
      starting_at: "2025-08-01 02:00:00", state_id: 5, participants: [] }], stages });
  assert.equal(e.providerRoundId, "274733");
  assert.equal(e.aggregateKey, "991");
  assert.equal(e.leg, null);
});

// ==== finished signal ======================================================

test("stage.finished is passed through as a real tri-state and never coerced", () => {
  const { stages } = buildSportmonks();
  assert.equal(stages.every((s) => s.finished === true), true);
  const [unknown] = sportmonks.toStages({
    stages: [{ id: 9, name: "Regular Season", sort_order: 1 }],
    instances: [{ instanceKey: "Regular Season", id: "x" }],
  });
  assert.equal(unknown.finished, null, "absent must be null (unknown), never false");
});

test("an instance is only finished:true when EVERY stage says so; one unknown stage makes it null, never false", () => {
  const comp = sportmonks.toCompetition({ id: 743, name: "Liga MX" });
  const mixed = [
    { id: 1, name: "Apertura", sort_order: 1, finished: true },
    { id: 2, name: "Apertura, Final", sort_order: 2 }, // no finished flag
  ];
  const [inst] = sportmonks.toCompetitionInstances({ season: SEASON, stages: mixed, competitionId: comp.id });
  assert.equal(inst.finished, null, "unknown must never be reported as a definitive answer");
});

// ==== 6. Legacy TheSportsDB compatibility =================================

test("EVIDENCE 6: TheSportsDB events still normalize into the domain, with stage/leg/aggregate honestly null", () => {
  const tsdb = resolveProvider("thesportsdb");
  const comp = tsdb.toCompetition({ externalLeagueId: "4350", name: "Liga MX" });
  const instances = tsdb.toCompetitionInstances({ season: "2025-2026", competitionId: comp.id });
  const events = tsdb.toEvents({
    events: [{ externalEventId: "2487452", round: "1", dateTime: "2025-08-01T02:00:00Z", status: "scheduled",
      participants: [{ role: "home", externalId: "10", name: "A" }, { role: "away", externalId: "20", name: "B" }] }],
    instances,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].providerRoundId, "1");
  assert.equal(events[0].stageId, null);
  assert.equal(events[0].leg, null);
  assert.equal(events[0].aggregateKey, null);
  assert.equal(events[0].instanceId, instances[0].id);
});

test("EVIDENCE 6: TheSportsDB reports finished as null -- it cannot answer, and null is not 'false'", () => {
  const tsdb = resolveProvider("thesportsdb");
  const comp = tsdb.toCompetition({ externalLeagueId: "4350" });
  const [inst] = tsdb.toCompetitionInstances({ season: "2025-2026", competitionId: comp.id });
  assert.equal(inst.finished, null);
});

test("EVIDENCE 6: the existing planCompetitionSync is untouched by DATA-003 -- legacy quinielas keep working", () => {
  const events = [];
  for (let n = 1; n <= 17; n++) {
    events.push({ provider: "thesportsdb", externalEventId: "e" + n, round: String(n),
      dateTime: `2026-08-${String((n % 28) + 1).padStart(2, "0")}T18:00:00Z`,
      participants: [{ role: "home", externalId: "h", name: "A" }, { role: "away", externalId: "a", name: "B" }] });
  }
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: "thesportsdb" });
  assert.deepEqual(newRounds.map((r) => r.number).sort((a, b) => a - b),
    [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]);
});

test("the reverted date heuristic is GONE from the codebase", () => {
  const sync = fs.readFileSync(path.join(__dirname, "..", "competitionSync.js"), "utf8");
  assert.ok(!sync.includes("ROUND_SPLIT_GAP_DAYS"));
  assert.ok(!/gap.*24 \* 60 \* 60 \* 1000/.test(sync), "no date-gap phase inference may remain");
});

test("no provider field name leaks above the domain boundary", () => {
  const dom = fs.readFileSync(path.join(__dirname, "..", "sportsDomain.js"), "utf8");
  const code = dom.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  ["intRound", "strSeason", "idEvent", "stage_id", "aggregate_id", "round_id"]
    .forEach((f) => assert.ok(!code.includes(f), `domain must not mention provider field ${f}`));
});

// ==== 8. Stable, idempotent domain ids ====================================

test("EVIDENCE 8: domain ids are stable and derived from provider identity -- never from array position or import order", () => {
  const { stages } = buildSportmonks();
  const a = sportmonks.toEvents({ fixtures: FINAL_FIXTURES, stages });
  const b = sportmonks.toEvents({ fixtures: FINAL_FIXTURES.slice().reverse(), stages });
  assert.deepEqual(a.map((e) => e.id).sort(), b.map((e) => e.id).sort(), "same payload, same ids, any order");
});

test("EVIDENCE 8: ids are namespaced by provider, so two providers can coexist without collision", () => {
  const smId = domain.makeEvent({ provider: "sportmonks", providerEventId: "1" }).id;
  const tsId = domain.makeEvent({ provider: "thesportsdb", providerEventId: "1" }).id;
  assert.notEqual(smId, tsId);
  assert.ok(smId.startsWith("sportmonks:") && tsId.startsWith("thesportsdb:"));
});

test("EVIDENCE 2 (domain level): the SAME provider round number in two instances produces two DISTINCT events", () => {
  const { stages } = buildSportmonks();
  const [ap] = sportmonks.toEvents({ fixtures: [{ id: 111, stage_id: 77479101, round_id: 1, aggregate_id: null, leg: null, starting_at: "2025-08-01 02:00:00", state_id: 5, participants: [] }], stages });
  const [cl] = sportmonks.toEvents({ fixtures: [{ id: 222, stage_id: 77479200, round_id: 1, aggregate_id: null, leg: null, starting_at: "2026-01-10 02:00:00", state_id: 5, participants: [] }], stages });
  assert.equal(ap.providerRoundId, cl.providerRoundId, "both are the provider's round 1");
  assert.notEqual(ap.instanceId, cl.instanceId, "but they belong to different tournaments");
  assert.notEqual(ap.id, cl.id, "and are never the same domain entity");
});

// ==== 1 & 3. KNOWN DEBT, proven not hidden ===============================
// These document defects that exist in the LEGACY TheSportsDB path today and
// that DATA-003 deliberately does not patch (patching them inside the old
// approach is exactly what the correction forbade). They will fail loudly the
// moment a follow-up ticket fixes them, which is the intent.

test("KNOWN DEBT 1 (incremental sync): a second sync bringing a NEW event under an already-imported externalRoundId is silently dropped", () => {
  const mk = (r, d, id) => ({ provider: "thesportsdb", externalEventId: id, round: r, dateTime: d,
    participants: [{ role: "home", externalId: "h", name: "A" }, { role: "away", externalId: "a", name: "B" }] });
  const first = planCompetitionSync({ existingRounds: [], events: [mk("0", "2025-11-21T02:00:00Z", "k1")], provider: "thesportsdb" });
  const existing = first.newRounds.map((r, i) => ({ ...r, id: "r" + i }));
  const second = planCompetitionSync({ existingRounds: existing,
    events: [mk("0", "2025-11-21T02:00:00Z", "k1"), mk("0", "2025-11-27T02:00:00Z", "k2")], provider: "thesportsdb" });
  assert.equal(second.newRounds.length, 0, "DOCUMENTED DEFECT: the Nov 27 event is dropped");
  assert.equal(second.skippedEvents, 0, "and it is not even counted as skipped -- fully silent");
});

test("KNOWN DEBT 3: deduplication is keyed only by externalRoundId, which is NOT a unique round identity", () => {
  const sync = fs.readFileSync(path.join(__dirname, "..", "competitionSync.js"), "utf8");
  assert.ok(sync.includes("existingExternalRoundIds.has(ev.round)"),
    "documents the exact line responsible; the domain layer above now provides the stable identity needed to fix it");
});

test("KNOWN DEBT 3: the reverted commit's duplicate-round.number defect is gone -- legacy path produces unique numbers", () => {
  const mk = (r, d, id) => ({ provider: "thesportsdb", externalEventId: id, round: r, dateTime: d,
    participants: [{ role: "home", externalId: "h", name: "A" }, { role: "away", externalId: "a", name: "B" }] });
  const { newRounds } = planCompetitionSync({ existingRounds: [],
    events: [mk("1", "2025-08-01T02:00:00Z", "a1"), mk("1", "2026-01-10T02:00:00Z", "c1")], provider: "thesportsdb" });
  const numbers = newRounds.map((r) => r.number);
  assert.equal(new Set(numbers).size, numbers.length, "no two rounds may share a number (5c217c4 produced [1,1])");
});

// ==== 7. Sportmonks error surfaces ========================================
// The mappers are pure, so error handling is a client concern -- but the
// mappers must never throw or fabricate data on malformed input.

test("EVIDENCE 7: malformed / empty / missing payloads degrade safely instead of throwing", () => {
  const comp = sportmonks.toCompetition({ id: 743, name: "Liga MX" });
  assert.doesNotThrow(() => sportmonks.toCompetitionInstances({ season: SEASON, stages: [], competitionId: comp.id }));
  assert.doesNotThrow(() => sportmonks.toCompetitionInstances({ season: SEASON, stages: null, competitionId: comp.id }));
  assert.doesNotThrow(() => sportmonks.toStages({ stages: null, instances: [] }));
  assert.doesNotThrow(() => sportmonks.toEvents({ fixtures: null, stages: [] }));
  assert.equal(sportmonks.toEvents({ fixtures: [], stages: [] }).length, 0);
  const [inst] = sportmonks.toCompetitionInstances({ season: SEASON, stages: [], competitionId: comp.id });
  assert.ok(inst, "a season with no stages still yields one instance to attach events to");
});

test("EVIDENCE 7: a fixture referencing an unknown stage still normalizes, with stage/instance null rather than a crash", () => {
  const [e] = sportmonks.toEvents({
    fixtures: [{ id: 777, stage_id: 999999, round_id: null, aggregate_id: null, leg: null, starting_at: null, state_id: 1, participants: [] }],
    stages: [],
  });
  assert.equal(e.stageId, null);
  assert.equal(e.instanceId, null);
  assert.equal(e.id, "sportmonks:event:777");
});

test("required identity is enforced -- a payload with no event id fails loudly instead of producing an unstable id", () => {
  assert.throws(() => domain.makeEvent({ provider: "sportmonks" }), /providerEventId are required/);
  assert.throws(() => domain.makeCompetition({ provider: "sportmonks" }), /providerCompetitionId are required/);
});

// ==== SECRETS ==============================================================

test("SECRETS: no Sportmonks token is hardcoded anywhere in the layer or its fixtures", () => {
  ["providers/sportmonksAdapter.js", "providers/providerRegistry.js", "providers/providerContract.js",
   "sportsDomain.js", "test/sportsDataLayer.test.js"].forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(!/api_token\s*=\s*["'][A-Za-z0-9]{8,}/.test(src), `${rel} must not embed a token`);
    // Needle built at runtime so this assertion does not match its own source.
    const assignNeedle = ["SPORTMONKS", "API", "TOKEN"].join("_") + "=";
    assert.ok(!src.includes(assignNeedle), `${rel} must not assign the token`);
  });
});

test("SECRETS: the pure mappers never read process.env at all", () => {
  ["providers/sportmonksAdapter.js", "sportsDomain.js"].forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(!src.includes("process.env"), `${rel} must stay pure and env-free`);
  });
});
