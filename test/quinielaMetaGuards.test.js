// AUTO-001 HOTFIX — BUG 2 backend defense-in-depth tests.
//
// server.js can't be require()'d directly (connects to a real Postgres
// instance at import time — same documented limitation as always). Both
// functions tested here are pure enough to extract and execute in
// isolation: stripQuinielaSecrets() only touches its own parameters, and
// validatePicksDeadline() only calls getRow() when preloadedMeta is
// omitted — every test here always supplies preloadedMeta, so the real
// function runs with zero DB dependency. This is genuine behavioral
// coverage of the actual production code, not a reimplementation.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extractFunctionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}" in server.js`);
  const braceStart = source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

function runStripQuinielaSecrets(value, isAdminOrOwner, selfParticipantId) {
  const fnSrc = extractFunctionSource(serverSrc, "function stripQuinielaSecrets(value, isAdminOrOwner, selfParticipantId)");
  const wrapped = new Function(`${fnSrc}\nreturn stripQuinielaSecrets(...arguments);`);
  return wrapped(value, isAdminOrOwner, selfParticipantId);
}

async function runValidatePicksDeadline(info, oldValue, newValue, preloadedMeta, nowMs) {
  const fnSrc = extractFunctionSource(serverSrc, "async function validatePicksDeadline(info, oldValue, newValue, preloadedMeta, nowMs)")
    .replace("async function validatePicksDeadline", "async function _validatePicksDeadline");
  const wrapped = new Function(`
    ${fnSrc}
    return _validatePicksDeadline(...arguments);
  `);
  return wrapped(info, oldValue, newValue, preloadedMeta, nowMs);
}

// ---- BUG 2: stripQuinielaSecrets excludes published:false rounds for non-admin ----

test("HOTFIX BUG 2: stripQuinielaSecrets removes published:false rounds for a non-admin/owner requester", () => {
  const value = { rounds: [{ id: "r1", published: false }, { id: "r2", published: true }, { id: "r3" }] };
  const result = runStripQuinielaSecrets(value, false, null);
  assert.deepEqual(result.rounds.map((r) => r.id), ["r2", "r3"]);
});

test("HOTFIX BUG 2: stripQuinielaSecrets keeps published:false rounds for admin/owner", () => {
  const value = { rounds: [{ id: "r1", published: false }, { id: "r2", published: true }] };
  const result = runStripQuinielaSecrets(value, true, null);
  assert.deepEqual(result.rounds.map((r) => r.id), ["r1", "r2"]);
});

test("HOTFIX BUG 2: legacy rounds (published undefined) still reach non-admin requesters", () => {
  const value = { rounds: [{ id: "legacy-round" }] };
  const result = runStripQuinielaSecrets(value, false, null);
  assert.deepEqual(result.rounds.map((r) => r.id), ["legacy-round"]);
});

test("stripQuinielaSecrets: pre-existing secret-stripping behavior (ownerPassword, PIN) is unchanged", () => {
  const value = {
    settings: { ownerPassword: "hash123" },
    participants: [{ id: "p1", pin: "1234" }],
    rounds: [],
  };
  const result = runStripQuinielaSecrets(value, false, null);
  assert.equal("ownerPassword" in result.settings, false);
  assert.equal("pin" in result.participants[0], false);
  assert.equal(result.participants[0].hasPin, true);
});

// ---- BUG 2: validatePicksDeadline blocks writes to published:false rounds ----

test("HOTFIX BUG 2: validatePicksDeadline rejects a NEW pick on a published:false round even before its deadline", async () => {
  const meta = { rounds: [{ id: "r1", published: false, deadline: "2099-01-01T00:00:00Z" }] };
  const result = await runValidatePicksDeadline(
    { metaKey: "k" }, {}, { r1: { m1: "A" } }, meta, Date.now()
  );
  assert.equal(result.ok, false);
});

test("validatePicksDeadline: a published:true round with a future deadline still accepts new picks", async () => {
  const meta = { rounds: [{ id: "r1", published: true, deadline: "2099-01-01T00:00:00Z" }] };
  const result = await runValidatePicksDeadline(
    { metaKey: "k" }, {}, { r1: { m1: "A" } }, meta, Date.now()
  );
  assert.equal(result.ok, true);
});

test("validatePicksDeadline: legacy round (published undefined) with a future deadline still accepts new picks", async () => {
  const meta = { rounds: [{ id: "r1", deadline: "2099-01-01T00:00:00Z" }] }; // no published field at all
  const result = await runValidatePicksDeadline(
    { metaKey: "k" }, {}, { r1: { m1: "A" } }, meta, Date.now()
  );
  assert.equal(result.ok, true);
});

test("validatePicksDeadline: an unchanged value for a published:false round is still ok (no-op writes never blocked)", async () => {
  const meta = { rounds: [{ id: "r1", published: false, deadline: "2099-01-01T00:00:00Z" }] };
  const result = await runValidatePicksDeadline(
    { metaKey: "k" }, { r1: { m1: "A" } }, { r1: { m1: "A" } }, meta, Date.now()
  );
  assert.equal(result.ok, true);
});

test("validatePicksDeadline: past-deadline behavior for published rounds is unchanged (pre-existing rule)", async () => {
  const meta = { rounds: [{ id: "r1", published: true, deadline: "2020-01-01T00:00:00Z" }] };
  const result = await runValidatePicksDeadline(
    { metaKey: "k" }, {}, { r1: { m1: "A" } }, meta, Date.now()
  );
  assert.equal(result.ok, false);
});

// ---- Validation-round hotfix: server-side guard against publishing results
// for an unpublished round via a direct API call (bypassing the frontend
// click-handler guard entirely) — real bug found via live end-to-end HTTP
// testing against a real running server + real Postgres, not caught by the
// previous round's tests because they only covered the frontend handler. ----

function runValidateRoundsIntegrity(newValue) {
  const constSrc = "const VALID_RESULT_VALUES = new Set([\"A\", \"D\", \"B\"]);";
  const fnSrc = extractFunctionSource(serverSrc, "function validateRoundsIntegrity(newValue)");
  const wrapped = new Function(`${constSrc}\n${fnSrc}\nreturn validateRoundsIntegrity(...arguments);`);
  return wrapped(newValue);
}

test("HOTFIX (validation round): validateRoundsIntegrity rejects resultsPublished:true on a published:false round", () => {
  const newValue = { rounds: [{ number: 2, published: false, resultsPublished: true, results: { m1: "A" }, matches: [{ id: "m1" }] }] };
  const result = runValidateRoundsIntegrity(newValue);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unpublished_round_results");
  assert.equal(result.roundNumber, 2);
});

test("HOTFIX (validation round): validateRoundsIntegrity still accepts resultsPublished:true on a published:true round with complete results (pre-existing behavior unchanged)", () => {
  const newValue = { rounds: [{ number: 1, published: true, resultsPublished: true, results: { m1: "A" }, matches: [{ id: "m1" }] }] };
  const result = runValidateRoundsIntegrity(newValue);
  assert.equal(result.ok, true);
});

test("HOTFIX (validation round): validateRoundsIntegrity still accepts resultsPublished:true on a legacy round (published undefined) with complete results", () => {
  const newValue = { rounds: [{ number: 1, resultsPublished: true, results: { m1: "A" }, matches: [{ id: "m1" }] }] }; // no published field
  const result = runValidateRoundsIntegrity(newValue);
  assert.equal(result.ok, true);
});

test("HOTFIX (validation round): the pre-existing incomplete_results check still fires for a published round missing a result", () => {
  const newValue = { rounds: [{ number: 1, published: true, resultsPublished: true, results: {}, matches: [{ id: "m1" }] }] };
  const result = runValidateRoundsIntegrity(newValue);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "incomplete_results");
});
