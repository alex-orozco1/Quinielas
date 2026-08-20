// AUTO-001 HOTFIX — BUG 3 (jornada free-limit usage) and the Admin ->
// Jornadas "sees everything" guarantee (BUG 1, admin-management-screen
// side). getPaymentStatus() closes over SLUG/meta/fetch/ROUTE — too many
// live dependencies to isolate-eval cleanly, so these are structural
// checks against the real source (same precedent as prior QA-fix rounds),
// plus a standalone re-derivation of the exact counting rule to prove the
// numeric examples from the ticket.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// ---- BUG 3: structural confirmation of the fix ----

test("HOTFIX BUG 3: getPaymentStatus counts only published !== false rounds, not meta.rounds.length directly", () => {
  const idx = indexSrc.indexOf("async function getPaymentStatus()");
  assert.ok(idx !== -1);
  const braceStart = indexSrc.indexOf("{", idx);
  let depth = 0, i = braceStart;
  for (; i < indexSrc.length; i++) {
    if (indexSrc[i] === "{") depth++;
    else if (indexSrc[i] === "}") { depth--; if (depth === 0) break; }
  }
  const body = indexSrc.slice(idx, i + 1);
  assert.ok(body.includes("meta.rounds.filter(r => r.published !== false).length"), "roundCount must be computed from published rounds only, not meta.rounds.length");
  assert.ok(!body.includes("const roundCount = meta.rounds.length;"), "the old unconditional count must be gone");
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
