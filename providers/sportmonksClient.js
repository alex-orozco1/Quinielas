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

// The relations the Adapter needs. Named here so the Client and its tests
// cannot drift apart silently, and so a change is one edit at the boundary.
const INCLUDE_SEASON_STAGES = "stages";
const INCLUDE_STAGE_FIXTURES = "fixtures.participants";

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

  // SINGLE contract for query parameters: everything goes through `params`.
  // The previous version accepted `{ include: ... }` at the top level and
  // silently dropped it, so getSeasonWithStages/getStageFixtures were issuing
  // requests WITHOUT the includes they exist to fetch. Any unknown top-level
  // option is now rejected loudly rather than ignored.
  async function request(path, options = {}) {
    const { params, ...unknown } = options;
    const unknownKeys = Object.keys(unknown);
    if (unknownKeys.length) {
      throw new ProviderError(
        "provider_invalid_response",
        `SportmonksClient.request received unsupported option(s): ${unknownKeys.join(", ")} — query parameters must be passed inside \`params\``,
        { provider: "sportmonks", path }
      );
    }
    const token = getApiToken(); // throws provider_auth_error if absent
    const url = new URL(BASE_URL + path);
    // null/undefined are SKIPPED, never stringified into "null"/"undefined".
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
      // Sportmonks v3 documents 401 and 403 as DIFFERENT conditions: 401 is an
      // unauthenticated request, 403 is a feed/resource the current plan does
      // not include. Reporting a coverage 403 as provider_auth_error was
      // wrong: it tells an admin their token is broken when the real problem
      // is that a league is not in the subscription -- which will happen
      // routinely as QRACKS adds competitions. Mapped to the existing
      // competition_not_supported state (AUTO-004 taxonomy, reused rather
      // than extended: it already carries exactly the meaning "we cannot get
      // this competition from the provider" and needs no new state).
      throw new ProviderError("competition_not_supported", "Sportmonks plan does not grant access to this resource", { ...safeMeta, status });
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

  // "no usable data returned" — deliberately NOT "the plan does not cover this
  // competition". A 200 with an empty/absent data payload can mean a
  // nonexistent resource, a wrong season/stage id, a genuinely empty result,
  // coverage, or something else entirely, and we have no provider signal that
  // distinguishes them. competition_not_supported is reused as the
  // conservative degradation because it already exists in the AUTO-004
  // taxonomy and reads correctly to an admin ("we couldn't get this
  // competition's data"), but the CAUSE is explicitly not claimed here.
  function assertUsableData(data, path) {
    const empty = data == null || (Array.isArray(data) && data.length === 0)
      || (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0);
    if (empty) {
      throw new ProviderError(
        "competition_not_supported",
        "Sportmonks returned no usable data for this resource",
        { provider: "sportmonks", path }
      );
    }
    return data;
  }

  async function getSeasonWithStages(seasonId) {
    const path = `/seasons/${encodeURIComponent(seasonId)}`;
    const body = await request(path, { params: { include: INCLUDE_SEASON_STAGES } });
    return assertUsableData(body.data, path);
  }

  async function getStageFixtures(stageId) {
    const path = `/stages/${encodeURIComponent(stageId)}`;
    const body = await request(path, { params: { include: INCLUDE_STAGE_FIXTURES } });
    return assertUsableData(body.data, path);
  }

  return { request, getSeasonWithStages, getStageFixtures };
}

module.exports = { createSportmonksClient, BASE_URL, REQUEST_TIMEOUT_MS, INCLUDE_SEASON_STAGES, INCLUDE_STAGE_FIXTURES };
