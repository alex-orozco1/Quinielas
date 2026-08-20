// AUTO-002 — Automatic Results: eligibility rule.
//
// Deliberately separate from server.js (can't be require()'d in tests
// without a live Postgres connection — same documented limitation as
// competitionSync.js/seasonDefaults.js). This is the single decision point
// that determines whether a round is even worth asking TheSportsDB about,
// which is what makes "0 elegibles -> 0 llamadas al proveedor" enforceable
// and testable in isolation.
//
// Bucket definitions (see AUTO-002 spec):
//   - published:false                              -> NOT eligible (not part of the game yet)
//   - published & deadline still in the future      -> NOT eligible (nothing could have finished)
//   - published & deadline passed & resultsPublished:true  -> NOT eligible (already resolved, persisted in QRACKS — the source of truth from here on)
//   - published & deadline passed & resultsPublished:false -> ELIGIBLE
//   - published === undefined (legacy) behaves exactly like published:true

function isRoundEligibleForAutoResults(round, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  if (round.published === false) return false;
  if (round.resultsPublished) return false;
  const deadline = new Date(round.deadline).getTime();
  if (!Number.isFinite(deadline)) return false; // no usable deadline — don't guess
  return now > deadline; // "reasonably closed" — same definition already used client-side (isRoundLocked)
}

module.exports = { isRoundEligibleForAutoResults };
