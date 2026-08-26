// planLimits.js — MON-001A: real, server-enforced plan limits.
//
// Deliberately separate from server.js (same documented limitation as
// competitionSync.js/autoResults.js/sportsDataHealth.js/seasonDefaults.js:
// can't be require()'d in tests without a live Postgres connection) — this
// is the one place that decides which plan is EFFECTIVELY in force right
// now and whether a given round-publish or participant-add should be
// allowed, which is what makes the CASE-by-CASE enforcement behavior
// (trial expiring mid-session, legacy quinielas, unknown/corrupt plan
// values, etc.) testable in isolation, deterministically, without a
// database or a live clock.
//
// Everything here is pure: no I/O, no mutation of its inputs.

// ---- Plan catalog ------------------------------------------------------
//
// These numbers are a proposed starting point for review, not a final
// pricing decision -- documented explicitly as such per the ticket's own
// instruction not to silently invent final business numbers. They are
// intentionally centralized here as named constants (never inlined at
// each call site) so a future pricing change is a one-line edit, not a
// grep-and-replace across server.js.
//
// FREE: mirrors the CURRENT global default (jornadaLimit: 5 in
// platform_settings) that the legacy system has used until now, so a
// brand-new Free quiniela sees limits it would already have been
// familiar with under the old (unenforced) system. maxParticipants is a
// new cap that did not exist at all before this ticket -- chosen as a
// generous number for a small office/friends pool (proposed, not final).
//
// PLUS: not a bare "unlimited" (no limit fields at all) -- a very high
// numeric ceiling instead. This is a deliberate choice: an explicit
// number is auditable, testable, and gives a real (if extremely
// generous) backstop against a runaway bug or genuine abuse, whereas
// "no limit at all" is a single code path that, if ever miswired, has no
// safety net. Effectively unlimited for any real usage QRACKS supports
// today.
//
// FREE_TRIAL: "temporal, todo abierto" -- generous like PLUS while the
// trial is active, automatically becomes equivalent to FREE once the
// trial window elapses (computed at read/enforcement time below, never
// via a background job -- consistent with this project's standing rule
// of no schedulers/cron). The STORED plan value on platform_index never
// changes itself when a trial expires; only the EFFECTIVE limits used
// for enforcement do. An explicit plan change (FREE_TRIAL -> FREE or
// FREE_TRIAL -> PLUS) is always a deliberate platform action, never
// silently auto-applied to the stored record.
const FREE_TRIAL_DAYS = 14; // proposed, not final -- see comment above

const PLAN_LIMITS = Object.freeze({
  FREE: Object.freeze({ maxPublishedRounds: 5, maxParticipants: 20 }),
  PLUS: Object.freeze({ maxPublishedRounds: 9999, maxParticipants: 9999 }),
});

// The 3 named plans a platform operator can explicitly assign. Any other
// stored value (including entirely absent -- a legacy quiniela created
// before this ticket) is handled by getEffectivePlan below, never treated
// as one of these three.
const KNOWN_PLANS = Object.freeze(["FREE_TRIAL", "FREE", "PLUS"]);

// ---- Effective plan resolution -----------------------------------------
//
// `entry` is the platform_index.quinielas[] row for one quiniela (never
// the quiniela's own meta -- the plan is intentionally NOT trusted from
// anything the quiniela owner can write, see server.js's classifyKey():
// platform_index is a "platform"-tier key, writable only with the
// platform password).
//
// Returns { effectivePlan, limits, isLegacy, isTrialExpired }.
//   limits === null means "no cap enforced" (legacy quinielas created
//   before this ticket, and any unrecognized/corrupt plan value --
//   see the reasoning below for why unrecognized values fail OPEN, not
//   closed).
function getEffectivePlan(entry, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const rawPlan = entry && entry.plan;

  // Legacy: a quiniela created before this ticket shipped, or any
  // platform_index row that was never explicitly given a plan. These
  // were running under the OLD system, which had a global default limit
  // that was never actually enforced server-side (see MON-001's own
  // investigation report) -- some of them may already have MORE
  // published rounds or participants than any new plan's limits allow.
  // Silently reclassifying them into a hard-capped tier the moment this
  // ships would retroactively break already-working, already-paid-for
  // (informally) quinielas with zero admin action on their part -- an
  // unacceptable regression for a live product with real users. They
  // stay unlimited (exactly matching today's real, if accidental,
  // behavior) until a platform operator explicitly assigns them a real
  // plan via the dashboard -- a deliberate, visible, reviewable action.
  if (!rawPlan) {
    return { effectivePlan: "LEGACY_UNLIMITED", limits: null, isLegacy: true, isTrialExpired: false };
  }

  if (rawPlan === "FREE") {
    return { effectivePlan: "FREE", limits: PLAN_LIMITS.FREE, isLegacy: false, isTrialExpired: false };
  }
  if (rawPlan === "PLUS") {
    return { effectivePlan: "PLUS", limits: PLAN_LIMITS.PLUS, isLegacy: false, isTrialExpired: false };
  }
  if (rawPlan === "FREE_TRIAL") {
    const setAtMs = entry.planSetAt ? new Date(entry.planSetAt).getTime() : NaN;
    // Missing/unparseable planSetAt on a FREE_TRIAL row should never
    // happen (creation always sets both together), but if it somehow
    // does, treat the trial as NOT yet expired rather than guessing --
    // punishing an admin with a hard block over a data anomaly that
    // isn't their fault is worse than being briefly too generous.
    const trialExpired = Number.isFinite(setAtMs) && (now - setAtMs) > FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000;
    if (trialExpired) {
      // The STORED plan is still "FREE_TRIAL" -- only what gets enforced
      // changes. A platform operator can later look at this same entry
      // and see it's still nominally a trial that lapsed, versus a
      // quiniela someone deliberately downgraded.
      return { effectivePlan: "FREE_TRIAL", limits: PLAN_LIMITS.FREE, isLegacy: false, isTrialExpired: true };
    }
    return { effectivePlan: "FREE_TRIAL", limits: null, isLegacy: false, isTrialExpired: false };
  }

  // An entirely unrecognized plan string (a typo, a future value this
  // deployed code doesn't know about yet, manual DB corruption, etc.).
  // Fails OPEN (unlimited), not closed -- the same reasoning as the
  // missing-planSetAt case above: a data anomaly should never silently
  // lock a real admin out of publishing a jornada. The caller is
  // expected to log this loudly (see server.js's wiring) so it gets
  // noticed and fixed, exactly like AUTO-004's Sports Data Reliability
  // work already established the pattern of "observe, never silently
  // swallow."
  return { effectivePlan: "LEGACY_UNLIMITED", limits: null, isLegacy: false, isTrialExpired: false };
}

// ---- Enforcement checks -------------------------------------------------
//
// Both of the following are pure, symmetric checks: they only ever
// BLOCK an INCREASE that would cross the limit. A write that keeps the
// count the same or decreases it (deleting a round, removing a
// participant) is always allowed regardless of plan, and is not even
// expected to call these functions in the first place, but they're safe
// to call in either direction as an extra guarantee.

// oldCount/newCount are the number of PUBLISHED rounds (published !== false)
// before and after the write being validated. Only an INCREASE that
// would push newCount over the effective limit is blocked -- editing an
// already-published round's matches/deadline, or Competition Sync adding
// any number of published:false prepared rounds, never changes this
// count and is therefore never affected.
function checkRoundPublishAllowed(entry, oldCount, newCount, nowMs) {
  const { effectivePlan, limits } = getEffectivePlan(entry, nowMs);
  if (newCount <= oldCount) return { allowed: true };
  if (!limits) return { allowed: true };
  if (newCount > limits.maxPublishedRounds) {
    return {
      allowed: false,
      reason: "plan_round_limit_reached",
      plan: effectivePlan,
      limit: limits.maxPublishedRounds,
    };
  }
  return { allowed: true };
}

// oldCount/newCount are meta.participants.length before and after.
function checkParticipantAddAllowed(entry, oldCount, newCount, nowMs) {
  const { effectivePlan, limits } = getEffectivePlan(entry, nowMs);
  if (newCount <= oldCount) return { allowed: true };
  if (!limits) return { allowed: true };
  if (newCount > limits.maxParticipants) {
    return {
      allowed: false,
      reason: "plan_participant_limit_reached",
      plan: effectivePlan,
      limit: limits.maxParticipants,
    };
  }
  return { allowed: true };
}

module.exports = {
  FREE_TRIAL_DAYS,
  PLAN_LIMITS,
  KNOWN_PLANS,
  getEffectivePlan,
  checkRoundPublishAllowed,
  checkParticipantAddAllowed,
};
