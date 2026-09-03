// planLimits.js — MON-001B: corrected commercial architecture.
//
// This REPLACES the MON-001A version, which shipped with a wrong
// commercial model (FREE_TRIAL, hardcoded FREE=5/20 and PLUS=9999/9999,
// fail-OPEN on unknown/corrupt data). None of that is preserved here.
//
// Deliberately separate from server.js (same documented limitation as
// competitionSync.js/autoResults.js/sportsDataHealth.js: can't be
// require()'d in tests without a live Postgres connection) — pure, no
// I/O, no mutation of inputs, fully deterministic and testable without a
// database or a live clock.
//
// ==========================================================================
// THE TWO DIMENSIONS — kept structurally separate throughout this file,
// never conflated into one number:
//
//   PLAN / CAPACITY  — how many PEOPLE can be registered right now. A live
//                       count: participants.length vs entitlement.participantLimit.
//                       Removing a participant genuinely frees a slot.
//
//   LIFECYCLE        — how much TIME/USE a quiniela gets, expressed (when
//                       there's no league) as a durable, monotonically
//                       increasing count of rounds ever published. Deleting
//                       a round does NOT return lifecycle budget — the
//                       counter lives in platform_index (owner-writable
//                       meta can never touch it), not in meta.rounds.length.
//                       When there IS a league, lifecycle is meant to track
//                       the tournament/season itself (see competitionIdentity
//                       below) rather than a round count — enforcement of
//                       THAT is explicitly NOT implemented yet (see the
//                       OPEN DECISION comment on computeCompetitionIdentity).
// ==========================================================================

// ---- Commercial config: the DYNAMIC, server-side SSOT ------------------
//
// These are only the SEED/DEFAULT values, used exactly once when the
// commercial_config row doesn't exist yet (fresh install / first boot
// after this ships). Once seeded, the row in Postgres is the live
// authority — Panel Plataforma edits it there, and every enforcement
// decision reads the CURRENT row, never these constants directly. This
// is what makes "$199 -> $299", "10 -> 12 participantes", etc. a config
// change instead of a deploy.
const DEFAULT_COMMERCIAL_CONFIG = Object.freeze({
  version: 1,
  updatedAt: null,
  updatedBy: "system_default",
  // MON-002B: how an organizer actually reaches QRACKS to get Plus turned
  // on. It lives in the config, not in the copy, because until MON-003 ships
  // a real checkout this IS the mechanism, and the paywall must state it
  // honestly rather than show a button that pretends to charge a card.
  // Empty means the paywall falls back to a generic sentence.
  upgradeContact: "",
  free: Object.freeze({ participantLimit: 10, manualRoundLimit: 7 }),
  plus: Object.freeze({ participantLimit: 50, manualRoundLimit: 18, priceMXN: 199 }),
});

// Validates the invariants a commercial_config write must satisfy before
// it's accepted — called by server.js before persisting an edit from
// Panel Plataforma, so an admin fat-fingering "0" or a negative number,
// or setting Plus below Free, can never corrupt the SSOT every
// enforcement decision depends on.
function isCommercialConfigValid(config) {
  if (!config || typeof config !== "object") return false;
  const f = config.free, p = config.plus;
  if (!f || !p) return false;
  if (!Number.isFinite(f.participantLimit) || f.participantLimit < 1) return false;
  if (!Number.isFinite(f.manualRoundLimit) || f.manualRoundLimit < 1) return false;
  if (!Number.isFinite(p.participantLimit) || p.participantLimit < f.participantLimit) return false;
  if (!Number.isFinite(p.manualRoundLimit) || p.manualRoundLimit < f.manualRoundLimit) return false;
  if (!Number.isFinite(p.priceMXN) || p.priceMXN < 0) return false;
  if (config.upgradeContact !== undefined && config.upgradeContact !== null) {
    if (typeof config.upgradeContact !== "string" || config.upgradeContact.length > 200) return false;
  }
  return true;
}

// ---- Competition identity (with-league lifecycle) -----------------------
//
// OPEN DECISION, documented explicitly rather than silently assumed:
// sportsdbSeason (see seasonDefaults.js) is a single calendar-year string
// like "2026-2027" covering the WHOLE football year. For a split-format
// league (Liga MX's Apertura Jul-Dec / Clausura Jan-Jun is the concrete
// example already in this codebase), Apertura 2026 and Clausura 2027
// BOTH fall inside the same "2026-2027" season string — so
// leagueId+season alone can NOT reliably distinguish them. This function
// returns the best available identity today (leagueId:season) and this
// comment is the flag: treat any enforcement that depends on this being
// a unique per-tournament identity as provisional until a real
// tournament/stage identifier is confirmed available from the provider
// (or a product decision picks a different signal).
function computeCompetitionIdentity(settings) {
  const leagueId = settings && settings.sportsdbLeagueId;
  const season = settings && settings.sportsdbSeason;
  if (!leagueId) return null;
  return `${leagueId}:${season || "unknown-season"}`;
}

// ---- Entitlement snapshots ------------------------------------------------
//
// An entitlement is a FROZEN snapshot of what a specific quiniela is
// entitled to, taken at a specific moment for a specific reason. It is
// NEVER recomputed from the live commercial_config after being granted —
// that's the whole point: changing commercial_config tomorrow must never
// silently change what a quiniela that already has an entitlement gets.
// configVersionAtGrant records which config version produced these
// numbers, purely for audit/debugging — it is never re-read at
// enforcement time.

// A brand-new quiniela's default entitlement: FREE. Deliberately does
// NOT snapshot participantLimit/manualRoundLimit -- per the approved
// product decision, FREE is a free product that always tracks whatever
// commercial_config says FREE means RIGHT NOW (see resolveEnforcementLimits
// below), not a frozen grant. Keeping stale numbers here that are never
// actually used for enforcement would be actively misleading to anyone
// reading this object later, so they're simply absent. configVersionAtGrant
// is kept purely as historical/informational context ("this is what was
// live when the quiniela signed up"), never re-read for enforcement.
function buildFreeEntitlement(config, nowIso) {
  return {
    plan: "FREE",
    source: "signup_default",
    grantedAt: nowIso || new Date().toISOString(),
    grantedBy: "system",
    reason: null,
    configVersionAtGrant: config.version,
    competitionIdentity: null, // set later, if/when a league gets selected — see server.js wiring
    revoked: false,
  };
}

// A PLUS purchase's entitlement snapshot (the numbers this specific
// quiniela paid for, frozen — see the module header comment on why this
// must never silently track a later commercial_config change).
function buildPlusEntitlement(config, nowIso, opts) {
  const o = opts || {};
  return {
    plan: "PLUS",
    participantLimit: config.plus.participantLimit,
    manualRoundLimit: config.plus.manualRoundLimit,
    pricePaidMXN: config.plus.priceMXN,
    source: o.source || "purchase",
    grantedAt: nowIso || new Date().toISOString(),
    grantedBy: o.grantedBy || "system",
    reason: o.reason || null,
    configVersionAtGrant: config.version,
    competitionIdentity: o.competitionIdentity || null,
    revoked: false,
  };
}

// A quiniela that existed before this ticket shipped. Deliberately NOT
// "no entitlement at all" (that was MON-001A's mistake — see the fail-
// closed section below for why absence must never mean unlimited).
// Deliberately NOT a bare-infinity sentinel either — an explicit,
// auditable, very generous numeric ceiling, consistent with this
// project's established "PLUS is a real number, not a magic unlimited
// code path" philosophy. Grandfathered quinielas keep exactly the
// experience they already had (which had no real enforcement at all) —
// this just makes that an explicit, visible, auditable fact instead of
// an accidental side effect of missing data.
const GRANDFATHER_CEILING = Object.freeze({ participantLimit: 100000, manualRoundLimit: 100000 });
function buildGrandfatheredEntitlement(nowIso, opts) {
  const o = opts || {};
  return {
    plan: "GRANDFATHERED",
    participantLimit: GRANDFATHER_CEILING.participantLimit,
    manualRoundLimit: GRANDFATHER_CEILING.manualRoundLimit,
    source: o.source || "grandfather_migration",
    grantedAt: nowIso || new Date().toISOString(),
    grantedBy: "migration",
    reason: o.reason || "Existed before commercial enforcement shipped — preserved as-is.",
    configVersionAtGrant: null,
    competitionIdentity: null,
    revoked: false,
  };
}

// A platform operator's manual grant/override (support, testing,
// friends, promotions) — replaces MON-001A's bare `exempt:true` boolean.
// Every field the ticket asked for an audit trail to contain lives
// directly on the entitlement object itself: what was granted (plan/
// limits), when, by whom, why, and — via `revoked`/`revokedAt`/
// `revokedBy` — whether/when it was taken back. server.js additionally
// appends every grant/revoke to entry.entitlementHistory (see server.js
// wiring) so the FULL sequence of an entitlement's life is reconstructable,
// not just its current state.
function buildManualGrantEntitlement(nowIso, opts) {
  const o = opts || {};
  return {
    plan: "MANUAL_GRANT",
    participantLimit: o.participantLimit,
    manualRoundLimit: o.manualRoundLimit,
    source: "manual_grant",
    grantedAt: nowIso || new Date().toISOString(),
    grantedBy: o.grantedBy, // e.g. "platform:<identifier>" — required, never defaulted silently
    reason: o.reason || null,
    configVersionAtGrant: null,
    competitionIdentity: null,
    revoked: false,
  };
}

// ---- Enforcement checks ---------------------------------------------------
//
// FAIL-CLOSED, unlike MON-001A: a missing/invalid entitlement NEVER
// grants capacity. This is safe in practice because server.js's startup
// migration guarantees every platform_index row has an entitlement
// before enforcement code can ever run against it (see server.js) — so
// "missing entitlement" should be structurally impossible in normal
// operation. If it somehow still happens (a bug, a row created through
// an unexpected path), the correct behavior for a commercial system is
// to deny NEW consumption, not to silently allow it — and to make the
// anomaly loud (server.js logs it), never silent.

function isKnownPlan(plan) {
  return plan === "FREE" || plan === "PLUS" || plan === "GRANDFATHERED" || plan === "MANUAL_GRANT";
}

// MON-002B. FREE is the one plan whose round budget is NOT lifted by having
// a tournament: it is a free product with a fixed allowance, and a league
// selection must never quietly turn it into an unlimited one (that was the
// commercial hole MON-002A found). Every other known plan was either paid
// for, granted by an operator, or predates enforcement entirely, and all
// three legitimately mean "this quiniela's tournament is covered".
// Written as an explicit FREE test rather than a whitelist so an unknown
// plan can never fall into the unlimited branch — isKnownPlan already
// fails those closed before this is ever reached.
function grantsFullCompetition(entitlement) {
  return !!entitlement && entitlement.plan !== "FREE";
}

// MON-001C: the approved FREE-vs-PLUS split. FREE is a free product that
// always tracks the CURRENT commercial_config — a platform-wide config
// change (10 -> 12 participants) applies to every existing FREE quiniela
// immediately, with zero migration, zero re-grant, zero snapshot to go
// stale. PLUS (and GRANDFATHERED/MANUAL_GRANT, which have their own
// explicit, deliberately-frozen semantics already) use the entitlement's
// OWN numbers, captured at grant time — a later commercial_config change
// must never retroactively alter what was already purchased/granted.
// Returns null (never guesses/defaults) if the entitlement or the
// relevant config section is missing/invalid — callers treat null as
// fail-closed, same as any other entitlement_unavailable case.
function resolveEnforcementLimits(entitlement, commercialConfig) {
  if (!entitlement || !isKnownPlan(entitlement.plan)) return null;
  if (entitlement.plan === "FREE") {
    if (!commercialConfig || !commercialConfig.free
      || !Number.isFinite(commercialConfig.free.participantLimit)
      || !Number.isFinite(commercialConfig.free.manualRoundLimit)) {
      return null;
    }
    return { participantLimit: commercialConfig.free.participantLimit, manualRoundLimit: commercialConfig.free.manualRoundLimit };
  }
  if (!Number.isFinite(entitlement.participantLimit) || !Number.isFinite(entitlement.manualRoundLimit)) return null;
  return { participantLimit: entitlement.participantLimit, manualRoundLimit: entitlement.manualRoundLimit };
}

// currentCount = participants.length BEFORE this write; additionalCount =
// how many NEW participants this write would add (usually 1, but bulk-add
// can genuinely add several at once — and a maliciously crafted payload
// could claim to add many in a single call, so this must handle N, not
// just assume 1). A live check — removing a participant later genuinely
// frees a slot for someone new.
function checkParticipantCapacity(entitlement, commercialConfig, currentCount, additionalCount) {
  const add = Number.isFinite(additionalCount) ? additionalCount : 1;
  if (add <= 0) return { allowed: true }; // no new capacity requested -- never block, even if currentCount already exceeds the limit (e.g. a later-reduced config, or a grandfathered/legacy quiniela)
  if (!entitlement || entitlement.revoked) {
    return { allowed: false, reason: "entitlement_unavailable", plan: entitlement && entitlement.plan };
  }
  const limits = resolveEnforcementLimits(entitlement, commercialConfig);
  if (!limits) {
    return { allowed: false, reason: "entitlement_unavailable", plan: entitlement.plan };
  }
  if (currentCount + add > limits.participantLimit) {
    return { allowed: false, reason: "plan_participant_limit_reached", plan: entitlement.plan, limit: limits.participantLimit };
  }
  return { allowed: true };
}

// consumedCount = the DURABLE count of rounds this quiniela has EVER
// published (platform_index's lifecycleRoundsConsumed in server.js —
// never meta.rounds.length, which deleting a round can reduce).
// additionalCount = how many NEWLY-published round IDs this write
// introduces (normally 1, but see the participant note above — a single
// write could claim several at once, whether legitimately or as an
// attempted bypass, and both must be evaluated against the total, not
// checked one at a time as if each were independently a "+1"). Only
// meaningful when entitlement.competitionIdentity is null (no league) —
// see the OPEN DECISION above for why with-league lifecycle isn't
// enforced by round count at all yet.
function checkLifecycleRoundConsumption(entitlement, commercialConfig, consumedCount, additionalCount) {
  const add = Number.isFinite(additionalCount) ? additionalCount : 1;
  if (add <= 0) return { allowed: true }; // no new consumption requested -- never block
  if (!entitlement || entitlement.revoked) {
    return { allowed: false, reason: "entitlement_unavailable", plan: entitlement && entitlement.plan };
  }
  if (entitlement.competitionIdentity && grantsFullCompetition(entitlement)) {
    // MON-002B: "Plus = 50 personas + torneo completo si existe". A paid/
    // granted plan bound to a tournament gets that whole tournament, so a
    // round count is not the thing being limited — the BINDING is (see
    // evaluateCompetitionBinding: it can only ever play the one tournament
    // it is bound to). FREE deliberately does NOT get this: a free quiniela
    // may IMPORT a full calendar, but it still only gets to publish
    // manualRoundLimit of those rounds, which is what makes "Gratis = 10
    // personas + 7 jornadas" true whether or not a league was picked.
    //
    // Still open, and deliberately NOT decided here (MON-002C): what
    // happens when that tournament ENDS — renewal, and whether
    // leagueId:season is a precise enough tournament identity for split
    // formats (see computeCompetitionIdentity's OPEN DECISION above).
    return { allowed: true };
  }
  const limits = resolveEnforcementLimits(entitlement, commercialConfig);
  if (!limits) {
    return { allowed: false, reason: "entitlement_unavailable", plan: entitlement.plan };
  }
  if (consumedCount + add > limits.manualRoundLimit) {
    return { allowed: false, reason: "plan_lifecycle_limit_reached", plan: entitlement.plan, limit: limits.manualRoundLimit };
  }
  return { allowed: true };
}

// ---- Competition binding (MON-001D) --------------------------------------
//
// A quiniela with a league is commercially bound to ONE tournament. Once
// bound, importing/publishing rounds that belong to a DIFFERENT tournament
// must be impossible — that's what stops one quiniela (and one Plus
// purchase) from being reused season after season.
//
// The binding lives on the entitlement (platform_index, platform-tier
// key) — NOT in meta.settings, which the quiniela owner can write. The
// owner CAN still edit meta.settings.sportsdbSeason/sportsdbLeagueId
// (subject to MON-001C's league-change block on the meta-write path), but
// doing so can never move the binding itself; this function is what makes
// a mismatch fail loudly instead of silently importing another tournament.
//
// Returns:
//   { violation: false, adopt: true }  -- not yet bound, this identity
//                                         should be adopted now
//   { violation: false, adopt: false } -- already bound to exactly this
//                                         identity, proceed normally
//   { violation: true, ... }           -- bound to a DIFFERENT tournament
//   { violation: true, reason: "competition_identity_unavailable" }
//                                      -- requested identity couldn't be
//                                         determined at all; never adopt
//                                         or proceed on a guess
function evaluateCompetitionBinding(entitlement, requestedIdentity) {
  if (!entitlement) {
    return { violation: true, reason: "entitlement_unavailable" };
  }
  const bound = entitlement.competitionIdentity || null;
  if (!requestedIdentity) {
    // An ambiguous/undeterminable competition must never extend a
    // quiniela's commercial life: if it's already bound, an unreadable
    // request identity can't be proven to match, so it's refused; if it's
    // not bound yet, there's nothing safe to adopt either.
    return { violation: true, reason: "competition_identity_unavailable", boundIdentity: bound };
  }
  if (!bound) return { violation: false, adopt: true, identity: requestedIdentity };
  if (bound === requestedIdentity) return { violation: false, adopt: false, identity: bound };
  return { violation: true, reason: "competition_mismatch", boundIdentity: bound, requestedIdentity };
}

// ---- What the Admin is allowed to SEE (MON-002B) --------------------------
//
// The plan screen, the warnings and the hard paywall are all rendered from
// this one object. It lives here, next to the rules it describes, so the
// browser never has to know what FREE means, what PLUS costs, or when a
// round limit applies — it only paints what it is handed. That is the whole
// point: MON-002A found a frontend paywall that had drifted to a different
// threshold AND a different price than the backend was actually enforcing,
// because both sides owned a copy of the rule.

const PLAN_LABELS = Object.freeze({
  FREE: "Gratis",
  PLUS: "Plus",
  GRANDFATHERED: "Sin límite",
  MANUAL_GRANT: "Especial",
});

// `available: false` carries no price and no capabilities at all — an offer
// that cannot be taken must not leave numbers lying around for a screen to
// render by accident.
function buildUpgradeOffer(entitlement, commercialConfig) {
  if (!entitlement || entitlement.plan !== "FREE") return { available: false };
  const plus = commercialConfig && commercialConfig.plus;
  if (!plus || !Number.isFinite(plus.priceMXN)
    || !Number.isFinite(plus.participantLimit) || !Number.isFinite(plus.manualRoundLimit)) {
    return { available: false };
  }
  return {
    available: true,
    priceMXN: plus.priceMXN,
    participantLimit: plus.participantLimit,
    roundLimit: plus.manualRoundLimit,
    // Whatever the operator configured, or "" — the screen decides which
    // sentence to write, but never invents a channel that does not exist.
    contact: typeof commercialConfig.upgradeContact === "string" ? commercialConfig.upgradeContact : "",
    // Scope is copy with a commercial promise in it, so it is written once,
    // here, rather than in whichever screen happens to show the offer.
    scope: entitlement.competitionIdentity
      ? "Aplica a esta quiniela para el torneo que ya está jugando."
      : "Aplica solo a esta quiniela.",
  };
}

// The complete plan picture for one quiniela. `usage` is measured by the
// caller from the rows it already read under lock (participants.length and
// the durable lifecycle counter) — this function never guesses either.
function summarizePlan(entitlement, commercialConfig, usage) {
  const u = usage || {};
  const participantsUsed = Number.isFinite(u.participantsUsed) ? u.participantsUsed : 0;
  const roundsUsed = Number.isFinite(u.roundsUsed) ? u.roundsUsed : 0;
  const limits = resolveEnforcementLimits(entitlement, commercialConfig);
  const plan = entitlement && isKnownPlan(entitlement.plan) ? entitlement.plan : null;
  const bound = !!(entitlement && entitlement.competitionIdentity);
  // The round budget stops applying exactly where enforcement stops applying
  // — same condition, one source (see checkLifecycleRoundConsumption).
  const roundsApply = !(bound && grantsFullCompetition(entitlement));

  // Fail-closed and SAY so, rather than inventing numbers to fill a screen.
  if (!plan || !limits || (entitlement && entitlement.revoked)) {
    return {
      plan: plan,
      planLabel: plan ? PLAN_LABELS[plan] : null,
      available: false,
      participants: null,
      rounds: null,
      competition: { bound, label: u.competitionLabel || null },
      upgrade: { available: false },
    };
  }

  const remaining = (limit, used) => Math.max(0, limit - used);
  return {
    plan,
    planLabel: PLAN_LABELS[plan],
    available: true,
    participants: {
      used: participantsUsed,
      limit: limits.participantLimit,
      remaining: remaining(limits.participantLimit, participantsUsed),
    },
    rounds: roundsApply
      ? { used: roundsUsed, limit: limits.manualRoundLimit, remaining: remaining(limits.manualRoundLimit, roundsUsed), applies: true }
      : { used: roundsUsed, limit: null, remaining: null, applies: false },
    competition: { bound, label: u.competitionLabel || null },
    upgrade: buildUpgradeOffer(entitlement, commercialConfig),
  };
}

// ---- Operator grants (MON-002B) ------------------------------------------
//
// A PLUS grant takes its numbers and its price from commercial_config, never
// from the request — that is what stops a crafted call from minting a
// 500-participant "PLUS" for $0. A MANUAL_GRANT is the deliberate exception
// (support, testing, promotions) and IS allowed to name its own numbers, so
// those numbers are the ones that need validating: safe integers, at least
// 1, and never above the grandfather ceiling this codebase already treats as
// its explicit "as good as unlimited" number.
function isValidManualGrantLimits(participantLimit, manualRoundLimit) {
  const ok = (n) => Number.isSafeInteger(n) && n >= 1;
  if (!ok(participantLimit) || !ok(manualRoundLimit)) return false;
  if (participantLimit > GRANDFATHER_CEILING.participantLimit) return false;
  if (manualRoundLimit > GRANDFATHER_CEILING.manualRoundLimit) return false;
  return true;
}

module.exports = {
  DEFAULT_COMMERCIAL_CONFIG,
  GRANDFATHER_CEILING,
  isCommercialConfigValid,
  computeCompetitionIdentity,
  evaluateCompetitionBinding,
  buildFreeEntitlement,
  buildPlusEntitlement,
  buildGrandfatheredEntitlement,
  buildManualGrantEntitlement,
  isKnownPlan,
  resolveEnforcementLimits,
  checkParticipantCapacity,
  checkLifecycleRoundConsumption,
  grantsFullCompetition,
  buildUpgradeOffer,
  summarizePlan,
  isValidManualGrantLimits,
  PLAN_LABELS,
};
