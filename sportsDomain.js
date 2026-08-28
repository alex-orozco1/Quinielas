// sportsDomain.js — DATA-003: the QRACKS Sports Domain.
//
// This is the FRONTIER. Everything above it (Competition Sync, Admin,
// scoring, monetization) speaks ONLY this vocabulary. Everything below it
// (TheSportsDB, Sportmonks, whatever comes next) speaks the provider's
// vocabulary and is translated by an Adapter.
//
// Hard rules, enforced by the factories below rather than by convention:
//   1. No provider field name ever appears above this file. No intRound, no
//      strSeason, no stage_id, no idEvent leaking into product code.
//   2. Every id is namespaced by provider, so two providers can coexist in
//      the same database without colliding.
//   3. Optionality is explicit. Sportmonks knockout fixtures really do come
//      back with round_id = null and aggregate_id = null; TheSportsDB has no
//      stage concept at all. The domain models "unknown" as null and never
//      invents a value to fill it.
//   4. Nothing here infers meaning from dates, gaps, or numeric codes. That
//      was the DATA-003 correction: semantics come from providers that model
//      them, never from heuristics layered on providers that don't.
//
// Pure module: no I/O, no clock, no network. Fully unit-testable.

const SPORT_FOOTBALL = "football";

// ---- id helpers -----------------------------------------------------------
// Stable and deterministic: the same provider payload always yields the same
// domain id, which is what makes sync idempotent without needing a database
// lookup. Never derived from array position, date, or import order.
function domainId(provider, kind, ...parts) {
  if (!provider) throw new Error("domainId: provider is required");
  const tail = parts.map((p) => (p == null ? "_" : String(p)));
  return [provider, kind, ...tail].join(":");
}

// ---- Competition ----------------------------------------------------------
// A recurring competition: Liga MX, Premier League, NBA.
function makeCompetition({ provider, providerCompetitionId, name, sportKey }) {
  if (!provider || providerCompetitionId == null) {
    throw new Error("makeCompetition: provider and providerCompetitionId are required");
  }
  return Object.freeze({
    id: domainId(provider, "competition", providerCompetitionId),
    provider,
    providerCompetitionId: String(providerCompetitionId),
    name: name || null,
    sportKey: sportKey || SPORT_FOOTBALL,
  });
}

// ---- CompetitionInstance --------------------------------------------------
// ONE tournament with its own champion: "Apertura 2025", "Clausura 2026",
// "Premier League 2025/2026".
//
// CRITICAL: a CompetitionInstance is NOT necessarily a provider season.
// Sportmonks returns Liga MX season 25539 ("2025/2026") containing BOTH
// Apertura and Clausura, which are two separate tournaments with two separate
// champions. The domain therefore carries providerSeasonId and instanceKey as
// separate fields, and the id includes both — so two instances can share one
// provider season without colliding.
function makeCompetitionInstance({
  provider, competitionId, providerSeasonId, instanceKey,
  name, startsAt, endsAt, finished, instanceSeparationConfirmed,
}) {
  if (!provider || !competitionId) {
    throw new Error("makeCompetitionInstance: provider and competitionId are required");
  }
  return Object.freeze({
    id: domainId(provider, "instance", providerSeasonId, instanceKey),
    provider,
    competitionId,
    providerSeasonId: providerSeasonId == null ? null : String(providerSeasonId),
    // instanceKey distinguishes tournaments inside one provider season.
    // null means "this provider models one tournament per season" (the normal
    // European case) -- NOT "unknown".
    instanceKey: instanceKey == null ? null : String(instanceKey),
    name: name || null,
    startsAt: startsAt || null,
    endsAt: endsAt || null,
    // Tri-state on purpose: true / false / null(unknown). TheSportsDB cannot
    // answer this at all, and null must never be read as "not finished".
    finished: typeof finished === "boolean" ? finished : null,
    // DATA-003 (QA correction): does QRACKS actually KNOW how to split this
    // competition's provider season into tournaments, or is this instance the
    // fail-safe "one season == one tournament" default? Consumers (especially
    // anything commercial) must be able to tell the difference instead of
    // assuming the separation was verified. Defaults to false: unverified
    // until a competition strategy says otherwise.
    instanceSeparationConfirmed: instanceSeparationConfirmed === true,
  });
}

// ---- Stage ----------------------------------------------------------------
// A phase inside an instance: "Regular Season", "Quarter-finals", "Final".
// Providers that don't model stages (TheSportsDB) simply produce none, and
// the domain does not fabricate one.
function makeStage({
  provider, instanceId, providerStageId, name, sortOrder,
  finished, isCurrent, startsAt, endsAt,
}) {
  if (!provider || !instanceId) {
    throw new Error("makeStage: provider and instanceId are required");
  }
  return Object.freeze({
    id: domainId(provider, "stage", providerStageId),
    provider,
    instanceId,
    providerStageId: providerStageId == null ? null : String(providerStageId),
    name: name || null,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : null,
    finished: typeof finished === "boolean" ? finished : null,
    isCurrent: typeof isCurrent === "boolean" ? isCurrent : null,
    startsAt: startsAt || null,
    endsAt: endsAt || null,
  });
}

// ---- Competitor -----------------------------------------------------------
// Deliberately "competitor", not "team": the same shape has to hold for a
// driver or a fighter later.
function makeCompetitor({ role, providerCompetitorId, name }) {
  return Object.freeze({
    role: role || null,
    providerCompetitorId: providerCompetitorId == null ? null : String(providerCompetitorId),
    name: name || null,
  });
}

// ---- Event ----------------------------------------------------------------
// One fixture/match/bout. This is the only entity Competition Sync consumes.
//
// providerRoundId, stageId, leg and aggregateKey are ALL optional by design,
// confirmed against real Sportmonks data: the Apertura Final fixtures come
// back with round_id = null and aggregate_id = null, carrying their identity
// entirely in stage_id + leg ("1/2", "2/2").
function makeEvent({
  provider, providerEventId, instanceId, stageId,
  providerRoundId, leg, aggregateKey,
  startsAt, status, competitors, score, providerRaw,
}) {
  if (!provider || providerEventId == null) {
    throw new Error("makeEvent: provider and providerEventId are required");
  }
  return Object.freeze({
    id: domainId(provider, "event", providerEventId),
    provider,
    providerEventId: String(providerEventId),
    instanceId: instanceId || null,
    stageId: stageId || null,
    // The provider's own round label, when it has one. String, never Number:
    // "Final" is a legal value for some providers. null is legal too.
    providerRoundId: providerRoundId == null || providerRoundId === "" ? null : String(providerRoundId),
    // Two-legged ties: "1/2", "2/2". null when the provider doesn't model it.
    leg: leg == null || leg === "" ? null : String(leg),
    // Groups the legs of one tie together, when the provider supplies it.
    aggregateKey: aggregateKey == null ? null : String(aggregateKey),
    startsAt: startsAt || null,
    status: status || "unknown",
    competitors: Object.freeze((competitors || []).map(makeCompetitor)),
    score: score || null,
    // Raw provider payload fragment, preserved for audit/debug ONLY.
    // Explicitly never read by product code -- that is the whole point of
    // this boundary.
    providerRaw: providerRaw ? Object.freeze({ ...providerRaw }) : null,
  });
}

module.exports = {
  SPORT_FOOTBALL,
  domainId,
  makeCompetition,
  makeCompetitionInstance,
  makeStage,
  makeCompetitor,
  makeEvent,
};
