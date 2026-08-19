// Tests for providers/theSportsDbAdapter.js — DATA-001 Paso 16 "Provider" tests.
// Uses Node's built-in test runner (node:test) — no new dependency added,
// consistent with the project's "simplicity wins" engineering principle.
// Run with: node --test test/

const test = require("node:test");
const assert = require("node:assert/strict");

// Mock global.fetch before requiring the adapter so its module-level
// REQUEST_TIMEOUT_MS/AbortController usage still works against our fake responses.
function mockFetchOnce(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test("throws provider_auth_error when THESPORTSDB_API_KEY is missing", async () => {
  delete process.env.THESPORTSDB_API_KEY;
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  await assert.rejects(
    () => adapter.getSeasonSchedule("4350", "2026-2027"),
    (err) => err instanceof adapter.ProviderError && err.reliabilityState === "provider_auth_error"
  );
});

test("getSeasonSchedule returns normalized-raw events on success", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => jsonResponse(200, {
    schedule: [{ idEvent: "1", strHomeTeam: "A", strAwayTeam: "B" }],
  }));
  try {
    const events = await adapter.getSeasonSchedule("4350", "2026-2027");
    assert.equal(events.length, 1);
    assert.equal(events[0].idEvent, "1");
  } finally { restore(); }
});

test("lookupEvent: 'No data found' means event_not_found (unambiguous for this endpoint)", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => jsonResponse(200, { Message: "No data found" }));
  try {
    await assert.rejects(
      () => adapter.lookupEvent("999999999"),
      (err) => err instanceof adapter.ProviderError && err.reliabilityState === "event_not_found"
    );
  } finally { restore(); }
});

test("getLivescore: 'No data found' means a legitimate empty result, NOT an error (DATA-001 §9 ambiguity)", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => jsonResponse(200, { Message: "No data found" }));
  try {
    const events = await adapter.getLivescore("4350");
    assert.deepEqual(events, []);
  } finally { restore(); }
});

test("HTTP 401 maps to provider_auth_error", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => jsonResponse(401, {}));
  try {
    await assert.rejects(
      () => adapter.getSeasonSchedule("4350", "2026-2027"),
      (err) => err.reliabilityState === "provider_auth_error"
    );
  } finally { restore(); }
});

test("HTTP 429 maps to provider_rate_limited", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => jsonResponse(429, {}));
  try {
    await assert.rejects(
      () => adapter.getSeasonSchedule("4350", "2026-2027"),
      (err) => err.reliabilityState === "provider_rate_limited"
    );
  } finally { restore(); }
});

test("HTTP 500 maps to provider_unavailable", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => jsonResponse(500, {}));
  try {
    await assert.rejects(
      () => adapter.getSeasonSchedule("4350", "2026-2027"),
      (err) => err.reliabilityState === "provider_unavailable"
    );
  } finally { restore(); }
});

test("malformed JSON maps to provider_invalid_response", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => ({
    status: 200, ok: true,
    json: async () => { throw new Error("not json"); },
  }));
  try {
    await assert.rejects(
      () => adapter.getSeasonSchedule("4350", "2026-2027"),
      (err) => err.reliabilityState === "provider_invalid_response"
    );
  } finally { restore(); }
});

test("network failure (fetch throws) maps to provider_unavailable", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => { throw new Error("ECONNRESET"); });
  try {
    await assert.rejects(
      () => adapter.getSeasonSchedule("4350", "2026-2027"),
      (err) => err.reliabilityState === "provider_unavailable"
    );
  } finally { restore(); }
});

test("aborted/timed-out request maps to provider_timeout", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  });
  try {
    await assert.rejects(
      () => adapter.getSeasonSchedule("4350", "2026-2027"),
      (err) => err.reliabilityState === "provider_timeout"
    );
  } finally { restore(); }
});

test("getSeasonSchedule: empty-but-legitimate schedule maps to competition_not_supported", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  const restore = mockFetchOnce(async () => jsonResponse(200, { Message: "No data found" }));
  try {
    await assert.rejects(
      () => adapter.getSeasonSchedule("4350", "2026-2027"),
      (err) => err.reliabilityState === "competition_not_supported"
    );
  } finally { restore(); }
});

// ---- provider_incomplete_response heuristic (QA fix: DATA-001.1 §6) ----

function fakeMatch(round, homeId, awayId) {
  return { intRound: String(round), idHomeTeam: String(homeId), idAwayTeam: String(awayId), strHomeTeam: "H" + homeId, strAwayTeam: "A" + awayId };
}

test("getSeasonSchedule: a full season (rounds spanning well past 2) is accepted as complete", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  // 18-team-shaped league, rounds 1..17 — same shape as the real Liga MX
  // spike evidence (153 events, rounds 1-17).
  const schedule = [];
  for (let round = 1; round <= 17; round++) {
    for (let i = 0; i < 9; i++) schedule.push(fakeMatch(round, i * 2, i * 2 + 1));
  }
  const restore = mockFetchOnce(async () => jsonResponse(200, { schedule }));
  try {
    const events = await adapter.getSeasonSchedule("4350", "2026-2027");
    assert.equal(events.length, 153);
  } finally { restore(); }
});

test("getSeasonSchedule: response capped at round <=2 for an 18-team league is flagged provider_incomplete_response", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  // Reproduces the exact real-world V1 free-tier bug shape: 15 events,
  // rounds 1-2 only, but 18 distinct teams already visible in round 1 alone
  // (9 matches) — structurally impossible for that league to have finished
  // at round 2.
  const schedule = [];
  for (let i = 0; i < 9; i++) schedule.push(fakeMatch(1, i * 2, i * 2 + 1));   // round 1: 9 matches, 18 teams
  for (let i = 0; i < 6; i++) schedule.push(fakeMatch(2, i * 2, i * 2 + 1));   // round 2: 6 more (partial), 15 total
  assert.equal(schedule.length, 15);
  const restore = mockFetchOnce(async () => jsonResponse(200, { schedule }));
  try {
    await assert.rejects(
      () => adapter.getSeasonSchedule("4350", "2026-2027"),
      (err) => err instanceof adapter.ProviderError && err.reliabilityState === "provider_incomplete_response"
    );
  } finally { restore(); }
});

test("getSeasonSchedule: a genuinely small competition (4-team mini-cup, 2 rounds) is NOT a false positive", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  // A legitimate 4-team knockout: semifinals (round 1, 2 matches, 4 teams)
  // + final (round 2, 1 match). Only 4 distinct participants — well under
  // the 6-participant threshold that implies a round-robin league too big
  // to end at round 2 — so this must be accepted as complete, not flagged.
  const schedule = [
    fakeMatch(1, 1, 2), fakeMatch(1, 3, 4), // semis
    fakeMatch(2, 1, 3),                     // final
  ];
  const restore = mockFetchOnce(async () => jsonResponse(200, { schedule }));
  try {
    const events = await adapter.getSeasonSchedule("9999", "2026");
    assert.equal(events.length, 3);
  } finally { restore(); }
});

test("_detectIncompleteSchedule: no round data present -> does not guess, returns false", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  const adapter = require("../providers/theSportsDbAdapter");
  assert.equal(adapter._detectIncompleteSchedule([{ idHomeTeam: "1", idAwayTeam: "2" }]), false);
  assert.equal(adapter._detectIncompleteSchedule([]), false);
});
