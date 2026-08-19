// AUTO-001 — replaces the hardcoded "2025-2026" literal that was flagged as
// stale in the AUTO-001 diagnostic. A fixed literal like that silently goes
// wrong the moment a new season starts.
//
// Deliberately a simple calendar heuristic, not real season detection (that
// would need provider calls / new scope, explicitly out of bounds for this
// ticket): most of the leagues QRACKS deals with run July/August through
// May/June, so before July we're still in the season that started the
// previous calendar year.
//
// Separate module (rather than inline in server.js) specifically so it's
// unit-testable without requiring server.js, which connects to a live
// Postgres instance at import time.

function currentDefaultSeason(now) {
  const d = now || new Date();
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 6 ? y : y - 1; // getUTCMonth() is 0-indexed; 6 = July
  return `${startYear}-${startYear + 1}`;
}

module.exports = { currentDefaultSeason };
