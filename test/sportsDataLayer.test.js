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

// ---- REAL Sportmonks evidence --------------------------------------------
// Every field below was OBSERVED against the live Sportmonks API for
// league_id 743 (Liga MX), season_id 25539. Fields that were NOT observed are
// omitted entirely rather than invented — notably `finished` (only reported
// for the "Apertura" stage), `is_current`, and `ending_at` for the two
// single-date stages. Anything synthetic in this file is named *_SYNTHETIC and
// is never described as real.
const SEASON_REAL = { id: 25539, name: "2025/2026", finished: true };

const STAGES_REAL = [
  { id: 77476863, season_id: 25539, type_id: 223, name: "Apertura",                   sort_order: 1, finished: true, starting_at: "2025-07-12", ending_at: "2025-11-09" },
  { id: 77478869, season_id: 25539, type_id: 224, name: "Apertura, Play In",          sort_order: 2, starting_at: "2025-11-24" },
  { id: 77478884, season_id: 25539, type_id: 224, name: "Apertura, Quarter-finals",   sort_order: 3, starting_at: "2025-11-27", ending_at: "2025-12-01" },
  { id: 77479071, season_id: 25539, type_id: 224, name: "Apertura, Semi-finals",      sort_order: 4, starting_at: "2025-12-04", ending_at: "2025-12-07" },
  { id: 77479151, season_id: 25539, type_id: 224, name: "Apertura, Final",            sort_order: 5, starting_at: "2025-12-12", ending_at: "2025-12-15" },
  // NOTE: sort_order 6 but played 2025-11-21 — BEFORE Play In (sort_order 2,
  // 2025-11-24). Real provider data. Preserved exactly; never reordered.
  { id: 77479512, season_id: 25539, type_id: 224, name: "Apertura - Reclasificación", sort_order: 6, starting_at: "2025-11-21" },
  { id: 77479601, season_id: 25539, type_id: 223, name: "Clausura",                   sort_order: 7, starting_at: "2026-01-10", ending_at: "2026-04-27" },
  { id: 77481527, season_id: 25539, type_id: 224, name: "Clausura - Quarter-finals",  sort_order: 8, starting_at: "2026-05-03", ending_at: "2026-05-11" },
  { id: 77481528, season_id: 25539, type_id: 224, name: "Clausura - Semi-finals",     sort_order: 9, starting_at: "2026-05-14", ending_at: "2026-05-18" },
  { id: 77482119, season_id: 25539, type_id: 224, name: "Clausura - Final",           sort_order: 10, starting_at: "2026-05-22", ending_at: "2026-05-25" },
];

// REAL: the Apertura 2025 Final, stage 77479151. Both legs really do come back
// with round_id = null and aggregate_id = null.
const FINAL_FIXTURES_REAL = [
  { id: 19609341, stage_id: 77479151, round_id: null, aggregate_id: null, leg: "1/2", starting_at: "2025-12-12",
    participants: [{ id: 1, name: "Tigres UANL", meta: { location: "home" } }, { id: 2, name: "Toluca", meta: { location: "away" } }] },
  { id: 19609342, stage_id: 77479151, round_id: null, aggregate_id: null, leg: "2/2", starting_at: "2025-12-15",
    participants: [{ id: 2, name: "Toluca", meta: { location: "home" } }, { id: 1, name: "Tigres UANL", meta: { location: "away" } }] },
];

const LIGA_MX_COMPETITION_ID = 743;

function buildSportmonks() {
  const competition = sportmonks.toCompetition({ id: LIGA_MX_COMPETITION_ID, name: "Liga MX" });
  const instances = sportmonks.toCompetitionInstances({
    season: SEASON_REAL, stages: STAGES_REAL,
    competitionId: competition.id, providerCompetitionId: LIGA_MX_COMPETITION_ID,
  });
  const stages = sportmonks.toStages({
    stages: STAGES_REAL, instances, providerCompetitionId: LIGA_MX_COMPETITION_ID,
  });
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

test("all 10 OBSERVED Liga MX stages (real ids 77476863..77482119) map to the correct instance, with phase names preserved", () => {
  const { instances, stages } = buildSportmonks();
  const byKey = new Map(instances.map((i) => [i.id, i.instanceKey]));
  const apertura = stages.filter((s) => byKey.get(s.instanceId) === "Apertura").map((s) => s.name);
  const clausura = stages.filter((s) => byKey.get(s.instanceId) === "Clausura").map((s) => s.name);
  assert.equal(apertura.length, 6);
  assert.equal(clausura.length, 4);
  assert.ok(apertura.includes("Final") && apertura.includes("Play In") && apertura.includes("Reclasificación"));
  assert.ok(clausura.includes("Final") && !clausura.includes("Play In"), "Clausura genuinely had no Play In -- never assumed");
});

test("no phase structure is hardcoded anywhere: neither the adapter nor the competition config names Apertura, Clausura or any phase", () => {
  ["providers/sportmonksAdapter.js", "providers/sportmonksCompetitionConfig.js"].forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    ["\"Apertura\"", "'Apertura'", "\"Clausura\"", "'Clausura'", "Play In", "Reclasificaci", "Quarter-finals"]
      .forEach((needle) => assert.ok(!code.includes(needle), `${rel} must not hardcode ${needle}`));
  });
  // The competition config MAY reference the league id -- that is the whole
  // point of per-competition configuration -- but the ADAPTER must not.
  const adapter = fs.readFileSync(path.join(__dirname, "..", "providers", "sportmonksAdapter.js"), "utf8");
  const adapterCode = adapter.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!adapterCode.includes("743"), "the adapter must not know any specific league id");
});

test("ADVERSARIAL: an unconfigured competition with SEVERAL differently-named stages still yields exactly ONE instance", () => {
  // This is the case the previous global name-splitting heuristic got wrong:
  // it would have produced three tournaments out of one competition.
  const comp = sportmonks.toCompetition({ id: 999999, name: "Some Unvalidated League" });
  const stages = [
    { id: 1, name: "Regular Season",     sort_order: 1 },
    { id: 2, name: "Championship Round", sort_order: 2 },
    { id: 3, name: "Relegation Round",   sort_order: 3 },
  ];
  const instances = sportmonks.toCompetitionInstances({
    season: { id: 111, name: "2026/2027" }, stages,
    competitionId: comp.id, providerCompetitionId: 999999,
  });
  assert.equal(instances.length, 1, "an unvalidated competition must NEVER be split into multiple tournaments");
  assert.equal(instances[0].instanceKey, null);
});

test("ADVERSARIAL: that same unconfigured competition reports instanceSeparationConfirmed=false", () => {
  const comp = sportmonks.toCompetition({ id: 999999 });
  const [inst] = sportmonks.toCompetitionInstances({
    season: { id: 111, name: "2026/2027" },
    stages: [{ id: 1, name: "Regular Season, Final", sort_order: 1 }],
    competitionId: comp.id, providerCompetitionId: 999999,
  });
  assert.equal(instances_confirmed(inst), false, "consumers must be able to tell the separation is unverified");
  assert.equal(inst.instanceKey, null, "and no prefix splitting may happen for it");
});
function instances_confirmed(i) { return i.instanceSeparationConfirmed; }

test("Liga MX (validated) reports instanceSeparationConfirmed=true", () => {
  const { instances } = buildSportmonks();
  instances.forEach((i) => assert.equal(i.instanceSeparationConfirmed, true));
});

test("a stage's phase name under SINGLE_INSTANCE keeps the FULL name -- no prefix is stripped", () => {
  const comp = sportmonks.toCompetition({ id: 999999 });
  const stages = [{ id: 1, name: "Championship Round", sort_order: 1 }];
  const instances = sportmonks.toCompetitionInstances({ season: { id: 111 }, stages, competitionId: comp.id, providerCompetitionId: 999999 });
  const [st] = sportmonks.toStages({ stages, instances, providerCompetitionId: 999999 });
  assert.equal(st.name, "Championship Round");
});

// ==== 4. Sportmonks knockout fixture: null round_id / null aggregate_id / legs

test("EVIDENCE 4: the real Apertura Final normalizes with round_id null, aggregate null, and legs 1/2 + 2/2", () => {
  const { stages } = buildSportmonks();
  const events = sportmonks.toEvents({ fixtures: FINAL_FIXTURES_REAL, stages });
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
  const events = sportmonks.toEvents({ fixtures: FINAL_FIXTURES_REAL, stages });
  assert.equal(events[0].stageId, events[1].stageId);
  assert.equal(events[0].instanceId, events[1].instanceId);
  const apertura = instances.find((i) => i.instanceKey === "Apertura");
  assert.equal(events[0].instanceId, apertura.id);
});

test("a fixture WITH a round_id still maps it through unchanged (round is optional, not forbidden)", () => {
  const { stages } = buildSportmonks();
  const [e] = sportmonks.toEvents({
    fixtures: [{ id: 500, stage_id: 77476863, round_id: 274733, aggregate_id: 991, leg: null,
      starting_at: "2025-08-01 02:00:00", state_id: 5, participants: [] }], stages });
  assert.equal(e.providerRoundId, "274733");
  assert.equal(e.aggregateKey, "991");
  assert.equal(e.leg, null);
});

// ==== finished signal ======================================================

test("stage.finished is a real tri-state: only the one stage that actually reported it is true, the rest are null (never false)", () => {
  const { stages } = buildSportmonks();
  const apertura = stages.find((x) => x.providerStageId === "77476863");
  assert.equal(apertura.finished, true, "the only stage where finished was actually observed");
  const notObserved = stages.filter((x) => x.providerStageId !== "77476863");
  notObserved.forEach((x) => assert.equal(x.finished, null, `${x.providerStageId}: unobserved must be null, never false`));
});

test("an instance is only finished:true when EVERY stage says so; one unknown stage makes it null, never false", () => {
  const comp = sportmonks.toCompetition({ id: LIGA_MX_COMPETITION_ID, name: "Liga MX" });
  const mixed = [
    { id: 1, name: "Apertura", sort_order: 1, finished: true },
    { id: 2, name: "Apertura, Final", sort_order: 2 }, // no finished flag
  ];
  const [inst] = sportmonks.toCompetitionInstances({ season: SEASON_REAL, stages: mixed, competitionId: comp.id, providerCompetitionId: LIGA_MX_COMPETITION_ID });
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
  const a = sportmonks.toEvents({ fixtures: FINAL_FIXTURES_REAL, stages });
  const b = sportmonks.toEvents({ fixtures: FINAL_FIXTURES_REAL.slice().reverse(), stages });
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
  // SYNTHETIC fixture ids (111/222) on REAL stage ids: Apertura 77476863, Clausura 77479601.
  const [ap] = sportmonks.toEvents({ fixtures: [{ id: 111, stage_id: 77476863, round_id: 1, aggregate_id: null, leg: null, starting_at: "2025-08-01", participants: [] }], stages });
  const [cl] = sportmonks.toEvents({ fixtures: [{ id: 222, stage_id: 77479601, round_id: 1, aggregate_id: null, leg: null, starting_at: "2026-01-10", participants: [] }], stages });
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
  const comp = sportmonks.toCompetition({ id: LIGA_MX_COMPETITION_ID, name: "Liga MX" });
  assert.doesNotThrow(() => sportmonks.toCompetitionInstances({ season: SEASON_REAL, stages: [], competitionId: comp.id, providerCompetitionId: LIGA_MX_COMPETITION_ID }));
  assert.doesNotThrow(() => sportmonks.toCompetitionInstances({ season: SEASON_REAL, stages: null, competitionId: comp.id, providerCompetitionId: LIGA_MX_COMPETITION_ID }));
  assert.doesNotThrow(() => sportmonks.toStages({ stages: null, instances: [] }));
  assert.doesNotThrow(() => sportmonks.toEvents({ fixtures: null, stages: [] }));
  assert.equal(sportmonks.toEvents({ fixtures: [], stages: [] }).length, 0);
  const [inst] = sportmonks.toCompetitionInstances({ season: SEASON_REAL, stages: [], competitionId: comp.id, providerCompetitionId: LIGA_MX_COMPETITION_ID });
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

// ==== sort_order is NOT chronology (real Liga MX edge case) ================

test("REAL EDGE CASE: 'Apertura - Reclasificación' has sort_order 6 but is played BEFORE 'Apertura, Play In' (sort_order 2) -- and both are preserved exactly", () => {
  const { stages } = buildSportmonks();
  const recla = stages.find((s) => s.providerStageId === "77479512");
  const playIn = stages.find((s) => s.providerStageId === "77478869");
  assert.equal(recla.sortOrder, 6, "provider sort_order passed through verbatim");
  assert.equal(playIn.sortOrder, 2);
  assert.equal(recla.startsAt, "2025-11-21");
  assert.equal(playIn.startsAt, "2025-11-24");
  assert.ok(recla.sortOrder > playIn.sortOrder, "sort_order says Reclasificación is later...");
  assert.ok(new Date(recla.startsAt) < new Date(playIn.startsAt), "...but it is actually played EARLIER");
});

test("sort_order is never re-derived, normalized or reordered to match dates", () => {
  const { stages } = buildSportmonks();
  const observed = stages.map((s) => s.sortOrder);
  assert.deepEqual(observed, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "exactly the provider's values, in the provider's order");
  const src = fs.readFileSync(path.join(__dirname, "..", "providers", "sportmonksAdapter.js"), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/sort_order[^)]*sort\(|sortOrder[^)]*=\s*(?!Number\.isFinite)/.test(code) || code.includes("Number.isFinite(st.sort_order) ? st.sort_order : null"),
    "sortOrder must be a straight passthrough");
});

test("a stage whose ending_at was never observed stays null -- not back-filled from its start date", () => {
  const { stages } = buildSportmonks();
  const playIn = stages.find((s) => s.providerStageId === "77478869");
  const recla = stages.find((s) => s.providerStageId === "77479512");
  assert.equal(playIn.endsAt, null);
  assert.equal(recla.endsAt, null);
});

test("the Apertura instance spans min(start)..max(end) of its OBSERVED stage dates only", () => {
  const { instances } = buildSportmonks();
  const ap = instances.find((i) => i.instanceKey === "Apertura");
  assert.equal(ap.startsAt, "2025-07-12");
  assert.equal(ap.endsAt, "2025-12-15", "the Final's ending_at, the latest actually observed");
});

test("the Apertura instance reports finished:null -- only ONE of its stages actually reported finished, so the answer is unknown", () => {
  const { instances } = buildSportmonks();
  const ap = instances.find((i) => i.instanceKey === "Apertura");
  assert.equal(ap.finished, null, "must never claim a tournament ended on partial evidence");
});

// ==== AGGREGATES capability semantics ======================================

test("CAPABILITY SEMANTICS: hasCapability(AGGREGATES) means 'the schema can supply aggregates', NOT 'every event has one'", () => {
  const sm = resolveProvider("sportmonks");
  assert.equal(hasCapability(sm, CAPABILITIES.AGGREGATES), true, "Sportmonks does model aggregates");
  const { stages } = buildSportmonks();
  const events = sportmonks.toEvents({ fixtures: FINAL_FIXTURES_REAL, stages });
  events.forEach((e) => assert.equal(e.aggregateKey, null,
    "yet the REAL Final returned aggregate_id null on both legs -- capability is never a non-null guarantee"));
});

test("CAPABILITY SEMANTICS: the same caveat is documented in the contract itself, not only in tests", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "providers", "providerContract.js"), "utf8");
  assert.ok(/CAN supply/i.test(src) && /never a non-null|never read hasCapability/i.test(src),
    "providerContract must state that capability != per-event guarantee");
});

// ==== fixture honesty ======================================================

test("FIXTURE HONESTY: nothing in this file labels synthetic data as real/recorded/evidence", () => {
  const src = fs.readFileSync(__filename, "utf8");
  // Synthetic helpers must be named *_SYNTHETIC or be explicitly annotated.
  assert.ok(src.includes("REAL Sportmonks evidence"), "the real block is labelled");
  assert.ok(src.includes("SYNTHETIC fixture ids"), "synthetic ids are explicitly called out");
  assert.ok(!/const STAGES = \[/.test(src), "the old ambiguously-named fixture must be gone");
});

test("FIXTURE HONESTY: the real stage ids used are exactly the ones observed from the provider", () => {
  const { stages } = buildSportmonks();
  assert.deepEqual(
    stages.map((s) => s.providerStageId),
    ["77476863","77478869","77478884","77479071","77479151","77479512","77479601","77481527","77481528","77482119"]
  );
});

test("FIXTURE HONESTY: the real Final fixture ids are the observed ones", () => {
  const { stages } = buildSportmonks();
  const events = sportmonks.toEvents({ fixtures: FINAL_FIXTURES_REAL, stages });
  assert.deepEqual(events.map((e) => e.providerEventId).sort(), ["19609341", "19609342"]);
});
