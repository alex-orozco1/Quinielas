// planLimits.js — MON-001A: exhaustive behavioral tests against the REAL
// module (require()'d directly, not extracted/reimplemented -- this file
// lives in server-side code, unlike the frontend-extraction pattern used
// for public/index.html functions elsewhere in this test suite).

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FREE_TRIAL_DAYS,
  PLAN_LIMITS,
  KNOWN_PLANS,
  getEffectivePlan,
  checkRoundPublishAllowed,
  checkParticipantAddAllowed,
} = require("../planLimits");

const NOW = new Date("2026-08-25T12:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- Basic plan catalog sanity ----

test("PLAN_LIMITS defines FREE and PLUS with sensible, documented numbers", () => {
  assert.equal(typeof PLAN_LIMITS.FREE.maxPublishedRounds, "number");
  assert.equal(typeof PLAN_LIMITS.FREE.maxParticipants, "number");
  assert.equal(typeof PLAN_LIMITS.PLUS.maxPublishedRounds, "number");
  assert.equal(typeof PLAN_LIMITS.PLUS.maxParticipants, "number");
  assert.ok(PLAN_LIMITS.PLUS.maxPublishedRounds > PLAN_LIMITS.FREE.maxPublishedRounds, "PLUS must be more generous than FREE");
  assert.ok(PLAN_LIMITS.PLUS.maxParticipants > PLAN_LIMITS.FREE.maxParticipants, "PLUS must be more generous than FREE");
});

test("KNOWN_PLANS lists exactly the 3 named plans, nothing else", () => {
  assert.deepEqual(KNOWN_PLANS.slice().sort(), ["FREE", "FREE_TRIAL", "PLUS"]);
});

test("FREE_TRIAL_DAYS is a positive, finite number", () => {
  assert.ok(Number.isFinite(FREE_TRIAL_DAYS) && FREE_TRIAL_DAYS > 0);
});

// ---- CASE: legacy quinielas (no plan field at all) ----

test("CASE (legacy): a platform_index entry with no plan field at all is LEGACY_UNLIMITED, never silently forced into FREE", () => {
  const result = getEffectivePlan({}, NOW);
  assert.equal(result.effectivePlan, "LEGACY_UNLIMITED");
  assert.equal(result.limits, null);
  assert.equal(result.isLegacy, true);
});

test("CASE (legacy): plan explicitly null is also treated as legacy, not as an unrecognized-string case", () => {
  const result = getEffectivePlan({ plan: null }, NOW);
  assert.equal(result.effectivePlan, "LEGACY_UNLIMITED");
  assert.equal(result.isLegacy, true);
});

test("CASE (legacy): a legacy quiniela that already has more published rounds than FREE's limit is never retroactively blocked", () => {
  const check = checkRoundPublishAllowed({}, 12, 13, NOW);
  assert.equal(check.allowed, true);
});

test("CASE (legacy): a legacy quiniela with 50 participants already can still add more", () => {
  const check = checkParticipantAddAllowed({}, 50, 51, NOW);
  assert.equal(check.allowed, true);
});

// ---- CASE: unrecognized/corrupt plan values fail OPEN, not closed ----

test("CASE (corrupt data): an unrecognized plan string is treated as LEGACY_UNLIMITED (fails open), never crashes", () => {
  const result = getEffectivePlan({ plan: "SOME_FUTURE_PLAN_THIS_CODE_DOESNT_KNOW" }, NOW);
  assert.equal(result.effectivePlan, "LEGACY_UNLIMITED");
  assert.equal(result.limits, null);
});

test("CASE (corrupt data): a typo'd plan value ('free' lowercase, 'Plus' mixed case) is NOT silently matched -- fails open rather than guessing", () => {
  assert.equal(getEffectivePlan({ plan: "free" }, NOW).limits, null);
  assert.equal(getEffectivePlan({ plan: "Plus" }, NOW).limits, null);
});

test("CASE (corrupt data): a numeric or object plan value never crashes, resolves to LEGACY_UNLIMITED", () => {
  assert.doesNotThrow(() => getEffectivePlan({ plan: 123 }, NOW));
  assert.doesNotThrow(() => getEffectivePlan({ plan: {} }, NOW));
  assert.equal(getEffectivePlan({ plan: 123 }, NOW).limits, null);
});

// ---- CASE: FREE plan, exact limit boundaries ----

test("CASE (FREE, at limit): going from limit-1 to limit is allowed", () => {
  const limit = PLAN_LIMITS.FREE.maxPublishedRounds;
  const check = checkRoundPublishAllowed({ plan: "FREE" }, limit - 1, limit, NOW);
  assert.equal(check.allowed, true);
});

test("CASE (FREE, over limit): going from limit to limit+1 is blocked, with the correct reason/plan/limit fields", () => {
  const limit = PLAN_LIMITS.FREE.maxPublishedRounds;
  const check = checkRoundPublishAllowed({ plan: "FREE" }, limit, limit + 1, NOW);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "plan_round_limit_reached");
  assert.equal(check.plan, "FREE");
  assert.equal(check.limit, limit);
});

test("CASE (FREE, far over limit): a single write that jumps from well under the limit to well over it is still blocked (not just off-by-one)", () => {
  const check = checkRoundPublishAllowed({ plan: "FREE" }, 1, 999, NOW);
  assert.equal(check.allowed, false);
});

test("CASE (FREE participants, at limit): going from limit-1 to limit is allowed", () => {
  const limit = PLAN_LIMITS.FREE.maxParticipants;
  const check = checkParticipantAddAllowed({ plan: "FREE" }, limit - 1, limit, NOW);
  assert.equal(check.allowed, true);
});

test("CASE (FREE participants, over limit): blocked with correct fields", () => {
  const limit = PLAN_LIMITS.FREE.maxParticipants;
  const check = checkParticipantAddAllowed({ plan: "FREE" }, limit, limit + 1, NOW);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "plan_participant_limit_reached");
  assert.equal(check.limit, limit);
});

// ---- CASE: decreasing/unchanged counts are NEVER blocked, regardless of plan ----

test("CASE (never blocks a decrease): deleting rounds down from over-the-limit is always allowed on any plan", () => {
  assert.equal(checkRoundPublishAllowed({ plan: "FREE" }, 10, 3, NOW).allowed, true);
  assert.equal(checkRoundPublishAllowed({ plan: "FREE_TRIAL", planSetAt: new Date(NOW - 100 * DAY_MS).toISOString() }, 10, 3, NOW).allowed, true);
});

test("CASE (never blocks unchanged count): a write that doesn't change round/participant count is always allowed", () => {
  assert.equal(checkRoundPublishAllowed({ plan: "FREE" }, 5, 5, NOW).allowed, true);
  assert.equal(checkParticipantAddAllowed({ plan: "FREE" }, 20, 20, NOW).allowed, true);
});

test("CASE (never blocks a decrease): removing participants is always allowed even while already over the limit (e.g. after a manual plan downgrade)", () => {
  const check = checkParticipantAddAllowed({ plan: "FREE" }, 30, 29, NOW);
  assert.equal(check.allowed, true);
});

// ---- CASE: PLUS plan is effectively unlimited for any real usage ----

test("CASE (PLUS): a very large round/participant count is still allowed", () => {
  assert.equal(checkRoundPublishAllowed({ plan: "PLUS" }, 500, 501, NOW).allowed, true);
  assert.equal(checkParticipantAddAllowed({ plan: "PLUS" }, 500, 501, NOW).allowed, true);
});

test("CASE (PLUS): even PLUS has an explicit, auditable numeric ceiling -- not a bare 'no limit at all' code path", () => {
  const overCeiling = PLAN_LIMITS.PLUS.maxPublishedRounds + 1;
  const check = checkRoundPublishAllowed({ plan: "PLUS" }, PLAN_LIMITS.PLUS.maxPublishedRounds, overCeiling, NOW);
  assert.equal(check.allowed, false, "PLUS must still have SOME real backstop, even if extremely generous");
});

// ---- CASE: FREE_TRIAL, active vs. expired, using a REAL clock comparison ----

test("CASE (trial active): a FREE_TRIAL quiniela created 1 day ago is fully unlimited", () => {
  const entry = { plan: "FREE_TRIAL", planSetAt: new Date(NOW - 1 * DAY_MS).toISOString() };
  const result = getEffectivePlan(entry, NOW);
  assert.equal(result.limits, null);
  assert.equal(result.isTrialExpired, false);
  assert.equal(checkRoundPublishAllowed(entry, 100, 101, NOW).allowed, true);
});

test("CASE (trial boundary): just before the trial window elapses, still active", () => {
  const entry = { plan: "FREE_TRIAL", planSetAt: new Date(NOW - (FREE_TRIAL_DAYS * DAY_MS - 1)).toISOString() };
  assert.equal(getEffectivePlan(entry, NOW).isTrialExpired, false);
});

test("CASE (trial boundary): exactly 1ms after the trial window is expired", () => {
  const entry = { plan: "FREE_TRIAL", planSetAt: new Date(NOW - (FREE_TRIAL_DAYS * DAY_MS + 1)).toISOString() };
  assert.equal(getEffectivePlan(entry, NOW).isTrialExpired, true);
});

test("CASE (trial expired): an expired FREE_TRIAL is enforced exactly like FREE -- same numeric limits", () => {
  const entry = { plan: "FREE_TRIAL", planSetAt: new Date(NOW - 100 * DAY_MS).toISOString() };
  const result = getEffectivePlan(entry, NOW);
  assert.deepEqual(result.limits, PLAN_LIMITS.FREE);
  const limit = PLAN_LIMITS.FREE.maxPublishedRounds;
  assert.equal(checkRoundPublishAllowed(entry, limit, limit + 1, NOW).allowed, false);
});

test("CASE (trial expired): the STORED plan value is never mutated by this function -- effectivePlan still reports 'FREE_TRIAL', not 'FREE'", () => {
  const entry = { plan: "FREE_TRIAL", planSetAt: new Date(NOW - 100 * DAY_MS).toISOString() };
  const result = getEffectivePlan(entry, NOW);
  assert.equal(result.effectivePlan, "FREE_TRIAL", "the stored/reported plan name must stay FREE_TRIAL -- only enforcement (limits) changes, distinguishing 'still nominally trialing but lapsed' from a deliberate downgrade");
});

test("CASE (trial, missing planSetAt): a FREE_TRIAL row with no planSetAt at all is treated as NOT expired (safest default for an unexpected data shape)", () => {
  const entry = { plan: "FREE_TRIAL" };
  const result = getEffectivePlan(entry, NOW);
  assert.equal(result.isTrialExpired, false);
  assert.equal(result.limits, null);
});

test("CASE (trial, unparseable planSetAt): a garbage date string is also treated as NOT expired, never crashes", () => {
  const entry = { plan: "FREE_TRIAL", planSetAt: "not-a-real-date" };
  assert.doesNotThrow(() => getEffectivePlan(entry, NOW));
  assert.equal(getEffectivePlan(entry, NOW).isTrialExpired, false);
});

// ---- CASE: mid-session trial expiry ----

test("CASE (mid-session expiry): the SAME entry evaluated just before and just after the trial boundary (simulating real time passing during a long-open admin session) transitions correctly with no special handling needed by the caller", () => {
  const setAt = new Date(NOW - FREE_TRIAL_DAYS * DAY_MS + 5000).toISOString();
  const entry = { plan: "FREE_TRIAL", planSetAt: setAt };
  const beforeExpiry = getEffectivePlan(entry, NOW);
  const afterExpiry = getEffectivePlan(entry, NOW + 10000);
  assert.equal(beforeExpiry.isTrialExpired, false);
  assert.equal(afterExpiry.isTrialExpired, true);
});

// ---- CASE: exempt is a server.js-level concern, not inside these pure functions ----

test("checkRoundPublishAllowed does not itself know about `exempt` -- that gate is applied one level up in server.js", () => {
  const check = checkRoundPublishAllowed({ plan: "FREE", exempt: true }, 5, 6, NOW);
  assert.equal(check.allowed, false, "exempt must be handled by the CALLER (server.js), not silently inside this pure function");
});

// ---- Server.js wiring: real structural confirmation ----

const fs = require("node:fs");
const path = require("node:path");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("server.js requires planLimits.js and never duplicates its logic inline", () => {
  assert.ok(serverSrc.includes('require("./planLimits")'));
  assert.ok(!serverSrc.includes("maxPublishedRounds:"), "the plan limit NUMBERS must live only in planLimits.js, never inlined/duplicated in server.js");
});

test("POST /api/create-quiniela assigns an explicit FREE_TRIAL plan to every new quiniela -- never relies on the legacy fallback for a brand-new row", () => {
  const idx = serverSrc.indexOf('app.post("/api/create-quiniela"');
  const body = serverSrc.slice(idx, idx + 3600);
  assert.ok(body.includes('plan: "FREE_TRIAL"'));
  assert.ok(body.includes("planSetAt: new Date().toISOString()"));
  assert.ok(body.includes('planSetBy: "system_default"'));
});

test("POST /api/kv/:key's quiniela-meta branch reads platform_index FRESH from the database for the plan check -- never trusts a plan value from the request body itself", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes('await getRow("platform_index")'));
  assert.ok(!body.includes("value.plan"), "must never read a plan value from the client-supplied write payload");
});

test("the plan-limit check in POST /api/kv/:key only evaluates when the published-round-count or participant-count actually INCREASED", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes("newPublishedCount > oldPublishedCount || newParticipantCount > oldParticipantCount"));
});

test("entries with exempt:true are never subjected to the plan-limit check in the generic write path", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes("if (entry && !entry.exempt) {"));
});

test("a plan-limit rejection in the generic write path returns HTTP 402 with the structured {error, limitType, plan, limit} shape, for both round and participant checks", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  const occurrences = [...body.matchAll(/res\.status\(402\)\.json\(\{ error: \w+Check\.reason, limitType: "(rounds|participants)", plan: \w+Check\.plan, limit: \w+Check\.limit \}\)/g)];
  assert.equal(occurrences.length, 2, "both the rounds check and the participants check must return this exact structured 402 shape");
});

test("POST /api/self-register derives the slug from metaKey itself (never trusts the separate client-supplied slug field) for its plan-limit check", () => {
  const idx = serverSrc.indexOf('app.post("/api/self-register"');
  const nextRoute = serverSrc.indexOf("app.post(", idx + 10);
  const body = serverSrc.slice(idx, nextRoute);
  assert.ok(body.includes("const metaKeyMatch = String(metaKey).match(/^quiniela:([a-z0-9-]{1,60}):meta$/);"));
  assert.ok(body.includes("const derivedSlug = metaKeyMatch ? metaKeyMatch[1] : null;"));
  assert.ok(!body.includes("q.slug === slug)"), "must never look up the plan using the raw client-supplied slug field");
});

test("POST /api/self-register's plan-limit check runs BEFORE the new participant is pushed/persisted", () => {
  const idx = serverSrc.indexOf('app.post("/api/self-register"');
  const nextRoute = serverSrc.indexOf("app.post(", idx + 10);
  const body = serverSrc.slice(idx, nextRoute);
  const checkIdx = body.indexOf("checkParticipantAddAllowed(entry,");
  const pushIdx = body.indexOf("value.participants.push(newParticipant);");
  assert.ok(checkIdx !== -1 && pushIdx !== -1 && checkIdx < pushIdx);
});

test("POST /api/self-register also respects exempt:true", () => {
  const idx = serverSrc.indexOf('app.post("/api/self-register"');
  const nextRoute = serverSrc.indexOf("app.post(", idx + 10);
  const body = serverSrc.slice(idx, nextRoute);
  assert.ok(body.includes("if (entry && !entry.exempt) {"));
});
