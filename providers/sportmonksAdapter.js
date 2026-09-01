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

// ---- Sportmonks status mapping ---------------------------------------------
//
// Sportmonks' own fixture-state reference (docs.sportmonks.com/v3/definitions/
// states -- GET /v3/football/states, GET /v3/football/states/{ID}). Every
// state_id below is one Sportmonks documents; anything not listed here
// (including 14/17/19/26 and any future code) deliberately falls through to
// "unknown" rather than being guessed at -- this file's existing rule against
// inferring meaning from unverified numeric codes.
const SPORTMONKS_STATE_TO_STATUS = new Map([
  [1, "scheduled"], [13, "scheduled"], [16, "scheduled"],
  [2, "live"], [3, "live"], [4, "live"], [6, "live"], [9, "live"], [21, "live"], [22, "live"], [25, "live"],
  [5, "finished"], [7, "finished"], [8, "finished"],
  [10, "postponed"], [11, "postponed"], [15, "postponed"], [18, "postponed"],
  [12, "cancelled"], [20, "cancelled"],
]);

// Sportmonks always sends state_id as a JSON number, and ONLY a real number
// is accepted -- Number(stateId) coercion was tried and rejected: it lets
// true, [1], and " 1 " all become 1 and silently gain the semantics of
// state_id 1 ("scheduled"), which is exactly a provider-specific-looking
// value acquiring QRACKS meaning through JavaScript type coercion rather
// than genuine provider evidence. typeof + Number.isSafeInteger rejects
// every non-number type outright (no numeric-string compatibility: there is
// no real Sportmonks payload shape that needs it) and rejects NaN/Infinity/
// non-integers/unsafe-magnitude numbers that Number.isInteger alone would
// have let through.
function normalizeSportmonksStatus(stateId) {
  if (typeof stateId !== "number" || !Number.isSafeInteger(stateId)) return "unknown";
  return SPORTMONKS_STATE_TO_STATUS.get(stateId) || "unknown";
}

// ---- Sportmonks leg parsing -------------------------------------------------
//
// The ONLY place that knows Sportmonks encodes a two-legged tie as "N/M".
// Parses into the QRACKS-owned { number, total } shape and lets
// domain.normalizeLeg() be the single authority on whether the result is
// legal -- malformed strings, "0/2", "3/2" (number > total), and anything
// that isn't exactly two positive integers separated by "/" all become null.
const LEG_RAW_PATTERN = /^(\d+)\/(\d+)$/;
function parseSportmonksLeg(raw) {
  if (typeof raw !== "string") return null;
  const m = LEG_RAW_PATTERN.exec(raw.trim());
  if (!m) return null;
  return domain.normalizeLeg({ number: Number(m[1]), total: Number(m[2]) });
}

// ---- Duplicate policy at the Adapter/Domain frontier ----------------------
//
// A stable domain id is NOT enough on its own: two provider records sharing an
// id previously produced TWO domain entities with the SAME id, pushing the
// problem onto product code. The frontier now resolves it, explicitly:
//
//   identical duplicates  -> ONE entity, counted as a duplicate
//   conflicting duplicates -> NO entity at all, counted as a conflict
//
// Conflicts drop BOTH records deliberately. Keeping either would be a silent
// first-wins/last-wins, and when two records contradict each other about the
// same identity there is no evidence for choosing one. Dropping and reporting
// is fail-safe and observable — the same posture as skippedFixtures and as
// AUTO-004's "observe, never silently swallow".
//
// Under NO circumstance may the returned collection contain two entities with
// the same domain id.

function normalizeForCompare(v) {
  if (v == null) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Fields that make two records with the same id genuinely contradictory.
// Chosen because each one changes what the event IS, not merely how it is
// described: which stage/round/tie it belongs to, when it is played, and
// who plays it. `leg` and `state_id` are deliberately NOT in this raw list:
// they are compared via their NORMALIZED QRACKS semantics below, so two raw
// codes that mean the same thing (e.g. two state_ids that both normalize to
// "finished") are a duplicate, not a manufactured conflict -- while two
// records whose normalized status or leg genuinely differ still conflict.
const EVENT_CONFLICT_FIELDS = ["stage_id", "round_id", "aggregate_id", "starting_at"];
const STAGE_CONFLICT_FIELDS = ["name", "sort_order", "starting_at", "ending_at", "finished", "is_current"];

// Signs the NORMALIZED QRACKS semantics of each participant, not the raw
// provider fields. Reuses mapParticipants() + domain.makeCompetitor() --
// the exact same functions toEvents() uses to build the real Event -- so
// there is exactly one rule for "what a participant means", never two
// parallel ones that can drift apart. This is what makes
// providerCompetitorId: true vs false (both -> null) or
// meta.location: "left" vs "right" (both -> role: null) collapse to the
// same signature entry instead of manufacturing a conflict over raw
// differences that produce an IDENTICAL Domain Competitor. name is
// deliberately excluded: it is cosmetic, never material to identity.
function participantSignature(fx) {
  return JSON.stringify(
    mapParticipants(fx)
      .map((p) => {
        const c = domain.makeCompetitor(p);
        return `${c.providerCompetitorId}|${c.role}`;
      })
      .sort()
  );
}

// The leg dimension of the signature, in normalized form: two equal-but-
// differently-spelled raw values collapse to the same signature entry, and
// two genuinely different legs (e.g. "1/2" vs "2/2") never do.
function legSignatureOf(fx) {
  const leg = parseSportmonksLeg(fx.leg);
  return leg ? `${leg.number}/${leg.total}` : null;
}

function eventSignature(fx) {
  return JSON.stringify([
    ...EVENT_CONFLICT_FIELDS.map((f) => normalizeForCompare(fx[f])),
    legSignatureOf(fx),
    normalizeSportmonksStatus(fx.state_id),
    participantSignature(fx),
  ]);
}

function stageSignature(st) {
  return JSON.stringify(STAGE_CONFLICT_FIELDS.map((f) => normalizeForCompare(st[f])));
}

// Groups records by their provider id and applies the policy above.
// Returns { unique, duplicates, conflicts } where `conflicts` is the list of
// provider ids that were dropped for contradicting themselves.
function dedupeByProviderId(records, signatureOf) {
  const groups = new Map();
  for (const rec of records) {
    const key = String(rec.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const unique = [];
  const conflicts = [];
  let duplicates = 0;
  for (const [key, group] of groups) {
    if (group.length === 1) { unique.push(group[0]); continue; }
    const signatures = new Set(group.map(signatureOf));
    if (signatures.size === 1) {
      unique.push(group[0]);          // identical: keep one
      duplicates += group.length - 1; // and report the rest
    } else {
      conflicts.push(key);            // contradictory: keep NONE
    }
  }
  return { unique, duplicates, conflicts };
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
  // Same rule as toStages: an unusable stage never contributes to instance
  // grouping or to the instance's date span.
  const list = dedupeByProviderId(
    (Array.isArray(stages) ? stages : []).filter((st) => st && domain.isUsableProviderId(st.id)),
    stageSignature
  ).unique;
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
  // A stage with no usable id cannot be given a stable domain identity, and
  // minting one anyway would make every malformed stage collide. Skipped
  // rather than fabricated -- and never silently: skippedStages is reported
  // by the payload normalizers below.
  const list = dedupeByProviderId(
    (Array.isArray(stages) ? stages : []).filter((st) => st && domain.isUsableProviderId(st.id)),
    stageSignature
  ).unique;
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
//
// STATUS: fx.state_id is mapped through normalizeSportmonksStatus() (Sportmonks'
// own documented states reference, see the mapping table above) into the
// QRACKS-owned vocabulary; an unrecognized or missing code safely degrades to
// "unknown" rather than being guessed at. LEG: fx.leg's raw "N/M" string is
// parsed by parseSportmonksLeg() into the QRACKS-owned { number, total }
// shape; malformed input safely degrades to null. Both raw values are kept
// in providerRaw for diagnostics only -- neither escapes into Event.status /
// Event.leg unnormalized.
function toEvents({ fixtures, stages }) {
  const list = dedupeByProviderId(
    (Array.isArray(fixtures) ? fixtures : []).filter((fx) => fx && domain.isUsableProviderId(fx.id)),
    eventSignature
  ).unique;
  const stageById = new Map((stages || []).map((s) => [s.providerStageId, s]));
  return list.map((fx) => {
    const st = fx.stage_id != null ? stageById.get(String(fx.stage_id)) : null;
    return domain.makeEvent({
      provider: KEY,
      providerEventId: fx.id,
      instanceId: st ? st.instanceId : null,
      stageId: st ? st.id : null,
      providerRoundId: fx.round_id == null ? null : fx.round_id,
      leg: parseSportmonksLeg(fx.leg),
      aggregateKey: fx.aggregate_id == null ? null : fx.aggregate_id,
      startsAt: fx.starting_at || null,
      status: normalizeSportmonksStatus(fx.state_id),
      competitors: mapParticipants(fx),
      score: null,
      providerRaw: {
        stage_id: fx.stage_id ?? null, round_id: fx.round_id ?? null, leg: fx.leg ?? null,
        state_id: fx.state_id ?? null,
      },
    });
  });
}

// ---- Client -> Adapter boundary -------------------------------------------
//
// The Sportmonks client returns the provider's own nested envelope: a season
// object with `stages` inside it, and a stage object with `fixtures` inside
// it. These two functions are the ONLY place that knows that shape. Product
// code receives domain entities and never touches `.stages` or `.fixtures`.
//
// Both report what they skipped, so a malformed payload degrades visibly
// instead of silently producing fewer entities than the provider sent.

function fromSeasonPayload(seasonData, { competitionId, providerCompetitionId }) {
  const data = seasonData && typeof seasonData === "object" && !Array.isArray(seasonData) ? seasonData : {};

  // SEASON ID TRUST. A CompetitionInstance built from a Sportmonks payload is
  // provider-backed BY DEFINITION -- callers read providerSeasonId as "this is
  // really season N over there". If season.id is missing/invalid we cannot
  // honour that, and falling back to instanceKey alone would mint an entity
  // that LOOKS provider-backed while being anchored to nothing. Refusing is
  // fail-safe: the caller sees a real error instead of a plausible-looking
  // fiction, and no season id is ever invented.
  if (!domain.isUsableProviderId(data.id)) {
    throw new Error(
      "fromSeasonPayload: Sportmonks season payload has no usable `id` — refusing to build a CompetitionInstance that would appear provider-backed without a real season"
    );
  }

  const rawStages = Array.isArray(data.stages) ? data.stages : [];
  const wellFormed = rawStages.filter((st) => st && domain.isUsableProviderId(st.id));
  const skippedStages = rawStages.length - wellFormed.length;
  const { unique, duplicates, conflicts } = dedupeByProviderId(wellFormed, stageSignature);

  const season = {
    id: data.id, name: data.name,
    finished: data.finished, starting_at: data.starting_at, ending_at: data.ending_at,
  };
  const instances = toCompetitionInstances({ season, stages: unique, competitionId, providerCompetitionId });
  const stages = toStages({ stages: unique, instances, providerCompetitionId });
  return {
    season, instances, stages,
    skippedStages,
    duplicateStages: duplicates,
    conflictingStages: conflicts,
  };
}

function fromStagePayload(stageData, { stages }) {
  const data = stageData && typeof stageData === "object" && !Array.isArray(stageData) ? stageData : {};
  const rawFixtures = Array.isArray(data.fixtures) ? data.fixtures : [];
  const wellFormed = rawFixtures.filter((fx) => fx && domain.isUsableProviderId(fx.id));
  const skippedFixtures = rawFixtures.length - wellFormed.length;
  const { unique, duplicates, conflicts } = dedupeByProviderId(wellFormed, eventSignature);
  const events = toEvents({ fixtures: unique, stages });
  return {
    events,
    skippedFixtures,
    duplicateFixtures: duplicates,
    conflictingFixtures: conflicts,
  };
}

module.exports = {
  key: KEY,
  fromSeasonPayload,
  fromStagePayload,
  capabilities: Object.freeze([
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
  normalizeSportmonksStatus,
  parseSportmonksLeg,
};
