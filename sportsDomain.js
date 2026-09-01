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
//   - safe integers ......... 123, 0, -5   (normalized via String())
//   - non-empty strings ..... "123", "abc", "9007199254740993"
//
// REJECTED, and why each one matters
//   - null / undefined ...... absent identity
//   - "" and "   " .......... would make every malformed record collide on
//                             one id, and would be indistinguishable from the
//                             "absent component" encoding above
//   - NaN / Infinity ........ String() yields "NaN"/"Infinity"; every NaN id
//                             would collide, and no provider ever issues one
//   - a finite but UNSAFE number (beyond Number.MAX_SAFE_INTEGER) ... it may
//                             already be a rounded, imprecise value by the
//                             time it reaches this function, and two
//                             genuinely different huge provider ids can round
//                             to the SAME double -- accepting it risks
//                             minting one domain id for two different real
//                             records. A provider id that large must be
//                             passed as a STRING (see below), never a number.
//   - true / false .......... "true"/"false" are not identities; accepting
//                             them silently converts a boolean field read by
//                             mistake into a plausible-looking id
//   - objects / arrays ...... stringify to "[object Object]" / "" / "a,b",
//                             so all of them collide
//   - symbols / functions ... String() throws or yields non-identity text
//
// Numeric 123 and string "123" deliberately normalize to the SAME identity.
// "0123" and 123 deliberately do NOT: they are different provider strings and
// pretending otherwise would merge two real records. A string is NEVER
// routed through Number() here, so an exact huge digit string like
// "9007199254740993" keeps its exact value -- precision loss is only a risk
// for the number branch, which is why that branch alone needs isSafeInteger.
function isUsableProviderId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value);
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
//
// The closed, QRACKS-owned vocabulary for role, same pattern as
// normalizeEventStatus: only "home"/"away" are real functional semantics
// today, and anything else -- a raw provider-specific value an adapter
// forgot to translate, or simply a future sport this domain doesn't model
// yet -- degrades to null rather than being accepted verbatim. null stays
// legal and is NOT "unknown": a driver or a fighter genuinely has no
// home/away, and this must not block that.
const COMPETITOR_ROLES = Object.freeze(["home", "away"]);
const COMPETITOR_ROLE_MEMBERSHIP = new Set(COMPETITOR_ROLES);
function normalizeCompetitorRole(role) {
  return COMPETITOR_ROLE_MEMBERSHIP.has(role) ? role : null;
}

function makeCompetitor({ role, providerCompetitorId, name }) {
  return Object.freeze({
    role: normalizeCompetitorRole(role),
    // isUsableProviderId, not a bare null-check: {} / [] / true / NaN /
    // Infinity must never become the identity strings "[object Object]" /
    // "" / "true" / "NaN" / "Infinity", which could collide across
    // competitors or look like a legitimate id. A competitor legitimately
    // missing an id degrades to null -- never fabricated.
    providerCompetitorId: isUsableProviderId(providerCompetitorId) ? String(providerCompetitorId) : null,
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

// ---- Event leg --------------------------------------------------------
// A two-legged tie's leg, QRACKS-owned: { number, total }. The domain never
// knows a provider's raw encoding ("1/2", "2/2") -- an adapter must parse its
// own format into this shape (or into null, when parsing fails) BEFORE
// calling makeEvent(). normalizeLeg() is the one place that decides whether
// an already-structured value is a legal leg, so a malformed or mutated
// object degrades to null instead of producing a nonsensical Event.
//
// Both fields must be positive SAFE integers with number <= total: "0/2",
// "3/2", non-integers, and anything not shaped like { number, total } are
// all invalid. Number.isSafeInteger, not Number.isInteger: a raw value like
// "9007199254740993" (2^53+1) parses via Number() to 9007199254740992,
// silently rounded to a DIFFERENT integer that Number.isInteger still
// accepts -- a corrupted/absurd input must never round into looking like a
// legitimate, different leg. isSafeInteger rejects it (and any digit string
// whose true magnitude exceeds Number.MAX_SAFE_INTEGER always rounds to a
// value >= 2^53, so this check catches every such case, not just this one).
// The returned object is freshly built and frozen on every call, so no two
// Events -- and no Event and its caller's original input -- can ever share
// a mutable reference to it.
function normalizeLeg(leg) {
  if (leg == null || typeof leg !== "object" || Array.isArray(leg)) return null;
  const { number, total } = leg;
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(total)) return null;
  if (number <= 0 || total <= 0 || number > total) return null;
  return Object.freeze({ number, total });
}

// ---- Event score ------------------------------------------------------
// score is currently always a flat { home, away } (numbers only, no nested
// data -- see sportsDataProvider.normalizeEvent()), or null. A shallow
// copy + freeze is the correct minimal protection for that shape: without
// it, Object.freeze(Event) is shallow and does nothing to a score object
// nested inside it, so a caller retaining the original input object (or
// reading event.score itself) could mutate scores after the fact --
// exactly the kind of externally-triggerable change in Sports Domain
// semantics DATA-003 exists to prevent. Not a general/deep-freeze solution:
// if a future provider nests data inside score, this must be revisited.
function normalizeScore(score) {
  if (score == null || typeof score !== "object" || Array.isArray(score)) return null;
  return Object.freeze({ ...score });
}

// ---- Event ----------------------------------------------------------------
// One fixture/match/bout. This is the only entity Competition Sync consumes.
//
// providerRoundId, stageId, leg and aggregateKey are ALL optional by design,
// confirmed against real Sportmonks data: the Apertura Final fixtures come
// back with round_id = null and aggregate_id = null, carrying their identity
// entirely in stage_id + leg (QRACKS-owned { number, total }, parsed by the
// adapter from the provider's own "1/2" / "2/2" encoding).
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
    // QRACKS-owned { number, total } value object. null when the provider
    // doesn't model legs, or when the input didn't parse to a legal leg.
    leg: normalizeLeg(leg),
    // Groups the legs of one tie together, when the provider supplies it.
    aggregateKey: aggregateKey == null ? null : String(aggregateKey),
    startsAt: startsAt || null,
    status: normalizeEventStatus(status),
    competitors: Object.freeze((competitors || []).map(makeCompetitor)),
    score: normalizeScore(score),
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
  normalizeLeg,
  normalizeScore,
  COMPETITOR_ROLES,
  normalizeCompetitorRole,
};
