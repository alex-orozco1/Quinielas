// sportmonksClient.js — DATA-003 (QA correction): the missing Provider Client.
//
//   Provider Client  <- this file
//        ↓
//   Adapter (sportmonksAdapter.js — pure mappers)
//        ↓
//   QRACKS Sports Domain (sportsDomain.js)
//        ↓
//   Product
//
// The adapter is deliberately pure, which is exactly why error handling has to
// live here. This file owns everything that touches the outside world: the
// token, the base URL, request construction, the timeout, and the mapping of
// every failure mode onto QRACKS's EXISTING reliability taxonomy.
//
// TAXONOMY: this reuses ProviderError + RELIABILITY_STATES from
// providers/theSportsDbAdapter.js verbatim. AUTO-004's Sports Data health
// persistence, the platform panel and the admin-facing message grouping all
// key off those exact strings, so introducing a second, parallel taxonomy
// would silently break observability for this provider. No new states are
// invented here.
//
// SECRETS: SPORTMONKS_API_TOKEN is read from the environment, server-side
// only. It is sent as a header (never as a query string, which would leak it
// into access logs and error URLs), is never returned in ProviderError.meta,
// never logged, and never appears in any fixture or test.

const { ProviderError } = require("./theSportsDbAdapter");

const BASE_URL = "https://api.sportmonks.com/v3/football";
const REQUEST_TIMEOUT_MS = 8000;

function getApiToken() {
  const token = process.env.SPORTMONKS_API_TOKEN;
  if (!token) {
    // Fail closed and loudly. A missing token is a deployment problem, not a
    // transient upstream issue, and must never be retried as if it were one.
    throw new ProviderError(
      "provider_auth_error",
      "SPORTMONKS_API_TOKEN is not configured",
      { provider: "sportmonks" }
    );
  }
  return token;
}

// `transport` is injectable purely so tests can drive every failure branch
// without a network. Production always uses global fetch.
function createSportmonksClient({ transport, timeoutMs } = {}) {
  const doFetch = transport || ((...args) => fetch(...args));
  const timeout = Number.isFinite(timeoutMs) ? timeoutMs : REQUEST_TIMEOUT_MS;

  async function request(path, { params } = {}) {
    const token = getApiToken(); // throws provider_auth_error if absent
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    // meta is attached to every ProviderError below. It deliberately carries
    // the PATH ONLY -- never the full URL object and never headers -- so a
    // token can never reach a log line through an error payload.
    const safeMeta = { provider: "sportmonks", path };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await doFetch(url.toString(), {
        method: "GET",
        headers: { Authorization: token, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new ProviderError("provider_timeout", "Sportmonks request timed out", safeMeta);
      }
      throw new ProviderError("provider_unavailable", "Sportmonks request failed", safeMeta);
    } finally {
      clearTimeout(timer);
    }

    const status = res && res.status;
    if (status === 401) {
      throw new ProviderError("provider_auth_error", "Sportmonks rejected the API token", { ...safeMeta, status });
    }
    if (status === 403) {
      // Sportmonks uses 403 both for a rejected token and for a resource
      // outside the current plan. We have NO verified sample of a 403 body
      // from this provider, so we do not guess which one it is -- exactly the
      // precedent AUTO-004 set for TheSportsDB's 429/quota ambiguity. It maps
      // to provider_auth_error, the safer of the two (it never tells an admin
      // "this competition isn't supported" when the real problem is a bad
      // token). If a distinguishable body is ever captured, branch here.
      throw new ProviderError("provider_auth_error", "Sportmonks denied access (token or plan coverage)", { ...safeMeta, status });
    }
    if (status === 429) {
      throw new ProviderError("provider_rate_limited", "Sportmonks rate limit hit", { ...safeMeta, status });
    }
    if (status >= 500) {
      throw new ProviderError("provider_unavailable", "Sportmonks server error", { ...safeMeta, status });
    }
    if (!res.ok) {
      throw new ProviderError("provider_invalid_response", "Unexpected Sportmonks status", { ...safeMeta, status });
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new ProviderError("provider_invalid_response", "Sportmonks response was not valid JSON", safeMeta);
    }
    if (!body || typeof body !== "object" || !("data" in body)) {
      throw new ProviderError("provider_invalid_response", "Sportmonks response had no data envelope", safeMeta);
    }
    return body;
  }

  // A subscribed-but-empty result is a real, distinct situation: the plan
  // simply doesn't cover this competition/season. That maps to the EXISTING
  // competition_not_supported state rather than a new "coverage" one.
  async function getSeasonWithStages(seasonId) {
    const body = await request(`/seasons/${encodeURIComponent(seasonId)}`, { include: "stages" });
    const data = body.data;
    if (!data || (Array.isArray(data) && data.length === 0)) {
      throw new ProviderError("competition_not_supported", "Sportmonks returned no data for this season", {
        provider: "sportmonks", path: `/seasons/${seasonId}`,
      });
    }
    return data;
  }

  async function getStageFixtures(stageId) {
    const body = await request(`/stages/${encodeURIComponent(stageId)}`, { include: "fixtures.participants" });
    const data = body.data;
    if (!data || (Array.isArray(data) && data.length === 0)) {
      throw new ProviderError("competition_not_supported", "Sportmonks returned no data for this stage", {
        provider: "sportmonks", path: `/stages/${stageId}`,
      });
    }
    return data;
  }

  return { request, getSeasonWithStages, getStageFixtures };
}

module.exports = { createSportmonksClient, BASE_URL, REQUEST_TIMEOUT_MS };
