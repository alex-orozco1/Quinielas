// MON-001E — Round Model: display vs commercial key.
// Executes the REAL planCompetitionSync/normalizeEvent, using the REAL
// Liga MX evidence captured in DATA-002/MON-001D.2 (intRound 0/125/200,
// two-legged 200, Apertura+Clausura sharing one strSeason).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { planCompetitionSync } = require("../competitionSync");

const P = "thesportsdb";
function ev(round, dateTime, id, meta) {
  return {
    provider: P, externalLeagueId: "4350", externalEventId: id, round,
    status: "scheduled", dateTime,
    participants: [{ role: "home", externalId: "h" + id, name: "Local" + id },
                   { role: "away", externalId: "a" + id, name: "Visita" + id }],
    score: null, providerStatus: "Not Started",
    providerMeta: meta || { season: "2025-2026", rawRound: round },
  };
}

// ---- SCENARIO A: existing quiniela, nothing changes ----

test("SCENARIO A: a normal J1-J17 import still produces round.number 1..17 -- byte-for-byte the previous behaviour", () => {
  const events = [];
  for (let n = 1; n <= 17; n++) events.push(ev(String(n), `2026-08-${String(n % 28 + 1).padStart(2,"0")}T18:00:00Z`, "e" + n));
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: P });
  const numbers = newRounds.map(r => r.number).sort((a,b) => a-b);
  assert.deepEqual(numbers, [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]);
});

test("SCENARIO A: displayLabel is null for every normally-imported round, so the UI falls back to 'Jornada {number}' exactly as before", () => {
  const events = [ev("5", "2026-08-10T18:00:00Z", "e5")];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: P });
  assert.equal(newRounds[0].displayLabel, null);
  assert.equal(newRounds[0].number, 5);
});

test("SCENARIO A: round.number is never derived from sortKey -- the two are independent fields", () => {
  const events = [ev("17", "2026-11-01T18:00:00Z", "e17")];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: P });
  assert.equal(newRounds[0].number, 17, "commercial key keeps the provider's natural round number");
  assert.equal(newRounds[0].sortKey, 1, "ordering key is chronological position, unrelated to 17");
});

// ---- SCENARIO B: Payment Penalty / commercial key untouched ----

test("SCENARIO B: round.number remains usable as the Payment Penalty ordering key for regular rounds", () => {
  const events = [];
  for (let n = 1; n <= 17; n++) events.push(ev(String(n), `2026-08-${String(n % 28 + 1).padStart(2,"0")}T18:00:00Z`, "e" + n));
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: P });
  const startsAtRound = 3;
  const eligible = newRounds.filter(r => r.number >= startsAtRound).map(r => r.number).sort((a,b)=>a-b);
  assert.deepEqual(eligible, [3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]);
});

test("SCENARIO B (the real bug this fixes): a knockout round coded intRound=0 no longer produces round.number 0 -- which had silently EXCLUDED it from Payment Penalty, since 0 >= startsAtRound is false", () => {
  const existingRounds = [];
  for (let n = 1; n <= 17; n++) existingRounds.push({ number: n, provider: P, externalRoundId: String(n), sortKey: n });
  const { newRounds } = planCompetitionSync({
    existingRounds,
    events: [ev("0", "2026-11-21T18:00:00Z", "k1")],
    provider: P,
  });
  assert.equal(newRounds.length, 1);
  assert.ok(newRounds[0].number >= 1, "must never be 0");
  assert.equal(newRounds[0].number, 18, "takes the sequential fallback, same as a non-numeric label always has");
  assert.ok(newRounds[0].number >= 3, "and is therefore correctly INCLUDED by a startsAtRound=3 penalty");
});

// ---- SCENARIO C: no phase collapse (the confirmed Liga MX bug) ----

test("SCENARIO C: Apertura's four intRound=0 knockout matchdays (Nov 21 / Nov 27 / Dec 4 / Dec 12) are NO LONGER collapsed into one round", () => {
  const events = [
    ev("0", "2025-11-21T02:00:00Z", "k1"),
    ev("0", "2025-11-27T02:00:00Z", "k2"),
    ev("0", "2025-12-04T02:00:00Z", "k3"),
    ev("0", "2025-12-12T02:00:00Z", "k4"),
  ];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: P });
  assert.equal(newRounds.length, 4, "four matchdays weeks apart must be four rounds, not one");
});

test("SCENARIO C: Apertura J1 and Clausura J1 -- both intRound=1 inside the SAME strSeason -- are no longer merged into a single 'Jornada 1'", () => {
  const events = [
    ev("1", "2025-08-01T02:00:00Z", "a1"),
    ev("1", "2026-01-10T02:00:00Z", "c1"),
  ];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: P });
  assert.equal(newRounds.length, 2, "two tournaments' opening matchdays must never share a round");
  const ids = newRounds.flatMap(r => r.matches.map(m => m.externalEventId)).sort();
  assert.deepEqual(ids, ["a1", "c1"]);
  assert.notEqual(newRounds[0].matches[0].externalEventId, newRounds[1].matches[0].externalEventId);
});

test("SCENARIO C: a NORMAL matchday spanning Fri->Mon is never split -- the threshold is conservative by design", () => {
  const events = [
    ev("7", "2026-09-04T02:00:00Z", "f1"),
    ev("7", "2026-09-05T02:00:00Z", "f2"),
    ev("7", "2026-09-06T02:00:00Z", "f3"),
    ev("7", "2026-09-07T02:00:00Z", "f4"),
  ];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: P });
  assert.equal(newRounds.length, 1, "a normal weekend round must stay a single round");
  assert.equal(newRounds[0].matches.length, 4);
});

test("SCENARIO C: the two-legged Final (both legs intRound=200, three days apart) stays ONE round -- legs of the same tie are not separate matchdays", () => {
  const events = [
    ev("200", "2025-05-23T02:00:00Z", "f_ida"),
    ev("200", "2025-05-26T02:00:00Z", "f_vuelta"),
  ];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: P });
  assert.equal(newRounds.length, 1);
  assert.equal(newRounds[0].matches.length, 2);
});

// ---- SCENARIO D: Liguilla import produces no "Jornada 0" ----

test("SCENARIO D: importing a full Liguilla (0 / 125 / 200) never yields round.number 0", () => {
  const existingRounds = [];
  for (let n = 1; n <= 17; n++) existingRounds.push({ number: n, provider: P, externalRoundId: String(n), sortKey: n });
  const events = [
    ev("125", "2026-05-03T02:00:00Z", "p1"),
    ev("0",   "2026-05-14T02:00:00Z", "q1"),
    ev("200", "2026-05-25T02:00:00Z", "fi"),
  ];
  const { newRounds } = planCompetitionSync({ existingRounds, events, provider: P });
  assert.equal(newRounds.length, 3);
  newRounds.forEach(r => assert.ok(r.number >= 1, `round.number must never be < 1 (got ${r.number})`));
});

test("SCENARIO D: every imported round carries stage:'UNKNOWN' -- no phase semantics are invented from 0/125/200", () => {
  const { newRounds } = planCompetitionSync({
    existingRounds: [], events: [ev("125", "2026-05-03T02:00:00Z", "p1")], provider: P,
  });
  assert.equal(newRounds[0].stage, "UNKNOWN");
  assert.equal(newRounds[0].displayLabel, null, "no guessed label like 'Cuartos de Final'");
});

// ---- sortKey ----

test("sortKey is monotonic and chronological, independent of the provider's codes", () => {
  const events = [
    ev("200", "2026-05-25T02:00:00Z", "c"),
    ev("1",   "2026-01-10T02:00:00Z", "a"),
    ev("125", "2026-05-03T02:00:00Z", "b"),
  ];
  const { newRounds } = planCompetitionSync({ existingRounds: [], events, provider: P });
  const byDate = newRounds.slice().sort((x,y) => new Date(x.deadline) - new Date(y.deadline));
  assert.deepEqual(byDate.map(r => r.sortKey), [1,2,3]);
});

test("sortKey continues after whatever the quiniela already has, never restarting at 1", () => {
  const { newRounds } = planCompetitionSync({
    existingRounds: [{ number: 1, sortKey: 1 }, { number: 2, sortKey: 2 }],
    events: [ev("3", "2026-09-01T02:00:00Z", "e3")],
    provider: P,
  });
  assert.equal(newRounds[0].sortKey, 3);
});

// ---- provider metadata preservation ----

test("providerReferences preserves the raw provider round AND strSeason -- information QRACKS was previously discarding entirely", () => {
  const { newRounds } = planCompetitionSync({
    existingRounds: [],
    events: [ev("200", "2026-05-25T02:00:00Z", "fi", { season: "2025-2026", rawRound: "200" })],
    provider: P,
  });
  const ref = newRounds[0].providerReferences[P];
  assert.equal(ref.rawRound, "200");
  assert.equal(ref.season, "2025-2026");
  assert.deepEqual(ref.eventIds, ["fi"]);
});

test("normalizeEvent now carries providerMeta.season/rawRound through", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "sportsDataProvider.js"), "utf8");
  assert.ok(src.includes("providerMeta: {"));
  assert.ok(src.includes("season: raw.strSeason"));
  assert.ok(src.includes("rawRound: raw.intRound"));
});

// ---- purely additive / no regressions ----

test("planCompetitionSync still never mutates its inputs", () => {
  const events = [ev("1", "2026-08-01T02:00:00Z", "e1")];
  const snapshot = JSON.parse(JSON.stringify(events));
  planCompetitionSync({ existingRounds: [], events, provider: P });
  assert.deepEqual(events, snapshot);
});

test("imported rounds still come out published:false / resultsPublished:false", () => {
  const { newRounds } = planCompetitionSync({
    existingRounds: [], events: [ev("1", "2026-08-01T02:00:00Z", "e1")], provider: P,
  });
  assert.equal(newRounds[0].published, false);
  assert.equal(newRounds[0].resultsPublished, false);
});

// ---- UI wiring ----

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("roundLabel() exists and falls back to 'Jornada {number}' when displayLabel is absent -- identical output for every existing round", () => {
  const m = indexSrc.match(/function roundLabel\(round\)\{[\s\S]*?\n  \}/);
  assert.ok(m, "roundLabel must exist");
  const fn = new Function("return " + m[0])();
  assert.equal(fn({ number: 7 }), "Jornada 7");
  assert.equal(fn({ number: 7, displayLabel: null }), "Jornada 7");
  assert.equal(fn({ number: 18, displayLabel: "Cuartos de Final · Ida" }), "Cuartos de Final · Ida");
  assert.equal(fn(null), "");
});

test("the commercial/functional uses of round.number are untouched by this ticket", () => {
  assert.ok(indexSrc.includes("r.number >= penalty.startsAtRound"), "Payment Penalty still keys off round.number");
  assert.ok(indexSrc.includes("r.number === bet.closesAtRound"), "Adicionales still key off round.number");
  assert.ok(indexSrc.includes("r.number > cutoffRoundNumber"), "scoring cutoffs still key off round.number");
  assert.ok(indexSrc.includes("Math.max(...meta.rounds.map(r => r.number)) + 1"), "next manual round still derives from round.number");
});

test("user-facing round titles now read through roundLabel(), not round.number directly", () => {
  assert.ok(indexSrc.includes("esc(roundLabel(r))"));
  assert.ok(indexSrc.includes("roundLabel(round)"));
});
