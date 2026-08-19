// AUTO-001 §17 — Tests for seasonDefaults.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { currentDefaultSeason } = require("../seasonDefaults");

test("August (mid-season start) returns startYear-startYear+1 with startYear = current year", () => {
  assert.equal(currentDefaultSeason(new Date("2026-08-19T00:00:00Z")), "2026-2027");
});

test("July 1st (season boundary) already counts as the new season", () => {
  assert.equal(currentDefaultSeason(new Date("2026-07-01T00:00:00Z")), "2026-2027");
});

test("June (before the boundary) still belongs to the season that started the previous year", () => {
  assert.equal(currentDefaultSeason(new Date("2026-06-30T23:59:59Z")), "2025-2026");
});

test("January (mid-season, still the previous year's start) returns startYear-1 correctly", () => {
  assert.equal(currentDefaultSeason(new Date("2027-01-15T00:00:00Z")), "2026-2027");
});

test("no argument defaults to the real current date and returns a well-formed string", () => {
  const result = currentDefaultSeason();
  assert.match(result, /^\d{4}-\d{4}$/);
});
