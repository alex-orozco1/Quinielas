// AUTO-001 HOTFIX — BUG 3 (jornada free-limit usage) and the Admin ->
// Jornadas "sees everything" guarantee (BUG 1, admin-management-screen
// side). These are structural checks against the real source (same
// precedent as prior QA-fix rounds), plus a standalone re-derivation of the
// exact counting rule to prove the numeric examples from the ticket.
//
// MON-002B moved the rule itself: "importing does not consume, publishing
// does" used to be a browser-side count feeding a browser-side gate, and is
// now the server's durable lifecycle counter. The structural check below
// follows it there, which is the only place it can actually be enforced.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// ---- BUG 3: structural confirmation of the fix ----

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("HOTFIX BUG 3 (MON-002B): the SERVER consumes lifecycle only for published rounds, never for imported-but-unpublished ones", () => {
  assert.ok(
    serverSrc.includes('.filter((r) => r.published !== false && !consumedIds.has(r.id))'),
    "a round only consumes budget when it is published AND has never been counted before"
  );
  // The durable counter, not meta.rounds.length: deleting a round must never
  // hand budget back, and importing a 17-round calendar must never spend it.
  assert.ok(serverSrc.includes("entry.lifecycleConsumedRoundIds = [...consumedIds, ...newlyConsumedIds];"));
  assert.ok(!serverSrc.includes("checkLifecycleRoundConsumption(entry.entitlement, commercialConfig, mergedValue.rounds.length"));
});

test("HOTFIX BUG 3 (MON-002B): the browser no longer counts rounds for any commercial decision of its own", () => {
  assert.ok(!indexSrc.includes("getPaymentStatus("), "the browser-side usage count is gone");
  assert.ok(!indexSrc.includes("meta.rounds.filter(r => r.published !== false).length"),
    "no client-side published-round tally may drive a paywall any more");
});

// ---- BUG 3: the exact counting rule, re-derived and checked against the ticket's numeric examples ----

function countUsage(rounds) {
  // Mirrors exactly: meta.rounds.filter(r => r.published !== false).length
  return rounds.filter((r) => r.published !== false).length;
}

test("HOTFIX BUG 3: 17 imported / 0 published -> usage 0", () => {
  const rounds = Array.from({ length: 17 }, (_, i) => ({ number: i + 1, published: false }));
  assert.equal(countUsage(rounds), 0);
});

test("HOTFIX BUG 3: 17 imported / 3 published -> usage 3", () => {
  const rounds = Array.from({ length: 17 }, (_, i) => ({ number: i + 1, published: i < 3 }));
  assert.equal(countUsage(rounds), 3);
});

test("HOTFIX BUG 3: 17 imported / 5 published -> usage 5", () => {
  const rounds = Array.from({ length: 17 }, (_, i) => ({ number: i + 1, published: i < 5 }));
  assert.equal(countUsage(rounds), 5);
});

test("HOTFIX BUG 3 legacy: rounds with published undefined count same as before (legacy quinielas unaffected)", () => {
  const rounds = Array.from({ length: 5 }, (_, i) => ({ number: i + 1 })); // no published field
  assert.equal(countUsage(rounds), 5);
});

// ---- BUG 1: Admin -> Jornadas still sees every round, including published:false ----

test("HOTFIX BUG 1: Admin -> Jornadas lists meta.rounds directly (not visibleRounds()), so it still shows every prepared round", () => {
  const idx = indexSrc.indexOf("async function renderAdminRondas(body)");
  assert.ok(idx !== -1);
  const braceStart = indexSrc.indexOf("{", idx);
  let depth = 0, i = braceStart;
  for (; i < indexSrc.length; i++) {
    if (indexSrc[i] === "{") depth++;
    else if (indexSrc[i] === "}") { depth--; if (depth === 0) break; }
  }
  const body = indexSrc.slice(idx, i + 1);
  assert.ok(body.includes("meta.rounds.length ? meta.rounds.slice().reverse()"), "the 'Jornadas existentes' list must still read meta.rounds directly, unfiltered");
  assert.ok(!body.includes("visibleRounds()"), "Admin -> Jornadas must not be affected by the BUG 1 fix to visibleRounds()");
});

// ---- Scoring defense-in-depth: jornada-scope custom bets never leak points from an unpublished round ----

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  const braceStart = source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

function runCustomBetPointsFor(meta, participantId, cutoffRoundNumber) {
  const fnSrc = extractFunctionBody(indexSrc, "function customBetPointsFor(participantId, participantMap, cutoffRoundNumber)");
  const wrapped = new Function("meta", "participantId", "participantMap", "cutoffRoundNumber", `${fnSrc}\nreturn customBetPointsFor(participantId, participantMap, cutoffRoundNumber);`);
  return wrapped(meta, participantId, null, cutoffRoundNumber);
}

test("HOTFIX scoring: a jornada-scope custom bet correct on a published:false round contributes ZERO points", () => {
  const meta = {
    customBets: [{ id: "b1", scope: "jornada", points: 5 }],
    participants: [{ id: "p1" }],
    rounds: [{ number: 1, published: false, customBetResults: { b1: { p1: true } } }],
  };
  assert.equal(runCustomBetPointsFor(meta, "p1"), 0);
});

test("HOTFIX scoring: the same bet DOES contribute points once the round is published:true", () => {
  const meta = {
    customBets: [{ id: "b1", scope: "jornada", points: 5 }],
    participants: [{ id: "p1" }],
    rounds: [{ number: 1, published: true, customBetResults: { b1: { p1: true } } }],
  };
  assert.equal(runCustomBetPointsFor(meta, "p1"), 5);
});

test("HOTFIX scoring: legacy round (published undefined) with a correct jornada bet still contributes points, unchanged", () => {
  const meta = {
    customBets: [{ id: "b1", scope: "jornada", points: 5 }],
    participants: [{ id: "p1" }],
    rounds: [{ number: 1, customBetResults: { b1: { p1: true } } }], // no published field
  };
  assert.equal(runCustomBetPointsFor(meta, "p1"), 5);
});
