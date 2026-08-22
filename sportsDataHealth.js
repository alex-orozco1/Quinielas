// sportsDataHealth.js — AUTO-004: pure state-transition logic for the
// Sports Data health singleton persisted in the `kv` table.
//
// Deliberately separate from server.js (same documented limitation as
// competitionSync.js/autoResults.js/seasonDefaults.js: can't be
// require()'d in tests without a live Postgres connection) — this is the
// one place that decides what the NEXT persisted row should look like
// given the previous one and a new attempt's outcome, which is what makes
// the CASE A/B/C state-transition sequences (success -> failure ->
// success, etc.) testable in isolation, deterministically, without a
// database.
//
// Everything here is pure: no I/O, no mutation of its inputs.

// Grouping used both to classify the GLOBAL health status (ok/warning/
// error/unknown, see classifySportsDataHealth below) and, separately, to
// group the ADMIN-facing message shown in public/index.html
// (sportsDataFailureMessage there mirrors this same grouping — the two
// can't literally share one JS module across the browser/Node boundary,
// so they're intentionally kept in sync by convention and by the tests in
// this file asserting every RELIABILITY_STATE from the adapter is
// accounted for in exactly one bucket).
//
// TEMPORARY: none of these are something the Admin or QRACKS caused, and
// a later retry is plausibly going to succeed once the provider's own
// hiccup clears.
const TEMPORARY_STATES = new Set([
  "provider_rate_limited",
  "provider_timeout",
  "provider_unavailable",
  "provider_incomplete_response",
]);
// NEEDS_REVIEW: a retry from the Admin's side is unlikely to fix these —
// they need the API key or the integration itself looked at.
const NEEDS_REVIEW_STATES = new Set([
  "provider_auth_error",
  "provider_invalid_response",
]);

// competition_not_supported is deliberately excluded from both sets above,
// and callers of recordSportsDataHealth (server.js) must never invoke it
// for that reliabilityState at all — a specific quiniela's league/season
// not being supported is a per-quiniela configuration fact, not a signal
// about whether the provider itself is reachable. See the ticket's
// explicit warning against marking global Sports Data health as ERROR
// just because one quiniela asked for an unsupported competition.

// Pure: given the PREVIOUS persisted row (or {}/null if none exists yet)
// and a new attempt's outcome, returns the NEXT row to persist. Never
// mutates `prev`.
//
// Success: lastSuccessAt advances to now; lastFailureAt and
// lastReliabilityState are left exactly as they were (a later success
// never erases the memory of the last problem — "it's fine now, but the
// last issue was X at time Y" stays answerable).
//
// Failure: lastFailureAt/lastReliabilityState advance to the new failure;
// lastSuccessAt is left exactly as it was (never cleared by a failure —
// "it failed just now, but the last time it worked was X" is exactly the
// question this exists to answer).
function nextSportsDataHealth(prev, { operation, outcome, reliabilityState, statusCode, nowIso }) {
  const now = nowIso || new Date().toISOString();
  const p = prev || {};
  return {
    lastAttemptAt: now,
    lastSuccessAt: outcome === "success" ? now : (p.lastSuccessAt || null),
    lastFailureAt: outcome === "failure" ? now : (p.lastFailureAt || null),
    lastOutcome: outcome, // "success" | "failure" -- this alone drives current ok vs warning/error
    lastReliabilityState: outcome === "failure" ? reliabilityState : (p.lastReliabilityState || null),
    lastOperation: operation, // "competition_sync" | "automatic_results"
    provider: "thesportsdb",
    // Only ever a bare HTTP status number (or null) -- never a request URL,
    // never a response body, never anything that could carry a key.
    statusCode: outcome === "failure" && statusCode != null ? statusCode : null,
  };
}

// Pure: derives the compact global status the Panel shows from a
// persisted (or default/never-attempted) health row. UNKNOWN is a real,
// distinct state -- it is never collapsed into "ok" just because the row
// technically exists with everything null.
function classifySportsDataHealth(health) {
  if (!health || !health.lastOutcome) return "unknown";
  if (health.lastOutcome === "success") return "ok";
  return NEEDS_REVIEW_STATES.has(health.lastReliabilityState) ? "error" : "warning";
}

const DEFAULT_SPORTS_DATA_HEALTH = Object.freeze({
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastOutcome: null,
  lastReliabilityState: null,
  lastOperation: null,
  provider: null,
  statusCode: null,
});

module.exports = {
  nextSportsDataHealth,
  classifySportsDataHealth,
  TEMPORARY_STATES,
  NEEDS_REVIEW_STATES,
  DEFAULT_SPORTS_DATA_HEALTH,
};
