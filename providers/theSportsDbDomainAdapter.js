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

const { CAPABILITIES } = require("./providerContract");
const domain = require("../sportsDomain");

const KEY = "thesportsdb";

function toCompetition(raw) {
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
function toCompetitionInstances({ season, competitionId }) {
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

// Accepts events already normalised by sportsDataProvider.normalizeEvent(),
// so the existing pipeline is reused rather than duplicated.
function toEvents({ events, instances }) {
  const instanceId = instances && instances[0] ? instances[0].id : null;
  return (events || []).map((ev) => domain.makeEvent({
    provider: KEY,
    providerEventId: ev.externalEventId,
    instanceId,
    stageId: null,
    providerRoundId: ev.round,
    leg: null,          // not modelled by this provider
    aggregateKey: null, // not modelled by this provider
    startsAt: ev.dateTime || null,
    status: ev.status || "unknown",
    competitors: (ev.participants || []).map((p) => ({
      role: p.role, providerCompetitorId: p.externalId, name: p.name,
    })),
    score: ev.score || null,
    providerRaw: { round: ev.round ?? null },
  }));
}

module.exports = {
  key: KEY,
  // Intentionally empty: this provider supports none of these. Callers must
  // check rather than assume.
  capabilities: new Set(),
  toCompetition,
  toCompetitionInstances,
  toStages,
  toEvents,
};
