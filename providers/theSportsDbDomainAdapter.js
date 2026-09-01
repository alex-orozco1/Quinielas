// theSportsDbDomainAdapter.js — DATA-003: TheSportsDB → QRACKS Sports Domain.
//
// Wraps the EXISTING, already-hardened TheSportsDB pipeline behind the same
// contract Sportmonks implements, so both can coexist. Deliberately additive:
// it does not modify providers/theSportsDbAdapter.js or sportsDataProvider.js,
// and no existing quiniela changes behaviour because of it.
//
// The point of this file is honesty about capability. TheSportsDB declares
// NO stages, NO finished signal, NO legs, NO aggregates, and NO multi-instance
// seasons -- because it genuinely has none. MON-001D.2 proved that intRound
// 0/125/200 carry no stable meaning and that one strSeason covers both
// Apertura and Clausura. Rather than paper over that with date heuristics
// (the DATA-003 correction), the adapter reports the gap truthfully and lets
// callers decide, via hasCapability(), what they may rely on.

const domain = require("../sportsDomain");

const KEY = "thesportsdb";

function toCompetition(rawLeague) {
  // `|| {}` so a null/undefined/primitive record fails as a DOMAIN error
  // ("a usable providerCompetitionId is required") rather than as a raw
  // TypeError from property access. These mappers are exported and can be
  // called directly, not only through the payload entry points.
  const raw = rawLeague && typeof rawLeague === "object" ? rawLeague : {};
  return domain.makeCompetition({
    provider: KEY,
    providerCompetitionId: raw.externalLeagueId != null ? raw.externalLeagueId : raw.idLeague,
    name: raw.name || raw.strLeague || null,
    sportKey: domain.SPORT_FOOTBALL,
  });
}

// One instance per provider season string, and that is ALL this provider can
// honestly support. For Liga MX that means Apertura and Clausura share a
// single instance -- a known, documented limitation of the provider, surfaced
// through the absent MULTI_INSTANCE_SEASONS capability rather than hidden.
function toCompetitionInstances({ season, competitionId } = {}) {
  return [domain.makeCompetitionInstance({
    provider: KEY,
    competitionId,
    providerSeasonId: season || null,
    instanceKey: null,
    name: season || null,
    startsAt: null,
    endsAt: null,
    finished: null, // provider cannot answer this; null is not "false"
  })];
}

// TheSportsDB has no stage concept. Returning [] is the correct, honest
// answer -- never a synthesised stage inferred from intRound or dates.
function toStages() {
  return [];
}

// Every COLLECTION is shape-checked with Array.isArray and every ELEMENT is
// checked before it is read. `x || []` is not enough: {}, "garbage", true and
// 5 are all truthy and have no .map, so they threw and took the whole batch
// down with them. Likewise a null/undefined element threw on property access.
// A malformed record is skipped; it never crashes, never aborts the other
// records in the same batch, and never invents a competitor that the provider
// did not actually describe.
function mapParticipants(ev) {
  const parts = Array.isArray(ev && ev.participants) ? ev.participants : [];
  return parts
    // A non-object element (null, undefined, true, "garbage", 5) carries no
    // readable identity or role at all -- keeping it would fabricate a
    // phantom all-null competitor the provider never sent. An EMPTY OBJECT
    // is different: it is a real record with no usable fields, so it
    // degrades to an all-null Competitor rather than disappearing.
    .filter((p) => p && typeof p === "object")
    .map((p) => ({ role: p.role, providerCompetitorId: p.externalId, name: p.name }));
}

// Accepts events already normalised by sportsDataProvider.normalizeEvent(),
// so the existing pipeline is reused rather than duplicated. Still filters
// for a well-formed, usable id first: a single null/undefined/malformed
// record in the array must be skipped, never crash or abort every other
// record in the same batch (the same fail-safe posture Sportmonks' own
// toEvents takes for its fixtures array).
function toEvents({ events, instances } = {}) {
  const instanceList = Array.isArray(instances) ? instances : [];
  const instanceId = instanceList[0] && instanceList[0].id ? instanceList[0].id : null;
  const wellFormed = (Array.isArray(events) ? events : [])
    .filter((ev) => ev && typeof ev === "object" && domain.isUsableProviderId(ev.externalEventId));
  return wellFormed.map((ev) => domain.makeEvent({
    provider: KEY,
    providerEventId: ev.externalEventId,
    instanceId,
    stageId: null,
    providerRoundId: ev.round,
    leg: null,          // not modelled by this provider
    aggregateKey: null, // not modelled by this provider
    startsAt: ev.dateTime || null,
    status: ev.status || "unknown",
    competitors: mapParticipants(ev),
    score: ev.score || null,
    providerRaw: { round: ev.round ?? null },
  }));
}

module.exports = {
  key: KEY,
  // Intentionally empty: this provider supports none of these. Callers must
  // check rather than assume. A frozen array so an external caller cannot
  // make it look like this provider has a capability it does not.
  capabilities: Object.freeze([]),
  toCompetition,
  toCompetitionInstances,
  toStages,
  toEvents,
};
