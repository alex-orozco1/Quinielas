// planLimits.js — MON-001B: exhaustive behavioral tests against the REAL,
// REWRITTEN module (require()'d directly, not extracted/reimplemented).
// This file REPLACES MON-001A's version entirely — none of the old
// FREE_TRIAL/getEffectivePlan/checkRoundPublishAllowed/checkParticipantAddAllowed
// tests survive, since none of those concepts exist anymore.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_COMMERCIAL_CONFIG,
  GRANDFATHER_CEILING,
  isCommercialConfigValid,
  computeCompetitionIdentity,
  buildFreeEntitlement,
  buildPlusEntitlement,
  buildGrandfatheredEntitlement,
  buildManualGrantEntitlement,
  isKnownPlan,
  checkParticipantCapacity,
  checkLifecycleRoundConsumption,
} = require("../planLimits");

// ---- Approved commercial model: exact numbers, never "close enough" ----

test("DEFAULT_COMMERCIAL_CONFIG matches the exact approved model: FREE=10 participants/7 rounds, PLUS=50 participants/18 rounds, $199 MXN", () => {
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.free.participantLimit, 10);
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.free.manualRoundLimit, 7);
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.plus.participantLimit, 50);
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.plus.manualRoundLimit, 18);
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.plus.priceMXN, 199);
});

test("there is no active FREE_TRIAL plan/constant anywhere in this module -- no trial-days constant, no time-based plan transition, no code path that assigns/compares plan === 'FREE_TRIAL'", () => {
  const mod = require("../planLimits");
  assert.equal(mod.FREE_TRIAL_DAYS, undefined);
  assert.equal(typeof mod.getEffectivePlan, "undefined", "the old time-based effective-plan resolver must not exist");
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../planLimits"), "utf8");
  assert.ok(!/["']FREE_TRIAL["']/.test(src), "no code may assign or compare against the literal string \"FREE_TRIAL\" (historical references in comments explaining what was removed are fine)");
});

// ---- Commercial config validation (the dynamic SSOT's own invariants) ----

test("a valid config passes isCommercialConfigValid", () => {
  assert.equal(isCommercialConfigValid(DEFAULT_COMMERCIAL_CONFIG), true);
});

test("free.participantLimit < 1 is rejected", () => {
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 0, manualRoundLimit: 7 }, plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: 199 } }), false);
});

test("plus.participantLimit below free.participantLimit is rejected (Plus must never be worse than Free)", () => {
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 10, manualRoundLimit: 7 }, plus: { participantLimit: 5, manualRoundLimit: 18, priceMXN: 199 } }), false);
});

test("plus.manualRoundLimit below free.manualRoundLimit is rejected", () => {
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 10, manualRoundLimit: 7 }, plus: { participantLimit: 50, manualRoundLimit: 5, priceMXN: 199 } }), false);
});

test("negative priceMXN is rejected", () => {
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 10, manualRoundLimit: 7 }, plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: -1 } }), false);
});

test("priceMXN of exactly 0 is VALID (a free promotional Plus is a legitimate config, not an error)", () => {
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 10, manualRoundLimit: 7 }, plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: 0 } }), true);
});

test("missing free or plus block entirely is rejected, never crashes", () => {
  assert.equal(isCommercialConfigValid({ plus: DEFAULT_COMMERCIAL_CONFIG.plus }), false);
  assert.equal(isCommercialConfigValid({}), false);
  assert.equal(isCommercialConfigValid(null), false);
  assert.doesNotThrow(() => isCommercialConfigValid(undefined));
});

test("plus.participantLimit EQUAL to free.participantLimit is valid (Plus doesn't have to be strictly greater, just never worse)", () => {
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 10, manualRoundLimit: 7 }, plus: { participantLimit: 10, manualRoundLimit: 18, priceMXN: 199 } }), true);
});

// ---- Entitlement snapshots freeze the config at grant time -----------

test("buildFreeEntitlement snapshots the CURRENT config's numbers, tagged with the config version -- changing config later does not retroactively touch this object", () => {
  const config = { version: 5, free: { participantLimit: 12, manualRoundLimit: 9 }, plus: { participantLimit: 60, manualRoundLimit: 20, priceMXN: 299 } };
  const ent = buildFreeEntitlement(config, "2026-01-01T00:00:00.000Z");
  assert.equal(ent.plan, "FREE");
  assert.equal(ent.participantLimit, 12);
  assert.equal(ent.manualRoundLimit, 9);
  assert.equal(ent.configVersionAtGrant, 5);
  assert.equal(ent.source, "signup_default");
  assert.equal(ent.competitionIdentity, null);
  assert.equal(ent.revoked, false);
});

test("buildPlusEntitlement snapshots price paid alongside the limits, defaults source to 'purchase'", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, "2026-01-01T00:00:00.000Z");
  assert.equal(ent.plan, "PLUS");
  assert.equal(ent.participantLimit, 50);
  assert.equal(ent.manualRoundLimit, 18);
  assert.equal(ent.pricePaidMXN, 199);
  assert.equal(ent.source, "purchase");
});

test("buildPlusEntitlement accepts an explicit competitionIdentity for a with-league purchase", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, "2026-01-01T00:00:00.000Z", { competitionIdentity: "4350:2026-2027" });
  assert.equal(ent.competitionIdentity, "4350:2026-2027");
});

test("buildGrandfatheredEntitlement uses an explicit, auditable numeric ceiling -- never a bare Infinity/null sentinel", () => {
  const ent = buildGrandfatheredEntitlement("2026-01-01T00:00:00.000Z");
  assert.equal(ent.plan, "GRANDFATHERED");
  assert.equal(ent.participantLimit, GRANDFATHER_CEILING.participantLimit);
  assert.equal(ent.manualRoundLimit, GRANDFATHER_CEILING.manualRoundLimit);
  assert.ok(Number.isFinite(ent.participantLimit) && Number.isFinite(ent.manualRoundLimit), "must be real finite numbers, not Infinity");
  assert.equal(ent.source, "grandfather_migration");
  assert.equal(ent.grantedBy, "migration");
});

test("buildGrandfatheredEntitlement preserves a custom reason (e.g. migrated from legacy exempt:true)", () => {
  const ent = buildGrandfatheredEntitlement("2026-01-01T00:00:00.000Z", { reason: "Migrated from legacy exempt:true flag." });
  assert.equal(ent.reason, "Migrated from legacy exempt:true flag.");
});

test("buildManualGrantEntitlement requires an explicit grantedBy -- never silently defaulted to something meaningless", () => {
  const ent = buildManualGrantEntitlement("2026-01-01T00:00:00.000Z", { grantedBy: "platform:alex", reason: "friend's office pool", participantLimit: 999, manualRoundLimit: 999 });
  assert.equal(ent.source, "manual_grant");
  assert.equal(ent.grantedBy, "platform:alex");
  assert.equal(ent.reason, "friend's office pool");
  assert.equal(ent.participantLimit, 999);
  assert.equal(ent.revoked, false);
});

// ---- isKnownPlan ----

test("isKnownPlan recognizes exactly FREE, PLUS, GRANDFATHERED, MANUAL_GRANT -- nothing else, including the old FREE_TRIAL", () => {
  assert.equal(isKnownPlan("FREE"), true);
  assert.equal(isKnownPlan("PLUS"), true);
  assert.equal(isKnownPlan("GRANDFATHERED"), true);
  assert.equal(isKnownPlan("MANUAL_GRANT"), true);
  assert.equal(isKnownPlan("FREE_TRIAL"), false);
  assert.equal(isKnownPlan("free"), false, "case-sensitive, never guesses at a typo");
  assert.equal(isKnownPlan(undefined), false);
  assert.equal(isKnownPlan(null), false);
});

// ---- FAIL-CLOSED: the central behavioral change from MON-001A ----

test("CRITICAL: a completely missing entitlement (null/undefined) is DENIED, never treated as unlimited -- this is the fail-closed fix", () => {
  assert.equal(checkParticipantCapacity(null, 0, 1).allowed, false);
  assert.equal(checkParticipantCapacity(undefined, 0, 1).allowed, false);
  assert.equal(checkLifecycleRoundConsumption(null, 0, 1).allowed, false);
  assert.equal(checkParticipantCapacity(null, 0, 1).reason, "entitlement_unavailable");
});

test("CRITICAL: an entitlement with an unrecognized plan string is DENIED, never fails open (opposite of MON-001A's LEGACY_UNLIMITED behavior)", () => {
  const corrupt = { plan: "SOME_FUTURE_PLAN", participantLimit: 999, manualRoundLimit: 999 };
  assert.equal(checkParticipantCapacity(corrupt, 0, 1).allowed, false);
  assert.equal(checkParticipantCapacity(corrupt, 0, 1).reason, "entitlement_unavailable");
});

test("CRITICAL: a revoked entitlement is DENIED even if its numeric limits are still present", () => {
  const revoked = { plan: "PLUS", participantLimit: 50, manualRoundLimit: 18, revoked: true };
  assert.equal(checkParticipantCapacity(revoked, 0, 1).allowed, false);
  assert.equal(checkLifecycleRoundConsumption(revoked, 0, 1).allowed, false);
});

test("an entitlement missing its numeric limit field entirely is DENIED, never NaN-compared into a false 'allowed'", () => {
  const noLimit = { plan: "FREE", revoked: false }; // participantLimit/manualRoundLimit absent
  assert.equal(checkParticipantCapacity(noLimit, 0, 1).allowed, false);
  assert.equal(checkLifecycleRoundConsumption(noLimit, 0, 1).allowed, false);
});

// ---- FREE: exact boundaries, 10 participants / 7 rounds ----

test("FREE participants: 9 -> 10 (adding the 10th) is allowed -- exactly at the approved limit", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, 9, 1).allowed, true);
});

test("FREE participants: 10 -> 11 (the 11th) is blocked, with the correct reason/plan/limit", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  const check = checkParticipantCapacity(ent, 10, 1);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "plan_participant_limit_reached");
  assert.equal(check.plan, "FREE");
  assert.equal(check.limit, 10);
});

test("FREE lifecycle: 6 -> 7 consumed (the 7th round) is allowed -- exactly at the approved limit", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkLifecycleRoundConsumption(ent, 6, 1).allowed, true);
});

test("FREE lifecycle: 7 -> 8 consumed (the 8th round) is blocked", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  const check = checkLifecycleRoundConsumption(ent, 7, 1);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "plan_lifecycle_limit_reached");
  assert.equal(check.limit, 7);
});

// ---- PLUS: exact boundaries, 50 participants / 18 rounds (NOT 9999) ----

test("PLUS participants: 49 -> 50 is allowed, 50 -> 51 is blocked -- confirms PLUS is a real 50, not unlimited", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, 49, 1).allowed, true);
  const over = checkParticipantCapacity(ent, 50, 1);
  assert.equal(over.allowed, false);
  assert.equal(over.limit, 50);
});

test("PLUS lifecycle: 17 -> 18 is allowed, 18 -> 19 is blocked -- confirms PLUS is a real 18, not unlimited", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkLifecycleRoundConsumption(ent, 17, 1).allowed, true);
  const over = checkLifecycleRoundConsumption(ent, 18, 1);
  assert.equal(over.allowed, false);
  assert.equal(over.limit, 18);
});

// ---- Multiple-at-once (bulk-add, or a crafted payload adding several rounds in one write) ----

test("bulk add: 8 participants + 3 at once (11 total) on FREE is blocked as a whole, not evaluated one at a time", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  const check = checkParticipantCapacity(ent, 8, 3);
  assert.equal(check.allowed, false, "3 at once pushing 8->11 must be rejected even though a naive one-at-a-time check might let the first couple through");
});

test("bulk add: 6 participants + 4 at once (10 total) on FREE is allowed -- lands exactly at the limit", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, 6, 4).allowed, true);
});

test("a crafted payload claiming 5 newly-published rounds at once on FREE (5 already consumed) is blocked as a whole", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  const check = checkLifecycleRoundConsumption(ent, 5, 5); // 5+5=10 > 7
  assert.equal(check.allowed, false);
});

// ---- Never blocks a decrease or unchanged count ----

test("no new participants (additionalCount 0) never blocks, regardless of current count", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, 15, 0).allowed, true);
});

// ---- GRANDFATHERED: real legacy scenarios ----

test("CASE (legacy, already over new limits): a grandfathered entitlement allows a quiniela already at 70 participants to keep adding more", () => {
  const ent = buildGrandfatheredEntitlement();
  assert.equal(checkParticipantCapacity(ent, 70, 1).allowed, true);
});

test("CASE (legacy, already over new lifecycle limit): a grandfathered entitlement allows a quiniela already at 40 published rounds to keep adding more", () => {
  const ent = buildGrandfatheredEntitlement();
  assert.equal(checkLifecycleRoundConsumption(ent, 40, 1).allowed, true);
});

test("a grandfathered entitlement still has a real (if extremely high) ceiling -- not literally infinite", () => {
  const ent = buildGrandfatheredEntitlement();
  const check = checkParticipantCapacity(ent, GRANDFATHER_CEILING.participantLimit, 1);
  assert.equal(check.allowed, false, "even grandfathered quinielas have SOME real backstop, however generous");
});

// ---- Competition identity (with-league) ----

test("computeCompetitionIdentity returns null when no league is configured", () => {
  assert.equal(computeCompetitionIdentity({}), null);
  assert.equal(computeCompetitionIdentity(null), null);
  assert.equal(computeCompetitionIdentity({ sportsdbSeason: "2026-2027" }), null, "a season with no league id is not a real identity");
});

test("computeCompetitionIdentity combines leagueId and season into one durable string", () => {
  assert.equal(computeCompetitionIdentity({ sportsdbLeagueId: "4350", sportsdbSeason: "2026-2027" }), "4350:2026-2027");
});

test("computeCompetitionIdentity handles a missing season gracefully (never crashes, never silently returns just the league id alone)", () => {
  assert.equal(computeCompetitionIdentity({ sportsdbLeagueId: "4350" }), "4350:unknown-season");
});

test("CASE (with league): lifecycle round-count check is a no-op (always allowed) once competitionIdentity is set on the entitlement -- round-count lifecycle only applies without a league", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "4350:2026-2027" });
  assert.equal(checkLifecycleRoundConsumption(ent, 999, 1).allowed, true);
});

test("CASE (with league): participant capacity STILL applies normally even with a league attached -- only round-count lifecycle is exempted", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "4350:2026-2027" });
  const check = checkParticipantCapacity(ent, 50, 1);
  assert.equal(check.allowed, false, "participant capacity is a completely separate dimension from lifecycle and must still be enforced");
});

// ---- Structural: server.js wiring ----

const fs = require("node:fs");
const path = require("node:path");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("server.js no longer contains any active FREE_TRIAL plan value assignment/comparison (historical comments referencing what MON-001A got wrong are fine)", () => {
  assert.ok(!/["']FREE_TRIAL["']/.test(serverSrc), "no code may assign or compare against the literal string \"FREE_TRIAL\"");
});

test("server.js's quiniela-meta write path is a real transaction: BEGIN, locks platform_index THEN the meta row (consistent order), COMMIT/ROLLBACK", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes('await client.query("BEGIN");'));
  const platformLockIdx = body.indexOf('await getRowLocked("platform_index", client)');
  const metaLockIdx = body.indexOf("await getRowLocked(info.metaKey, client)");
  assert.ok(platformLockIdx !== -1 && metaLockIdx !== -1 && platformLockIdx < metaLockIdx, "platform_index must be locked BEFORE the meta row, consistently, to avoid deadlocks with self-register");
  assert.ok(body.includes('await client.query("COMMIT");'));
  assert.ok(body.includes('await client.query("ROLLBACK")'));
});

test("server.js's quiniela-meta write path fails CLOSED (402, not silently allowed) when a platform_index entry has no entitlement at all", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  const noEntIdx = body.indexOf("if (!entry.entitlement) {");
  assert.ok(noEntIdx !== -1, "the quiniela-meta write path itself must have its own fail-closed check, distinct from the migration's own (different) '!entry.entitlement' check");
  const slice = body.slice(noEntIdx, noEntIdx + 550);
  assert.ok(slice.includes("res.status(402)"));
});

test("server.js's quiniela-meta write path uses the DURABLE lifecycleConsumedRoundIds list, never a live meta.rounds count comparison, to decide what's newly consumed", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes("entry.lifecycleConsumedRoundIds"));
  assert.ok(body.includes("!consumedIds.has(r.id)"));
  assert.ok(!body.includes("oldPublishedCount"), "the old MON-001A live-published-count comparison must be completely gone");
});

test("server.js's quiniela-meta write path persists BOTH the meta row and the updated platform_index entitlement counters in the SAME transaction (same client), never as two separate unlocked writes", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes('await putRow("platform_index", platformIdx, client);'));
  assert.ok(body.includes("await putRow(info.metaKey, mergedValue, client);"));
});

test("POST /api/self-register is also a real locked transaction with the SAME lock order (platform_index first, then the meta row)", () => {
  const idx = serverSrc.indexOf('app.post("/api/self-register"');
  const nextRoute = serverSrc.indexOf("app.post(", idx + 10);
  const body = serverSrc.slice(idx, nextRoute);
  assert.ok(body.includes('await client.query("BEGIN");'));
  const platformLockIdx = body.indexOf('await getRowLocked("platform_index", client)');
  const metaLockIdx = body.indexOf("await getRowLocked(metaKey, client)");
  assert.ok(platformLockIdx !== -1 && metaLockIdx !== -1 && platformLockIdx < metaLockIdx);
  assert.ok(body.includes('await client.query("COMMIT");'));
});

test("POST /api/create-quiniela reads commercial_config and builds a FREE entitlement via buildFreeEntitlement -- never hardcodes 10/7 inline", () => {
  const idx = serverSrc.indexOf('app.post("/api/create-quiniela"');
  const body = serverSrc.slice(idx, idx + 4500);
  assert.ok(body.includes('await getRow("commercial_config", client)'));
  assert.ok(body.includes("buildFreeEntitlement(commercialConfig)"));
  assert.ok(!body.includes("participantLimit: 10"), "the number must never be inlined directly in server.js -- only ever read from commercial_config via planLimits.js");
});

test("ensureTable() seeds commercial_config from DEFAULT_COMMERCIAL_CONFIG and runs the grandfathering migration idempotently", () => {
  const idx = serverSrc.indexOf("async function ensureTable()");
  const nextFn = serverSrc.indexOf("async function getRow(", idx);
  const body = serverSrc.slice(idx, nextFn);
  assert.ok(body.includes("'commercial_config'"));
  assert.ok(body.includes("ON CONFLICT (key) DO NOTHING"));
  assert.ok(body.includes("buildGrandfatheredEntitlement("));
  assert.ok(body.includes("if (!entry.entitlement) {"));
});

test("commercial_config is classified as a platform-tier key -- protected by the same platform password as platform_settings/platform_index", () => {
  assert.ok(serverSrc.includes('const PLATFORM_KEYS = new Set(["platform_settings", "platform_index", "platform_payment_log", "commercial_config"]);'));
});

test("a commercial_config write is validated with isCommercialConfigValid BEFORE being persisted, and gets an auto-incremented version + updatedAt/updatedBy stamp", () => {
  const idx = serverSrc.indexOf('if (req.params.key === "commercial_config") {');
  const body = serverSrc.slice(idx, idx + 900);
  assert.ok(body.includes("isCommercialConfigValid(value)"));
  assert.ok(body.includes("res.status(400)"));
  assert.ok(body.includes("version:"));
  assert.ok(body.includes('updatedBy: "platform"'));
});
