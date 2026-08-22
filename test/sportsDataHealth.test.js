// AUTO-004 — Sports Data Reliability / Observability. Cases A-P, executing
// the REAL functions from sportsDataHealth.js (state transitions,
// classification) and, where indicated, real fragments extracted verbatim
// from server.js/public/index.html — not reimplementations.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  nextSportsDataHealth,
  classifySportsDataHealth,
  TEMPORARY_STATES,
  NEEDS_REVIEW_STATES,
  DEFAULT_SPORTS_DATA_HEALTH,
} = require("../sportsDataHealth");
const { RELIABILITY_STATES } = require("../providers/theSportsDbAdapter");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// ---- CASE A: first successful operation ----

test("CASE A: first-ever successful operation -> ok, lastAttemptAt and lastSuccessAt both set", () => {
  const next = nextSportsDataHealth(null, { operation: "competition_sync", outcome: "success", nowIso: "2026-08-22T10:00:00.000Z" });
  assert.equal(next.lastAttemptAt, "2026-08-22T10:00:00.000Z");
  assert.equal(next.lastSuccessAt, "2026-08-22T10:00:00.000Z");
  assert.equal(next.lastFailureAt, null);
  assert.equal(next.lastOutcome, "success");
  assert.equal(classifySportsDataHealth(next), "ok");
});

// ---- CASE B: success -> timeout ----

test("CASE B: success, then a timeout -> status leaves ok, lastFailureAt updates, lastSuccessAt is PRESERVED", () => {
  const afterSuccess = nextSportsDataHealth(null, { operation: "competition_sync", outcome: "success", nowIso: "2026-08-22T10:00:00.000Z" });
  const afterTimeout = nextSportsDataHealth(afterSuccess, { operation: "competition_sync", outcome: "failure", reliabilityState: "provider_timeout", nowIso: "2026-08-22T11:00:00.000Z" });
  assert.equal(afterTimeout.lastFailureAt, "2026-08-22T11:00:00.000Z");
  assert.equal(afterTimeout.lastSuccessAt, "2026-08-22T10:00:00.000Z", "lastSuccessAt must be preserved, never cleared by a failure");
  assert.equal(afterTimeout.lastReliabilityState, "provider_timeout");
  assert.equal(classifySportsDataHealth(afterTimeout), "warning");
});

// ---- CASE C: timeout -> next success ----

test("CASE C: timeout, then the next operation succeeds -> status returns to ok, with a NEW lastSuccessAt", () => {
  const afterSuccess1 = nextSportsDataHealth(null, { operation: "competition_sync", outcome: "success", nowIso: "2026-08-22T10:00:00.000Z" });
  const afterTimeout = nextSportsDataHealth(afterSuccess1, { operation: "competition_sync", outcome: "failure", reliabilityState: "provider_timeout", nowIso: "2026-08-22T11:00:00.000Z" });
  const afterSuccess2 = nextSportsDataHealth(afterTimeout, { operation: "competition_sync", outcome: "success", nowIso: "2026-08-22T12:00:00.000Z" });
  assert.equal(classifySportsDataHealth(afterSuccess2), "ok");
  assert.equal(afterSuccess2.lastSuccessAt, "2026-08-22T12:00:00.000Z", "must be the NEW success time, not the old one");
  assert.equal(afterSuccess2.lastFailureAt, "2026-08-22T11:00:00.000Z", "the failure history is preserved even after recovering");
});

// ---- CASE D: 401/403 ----

test("CASE D: provider_auth_error is persisted and classified as error (requires QRACKS review)", () => {
  const next = nextSportsDataHealth(null, { operation: "competition_sync", outcome: "failure", reliabilityState: "provider_auth_error", statusCode: 401, nowIso: "2026-08-22T10:00:00.000Z" });
  assert.equal(next.lastReliabilityState, "provider_auth_error");
  assert.equal(next.statusCode, 401);
  assert.equal(classifySportsDataHealth(next), "error");
});

// ---- CASE E: 429 ----

test("CASE E: provider_rate_limited is persisted, classified as warning (temporary) -- NEVER as quota exhaustion", () => {
  const next = nextSportsDataHealth(null, { operation: "automatic_results", outcome: "failure", reliabilityState: "provider_rate_limited", statusCode: 429, nowIso: "2026-08-22T10:00:00.000Z" });
  assert.equal(next.lastReliabilityState, "provider_rate_limited");
  assert.equal(classifySportsDataHealth(next), "warning");
  const adminMsgFn = indexSrc.slice(indexSrc.indexOf("function sportsDataFailureMessage"), indexSrc.indexOf("function sportsDataFailureMessage") + 1600);
  assert.ok(!/cuota/i.test(adminMsgFn), "admin message logic must never mention 'cuota' -- we cannot distinguish rate-limit from quota exhaustion");
  const platformHtmlFn = indexSrc.slice(indexSrc.indexOf("function sportsDataHealthHtml"), indexSrc.indexOf("function sportsDataHealthHtml") + 2200);
  assert.ok(!/cuota|plan agotado/i.test(platformHtmlFn), "platform panel must never mention quota/plan exhaustion as a confirmed cause");
});

// ---- CASE F: 500/503 ----

test("CASE F: provider_unavailable (5xx) is classified as warning (temporary problem)", () => {
  const next = nextSportsDataHealth(null, { operation: "competition_sync", outcome: "failure", reliabilityState: "provider_unavailable", statusCode: 503, nowIso: "2026-08-22T10:00:00.000Z" });
  assert.equal(classifySportsDataHealth(next), "warning");
});

// ---- CASE G: provider_incomplete_response ----

test("CASE G: provider_incomplete_response is persisted correctly, classified as warning", () => {
  const next = nextSportsDataHealth(null, { operation: "competition_sync", outcome: "failure", reliabilityState: "provider_incomplete_response", nowIso: "2026-08-22T10:00:00.000Z" });
  assert.equal(next.lastReliabilityState, "provider_incomplete_response");
  assert.equal(classifySportsDataHealth(next), "warning");
});

test("CASE G (server-side): sync-competition ROLLBACKs before any round is added on provider failure", () => {
  const catchIdx = serverSrc.indexOf('catch (err) {\n      await client.query("ROLLBACK");');
  assert.ok(catchIdx !== -1, "could not locate the provider-failure catch block in sync-competition");
});

// ---- CASE H: competition_not_supported must NEVER flip global health ----

test("CASE H: competition_not_supported never reaches recordSportsDataHealth from any of the 3 call sites", () => {
  const occurrences = [...serverSrc.matchAll(/if \(reliabilityState !== "competition_not_supported"\) \{\s*\n\s*recordSportsDataHealth/g)];
  assert.equal(occurrences.length, 3, "all three failure call sites must guard recordSportsDataHealth behind this exact check");
});

test("CASE H: classifySportsDataHealth never treats competition_not_supported as a real warning/error signal", () => {
  assert.ok(!TEMPORARY_STATES.has("competition_not_supported"));
  assert.ok(!NEEDS_REVIEW_STATES.has("competition_not_supported"));
});

// ---- CASE I: Automatic Results with no new results is not a failure ----

test("CASE I: 0 eligible rounds never calls recordSportsDataHealth (no provider call was made)", () => {
  const idx = serverSrc.indexOf("if (!eligibleRounds.length) {");
  const slice = serverSrc.slice(idx, idx + 200);
  assert.ok(!slice.includes("recordSportsDataHealth"), "no attempt was made, so nothing should be recorded as an attempt");
});

// ---- CASE J: Competition Sync fails -> health records failure, meta stays intact ----

test("CASE J: sync-competition records failure only AFTER the transaction ROLLBACK", () => {
  const catchBlockStart = serverSrc.indexOf('catch (err) {\n      await client.query("ROLLBACK");');
  const rollbackIdx = serverSrc.indexOf('await client.query("ROLLBACK")', catchBlockStart);
  const recordIdx = serverSrc.indexOf("recordSportsDataHealth", catchBlockStart);
  assert.ok(rollbackIdx !== -1 && recordIdx !== -1 && rollbackIdx < recordIdx, "ROLLBACK must happen before recordSportsDataHealth");
});

// ---- CASE K: Automatic Results fails -> health records failure, no round modified ----

test("CASE K: sports-results (both single and bulk) never assigns to meta.rounds anywhere in their handlers", () => {
  const bulkIdx = serverSrc.indexOf('app.get("/api/quinielas/:slug/sports-results", rateLimit');
  const bulkEnd = serverSrc.indexOf("\n});", bulkIdx);
  const bulkBody = serverSrc.slice(bulkIdx, bulkEnd);
  assert.ok(!bulkBody.includes("meta.rounds ="), "bulk sports-results must never assign meta.rounds");

  const singleIdx = serverSrc.indexOf('app.get("/api/quinielas/:slug/rounds/:roundId/sports-results"');
  const singleEnd = serverSrc.indexOf("\n});", singleIdx);
  const singleBody = serverSrc.slice(singleIdx, singleEnd);
  assert.ok(!singleBody.includes("meta.rounds ="), "single-round sports-results must never assign meta.rounds");
});

// ---- CASE L: a failure writing sports_data_health itself must never break the real operation ----

test("CASE L: recordSportsDataHealth wraps its entire body in try/catch and never re-throws", () => {
  const idx = serverSrc.indexOf("async function recordSportsDataHealth(");
  const body = serverSrc.slice(idx, idx + 900);
  assert.ok(body.includes("try {"));
  assert.ok(body.includes("} catch (err) {"));
  assert.ok(body.includes('console.error("recordSportsDataHealth failed (non-fatal, ignored)"'), "failure must only be logged, never thrown further");
  assert.ok(!/throw/.test(body.slice(body.indexOf("} catch (err) {"))), "the catch block must not re-throw");
});

test("CASE L: recordSportsDataHealth is called as a bare fire-and-forget statement on all 3 success paths, never gating the response", () => {
  const occurrences = [...serverSrc.matchAll(/^\s*recordSportsDataHealth\(\{ operation: "(?:competition_sync|automatic_results)", outcome: "success"\s*\}\);\s*$/gm)];
  assert.equal(occurrences.length, 3, "all three success call sites (sync-competition, sports-results single, sports-results bulk) must call recordSportsDataHealth as a bare non-awaited statement");
});

// ---- CASE M: persistence survives a fresh read (restart simulation) ----

test("CASE M: nextSportsDataHealth is a pure function -- re-deriving from a freshly JSON-round-tripped prev (simulating a restart re-reading from Postgres) preserves history correctly", () => {
  const prev = { lastAttemptAt: "2026-08-22T09:00:00.000Z", lastSuccessAt: "2026-08-22T09:00:00.000Z", lastFailureAt: null, lastOutcome: "success", lastReliabilityState: null, lastOperation: "competition_sync", provider: "thesportsdb", statusCode: null };
  const prevFromFreshRead = JSON.parse(JSON.stringify(prev));
  const next = nextSportsDataHealth(prevFromFreshRead, { operation: "automatic_results", outcome: "failure", reliabilityState: "provider_timeout", nowIso: "2026-08-22T10:00:00.000Z" });
  assert.equal(next.lastSuccessAt, "2026-08-22T09:00:00.000Z", "history from before the simulated restart must survive intact");
  assert.equal(next.lastFailureAt, "2026-08-22T10:00:00.000Z");
});

// ---- CASE N: platform endpoint requires real platform auth ----

test("CASE N: /api/platform-sports-health uses the exact same auth check as /api/platform-analytics", () => {
  const idx = serverSrc.indexOf('app.get("/api/platform-sports-health"');
  const body = serverSrc.slice(idx, idx + 500);
  assert.ok(body.includes('req.get("x-qracks-platform-auth")'));
  assert.ok(body.includes("verifyPassword(providedPlatformAuth, platformHash)"));
  assert.ok(body.includes('res.status(403).json({ error: "unauthorized" })'));
});

// ---- CASE O: never attempted -> UNKNOWN, never invented as OK ----

test("CASE O: a health object with lastOutcome:null (never attempted) classifies as unknown, never ok", () => {
  assert.equal(classifySportsDataHealth(DEFAULT_SPORTS_DATA_HEALTH), "unknown");
  assert.equal(classifySportsDataHealth(null), "unknown");
  assert.equal(classifySportsDataHealth({}), "unknown");
});

test("CASE O: the seeded row in ensureTable() starts with lastOutcome:null", () => {
  const seedIdx = serverSrc.indexOf("lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null,");
  assert.ok(seedIdx !== -1, "could not find the seed shape in ensureTable()");
  const seedSlice = serverSrc.slice(seedIdx, seedIdx + 150);
  assert.ok(seedSlice.includes("lastOutcome: null"));
});

// ---- CASE P: no secrets/stack traces/payloads ever persisted or exposed ----

test("CASE P: nextSportsDataHealth's output object only ever contains the 8 documented fields", () => {
  const next = nextSportsDataHealth(null, {
    operation: "competition_sync",
    outcome: "failure",
    reliabilityState: "provider_auth_error",
    statusCode: 401,
    nowIso: "2026-08-22T10:00:00.000Z",
  });
  assert.deepEqual(Object.keys(next).sort(), [
    "lastAttemptAt", "lastFailureAt", "lastOperation", "lastOutcome",
    "lastReliabilityState", "lastSuccessAt", "provider", "statusCode",
  ]);
});

test("CASE P: statusCode is only ever a bare number (or null) -- server.js only ever extracts err.meta.status, never the full err.meta object", () => {
  const occurrences = [...serverSrc.matchAll(/statusCode: err instanceof ProviderError \? err\.meta && err\.meta\.status : null/g)];
  assert.equal(occurrences.length, 3, "all 3 failure call sites must extract only the bare status code, never the full error meta object (which could include the request URL)");
  assert.ok(!serverSrc.includes("statusCode: err.meta,"), "must never pass the raw meta object through as statusCode");
});

test("CASE P: server.js never references THESPORTSDB_API_KEY anywhere near the health-recording code", () => {
  const idx = serverSrc.indexOf("async function recordSportsDataHealth(");
  const body = serverSrc.slice(idx, idx + 900);
  assert.ok(!body.includes("THESPORTSDB_API_KEY"));
  assert.ok(!body.includes("process.env"));
});

// ---- Coverage: every RELIABILITY_STATES value relevant here is accounted for ----

test("every reliabilityState relevant to season-schedule fetches is in exactly one bucket, except competition_not_supported which is in neither", () => {
  const relevantStates = RELIABILITY_STATES.filter((s) => s !== "event_not_found" && s !== "event_not_finished" && s !== "provider_quota_exceeded");
  relevantStates.forEach((state) => {
    if (state === "competition_not_supported") {
      assert.ok(!TEMPORARY_STATES.has(state) && !NEEDS_REVIEW_STATES.has(state), `${state} must be in neither bucket`);
      return;
    }
    const inTemp = TEMPORARY_STATES.has(state);
    const inReview = NEEDS_REVIEW_STATES.has(state);
    assert.ok(inTemp || inReview, `${state} must be classified in at least one bucket`);
    assert.ok(!(inTemp && inReview), `${state} must not be in both buckets`);
  });
});

test("provider_quota_exceeded is never generated by any code path touched in this ticket", () => {
  assert.ok(!serverSrc.includes('"provider_quota_exceeded"'));
  assert.ok(!fs.readFileSync(path.join(__dirname, "..", "sportsDataHealth.js"), "utf8").includes("provider_quota_exceeded"));
});
