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
// Every component is percent-encoded BEFORE being joined, so the ":" that
// separates components can never occur inside one. Without this the id was
// not injective over its components:
//   ("123:A", "B")  and  ("123", "A:B")
// both flattened to "sportmonks:instance:123:A:B" — two different provider
// identities colliding on one domain id. encodeURIComponent was chosen over a
// bespoke escaping scheme because it is standard, auditable, deterministic,
// and escapes ":" (to %3A) while leaving ordinary ids byte-identical, so
// "sportmonks:event:19609341" is unchanged.
//
// An ABSENT component encodes as the empty string. That is unambiguous
// because a PRESENT component can never be empty: isUsableProviderId rejects
// empty and whitespace-only values before we get here.
function encodeIdComponent(value) {
  if (value == null) return "";
  return encodeURIComponent(String(value));
}

function domainId(provider, kind, ...parts) {
  if (!provider) throw new Error("domainId: provider is required");
  return [encodeIdComponent(provider), encodeIdComponent(kind), ...parts.map(encodeIdComponent)].join(":");
}

// What may serve as a provider id.
//
// ACCEPTED
//   - finite numbers ........ 123, 0, -5   (normalized via String())
//   - non-empty strings ..... "123", "abc"
//
// REJECTED, and why each one matters
//   - null / undefined ...... absent identity
//   - "" and "   " .......... would make every malformed record collide on
//                             one id, and would be indistinguishable from the
//                             "absent component" encoding above
//   - NaN / Infinity ........ String() yields "NaN"/"Infinity"; every NaN id
//                             would collide, and no provider ever issues one
//   - true / false .......... "true"/"false" are not identities; accepting
//                             them silently converts a boolean field read by
//                             mistake into a plausible-looking id
//   - objects / arrays ...... stringify to "[object Object]" / "" / "a,b",
//                             so all of them collide
//   - symbols / functions ... String() throws or yields non-identity text
//
// Numeric 123 and string "123" deliberately normalize to the SAME identity.
// "0123" and 123 deliberately do NOT: they are different provider strings and
// pretending otherwise would merge two real records.
function isUsableProviderId(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim() !== "";
  return false;
}

// ---- Competition ----------------------------------------------------------
// A recurring competition: Liga MX, Premier League, NBA.
function makeCompetition({ provider, providerCompetitionId, name, sportKey }) {
  if (!provider || !isUsableProviderId(providerCompetitionId)) {
    throw new Error("makeCompetition: provider and a usable providerCompetitionId are required");
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
  // The id is built from providerSeasonId + instanceKey. If BOTH are absent
  // the result would be "provider:instance:_:_" -- an id every anonymous
  // instance would share. Refuse rather than mint a colliding identity.
  if (!isUsableProviderId(providerSeasonId) && !isUsableProviderId(instanceKey)) {
    throw new Error("makeCompetitionInstance: at least one of providerSeasonId or instanceKey must be usable");
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
  // Same collision hazard as above: a stage with no id would become
  // "provider:stage:_", shared by every id-less stage in the payload.
  if (!isUsableProviderId(providerStageId)) {
    throw new Error("makeStage: a usable providerStageId is required");
  }
  return Object.freeze({
    id: domainId(provider, "stage", providerStageId),
    provider,
    instanceId,
    providerStageId: String(providerStageId),
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

// ---- Event status -----------------------------------------------------
// The closed, QRACKS-owned vocabulary for Event.status. This is the frontier
// rule from the top of this file applied to status specifically: a provider
// value is either translated into one of these six words or it becomes
// "unknown" -- it never passes through verbatim.
//
// Object.freeze(new Set(...)) looks like it makes a status allowlist
// immutable and does NOT: freeze only locks a Set's OWN properties, never
// its inherited add/delete/clear methods, so `frozenSet.add("5")` still
// silently succeeds. A frozen ARRAY is genuinely immutable (its elements are
// plain own properties, which freeze does lock), so that is what gets
// exported for callers that need to enumerate or validate against the
// vocabulary. The Set below exists only for fast membership testing and is
// never exported, so there is nothing external code could reach to mutate.
const EVENT_STATUSES = Object.freeze([
  "scheduled", "live", "finished", "postponed", "cancelled", "unknown",
]);
const EVENT_STATUS_MEMBERSHIP = new Set(EVENT_STATUSES);

// The single point of enforcement: called from makeEvent() so every Event,
// from every adapter, gets the same treatment -- an adapter cannot forget to
// normalize because it never gets the choice. Anything not already one of
// the six words above (a Sportmonks numeric state_id, a stale provider code,
// a typo) degrades to "unknown" rather than being accepted verbatim.
function normalizeEventStatus(value) {
  return EVENT_STATUS_MEMBERSHIP.has(value) ? value : "unknown";
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
  if (!provider || !isUsableProviderId(providerEventId)) {
    throw new Error("makeEvent: provider and a usable providerEventId are required");
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
    status: normalizeEventStatus(status),
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
  isUsableProviderId,
  encodeIdComponent,
  makeCompetition,
  makeCompetitionInstance,
  makeStage,
  makeCompetitor,
  makeEvent,
  EVENT_STATUSES,
  normalizeEventStatus,
};
