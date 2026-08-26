// planLimits.js — MON-001C: exhaustive behavioral tests against the REAL,
// CORRECTED module. Central new behavior vs MON-001B: FREE entitlements
// no longer snapshot participantLimit/manualRoundLimit at all -- they
// ALWAYS resolve against the CURRENT commercial_config at enforcement
// time (resolveEnforcementLimits). PLUS/GRANDFATHERED/MANUAL_GRANT keep
// their own frozen numbers, unaffected by later config changes.

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
  resolveEnforcementLimits,
  checkParticipantCapacity,
  checkLifecycleRoundConsumption,
} = require("../planLimits");

// ---- Approved commercial model: exact numbers ----

test("DEFAULT_COMMERCIAL_CONFIG matches the exact approved model: FREE=10 participants/7 rounds, PLUS=50 participants/18 rounds, $199 MXN", () => {
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.free.participantLimit, 10);
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.free.manualRoundLimit, 7);
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.plus.participantLimit, 50);
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.plus.manualRoundLimit, 18);
  assert.equal(DEFAULT_COMMERCIAL_CONFIG.plus.priceMXN, 199);
});

test("there is no active FREE_TRIAL plan/constant anywhere in this module", () => {
  const mod = require("../planLimits");
  assert.equal(mod.FREE_TRIAL_DAYS, undefined);
  assert.equal(typeof mod.getEffectivePlan, "undefined");
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../planLimits"), "utf8");
  assert.ok(!/["']FREE_TRIAL["']/.test(src));
});

// ---- Commercial config validation ----

test("a valid config passes isCommercialConfigValid", () => {
  assert.equal(isCommercialConfigValid(DEFAULT_COMMERCIAL_CONFIG), true);
});

test("free.participantLimit < 1 is rejected", () => {
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 0, manualRoundLimit: 7 }, plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: 199 } }), false);
});

test("plus.participantLimit below free.participantLimit is rejected", () => {
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 10, manualRoundLimit: 7 }, plus: { participantLimit: 5, manualRoundLimit: 18, priceMXN: 199 } }), false);
});

test("negative priceMXN is rejected; priceMXN of exactly 0 is valid", () => {
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 10, manualRoundLimit: 7 }, plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: -1 } }), false);
  assert.equal(isCommercialConfigValid({ free: { participantLimit: 10, manualRoundLimit: 7 }, plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: 0 } }), true);
});

test("missing free or plus block entirely is rejected, never crashes", () => {
  assert.equal(isCommercialConfigValid({}), false);
  assert.equal(isCommercialConfigValid(null), false);
  assert.doesNotThrow(() => isCommercialConfigValid(undefined));
});

// ---- MON-001C CENTRAL CHANGE: FREE entitlements never snapshot limits ----

test("CRITICAL: buildFreeEntitlement does NOT store participantLimit/manualRoundLimit at all -- FREE never snapshots, only tracks live config", () => {
  const config = { version: 5, free: { participantLimit: 12, manualRoundLimit: 9 }, plus: { participantLimit: 60, manualRoundLimit: 20, priceMXN: 299 } };
  const ent = buildFreeEntitlement(config, "2026-01-01T00:00:00.000Z");
  assert.equal(ent.plan, "FREE");
  assert.equal(ent.participantLimit, undefined, "FREE entitlements must never carry a stale snapshot field");
  assert.equal(ent.manualRoundLimit, undefined);
  assert.equal(ent.configVersionAtGrant, 5, "configVersionAtGrant is kept purely as historical context, never re-read for enforcement");
  assert.equal(ent.source, "signup_default");
});

test("CRITICAL: resolveEnforcementLimits for a FREE entitlement ALWAYS reads the CURRENT commercialConfig passed in, ignoring anything on the entitlement itself", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  const changedConfig = { version: 2, free: { participantLimit: 12, manualRoundLimit: 10 }, plus: DEFAULT_COMMERCIAL_CONFIG.plus };
  const limits = resolveEnforcementLimits(ent, changedConfig);
  assert.deepEqual(limits, { participantLimit: 12, manualRoundLimit: 10 }, "must reflect the NEW config immediately, not whatever was true when the entitlement was created");
});

test("CRITICAL: a config change is IMMEDIATELY reflected for an existing FREE quiniela with zero re-grant -- confirmed end to end via checkParticipantCapacity", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG); // created under the OLD config (limit 10)
  const newConfig = { version: 2, free: { participantLimit: 12, manualRoundLimit: 7 }, plus: DEFAULT_COMMERCIAL_CONFIG.plus };
  // 11 -> 12 was blocked under the old config (limit 10), must now be ALLOWED under the new config (limit 12)
  assert.equal(checkParticipantCapacity(ent, newConfig, 11, 1).allowed, true);
  // 12 -> 13 must still be blocked under the new config
  assert.equal(checkParticipantCapacity(ent, newConfig, 12, 1).allowed, false);
});

// ---- PLUS keeps its own frozen snapshot, unaffected by later config changes ----

test("CRITICAL: buildPlusEntitlement DOES snapshot participantLimit/manualRoundLimit/pricePaidMXN -- this is the frozen purchase, unaffected by later commercial_config edits", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, "2026-01-01T00:00:00.000Z");
  assert.equal(ent.participantLimit, 50);
  assert.equal(ent.manualRoundLimit, 18);
  assert.equal(ent.pricePaidMXN, 199);
});

test("CRITICAL: resolveEnforcementLimits for a PLUS entitlement IGNORES the commercialConfig argument entirely -- always uses its own frozen numbers", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG); // bought under 50/18
  const changedConfig = { version: 2, free: DEFAULT_COMMERCIAL_CONFIG.free, plus: { participantLimit: 60, manualRoundLimit: 15, priceMXN: 299 } };
  const limits = resolveEnforcementLimits(ent, changedConfig);
  assert.deepEqual(limits, { participantLimit: 50, manualRoundLimit: 18 }, "an already-purchased Plus must NEVER silently pick up a later config change");
});

test("CRITICAL end to end: a Plus purchased at 50/18 stays at 50/18 even after commercial_config changes to 60/15 -- a NEW Plus purchase would get 60/15", () => {
  const oldConfig = DEFAULT_COMMERCIAL_CONFIG;
  const purchasedEnt = buildPlusEntitlement(oldConfig); // 50/18
  const newConfig = { version: 2, free: oldConfig.free, plus: { participantLimit: 60, manualRoundLimit: 15, priceMXN: 299 } };
  // The EXISTING purchase: 50 -> 51 must still be blocked (its own limit is 50, not 60)
  assert.equal(checkParticipantCapacity(purchasedEnt, newConfig, 50, 1).allowed, false);
  // A NEW purchase under the new config: 59 -> 60 must be allowed (uses the new config's 60)
  const newPurchaseEnt = buildPlusEntitlement(newConfig);
  assert.equal(checkParticipantCapacity(newPurchaseEnt, newConfig, 59, 1).allowed, true);
  assert.equal(checkParticipantCapacity(newPurchaseEnt, newConfig, 60, 1).allowed, false);
});

test("GRANDFATHERED and MANUAL_GRANT also use their own frozen numbers, same as PLUS -- only FREE is dynamic", () => {
  const grandfathered = buildGrandfatheredEntitlement();
  const manual = buildManualGrantEntitlement(undefined, { grantedBy: "platform:x", participantLimit: 999, manualRoundLimit: 999 });
  const changedConfig = { version: 2, free: { participantLimit: 1, manualRoundLimit: 1 }, plus: DEFAULT_COMMERCIAL_CONFIG.plus };
  assert.deepEqual(resolveEnforcementLimits(grandfathered, changedConfig), { participantLimit: GRANDFATHER_CEILING.participantLimit, manualRoundLimit: GRANDFATHER_CEILING.manualRoundLimit });
  assert.deepEqual(resolveEnforcementLimits(manual, changedConfig), { participantLimit: 999, manualRoundLimit: 999 });
});

test("resolveEnforcementLimits returns null (fail-closed signal) for a FREE entitlement when commercialConfig itself is missing/invalid -- never guesses a default", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(resolveEnforcementLimits(ent, null), null);
  assert.equal(resolveEnforcementLimits(ent, {}), null);
  assert.equal(resolveEnforcementLimits(ent, { free: { participantLimit: "not a number" } }), null);
});

// ---- isKnownPlan ----

test("isKnownPlan recognizes exactly FREE, PLUS, GRANDFATHERED, MANUAL_GRANT", () => {
  assert.equal(isKnownPlan("FREE"), true);
  assert.equal(isKnownPlan("PLUS"), true);
  assert.equal(isKnownPlan("GRANDFATHERED"), true);
  assert.equal(isKnownPlan("MANUAL_GRANT"), true);
  assert.equal(isKnownPlan("FREE_TRIAL"), false);
  assert.equal(isKnownPlan(undefined), false);
});

// ---- FAIL-CLOSED ----

test("CRITICAL: a completely missing entitlement is DENIED regardless of commercialConfig validity", () => {
  assert.equal(checkParticipantCapacity(null, DEFAULT_COMMERCIAL_CONFIG, 0, 1).allowed, false);
  assert.equal(checkParticipantCapacity(null, DEFAULT_COMMERCIAL_CONFIG, 0, 1).reason, "entitlement_unavailable");
  assert.equal(checkLifecycleRoundConsumption(undefined, DEFAULT_COMMERCIAL_CONFIG, 0, 1).allowed, false);
});

test("CRITICAL: an unrecognized plan string is DENIED even with a perfectly valid commercialConfig", () => {
  const corrupt = { plan: "SOME_FUTURE_PLAN" };
  assert.equal(checkParticipantCapacity(corrupt, DEFAULT_COMMERCIAL_CONFIG, 0, 1).allowed, false);
});

test("CRITICAL: a revoked entitlement is DENIED even with valid numbers and valid config", () => {
  const revoked = { plan: "PLUS", participantLimit: 50, manualRoundLimit: 18, revoked: true };
  assert.equal(checkParticipantCapacity(revoked, DEFAULT_COMMERCIAL_CONFIG, 0, 1).allowed, false);
});

test("CRITICAL: a FREE entitlement is DENIED if commercialConfig is missing/corrupt, even though the entitlement itself is fine -- FREE has no fallback numbers of its own anymore", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, null, 0, 1).allowed, false);
  assert.equal(checkParticipantCapacity(ent, {}, 0, 1).allowed, false);
});

// ---- FREE: exact boundaries under DEFAULT_COMMERCIAL_CONFIG ----

test("FREE participants: 9 -> 10 allowed, 10 -> 11 blocked (using the passed-in current config)", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 9, 1).allowed, true);
  const blocked = checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 10, 1);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.limit, 10);
  assert.equal(blocked.plan, "FREE");
});

test("FREE lifecycle: 6 -> 7 allowed, 7 -> 8 blocked", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 6, 1).allowed, true);
  const blocked = checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 7, 1);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.limit, 7);
});

// ---- PLUS: exact boundaries ----

test("PLUS participants: 49 -> 50 allowed, 50 -> 51 blocked", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 49, 1).allowed, true);
  const blocked = checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 50, 1);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.limit, 50);
});

test("PLUS lifecycle: 17 -> 18 allowed, 18 -> 19 blocked", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 17, 1).allowed, true);
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 18, 1).allowed, false);
});

// ---- Multiple-at-once ----

test("bulk add: 8 + 3 at once (11 total) on FREE is blocked as a whole", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 8, 3).allowed, false);
});

test("bulk add: 6 + 4 at once (10 total) on FREE is allowed -- lands exactly at the limit", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 6, 4).allowed, true);
});

// ---- Never blocks a decrease/no-op ----

test("additionalCount 0 never blocks, even if currentCount already exceeds the limit", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 15, 0).allowed, true);
});

// ---- GRANDFATHERED ----

test("a grandfathered entitlement already over the new limits keeps working; still has a real (if huge) ceiling", () => {
  const ent = buildGrandfatheredEntitlement();
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 70, 1).allowed, true);
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, GRANDFATHER_CEILING.participantLimit, 1).allowed, false);
});

// ---- Competition identity ----

test("computeCompetitionIdentity: null with no league; combines leagueId+season; handles missing season", () => {
  assert.equal(computeCompetitionIdentity({}), null);
  assert.equal(computeCompetitionIdentity({ sportsdbLeagueId: "4350", sportsdbSeason: "2026-2027" }), "4350:2026-2027");
  assert.equal(computeCompetitionIdentity({ sportsdbLeagueId: "4350" }), "4350:unknown-season");
});

test("CASE (with league): round-count lifecycle is a no-op once competitionIdentity is set; participant capacity still applies", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "4350:2026-2027" });
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 999, 1).allowed, true);
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 50, 1).allowed, false);
});

// ---- Structural: server.js wiring ----

const fs = require("node:fs");
const path = require("node:path");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("server.js no longer contains any active FREE_TRIAL plan value", () => {
  assert.ok(!/["']FREE_TRIAL["']/.test(serverSrc));
});

// ---- MON-001C FIX 1: missing platform_index entry fails closed on BOTH paths ----

test("FIX 1: quiniela-meta write path fails CLOSED for a per-slug quiniela with NO platform_index entry at all (not just no entitlement) -- distinct from the legacy no-slug case", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes("if (info.slug) {"), "must gate the whole entitlement block on info.slug, distinguishing a real per-slug quiniela from the legacy singleton key");
  const slugBlockIdx = body.indexOf("if (info.slug) {");
  const noEntryIdx = body.indexOf("if (!entry) {", slugBlockIdx);
  assert.ok(noEntryIdx !== -1, "must have its own explicit check for a missing platform_index entry, separate from the missing-entitlement check");
  const slice = body.slice(noEntryIdx, noEntryIdx + 300);
  assert.ok(slice.includes("res.status(402)"));
});

test("FIX 1: self-register also fails CLOSED for a per-slug quiniela with no platform_index entry", () => {
  const idx = serverSrc.indexOf('app.post("/api/self-register"');
  const nextRoute = serverSrc.indexOf("app.post(", idx + 10);
  const body = serverSrc.slice(idx, nextRoute);
  assert.ok(body.includes("if (derivedSlug) {"));
  const slugBlockIdx = body.indexOf("if (derivedSlug) {");
  const noEntryIdx = body.indexOf("if (!entry) {", slugBlockIdx);
  assert.ok(noEntryIdx !== -1);
  const slice = body.slice(noEntryIdx, noEntryIdx + 300);
  assert.ok(slice.includes("res.status(402)"));
});

// ---- MON-001C FIX 2: single release strategy ----

test("FIX 2: self-register's invalid_params branch no longer calls client.release() manually -- exactly ONE ACTUAL release() call in the whole handler, inside finally (a historical comment mentioning the removed call doesn't count)", () => {
  const idx = serverSrc.indexOf('app.post("/api/self-register"');
  const nextRoute = serverSrc.indexOf("app.post(", idx + 10);
  const body = serverSrc.slice(idx, nextRoute);
  const occurrences = [...body.matchAll(/^\s*client\.release\(\);\s*$/gm)];
  assert.equal(occurrences.length, 1, "must release the pg client exactly once, in finally, never manually inside an early-return branch");
  const finallyIdx = body.indexOf("} finally {");
  const releaseIdx = body.indexOf("client.release();", finallyIdx);
  assert.ok(finallyIdx !== -1 && releaseIdx > finallyIdx, "the one release() call must be inside the finally block");
});

// ---- MON-001C FIX 3: slug authority ----

test("FIX 3: self-register's session cookie uses derivedSlug (server-validated), never the raw client-supplied `slug` field from the request body", () => {
  const idx = serverSrc.indexOf('app.post("/api/self-register"');
  const nextRoute = serverSrc.indexOf("app.post(", idx + 10);
  const body = serverSrc.slice(idx, nextRoute);
  assert.ok(body.includes("issueSessionCookie(res, derivedSlug, newParticipant);"));
  assert.ok(!body.includes("issueSessionCookie(res, slug, newParticipant);"), "must never use the raw client-supplied slug for session identity");
});

// ---- MON-001C FIX 4: competitionIdentity assignment + league-change policy ----

test("FIX 4: POST /api/create-quiniela computes competitionIdentity on the entitlement immediately when a league was selected at creation -- never left null", () => {
  const idx = serverSrc.indexOf('app.post("/api/create-quiniela"');
  const body = serverSrc.slice(idx, idx + 5000);
  assert.ok(body.includes("if (cleanLeagueId) {"));
  assert.ok(body.includes("entitlement.competitionIdentity = computeCompetitionIdentity(meta.settings);"));
});

test("FIX 4: the quiniela-meta write path blocks changing an ALREADY-set league/season once the quiniela is already operating, unless the write is platform-authenticated", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes("leagueOrSeasonChanged"));
  assert.ok(body.includes("wasAlreadyOperating"));
  assert.ok(body.includes('authTier !== "platform"'));
  assert.ok(body.includes('res.status(403).json({ error: "league_change_blocked" })'));
});

test("FIX 4: selecting a league for the FIRST time (previously unset) is never blocked by the league-change rule -- only changing an ALREADY-set one is", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes("leagueOrSeasonChanged && oldLeagueId && wasAlreadyOperating"), "the block condition must require oldLeagueId to have already existed -- unset-to-set is exempt by construction");
});

test("FIX 4: 'already operating' is judged durably (lifecycleRoundsConsumed > 0 or an existing competitionIdentity), never by the current meta.rounds count alone", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes("entry.entitlement.competitionIdentity") && body.includes("entry.lifecycleRoundsConsumed"));
});

// ---- FREE-vs-PLUS wiring confirmation in server.js ----

test("server.js's quiniela-meta write path reads commercial_config fresh and passes it to BOTH check functions (participant capacity AND lifecycle)", () => {
  const idx = serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {');
  const nextBranch = serverSrc.indexOf('} else if (info.kind === "picks")', idx);
  const body = serverSrc.slice(idx, nextBranch);
  assert.ok(body.includes('await getRow("commercial_config", client)'));
  assert.ok(body.includes("checkParticipantCapacity(entry.entitlement, commercialConfig,"));
  assert.ok(body.includes("checkLifecycleRoundConsumption(entry.entitlement, commercialConfig,"));
});

test("self-register also reads commercial_config fresh and passes it to checkParticipantCapacity", () => {
  const idx = serverSrc.indexOf('app.post("/api/self-register"');
  const nextRoute = serverSrc.indexOf("app.post(", idx + 10);
  const body = serverSrc.slice(idx, nextRoute);
  assert.ok(body.includes('await getRow("commercial_config", client)'));
  assert.ok(body.includes("checkParticipantCapacity(entry.entitlement, commercialConfig,"));
});

test("commercial_config is classified as a platform-tier key", () => {
  assert.ok(serverSrc.includes('const PLATFORM_KEYS = new Set(["platform_settings", "platform_index", "platform_payment_log", "commercial_config"]);'));
});

test("a commercial_config write is validated with isCommercialConfigValid BEFORE being persisted, versioned and stamped", () => {
  const idx = serverSrc.indexOf('if (req.params.key === "commercial_config") {');
  const body = serverSrc.slice(idx, idx + 900);
  assert.ok(body.includes("isCommercialConfigValid(value)"));
  assert.ok(body.includes("res.status(400)"));
  assert.ok(body.includes('updatedBy: "platform"'));
});

test("ensureTable() seeds commercial_config and runs the grandfathering migration idempotently", () => {
  const idx = serverSrc.indexOf("async function ensureTable()");
  const nextFn = serverSrc.indexOf("async function getRow(", idx);
  const body = serverSrc.slice(idx, nextFn);
  assert.ok(body.includes("'commercial_config'"));
  assert.ok(body.includes("buildGrandfatheredEntitlement("));
  assert.ok(body.includes("if (!entry.entitlement) {"));
});
