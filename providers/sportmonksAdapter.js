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
const { STRATEGIES, STAGE_NAME_SEPARATOR, getCompetitionConfig } = require("./sportmonksCompetitionConfig");

const KEY = "sportmonks";

// ---- CompetitionInstance derivation ---------------------------------------
//
// DATA-003 (QA correction). The previous version applied a single global
// name-splitting rule to every competition and claimed it was "safe for every
// league". That claim was not evidenced and was wrong: a competition with
// stages named "Regular Season" / "Championship Round" / "Relegation Round"
// would have been split into three separate tournaments, which for a
// commercial anchor is unacceptable.
//
// Derivation is now driven by explicit per-competition configuration
// (sportmonksCompetitionConfig.js), with a fail-safe default of ONE instance
// per provider season for any competition we have not validated. Stages
// themselves always come dynamically from the provider; configuration only
// decides how they are grouped.

function deriveInstanceKey(stageName, config) {
  if (!config || config.instanceStrategy !== STRATEGIES.STAGE_NAME_PREFIX) return null;
  if (!stageName || typeof stageName !== "string") return null;
  const head = stageName.split(STAGE_NAME_SEPARATOR)[0].trim();
  return head || null;
}

// The phase label shown for a stage. Under SINGLE_INSTANCE the whole name IS
// the phase ("Regular Season"). Under STAGE_NAME_PREFIX the tournament prefix
// is stripped, leaving "Final", "Play In", "Reclasificación", etc. The set of
// phases is never assumed or enumerated anywhere — it is whatever the
// provider returned.
function derivePhaseName(stageName, config) {
  if (!stageName || typeof stageName !== "string") return null;
  if (!config || config.instanceStrategy !== STRATEGIES.STAGE_NAME_PREFIX) {
    return stageName.trim() || null;
  }
  const parts = stageName.split(STAGE_NAME_SEPARATOR).map((x) => x.trim()).filter(Boolean);
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
function toCompetitionInstances({ season, stages, competitionId, providerCompetitionId }) {
  const config = getCompetitionConfig(providerCompetitionId);
  const list = Array.isArray(stages) ? stages : [];
  const byKey = new Map();
  for (const st of list) {
    const key = deriveInstanceKey(st && st.name, config);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(st);
  }
  // No stages at all: still produce one instance for the season, so callers
  // always have somewhere to attach events.
  if (byKey.size === 0) byKey.set(null, []);

  const instances = [];
  for (const [instanceKey, sts] of byKey) {
    // Dates are the observed min/max across the instance's stages. Stages
    // whose ending_at was never observed contribute nothing here rather than
    // being back-filled from a guess.
    const starts = sts.map((x) => x.starting_at).filter(Boolean).sort();
    const ends = sts.map((x) => x.ending_at).filter(Boolean).sort();
    // finished is true only when EVERY stage reports finished:true. A single
    // stage without the flag makes the answer null (unknown) -- never false,
    // which could read as "still running", and never true, which could close
    // a tournament early.
    const flags = sts.map((x) => (typeof x.finished === "boolean" ? x.finished : null));
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
      instanceSeparationConfirmed: config.instanceSeparationConfirmed === true,
    }));
  }
  return instances;
}

function toStages({ stages, instances, providerCompetitionId }) {
  const config = getCompetitionConfig(providerCompetitionId);
  const list = Array.isArray(stages) ? stages : [];
  const instanceByKey = new Map((instances || []).map((i) => [i.instanceKey, i.id]));
  return list.map((st) => {
    const key = deriveInstanceKey(st && st.name, config);
    return domain.makeStage({
      provider: KEY,
      instanceId: instanceByKey.get(key) || null,
      providerStageId: st.id,
      name: derivePhaseName(st && st.name, config),
      // sort_order is passed through EXACTLY as the provider gave it. It is a
      // provider-defined ordering hint and is explicitly NOT chronology: the
      // real Liga MX data has "Apertura - Reclasificación" at sort_order 6
      // while it is played on 2025-11-21, before "Apertura, Play In" at
      // sort_order 2 on 2025-11-24. Never reorder, never re-derive.
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
