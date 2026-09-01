// adapterMalformedInput.test.js — DATA-003 closure correction 2.
//
// Malformed provider input must degrade safely, and it must do so
// SYMMETRICALLY in both adapters. The bug this suite exists to prevent was
// real and shipped: theSportsDbDomainAdapter did
//
//     competitors: (ev.participants || []).map(...)
//
// and `{}`, `"garbage"`, `true` and `5` are all TRUTHY with no .map, so a
// single wrong-typed field threw "map is not a function" and took the entire
// batch down -- including the perfectly valid events next to it. A previous
// report claimed "participants non-array is already handled"; that guard
// existed only in the Sportmonks mapper and was never tested in either
// adapter. Every case below therefore reproduces the EXACT malformed shape
// rather than a stand-in: null does not prove {}, and {} does not prove "".

const test = require("node:test");
const assert = require("node:assert/strict");

const sportmonks = require("../providers/sportmonksAdapter");
const thesportsdb = require("../providers/theSportsDbDomainAdapter");

// Every wrong type, including the truthy ones that `x || []` lets through.
const NON_ARRAYS = [{}, "garbage", "", true, false, 5, 0, null, undefined];
// Elements that are not readable records at all.
const NON_OBJECT_ELEMENTS = [null, undefined, true, false, "garbage", 5, 0];

const tsdbEvent = (over = {}) => ({ externalEventId: "1", status: "finished", ...over });
const smFixture = (over = {}) => ({ id: 1, stage_id: null, round_id: null, aggregate_id: null, leg: null, starting_at: null, state_id: 1, ...over });
const instances = [{ id: "thesportsdb:instance:2025" }];

// ==== A. participants: wrong COLLECTION type ================================

test("TSDB: a truthy non-array `participants` does not crash and yields no competitors", () => {
  for (const participants of NON_ARRAYS) {
    const events = thesportsdb.toEvents({ events: [tsdbEvent({ participants })], instances });
    assert.equal(events.length, 1, `participants ${JSON.stringify(participants)}: the event must survive`);
    assert.deepEqual(events[0].competitors, [], `participants ${JSON.stringify(participants)}: no competitors`);
  }
});

test("SPORTMONKS: a truthy non-array `participants` does not crash and yields no competitors", () => {
  for (const participants of NON_ARRAYS) {
    const events = sportmonks.toEvents({ fixtures: [smFixture({ participants })], stages: [] });
    assert.equal(events.length, 1, `participants ${JSON.stringify(participants)}: the event must survive`);
    assert.deepEqual(events[0].competitors, [], `participants ${JSON.stringify(participants)}: no competitors`);
  }
});

// ==== B. participants: malformed ELEMENTS inside a valid array ==============

test("TSDB: non-object participant elements are skipped, never read and never turned into phantom competitors", () => {
  for (const el of NON_OBJECT_ELEMENTS) {
    const events = thesportsdb.toEvents({ events: [tsdbEvent({ participants: [el] })], instances });
    assert.equal(events.length, 1, `element ${JSON.stringify(el)}: the event must survive`);
    assert.deepEqual(events[0].competitors, [], `element ${JSON.stringify(el)}: must be skipped, not kept as an all-null competitor`);
  }
});

test("SPORTMONKS: non-object participant elements are skipped, never read and never turned into phantom competitors", () => {
  for (const el of NON_OBJECT_ELEMENTS) {
    const events = sportmonks.toEvents({ fixtures: [smFixture({ participants: [el] })], stages: [] });
    assert.equal(events.length, 1, `element ${JSON.stringify(el)}: the event must survive`);
    assert.deepEqual(events[0].competitors, [], `element ${JSON.stringify(el)}: must be skipped`);
  }
});

test("SYMMETRY: an EMPTY OBJECT participant is a real record in both adapters -- kept, degraded to an all-null Competitor", () => {
  const [tsdbEv] = thesportsdb.toEvents({ events: [tsdbEvent({ participants: [{}] })], instances });
  const [smEv] = sportmonks.toEvents({ fixtures: [smFixture({ participants: [{}] })], stages: [] });
  for (const [label, ev] of [["thesportsdb", tsdbEv], ["sportmonks", smEv]]) {
    assert.equal(ev.competitors.length, 1, `${label}: {} is a record, not nothing`);
    assert.deepEqual(
      { ...ev.competitors[0] },
      { role: null, providerCompetitorId: null, name: null },
      `${label}: an empty record degrades to an all-null Competitor, inventing nothing`
    );
  }
});

test("BATCH ISOLATION: one malformed record never aborts the valid records beside it", () => {
  const tsdbEvents = thesportsdb.toEvents({
    events: [tsdbEvent({ externalEventId: "1", participants: {} }), tsdbEvent({ externalEventId: "2", participants: [] })],
    instances,
  });
  assert.deepEqual(tsdbEvents.map((e) => e.providerEventId), ["1", "2"]);

  const smEvents = sportmonks.toEvents({
    fixtures: [smFixture({ id: 1, participants: "garbage" }), smFixture({ id: 2, participants: [] })],
    stages: [],
  });
  assert.deepEqual(smEvents.map((e) => e.providerEventId), ["1", "2"]);
});

test("BATCH ISOLATION: a mix of good and unusable-id records keeps every good one", () => {
  const events = thesportsdb.toEvents({
    events: [null, undefined, {}, "garbage", 5, true, { externalEventId: "" }, { externalEventId: "   " },
      tsdbEvent({ externalEventId: "7" })],
    instances,
  });
  assert.deepEqual(events.map((e) => e.providerEventId), ["7"]);
});

// ==== C. the events/fixtures COLLECTION itself ==============================

test("TSDB: a wrong-typed or absent events collection yields [] instead of throwing", () => {
  for (const events of NON_ARRAYS) {
    assert.deepEqual(thesportsdb.toEvents({ events, instances }), [], `events ${JSON.stringify(events)}`);
  }
});

test("SPORTMONKS: a wrong-typed or absent fixtures collection yields [] instead of throwing", () => {
  for (const fixtures of NON_ARRAYS) {
    assert.deepEqual(sportmonks.toEvents({ fixtures, stages: [] }), [], `fixtures ${JSON.stringify(fixtures)}`);
  }
});

test("TSDB: a wrong-typed `instances` collection degrades to instanceId null, never throws", () => {
  for (const inst of NON_ARRAYS) {
    const [ev] = thesportsdb.toEvents({ events: [tsdbEvent()], instances: inst });
    assert.equal(ev.instanceId, null, `instances ${JSON.stringify(inst)}`);
  }
  const [noId] = thesportsdb.toEvents({ events: [tsdbEvent()], instances: [{}] });
  assert.equal(noId.instanceId, null, "an instance object with no id must not produce undefined");
});

// ==== D. exported mappers called directly, with no argument at all ==========
// These are exported helpers. A caller reaching them outside the payload
// entry points must not hit a destructuring TypeError.

test("EXPORTED HELPERS: calling the collection mappers with no argument returns empty, never throws", () => {
  assert.deepEqual(sportmonks.toEvents(), []);
  assert.deepEqual(sportmonks.toStages(), []);
  assert.deepEqual(thesportsdb.toEvents(), []);
  assert.deepEqual(thesportsdb.toStages(), []);
});

test("EXPORTED HELPERS: toCompetition() on a malformed record fails as a DOMAIN error, not a raw TypeError", () => {
  for (const raw of [null, undefined, {}, "garbage", 5, true]) {
    assert.throws(
      () => thesportsdb.toCompetition(raw),
      /usable providerCompetitionId/,
      `thesportsdb.toCompetition(${JSON.stringify(raw)})`
    );
    assert.throws(
      () => sportmonks.toCompetition(raw),
      /usable providerCompetitionId/,
      `sportmonks.toCompetition(${JSON.stringify(raw)})`
    );
  }
});

// ==== E. malformed values on an otherwise valid record ======================

test("A valid record with every optional field malformed still produces a safe, fully-normalized Event", () => {
  const [ev] = sportmonks.toEvents({
    fixtures: [{
      id: 1, stage_id: {}, round_id: null, aggregate_id: null,
      leg: "garbage", starting_at: null, state_id: "5",
      participants: [null, {}, { id: true, meta: "not-an-object" }],
    }],
    stages: [],
  });
  assert.equal(ev.status, "unknown", "a string state_id must not coerce into a real status");
  assert.equal(ev.leg, null, "an unparseable leg degrades to null");
  assert.equal(ev.stageId, null);
  assert.equal(ev.providerRoundId, null);
  assert.equal(ev.aggregateKey, null);
  assert.equal(ev.startsAt, null);
  // The null element is skipped; {} and the unreadable-meta record remain as
  // all-null competitors.
  assert.equal(ev.competitors.length, 2);
  ev.competitors.forEach((c) => {
    assert.equal(c.role, null);
    assert.equal(c.providerCompetitorId, null);
  });
});

// ==== F. the SAME bug class in every other collection =======================
// Found by re-running the adversarial matrix after fixing `participants`:
// exactly the same `x || []` / unchecked-element pattern was still live in
// four more places. Each one crashed a whole batch on a truthy non-array or
// a null element.

test("DOMAIN: makeEvent() accepts a wrong-typed competitors collection without crashing", () => {
  for (const competitors of NON_ARRAYS) {
    const ev = require("../sportsDomain").makeEvent({ provider: "p", providerEventId: 1, competitors });
    assert.deepEqual(ev.competitors, [], `competitors ${JSON.stringify(competitors)}`);
  }
});

test("DOMAIN: makeEvent() drops non-object competitor elements instead of minting phantom competitors", () => {
  const domain = require("../sportsDomain");
  for (const el of NON_OBJECT_ELEMENTS) {
    const ev = domain.makeEvent({ provider: "p", providerEventId: 1, competitors: [el] });
    assert.deepEqual(ev.competitors, [], `element ${JSON.stringify(el)}`);
  }
  const mixed = domain.makeEvent({ provider: "p", providerEventId: 1, competitors: [null, {}, { role: "home", providerCompetitorId: 7 }] });
  assert.equal(mixed.competitors.length, 2, "the null is dropped; {} and the real record survive");
  assert.equal(mixed.competitors[1].providerCompetitorId, "7");
});

test("DOMAIN: makeCompetitor() is total -- a missing or malformed record yields an all-null Competitor, never a TypeError", () => {
  const domain = require("../sportsDomain");
  const expected = { role: null, providerCompetitorId: null, name: null };
  assert.deepEqual({ ...domain.makeCompetitor() }, expected);
  for (const bad of [null, undefined, "garbage", 5, true, []]) {
    assert.deepEqual({ ...domain.makeCompetitor(bad) }, expected, `makeCompetitor(${JSON.stringify(bad)})`);
  }
});

test("DOMAIN: providerRaw is shape-checked -- a truthy non-object is never spread into nonsense", () => {
  const domain = require("../sportsDomain");
  for (const bad of ["ab", 5, true, ["x"]]) {
    const ev = domain.makeEvent({ provider: "p", providerEventId: 1, providerRaw: bad });
    assert.equal(ev.providerRaw, null, `providerRaw ${JSON.stringify(bad)} must not become {0:"a",1:"b"}`);
  }
  const ok = domain.makeEvent({ provider: "p", providerEventId: 1, providerRaw: { round: 3 } });
  assert.deepEqual({ ...ok.providerRaw }, { round: 3 });
});

test("SPORTMONKS: a wrong-typed or malformed `stages` lookup never crashes the fixture batch", () => {
  for (const stages of [...NON_ARRAYS, [null], [undefined], ["x"], [5]]) {
    const events = sportmonks.toEvents({ fixtures: [smFixture()], stages });
    assert.equal(events.length, 1, `stages ${JSON.stringify(stages)}: the event must survive`);
    assert.equal(events[0].stageId, null, `stages ${JSON.stringify(stages)}: with no resolvable stage`);
  }
});

test("SPORTMONKS: a malformed ELEMENT in `instances` is skipped without breaking the stages that do resolve", () => {
  const instances = [null, undefined, "x", 5, { instanceKey: "Apertura", id: "sportmonks:instance:25539:Apertura" }];
  const stages = sportmonks.toStages({ stages: [{ id: 1, name: "Apertura, Final" }], instances, providerCompetitionId: 743 });
  assert.equal(stages.length, 1);
  assert.equal(stages[0].instanceId, "sportmonks:instance:25539:Apertura",
    "the one good instance still resolves despite the malformed elements beside it");
});

test("SPORTMONKS: an unresolvable `instances` context fails as a DOMAIN error, never as a TypeError", () => {
  // makeStage deliberately REQUIRES an instanceId: a Stage with no tournament
  // is meaningless, and minting an orphan would be worse than refusing. That
  // pre-existing fail-fast invariant is preserved on purpose. What must never
  // happen -- and was happening -- is a raw TypeError from `.map` on a truthy
  // non-array or from reading `.instanceKey` off a null element.
  for (const instances of NON_ARRAYS) {
    assert.throws(
      () => sportmonks.toStages({ stages: [{ id: 1, name: "Apertura" }], instances, providerCompetitionId: 743 }),
      (err) => err instanceof Error && !(err instanceof TypeError) && /instanceId are required/.test(err.message),
      `instances ${JSON.stringify(instances)} must fail as a domain error, not a TypeError`
    );
  }
});

test("SPORTMONKS: fromStagePayload() survives a wrong-typed stages context end to end", () => {
  for (const stages of NON_ARRAYS) {
    const r = sportmonks.fromStagePayload({ id: 1, fixtures: [smFixture()] }, { stages });
    assert.equal(r.events.length, 1, `stages ${JSON.stringify(stages)}`);
  }
});

test("TSDB: a wrong-typed or malformed participant element list is symmetric with Sportmonks", () => {
  for (const participants of [[null], [undefined], [true], ["x"], [5]]) {
    const [tsdbEv] = thesportsdb.toEvents({ events: [tsdbEvent({ participants })], instances });
    const [smEv] = sportmonks.toEvents({ fixtures: [smFixture({ participants })], stages: [] });
    assert.equal(tsdbEv.competitors.length, smEv.competitors.length,
      `both adapters must treat ${JSON.stringify(participants)} identically`);
    assert.equal(tsdbEv.competitors.length, 0);
  }
});

test("DEDUPE: a skipped malformed participant element does not change the normalized signature", () => {
  // Filtering elements must not become a NEW source of false conflicts: a
  // record carrying [null, realParticipant] and one carrying just
  // [realParticipant] describe the identical Event and must dedupe as a
  // duplicate, not contradict each other.
  const real = { id: 9, meta: { location: "home" } };
  const r = sportmonks.fromStagePayload({
    id: 1,
    fixtures: [smFixture({ participants: [null, real] }), smFixture({ participants: [real] })],
  }, { stages: [] });
  assert.equal(r.events.length, 1);
  assert.equal(r.duplicateFixtures, 1);
  assert.deepEqual(r.conflictingFixtures, []);
});

test("SYMMETRY: an array participant element behaves identically in both adapters", () => {
  const smCount = sportmonks.toEvents({ fixtures: [smFixture({ participants: [[]] })], stages: [] })[0].competitors.length;
  const tsdbCount = thesportsdb.toEvents({ events: [tsdbEvent({ participants: [[]] })], instances })[0].competitors.length;
  assert.equal(smCount, tsdbCount, "both adapters must agree on how an array element is treated");
});

test("TSDB: a malformed participant meta/role/id degrades per field without dropping the event", () => {
  const [ev] = thesportsdb.toEvents({
    events: [tsdbEvent({ participants: [{ role: "left", externalId: {}, name: "X" }] })],
    instances,
  });
  assert.equal(ev.competitors.length, 1);
  assert.equal(ev.competitors[0].role, null, "an out-of-vocabulary role degrades to null");
  assert.equal(ev.competitors[0].providerCompetitorId, null, "an object id is never stringified into an identity");
  assert.equal(ev.competitors[0].name, "X", "the cosmetic name is untouched");
});
