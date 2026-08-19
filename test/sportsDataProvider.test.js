// Tests for sportsDataProvider.js — DATA-001 Paso 16 "Provider" tests.
// Run with: node --test test/

const test = require("node:test");
const assert = require("node:assert/strict");

function freshProvider() {
  delete require.cache[require.resolve("../sportsDataProvider")];
  delete require.cache[require.resolve("../providers/theSportsDbAdapter")];
  return require("../sportsDataProvider");
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// ---- normalizeEvent ----

test("normalizeEvent: finished match with score", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const norm = provider.normalizeEvent({
    idEvent: "2487452", idLeague: "4350",
    strHomeTeam: "Necaxa", strAwayTeam: "Atlante",
    idHomeTeam: "135662", idAwayTeam: "134203",
    intHomeScore: "2", intAwayScore: "1",
    strStatus: "FT", strTimestamp: "2026-07-17T01:00:00",
    strPostponed: "no",
  }, "thesportsdb");
  assert.equal(norm.status, "finished");
  assert.deepEqual(norm.score, { home: 2, away: 1 });
  assert.equal(norm.participants[0].role, "home");
  assert.equal(norm.participants[0].name, "Necaxa");
  assert.equal(norm.externalEventId, "2487452");
});

test("normalizeEvent: future match has no score and status scheduled", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const norm = provider.normalizeEvent({
    idEvent: "2487602", idLeague: "4350",
    strHomeTeam: "Tigres UANL", strAwayTeam: "América",
    intHomeScore: null, intAwayScore: null,
    strStatus: "NS", strTimestamp: "2026-11-22T03:00:00",
    strPostponed: "no",
  }, "thesportsdb");
  assert.equal(norm.status, "scheduled");
  assert.equal(norm.score, null);
});

test("normalizeEvent: postponed flag overrides status", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const norm = provider.normalizeEvent({
    idEvent: "1", strStatus: "NS", strPostponed: "yes",
  }, "thesportsdb");
  assert.equal(norm.status, "postponed");
});

// ---- timestamp normalization (QA fix: don't blindly append "Z") ----

test("normalizeTimestamp: no timezone marker -> treated as UTC, gets Z appended", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const iso = provider._normalizeTimestamp("2026-07-17T01:00:00");
  assert.equal(iso, "2026-07-17T01:00:00.000Z");
});

test("normalizeTimestamp: already ends in Z -> not double-suffixed", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const iso = provider._normalizeTimestamp("2026-07-17T01:00:00Z");
  assert.equal(iso, "2026-07-17T01:00:00.000Z");
});

test("normalizeTimestamp: explicit +00:00 offset -> respected, not double-suffixed", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const iso = provider._normalizeTimestamp("2026-07-17T01:00:00+00:00");
  assert.equal(iso, "2026-07-17T01:00:00.000Z");
});

test("normalizeTimestamp: non-UTC offset is converted correctly, not treated as UTC", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const iso = provider._normalizeTimestamp("2026-07-17T01:00:00-05:00");
  // 01:00 at -05:00 is 06:00 UTC — must NOT come out as 01:00Z (which the
  // old "always append Z" bug would have produced by ignoring the offset).
  assert.equal(iso, "2026-07-17T06:00:00.000Z");
});

test("normalizeTimestamp: unparseable input returns null instead of an Invalid Date", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  assert.equal(provider._normalizeTimestamp("not-a-date"), null);
  assert.equal(provider._normalizeTimestamp(""), null);
  assert.equal(provider._normalizeTimestamp(null), null);
});

test("normalizeEvent + findMatchingEvent: matching works for all three real timestamp formats", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const formats = [
    "2026-07-17T01:00:00",       // no timezone (observed real shape)
    "2026-07-17T01:00:00Z",      // explicit Z
    "2026-07-17T01:00:00+00:00", // explicit UTC offset
  ];
  for (const strTimestamp of formats) {
    const events = [provider.normalizeEvent({
      idEvent: "1", strHomeTeam: "Necaxa", strAwayTeam: "Atlante",
      intHomeScore: "2", intAwayScore: "1", strStatus: "FT",
      strTimestamp,
    }, "thesportsdb")];
    assert.ok(!Number.isNaN(new Date(events[0].dateTime).getTime()), `dateTime should be valid for input "${strTimestamp}"`);
    const hit = provider.findMatchingEvent(events, { teamA: "Necaxa", teamB: "Atlante" }, "2026-07-17T00:00:00Z");
    assert.ok(hit, `matching should succeed for timestamp format "${strTimestamp}"`);
    assert.equal(hit.externalEventId, "1");
  }
});

// ---- findMatchingEvent ----

test("findMatchingEvent: fast path via externalEventId", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const events = [
    provider.normalizeEvent({ idEvent: "1", strHomeTeam: "X", strAwayTeam: "Y", intHomeScore: "1", intAwayScore: "0", strStatus: "FT", strTimestamp: "2026-07-17T01:00:00" }, "thesportsdb"),
    provider.normalizeEvent({ idEvent: "2", strHomeTeam: "Necaxa", strAwayTeam: "Atlante", intHomeScore: "2", intAwayScore: "1", strStatus: "FT", strTimestamp: "2026-07-17T01:00:00" }, "thesportsdb"),
  ];
  const hit = provider.findMatchingEvent(events, { teamA: "whatever", teamB: "irrelevant", externalEventId: "2" }, "2026-07-17T00:00:00");
  assert.equal(hit.externalEventId, "2");
});

test("findMatchingEvent: fuzzy team-name fallback within date window", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const events = [
    provider.normalizeEvent({ idEvent: "1", strHomeTeam: "Necaxa", strAwayTeam: "Atlante", intHomeScore: "2", intAwayScore: "1", strStatus: "FT", strTimestamp: "2026-07-17T01:00:00" }, "thesportsdb"),
  ];
  const hit = provider.findMatchingEvent(events, { teamA: "Necaxa", teamB: "Atlante" }, "2026-07-17T00:00:00");
  assert.ok(hit);
  assert.equal(hit.externalEventId, "1");
});

test("findMatchingEvent: known alias (América) matches TheSportsDB's 'CF America'", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  assert.ok(provider._teamsMatch("América", "CF America"));
  assert.ok(provider._teamsMatch("Chivas", "CD Guadalajara"));
});

test("findMatchingEvent: does not suggest a not-yet-finished match", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const events = [
    provider.normalizeEvent({ idEvent: "1", strHomeTeam: "Necaxa", strAwayTeam: "Atlante", intHomeScore: null, intAwayScore: null, strStatus: "NS", strTimestamp: "2026-07-17T01:00:00" }, "thesportsdb"),
  ];
  const hit = provider.findMatchingEvent(events, { teamA: "Necaxa", teamB: "Atlante" }, "2026-07-17T00:00:00");
  assert.equal(hit, null);
});

test("findMatchingEvent: outside the ~20 day window is not matched", () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const events = [
    provider.normalizeEvent({ idEvent: "1", strHomeTeam: "Necaxa", strAwayTeam: "Atlante", intHomeScore: "2", intAwayScore: "1", strStatus: "FT", strTimestamp: "2026-01-01T01:00:00" }, "thesportsdb"),
  ];
  const hit = provider.findMatchingEvent(events, { teamA: "Necaxa", teamB: "Atlante" }, "2026-07-17T00:00:00");
  assert.equal(hit, null);
});

// ---- unknown provider guard ----

test("getSeasonEvents rejects unknown provider with competition_not_supported", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  await assert.rejects(
    () => provider.getSeasonEvents({ provider: "some-other-provider", externalLeagueId: "1", season: "2026" }),
    (err) => err.reliabilityState === "competition_not_supported"
  );
});

// ---- caching ----

test("getSeasonEvents caches successful results (second call does not re-fetch)", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { calls++; return jsonResponse(200, { schedule: [{ idEvent: "1" }] }); };
  try {
    await provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" });
    await provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" });
    assert.equal(calls, 1, "second call should be served from cache, not hit the network again");
  } finally { global.fetch = originalFetch; }
});

test("getSeasonEvents NEVER caches a failure (next call retries against the network)", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { calls++; return jsonResponse(500, {}); };
  try {
    await assert.rejects(() => provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" }));
    await assert.rejects(() => provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" }));
    assert.equal(calls, 2, "a failed lookup must never be cached — every call should hit the network again");
  } finally { global.fetch = originalFetch; }
});

test("different league/season keys do not share a cache entry", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { calls++; return jsonResponse(200, { schedule: [] }); };
  try {
    await provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" });
    await provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4328", season: "2025-2026" });
    assert.equal(calls, 2);
  } finally { global.fetch = originalFetch; }
});

// ---- provider_incomplete_response propagation through the cache layer (QA fix) ----

function fakeMatchRaw(round, homeId, awayId) {
  return { intRound: String(round), idHomeTeam: String(homeId), idAwayTeam: String(awayId), strHomeTeam: "H" + homeId, strAwayTeam: "A" + awayId };
}

test("getSeasonEvents: a complete season schedule is accepted AND cached", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const schedule = [];
  for (let round = 1; round <= 17; round++) {
    for (let i = 0; i < 9; i++) schedule.push(fakeMatchRaw(round, i * 2, i * 2 + 1));
  }
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { calls++; return jsonResponse(200, { schedule }); };
  try {
    const events = await provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" });
    assert.equal(events.length, 153);
    await provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" });
    assert.equal(calls, 1, "a complete response should be cached — second call must not re-fetch");
  } finally { global.fetch = originalFetch; }
});

test("getSeasonEvents: a truncated-looking season schedule is rejected with provider_incomplete_response and is NEVER cached", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const schedule = [];
  for (let i = 0; i < 9; i++) schedule.push(fakeMatchRaw(1, i * 2, i * 2 + 1));
  for (let i = 0; i < 6; i++) schedule.push(fakeMatchRaw(2, i * 2, i * 2 + 1));
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { calls++; return jsonResponse(200, { schedule }); };
  try {
    await assert.rejects(
      () => provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" }),
      (err) => err.reliabilityState === "provider_incomplete_response"
    );
    // Retry immediately after — must hit the network again, proving the
    // incomplete result was never written to cache.
    await assert.rejects(
      () => provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" }),
      (err) => err.reliabilityState === "provider_incomplete_response"
    );
    assert.equal(calls, 2, "an incomplete-looking response must never be cached — every call should hit the network again");
  } finally { global.fetch = originalFetch; }
});

test("getSeasonEvents: once the provider self-heals (returns a full schedule), the next call succeeds and caches normally", async () => {
  process.env.THESPORTSDB_API_KEY = "test-key";
  const provider = freshProvider();
  const truncated = [];
  for (let i = 0; i < 9; i++) truncated.push(fakeMatchRaw(1, i * 2, i * 2 + 1));
  for (let i = 0; i < 6; i++) truncated.push(fakeMatchRaw(2, i * 2, i * 2 + 1));
  const full = [];
  for (let round = 1; round <= 17; round++) {
    for (let i = 0; i < 9; i++) full.push(fakeMatchRaw(round, i * 2, i * 2 + 1));
  }
  let call = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    call++;
    return jsonResponse(200, { schedule: call === 1 ? truncated : full });
  };
  try {
    await assert.rejects(() => provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" }));
    const events = await provider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId: "4350", season: "2026-2027" });
    assert.equal(events.length, 153);
    assert.equal(call, 2);
  } finally { global.fetch = originalFetch; }
});
