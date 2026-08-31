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
//   capabilities  Set     — from CAPABILITIES above
//   toCompetition(raw)        -> domain Competition
//   toCompetitionInstances(raw) -> domain CompetitionInstance[]
//   toStages(raw, ctx)        -> domain Stage[]
//   toEvents(raw, ctx)        -> domain Event[]
//
// Fetching is deliberately NOT part of this contract: the mappers are pure so
// they can be tested against recorded payloads with no network, per DATA-003's
// explicit "NO uses una API real en tests".
function assertImplementsContract(adapter) {
  const required = ["key", "capabilities", "toCompetition", "toCompetitionInstances", "toStages", "toEvents"];
  const missing = required.filter((k) => adapter == null || adapter[k] == null);
  if (missing.length) {
    throw new Error(`Adapter does not implement SportsProvider contract, missing: ${missing.join(", ")}`);
  }
  if (!(adapter.capabilities instanceof Set)) {
    throw new Error("Adapter.capabilities must be a Set of CAPABILITIES values");
  }
  return true;
}

function hasCapability(adapter, capability) {
  return !!(adapter && adapter.capabilities instanceof Set && adapter.capabilities.has(capability));
}

// A capabilities Set that is genuinely immutable, unlike
// Object.freeze(new Set(...)) -- freeze only locks a Set's OWN properties,
// never its inherited add/delete/clear methods, so a frozen Set stays fully
// mutable through its own API. A consumer able to call
// adapter.capabilities.add(...) could make hasCapability() lie about what a
// provider actually supports, which is exactly the kind of externally
// triggerable change in Sports Domain semantics DATA-003 exists to prevent.
//
// A Proxy is the correct fix: it intercepts add/delete/clear before they
// reach the underlying Set, so a mutation attempt throws instead of
// silently changing what hasCapability() reports. `instanceof Set` and
// `.has()` keep working exactly as assertImplementsContract() and
// hasCapability() require, because the Proxy's default traps forward
// everything else straight to the wrapped Set.
function immutableCapabilitySet(values) {
  const set = new Set(values);
  const blockedMethods = new Set(["add", "delete", "clear"]);
  return new Proxy(set, {
    get(target, prop, receiver) {
      if (blockedMethods.has(prop)) {
        return () => {
          throw new TypeError(`capabilities is immutable: cannot call .${String(prop)}()`);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

module.exports = { CAPABILITIES, assertImplementsContract, hasCapability, immutableCapabilitySet };
