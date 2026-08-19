// TheSportsDB V2 adapter — the ONLY file in QRACKS that knows the shape of
// TheSportsDB's JSON, its auth mechanism, or its URLs. Everything above this
// file (server.js, the frontend) talks to sportsDataProvider.js instead,
// which only sees QRACKS's own normalized event shape (see sportsDataProvider.js).
//
// Root cause this replaces (DATA-001): the old frontend code called
// TheSportsDB V1 directly with the public free key "123", whose
// eventsseason.php endpoint truncates to 15 events regardless of season
// size — confirmed empirically to return only round 1-2 of any league's
// season. V2 with a paid key does not truncate (confirmed empirically:
// 153/153 Liga MX events across all 17 rounds, 380/380 Premier League
// events — see DATA-001 spike report).

const BASE_URL = "https://www.thesportsdb.com/api/v2/json";
const REQUEST_TIMEOUT_MS = 8000;

// Never fall back to the public free key "123" in production — DATA-001.1
// explicitly rejected Free as a viable source (structural truncation), so a
// silent fallback to it here would quietly reintroduce the exact bug this
// adapter exists to fix.
function getApiKey() {
  const key = process.env.THESPORTSDB_API_KEY;
  if (!key) {
    throw new ProviderError("provider_auth_error", "THESPORTSDB_API_KEY is not configured");
  }
  return key;
}

class ProviderError extends Error {
  constructor(reliabilityState, message, meta) {
    super(message);
    this.name = "ProviderError";
    this.reliabilityState = reliabilityState; // one of RELIABILITY_STATES below
    this.meta = meta || {};
  }
}

const RELIABILITY_STATES = Object.freeze([
  "event_not_finished",
  "event_not_found",
  "competition_not_supported",
  "provider_rate_limited",
  // provider_quota_exceeded: kept in this enum for forward-compatibility with
  // DATA-001.1's reliability model, but this adapter does NOT currently
  // produce it. TheSportsDB V2's documentation and the empirical evidence
  // gathered for this provider (DATA-001 spike) only show a single signal
  // for "too many requests" — HTTP 429 — with no distinct response for
  // plan/quota exhaustion vs. short-term rate limiting. Every 429 maps to
  // provider_rate_limited below. If TheSportsDB starts returning a
  // distinguishable signal for quota exhaustion (e.g. a different status
  // code or an explicit error body), wire it here — do not infer it from
  // request counts or timing, which would be guessing, not detecting.
  "provider_quota_exceeded", // NOT EMPIRICALLY DETECTABLE with current evidence — never thrown by this file
  "provider_auth_error",
  "provider_unavailable",
  "provider_timeout",
  "provider_invalid_response",
  "provider_incomplete_response",
]);

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new ProviderError("provider_timeout", "TheSportsDB request timed out", { url });
    }
    throw new ProviderError("provider_unavailable", "TheSportsDB request failed: " + err.message, { url });
  } finally {
    clearTimeout(timer);
  }
}

async function callThesportsdb(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetchWithTimeout(url, {
    headers: { "X-API-KEY": getApiKey() },
  });

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("provider_auth_error", "TheSportsDB rejected the API key", { url, status: res.status });
  }
  if (res.status === 429) {
    throw new ProviderError("provider_rate_limited", "TheSportsDB rate limit hit", { url, status: res.status });
  }
  if (res.status >= 500) {
    throw new ProviderError("provider_unavailable", "TheSportsDB server error", { url, status: res.status });
  }
  if (!res.ok) {
    throw new ProviderError("provider_invalid_response", "Unexpected TheSportsDB status", { url, status: res.status });
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new ProviderError("provider_invalid_response", "TheSportsDB response was not valid JSON", { url });
  }
  return body;
}

// TheSportsDB uses the SAME generic message — {"Message":"No data found"} —
// for two very different situations (confirmed empirically in the DATA-001
// Premium V2 spike):
//   1. livescore endpoint, no matches currently live → legitimate empty result
//   2. lookup/event endpoint, an event id that doesn't exist → event_not_found
// The message text alone can't tell these apart. The caller (this file)
// always knows which endpoint it just called, so the distinction is made
// here, at the call site, never by pattern-matching the message elsewhere.
function isNoDataFound(body) {
  return !!(body && typeof body.Message === "string" && /no data found/i.test(body.Message));
}

// DATA-001.1 §6 gate + QA fix: detects a season schedule that LOOKS like the
// exact truncation this adapter exists to eliminate — TheSportsDB Free's
// eventsseason.php always capped a season at round 1-2 regardless of true
// size (empirically confirmed in DATA-001). If a "full season" response
// ever comes back capped the same way — even from Premium V2, e.g. a key
// that silently degraded, a proxy/cache serving stale free-tier data, or a
// provider regression — QRACKS must not treat it as a complete, cacheable
// result and must not silently generate suggestions from it.
//
// Deliberately league/sport-agnostic: it never assumes a specific expected
// event count for any competition (that would require hardcoding Liga MX or
// any other league). It only reasons from structure PRESENT IN THIS SAME
// RESPONSE:
//   - how many distinct rounds were returned, and how high they go
//   - how many distinct participants appear in the earliest round
// A response capped at round <=2 is only flagged when that earliest round
// alone already implies a multi-team round-robin competition (>=6 distinct
// participants, i.e. >=3 simultaneous matches) — because a competition with
// that many participants structurally cannot finish in 2 rounds. A
// genuinely tiny competition (e.g. a 4-team mini-cup: semis + final = 2
// rounds, 4 participants) never trips this, since 4 < 6 — see test suite
// for the false-positive guard this encodes.
function detectIncompleteSchedule(rawEvents) {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) return false;

  const rounds = rawEvents.map((e) => Number(e.intRound)).filter((n) => Number.isFinite(n));
  if (rounds.length === 0) return false; // no round data to reason about — don't guess

  const maxRound = Math.max(...rounds);
  const minRound = Math.min(...rounds);
  const narrowRoundSpan = maxRound <= 2; // the exact ceiling the V1 free-tier bug always hit

  if (!narrowRoundSpan) return false;

  const earliestRoundEvents = rawEvents.filter((e) => Number(e.intRound) === minRound);
  const impliedParticipants = new Set(
    earliestRoundEvents.flatMap((e) => [e.idHomeTeam, e.idAwayTeam]).filter(Boolean)
  ).size;

  return impliedParticipants >= 6; // implies a league too large to legitimately end at round 2
}

// ---- Public adapter surface -------------------------------------------

// Full season schedule for a league. This is the endpoint that replaces the
// truncated V1 eventsseason.php call — see module header.
async function getSeasonSchedule(externalLeagueId, season) {
  const body = await callThesportsdb(`/schedule/league/${encodeURIComponent(externalLeagueId)}/${encodeURIComponent(season)}`);
  if (isNoDataFound(body)) {
    // An empty-but-legitimate season schedule is unusual but not impossible
    // (e.g. a season that hasn't started publishing fixtures yet) — treat as
    // "competition not (yet) supported for this season" rather than a hard error.
    throw new ProviderError("competition_not_supported", "No schedule data for this league/season", {
      externalLeagueId,
      season,
    });
  }
  const events = Array.isArray(body && body.schedule) ? body.schedule
    : Array.isArray(body) ? body
    : [];

  if (detectIncompleteSchedule(events)) {
    // Never returned to the caller as if it were a valid, cacheable result —
    // sportsDataProvider.getSeasonEvents() only caches on success, so a
    // thrown ProviderError here automatically satisfies "incomplete
    // responses are never cached, and the next call retries against the
    // provider" without any extra plumbing.
    throw new ProviderError("provider_incomplete_response", "Season schedule looks truncated (capped at round <=2 for a multi-team competition)", {
      externalLeagueId,
      season,
      eventCount: events.length,
    });
  }

  return events;
}

// Look up a single event by TheSportsDB's own event id.
async function lookupEvent(externalEventId) {
  const body = await callThesportsdb(`/lookup/event/${encodeURIComponent(externalEventId)}`);
  if (isNoDataFound(body)) {
    // Unambiguous here: we asked for one specific event id and got nothing back.
    throw new ProviderError("event_not_found", "No event found for this id", { externalEventId });
  }
  const events = Array.isArray(body && body.lookup) ? body.lookup : [];
  if (!events.length) {
    throw new ProviderError("event_not_found", "No event found for this id", { externalEventId });
  }
  return events[0];
}

// Live matches for a league right now. A "no data found" here is a
// legitimate empty result (nothing currently live), NOT an error — this is
// the other half of the isNoDataFound() ambiguity described above.
async function getLivescore(externalLeagueId) {
  const body = await callThesportsdb(`/livescore/${encodeURIComponent(externalLeagueId)}`);
  if (isNoDataFound(body)) {
    return []; // legitimate: nothing live right now
  }
  const events = Array.isArray(body && body.livescore) ? body.livescore
    : Array.isArray(body) ? body
    : [];
  return events;
}

module.exports = {
  ProviderError,
  RELIABILITY_STATES,
  getSeasonSchedule,
  lookupEvent,
  getLivescore,
  // exported for tests only
  _isNoDataFound: isNoDataFound,
  _detectIncompleteSchedule: detectIncompleteSchedule,
};
