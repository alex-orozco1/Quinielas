// SportsDataProvider — the ONLY module the rest of QRACKS (server.js routes,
// eventually the frontend via the backend endpoint) talks to for sports
// data. Nothing outside this file and providers/theSportsDbAdapter.js should
// ever know TheSportsDB's URL shape, field names, or auth mechanism.
//
// Normalized QRACKS event shape (deliberately provider-agnostic and not
// limited to two-participant sports — see DATA-001 §14/§5):
//
//   {
//     provider: "thesportsdb",
//     externalLeagueId: "4350",
//     externalEventId: "2487452",       // stable id from the provider
//     round: "17" | null,               // provider's own round label, ALWAYS a string
//                                        // (never coerced to Number — some
//                                        // competitions/stages use non-numeric
//                                        // labels) — see AUTO-001
//     status: "finished" | "scheduled" | "postponed" | "unknown",
//     dateTime: "2026-07-17T01:00:00Z" | null,
//     participants: [
//       { role: "home", externalId: "135662", name: "Necaxa" },
//       { role: "away", externalId: "134203", name: "Atlante" }
//     ],
//     score: { home: 2, away: 1 } | null,
//     providerStatus: "FT"              // raw status string, kept for debugging only
//   }
//
// `participants` is a list, not fixed home/away fields, specifically so a
// future non-two-sided sport (F1: N participants with finishing positions,
// no "home") can be represented without changing this shape — see DATA-001
// §5/§14. Today's adapters only ever produce 2-participant entries with
// role "home"/"away"; nothing downstream should assume the list length is 2.

const thesportsdb = require("./providers/theSportsDbAdapter");

const CACHE_TTL_MS = 8 * 60 * 1000; // 5-10 min window, per DATA-001.1 §Caché
const cache = new Map(); // key -> { expiresAt, events }

function cacheKey(provider, externalLeagueId, season) {
  return `${provider}:${externalLeagueId}:${season}`;
}

// Errors are NEVER written to the cache — a failed lookup must be retryable
// on the very next call, not "stuck" showing the same failure for the TTL
// window. Only successful, fully-fetched season schedules are cached.
function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.events;
}

function setCached(key, events) {
  cache.set(key, { events, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Exposed for tests / ops — never exposed over HTTP.
function _clearCache() {
  cache.clear();
}

function normalizeStatus(providerStatus, hasScore) {
  if (providerStatus === "FT" || providerStatus === "AET" || providerStatus === "PEN") return "finished";
  if (providerStatus === "PPD" || providerStatus === "CANC") return "postponed";
  if (providerStatus === "NS" || !providerStatus) return hasScore ? "finished" : "scheduled";
  return "unknown";
}

// TheSportsDB's strTimestamp is UTC but is NOT guaranteed to carry an
// explicit timezone marker — observed real payloads (DATA-001 V2 spike)
// look like "2026-11-22T03:00:00" (no zone). Blindly appending "Z" was a
// bug: if a payload DOES include a zone ("...Z" or "...+00:00"/"...-05:00"),
// appending another "Z" produces an invalid or silently wrong Date. This
// only adds "Z" when no zone is already present, and always validates the
// result — an unparseable timestamp becomes null (caller falls back to
// raw.dateEvent) rather than a bogus/NaN date silently breaking matching.
function normalizeTimestamp(raw) {
  if (!raw) return null;
  const hasZone = /Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(raw);
  const iso = hasZone ? raw : raw + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeEvent(raw, provider) {
  const hasScore = raw.intHomeScore != null && raw.intHomeScore !== "" &&
                    raw.intAwayScore != null && raw.intAwayScore !== "";
  return {
    provider,
    externalLeagueId: raw.idLeague != null ? String(raw.idLeague) : null,
    externalEventId: raw.idEvent != null ? String(raw.idEvent) : null,
    // AUTO-001: the provider's own round label, kept as a string (never
    // Number()) — some competitions/stages use non-numeric round labels
    // (e.g. "Final"), and forcing an integer here would silently break
    // grouping for those. null when the provider gives no round at all;
    // callers (Competition Sync) must treat that as "cannot group this
    // event automatically," never invent a round number for it.
    round: raw.intRound != null && raw.intRound !== "" ? String(raw.intRound) : null,
    status: raw.strPostponed === "yes" ? "postponed" : normalizeStatus(raw.strStatus, hasScore),
    dateTime: normalizeTimestamp(raw.strTimestamp) || raw.dateEvent || null,
    participants: [
      { role: "home", externalId: raw.idHomeTeam != null ? String(raw.idHomeTeam) : null, name: raw.strHomeTeam || null },
      { role: "away", externalId: raw.idAwayTeam != null ? String(raw.idAwayTeam) : null, name: raw.strAwayTeam || null },
    ],
    score: hasScore ? { home: Number(raw.intHomeScore), away: Number(raw.intAwayScore) } : null,
    providerStatus: raw.strStatus || null,
    // MON-001E: raw provider metadata, preserved verbatim and NEVER
    // interpreted here. DATA-002/MON-001D.1 confirmed QRACKS was discarding
    // strSeason entirely -- information we already pay for and that is a
    // prerequisite for any future tournament-identity work. `round` above is
    // the normalized (string) label the sync pipeline groups on; rawRound is
    // kept alongside it so nothing is lost if that normalization ever
    // changes. Deliberately NOT used for any enforcement or semantic
    // decision in this ticket -- purely carried forward and persisted.
    providerMeta: {
      season: raw.strSeason != null && raw.strSeason !== "" ? String(raw.strSeason) : null,
      rawRound: raw.intRound != null && raw.intRound !== "" ? String(raw.intRound) : null,
    },
  };
}

// Fetches (or serves from cache) the full normalized season schedule for a
// league. This is the call that replaces the old truncated V1 frontend
// call — see DATA-001 root cause. Throws thesportsdb.ProviderError on
// failure; callers decide how to surface that (see server.js route).
async function getSeasonEvents({ provider, externalLeagueId, season }) {
  if (provider !== "thesportsdb") {
    // Only one provider exists today; this guard exists so that adding a
    // second provider later is a matter of branching here, not rewriting
    // every caller — see DATA-001 §4/§14.
    throw new thesportsdb.ProviderError("competition_not_supported", `Unknown provider: ${provider}`);
  }
  const key = cacheKey(provider, externalLeagueId, season);
  const cached = getCached(key);
  if (cached) return cached;

  const rawEvents = await thesportsdb.getSeasonSchedule(externalLeagueId, season);
  const events = rawEvents.map((e) => normalizeEvent(e, provider));
  setCached(key, events);
  return events;
}

async function getLiveEvents({ provider, externalLeagueId }) {
  if (provider !== "thesportsdb") {
    throw new thesportsdb.ProviderError("competition_not_supported", `Unknown provider: ${provider}`);
  }
  const rawEvents = await thesportsdb.getLivescore(externalLeagueId);
  return rawEvents.map((e) => normalizeEvent(e, provider));
}

// ---- Matching: normalized provider events <-> QRACKS's own round.matches --
//
// Preserves the exact matching behavior that existed before DATA-001
// (fuzzy team-name comparison within a date window around the round
// deadline), but now prefers a stable externalEventId when the match
// already has one stored (see DATA-001 §8/§12: additive only, never
// required — a manually-created match without externalEventId keeps
// working exactly as before, forever).

const TEAM_ALIASES = {
  "América": "CF America",
  "Chivas": "CD Guadalajara",
  "Juárez": "FC Juarez",
  "Querétaro": "Queretaro FC",
  "Santos": "Santos Laguna",
  "Xolos": "Tijuana",
};

function normalizeTeamName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(fc|cf|cd|afc|sc|ac|club|de)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function teamsMatch(ourName, providerName) {
  const resolved = TEAM_ALIASES[ourName] || ourName;
  const a = normalizeTeamName(resolved);
  const b = normalizeTeamName(providerName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

const MATCH_WINDOW_MS = 1000 * 60 * 60 * 24 * 20; // ~20 days, unchanged from pre-DATA-001 behavior

// Returns a normalized event (see shape above) or null. `match` is a
// QRACKS round.matches[] entry: { teamA, teamB, externalEventId? }.
function findMatchingEvent(events, match, roundDeadlineIso) {
  // Fast path: this match already has a stable external id (e.g. imported
  // via a future Competition Sync) — trust it directly, no fuzzy matching.
  if (match.externalEventId) {
    const direct = events.find((e) => e.externalEventId === String(match.externalEventId));
    if (direct) return direct;
    // Falls through to name-based matching if the id isn't in this batch —
    // never a hard failure just because the id lookup missed.
  }

  const targetTime = new Date(roundDeadlineIso).getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const ev of events) {
    if (ev.status !== "finished" || !ev.score) continue; // only suggest finished results, same as before
    const [home, away] = ev.participants;
    const straight = teamsMatch(match.teamA, home.name) && teamsMatch(match.teamB, away.name);
    const swapped = teamsMatch(match.teamB, home.name) && teamsMatch(match.teamA, away.name);
    if (!straight && !swapped) continue;
    const evTime = ev.dateTime ? new Date(ev.dateTime).getTime() : NaN;
    const diff = Math.abs(evTime - targetTime);
    if (Number.isFinite(diff) && diff < bestDiff && diff < MATCH_WINDOW_MS) {
      bestDiff = diff;
      best = ev;
    }
  }
  return best;
}

module.exports = {
  getSeasonEvents,
  getLiveEvents,
  findMatchingEvent,
  normalizeEvent,
  // exported for tests only
  _teamsMatch: teamsMatch,
  _normalizeTeamName: normalizeTeamName,
  _normalizeTimestamp: normalizeTimestamp,
  _clearCache,
};
