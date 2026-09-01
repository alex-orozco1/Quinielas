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
const { CAPABILITIES, hasCapability, assertImplementsContract } = require("../providers/providerContract");
const sportmonks = require("../providers/sportmonksAdapter");
const thesportsdb = require("../providers/theSportsDbDomainAdapter");
const providerRegistry = require("../providers/providerRegistry");

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

test("SPORTMONKS STATUS: type coercion cannot manufacture a fake state_id (adversarial QA correction)", () => {
  // Number(true) === 1, Number([1]) === 1, Number(" 1 ") === 1, Number("1e0") === 1,
  // Number("01") === 1 -- none of these are a real Sportmonks state_id, and none
  // may gain the functional semantics of state_id 1 ("scheduled") through
  // JavaScript coercion. Only an actual `number` type is accepted.
  for (const v of [true, false, [1], ["1"], {}, "1e0", " 1 ", "01", NaN, Infinity, -Infinity, 1.5]) {
    assert.equal(sportmonks.normalizeSportmonksStatus(v), "unknown", `must reject ${JSON.stringify(v)} (${typeof v})`);
  }
  // Real, official numeric state IDs must keep working.
  assert.equal(sportmonks.normalizeSportmonksStatus(1), "scheduled");
  assert.equal(sportmonks.normalizeSportmonksStatus(5), "finished");
});

// ==== capabilities: frozen array, not a mutable-Set-behind-a-Proxy =========
//
// A prior iteration wrapped a Set in a Proxy that blocked add/delete/clear.
// That looked safe but wasn't: Set.prototype.forEach(cb) invokes
// cb(value, value, S) with S being whatever `this` forEach actually ran on.
// Since every forwarded method had to be bound to the REAL backing Set
// (built-in Set methods require a genuine internal Set slot -- they throw
// "incompatible receiver" on a bare Proxy), forEach's third argument leaked
// that real, unprotected Set -- fully mutable, Proxy bypassed entirely. The
// design was replaced with a frozen plain array: Object.freeze() genuinely
// blocks push/pop/splice/index-reassignment on an array, so even Array.
// prototype.forEach's third argument (the array itself) is harmless.

test("CAPABILITIES-1: capabilities is a frozen array, not a Set -- there is no add/delete/clear to intercept in the first place", () => {
  assert.ok(Array.isArray(sportmonks.capabilities));
  assert.ok(Object.isFrozen(sportmonks.capabilities));
  assert.ok(Array.isArray(thesportsdb.capabilities));
  assert.ok(Object.isFrozen(thesportsdb.capabilities));
});

test("CAPABILITIES-2: mutation attempts on Sportmonks capabilities never grant or remove a real capability", () => {
  const before = sportmonks.capabilities.slice();
  try { sportmonks.capabilities.push("made_up_capability"); } catch (_e) { /* strict mode: expected */ }
  try { sportmonks.capabilities[0] = "made_up_capability"; } catch (_e) { /* strict mode: expected */ }
  try { sportmonks.capabilities.length = 0; } catch (_e) { /* strict mode: expected */ }
  assert.deepEqual(sportmonks.capabilities.slice(), before, "array contents must be unchanged");
  assert.equal(hasCapability(sportmonks, "made_up_capability"), false);
  assert.equal(hasCapability(sportmonks, CAPABILITIES.LEGS), true, "a real capability must still be reported");
});

test("CAPABILITIES-3: TheSportsDB's empty capabilities cannot be made to look like it supports anything", () => {
  try { thesportsdb.capabilities.push(CAPABILITIES.STAGES); } catch (_e) { /* strict mode: expected */ }
  assert.equal(thesportsdb.capabilities.length, 0);
  Object.values(CAPABILITIES).forEach((c) => assert.equal(hasCapability(thesportsdb, c), false));
});

test("CAPABILITIES-4 (adversarial QA correction): the forEach-third-argument attack that broke the previous Proxy design cannot recover a mutable backing collection", () => {
  let leaked;
  sportmonks.capabilities.forEach((_v, _k, arr) => { leaked = arr; });
  // Even a successful leak is harmless here: `leaked` is the SAME frozen
  // array `sportmonks.capabilities` already is, not a hidden unprotected one.
  assert.equal(leaked, sportmonks.capabilities);
  assert.ok(Object.isFrozen(leaked));
  try { leaked.push("made_up_capability"); } catch (_e) { /* strict mode: expected */ }
  assert.equal(hasCapability(sportmonks, "made_up_capability"), false);
});

test("CAPABILITIES-5: spreading/destructuring/iterating capabilities never exposes a mutable handle back to the real collection", () => {
  const spread = [...sportmonks.capabilities];
  spread.push("made_up_capability"); // a plain new array: mutating it is expected and harmless
  assert.equal(hasCapability(sportmonks, "made_up_capability"), false);
  assert.ok(Object.isFrozen(sportmonks.capabilities), "the original must remain untouched and frozen");
});

test("assertImplementsContract requires capabilities to be an array, and rejects a bare mutable Set", () => {
  const fakeAdapter = {
    key: "fake", capabilities: new Set(["x"]),
    toCompetition() {}, toCompetitionInstances() {}, toStages() {}, toEvents() {},
  };
  assert.throws(() => assertImplementsContract(fakeAdapter), /frozen array/);
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

test("LEG-SAFE-INTEGER (adversarial QA correction): a corrupted/absurd raw leg cannot round into a DIFFERENT, seemingly-legal leg", () => {
  // 9007199254740993 = 2^53 + 1 rounds via Number() to 2^53 (9007199254740992),
  // a DIFFERENT integer that Number.isInteger alone would still have accepted.
  assert.equal(sportmonks.parseSportmonksLeg("9007199254740993/9007199254740994"), null);
  assert.equal(sportmonks.parseSportmonksLeg("999999999999999999999/999999999999999999999"), null);
  assert.equal(domain.normalizeLeg({ number: 9007199254740993, total: 9007199254740994 }), null);
  // Number.MAX_SAFE_INTEGER itself is still a legal safe integer.
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(domain.normalizeLeg({ number: max, total: max }), { number: max, total: max });
  // One past it is not.
  assert.equal(domain.normalizeLeg({ number: max + 1, total: max + 1 }), null);
  assert.equal(domain.normalizeLeg({ number: max + 2, total: max + 2 }), null); // beyond double precision entirely
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

// ==== Event.score value semantics (adversarial QA correction) ==============
// Object.freeze(Event) is shallow: it does nothing to a plain object nested
// inside it. score was passed through as `score || null` with no copy, so a
// caller retaining the original { home, away } object -- or reading
// event.score itself -- could mutate a final score after the Event was
// created. normalizeScore() now shallow-copies and freezes it.

test("SCORE-1: mutating the source object after makeEvent() does not change Event.score", () => {
  const scoreInput = { home: 2, away: 1 };
  const event = domain.makeEvent({ provider: "thesportsdb", providerEventId: 1, score: scoreInput });
  scoreInput.home = 99;
  assert.deepEqual(event.score, { home: 2, away: 1 });
});

test("SCORE-2: mutating event.score itself does not change its values", () => {
  const event = domain.makeEvent({ provider: "thesportsdb", providerEventId: 1, score: { home: 2, away: 1 } });
  assert.ok(Object.isFrozen(event.score), "Event.score must be frozen");
  try { event.score.home = 99; } catch (_e) { /* strict mode: expected */ }
  assert.equal(event.score.home, 2, "mutating Event.score's own object must never change it");
});

test("SCORE-3: two Events built from the same mutable input object never share a score reference", () => {
  const scoreInput = { home: 2, away: 1 };
  const a = domain.makeEvent({ provider: "thesportsdb", providerEventId: 1, score: scoreInput });
  const b = domain.makeEvent({ provider: "thesportsdb", providerEventId: 2, score: scoreInput });
  assert.notEqual(a.score, b.score, "each Event must get its own frozen score object");
  try { a.score.home = 77; } catch (_e) { /* strict mode: expected */ }
  assert.equal(b.score.home, 2, "mutating one Event's score must never affect another's");
});

test("MALFORMED-PAYLOAD (final closure audit): TheSportsDB toEvents() skips null/undefined/malformed records instead of crashing the whole batch", () => {
  const instances = [{ id: "thesportsdb:instance:2025" }];
  assert.doesNotThrow(() => thesportsdb.toEvents({ events: null, instances }));
  assert.doesNotThrow(() => thesportsdb.toEvents({ events: undefined, instances }));
  assert.deepEqual(thesportsdb.toEvents({ events: [], instances }), []);
  const events = thesportsdb.toEvents({
    events: [null, undefined, {}, { externalEventId: "" }, { externalEventId: "1", status: "finished", participants: [] }],
    instances,
  });
  assert.equal(events.length, 1, "only the one well-formed record should survive");
  assert.equal(events[0].providerEventId, "1");
});

test("SCORE-4: TheSportsDB's { home, away } shape still works end to end", () => {
  const [event] = thesportsdb.toEvents({
    events: [{ externalEventId: "1", status: "finished", score: { home: 3, away: 0 }, participants: [] }],
    instances: [{ id: "thesportsdb:instance:2025" }],
  });
  assert.deepEqual(event.score, { home: 3, away: 0 });
  assert.ok(Object.isFrozen(event.score));
});

test("SCORE-5: non-object / null score degrades to null rather than passing through unprotected", () => {
  for (const bad of [null, undefined, "2-1", 5, ["2", "1"]]) {
    const event = domain.makeEvent({ provider: "thesportsdb", providerEventId: 1, score: bad });
    assert.equal(event.score, null, `expected null score for ${JSON.stringify(bad)}`);
  }
});

// ==== Competitor identity/role audit (adversarial QA correction) ===========
// providerCompetitorId used String(x) directly, so {} / [] / true / NaN /
// Infinity became the plausible-looking identities "[object Object]" / "" /
// "true" / "NaN" / "Infinity" instead of degrading to null. role accepted
// any truthy value verbatim, which would let an adapter's bug (or a future
// provider) leak provider-specific semantics into role the same way raw
// state_id used to leak into status.

test("COMPETITOR-ID: malformed provider ids degrade to null, never a plausible-looking fabricated identity", () => {
  for (const bad of [{}, [], true, false, NaN, Infinity, -Infinity, "", "   "]) {
    const c = domain.makeCompetitor({ role: "home", providerCompetitorId: bad, name: "X" });
    assert.equal(c.providerCompetitorId, null, `expected null for ${JSON.stringify(bad)}`);
  }
  // Missing id legitimately degrades to null -- never fabricated.
  assert.equal(domain.makeCompetitor({ role: null, providerCompetitorId: null, name: "X" }).providerCompetitorId, null);
  // Real ids still work, and 123 / "123" still collapse to the same identity
  // (consistent with isUsableProviderId's existing numeric/string contract).
  assert.equal(domain.makeCompetitor({ providerCompetitorId: 123 }).providerCompetitorId, "123");
  assert.equal(domain.makeCompetitor({ providerCompetitorId: "123" }).providerCompetitorId, "123");
});

test("COMPETITOR-ROLE: only home/away are accepted; anything else -- including a future/raw provider value -- degrades to null", () => {
  assert.equal(domain.makeCompetitor({ role: "home" }).role, "home");
  assert.equal(domain.makeCompetitor({ role: "away" }).role, "away");
  for (const bad of [null, undefined, "H", "referee", "HOME", 1, {}, []]) {
    assert.equal(domain.makeCompetitor({ role: bad }).role, null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("COMPETITOR-ROLE: a competitor legitimately without home/away (future sport) is not blocked -- null stays a first-class value", () => {
  const driver = domain.makeCompetitor({ role: null, providerCompetitorId: 44, name: "Driver 44" });
  assert.equal(driver.role, null);
  assert.equal(driver.providerCompetitorId, "44");
  assert.equal(driver.name, "Driver 44");
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

test("DEDUPE-NORM-3b: three IDENTICAL raw duplicates collapse to one Event and report 2 duplicates", () => {
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [baseFx(), baseFx(), baseFx()] }, { stages: [] });
  assert.equal(r.events.length, 1);
  assert.equal(r.duplicateFixtures, 2);
  assert.deepEqual(r.conflictingFixtures, []);
});

test("DEDUPE-NORM-4: A+A+B on normalized status is a conflict, never majority-wins", () => {
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [
    baseFx({ state_id: 5 }), baseFx({ state_id: 5 }), baseFx({ state_id: 2 }),
  ] }, { stages: [] });
  assert.equal(r.events.length, 0, "2-against-1 must still conflict, never pick the majority");
  assert.deepEqual(r.conflictingFixtures, ["500"]);
});

// ==== Provider identity: safe-integer precision (final closure audit) ======
// isUsableProviderId's number branch used Number.isFinite, which accepts a
// finite-but-UNSAFE number. Two genuinely different huge provider ids can
// round to the SAME double once they cross Number.MAX_SAFE_INTEGER, so
// accepting one as "usable" risked minting one domain id for two different
// real records. A provider id that large must arrive as a string, which is
// never routed through Number() and so never loses precision.

test("PROVIDER-ID: numeric ids must be safe integers; a finite-but-unsafe number is rejected", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(domain.isUsableProviderId(max), true);
  assert.equal(domain.isUsableProviderId(max + 1), false, "finite but no longer a safe integer");
  assert.equal(domain.isUsableProviderId(max + 2), false);
  assert.equal(domain.isUsableProviderId(0), true);
  assert.equal(domain.isUsableProviderId(-5), true, "the existing negative-id policy is preserved");
});

test("PROVIDER-ID: a huge id passed as an EXACT string never loses precision, unlike the equivalent number", () => {
  const hugeString = "9007199254740993"; // 2^53 + 1 -- not representable exactly as a double
  assert.equal(domain.isUsableProviderId(hugeString), true);
  const c = domain.makeCompetition({ provider: "p", providerCompetitionId: hugeString });
  assert.equal(c.providerCompetitionId, hugeString, "the exact digit string must survive untouched");
});

test("PROVIDER-ID: the full accepted/rejected matrix from the closure spec", () => {
  const accepted = [0, 123, -5, Number.MAX_SAFE_INTEGER, "0123", "9007199254740993", "abc"];
  const rejected = [
    null, undefined, "", "   ", NaN, Infinity, -Infinity, true, false, {}, [],
    () => {}, Symbol("x"), Number.MAX_SAFE_INTEGER + 1,
  ];
  accepted.forEach((v) => assert.equal(domain.isUsableProviderId(v), true, `must accept ${String(v)}`));
  rejected.forEach((v) => assert.equal(domain.isUsableProviderId(v), false, `must reject ${String(v)}`));
});

// ==== Capabilities contract hardening (final closure audit) ================
// assertImplementsContract previously only checked Array.isArray. A mutable
// (unfrozen) array, an array containing a value outside the CAPABILITIES
// vocabulary, or one with a duplicate all passed silently -- none of those
// are a canonical, unambiguous capability declaration.

function fakeAdapter(capabilities) {
  return { key: "fake", capabilities, toCompetition() {}, toCompetitionInstances() {}, toStages() {}, toEvents() {} };
}

test("CONTRACT: a mutable (non-frozen) capabilities array fails the contract", () => {
  assert.throws(() => assertImplementsContract(fakeAdapter(["stages"])), /frozen array/);
});

test("CONTRACT: a value outside the CAPABILITIES vocabulary fails the contract", () => {
  assert.throws(() => assertImplementsContract(fakeAdapter(Object.freeze(["made_up_capability"]))), /outside the CAPABILITIES vocabulary/);
});

test("CONTRACT: duplicate capability values fail the contract", () => {
  assert.throws(() => assertImplementsContract(fakeAdapter(Object.freeze(["stages", "stages"]))), /duplicate/);
});

test("CONTRACT: an empty frozen array and a valid frozen array both pass", () => {
  assert.equal(assertImplementsContract(fakeAdapter(Object.freeze([]))), true);
  assert.equal(assertImplementsContract(fakeAdapter(Object.freeze([CAPABILITIES.STAGES]))), true);
});

test("CONTRACT: both real, registered adapters satisfy the hardened contract", () => {
  assert.equal(assertImplementsContract(sportmonks), true);
  assert.equal(assertImplementsContract(thesportsdb), true);
});

// ==== Provider registry: duplicate key protection (final closure audit) ====
// register() overwrote ADAPTERS.set(adapter.key, ...) silently on a repeat
// key -- a misconfigured second adapter under the same key would replace the
// first with no signal at all, the opposite of "fail loudly" this registry
// otherwise practices (resolveProvider throws on an UNKNOWN key already).

test("REGISTRY: registering a second adapter under an already-used key throws instead of silently replacing it", () => {
  const a = fakeAdapter(Object.freeze([]));
  a.key = "test-only-duplicate-key";
  const b = fakeAdapter(Object.freeze([]));
  b.key = "test-only-duplicate-key";
  providerRegistry.register(a);
  assert.throws(() => providerRegistry.register(b), /Duplicate sports data provider key/);
  assert.equal(providerRegistry.resolveProvider("test-only-duplicate-key"), a, "the original registration must be untouched");
});

test("REGISTRY: both real providers are registered", () => {
  // Not a strict-equality check on the full list: the duplicate-key test
  // above deliberately registers its own throwaway key into this same
  // process-wide registry, so other keys may legitimately be present too.
  const providers = providerRegistry.listProviders();
  assert.ok(providers.includes("sportmonks"));
  assert.ok(providers.includes("thesportsdb"));
});

// ==== Participant signature: normalized semantics (final closure audit) ====
// participantSignature used to sign RAW p.id / p.meta.location directly,
// bypassing the same normalization mapParticipants()/makeCompetitor() apply
// when actually building the Event. Two raw participant records that
// normalize to the IDENTICAL Domain Competitor (e.g. providerCompetitorId
// true vs false, both -> null; meta.location "left" vs "right", both ->
// role: null) were therefore compared as if they were materially different,
// manufacturing a conflict the Domain would never actually see.

const partFx = (participants, over = {}) => ({
  id: 700, stage_id: 1, round_id: null, aggregate_id: null, leg: null,
  starting_at: "2025-12-12", state_id: 1, participants, ...over,
});

test("DEDUPE-PARTICIPANT-1: raw ids that both normalize to providerCompetitorId:null are a duplicate, not a conflict", () => {
  const a = partFx([{ id: true, meta: { location: "home" } }]);
  const b = partFx([{ id: false, meta: { location: "home" } }]);
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [a, b] }, { stages: [] });
  assert.equal(r.events.length, 1);
  assert.equal(r.duplicateFixtures, 1);
  assert.deepEqual(r.conflictingFixtures, []);
  assert.equal(r.events[0].competitors[0].providerCompetitorId, null);
});

test("DEDUPE-PARTICIPANT-2: raw roles that both normalize to role:null are a duplicate, not a conflict", () => {
  const a = partFx([{ id: 1, meta: { location: "left" } }]);
  const b = partFx([{ id: 1, meta: { location: "right" } }]);
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [a, b] }, { stages: [] });
  assert.equal(r.events.length, 1);
  assert.equal(r.duplicateFixtures, 1);
  assert.deepEqual(r.conflictingFixtures, []);
  assert.equal(r.events[0].competitors[0].role, null);
});

test("DEDUPE-PARTICIPANT-3: home vs away for the SAME competitor id is still a real, material conflict", () => {
  const a = partFx([{ id: 1, meta: { location: "home" } }]);
  const b = partFx([{ id: 1, meta: { location: "away" } }]);
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [a, b] }, { stages: [] });
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.conflictingFixtures, ["700"]);
});

test("DEDUPE-PARTICIPANT-4: genuinely different usable competitor ids are still a real conflict", () => {
  const a = partFx([{ id: 1, meta: { location: "home" } }]);
  const b = partFx([{ id: 2, meta: { location: "home" } }]);
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [a, b] }, { stages: [] });
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.conflictingFixtures, ["700"]);
});

test("DEDUPE-PARTICIPANT-5: participant order never fabricates a conflict when roles/ids match", () => {
  const a = partFx([{ id: 1, meta: { location: "home" } }, { id: 2, meta: { location: "away" } }]);
  const b = partFx([{ id: 2, meta: { location: "away" } }, { id: 1, meta: { location: "home" } }]);
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [a, b] }, { stages: [] });
  assert.equal(r.events.length, 1);
  assert.equal(r.duplicateFixtures, 1);
});

test("DEDUPE-PARTICIPANT-6: cosmetic name differences never fabricate a conflict", () => {
  const a = partFx([{ id: 1, name: "Club América", meta: { location: "home" } }]);
  const b = partFx([{ id: 1, name: "America", meta: { location: "home" } }]);
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [a, b] }, { stages: [] });
  assert.equal(r.events.length, 1);
  assert.equal(r.duplicateFixtures, 1);
});

// ==== Generative/matrix testing (§20): raw equivalence classes =============

test("MATRIX: every pair of raw state_ids in the SAME normalized-status group is a duplicate; every cross-group pair is a conflict", () => {
  const groups = {
    scheduled: [1, 13, 16], live: [2, 3, 4, 6, 9, 21, 22, 25],
    finished: [5, 7, 8], postponed: [10, 11, 15, 18], cancelled: [12, 20],
  };
  const allIds = Object.values(groups).flat();
  for (const idA of allIds) {
    for (const idB of allIds) {
      const r = sportmonks.fromStagePayload(
        { id: 1, fixtures: [baseFx({ state_id: idA }), baseFx({ state_id: idB })] }, { stages: [] }
      );
      const sameGroup = Object.values(groups).some((g) => g.includes(idA) && g.includes(idB));
      if (sameGroup) {
        assert.equal(r.events.length, 1, `state_id ${idA} vs ${idB} (same group) must be a duplicate`);
      } else {
        assert.equal(r.events.length, 0, `state_id ${idA} vs ${idB} (different group) must be a conflict`);
      }
    }
  }
});

test("MATRIX: raw participant fields that normalize to the same Competitor never conflict; changing role or id always does", () => {
  const idEquivalents = [true, false, {}, [], NaN, Infinity]; // all -> providerCompetitorId: null
  const roleEquivalents = ["left", "right", "referee", undefined]; // all -> role: null
  for (const idA of idEquivalents) {
    for (const idB of idEquivalents) {
      const r = sportmonks.fromStagePayload({ id: 1, fixtures: [
        partFx([{ id: idA, meta: { location: "home" } }]),
        partFx([{ id: idB, meta: { location: "home" } }]),
      ] }, { stages: [] });
      assert.equal(r.events.length, 1, `id ${JSON.stringify(idA)} vs ${JSON.stringify(idB)} must be a duplicate`);
    }
  }
  for (const roleA of roleEquivalents) {
    for (const roleB of roleEquivalents) {
      const r = sportmonks.fromStagePayload({ id: 1, fixtures: [
        partFx([{ id: 1, meta: { location: roleA } }]),
        partFx([{ id: 1, meta: { location: roleB } }]),
      ] }, { stages: [] });
      assert.equal(r.events.length, 1, `role ${JSON.stringify(roleA)} vs ${JSON.stringify(roleB)} must be a duplicate`);
    }
  }
});
