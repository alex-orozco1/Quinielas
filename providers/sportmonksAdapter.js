// sportmonksAdapter.js — DATA-003: Sportmonks → QRACKS Sports Domain.
//
// PURE MAPPERS ONLY. No HTTP, no token, no clock. Everything here is driven
// by payloads, so tests run against recorded fixtures and never touch a live
// API (DATA-003 §"NO uses una API real en tests").
//
// SPORTMONKS_API_TOKEN is read exclusively server-side from the environment by
// the client layer -- never here, never in fixtures, never logged.

const { CAPABILITIES } = require("./providerContract");
const domain = require("../sportsDomain");

const KEY = "sportmonks";

// ---- CompetitionInstance derivation ---------------------------------------
//
// The real problem this solves, confirmed against Sportmonks data for Liga MX
// (league_id 743, season 25539 "2025/2026", finished): ONE provider season
// contains TWO tournaments with two champions. Its stages are named:
//
//   Apertura · Apertura - Reclasificación · Apertura, Play In ·
//   Apertura, Quarter-finals · Apertura, Semi-finals · Apertura, Final ·
//   Clausura · Clausura - Quarter-finals · Clausura - Semi-finals ·
//   Clausura - Final
//
// So the tournament identity is carried in the stage NAME's leading segment,
// with the phase after a separator ("," or " - ").
//
// This is a GENERIC string rule, not a Liga MX special case: it never mentions
// "Apertura"/"Clausura", never checks league_id, and degrades correctly for a
// normal European league, where stage names like "Regular Season" have no
// separator and therefore all collapse to a single instance.
//
// It is a declared, testable adapter strategy -- not an inference about dates
// or numeric codes. If a competition ever needs a different rule, it is
// overridden here, at the boundary, and nothing above the domain changes.
const INSTANCE_SEPARATOR = /\s*(?:,| - )\s*/;

function deriveInstanceKey(stageName) {
  if (!stageName || typeof stageName !== "string") return null;
  const head = stageName.split(INSTANCE_SEPARATOR)[0].trim();
  return head || null;
}

// Phase label = whatever follows the instance prefix. Returns the full name
// when there is no separator, which is correct for "Regular Season".
function derivePhaseName(stageName) {
  if (!stageName || typeof stageName !== "string") return null;
  const parts = stageName.split(INSTANCE_SEPARATOR).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return stageName.trim() || null;
  return parts.slice(1).join(" ");
}

function toCompetition(rawLeague) {
  return domain.makeCompetition({
    provider: KEY,
    providerCompetitionId: rawLeague.id,
    name: rawLeague.name || null,
    sportKey: domain.SPORT_FOOTBALL,
  });
}

// Builds one CompetitionInstance per distinct instanceKey found across the
// season's stages. A season whose stages share no prefix yields exactly one
// instance -- the normal case -- so this is safe for every league.
function toCompetitionInstances({ season, stages, competitionId }) {
  const list = Array.isArray(stages) ? stages : [];
  const byKey = new Map();
  for (const st of list) {
    const key = deriveInstanceKey(st && st.name);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(st);
  }
  // No stages at all: still produce one instance for the season, so callers
  // always have something to attach events to.
  if (byKey.size === 0) byKey.set(null, []);

  const instances = [];
  for (const [instanceKey, sts] of byKey) {
    const starts = sts.map((s) => s.starting_at).filter(Boolean).sort();
    const ends = sts.map((s) => s.ending_at).filter(Boolean).sort();
    // finished is true only when EVERY stage of the instance reports finished.
    // If any stage lacks the flag, the answer is null (unknown) -- never
    // silently false, which downstream could misread as "still active", and
    // never silently true, which could close a tournament early.
    const flags = sts.map((s) => (typeof s.finished === "boolean" ? s.finished : null));
    const finished = flags.length && flags.every((f) => f === true)
      ? true
      : flags.some((f) => f === null) ? null : false;

    instances.push(domain.makeCompetitionInstance({
      provider: KEY,
      competitionId,
      providerSeasonId: season && season.id,
      instanceKey,
      name: instanceKey
        ? `${instanceKey} ${(season && season.name) || ""}`.trim()
        : (season && season.name) || null,
      startsAt: starts[0] || (season && season.starting_at) || null,
      endsAt: ends[ends.length - 1] || (season && season.ending_at) || null,
      finished,
    }));
  }
  return instances;
}

function toStages({ stages, instances }) {
  const list = Array.isArray(stages) ? stages : [];
  const instanceByKey = new Map((instances || []).map((i) => [i.instanceKey, i.id]));
  return list.map((st) => {
    const key = deriveInstanceKey(st && st.name);
    return domain.makeStage({
      provider: KEY,
      instanceId: instanceByKey.get(key) || null,
      providerStageId: st.id,
      name: derivePhaseName(st && st.name),
      sortOrder: Number.isFinite(st.sort_order) ? st.sort_order : null,
      finished: typeof st.finished === "boolean" ? st.finished : null,
      isCurrent: typeof st.is_current === "boolean" ? st.is_current : null,
      startsAt: st.starting_at || null,
      endsAt: st.ending_at || null,
    });
  });
}

function mapParticipants(fixture) {
  const parts = Array.isArray(fixture.participants) ? fixture.participants : [];
  return parts.map((p) => {
    const loc = p && p.meta && p.meta.location;
    return {
      role: loc === "home" ? "home" : loc === "away" ? "away" : null,
      providerCompetitorId: p && p.id,
      name: (p && p.name) || null,
    };
  });
}

// Confirmed against the real Apertura Final (stage_id 77479151): both fixtures
// come back with round_id = null and aggregate_id = null, and carry their
// identity in stage_id + leg ("1/2" / "2/2"). The mapper must therefore treat
// round_id and aggregate_id as genuinely optional and must NOT synthesise them.
function toEvents({ fixtures, stages }) {
  const list = Array.isArray(fixtures) ? fixtures : [];
  const stageById = new Map((stages || []).map((s) => [s.providerStageId, s]));
  return list.map((fx) => {
    const st = fx.stage_id != null ? stageById.get(String(fx.stage_id)) : null;
    return domain.makeEvent({
      provider: KEY,
      providerEventId: fx.id,
      instanceId: st ? st.instanceId : null,
      stageId: st ? st.id : null,
      providerRoundId: fx.round_id == null ? null : fx.round_id,
      leg: fx.leg == null ? null : fx.leg,
      aggregateKey: fx.aggregate_id == null ? null : fx.aggregate_id,
      startsAt: fx.starting_at || null,
      status: fx.state_id != null ? String(fx.state_id) : "unknown",
      competitors: mapParticipants(fx),
      score: null,
      providerRaw: { stage_id: fx.stage_id ?? null, round_id: fx.round_id ?? null, leg: fx.leg ?? null },
    });
  });
}

module.exports = {
  key: KEY,
  capabilities: new Set([
    CAPABILITIES.STAGES,
    CAPABILITIES.FINISHED_SIGNAL,
    CAPABILITIES.LEGS,
    CAPABILITIES.AGGREGATES,
    CAPABILITIES.MULTI_INSTANCE_SEASONS,
  ]),
  toCompetition,
  toCompetitionInstances,
  toStages,
  toEvents,
  // exported for tests
  deriveInstanceKey,
  derivePhaseName,
};
