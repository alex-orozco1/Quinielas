// MON-002B — the plan surface, the paywall, and the removal of the legacy
// one.
//
// MON-002A found that QRACKS was showing one paywall and enforcing another:
// the visible block counted 5 rounds and asked for $10 x participants by
// bank deposit, purely in the browser, while the server enforced 7 rounds
// and knew about a $199 flat price nothing in the product could ever reach.
// PLUS itself was unreachable — its builder existed and was unit-tested, and
// server.js never imported it.
//
// These tests cover the replacement end to end: what the server hands the
// Admin, what the Admin's screens do with it, what a PARTICIPANT must never
// receive, and the proof that the legacy model is gone rather than merely
// hidden.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_COMMERCIAL_CONFIG, isCommercialConfigValid,
  buildFreeEntitlement, buildPlusEntitlement, buildGrandfatheredEntitlement, buildManualGrantEntitlement,
  checkParticipantCapacity, checkLifecycleRoundConsumption,
  summarizePlan, buildUpgradeOffer, isValidManualGrantLimits,
} = require("../planLimits");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

const cfg = DEFAULT_COMMERCIAL_CONFIG;
const FREE = buildFreeEntitlement(cfg);
const PLUS = buildPlusEntitlement(cfg);

// Scans CODE, not documentation. A comment explaining what was removed must
// not be able to fail a "this is removed" assertion — that is how a test
// starts policing prose instead of behaviour. URLs are protected by only
// treating "//" as a comment when it is not preceded by ":".
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === "/" && line[i + 1] === "/" && line[i - 1] !== ":") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

function blockFrom(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at !== -1, `no se encontró: ${marker}`);
  const braceStart = source.indexOf("{", at);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(at, i + 1); }
  }
  throw new Error(`bloque sin cerrar: ${marker}`);
}

// ==== 1. what the plan endpoint reports ====================================

test("PLAN READ: FREE reports the live numbers, its usage, and a real upgrade offer", () => {
  const s = summarizePlan(FREE, cfg, { participantsUsed: 8, roundsUsed: 5 });
  assert.equal(s.plan, "FREE");
  assert.equal(s.planLabel, "Gratis");
  assert.deepEqual(s.participants, { used: 8, limit: 10, remaining: 2 });
  assert.deepEqual(s.rounds, { used: 5, limit: 7, remaining: 2, applies: true });
  assert.equal(s.upgrade.available, true);
  assert.equal(s.upgrade.priceMXN, 199);
  assert.equal(s.upgrade.participantLimit, 50);
  assert.equal(s.upgrade.roundLimit, 18);
});

test("PLAN READ: PLUS reports its own snapshot and offers nothing further", () => {
  const s = summarizePlan(PLUS, cfg, { participantsUsed: 49, roundsUsed: 17 });
  assert.equal(s.planLabel, "Plus");
  assert.deepEqual(s.participants, { used: 49, limit: 50, remaining: 1 });
  assert.deepEqual(s.rounds, { used: 17, limit: 18, remaining: 1, applies: true });
  assert.equal(s.upgrade.available, false);
  assert.equal(s.upgrade.priceMXN, undefined, "an offer that cannot be taken carries no price");
});

test("PLAN READ: PLUS with a tournament reports the round budget as not applying", () => {
  const bound = buildPlusEntitlement(cfg, undefined, { competitionIdentity: "4350:2026-2027" });
  const s = summarizePlan(bound, cfg, { participantsUsed: 12, roundsUsed: 34 });
  assert.equal(s.rounds.applies, false);
  assert.equal(s.rounds.limit, null);
  assert.equal(s.rounds.used, 34, "usage is still reported, it just isn't a budget");
  assert.equal(s.competition.bound, true);
});

test("PLAN READ: FREE with a tournament STILL reports a round budget — a league is not a way out of the free plan", () => {
  const bound = buildFreeEntitlement(cfg);
  bound.competitionIdentity = "4350:2026-2027";
  const s = summarizePlan(bound, cfg, { participantsUsed: 3, roundsUsed: 6 });
  assert.equal(s.rounds.applies, true);
  assert.equal(s.rounds.limit, 7);
  assert.equal(s.rounds.remaining, 1);
  assert.equal(s.competition.bound, true);
});

test("PLAN READ: GRANDFATHERED and MANUAL_GRANT report their own ceilings and no offer", () => {
  const gf = summarizePlan(buildGrandfatheredEntitlement(), cfg, { participantsUsed: 12, roundsUsed: 40 });
  assert.equal(gf.planLabel, "Sin límite");
  assert.equal(gf.participants.limit, 100000);
  assert.equal(gf.upgrade.available, false);

  const manual = buildManualGrantEntitlement(undefined, { grantedBy: "platform:x", participantLimit: 25, manualRoundLimit: 12, reason: "soporte" });
  const m = summarizePlan(manual, cfg, { participantsUsed: 20, roundsUsed: 3 });
  assert.equal(m.planLabel, "Especial");
  assert.deepEqual(m.participants, { used: 20, limit: 25, remaining: 5 });
  assert.deepEqual(m.rounds, { used: 3, limit: 12, remaining: 9, applies: true });
  assert.equal(m.upgrade.available, false);
});

test("PLAN READ: a missing, unknown or revoked entitlement reports unavailable rather than inventing a plan", () => {
  for (const ent of [null, undefined, {}, { plan: "UNLIMITED" }, { plan: "FREE", revoked: true }]) {
    const s = summarizePlan(ent, cfg, { participantsUsed: 3, roundsUsed: 1 });
    assert.equal(s.available, false, `must fail closed for ${JSON.stringify(ent)}`);
    assert.equal(s.participants, null);
    assert.equal(s.upgrade.available, false);
  }
});

test("PLAN READ: usage never goes negative when a limit was lowered under an existing quiniela", () => {
  const s = summarizePlan(FREE, { ...cfg, free: { participantLimit: 5, manualRoundLimit: 3 } }, { participantsUsed: 9, roundsUsed: 6 });
  assert.equal(s.participants.remaining, 0);
  assert.equal(s.rounds.remaining, 0);
});

test("PLAN READ: the endpoint is Admin/owner only, and 404s an unknown quiniela before anything else", () => {
  const handler = blockFrom(serverSrc, 'app.get("/api/quinielas/:slug/plan"');
  assert.ok(handler.includes("computeRequesterIdentity(req, slug, meta)"), "must resolve who is asking");
  assert.ok(handler.includes('if (!isAdminOrOwner) return res.status(403).json({ error: "forbidden" });'),
    "a participant must be refused: this response carries the price the organizer pays QRACKS");
  const notFoundAt = handler.indexOf('res.status(404)');
  const authAt = handler.indexOf("isAdminOrOwner");
  assert.ok(notFoundAt !== -1 && notFoundAt < authAt, "an unknown slug is answered before auth work is done");
  assert.ok(!handler.includes("ownerPassword"), "no secret may appear in the response");
  assert.ok(!handler.includes("depositInfo"));
});

test("PLAN READ: usage comes from the DURABLE lifecycle counter, never from meta.rounds.length", () => {
  const handler = blockFrom(serverSrc, 'app.get("/api/quinielas/:slug/plan"');
  const code = stripComments(handler);
  assert.ok(code.includes("entry.lifecycleRoundsConsumed"), "the durable counter is the source");
  assert.ok(!code.includes("meta.rounds.length"), "deleting a round must not appear to return budget");
  assert.ok(!code.includes("meta.rounds"), "the round array plays no part in the reported usage at all");
});

// ==== 2. participant capacity, exactly as the ticket specifies =============

test("PARTICIPANTS: FREE 8/10 and 9/10 are normal, 10/10 refuses the eleventh", () => {
  assert.equal(checkParticipantCapacity(FREE, cfg, 8, 1).allowed, true);
  assert.equal(checkParticipantCapacity(FREE, cfg, 9, 1).allowed, true);
  const blocked = checkParticipantCapacity(FREE, cfg, 10, 1);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "plan_participant_limit_reached");
  assert.equal(blocked.limit, 10);
});

test("PARTICIPANTS: the Admin counts inside the 10 — a FREE quiniela holds 1 organizer + 9 others", () => {
  // create-quiniela inserts the creator AS a participant, and every capacity
  // check measures participants.length, so this is arithmetic, not policy.
  assert.ok(serverSrc.includes('participants: [{ id: creatorId, name: cleanCreatorName, isAdmin: true'));
  assert.equal(checkParticipantCapacity(FREE, cfg, 9, 1).allowed, true, "the 10th person fits");
  assert.equal(checkParticipantCapacity(FREE, cfg, 10, 1).allowed, false, "the 11th does not");
});

test("PARTICIPANTS: PLUS 49/50 fits, 50/50 refuses", () => {
  assert.equal(checkParticipantCapacity(PLUS, cfg, 49, 1).allowed, true);
  const blocked = checkParticipantCapacity(PLUS, cfg, 50, 1);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.limit, 50);
});

test("PARTICIPANTS: a bulk add that does not fit is refused as a whole, never partially", () => {
  const r = checkParticipantCapacity(FREE, cfg, 8, 5);
  assert.equal(r.allowed, false, "8 + 5 > 10");
  assert.equal(checkParticipantCapacity(FREE, cfg, 8, 2).allowed, true, "8 + 2 fits exactly");
  assert.equal(checkParticipantCapacity(FREE, cfg, 8, 3).allowed, false);
});

test("PARTICIPANTS: an existing participant coming back is not an addition and is never checked", () => {
  // Re-entry adds nobody, so additionalCount is 0 — and a full quiniela must
  // never lock its own people out.
  assert.equal(checkParticipantCapacity(FREE, cfg, 10, 0).allowed, true);
  assert.equal(checkParticipantCapacity(PLUS, cfg, 50, 0).allowed, true);
  // Even a quiniela already OVER its limit (a lowered config) lets its
  // people back in.
  assert.equal(checkParticipantCapacity(FREE, { ...cfg, free: { participantLimit: 5, manualRoundLimit: 7 } }, 10, 0).allowed, true);
});

test("PARTICIPANTS: two simultaneous registrations for the last seat — one wins, one is refused", async () => {
  // The lock is what makes this deterministic; the check is what makes the
  // loser fail closed rather than both landing at 11.
  let stored = { participants: Array.from({ length: 9 }, (_, i) => ({ id: "p" + i })) };
  let lock = null;
  async function register(id) {
    while (lock) await lock;
    let release;
    lock = new Promise((r) => { release = r; });
    try {
      const current = JSON.parse(JSON.stringify(stored));
      const check = checkParticipantCapacity(FREE, cfg, current.participants.length, 1);
      if (!check.allowed) return { status: 402 };
      current.participants.push({ id });
      stored = current;
      return { status: 200 };
    } finally { lock = null; release(); }
  }
  const [a, b] = await Promise.all([register("x"), register("y")]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 402], "exactly one gets the seat");
  assert.equal(stored.participants.length, 10, "and the quiniela never exceeds its plan");
});

test("PARTICIPANTS: a participant refused at the door is told nothing commercial", () => {
  const handler = blockFrom(serverSrc, 'app.post("/api/self-register"');
  const at = handler.indexOf("if (!check.allowed)");
  const slice = handler.slice(at, at + 700);
  assert.ok(slice.includes('return res.status(402).json({ error: check.reason });'),
    "the bare code and nothing else");
  assert.ok(!slice.includes("buildUpgradeOffer"), "no upgrade offer");
  assert.ok(!slice.includes("limit: check.limit"), "no limit number");
  assert.ok(!slice.includes("plan: check.plan"), "no plan name");
});

test("PARTICIPANTS: the guest-facing copy names no plan, no limit and no price", () => {
  const at = indexSrc.indexOf('}else if(result.error === "plan_participant_limit_reached"){');
  assert.ok(at !== -1);
  const slice = indexSrc.slice(at, at + 500);
  assert.ok(slice.includes("Esta quiniela ya está llena. Avísale a quien la organiza."));
  for (const forbidden of ["Plus", "$", "199", "límite de"]) {
    assert.ok(!slice.includes(forbidden), `la copy del invitado no debe contener "${forbidden}"`);
  }
});

// ==== 3. lifecycle ========================================================

test("LIFECYCLE: FREE publishes its 7th round and is refused the 8th", () => {
  assert.equal(checkLifecycleRoundConsumption(FREE, cfg, 6, 1).allowed, true, "6 -> 7 is allowed");
  const blocked = checkLifecycleRoundConsumption(FREE, cfg, 7, 1);
  assert.equal(blocked.allowed, false, "7 -> 8 is refused");
  assert.equal(blocked.reason, "plan_lifecycle_limit_reached");
  assert.equal(blocked.limit, 7);
});

test("LIFECYCLE: PLUS without a tournament publishes its 18th and is refused the 19th", () => {
  assert.equal(checkLifecycleRoundConsumption(PLUS, cfg, 17, 1).allowed, true);
  assert.equal(checkLifecycleRoundConsumption(PLUS, cfg, 18, 1).allowed, false);
  assert.equal(checkLifecycleRoundConsumption(PLUS, cfg, 18, 1).limit, 18);
});

test("LIFECYCLE: a bulk publish is judged on the total, not one round at a time", () => {
  assert.equal(checkLifecycleRoundConsumption(FREE, cfg, 5, 2).allowed, true);
  assert.equal(checkLifecycleRoundConsumption(FREE, cfg, 5, 3).allowed, false, "5 + 3 > 7");
});

test("LIFECYCLE: deleting a round does not return budget — the counter is a durable id list", () => {
  const branch = serverSrc.slice(serverSrc.indexOf("const consumedIds = new Set(entry.lifecycleConsumedRoundIds || []);"));
  assert.ok(branch.includes("entry.lifecycleConsumedRoundIds = [...consumedIds, ...newlyConsumedIds];"),
    "ids accumulate; nothing ever removes one");
  assert.ok(!branch.slice(0, 1500).includes("lifecycleConsumedRoundIds.filter"),
    "no path may prune the consumed list");
  // and re-publishing the same id is never counted twice
  assert.ok(branch.includes("!consumedIds.has(r.id)"));
});

test("LIFECYCLE: actions that consume nothing are never blocked, even at the limit", () => {
  // additionalCount <= 0 short-circuits before any limit is consulted, which
  // is what keeps results, standings and edits working on a blocked quiniela.
  assert.equal(checkLifecycleRoundConsumption(FREE, cfg, 99, 0).allowed, true);
  assert.equal(checkLifecycleRoundConsumption(FREE, cfg, 99, -1).allowed, true);
  assert.equal(checkParticipantCapacity(FREE, cfg, 99, 0).allowed, true);
  // and the server only runs the round check when there is something new
  assert.ok(serverSrc.includes("if (newlyConsumedIds.length > 0) {"));
  assert.ok(serverSrc.includes("if (newParticipantCount > oldParticipantCount) {"));
});

// ==== 4. commercial config ================================================

test("CONFIG: FREE tracks the live config immediately, with no re-grant", () => {
  const wider = { ...cfg, version: 2, free: { participantLimit: 12, manualRoundLimit: 9 } };
  assert.equal(checkParticipantCapacity(FREE, wider, 11, 1).allowed, true, "the same entitlement now allows more");
  assert.equal(checkLifecycleRoundConsumption(FREE, wider, 8, 1).allowed, true);
  const narrower = { ...cfg, version: 3, free: { participantLimit: 5, manualRoundLimit: 3 } };
  assert.equal(checkParticipantCapacity(FREE, narrower, 5, 1).allowed, false, "and fewer");
});

test("CONFIG: a PLUS snapshot ignores every later config change, in both directions", () => {
  const bought = buildPlusEntitlement(cfg); // 50 / 18 / $199
  const cheapened = { ...cfg, version: 9, plus: { participantLimit: 5, manualRoundLimit: 2, priceMXN: 1 } };
  assert.equal(checkParticipantCapacity(bought, cheapened, 45, 1).allowed, true, "a lowered config cannot shrink a purchase");
  assert.equal(checkLifecycleRoundConsumption(bought, cheapened, 15, 1).allowed, true);
  const inflated = { ...cfg, version: 10, plus: { participantLimit: 500, manualRoundLimit: 500, priceMXN: 999 } };
  assert.equal(checkParticipantCapacity(bought, inflated, 50, 1).allowed, false, "nor grow it");
});

test("CONFIG: the price and the limits of a PLUS grant come from the server, never the request", () => {
  const handler = blockFrom(serverSrc, 'app.post("/api/platform/quinielas/:slug/entitlement"');
  assert.ok(handler.includes('const commercialConfig = (await getRow("commercial_config", client))'),
    "read inside the transaction");
  const plusBranch = handler.slice(handler.indexOf('if (plan === "PLUS")'), handler.indexOf('} else if (plan === "MANUAL_GRANT")'));
  assert.ok(plusBranch.includes("buildPlusEntitlement(commercialConfig, now"), "built from the config");
  assert.ok(!plusBranch.includes("body.participantLimit"), "never from the body");
  assert.ok(!plusBranch.includes("body.priceMXN"));
  assert.ok(!plusBranch.includes("body.manualRoundLimit"));
});

test("CONFIG: a browser cannot fabricate a 500-person PLUS", () => {
  // The only path that reads caller-supplied numbers is MANUAL_GRANT, and it
  // validates them; PLUS ignores them entirely.
  const forged = buildPlusEntitlement(cfg, undefined, { participantLimit: 500, manualRoundLimit: 500 });
  assert.equal(forged.participantLimit, 50, "buildPlusEntitlement takes limits only from the config");
  assert.equal(forged.manualRoundLimit, 18);
  assert.equal(forged.pricePaidMXN, 199);
  assert.equal(isValidManualGrantLimits(500, 500), true, "a manual override MAY be large...");
  assert.equal(isValidManualGrantLimits(100001, 5), false, "...but not unbounded");
  assert.equal(isValidManualGrantLimits(0, 5), false);
  assert.equal(isValidManualGrantLimits("10", 5), false);
});

test("CONFIG: the server refuses an invalid commercial config before it can corrupt enforcement", () => {
  assert.equal(isCommercialConfigValid(cfg), true);
  for (const bad of [
    { ...cfg, free: { participantLimit: 0, manualRoundLimit: 7 } },
    { ...cfg, free: { participantLimit: 10, manualRoundLimit: 0 } },
    { ...cfg, plus: { participantLimit: 5, manualRoundLimit: 18, priceMXN: 199 } },   // plus < free
    { ...cfg, plus: { participantLimit: 50, manualRoundLimit: 3, priceMXN: 199 } },   // plus < free
    { ...cfg, plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: -1 } },
    { ...cfg, upgradeContact: 123 },
    { ...cfg, upgradeContact: "x".repeat(201) },
    null, undefined, "nope", 42,
  ]) {
    assert.equal(isCommercialConfigValid(bad), false, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(isCommercialConfigValid({ ...cfg, upgradeContact: "hola@qracks.mx" }), true);
  // and the write path actually calls it
  assert.ok(serverSrc.includes('if (req.params.key === "commercial_config") {'));
  assert.ok(serverSrc.includes('return res.status(400).json({ error: "invalid_commercial_config" });'));
});

test("CONFIG: the editor carries the version it read, so a concurrent edit conflicts instead of overwriting", () => {
  const at = indexSrc.indexOf('const commercialSaveBtn = document.getElementById("qz-c-save");');
  assert.ok(at !== -1, "el editor debe existir");
  const body = indexSrc.slice(at, at + 1400);
  assert.ok(body.includes("version: config.version"), "must state the version it read");
  assert.ok(body.includes("setCommercialConfig(next)"));
  assert.ok(body.includes("platformStaleHandled"), "a 409 is handled and recoverable, not silently swallowed");
});

// ==== 5. the legacy model is gone, not hidden =============================

test("LEGACY: the cobro model has no remaining code path anywhere", () => {
  const frontCode = stripComments(indexSrc);
  const serverCode = stripComments(serverSrc);
  for (const gone of [
    "getPaymentStatus(",              // the browser-side status read
    "renderPaymentBanner",            // the deposit banner
    "blockingStatus",                 // the frontend-only round gate
    "/api/payment-status",            // the unauthenticated endpoint
    "pricePerParticipant",            // $10 x participants
    "depositInfo",                    // bank details
    "jornadaLimit",                   // the 5-round threshold
    "customJornadaLimit",             // its per-quiniela twin
    "data-paid-toggle",
    "data-exempt-toggle",
  ]) {
    assert.ok(!frontCode.includes(gone), `"${gone}" debe haber desaparecido del frontend`);
  }
  for (const gone of ["/api/payment-status", "applyPaidToggle", "pricePerParticipant", "customJornadaLimit"]) {
    assert.ok(!serverCode.includes(gone), `"${gone}" debe haber desaparecido del servidor`);
  }
});

test("LEGACY: platform_settings is no longer readable without the platform password", () => {
  const fn = blockFrom(serverSrc, "function stripPlatformSecrets(");
  assert.ok(fn.includes("if (!isPlatformAuthed) return {};"),
    "an unauthenticated read must get nothing at all, not everything-minus-the-password");
  assert.ok(fn.includes('if ("dashboardPassword" in clone) delete clone.dashboardPassword;'),
    "and the hash never leaves the server even for an authenticated read");
  const call = serverSrc.slice(serverSrc.indexOf('if (req.params.key === "platform_settings") {'), serverSrc.indexOf('} else if (req.params.key === "platform_index")'));
  assert.ok(call.includes("verifyPassword(providedPlatformAuth, platformHash)"), "the projection is chosen by real auth");
});

test("LEGACY: the dashboard reads platform_settings WITH credentials", () => {
  const fn = indexSrc.slice(indexSrc.indexOf("async function getPlatformSettings()"), indexSrc.indexOf("const COMMERCIAL_CONFIG_KEY"));
  assert.ok(fn.includes("{ platform: platformPasswordCache }"), "or it would read the empty public projection and save it back");
});

test("LEGACY: an existing quiniela is not converted or broken by the removal", () => {
  // exempt/paid stay in storage as inert history; the entitlement is what
  // decides, and grandfathered ones keep their ceiling.
  const gf = buildGrandfatheredEntitlement();
  assert.equal(checkParticipantCapacity(gf, cfg, 60, 1).allowed, true);
  assert.equal(checkLifecycleRoundConsumption(gf, cfg, 900, 1).allowed, true);
  // the boot migration is untouched and still stamps anything without one
  assert.ok(serverSrc.includes("if (!entry.entitlement) {"));
  assert.ok(serverSrc.includes("buildGrandfatheredEntitlement(new Date().toISOString(), {"));
});

test("LEGACY: migrate-quiniela now creates a complete, valid entry instead of one with no plan", () => {
  const handler = blockFrom(serverSrc, 'app.post("/api/migrate-quiniela"');
  assert.ok(handler.includes("const migratedEntitlement = buildGrandfatheredEntitlement("),
    "it must be granted explicitly, not left for a restart to guess at");
  assert.ok(handler.includes("entitlement: migratedEntitlement,"));
  assert.ok(handler.includes("entitlementHistory: [{ action: \"grant\", entitlement: migratedEntitlement"));
  assert.ok(handler.includes("lifecycleRoundsConsumed: 0,"));
  assert.ok(handler.includes("lifecycleConsumedRoundIds: [],"));
  assert.ok(!handler.includes("exempt: true"), "the old silent-bypass flag is not set any more");
});

// ==== 6. the Admin surface =================================================

test("UX: the plan strip is Admin-only and backend-driven", () => {
  const fn = blockFrom(indexSrc, "async function renderPlanStrip()");
  assert.ok(fn.includes("currentUser && currentUser.isAdmin"), "participants never see it");
  assert.ok(fn.includes("await loadPlan()"), "and it renders what the server said");
  const loader = blockFrom(indexSrc, "async function loadPlan(opts)");
  assert.ok(loader.includes('"/api/quinielas/" + encodeURIComponent(SLUG) + "/plan"'));
  assert.ok(loader.includes("adminOrOwnerCred()"), "authenticated as the organizer");
});

test("UX: the status line is composed from the server's numbers, not recomputed", () => {
  const fn = blockFrom(indexSrc, "function planStatusHtml(plan)");
  assert.ok(fn.includes("plan.planLabel"));
  assert.ok(fn.includes("plan.participants.used") && fn.includes("plan.participants.limit"));
  assert.ok(fn.includes("plan.rounds.applies"), "and it honours the server's own applies flag");
  // No commercial number may be written into this function: every one of
  // them must arrive from the server.
  const withoutFieldNames = fn.replace(/plan\.\w+(\.\w+)?/g, "X");
  for (const v of ["10", "7", "50", "18", "199"]) {
    assert.ok(!new RegExp(`(^|[^\\w.])${v}([^\\w]|$)`).test(withoutFieldNames), `no hardcoded ${v}`);
  }
});

test("UX: warnings fire at exactly one remaining, once per threshold, and only for the applicable ones", () => {
  const fn = blockFrom(indexSrc, "function planWarningHtml(plan)");
  assert.ok(fn.includes("plan.participants.remaining === 1"));
  assert.ok(fn.includes("plan.rounds.applies && plan.rounds.remaining === 1"),
    "no round warning when the round budget does not apply");
  assert.ok(fn.includes('planWarningSeen("people")') && fn.includes('planWarningSeen("rounds")'), "once per threshold");
  assert.ok(fn.includes("borrar una jornada no te devuelve el espacio"),
    "the durable-consumption surprise is stated BEFORE it bites");
  // A plan with nothing above it still warns, but never upsells.
  assert.ok(fn.includes("offer\n") || fn.includes("offer ?"), "the CTA is conditional on a real offer");
  assert.ok(fn.includes('`<button class="btn btn-gold btn-sm" data-plan-warning-cta='), "CTA exists when there is an offer");
});

test("UX: the warning 'seen' flag survives a reload, so it informs once instead of nagging", () => {
  const fn = blockFrom(indexSrc, "function markPlanWarningSeen(kind)");
  assert.ok(fn.includes("window.localStorage.setItem"));
  const reader = blockFrom(indexSrc, "function planWarningSeen(kind)");
  assert.ok(reader.includes("window.localStorage.getItem"));
  assert.ok(reader.includes("catch"), "storage failures must not break the screen");
});

test("UX: the hard paywall answers all five required questions, from the server's own refusal", () => {
  const fn = blockFrom(indexSrc, "function showPlanBlock(errorBody)");
  // 1) what happened  2) the free alternative
  assert.ok(fn.includes("headline:") && fn.includes("alternative:"));
  assert.ok(fn.includes("Puedes quitar a alguien de la lista"), "a real free alternative for the people limit");
  assert.ok(fn.includes("Tus jornadas, resultados y tabla siguen aquí"), "and reassurance for the round limit");
  // 3/4/5) unlocks, price, scope — all from the response's upgrade block
  assert.ok(fn.includes("body.upgrade"), "the offer comes from the rejection, with no second read");
  const sheet = blockFrom(indexSrc, "function showUpgradeSheet(upgrade, ctx)");
  assert.ok(sheet.includes("offer.participantLimit") && sheet.includes("offer.roundLimit"), "what Plus unlocks");
  assert.ok(sheet.includes("money(offer.priceMXN)"), "what it costs");
  assert.ok(sheet.includes("offer.scope"), "what it covers");
  assert.ok(sheet.includes("Pasar a Plus"), "one primary action");
});

test("UX: the paywall is honest about the mechanism and does not fake a checkout", () => {
  const sheet = blockFrom(indexSrc, "function showUpgradeSheet(upgrade, ctx)");
  assert.ok(sheet.includes("activamos Plus en esta quiniela"), "it says what actually happens next");
  assert.ok(sheet.includes("offer.contact"), "using the channel the operator configured");
  const code = stripComments(sheet);
  for (const fake of ["Pagar ahora", "checkout", "Stripe", "MercadoPago", "tarjeta"]) {
    assert.ok(!code.includes(fake), `no debe simular un cobro: "${fake}"`);
  }
});

test("UX: no dark patterns — no countdown, no scarcity, no hidden price", () => {
  const sheet = stripComments(blockFrom(indexSrc, "function showUpgradeSheet(upgrade, ctx)"));
  for (const v of ["setTimeout", "Date.now", "quedan pocas", "última oportunidad", "solo por hoy"]) {
    assert.ok(!sheet.includes(v), `dark pattern: ${v}`);
  }
  assert.ok(sheet.includes("un solo pago"), "the price is stated in full the first time Plus is mentioned");
});

test("UX: PLUS at its maximum points at a conversation, never at an invented tier", () => {
  const fn = blockFrom(indexSrc, "function showPlanBlock(errorBody)");
  assert.ok(fn.includes("Si necesitas un grupo más grande, escríbenos."));
  const sheet = blockFrom(indexSrc, "function showUpgradeSheet(upgrade, ctx)");
  assert.ok(sheet.includes("c.noOffer"), "the no-offer sentence is the caller's to choose");
});

test("UX: sharing at capacity warns first and still lets the Admin share", () => {
  const fn = blockFrom(indexSrc, "async function copyAccessLink()");
  assert.ok(fn.includes("plan.participants.remaining === 0"));
  assert.ok(fn.includes("Quien abra el link no va a poder registrarse"));
  assert.ok(fn.includes('cancelLabel: "Compartir de todos modos"'), "sharing anyway must remain possible");
  assert.ok(fn.includes("currentUser && currentUser.isAdmin"), "and only the Admin ever sees this");
});

test("UX: the bulk-add screen says how many seats are left before anything is pasted", () => {
  assert.ok(indexSrc.includes('id="qz-bulk-capacity"'));
  const at = indexSrc.indexOf('const hint = document.getElementById("qz-bulk-capacity");');
  const slice = indexSrc.slice(at - 200, at + 600);
  assert.ok(slice.includes("await loadPlan()"));
  assert.ok(slice.includes("plan.participants.remaining"));
  assert.ok(slice.includes("Tu quiniela está llena"));
});

test("UX: every commercial rejection has copy of its own, and none of it suggests a workaround", () => {
  const at = indexSrc.indexOf("const ERROR_MESSAGES = {");
  const block = indexSrc.slice(at, indexSrc.indexOf("};", at));
  for (const code of [
    "plan_participant_limit_reached", "plan_lifecycle_limit_reached", "entitlement_unavailable",
    "competition_mismatch", "competition_identity_unavailable", "league_change_blocked",
  ]) {
    assert.ok(block.includes(code + ":"), `falta copy para ${code}`);
  }
  const commercial = ["competition_mismatch", "competition_identity_unavailable", "league_change_blocked"];
  commercial.forEach((code) => {
    const line = block.slice(block.indexOf(code + ":"), block.indexOf("\n", block.indexOf(code + ":")));
    assert.ok(!line.includes("manualmente"), `${code} nunca debe sugerir continuar manualmente como salida`);
  });
});

test("UX: a commercial refusal from the import flow is not dressed up as a provider outage", () => {
  const at = indexSrc.indexOf("const syncBtn = document.getElementById(\"qz-sync-competition\");");
  const slice = indexSrc.slice(at, at + 2600);
  assert.ok(slice.includes("res.status === 402"), "402 must be handled on its own");
  assert.ok(slice.includes("humanizeError(data.error)"), "with the commercial copy");
  const at402 = slice.indexOf("res.status === 402");
  const branch = slice.slice(at402, slice.indexOf("} else {", at402));
  assert.ok(!branch.includes("sportsDataFailureMessage"), "and never through the provider-failure message");
});

test("UX: publishing an imported round surfaces a 402 as the paywall, not as 'intenta de nuevo'", () => {
  const at = indexSrc.indexOf('body.querySelectorAll("[data-publish-round]")');
  const slice = indexSrc.slice(at, at + 1400);
  assert.ok(slice.includes("await setMetaWithError(meta)"), "must use the error-aware save");
  assert.ok(slice.includes('result.error === "plan_lifecycle_limit_reached"') && slice.includes("showPlanBlock(result)"));
  assert.ok(!slice.includes('toast("No se pudo publicar, intenta de nuevo")'), "the dead-end retry copy must be gone");
});

// ==== 7. security =========================================================

test("UX: the paywall and the plan panel work at phone width as well as desktop", () => {
  // The sheet reuses the app's existing modal shell rather than inventing a
  // fixed-width one, so it is already fluid: max-width with width:100%.
  const sheet = blockFrom(indexSrc, "function showUpgradeSheet(upgrade, ctx)");
  assert.ok(sheet.includes('overlay.className = "qz-modal-overlay"'), "usa el shell compartido");
  assert.ok(sheet.includes('class="qz-modal-card"'));
  const css = indexSrc.slice(indexSrc.indexOf(".qz-modal-card{"), indexSrc.indexOf(".qz-modal-title{"));
  assert.ok(css.includes("max-width:420px") && css.includes("width:100%"), "el shell es fluido, no de ancho fijo");
  // The plan strip is a single paragraph in normal flow — nothing to overflow.
  const strip = blockFrom(indexSrc, "function planStatusHtml(plan)");
  assert.ok(strip.includes('<p class="muted"'), "una línea de texto, no una tabla");
  // The dashboard's wider table keeps its horizontal scroll container.
  const table = indexSrc.slice(indexSrc.indexOf('<table class="qz-platform-table"') - 200, indexSrc.indexOf('<table class="qz-platform-table"') + 200);
  assert.ok(table.includes("overflow-x:auto"), "la tabla del panel sigue teniendo scroll horizontal");
  assert.ok(table.includes("min-width:800px"));
});

test("SECURITY: the grant endpoint and every commercial write require the platform password", () => {
  for (const marker of [
    'app.post("/api/platform/quinielas/:slug/entitlement"',
    'app.post("/api/platform/quinielas/:slug/settings"',
  ]) {
    const handler = blockFrom(serverSrc, marker);
    const authAt = handler.indexOf("verifyPassword(providedPlatformAuth, platformHash)");
    const workAt = handler.indexOf("pool.connect()");
    assert.ok(authAt !== -1, `${marker}: debe exigir auth de plataforma`);
    assert.ok(workAt === -1 || authAt < workAt, `${marker}: la auth va antes de tocar la base`);
  }
  // commercial_config goes through the platform branch of POST /api/kv/:key,
  // which authenticates every platform key against the same hash.
  const kv = serverSrc.slice(serverSrc.indexOf('if (info.kind === "platform") {'), serverSrc.indexOf('if (req.params.key === "commercial_config")'));
  assert.ok(kv.includes("verifyPassword(providedPlatformAuth, platformHash)"));
  assert.ok(kv.includes('return res.status(403).json({ error: "unauthorized" });'));
});

test("SECURITY: a malformed grant is refused before any row is touched", () => {
  const handler = blockFrom(serverSrc, 'app.post("/api/platform/quinielas/:slug/entitlement"');
  const connectAt = handler.indexOf("pool.connect()");
  for (const guard of [
    'if (!isUsableGrantId(grantId)) return res.status(400).json({ error: "invalid_grant_id" });',
    'return res.status(400).json({ error: "invalid_plan" });',
    'return res.status(400).json({ error: "invalid_limits" });',
    'return res.status(400).json({ error: "reason_required" });',
  ]) {
    const at = handler.indexOf(guard);
    assert.ok(at !== -1, `falta la validación: ${guard}`);
    assert.ok(at < connectAt, "toda validación de forma ocurre antes de abrir la transacción");
  }
});

test("SECURITY: a hand-crafted request cannot get past a limit any UI would have shown", () => {
  // Enforcement lives in the three write paths, all server-side, all inside
  // a locked transaction. There is no client-side gate left to bypass.
  for (const marker of ['app.post("/api/kv/:key"', 'app.post("/api/self-register"']) {
    const handler = blockFrom(serverSrc, marker);
    assert.ok(handler.includes("checkParticipantCapacity("), `${marker}: capacidad server-side`);
    assert.ok(handler.includes('await client.query("BEGIN")'), `${marker}: dentro de transacción`);
    assert.ok(handler.includes('getRowLocked("platform_index", client)'), `${marker}: leyendo el entitlement bajo lock`);
  }
  assert.ok(blockFrom(serverSrc, 'app.post("/api/kv/:key"').includes("checkLifecycleRoundConsumption("));
});

test("SECURITY: enforcement fails closed on a missing entry, a missing entitlement, or an unreadable one", () => {
  const kv = blockFrom(serverSrc, 'app.post("/api/kv/:key"');
  assert.ok(kv.includes('return res.status(402).json({ error: "entitlement_unavailable" });'));
  const reg = blockFrom(serverSrc, 'app.post("/api/self-register"');
  assert.ok(reg.includes('return res.status(402).json({ error: "entitlement_unavailable" });'));
  const sync = blockFrom(serverSrc, 'app.post("/api/quinielas/:slug/sync-competition"');
  assert.ok(sync.includes('error: "entitlement_unavailable"'), "el import también falla cerrado sin entrada de índice");
  // and the pure layer agrees
  assert.equal(checkParticipantCapacity(null, cfg, 0, 1).allowed, false);
  assert.equal(checkParticipantCapacity({ plan: "FREE" }, null, 0, 1).allowed, false);
  assert.equal(checkLifecycleRoundConsumption({ plan: "FREE" }, { free: {} }, 0, 1).allowed, false);
});

test("SECURITY: the upgrade offer carries no secret and nothing a participant could misuse", () => {
  const offer = buildUpgradeOffer(FREE, { ...cfg, upgradeContact: "hola@qracks.mx" });
  assert.deepEqual(Object.keys(offer).sort(), ["available", "contact", "participantLimit", "priceMXN", "roundLimit", "scope"]);
  assert.deepEqual(buildUpgradeOffer(PLUS, cfg), { available: false });
  assert.deepEqual(buildUpgradeOffer(FREE, null), { available: false }, "no config -> no offer, never a guess");
});
