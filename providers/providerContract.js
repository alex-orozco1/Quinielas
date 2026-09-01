// providerContract.js — DATA-003: the SportsProvider contract.
//
// Every adapter implements this shape. Product code depends on the CONTRACT,
// never on a concrete adapter, which is what makes swapping or running two
// providers side by side a configuration change instead of a refactor.
//
// Capabilities are declared, not guessed. This is the mechanism that lets
// QRACKS ask "can this provider tell me a tournament ended?" instead of
// inferring it from data shape -- the mistake DATA-003 exists to correct.

const CAPABILITIES = Object.freeze({
  // Does the provider model phases (Regular Season / Quarter-finals / Final)?
  STAGES: "stages",
  // Can it say a stage/season is finished, explicitly?
  FINISHED_SIGNAL: "finished_signal",
  // Does the provider's SCHEMA model two-legged ties (leg "1/2", "2/2")?
  LEGS: "legs",
  // Does the provider's SCHEMA include an aggregate concept grouping the legs
  // of a tie?
  //
  // READ THIS BEFORE RELYING ON IT. Every capability here means
  // "the provider's schema CAN supply this", NOT "every event will have it".
  // The distinction is concrete, not theoretical: the real Sportmonks
  // Apertura 2025 Final (stage 77479151, fixtures 19609341 / 19609342) came
  // back with aggregate_id = null on BOTH legs even though Sportmonks models
  // aggregates. Consumers must therefore treat event.aggregateKey as
  // genuinely optional and must never read hasCapability(AGGREGATES) as a
  // guarantee of a non-null value. The same applies to providerRoundId, which
  // was also null on those fixtures.
  AGGREGATES: "aggregates",
  // Can more than one tournament (Apertura/Clausura) live in one provider
  // season, distinguishably?
  MULTI_INSTANCE_SEASONS: "multi_instance_seasons",
});

// Shape every adapter must expose. Documented as a plain object rather than a
// class so adapters stay trivially testable as pure mappers.
//
//   key           string  — stable provider key, used in every domain id
//   capabilities  Array   — a frozen array of values from CAPABILITIES above
//   toCompetition(raw)        -> domain Competition
//   toCompetitionInstances(raw) -> domain CompetitionInstance[]
//   toStages(raw, ctx)        -> domain Stage[]
//   toEvents(raw, ctx)        -> domain Event[]
//
// capabilities is a frozen ARRAY, not a Set. It was a Set wrapped in a Proxy
// that blocked add/delete/clear, which fixed the direct mutation hole
// (Object.freeze(new Set(...)) does NOT work: freeze only locks a Set's OWN
// properties, never its inherited add/delete/clear methods) but reopened an
// equivalent one: Set.prototype.forEach(cb) invokes cb(value, value, S) with
// S bound to whatever `this` forEach was actually called on. Binding every
// forwarded method to the wrapped target (needed for methods like .has() to
// work at all, since built-in Set methods require a real internal Set slot)
// meant forEach handed callbacks the REAL, unprotected backing Set as its
// third argument -- fully mutable, Proxy bypassed entirely:
//   adapter.capabilities.forEach((_v, _k, realSet) => realSet.add("fake"));
// A frozen plain array has no such hole: Object.freeze() on an array
// genuinely blocks push/pop/splice/index-reassignment (its elements are
// ordinary own properties, unlike a Set's internal slot data), and even
// Array.prototype.forEach's third argument (the array itself) is harmless
// because that array is frozen too. Simpler and strictly safer than the
// Proxy, so the Proxy approach is not kept for either adapter.
//
// Fetching is deliberately NOT part of this contract: the mappers are pure so
// they can be tested against recorded payloads with no network, per DATA-003's
// explicit "NO uses una API real en tests".
const VALID_CAPABILITY_VALUES = new Set(Object.values(CAPABILITIES));

function assertImplementsContract(adapter) {
  const required = ["key", "capabilities", "toCompetition", "toCompetitionInstances", "toStages", "toEvents"];
  const missing = required.filter((k) => adapter == null || adapter[k] == null);
  if (missing.length) {
    throw new Error(`Adapter does not implement SportsProvider contract, missing: ${missing.join(", ")}`);
  }
  const caps = adapter.capabilities;
  // Array.isArray alone isn't the contract: a mutable array is exactly the
  // hole this frontier exists to close, so a declaration that isn't actually
  // frozen is rejected just as hard as one that isn't an array at all.
  if (!Array.isArray(caps) || !Object.isFrozen(caps)) {
    throw new Error("Adapter.capabilities must be a frozen array of CAPABILITIES values");
  }
  const invalid = caps.filter((c) => !VALID_CAPABILITY_VALUES.has(c));
  if (invalid.length) {
    throw new Error(`Adapter.capabilities contains values outside the CAPABILITIES vocabulary: ${invalid.join(", ")}`);
  }
  // A capability declaration is a canonical, unambiguous set -- listing one
  // twice has no meaning and would only ever be an authoring mistake.
  if (new Set(caps).size !== caps.length) {
    throw new Error("Adapter.capabilities must not contain duplicate values");
  }
  return true;
}

function hasCapability(adapter, capability) {
  return !!(adapter && Array.isArray(adapter.capabilities) && adapter.capabilities.includes(capability));
}

module.exports = { CAPABILITIES, assertImplementsContract, hasCapability };
