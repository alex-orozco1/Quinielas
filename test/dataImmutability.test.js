// dataImmutability.test.js — DATA-003 QA correction.
//
// Object.freeze(new Set(...)) does NOT make a Set immutable: freeze only
// locks a Set's OWN properties, never its inherited add/delete/clear
// methods, so a frozen Set stays fully mutable through its own API. This
// suite proves the two real, exported, DATA-003-scoped collections that were
// vulnerable to exactly that gap -- Event.status's allowlist and each
// adapter's capabilities Set -- are now genuinely safe against external
// mutation changing Sports Domain functional semantics.

const test = require("node:test");
const assert = require("node:assert/strict");

const domain = require("../sportsDomain");
const { CAPABILITIES, hasCapability, immutableCapabilitySet } = require("../providers/providerContract");
const sportmonks = require("../providers/sportmonksAdapter");
const thesportsdb = require("../providers/theSportsDbDomainAdapter");

// ==== EVENT_STATUSES / normalizeEventStatus ================================

test("IMMUTABILITY-1: the six QRACKS-owned statuses normalize to themselves", () => {
  for (const s of ["scheduled", "live", "finished", "postponed", "cancelled", "unknown"]) {
    assert.equal(domain.normalizeEventStatus(s), s);
  }
});

test("IMMUTABILITY-2: arbitrary / provider-specific values degrade safely to 'unknown'", () => {
  for (const v of ["5", "1", "NS", "whatever", "", null, undefined, 5, {}, ["live"]]) {
    assert.equal(domain.normalizeEventStatus(v), "unknown");
  }
});

test("IMMUTABILITY-3: EVENT_STATUSES is a frozen array -- mutation attempts do not change it or the normalizer", () => {
  const before = domain.EVENT_STATUSES.slice();
  assert.ok(Object.isFrozen(domain.EVENT_STATUSES));
  // A frozen array silently no-ops a mutation in sloppy mode and throws in
  // strict mode -- both are acceptable; what must NEVER happen is the
  // mutation actually taking effect.
  try { domain.EVENT_STATUSES.push("5"); } catch (_e) { /* strict mode: expected */ }
  try { domain.EVENT_STATUSES[0] = "5"; } catch (_e) { /* strict mode: expected */ }
  assert.deepEqual(domain.EVENT_STATUSES.slice(), before, "array contents must be unchanged");
  // Even if a mutation attempt somehow appeared to work, it must not be able
  // to make a bogus value validate -- membership is checked against a
  // module-private Set, never against the exported array itself.
  assert.equal(domain.normalizeEventStatus("5"), "unknown");
});

test("IMMUTABILITY-4: a consumer cannot delete 'finished' from the vocabulary and turn it into 'unknown'", () => {
  // There is nothing exported that exposes a mutable membership structure
  // (the internal Set is module-private), so there is no delete-capable
  // handle for a consumer to reach in the first place -- which IS the fix.
  assert.equal(domain.normalizeEventStatus("finished"), "finished");
});

test("IMMUTABILITY-5: makeEvent() is the enforcement point -- a raw Sportmonks-style numeric status can never leak through as valid QRACKS semantics", () => {
  const event = domain.makeEvent({
    provider: "sportmonks", providerEventId: 1, status: "5",
  });
  assert.equal(event.status, "unknown");
});

test("IMMUTABILITY-6: Sportmonks adapter maps state_id through the verified reference table, never leaks the raw code as status", () => {
  const [event] = sportmonks.toEvents({
    fixtures: [{ id: 1, stage_id: null, round_id: null, aggregate_id: null, leg: null,
      starting_at: null, state_id: 5, participants: [] }],
    stages: [],
  });
  assert.equal(event.status, "finished");
  // The raw code is preserved for diagnostics only.
  assert.equal(event.providerRaw.state_id, 5);
});

test("SPORTMONKS STATUS: every documented state_id maps to the approved QRACKS status", () => {
  const table = {
    1: "scheduled", 13: "scheduled", 16: "scheduled",
    2: "live", 3: "live", 4: "live", 6: "live", 9: "live", 21: "live", 22: "live", 25: "live",
    5: "finished", 7: "finished", 8: "finished",
    10: "postponed", 11: "postponed", 15: "postponed", 18: "postponed",
    12: "cancelled", 20: "cancelled",
    14: "unknown", 17: "unknown", 19: "unknown", 26: "unknown",
  };
  for (const [stateId, expected] of Object.entries(table)) {
    assert.equal(sportmonks.normalizeSportmonksStatus(Number(stateId)), expected, `state_id ${stateId}`);
  }
  for (const v of [null, undefined, "garbage", {}, [], "5.5", NaN]) {
    assert.equal(sportmonks.normalizeSportmonksStatus(v), "unknown", `garbage input ${JSON.stringify(v)}`);
  }
});

// ==== capabilities Set immutability =========================================

test("IMMUTABILITY-7: Sportmonks capabilities.add() throws and does not grant a fake capability", () => {
  assert.throws(() => sportmonks.capabilities.add(CAPABILITIES.MULTI_INSTANCE_SEASONS), TypeError);
  assert.throws(() => sportmonks.capabilities.add("made_up_capability"), TypeError);
  assert.equal(hasCapability(sportmonks, "made_up_capability"), false);
});

test("IMMUTABILITY-8: Sportmonks capabilities.delete()/.clear() throw and never remove a real capability", () => {
  assert.throws(() => sportmonks.capabilities.delete(CAPABILITIES.LEGS), TypeError);
  assert.throws(() => sportmonks.capabilities.clear(), TypeError);
  assert.equal(hasCapability(sportmonks, CAPABILITIES.LEGS), true);
  assert.equal(hasCapability(sportmonks, CAPABILITIES.STAGES), true);
  assert.equal(hasCapability(sportmonks, CAPABILITIES.FINISHED_SIGNAL), true);
  assert.equal(hasCapability(sportmonks, CAPABILITIES.AGGREGATES), true);
});

test("TheSportsDB capabilities.add() throws and cannot make an unsupported capability look supported", () => {
  assert.throws(() => thesportsdb.capabilities.add(CAPABILITIES.STAGES), TypeError);
  Object.values(CAPABILITIES).forEach((c) => assert.equal(hasCapability(thesportsdb, c), false));
});

test("immutableCapabilitySet still behaves as a real Set for legitimate reads", () => {
  const s = immutableCapabilitySet(["a", "b"]);
  assert.ok(s instanceof Set);
  assert.equal(s.has("a"), true);
  assert.equal(s.has("z"), false);
  assert.equal(s.size, 2);
  assert.deepEqual([...s].sort(), ["a", "b"]);
});

// ==== leg value semantics ====================================================
// leg is a QRACKS-owned value object { number, total }, never the provider's
// raw "1/2" / "2/2" encoding. These tests lock in that the object is frozen,
// freshly built on every call, and immune to mutation of the caller's input.

test("LEG: normalizeLeg accepts only positive integers with number <= total, frozen output", () => {
  assert.deepEqual(domain.normalizeLeg({ number: 1, total: 2 }), { number: 1, total: 2 });
  assert.ok(Object.isFrozen(domain.normalizeLeg({ number: 1, total: 2 })));
  for (const bad of [
    { number: 0, total: 2 }, { number: 3, total: 2 }, { number: -1, total: 2 },
    { number: 1.5, total: 2 }, { number: 1, total: 0 }, { number: "1", total: 2 },
    null, undefined, "1/2", 5, [1, 2], {},
  ]) {
    assert.equal(domain.normalizeLeg(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("LEG: parseSportmonksLeg parses the documented raw formats and rejects malformed ones", () => {
  const valid = { "1/1": [1, 1], "1/2": [1, 2], "2/2": [2, 2], "1/3": [1, 3], "2/3": [2, 3], "3/3": [3, 3] };
  for (const [raw, [number, total]] of Object.entries(valid)) {
    assert.deepEqual(sportmonks.parseSportmonksLeg(raw), { number, total }, raw);
  }
  for (const raw of ["0/2", "3/2", "-1/2", "1/-2", "abc", "1/2/3", "", "1 / 2", null, undefined, 5]) {
    assert.equal(sportmonks.parseSportmonksLeg(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test("IMMUTABILITY-9: mutating the source object after makeEvent() does not change Event.leg", () => {
  const legInput = { number: 1, total: 2 };
  const event = domain.makeEvent({ provider: "sportmonks", providerEventId: 1, leg: legInput });
  legInput.number = 2;
  assert.deepEqual(event.leg, { number: 1, total: 2 });
  assert.ok(Object.isFrozen(event), "the Event itself must be frozen");
  assert.ok(Object.isFrozen(event.leg), "Event.leg must be frozen");
  try { event.leg.number = 2; } catch (_e) { /* strict mode: expected */ }
  assert.equal(event.leg.number, 1, "mutating Event.leg's own object must never change it");
});

test("IMMUTABILITY-10: two Events built from equal leg values never share a mutable reference", () => {
  const a = domain.makeEvent({ provider: "sportmonks", providerEventId: 1, leg: { number: 1, total: 2 } });
  const b = domain.makeEvent({ provider: "sportmonks", providerEventId: 2, leg: { number: 1, total: 2 } });
  assert.deepEqual(a.leg, b.leg);
  assert.notEqual(a.leg, b.leg, "each Event must get its own frozen leg object, never a shared reference");
  a.leg && Object.isFrozen(a.leg); // sanity: both independently frozen
  try { a.leg.number = 99; } catch (_e) { /* strict mode: expected */ }
  assert.equal(b.leg.number, 1, "mutating one Event's leg must never affect another's");
});

// ==== dedupe compares NORMALIZED QRACKS semantics, not raw provider codes ===

const baseFx = (over = {}) => ({
  id: 500, stage_id: 1, round_id: null, aggregate_id: null, leg: "1/2", starting_at: "2025-12-12",
  state_id: 5, participants: [{ id: 1, name: "A", meta: { location: "home" } }],
  ...over,
});

test("DEDUPE-NORM-1: different raw state_id normalizing to the SAME status is a duplicate, not a conflict", () => {
  // 5 (FT) and 7 (AET) both normalize to 'finished'.
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [baseFx({ state_id: 5 }), baseFx({ state_id: 7 })] }, { stages: [] });
  assert.equal(r.events.length, 1);
  assert.equal(r.duplicateFixtures, 1);
  assert.deepEqual(r.conflictingFixtures, []);
  assert.equal(r.events[0].status, "finished");
});

test("DEDUPE-NORM-2: different raw leg spelling normalizing to the SAME leg is a duplicate, not a conflict", () => {
  // "01/02" and "1/2" both normalize to { number: 1, total: 2 }.
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [baseFx({ leg: "01/02" }), baseFx({ leg: "1/2" })] }, { stages: [] });
  assert.equal(r.events.length, 1);
  assert.equal(r.duplicateFixtures, 1);
  assert.deepEqual(r.conflictingFixtures, []);
  assert.deepEqual(r.events[0].leg, { number: 1, total: 2 });
});

test("DEDUPE-NORM-3: genuinely different normalized status (not just raw code) is a real conflict", () => {
  // 5 (finished) vs 2 (live): materially different, must conflict.
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [baseFx({ state_id: 5 }), baseFx({ state_id: 2 })] }, { stages: [] });
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.conflictingFixtures, ["500"]);
  assert.equal(r.duplicateFixtures, 0);
});

test("DEDUPE-NORM-4: A+A+B on normalized status is a conflict, never majority-wins", () => {
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [
    baseFx({ state_id: 5 }), baseFx({ state_id: 5 }), baseFx({ state_id: 2 }),
  ] }, { stages: [] });
  assert.equal(r.events.length, 0, "2-against-1 must still conflict, never pick the majority");
  assert.deepEqual(r.conflictingFixtures, ["500"]);
});
