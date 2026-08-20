// AUTO-002 — Tests for autoResults.js (isRoundEligibleForAutoResults)
const test = require("node:test");
const assert = require("node:assert/strict");
const { isRoundEligibleForAutoResults } = require("../autoResults");

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const NOW = new Date("2026-08-19T00:00:00.000Z").getTime();

test("unpublished (published:false) is never eligible, even past deadline", () => {
  assert.equal(isRoundEligibleForAutoResults({ published: false, resultsPublished: false, deadline: PAST }, NOW), false);
});

test("published + resultsPublished:true is not eligible (already resolved, QRACKS is now the source of truth)", () => {
  assert.equal(isRoundEligibleForAutoResults({ published: true, resultsPublished: true, deadline: PAST }, NOW), false);
});

test("published + pending + deadline passed IS eligible", () => {
  assert.equal(isRoundEligibleForAutoResults({ published: true, resultsPublished: false, deadline: PAST }, NOW), true);
});

test("legacy (published undefined) + pending + deadline passed IS eligible, same as published:true", () => {
  assert.equal(isRoundEligibleForAutoResults({ resultsPublished: false, deadline: PAST }, NOW), true);
});

test("published + pending but deadline still in the future is NOT eligible (nothing could have finished)", () => {
  assert.equal(isRoundEligibleForAutoResults({ published: true, resultsPublished: false, deadline: FUTURE }, NOW), false);
});

test("no usable deadline -> not eligible, never guessed", () => {
  assert.equal(isRoundEligibleForAutoResults({ published: true, resultsPublished: false, deadline: "not-a-date" }, NOW), false);
  assert.equal(isRoundEligibleForAutoResults({ published: true, resultsPublished: false }, NOW), false);
});

test("resultsPublished:true wins even if published were somehow false (defensive, shouldn't happen given AUTO-001 hotfix's own guard)", () => {
  assert.equal(isRoundEligibleForAutoResults({ published: false, resultsPublished: true, deadline: PAST }, NOW), false);
});
