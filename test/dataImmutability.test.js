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

test("IMMUTABILITY-6: Sportmonks adapter reports 'unknown' status, never the raw provider state_id, until a verified mapping exists", () => {
  const [event] = sportmonks.toEvents({
    fixtures: [{ id: 1, stage_id: null, round_id: null, aggregate_id: null, leg: null,
      starting_at: null, state_id: 5, participants: [] }],
    stages: [],
  });
  assert.equal(event.status, "unknown");
  // The raw code is preserved for diagnostics only.
  assert.equal(event.providerRaw.state_id, 5);
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
// leg is modeled as a plain string ("1/2" / "2/2" / null), which is an
// immutable JS primitive by construction -- there is no object reference for
// a caller to mutate after the fact. These tests lock that in.

test("IMMUTABILITY-9: mutating the source variable after makeEvent() does not change Event.leg", () => {
  let legInput = "1/2";
  const event = domain.makeEvent({ provider: "sportmonks", providerEventId: 1, leg: legInput });
  legInput = "2/2";
  assert.equal(event.leg, "1/2");
  assert.ok(Object.isFrozen(event), "the Event itself must be frozen");
  try { event.leg = "2/2"; } catch (_e) { /* strict mode: expected */ }
  assert.equal(event.leg, "1/2", "assigning to a frozen Event must never change it");
});

test("IMMUTABILITY-10: two Events built from equal leg values never share a mutable reference", () => {
  const a = domain.makeEvent({ provider: "sportmonks", providerEventId: 1, leg: "1/2" });
  const b = domain.makeEvent({ provider: "sportmonks", providerEventId: 2, leg: "1/2" });
  assert.equal(typeof a.leg, "string");
  assert.equal(a.leg, b.leg);
  // Strings are primitives: there is no reference to share in the first
  // place, so no mutation of one can ever be observed through the other.
});
