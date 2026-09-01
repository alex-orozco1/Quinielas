// sportmonksCompetitionConfig.js — DATA-003 (QA correction).
//
// WHY THIS FILE EXISTS
// -------------------
// The first attempt derived CompetitionInstance globally, by splitting every
// stage name on the first "," or " - ". That happened to work for Liga MX and
// was WRONG as a general rule: there is no evidence that Sportmonks treats a
// stage-name prefix as a tournament identifier, and a perfectly ordinary
// competition with stages named "Regular Season" / "Championship Round" /
// "Relegation Round" would have been split into three tournaments. Since
// CompetitionInstance is the anchor for commercial lifecycle, an unproven
// global heuristic there is unacceptable.
//
// So instance derivation is now an EXPLICIT, per-competition strategy, and the
// default is fail-safe.
//
// WHAT WE INVESTIGATED BEFORE CHOOSING
// ------------------------------------
// Looking for an official Sportmonks field that identifies the tournament
// inside a season, the only structural signal present in our real Liga MX
// evidence is stage.type_id: 223 for the two league phases ("Apertura",
// "Clausura") and 224 for every knockout phase. In that sample a new 223
// stage does coincide with the start of a new tournament — but we have NO
// documentation or cross-competition evidence that this is a contract, and a
// league with several 223-type stages in one season would break it. It is
// therefore recorded here as an observation, NOT used as the identifier.
// If Sportmonks ever exposes an explicit tournament/edition field, it should
// replace the strategy below — at this boundary, with nothing above it
// changing.
//
// The stage LIST always comes dynamically from the provider. Configuration
// only decides HOW stages are grouped into tournaments. No phase is ever
// hardcoded: nothing here knows or assumes that a Play In, a Reclasificación,
// or any particular round exists, or that Apertura and Clausura share a shape.

const STRATEGIES = Object.freeze({
  // One provider season == one tournament. The safe default for every
  // competition we have not explicitly validated.
  SINGLE_INSTANCE: "single_instance",
  // The season contains several tournaments, distinguished by the leading
  // segment of each stage name. Only ever applied to competitions where we
  // have checked this against real provider data.
  STAGE_NAME_PREFIX: "stage_name_prefix",
});

// Separator used only by STAGE_NAME_PREFIX. Both forms appear in the real
// Liga MX data ("Apertura, Final" and "Clausura - Final").
const STAGE_NAME_SEPARATOR = /\s*(?:,| - )\s*/;

const COMPETITION_CONFIG = Object.freeze({
  // Liga MX. Validated against real provider data for season 25539
  // (2025/2026): 10 stages resolving to exactly two tournaments, each with
  // its own champion. See test/sportsDataLayer.test.js for the recorded
  // evidence this was checked against.
  "743": Object.freeze({
    label: "Liga MX",
    instanceStrategy: STRATEGIES.STAGE_NAME_PREFIX,
    instanceSeparationConfirmed: true,
    evidenceNote: "Verified against real Sportmonks stages for season 25539 (2025/2026).",
  }),
});

// A competition with no entry gets the fail-safe default: ONE instance per
// provider season, and instanceSeparationConfirmed=false so consumers can
// tell that multi-tournament separation is unverified rather than absent.
const DEFAULT_CONFIG = Object.freeze({
  label: null,
  instanceStrategy: STRATEGIES.SINGLE_INSTANCE,
  instanceSeparationConfirmed: false,
  evidenceNote: "No validated instance strategy for this competition — defaulting to one instance per provider season.",
});

function getCompetitionConfig(providerCompetitionId) {
  if (providerCompetitionId == null) return DEFAULT_CONFIG;
  return COMPETITION_CONFIG[String(providerCompetitionId)] || DEFAULT_CONFIG;
}

module.exports = {
  STRATEGIES,
  STAGE_NAME_SEPARATOR,
  COMPETITION_CONFIG,
  DEFAULT_CONFIG,
  getCompetitionConfig,
};
