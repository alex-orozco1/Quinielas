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
  // Does it model two-legged ties (leg 1/2, 2/2)?
  LEGS: "legs",
  // Does it group the legs of a tie under one aggregate?
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

module.exports = { CAPABILITIES, assertImplementsContract, hasCapability };
