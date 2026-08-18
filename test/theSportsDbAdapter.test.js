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
