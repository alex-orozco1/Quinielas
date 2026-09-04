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
  assert.equal(computeCompetitionIdentity(null, "2026-2027"), null);
  assert.equal(computeCompetitionIdentity("", "2026-2027"), null);
  assert.equal(computeCompetitionIdentity("   ", "2026-2027"), null);
  assert.equal(computeCompetitionIdentity("4350", "2026-2027"), "4350:2026-2027");
  assert.equal(computeCompetitionIdentity("4350"), "4350:unknown-season");
  assert.equal(computeCompetitionIdentity("4350", "  "), "4350:unknown-season");
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
  assert.ok(body.includes("entitlement.competitionIdentity = computeCompetitionIdentity(cleanLeagueId, meta.settings.sportsdbSeason);"));
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
  // MON-001F moved the persist step into a locked transaction, so validation
  // and stamping no longer sit in one contiguous block. The invariant is
  // unchanged and is asserted here by ORDER instead of by proximity: reject
  // an invalid config before any row is touched, and stamp the write inside
  // the transaction that persists it.
  const platformBranch = serverSrc.indexOf('if (info.kind === "platform") {', serverSrc.indexOf('app.post("/api/kv/:key"'));
  const body = serverSrc.slice(platformBranch, serverSrc.indexOf('} else if (info.kind === "quiniela-meta") {', platformBranch));
  const validateIdx = body.indexOf("isCommercialConfigValid(value)");
  const connectIdx = body.indexOf("await pool.connect()");
  const stampIdx = body.indexOf('updatedBy: "platform"');
  assert.ok(validateIdx !== -1, "must still validate the incoming config");
  assert.ok(body.includes("res.status(400)"), "must still reject an invalid one with 400");
  assert.ok(stampIdx !== -1, "must still stamp updatedBy");
  assert.ok(validateIdx < connectIdx, "validation happens before the row is opened for writing");
  assert.ok(connectIdx < stampIdx, "stamping happens inside the transaction that persists it");
});

test("ensureTable() seeds commercial_config and runs the grandfathering migration idempotently", () => {
  const idx = serverSrc.indexOf("async function ensureTable()");
  const nextFn = serverSrc.indexOf("async function getRow(", idx);
  const body = serverSrc.slice(idx, nextFn);
  assert.ok(body.includes("'commercial_config'"));
  assert.ok(body.includes("buildGrandfatheredEntitlement("));
  assert.ok(body.includes("if (!entry.entitlement) {"));
});

// ==========================================================================
// MON-001D: competition binding / lifecycle enforcement
// ==========================================================================

const { evaluateCompetitionBinding } = require("../planLimits");

// ---- CASE M: not yet bound -> adopt (forward-looking, never destructive) ----

test("CASE M: an entitlement with no competitionIdentity yet ADOPTS the requested tournament (the 'sin liga -> con liga' transition)", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  const r = evaluateCompetitionBinding(ent, "thesportsdb:4350:2026-2027");
  assert.equal(r.violation, false);
  assert.equal(r.adopt, true);
  assert.equal(r.identity, "thesportsdb:4350:2026-2027");
});

test("CASE M: adoption is a pure decision -- evaluateCompetitionBinding never mutates the entitlement it was handed", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  evaluateCompetitionBinding(ent, "thesportsdb:4350:2026-2027");
  assert.equal(ent.competitionIdentity, null, "the caller decides whether/when to persist the adoption, inside its own transaction");
});

// ---- CASE D/J: same tournament -> always allowed, idempotent ----

test("CASE D/J: an entitlement already bound to exactly the requested tournament proceeds normally, with no re-adoption", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "thesportsdb:4350:2026-2027" });
  const r = evaluateCompetitionBinding(ent, "thesportsdb:4350:2026-2027");
  assert.equal(r.violation, false);
  assert.equal(r.adopt, false, "must not re-stamp/re-log an identity it already has -- keeps re-syncing the same tournament idempotent");
});

// ---- CASE G/I: different tournament -> blocked ----

test("CASE G/I: an entitlement bound to one tournament REFUSES a different season of the same league (the 'next tournament' bypass)", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "thesportsdb:4350:2026-2027" });
  const r = evaluateCompetitionBinding(ent, "thesportsdb:4350:2027-2028");
  assert.equal(r.violation, true);
  assert.equal(r.reason, "competition_mismatch");
  assert.equal(r.boundIdentity, "thesportsdb:4350:2026-2027");
  assert.equal(r.requestedIdentity, "thesportsdb:4350:2027-2028");
});

test("CASE N: an entitlement bound to one league REFUSES a different league entirely", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "thesportsdb:4350:2026-2027" });
  const r = evaluateCompetitionBinding(ent, "thesportsdb:4328:2026-2027");
  assert.equal(r.violation, true);
  assert.equal(r.reason, "competition_mismatch");
});

// ---- CASE L: every supported annual league distinguishes season to season ----

test("CASE L: for each of the 6 annual leagues QRACKS supports, consecutive seasons produce DIFFERENT identities (never collide)", () => {
  ["4328", "4335", "4331", "4332", "4334", "4480"].forEach((leagueId) => {
    const a = computeCompetitionIdentity(leagueId, "2026-2027");
    const b = computeCompetitionIdentity(leagueId, "2027-2028");
    assert.notEqual(a, b, `league ${leagueId}: consecutive seasons must never share an identity`);
    const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: a });
    assert.equal(evaluateCompetitionBinding(ent, b).violation, true, `league ${leagueId}: next season must be refused`);
  });
});

// ---- CASE K: Liga MX Apertura/Clausura -- the documented, UNRESOLVED gap ----

test("CASE K (KNOWN GAP, documented not hidden): Liga MX Apertura and Clausura within the same football year currently produce the SAME identity -- this test asserts the CURRENT limitation truthfully rather than pretending it's solved", () => {
  // seasonDefaults.js's currentDefaultSeason() yields one "YYYY-YYYY"
  // string per football year, and the normalized provider event
  // (sportsDataProvider.normalizeEvent) does not carry strSeason or any
  // tournament/stage label at all -- so there is genuinely no available
  // signal today that separates Apertura from Clausura. Asserting the
  // real behavior keeps this visible and will fail loudly the moment a
  // future ticket introduces a real distinguishing signal.
  const apertura = computeCompetitionIdentity("4350", "2026-2027");
  const clausura = computeCompetitionIdentity("4350", "2026-2027");
  assert.equal(apertura, clausura, "DOCUMENTED GAP: not currently distinguishable -- see the delivery report's open decision");
});

test("CASE K: Liga MX across DIFFERENT football years IS correctly distinguished (the partial protection that does work today)", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "thesportsdb:4350:2026-2027" });
  assert.equal(evaluateCompetitionBinding(ent, "thesportsdb:4350:2027-2028").violation, true);
});

// ---- CASE P/Q/Z: ambiguous / missing / corrupt -> never extends lifecycle ----

test("CASE Q/Z: an undeterminable requested identity (null) is REFUSED for an already-bound quiniela -- ambiguity never extends a lifecycle", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "thesportsdb:4350:2026-2027" });
  const r = evaluateCompetitionBinding(ent, null);
  assert.equal(r.violation, true);
  assert.equal(r.reason, "competition_identity_unavailable");
  assert.equal(r.boundIdentity, "thesportsdb:4350:2026-2027", "the already-confirmed identity is reported back intact, never cleared");
});

test("CASE Q/Z: an undeterminable requested identity is ALSO refused when not yet bound -- never adopts a guess", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  const r = evaluateCompetitionBinding(ent, null);
  assert.equal(r.violation, true);
  assert.equal(r.adopt, undefined, "must never adopt an identity it couldn't determine");
});

test("CASE Z: a missing entitlement is refused (fail-closed), never treated as 'unbound, adopt anything'", () => {
  const r = evaluateCompetitionBinding(null, "thesportsdb:4350:2026-2027");
  assert.equal(r.violation, true);
  assert.equal(r.reason, "entitlement_unavailable");
});

// ---- CASE P: a provider outage never mutates an already-confirmed identity ----

test("CASE P: evaluateCompetitionBinding is pure and read-only -- a provider failure elsewhere can never cause it to clear or rewrite a bound identity", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "thesportsdb:4350:2026-2027" });
  const before = ent.competitionIdentity;
  evaluateCompetitionBinding(ent, null);
  evaluateCompetitionBinding(ent, "thesportsdb:4328:2027-2028");
  assert.equal(ent.competitionIdentity, before, "the bound identity survives any number of failed/mismatched evaluations untouched");
});

// ---- CASE E/F: a league-bound quiniela is NOT limited to 7/18 rounds ----

// MON-002B REVERSED THIS CASE, deliberately and with a product decision
// behind it. The rule used to be "a league lifts the round budget", full
// stop, which meant a FREE quiniela became unlimited the moment its Admin
// picked a league from a dropdown labelled "sirve para sugerir nombres de
// equipos". The approved rule is now: "Gratis = 10 personas + 7 jornadas.
// Plus = 50 personas + torneo completo si existe." A free quiniela may
// import a whole calendar -- importing costs nothing -- but it still only
// gets to PUBLISH its plan's rounds.
test("MON-002B: a FREE quiniela WITH a league is still capped at the FREE round limit -- picking a league is not a way out of the free plan", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  ent.competitionIdentity = "thesportsdb:4350:2026-2027";
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 30, 1).allowed, false);
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 30, 1).reason, "plan_lifecycle_limit_reached");
  // and the boundary itself is unchanged by the league
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 6, 1).allowed, true);
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 7, 1).allowed, false);
});

test("MON-002B: with NO league, a FREE quiniela hits exactly the same limit -- the league changes nothing for FREE either way", () => {
  const bare = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  const bound = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  bound.competitionIdentity = "thesportsdb:4350:2026-2027";
  for (const consumed of [0, 3, 6, 7, 8, 100]) {
    assert.equal(
      checkLifecycleRoundConsumption(bare, DEFAULT_COMMERCIAL_CONFIG, consumed, 1).allowed,
      checkLifecycleRoundConsumption(bound, DEFAULT_COMMERCIAL_CONFIG, consumed, 1).allowed,
      `FREE must behave identically at ${consumed} consumed, league or no league`
    );
  }
});

test("MON-002B: GRANDFATHERED and MANUAL_GRANT keep the whole tournament, like PLUS -- FREE is the only plan that does not", () => {
  const gf = buildGrandfatheredEntitlement();
  gf.competitionIdentity = "thesportsdb:4350:2026-2027";
  assert.equal(checkLifecycleRoundConsumption(gf, DEFAULT_COMMERCIAL_CONFIG, 999, 1).allowed, true);
  const manual = buildManualGrantEntitlement(undefined, { grantedBy: "platform:x", participantLimit: 20, manualRoundLimit: 5, reason: "soporte" });
  manual.competitionIdentity = "thesportsdb:4350:2026-2027";
  assert.equal(checkLifecycleRoundConsumption(manual, DEFAULT_COMMERCIAL_CONFIG, 999, 1).allowed, true);
  // ...and without a tournament, a manual grant is held to its own number
  const manualBare = buildManualGrantEntitlement(undefined, { grantedBy: "platform:x", participantLimit: 20, manualRoundLimit: 5, reason: "soporte" });
  assert.equal(checkLifecycleRoundConsumption(manualBare, DEFAULT_COMMERCIAL_CONFIG, 5, 1).allowed, false);
});

test("CASE F: a PLUS quiniela WITH a league is never accidentally capped at the manual 18-round limit", () => {
  const ent = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, undefined, { competitionIdentity: "thesportsdb:4350:2026-2027" });
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 40, 1).allowed, true);
});

test("CASE S: participant capacity is completely unaffected by competition binding -- a league-bound FREE quiniela still stops at its dynamic participant limit", () => {
  const ent = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
  ent.competitionIdentity = "thesportsdb:4350:2026-2027";
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 9, 1).allowed, true);
  assert.equal(checkParticipantCapacity(ent, DEFAULT_COMMERCIAL_CONFIG, 10, 1).allowed, false);
});

// ---- CASE R: grandfathered quinielas are never retroactively bound ----

test("CASE R: a GRANDFATHERED entitlement has no competitionIdentity and is therefore never blocked by binding -- legacy quinielas are not retroactively locked to a tournament", () => {
  const ent = buildGrandfatheredEntitlement();
  assert.equal(ent.competitionIdentity, null);
  assert.equal(checkLifecycleRoundConsumption(ent, DEFAULT_COMMERCIAL_CONFIG, 500, 1).allowed, true);
  // It CAN still adopt one if it ever syncs a league -- forward-looking only, never retroactive.
  assert.equal(evaluateCompetitionBinding(ent, "thesportsdb:4350:2026-2027").adopt, true);
});

// ---- Structural: server.js wiring for MON-001D ----

test("MON-001D: sync-competition locks platform_index BEFORE the meta row -- same global order as the kv-write and self-register paths (deadlock safety)", () => {
  const idx = serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"');
  const body = serverSrc.slice(idx, idx + 2000);
  const pIdx = body.indexOf('await getRowLocked("platform_index", client)');
  const mIdx = body.indexOf("await getRowLocked(metaKey, client)");
  assert.ok(pIdx !== -1 && mIdx !== -1 && pIdx < mIdx, "platform_index must be locked first");
});

test("MON-001D: sync-competition evaluates the competition binding BEFORE calling the provider -- a mismatch fetches and writes nothing at all", () => {
  const idx = serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"');
  // Ventana ampliada en MON-002C: el handler creció con el registro de la
  // competencia sobre la metadata del ciclo.
  const body = serverSrc.slice(idx, idx + 9000);
  const bindIdx = body.indexOf("evaluateCompetitionBinding(bindingEntry.entitlement, requestedIdentity)");
  const fetchIdx = body.indexOf("await sportsDataProvider.getSeasonEvents(");
  assert.ok(bindIdx !== -1 && fetchIdx !== -1 && bindIdx < fetchIdx, "binding must be checked before any provider call");
});

test("MON-001D: a binding violation in sync-competition ROLLBACKs and returns 402 with both identities, importing nothing", () => {
  const idx = serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"');
  const body = serverSrc.slice(idx, idx + 6000);
  const vIdx = body.indexOf("if (binding.violation) {");
  assert.ok(vIdx !== -1);
  const slice = body.slice(vIdx, vIdx + 600);
  assert.ok(slice.includes('await client.query("ROLLBACK")'));
  assert.ok(slice.includes("res.status(402)"));
  assert.ok(slice.includes("boundIdentity") && slice.includes("requestedIdentity"));
});

test("MON-001D: adoption persists the identity onto the ENTITLEMENT (platform_index, platform-tier) and appends an audit-trail entry -- never into owner-writable meta", () => {
  const idx = serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"');
  const body = serverSrc.slice(idx, idx + 6000);
  assert.ok(body.includes("bindingEntry.entitlement.competitionIdentity = binding.identity;"));
  assert.ok(body.includes('action: "competition_bound"'));
  assert.ok(body.includes('await putRow("platform_index", platformIdx, client);'));
});

test("MON-001D: the requested identity is derived server-side from the resolved league+season, never read from the request body", () => {
  const idx = serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"');
  const body = serverSrc.slice(idx, idx + 6000);
  assert.ok(body.includes("const requestedIdentity = computeCompetitionIdentity(externalLeagueId, season);"));
  assert.ok(!body.includes("req.body.competitionIdentity"), "must never accept a client-supplied competition identity");
});

test("CASE Y: imported rounds carry competitionIdentity for auditability, but it lives in owner-writable meta and is explicitly NOT the enforcement authority", () => {
  const idx = serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"');
  // Window widened in MON-002B: the handler grew a fail-closed branch for a
  // per-slug quiniela with no platform_index entry, which pushed the round
  // stamping further down.
  const body = serverSrc.slice(idx, idx + 8000);
  assert.ok(body.includes("competitionIdentity: requestedIdentity,"));
  // The enforcement path reads the ENTITLEMENT, never the round's own stamp.
  assert.ok(body.includes("evaluateCompetitionBinding(bindingEntry.entitlement"));
});

// ---- CASE P (adoption side): a provider failure must never leave a
// quiniela bound to an UNVERIFIED tournament ----

test("CASE P: adoption is written inside the same transaction the provider-failure path ROLLBACKs -- a quiniela never gets bound to a tournament whose schedule could not actually be fetched", () => {
  const idx = serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"');
  const body = serverSrc.slice(idx, idx + 7000);
  const adoptIdx = body.indexOf("bindingEntry.entitlement.competitionIdentity = binding.identity;");
  const providerCatchIdx = body.indexOf('await client.query("ROLLBACK"); // fail-safe: no partial writes on provider failure');
  assert.ok(adoptIdx !== -1 && providerCatchIdx !== -1 && adoptIdx < providerCatchIdx,
    "adoption happens before the provider call, inside the same transaction, so a provider failure undoes it -- confirmed E2E: a sync that fails at the provider leaves competitionIdentity null rather than binding to something unverified");
});

test("CASE P: an ALREADY-bound identity is never touched by a mismatch check -- the mismatch path returns before any write, so a wrong/ambiguous request cannot clear a confirmed binding", () => {
  const idx = serverSrc.indexOf('app.post("/api/quinielas/:slug/sync-competition"');
  const body = serverSrc.slice(idx, idx + 7000);
  const vIdx = body.indexOf("if (binding.violation) {");
  const slice = body.slice(vIdx, vIdx + 600);
  assert.ok(!slice.includes("competitionIdentity ="), "the violation branch must never assign a competition identity");
  assert.ok(!slice.includes('putRow("platform_index"'), "the violation branch must never write platform_index at all");
});
