// AUTO-002 (bulk validation round) — tests for the "buscar resultados
// pendientes (todas)" flow: GET /api/quinielas/:slug/sports-results.
//
// server.js can't be require()'d in tests (connects to a live Postgres
// instance at import time). The actual eligibility decision is the pure,
// already-tested isRoundEligibleForAutoResults() (see autoResults.test.js)
// — this file (1) re-runs that same real function against the EXACT
// 17-round scenario from the ticket to prove the resulting round set is
// precisely {J6, J7}, and (2) does structural checks against the real
// server.js source to confirm the endpoint calls the provider exactly once
// (outside any per-round loop) and never writes to meta.rounds — i.e. it's
// genuinely read-only, so a provider failure can't touch existing results.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isRoundEligibleForAutoResults } = require("../autoResults");

function ticketScenarioRounds() {
  const rounds = [];
  for (let n = 1; n <= 5; n++) {
    rounds.push({ id: "r_j" + n, number: n, resultsPublished: true, published: true, deadline: "2020-01-01T00:00:00.000Z" });
  }
  for (let n = 6; n <= 7; n++) {
    rounds.push({ id: "r_j" + n, number: n, resultsPublished: false, published: true, deadline: "2020-01-01T00:00:00.000Z" });
  }
  rounds.push({ id: "r_j8", number: 8, resultsPublished: false, published: true, deadline: "2099-01-01T00:00:00.000Z" });
  for (let n = 9; n <= 17; n++) {
    rounds.push({ id: "r_j" + n, number: n, resultsPublished: false, published: false, deadline: "2020-01-01T00:00:00.000Z" });
  }
  return rounds;
}

test("1. exact ticket scenario: J1-J5 resultsPublished, J6-J7 eligible+closed, J8 eligible+future, J9-J17 unpublished", () => {
  const rounds = ticketScenarioRounds();
  assert.equal(rounds.length, 17);
});

test("2/3/4/5. only J6 and J7 are eligible — J1-J5, J8, J9-J17 all excluded", () => {
  const rounds = ticketScenarioRounds();
  const eligible = rounds.filter((r) => isRoundEligibleForAutoResults(r, new Date("2026-08-19").getTime()));
  assert.deepEqual(eligible.map((r) => r.number).sort((a, b) => a - b), [6, 7]);
});

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extractRouteHandler(source, routeSignature) {
  const start = source.indexOf(routeSignature);
  assert.ok(start !== -1, `could not locate route "${routeSignature}"`);
  const braceStart = source.indexOf("{", source.indexOf("async (req, res) => {", start));
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

test("6. the bulk endpoint calls getSeasonEvents() exactly once, outside the per-round loop (one fetch serves every eligible round)", () => {
  const body = extractRouteHandler(serverSrc, 'app.get("/api/quinielas/:slug/sports-results"');
  const getEventsIdx = body.indexOf("sportsDataProvider.getSeasonEvents(");
  const loopIdx = body.indexOf("for (const round of eligibleRounds)");
  assert.ok(getEventsIdx !== -1, "must call getSeasonEvents()");
  assert.ok(loopIdx !== -1, "must loop over eligibleRounds to build suggestions");
  assert.ok(getEventsIdx < loopIdx, "getSeasonEvents() must be called BEFORE the per-round loop, not inside it");
  // Only one occurrence in this handler — confirms it isn't called again per round.
  const occurrences = body.split("sportsDataProvider.getSeasonEvents(").length - 1;
  assert.equal(occurrences, 1, "getSeasonEvents() must appear exactly once in this handler");
});

test("6b. the bulk endpoint filters eligibility BEFORE calling the provider (0 eligible -> 0 calls)", () => {
  const body = extractRouteHandler(serverSrc, 'app.get("/api/quinielas/:slug/sports-results"');
  const filterIdx = body.indexOf("isRoundEligibleForAutoResults(r)");
  const getEventsIdx = body.indexOf("sportsDataProvider.getSeasonEvents(");
  assert.ok(filterIdx !== -1 && filterIdx < getEventsIdx, "eligibility filtering must happen before any provider call");
  assert.ok(body.includes("if (!eligibleRounds.length)"), "must short-circuit with zero eligible rounds, never reaching the provider");
});

test("7/22. provider failure in the bulk endpoint never writes to meta.rounds (read-only, results not at risk)", () => {
  const body = extractRouteHandler(serverSrc, 'app.get("/api/quinielas/:slug/sports-results"');
  assert.ok(!body.includes("putRow("), "the bulk endpoint must never persist anything — it only reads and returns suggestions");
  assert.ok(!body.includes("resultsPublished ="), "must never touch resultsPublished");
  assert.ok(!body.includes(".published ="), "must never touch published");
});

test("9. results are never auto-published — the bulk endpoint response shape only contains suggestions, never a publish action", () => {
  const body = extractRouteHandler(serverSrc, 'app.get("/api/quinielas/:slug/sports-results"');
  assert.ok(body.includes("res.json({ ok: true, reliabilityState: null, results });"), "success response must only return suggestions grouped by round, nothing else");
});

test("10. the single-round endpoint (individual search fallback) is still present and unchanged in shape", () => {
  assert.ok(serverSrc.includes('app.get("/api/quinielas/:slug/rounds/:roundId/sports-results"'), "the per-round endpoint must still exist as a fallback");
  const body = extractRouteHandler(serverSrc, 'app.get("/api/quinielas/:slug/rounds/:roundId/sports-results"');
  assert.ok(body.includes("buildRoundSuggestions(round, events)"), "the single-round endpoint must use the same shared matching logic as the bulk one");
});

test("shared matching logic: buildRoundSuggestions is defined once and used by both endpoints (no duplicated matching rules to drift apart)", () => {
  const defOccurrences = serverSrc.split("function buildRoundSuggestions(").length - 1;
  assert.equal(defOccurrences, 1, "buildRoundSuggestions must be defined exactly once");
  // Total occurrences of the exact call-site string include the definition
  // itself (same parameter names) plus each real call site — 3 total means
  // 1 definition + 2 call sites (single-round endpoint + bulk loop).
  const totalOccurrences = serverSrc.split("buildRoundSuggestions(round, events)").length - 1;
  assert.equal(totalOccurrences, 3, "expected 1 definition + 2 call sites (single-round endpoint and bulk loop)");
});
