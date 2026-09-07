// platformConcurrency.test.js — MON-001F.
//
// Reproduces the exact bug class the pre-fix audit demonstrated against a real
// Postgres, then proves it can no longer happen.
//
// WHY A SIMULATED STORE. The suite runs under plain `node --test` with no
// database (every other suite here does the same). So the two actors are
// driven through a tiny in-memory KV that implements the SAME semantics the
// real code relies on: a row lock that serializes transactions, reads that
// see only committed state, and writes that replace the whole document. The
// LOGIC under test is the real, shipped logic from platformState.js — not a
// re-implementation. The structural tests at the bottom then prove server.js
// actually runs that logic inside BEGIN / SELECT ... FOR UPDATE / COMMIT,
// which is the part a simulation cannot assert on its own.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  readStoredVersion, readExpectedVersion, isFreshWrite, stampVersion,
  mergePlatformIndex, applyEntitlementGrant, findPurchaseForScope, applyQuinielaSettings,
  ADMIN_EDITABLE_INDEX_FIELDS, SERVER_OWNED_INDEX_FIELDS,
} = require("../platformState");
const {
  DEFAULT_COMMERCIAL_CONFIG, buildPlusEntitlement, buildFreeEntitlement,
  buildManualGrantEntitlement, buildGrandfatheredEntitlement,
  isValidManualGrantLimits,
} = require("../planLimits");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ---- minimal transactional KV -------------------------------------------
// One writer at a time per key, committed-state reads, whole-document writes.
function createStore(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const locks = new Map();
  return {
    raw(key) { const v = rows.get(key); return v === undefined ? null : JSON.parse(JSON.stringify(v)); },
    // Replaces a row wholesale, for setting up legacy/malformed shapes.
    seed(key, value) { rows.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value))); },
    // Runs fn as a transaction holding the row lock for `key`, exactly like
    // BEGIN; SELECT ... FOR UPDATE; ...; COMMIT.
    async transaction(key, fn) {
      while (locks.get(key)) await locks.get(key);
      let release;
      locks.set(key, new Promise((r) => { release = r; }));
      try {
        const current = rows.has(key) ? JSON.parse(JSON.stringify(rows.get(key))) : null;
        const result = await fn({
          current,
          write(value) { rows.set(key, JSON.parse(JSON.stringify(value))); },
        });
        return result;
      } finally {
        locks.delete(key);
        release();
      }
    },
  };
}

// The server's platform-write decision, expressed once so both the
// concurrency tests and the version tests exercise the same path.
async function platformWrite(store, key, incoming, { merge = null } = {}) {
  const expected = readExpectedVersion(incoming);
  if (!expected.ok) return { status: 400, error: "invalid_version" };
  return store.transaction(key, async ({ current, write }) => {
    const storedVersion = readStoredVersion(current);
    if (!isFreshWrite(storedVersion, expected.expected)) {
      return { status: 409, error: "stale_version", currentVersion: storedVersion };
    }
    const next = stampVersion(merge ? merge(current, incoming) : incoming, storedVersion);
    write(next);
    return { status: 200, ok: true, version: next.version };
  });
}

const indexWrite = (store, incoming) => platformWrite(store, "platform_index", incoming, { merge: mergePlatformIndex });

// ==== FIX 1 — platform_index: the audited scenario ========================

test("PLATFORM_INDEX: the audited T0/T1/T2 lost update no longer happens", async () => {
  const store = createStore({
    platform_index: { version: 1, quinielas: [
      { slug: "alpha", name: "Alpha", entitlement: { plan: "FREE" }, lifecycleRoundsConsumed: 3, lifecycleConsumedRoundIds: ["r1", "r2", "r3"] },
    ] },
  });

  // T0 — the admin panel loads the index and keeps it in browser memory.
  const adminSnapshot = store.raw("platform_index");

  // T1 — a server-side transaction registers 'beta' and advances alpha's
  // lifecycle budget, exactly as create-quiniela + a meta save would.
  await store.transaction("platform_index", async ({ current, write }) => {
    current.quinielas[0].lifecycleRoundsConsumed = 4;
    current.quinielas[0].lifecycleConsumedRoundIds = ["r1", "r2", "r3", "r4"];
    current.quinielas.push({ slug: "beta", name: "Beta", entitlement: { plan: "PLUS" }, lifecycleRoundsConsumed: 0, lifecycleConsumedRoundIds: [] });
    write(current); // server-side writers deliberately do NOT bump the version
  });

  // T2 — the admin renames alpha on the T0 snapshot and sends it back.
  // (MON-002B: `paid` is no longer an admin-writable field at all; `name` is
  // the remaining one, and the merge behaviour under test is the same.)
  adminSnapshot.quinielas[0].name = "Alpha renombrada";
  const res = await indexWrite(store, adminSnapshot);
  assert.equal(res.status, 200, "server activity must not 409 the admin");

  const final = store.raw("platform_index");
  const bySlug = Object.fromEntries(final.quinielas.map((q) => [q.slug, q]));

  assert.ok(bySlug.beta, "the quiniela registered at T1 must survive");
  assert.equal(bySlug.beta.entitlement.plan, "PLUS", "and keep its entitlement");
  assert.equal(bySlug.alpha.lifecycleRoundsConsumed, 4, "consumed lifecycle budget is never given back");
  assert.deepEqual(bySlug.alpha.lifecycleConsumedRoundIds, ["r1", "r2", "r3", "r4"]);
  assert.equal(bySlug.alpha.name, "Alpha renombrada", "and the admin's own change still applies");
});

test("PLATFORM_INDEX: every server-owned field survives a stale admin snapshot", async () => {
  const serverEntry = {
    slug: "alpha", name: "Alpha",
    entitlement: { plan: "PLUS" }, entitlementHistory: [{ action: "grant" }],
    lifecycleConsumedRoundIds: ["r1"], lifecycleRoundsConsumed: 1,
    participantCount: 9, roundCount: 4,
  };
  const store = createStore({ platform_index: { version: 1, quinielas: [serverEntry] } });

  // A snapshot where EVERY server-owned field is stale/wrong.
  const stale = { version: 1, quinielas: [{
    slug: "alpha", name: "Alpha renombrada",
    entitlement: { plan: "FREE" }, entitlementHistory: [],
    lifecycleConsumedRoundIds: [], lifecycleRoundsConsumed: 0,
    participantCount: 0, roundCount: 0,
  }] };

  assert.equal((await indexWrite(store, stale)).status, 200);
  const entry = store.raw("platform_index").quinielas[0];
  SERVER_OWNED_INDEX_FIELDS.forEach((field) => {
    assert.deepEqual(entry[field], serverEntry[field], `${field} must come from the locked row, never the client`);
  });
  assert.equal(entry.name, "Alpha renombrada", "the admin-editable field still applies");
});

test("MON-002B: paid and exempt can no longer be written from a browser at all", async () => {
  // They used to be admin-editable and to mean nothing: enforcement never
  // read either one, so "Exenta" looked like an unlock and was not one. They
  // are inert stored history now, and a crafted snapshot cannot revive them.
  const store = createStore({ platform_index: { version: 1, quinielas: [
    { slug: "alpha", name: "Alpha", paid: false, exempt: false, entitlement: { plan: "FREE" } },
  ] } });
  await indexWrite(store, { version: 1, quinielas: [{ slug: "alpha", name: "Alpha", paid: true, exempt: true, entitlement: { plan: "PLUS" } }] });
  const entry = store.raw("platform_index").quinielas[0];
  assert.equal(entry.paid, false, "paid is not admin-writable any more");
  assert.equal(entry.exempt, false, "exempt is not admin-writable any more");
  assert.equal(entry.entitlement.plan, "FREE", "and the plan is server-owned, as before");
});

test("PLATFORM_INDEX: an admin snapshot can neither delete nor invent registry entries", async () => {
  const store = createStore({ platform_index: { version: 1, quinielas: [
    { slug: "alpha", name: "Alpha" }, { slug: "beta", name: "Beta" },
  ] } });
  // Snapshot that dropped 'beta' and made up 'ghost'.
  await indexWrite(store, { version: 1, quinielas: [{ slug: "alpha", name: "A" }, { slug: "ghost", name: "G", entitlement: { plan: "PLUS" } }] });
  const slugs = store.raw("platform_index").quinielas.map((q) => q.slug).sort();
  assert.deepEqual(slugs, ["alpha", "beta"], "beta survives, ghost is never created");
});

test("PLATFORM_INDEX: two admins editing from the same version -> one wins, the other gets 409", async () => {
  const store = createStore({ platform_index: { version: 4, quinielas: [
    { slug: "alpha", name: "Alpha" }, { slug: "beta", name: "Beta" },
  ] } });
  const a = store.raw("platform_index");
  const b = store.raw("platform_index");
  a.quinielas[0].name = "Alpha de A";
  b.quinielas[1].name = "Beta de B";

  const resA = await indexWrite(store, a);
  const resB = await indexWrite(store, b);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 409, "the second admin must not silently win");
  assert.equal(resB.currentVersion, 5);

  const final = store.raw("platform_index");
  assert.equal(final.version, 5, "exactly one write landed");
  assert.equal(final.quinielas[0].name, "Alpha de A");
  assert.equal(final.quinielas[1].name, "Beta", "the rejected edit was NOT applied");

  // Recovery: reload and retry succeeds, on top of the write that won.
  const reloaded = store.raw("platform_index");
  reloaded.quinielas[1].name = "Beta de B";
  assert.equal((await indexWrite(store, reloaded)).status, 200);
  const after = store.raw("platform_index");
  assert.equal(after.version, 6);
  assert.equal(after.quinielas[0].name, "Alpha de A", "and both changes now coexist");
  assert.equal(after.quinielas[1].name, "Beta de B");
});

// ==== FIX 1 — commercial_config: real optimistic concurrency ==============

const config = (over = {}) => ({
  free: { participantLimit: 10, manualRoundLimit: 7 },
  plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: 199 },
  ...over,
});

test("COMMERCIAL_CONFIG: the audited two-writer race -> one 200, one 409, nothing lost", async () => {
  const store = createStore({ commercial_config: config({ version: 5 }) });
  const a = store.raw("commercial_config");
  const b = store.raw("commercial_config");
  a.plus.priceMXN = 250;          // client A changes the price
  b.free.manualRoundLimit = 8;    // client B changes the FREE limit

  const resA = await platformWrite(store, "commercial_config", a);
  const resB = await platformWrite(store, "commercial_config", b);

  assert.equal(resA.status, 200);
  assert.equal(resA.version, 6, "the winner advances to exactly N+1");
  assert.equal(resB.status, 409, "the loser is rejected, not silently applied");
  assert.equal(resB.currentVersion, 6);

  const final = store.raw("commercial_config");
  assert.equal(final.version, 6, "no second successful write claimed version 6");
  assert.equal(final.plus.priceMXN, 250, "the winner's change is intact");
  assert.equal(final.free.manualRoundLimit, 7, "the loser's change was never applied");
});

test("COMMERCIAL_CONFIG: after reloading, the rejected client retries successfully to version 7", async () => {
  const store = createStore({ commercial_config: config({ version: 5 }) });
  const a = store.raw("commercial_config");
  a.plus.priceMXN = 250;
  await platformWrite(store, "commercial_config", a);

  const reloaded = store.raw("commercial_config");
  assert.equal(reloaded.version, 6);
  reloaded.free.manualRoundLimit = 8;
  const retry = await platformWrite(store, "commercial_config", reloaded);
  assert.equal(retry.status, 200);
  assert.equal(retry.version, 7);
  const final = store.raw("commercial_config");
  assert.equal(final.plus.priceMXN, 250, "and neither change was lost");
  assert.equal(final.free.manualRoundLimit, 8);
});

test("COMMERCIAL_CONFIG: version handling — correct / stale / absent / malformed", async () => {
  // correct
  let store = createStore({ commercial_config: config({ version: 5 }) });
  assert.equal((await platformWrite(store, "commercial_config", config({ version: 5 }))).status, 200);

  // stale (below current)
  store = createStore({ commercial_config: config({ version: 5 }) });
  assert.equal((await platformWrite(store, "commercial_config", config({ version: 4 }))).status, 409);

  // a version from the FUTURE is just as invalid as a stale one
  assert.equal((await platformWrite(store, "commercial_config", config({ version: 99 }))).status, 409);

  // absent, on a row that already has a version -> refused (otherwise
  // omitting the field would opt out of the check)
  assert.equal((await platformWrite(store, "commercial_config", config())).status, 409);

  // absent, on a row that has never been written under this protocol -> allowed
  const fresh = createStore({});
  const first = await platformWrite(fresh, "commercial_config", config());
  assert.equal(first.status, 200);
  assert.equal(first.version, 1);

  // malformed -> 400, and never treated as "no expectation"
  for (const bad of ["5", 5.5, NaN, Infinity, -1, true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    const s = createStore({ commercial_config: config({ version: 5 }) });
    const r = await platformWrite(s, "commercial_config", config({ version: bad }));
    assert.equal(r.status, 400, `version ${JSON.stringify(bad)} must be rejected as malformed`);
    assert.equal(s.raw("commercial_config").version, 5, "a rejected write changes nothing");
  }
});

test("VERSION: the stored version is computed by the server, never taken from the client", async () => {
  const store = createStore({ platform_index: { version: 2, quinielas: [] } });
  // The client claims the correct expectation but also tries to dictate a
  // wildly different stored value in the same document. Only N+1 may land.
  const res = await indexWrite(store, { version: 2, quinielas: [], someOtherField: 1 });
  assert.equal(res.status, 200);
  assert.equal(store.raw("platform_index").version, 3);
});

test("VERSION: a 409 leaves the stored row byte-identical", async () => {
  const before = { version: 7, quinielas: [{ slug: "alpha", paid: false, entitlement: { plan: "PLUS" } }] };
  const store = createStore({ platform_index: before });
  const res = await indexWrite(store, { version: 3, quinielas: [{ slug: "alpha", paid: true }] });
  assert.equal(res.status, 409);
  assert.deepEqual(store.raw("platform_index"), before);
});

// ==== FIX 1 — platform_settings / platform_payment_log ====================

test("PLATFORM_SETTINGS: a concurrent password rotation cannot be reverted by a stale settings save", async () => {
  // mergeProtectedPlatformFields carries the password over when the incoming
  // payload has none; the fix is that it now reads it from the LOCKED row.
  const store = createStore({ platform_settings: { version: 1, jornadaLimit: 5, dashboardPassword: "hash-old" } });
  const staleTab = store.raw("platform_settings");

  await store.transaction("platform_settings", async ({ current, write }) => {
    current.dashboardPassword = "hash-new";
    current.version = 2;
    write(current);
  });

  staleTab.jornadaLimit = 9; // the other tab only meant to change the limit
  delete staleTab.dashboardPassword;
  const res = await platformWrite(store, "platform_settings", staleTab);
  assert.equal(res.status, 409, "the stale tab is rejected instead of reverting the rotation");
  assert.equal(store.raw("platform_settings").dashboardPassword, "hash-new");
});

test("PLATFORM_PAYMENT_LOG: two concurrent appends from the same version cannot drop a payment", async () => {
  const store = createStore({ platform_payment_log: { version: 3, payments: [{ slug: "alpha", amount: 10 }] } });
  const a = store.raw("platform_payment_log");
  const b = store.raw("platform_payment_log");
  a.payments.push({ slug: "beta", amount: 20 });
  b.payments.push({ slug: "gamma", amount: 30 });

  assert.equal((await platformWrite(store, "platform_payment_log", a)).status, 200);
  assert.equal((await platformWrite(store, "platform_payment_log", b)).status, 409,
    "the second append is refused rather than silently discarding the first");
  const payments = store.raw("platform_payment_log").payments.map((p) => p.slug);
  assert.deepEqual(payments, ["alpha", "beta"], "no payment record was lost");

  // Recovery: reload, re-append, both survive.
  const reloaded = store.raw("platform_payment_log");
  reloaded.payments.push({ slug: "gamma", amount: 30 });
  assert.equal((await platformWrite(store, "platform_payment_log", reloaded)).status, 200);
  assert.deepEqual(store.raw("platform_payment_log").payments.map((p) => p.slug), ["alpha", "beta", "gamma"]);
});

// ==== consecutive edits from one open panel ===============================
// Found by adversarial QA on this fix, not by the original audit: the panel
// keeps ONE index object in memory and re-sends it on every toggle. If the
// client doesn't carry the server-assigned version forward, the second toggle
// looks stale and 409s even though nothing else touched the row.

test("SEQUENTIAL EDITS: a panel that carries the returned version forward can keep editing without a spurious 409", async () => {
  const store = createStore({ platform_index: { version: 1, quinielas: [
    { slug: "alpha", name: "Alpha" }, { slug: "beta", name: "Beta" },
  ] } });
  const panelIdx = store.raw("platform_index"); // loaded once, like the dashboard does

  panelIdx.quinielas[0].name = "Alpha 2";
  const first = await indexWrite(store, panelIdx);
  assert.equal(first.status, 200);
  panelIdx.version = first.version; // what savePlatformRow now does

  panelIdx.quinielas[1].name = "Beta 2";
  const second = await indexWrite(store, panelIdx);
  assert.equal(second.status, 200, "a second edit from the same open panel must not be treated as stale");

  const final = store.raw("platform_index");
  assert.equal(final.quinielas[0].name, "Alpha 2", "both edits survive");
  assert.equal(final.quinielas[1].name, "Beta 2");
  assert.equal(final.version, 3);
});

test("SEQUENTIAL EDITS: a panel that does NOT refresh its version is correctly refused on the second edit", async () => {
  const store = createStore({ platform_index: { version: 1, quinielas: [{ slug: "alpha", name: "Alpha" }] } });
  const stalePanel = store.raw("platform_index");
  stalePanel.quinielas[0].name = "Alpha 2";
  assert.equal((await indexWrite(store, stalePanel)).status, 200);
  stalePanel.quinielas[0].name = "Alpha 3"; // version still 1 -> genuinely stale now
  assert.equal((await indexWrite(store, stalePanel)).status, 409);
});

test("FRONTEND: savePlatformRow carries the server-assigned version back into the in-memory snapshot", () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const i = indexHtml.indexOf("async function savePlatformRow(");
  assert.ok(i !== -1, "savePlatformRow debe existir");
  const body = indexHtml.slice(i, i + 1200);
  assert.ok(body.includes("kvSetWithError"), "must use the error-aware helper, not the boolean one");
  assert.ok(/Number\.isSafeInteger\(r\.version\)/.test(body), "must only accept a safe-integer version from the server");
  assert.ok(body.includes("value.version = r.version"), "must refresh the snapshot's version after a successful write");
  assert.ok(body.includes('r.error === "stale_version"'), "must detect the 409");
  assert.ok(body.includes("renderPlatformDashboard()"), "must reload state instead of retrying the stale snapshot");
  assert.ok(!/retry|reintent/i.test(body), "must never auto-retry the same stale snapshot");
});

test("FRONTEND: the 409 copy is user-facing and recoverable", () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(indexHtml.includes("stale_version: \"La información cambió mientras estabas editando."),
    "el admin debe ver una explicación clara, no un código técnico");
});

// ==== MON-001F.2 — product-flow: marking a quiniela as paid ===============
//
// The earlier suite proved the PRIMITIVE was safe and then recovered by hand.
// The real dashboard never did that recovery: it wrote the index, then wrote
// the payment log as a separate whole-document write, and ignored the result.
// These drive the shipped applyEntitlementGrant/applyQuinielaSettings logic
// through the same transactional store, as one atomic operation per admin
// action.
//
// MON-002B replaced the PAID FLOW that used to live here. Marking a quiniela
// "Pagado" recorded money and granted nothing -- no enforcement path read
// that field -- so the operation being tested now is the one that actually
// changes what a quiniela is entitled to, with the payment recorded as part
// of the same transaction.

// Mirrors the endpoint exactly, including the rule that a PLUS grant takes
// its numbers and its price from commercial_config and NOTHING from the
// caller.
function buildGrantEntitlement(plan, body, cfg, now) {
  if (plan === "PLUS") {
    return buildPlusEntitlement(cfg, now, { source: "platform_grant", grantedBy: "platform", reason: body.reason || null });
  }
  if (plan === "MANUAL_GRANT") {
    if (!isValidManualGrantLimits(body.participantLimit, body.manualRoundLimit)) return null;
    if (!body.reason) return null;
    return buildManualGrantEntitlement(now, {
      grantedBy: "platform", reason: body.reason,
      participantLimit: body.participantLimit, manualRoundLimit: body.manualRoundLimit,
    });
  }
  if (plan === "FREE") {
    const ent = buildFreeEntitlement(cfg, now);
    ent.source = "platform_revoke";
    ent.grantedBy = "platform";
    ent.reason = body.reason || null;
    return ent;
  }
  return null;
}

async function grant(store, slug, body, { cfg = DEFAULT_COMMERCIAL_CONFIG, now = "2026-09-03T00:00:00.000Z" } = {}) {
  const plan = body.plan;
  const grantId = body.grantId;
  // Mirrors isUsableGrantId() exactly, including the typeof check: a number
  // that merely stringifies into the right shape is not a usable id.
  if (!(typeof grantId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(grantId))) {
    return { status: 400, error: "invalid_grant_id" };
  }
  if (plan !== "PLUS" && plan !== "MANUAL_GRANT" && plan !== "FREE") return { status: 400, error: "invalid_plan" };
  const entitlement = buildGrantEntitlement(plan, body, cfg, now);
  if (!entitlement) return { status: 400, error: plan === "MANUAL_GRANT" && !body.reason ? "reason_required" : "invalid_limits" };

  // Lock order: platform_index, then platform_payment_log — and the log is
  // only touched when there is money to record.
  return store.transaction("platform_index", async ({ current: index, write: writeIndex }) =>
    store.transaction("platform_payment_log", async ({ current: paymentLog, write: writeLog }) => {
      const r = applyEntitlementGrant({
        index, paymentLog: plan === "PLUS" ? paymentLog : null,
        entitlement, slug, grantId, grantedBy: "platform", reason: body.reason || null, now,
      });
      if (!r.ok) return { status: r.error === "not_found" ? 404 : 400, error: r.error };
      if (r.paymentLog) writeLog(r.paymentLog);
      if (r.index) writeIndex(r.index);
      return {
        status: 200, applied: r.applied, recorded: r.recorded, reason: r.reason || null,
        indexVersion: r.index ? r.index.version : readStoredVersion(index),
      };
    }));
}

const grantStore = () => createStore({
  platform_index: { version: 1, quinielas: [
    { slug: "alpha", name: "Alpha", participantCount: 4, entitlement: buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG), entitlementHistory: [] },
    { slug: "beta", name: "Beta", participantCount: 7, entitlement: buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG), entitlementHistory: [] },
  ] },
  platform_payment_log: { version: 1, payments: [] },
  "quiniela:alpha:meta": { groupName: "Alpha", settings: { ownerPassword: "hash-old" }, rounds: [] },
});
const entryOf = (store, slug) => store.raw("platform_index").quinielas.find((q) => q.slug === slug);
const paymentsOf = (store) => store.raw("platform_payment_log").payments;

test("GRANT: FREE -> PLUS grants the plan AND records the payment, in one operation", async () => {
  const store = grantStore();
  const r = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-alpha-0001" });
  assert.equal(r.status, 200);
  assert.equal(r.applied, true);
  assert.equal(r.recorded, true);

  const entry = entryOf(store, "alpha");
  assert.equal(entry.entitlement.plan, "PLUS");
  assert.equal(entry.entitlement.participantLimit, DEFAULT_COMMERCIAL_CONFIG.plus.participantLimit);
  assert.equal(entry.entitlement.manualRoundLimit, DEFAULT_COMMERCIAL_CONFIG.plus.manualRoundLimit);
  assert.equal(entry.entitlement.pricePaidMXN, DEFAULT_COMMERCIAL_CONFIG.plus.priceMXN);

  const payments = paymentsOf(store);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].amount, DEFAULT_COMMERCIAL_CONFIG.plus.priceMXN,
    "the amount is the snapshot price, never price x participants");
  assert.equal(payments[0].slug, "alpha");
  assert.equal(payments[0].id, "grant-alpha-0001");
});

test("GRANT: a retry with the SAME id grants once and charges once", async () => {
  const store = grantStore();
  const a = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-retry-0001" });
  const b = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-retry-0001" });
  assert.equal(a.applied, true);
  assert.equal(b.status, 200);
  assert.equal(b.applied, false, "the replay applies nothing");
  assert.equal(paymentsOf(store).length, 1);
  assert.equal(entryOf(store, "alpha").entitlementHistory.length, 1);
});

test("GRANT: a replayed id writes NOTHING -- not even a version bump", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-noop-0001" });
  const afterFirst = JSON.stringify(store.raw("platform_index"));
  const logAfterFirst = JSON.stringify(store.raw("platform_payment_log"));
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-noop-0001" });
  assert.equal(JSON.stringify(store.raw("platform_index")), afterFirst, "index untouched");
  assert.equal(JSON.stringify(store.raw("platform_payment_log")), logAfterFirst, "log untouched");
});

test("GRANT: two tabs with DIFFERENT ids on the same quiniela produce exactly ONE purchase", async () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong. The first
  // version of this ticket keyed idempotency on the grant id alone and
  // justified two grants as "a renewal" -- but renewal is MON-002C's to
  // define, and Plus is one payment per quiniela per tournament. An id is a
  // token the browser makes up and each tab makes up its own, so two
  // operators (or one with two tabs) clicking "Activar Plus" on the same FREE
  // quiniela were charging it twice. The transition, read from the locked
  // row, is what decides.
  const store = grantStore();
  const [a, b] = await Promise.all([
    grant(store, "alpha", { plan: "PLUS", grantId: "grant-tab-a-0001" }),
    grant(store, "alpha", { plan: "PLUS", grantId: "grant-tab-b-0001" }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal([a, b].filter((r) => r.applied).length, 1, "exactly one of the two tabs applies");
  assert.equal([a, b].filter((r) => r.recorded).length, 1, "and exactly one payment is recorded");
  assert.equal(paymentsOf(store).length, 1);
  assert.equal(entryOf(store, "alpha").entitlementHistory.length, 1, "one purchase event, not two");
  assert.equal(entryOf(store, "alpha").entitlement.plan, "PLUS");
});

test("GRANT: PLUS -> PLUS in the same scope is a no-op that writes NOTHING", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-first-00001" });
  const indexAfter = JSON.stringify(store.raw("platform_index"));
  const logAfter = JSON.stringify(store.raw("platform_payment_log"));

  const again = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-second-0001" });
  assert.equal(again.status, 200);
  assert.equal(again.applied, false);
  assert.equal(again.recorded, false);
  assert.equal(JSON.stringify(store.raw("platform_index")), indexAfter, "not even a version bump");
  assert.equal(JSON.stringify(store.raw("platform_payment_log")), logAfter);
});

test("GRANT: a price change after the purchase never re-snapshots and never charges again", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-price-00001" });
  const bought = JSON.parse(JSON.stringify(entryOf(store, "alpha").entitlement));
  assert.equal(bought.pricePaidMXN, 199);

  // The operator raises the price, then a second "Activar Plus" intent
  // arrives for the same quiniela.
  const dearer = { ...DEFAULT_COMMERCIAL_CONFIG, version: 2, plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: 299 } };
  const after = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-price-00002" }, { cfg: dearer });
  assert.equal(after.applied, false, "no second purchase");
  assert.deepEqual(entryOf(store, "alpha").entitlement, bought, "and the snapshot is untouched -- still 199");
  assert.equal(paymentsOf(store).filter((p) => p.slug === "alpha").length, 1);
});

test("GRANT: FREE -> FREE is a no-op too", async () => {
  const store = grantStore();
  const before = JSON.stringify(store.raw("platform_index"));
  const r = await grant(store, "alpha", { plan: "FREE", grantId: "grant-freefree-01", reason: "nada" });
  assert.equal(r.applied, false);
  assert.equal(JSON.stringify(store.raw("platform_index")), before);
});

test("PURCHASE HISTORY 2: revoking to FREE and granting PLUS again does NOT charge a second time", async () => {
  // THIS TEST ALSO USED TO ASSERT THE OPPOSITE. The previous version read
  // only the CURRENT entitlement, so PLUS -> FREE -> PLUS looked like a fresh
  // FREE -> PLUS and charged again; the comment called it "a deliberate
  // re-sale". An administrative revoke does not un-buy a tournament, and
  // refunds and renewal do not exist yet to justify a second charge. The
  // purchase history takes part in the decision now.
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-cycle-00001" });
  await grant(store, "alpha", { plan: "FREE", grantId: "grant-cycle-00002", reason: "revoke por error" });
  assert.equal(entryOf(store, "alpha").entitlement.plan, "FREE", "the revoke does change the current plan");

  const back = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-cycle-00003" });
  assert.equal(back.status, 200);
  assert.equal(back.applied, true, "the coverage comes back");
  assert.equal(back.recorded, false, "but nothing is charged");
  assert.equal(back.reason, "reactivated_existing_purchase");
  assert.equal(paymentsOf(store).length, 1, "still exactly one payment for this tournament");
  assert.equal(entryOf(store, "alpha").entitlement.plan, "PLUS");
});

test("PURCHASE HISTORY 3: a price change between the revoke and the reactivation cannot fabricate a second purchase", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-repr-000001" });
  const sold = JSON.parse(JSON.stringify(entryOf(store, "alpha").entitlement));
  await grant(store, "alpha", { plan: "FREE", grantId: "grant-repr-000002", reason: "revoke" });

  // Price up AND limits down, then reactivate.
  const changed = { ...DEFAULT_COMMERCIAL_CONFIG, version: 5, plus: { participantLimit: 20, manualRoundLimit: 9, priceMXN: 299 } };
  const back = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-repr-000003" }, { cfg: changed });
  assert.equal(back.recorded, false);
  const now = entryOf(store, "alpha").entitlement;
  assert.equal(now.participantLimit, sold.participantLimit, "the restored coverage is the one that was sold");
  assert.equal(now.manualRoundLimit, sold.manualRoundLimit);
  assert.equal(now.pricePaidMXN, 199, "not re-snapshotted at the new price");
  assert.equal(paymentsOf(store).length, 1);
});

test("PURCHASE HISTORY 4: revoke and reactivation are both auditable, and the purchase is marked as such", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-audit-00001", reason: "pago recibido" });
  await grant(store, "alpha", { plan: "FREE", grantId: "grant-audit-00002", reason: "revoke por error" });
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-audit-00003", reason: "restaurar" });

  const h = entryOf(store, "alpha").entitlementHistory;
  assert.deepEqual(h.map((x) => x.action), ["grant", "revoke", "reactivate"], "the sequence reads on its own");
  assert.equal(h[0].purchase, true, "only the first one is a purchase");
  assert.equal(h[1].purchase, false);
  assert.equal(h[2].purchase, undefined, "a reactivation records no money and claims no purchase");
  h.forEach((x) => {
    assert.ok(x.at, "every entry is timestamped");
    assert.ok(x.grantId, "and carries the id that caused it");
    assert.equal(x.grantedBy, "platform");
  });
  assert.equal(h[1].reason, "revoke por error");
});

test("PURCHASE HISTORY 9: a MANUAL_GRANT in between does not make the purchase disappear", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-mid-0000001" });
  await grant(store, "alpha", { plan: "MANUAL_GRANT", grantId: "grant-mid-0000002", participantLimit: 30, manualRoundLimit: 15, reason: "soporte" });
  assert.equal(entryOf(store, "alpha").entitlement.plan, "MANUAL_GRANT");

  const back = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-mid-0000003" });
  assert.equal(back.recorded, false, "the tournament was already bought, whatever happened in between");
  assert.equal(back.reason, "reactivated_existing_purchase");
  assert.equal(paymentsOf(store).length, 1);
  assert.equal(entryOf(store, "alpha").entitlement.pricePaidMXN, 199);
});

test("PURCHASE HISTORY: a purchase in a DIFFERENT tournament cycle does not cover this one", async () => {
  // MON-002C replaced the scope key: it was "leagueId:season", which could
  // not tell Liga MX Apertura from Clausura (both are "4350:2026-2027"), and
  // is now the internal cycle id. This drives the two cycles directly.
  const e1 = "ts:1:football:thesportsdb:4350:e1";
  const e2 = "ts:1:football:thesportsdb:4350:e2";
  const store = grantStore();
  await store.transaction("platform_index", async ({ current, write }) => {
    current.quinielas[0].tournamentScope = { id: e1, editionSeq: 1, lifecycle: "ACTIVE", providerRefs: { provider: "thesportsdb", competitionId: "4350" } };
    write(current);
  });
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-scope-000001" });
  assert.equal(paymentsOf(store).length, 1);
  assert.equal(paymentsOf(store)[0].competitionIdentity, null, "el log guarda la competencia si la hay");

  const history = entryOf(store, "alpha").entitlementHistory;
  assert.ok(findPurchaseForScope(history, e1), "cubierto para el torneo que pagó");
  assert.equal(findPurchaseForScope(history, e2), null, "y NO para la siguiente edición");
});

test("PURCHASE HISTORY: the same league and season in two cycles are two different purchases", async () => {
  // The exact collision MON-002C exists for: Apertura 2026 and Clausura 2027
  // are one string to the provider, and two tournaments to a customer.
  const e1 = "ts:1:football:thesportsdb:4350:e1";
  const e2 = "ts:1:football:thesportsdb:4350:e2";
  const store = grantStore();
  const setScope = (id, seq) => store.transaction("platform_index", async ({ current, write }) => {
    current.quinielas[0].tournamentScope = { id, editionSeq: seq, lifecycle: "ACTIVE", providerRefs: { provider: "thesportsdb", competitionId: "4350" } };
    write(current);
  });

  await setScope(e1, 1);
  const apertura = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-apertura-001" });
  assert.equal(apertura.recorded, true);

  // The Admin starts the next tournament: new cycle, plan back to FREE.
  await setScope(e2, 2);
  await store.transaction("platform_index", async ({ current, write }) => {
    current.quinielas[0].entitlement = { ...buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG), scopeId: e2 };
    write(current);
  });

  const clausura = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-clausura-001" });
  assert.equal(clausura.applied, true);
  assert.equal(clausura.recorded, true, "la segunda edición es una COMPRA, no una reactivación");
  assert.equal(clausura.reason, null);
  assert.equal(paymentsOf(store).length, 2, "un pago por torneo");
  assert.ok(findPurchaseForScope(entryOf(store, "alpha").entitlementHistory, e1), "y la primera compra sigue reconocida");
});

test("PURCHASE HISTORY: a legacy row without the `purchase` marker still counts as bought", async () => {
  // Rows written before the marker existed carry the price on the
  // entitlement, which means the same thing. Missing it must not let a
  // quiniela be charged a second time.
  const store = createStore({
    platform_index: { version: 1, quinielas: [{
      slug: "old", name: "Old",
      entitlement: buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG),
      entitlementHistory: [{ action: "grant", at: "2026-01-01T00:00:00.000Z", grantId: "viejo-000001", entitlement: buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG, "2026-01-01T00:00:00.000Z") }],
    }] },
    platform_payment_log: { version: 1, payments: [] },
    "quiniela:old:meta": { groupName: "Old", settings: {}, rounds: [] },
  });
  const r = await grant(store, "old", { plan: "PLUS", grantId: "grant-legacy-00001" });
  assert.equal(r.applied, true);
  assert.equal(r.recorded, false, "already bought, even without the marker");
  assert.equal(paymentsOf(store).length, 0);
});

test("PURCHASE HISTORY 10: entitlement and payment log never disagree, through any sequence", async () => {
  const store = grantStore();
  const sequence = [
    { plan: "PLUS", grantId: "grant-seq-00000001" },
    { plan: "PLUS", grantId: "grant-seq-00000002" },
    { plan: "FREE", grantId: "grant-seq-00000003", reason: "r" },
    { plan: "MANUAL_GRANT", grantId: "grant-seq-00000004", participantLimit: 30, manualRoundLimit: 9, reason: "s" },
    { plan: "PLUS", grantId: "grant-seq-00000005" },
    { plan: "FREE", grantId: "grant-seq-00000006", reason: "r2" },
    { plan: "PLUS", grantId: "grant-seq-00000007" },
    { plan: "PLUS", grantId: "grant-seq-00000007" },
  ];
  for (const step of sequence) await grant(store, "alpha", step);

  const payments = paymentsOf(store).filter((p) => p.slug === "alpha");
  assert.equal(payments.length, 1, "one tournament, one payment, whatever the operator did");
  const history = entryOf(store, "alpha").entitlementHistory;
  assert.equal(history.filter((h) => h.purchase === true).length, 1, "and exactly one purchase event");
  assert.equal(entryOf(store, "alpha").entitlement.plan, "PLUS");
  // The coverage in force is the one that was paid for.
  assert.equal(entryOf(store, "alpha").entitlement.pricePaidMXN, payments[0].amount);
});

test("GRANT: a MANUAL_GRANT may be re-issued to adjust its numbers, and still records no money", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "MANUAL_GRANT", grantId: "grant-adj-0000001", participantLimit: 25, manualRoundLimit: 12, reason: "soporte" });
  const adjusted = await grant(store, "alpha", { plan: "MANUAL_GRANT", grantId: "grant-adj-0000002", participantLimit: 40, manualRoundLimit: 20, reason: "ampliación" });
  assert.equal(adjusted.applied, true, "a manual override is the one plan that may be re-issued");
  assert.equal(entryOf(store, "alpha").entitlement.participantLimit, 40);
  assert.equal(paymentsOf(store).length, 0, "and it still cannot introduce a charge");
});

test("GRANT: an upgrade from MANUAL_GRANT or GRANDFATHERED to PLUS is a real purchase", async () => {
  for (const start of ["MANUAL_GRANT", "GRANDFATHERED"]) {
    const store = grantStore();
    if (start === "MANUAL_GRANT") {
      await grant(store, "alpha", { plan: "MANUAL_GRANT", grantId: "grant-start-000001", participantLimit: 15, manualRoundLimit: 8, reason: "prueba" });
    } else {
      await store.transaction("platform_index", async ({ current, write }) => {
        current.quinielas[0].entitlement = buildGrandfatheredEntitlement("2026-01-01T00:00:00.000Z");
        write(current);
      });
    }
    const r = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-upto-0000001" });
    assert.equal(r.applied, true, `${start} -> PLUS must apply`);
    assert.equal(r.recorded, true, `${start} -> PLUS is a purchase`);
    assert.equal(paymentsOf(store).length, 1);
  }
});

test("GRANT: five simultaneous retries of the SAME grant produce exactly one grant and one payment", async () => {
  const store = grantStore();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => grant(store, "alpha", { plan: "PLUS", grantId: "grant-storm-0001" }))
  );
  assert.equal(results.filter((r) => r.applied).length, 1, "exactly one applied");
  assert.equal(paymentsOf(store).length, 1);
  assert.equal(entryOf(store, "alpha").entitlementHistory.length, 1);
});

test("GRANT: two different quinielas granted concurrently -> one grant and one payment each", async () => {
  const store = grantStore();
  await Promise.all([
    grant(store, "alpha", { plan: "PLUS", grantId: "grant-alpha-0002" }),
    grant(store, "beta", { plan: "PLUS", grantId: "grant-beta-0002" }),
  ]);
  assert.equal(entryOf(store, "alpha").entitlement.plan, "PLUS");
  assert.equal(entryOf(store, "beta").entitlement.plan, "PLUS");
  const payments = paymentsOf(store);
  assert.equal(payments.length, 2);
  assert.deepEqual(payments.map((p) => p.slug).sort(), ["alpha", "beta"]);
});

test("GRANT: the browser cannot forge the numbers or the price of a PLUS grant", async () => {
  const store = grantStore();
  await grant(store, "alpha", {
    plan: "PLUS", grantId: "grant-forged-0001",
    // A crafted request trying to mint a 500-person plan for nothing.
    participantLimit: 500, manualRoundLimit: 500, priceMXN: 0, pricePaidMXN: 0,
  });
  const ent = entryOf(store, "alpha").entitlement;
  assert.equal(ent.participantLimit, DEFAULT_COMMERCIAL_CONFIG.plus.participantLimit);
  assert.equal(ent.manualRoundLimit, DEFAULT_COMMERCIAL_CONFIG.plus.manualRoundLimit);
  assert.equal(ent.pricePaidMXN, DEFAULT_COMMERCIAL_CONFIG.plus.priceMXN);
  assert.equal(paymentsOf(store)[0].amount, DEFAULT_COMMERCIAL_CONFIG.plus.priceMXN);
});

test("GRANT: a PLUS grant snapshots the config LIVE at grant time and never tracks it afterwards", async () => {
  const store = grantStore();
  const cheap = { ...DEFAULT_COMMERCIAL_CONFIG, version: 2, plus: { participantLimit: 50, manualRoundLimit: 18, priceMXN: 199 } };
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-snap-0001" }, { cfg: cheap });
  const before = JSON.parse(JSON.stringify(entryOf(store, "alpha").entitlement));
  // The operator raises the price and lowers the limits afterwards.
  const dearer = { ...DEFAULT_COMMERCIAL_CONFIG, version: 3, plus: { participantLimit: 20, manualRoundLimit: 9, priceMXN: 299 } };
  await grant(store, "beta", { plan: "PLUS", grantId: "grant-snap-0002" }, { cfg: dearer });
  assert.deepEqual(entryOf(store, "alpha").entitlement, before, "alpha's purchase is frozen");
  assert.equal(entryOf(store, "beta").entitlement.participantLimit, 20, "beta bought the new terms");
  assert.equal(entryOf(store, "beta").entitlement.pricePaidMXN, 299);
});

test("GRANT: a MANUAL_GRANT may name its own numbers, and they are validated", async () => {
  const store = grantStore();
  const ok = await grant(store, "alpha", { plan: "MANUAL_GRANT", grantId: "grant-manual-0001", participantLimit: 25, manualRoundLimit: 12, reason: "soporte" });
  assert.equal(ok.status, 200);
  const ent = entryOf(store, "alpha").entitlement;
  assert.equal(ent.plan, "MANUAL_GRANT");
  assert.equal(ent.participantLimit, 25);
  assert.equal(ent.manualRoundLimit, 12);
  assert.equal(ent.reason, "soporte");
  assert.equal(paymentsOf(store).length, 0, "a manual grant is not a sale and records no money");
});

test("GRANT: malformed manual limits are refused and write nothing", async () => {
  for (const bad of [
    { participantLimit: 0, manualRoundLimit: 5 },
    { participantLimit: -1, manualRoundLimit: 5 },
    { participantLimit: 1.5, manualRoundLimit: 5 },
    { participantLimit: "10", manualRoundLimit: 5 },
    { participantLimit: NaN, manualRoundLimit: 5 },
    { participantLimit: 10, manualRoundLimit: 0 },
    { participantLimit: 10, manualRoundLimit: null },
    { participantLimit: 1e9, manualRoundLimit: 5 },
    { participantLimit: 10, manualRoundLimit: 1e9 },
    { participantLimit: undefined, manualRoundLimit: undefined },
  ]) {
    const store = grantStore();
    const r = await grant(store, "alpha", { plan: "MANUAL_GRANT", grantId: "grant-bad-000001", reason: "x", ...bad });
    assert.equal(r.status, 400, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(entryOf(store, "alpha").entitlement.plan, "FREE", "nothing was written");
    assert.equal(paymentsOf(store).length, 0);
  }
});

test("GRANT: a manual grant without a stated reason is refused -- the history must say WHY", async () => {
  const store = grantStore();
  const r = await grant(store, "alpha", { plan: "MANUAL_GRANT", grantId: "grant-noreason-01", participantLimit: 25, manualRoundLimit: 12 });
  assert.equal(r.status, 400);
  assert.equal(entryOf(store, "alpha").entitlement.plan, "FREE");
});

test("GRANT: an unusable or missing grant id is refused before anything is written", async () => {
  for (const id of [undefined, null, "", "short", "x".repeat(65), "has spaces!", 12345678, {}]) {
    const store = grantStore();
    const r = await grant(store, "alpha", { plan: "PLUS", grantId: id });
    assert.equal(r.status, 400, `must refuse id ${JSON.stringify(id)}`);
    assert.equal(entryOf(store, "alpha").entitlement.plan, "FREE");
    assert.equal(paymentsOf(store).length, 0);
  }
});

test("GRANT: an unknown plan is refused and writes nothing", async () => {
  const store = grantStore();
  for (const plan of ["UNLIMITED", "free", "plus", "", null, 1, {}]) {
    const r = await grant(store, "alpha", { plan, grantId: "grant-badplan-01" });
    assert.equal(r.status, 400);
  }
  assert.equal(entryOf(store, "alpha").entitlement.plan, "FREE");
});

test("GRANT: granting an unknown quiniela is refused and writes nothing", async () => {
  const store = grantStore();
  const before = JSON.stringify(store.raw("platform_index"));
  const r = await grant(store, "ghost", { plan: "PLUS", grantId: "grant-ghost-0001" });
  assert.equal(r.status, 404);
  assert.equal(JSON.stringify(store.raw("platform_index")), before);
  assert.equal(paymentsOf(store).length, 0);
});

test("GRANT: the tournament binding is CARRIED OVER, never reset -- a grant is not a way to start a second tournament", async () => {
  const store = grantStore();
  await store.transaction("platform_index", async ({ current, write }) => {
    current.quinielas[0].entitlement.competitionIdentity = "4350:2026-2027";
    write(current);
  });
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-bound-0001" });
  assert.equal(entryOf(store, "alpha").entitlement.competitionIdentity, "4350:2026-2027");
  // ...and the same on the way back down to FREE
  await grant(store, "alpha", { plan: "FREE", grantId: "grant-unbound-001", reason: "prueba" });
  assert.equal(entryOf(store, "alpha").entitlement.competitionIdentity, "4350:2026-2027");
});

test("GRANT: going back to FREE restores the dynamic plan and keeps the whole history", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-updown-001" });
  await grant(store, "alpha", { plan: "FREE", grantId: "grant-updown-002", reason: "reembolso" });
  const entry = entryOf(store, "alpha");
  assert.equal(entry.entitlement.plan, "FREE");
  assert.equal(entry.entitlement.participantLimit, undefined, "FREE never snapshots numbers");
  assert.equal(entry.entitlementHistory.length, 2, "both decisions stay auditable");
  assert.equal(entry.entitlementHistory[0].entitlement.plan, "PLUS");
  assert.equal(entry.entitlementHistory[1].entitlement.plan, "FREE");
  assert.equal(paymentsOf(store).length, 1, "the earlier payment is history, not undone");
});

test("GRANT: every history entry records who, why, when and under which id", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-audit-0001", reason: "pago recibido" });
  const h = entryOf(store, "alpha").entitlementHistory[0];
  assert.equal(h.action, "grant");
  assert.equal(h.grantId, "grant-audit-0001");
  assert.equal(h.grantedBy, "platform");
  assert.equal(h.reason, "pago recibido");
  assert.ok(h.at, "and when");
  assert.equal(h.entitlement.plan, "PLUS");
});

test("GRANT: an existing GRANDFATHERED entitlement is replaced deliberately, never silently reinterpreted", async () => {
  const store = createStore({
    platform_index: { version: 1, quinielas: [
      { slug: "old", name: "Old", entitlement: buildGrandfatheredEntitlement("2026-01-01T00:00:00.000Z"), entitlementHistory: [] },
    ] },
    platform_payment_log: { version: 1, payments: [] },
  });
  assert.equal(entryOf(store, "old").entitlement.plan, "GRANDFATHERED");
  const r = await grant(store, "old", { plan: "PLUS", grantId: "grant-oldone-0001" });
  assert.equal(r.status, 200);
  assert.equal(entryOf(store, "old").entitlement.plan, "PLUS");
  assert.equal(entryOf(store, "old").entitlementHistory[0].entitlement.plan, "PLUS");
});

test("GRANT: a grant bumps the index version, so a stale generic write cannot revert it", async () => {
  const store = grantStore();
  const staleSnapshot = store.raw("platform_index");
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-version-001" });
  staleSnapshot.quinielas[0].name = "Alpha vieja";
  const res = await indexWrite(store, staleSnapshot);
  assert.equal(res.status, 409, "the stale panel must be refused");
  assert.equal(entryOf(store, "alpha").entitlement.plan, "PLUS", "the grant survives");
});

test("GRANT: granting concurrently with a settings edit keeps BOTH changes", async () => {
  const store = grantStore();
  await Promise.all([
    grant(store, "alpha", { plan: "PLUS", grantId: "grant-both-00001" }),
    saveSettings(store, "alpha", { name: "Alpha Nueva", hashedOwnerPassword: null }),
  ]);
  const entry = entryOf(store, "alpha");
  assert.equal(entry.entitlement.plan, "PLUS", "the grant survived");
  assert.equal(entry.name, "Alpha Nueva", "and so did the rename");
});

test("GRANT: a malformed / legacy payment log never blocks a new record", async () => {
  for (const log of [null, {}, { payments: null }, { payments: "nope" }, { payments: [null, 7, "x"] }]) {
    const store = grantStore();
    store.seed("platform_payment_log", log);
    const r = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-legacy-0001" });
    assert.equal(r.status, 200, `must record against ${JSON.stringify(log)}`);
    assert.equal(r.recorded, true);
    assert.ok(paymentsOf(store).some((p) => p && p.id === "grant-legacy-0001"));
  }
});

test("GRANT: plan and its payment record are always coherent -- never one without the other", async () => {
  const store = grantStore();
  const ids = ["grant-coh-0000001", "grant-coh-0000002", "grant-coh-0000001", "grant-coh-0000003"];
  for (const id of ids) await grant(store, "alpha", { plan: "PLUS", grantId: id });
  const history = entryOf(store, "alpha").entitlementHistory;
  const plusPayments = paymentsOf(store).filter((p) => p.slug === "alpha");
  assert.equal(history.length, plusPayments.length,
    "exactly one payment per applied PLUS grant, no more and no fewer");
  assert.deepEqual(history.map((h) => h.grantId).sort(), plusPayments.map((p) => p.id).sort());
});

async function saveSettings(store, slug, changes) {
  // Mirrors the endpoint's lock order: platform_index, then the meta row.
  const metaKey = `quiniela:${slug}:meta`;
  return store.transaction("platform_index", async ({ current: index, write: writeIndex }) =>
    store.transaction(metaKey, async ({ current: meta, write: writeMeta }) => {
      const r = applyQuinielaSettings({ index, meta, slug, ...changes });
      if (!r.ok) return { status: 404, error: r.error };
      writeMeta(r.meta);
      writeIndex(r.index);
      return { status: 200, indexVersion: r.index.version };
    }));
}

const editStore = () => createStore({
  platform_index: { version: 1, quinielas: [{ slug: "alpha", name: "Alpha" }] },
  "quiniela:alpha:meta": { groupName: "Alpha", settings: { ownerPassword: "hash-old" }, rounds: [] },
});

test("EDIT FLOW: the audited T0/T1/T2 -> all three changes land coherently", async () => {
  const store = editStore();
  // T1 — another valid operation advances platform_index while the edit form
  // is open (a new quiniela is registered).
  await store.transaction("platform_index", async ({ current, write }) => {
    current.quinielas.push({ slug: "beta", name: "Beta" });
    write(current);
  });

  // T2 — the admin saves name + password.
  const r = await saveSettings(store, "alpha", { name: "Alpha Renombrada", hashedOwnerPassword: "hash-new" });
  assert.equal(r.status, 200);

  const idx = store.raw("platform_index");
  const meta = store.raw("quiniela:alpha:meta");
  const entry = idx.quinielas.find((q) => q.slug === "alpha");
  assert.equal(entry.name, "Alpha Renombrada");
  assert.equal(meta.groupName, "Alpha Renombrada", "el nombre no puede divergir entre meta e índice");
  assert.equal(meta.settings.ownerPassword, "hash-new");
  assert.ok(idx.quinielas.some((q) => q.slug === "beta"), "y la operación concurrente sobrevive");
});

test("EDIT FLOW: a refused edit leaves NOTHING partially applied", async () => {
  const store = editStore();
  const idxBefore = store.raw("platform_index");
  const metaBefore = store.raw("quiniela:alpha:meta");

  const r = await saveSettings(store, "ghost", { name: "X", hashedOwnerPassword: "hash-new" });
  assert.equal(r.status, 404);
  assert.deepEqual(store.raw("platform_index"), idxBefore);
  assert.deepEqual(store.raw("quiniela:alpha:meta"), metaBefore);
});

test("EDIT FLOW: the forbidden outcomes from the ticket are unreachable", async () => {
  const store = editStore();
  await saveSettings(store, "alpha", { name: "Nuevo", hashedOwnerPassword: "hash-new" });
  const meta = store.raw("quiniela:alpha:meta");
  const entry = store.raw("platform_index").quinielas[0];
  // prohibido: password actualizado pero index no
  assert.ok(meta.settings.ownerPassword === "hash-new" && entry.name === "Nuevo");
  // prohibido: name divergente meta vs index
  assert.equal(meta.groupName, entry.name);
});

test("EDIT FLOW: a partial intent only changes what it names, and still atomically", async () => {
  const store = editStore();
  await saveSettings(store, "alpha", { name: null, hashedOwnerPassword: "hash-new" });
  const meta = store.raw("quiniela:alpha:meta");
  const entry = store.raw("platform_index").quinielas[0];
  assert.equal(meta.settings.ownerPassword, "hash-new");
  assert.equal(meta.groupName, "Alpha", "sin nombre en la intención, el nombre no cambia");
  assert.equal(entry.name, "Alpha", "y el índice tampoco");
});

test("EDIT FLOW: editing bumps the index version, so a stale generic write cannot revert the rename", async () => {
  const store = editStore();
  const stalePanel = store.raw("platform_index");
  await saveSettings(store, "alpha", { name: "Nuevo" });
  stalePanel.quinielas[0].name = "Viejo"; // panel still on version 1
  assert.equal((await indexWrite(store, stalePanel)).status, 409);
  assert.equal(store.raw("platform_index").quinielas[0].name, "Nuevo");
});

// ==== the "version counts admin edits only" premise, demonstrated ==========

test("PREMISE: no server-side writer mutates an admin-owned field on an EXISTING entry", () => {
  // The decision that server writers don't bump the version is only safe while
  // this holds. Asserted against the real source rather than by inspection.
  const adminOwned = ["name", "paid", "exempt", "customJornadaLimit"];
  const assignments = serverSrc.match(/\b(?:entry|q|target)\.(name|paid|exempt|customJornadaLimit)\s*=[^=]/g) || [];
  assert.deepEqual(assignments, [], `un writer del servidor asigna un campo admin-owned: ${assignments.join(", ")}`);

  // The only places those fields appear on a write path are entry CREATION
  // (push) and entry REMOVAL (filter) — membership, which mergePlatformIndex
  // always takes from the locked row, so neither can be lost or resurrected.
  adminOwned.forEach((field) => {
    const inPush = new RegExp(`quinielas\\.push\\([\\s\\S]{0,400}?${field}`).test(serverSrc);
    const inMerge = serverSrc.includes("mergePlatformIndex");
    assert.ok(inPush || inMerge, `${field} debe estar cubierto por creación o por el merge`);
  });
});

test("PREMISE: the two multi-row admin endpoints DO bump the version, because they edit admin-owned fields", () => {
  for (const marker of ['app.post("/api/platform/quinielas/:slug/entitlement"', 'app.post("/api/platform/quinielas/:slug/settings"']) {
    const slice = blockFrom(serverSrc, marker);
    assert.ok(slice.includes("putRow(\"platform_index\", result.index, client)"), `${marker}: debe escribir el índice`);
    assert.ok(slice.includes('await client.query("BEGIN")'), `${marker}: transacción`);
    assert.ok(slice.includes('getRowLocked("platform_index", client)'), `${marker}: lock del índice`);
    assert.ok(slice.includes('await client.query("COMMIT")'), `${marker}: commit`);
    assert.ok(slice.includes('await client.query("ROLLBACK").catch(() => {})'), `${marker}: rollback ante error`);
    assert.ok(slice.includes("client.release()"), `${marker}: libera conexión`);
    assert.ok(slice.includes("verifyPassword(providedPlatformAuth, platformHash)"), `${marker}: exige auth de plataforma`);
  }
  // stampVersion lives inside the shared logic both endpoints delegate to.
  const src = fs.readFileSync(path.join(__dirname, "..", "platformState.js"), "utf8");
  const granted = src.slice(src.indexOf("function applyEntitlementGrant"), src.indexOf("function applyQuinielaSettings"));
  assert.ok(granted.includes("stampVersion("), "applyEntitlementGrant debe avanzar la versión");
  assert.ok(src.slice(src.indexOf("function applyQuinielaSettings")).includes("stampVersion("), "applyQuinielaSettings debe avanzar la versión");
});

test("SERVER: the grant endpoint locks platform_index BEFORE platform_payment_log", () => {
  const slice = blockFrom(serverSrc, 'app.post("/api/platform/quinielas/:slug/entitlement"');
  const idxIdx = slice.indexOf('getRowLocked("platform_index", client)');
  const logIdx = slice.indexOf('getRowLocked("platform_payment_log", client)');
  assert.ok(idxIdx !== -1 && logIdx !== -1);
  assert.ok(idxIdx < logIdx, "orden de locks consistente: índice primero");
});

test("SERVER: the settings endpoint locks platform_index BEFORE the meta row", () => {
  const slice = blockFrom(serverSrc, 'app.post("/api/platform/quinielas/:slug/settings"');
  const idxIdx = slice.indexOf('getRowLocked("platform_index", client)');
  const metaIdx = slice.indexOf("getRowLocked(metaKey, client)");
  assert.ok(idxIdx !== -1 && metaIdx !== -1);
  assert.ok(idxIdx < metaIdx, "mismo orden que create-quiniela y la rama quiniela-meta");
});

test("FRONTEND: both grant-id generators produce ids the server accepts", () => {
  // The server enforces /^[A-Za-z0-9_-]{8,64}$/ AND typeof === "string".
  // Both branches of newGrantId() must satisfy it, including the fallback
  // used when crypto.randomUUID is unavailable.
  const serverPattern = /^[A-Za-z0-9_-]{8,64}$/;
  const fromUuid = "3f2b8c1d4e5a6b7c8d9e0f1a2b3c4d5e"; // randomUUID() with dashes removed
  assert.match(fromUuid, serverPattern);
  const fallback = "grant" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  assert.match(fallback, serverPattern, `el fallback sin crypto.randomUUID produjo: ${fallback}`);

  // And the shipped generator really is those two branches.
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const gen = indexHtml.slice(indexHtml.indexOf("function newGrantId()"), indexHtml.indexOf("function newGrantId()") + 400);
  assert.ok(gen.includes("crypto.randomUUID"), "debe preferir randomUUID");
  assert.ok(gen.includes("Math.random"), "y tener fallback cuando no existe");

  // A number that stringifies into the right shape must NOT be accepted:
  // the server checks the type first.
  const guard = serverSrc.slice(serverSrc.indexOf("function isUsableGrantId"), serverSrc.indexOf("function isUsableGrantId") + 200);
  assert.ok(guard.includes('typeof value === "string"'), "el id debe ser string, no algo que se convierta en string");
});

test("FRONTEND: a grant id survives a retry but is discarded once the server has rejected it", () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const start = indexHtml.indexOf("async function runGrant(");
  assert.ok(start !== -1, "debe existir el helper de otorgamiento");
  const handler = indexHtml.slice(start, start + 1600);
  // El MISMO id se reutiliza mientras el intento siga vivo: eso es lo que
  // hace que un reintento tras una respuesta perdida no otorgue dos veces.
  assert.ok(handler.includes('btn.dataset.grantId || (btn.dataset.grantId = newGrantId())'),
    "el id debe persistir en el botón entre intentos");
  // Y se descarta cuando el servidor ya lo rechazó, para no repetir el mismo
  // error para siempre.
  assert.ok(handler.includes("delete btn.dataset.grantId;"), "un id quemado se descarta");
  assert.ok(handler.includes("r.applied"), "debe distinguir un otorgamiento real de un replay");
});

test("FRONTEND: the dashboard uses the atomic endpoints and checks their result", () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(indexHtml.includes("grantEntitlement("), "el cambio de plan debe usar el endpoint atómico");
  assert.ok(indexHtml.includes("saveQuinielaSettings("), "la edición debe usar el endpoint atómico");
  // El bug era exactamente este: no comprobar el retorno del append.
  assert.ok(!/await setPlatformPaymentLog\(paymentLog\);/.test(indexHtml),
    "el append del payment log por documento completo ya no debe existir");
  const start = indexHtml.indexOf("async function runGrant(");
  const handler = indexHtml.slice(start, start + 1600);
  assert.ok(handler.includes("if(r.ok)"), "el caller debe comprobar el resultado");
  assert.ok(handler.includes("grantId"), "y mandar un id idempotente");
  // Y el panel ya no puede tocar los campos muertos.
  assert.ok(!indexHtml.includes("data-paid-toggle"), "el checkbox de Pagado debe estar retirado");
  assert.ok(!indexHtml.includes("data-exempt-toggle"), "el checkbox de Exenta debe estar retirado");
});

// ==== interleaving: writes actually serialize ==============================

test("INTERLEAVING: concurrent in-flight writes serialize; the later one sees the earlier one's version", async () => {
  const store = createStore({ platform_index: { version: 1, quinielas: [{ slug: "alpha", paid: false, exempt: false }] } });
  const a = store.raw("platform_index"); a.quinielas[0].paid = true;
  const b = store.raw("platform_index"); b.quinielas[0].exempt = true;

  // Both dispatched before either completes.
  const [resA, resB] = await Promise.all([indexWrite(store, a), indexWrite(store, b)]);
  const codes = [resA.status, resB.status].sort();
  assert.deepEqual(codes, [200, 409], "exactly one wins, whichever got the lock first");
  assert.equal(store.raw("platform_index").version, 2, "and only one write landed");
});

// ==== structural: server.js really runs this inside a locked transaction ==

// Brace-matched extraction, so a slice can never bleed into the next handler
// (and so a marker that is also a substring of some OTHER construct can't
// silently anchor the test on the wrong block).
function blockFrom(source, marker, { from = 0 } = {}) {
  const start = source.indexOf(marker, from);
  assert.ok(start !== -1, `no se encontró ${marker}`);
  const braceStart = source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

// The POST handler, then the platform branch inside it — the GET handler has
// a branch that reads identically, so anchoring on the POST one is required.
const kvPostHandler = blockFrom(serverSrc, 'app.post("/api/kv/:key"');
const handlerSlice = (marker) => blockFrom(serverSrc, marker);

test("SERVER: the platform branch runs inside BEGIN + FOR UPDATE + COMMIT, and no longer writes unlocked", () => {
  const slice = blockFrom(kvPostHandler, 'if (info.kind === "platform") {');
  assert.ok(slice.includes('await client.query("BEGIN")'), "must open a transaction");
  assert.ok(slice.includes('await getRowLocked(req.params.key, client)'), "must read the row under FOR UPDATE");
  assert.ok(slice.includes('await putRow(req.params.key, finalValue, client)'), "must write with the SAME client");
  assert.ok(slice.includes('await client.query("COMMIT")'), "must commit");
  assert.ok(slice.includes('client.release()'), "must release the connection");
  assert.ok(slice.includes('status(409)') && slice.includes("stale_version"), "must reject a stale snapshot with 409");
});

// Balances parentheses instead of stopping at the first ")", so a putRow
// whose argument is itself a call — putRow(k, f(a, b), client) — is read
// whole rather than truncated into a false positive.
function putRowCalls(source) {
  const calls = [];
  const marker = "await putRow(";
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) return calls;
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") { depth--; if (depth === 0) break; }
    }
    calls.push(source.slice(at, i + 1));
    from = i + 1;
  }
}

test("SERVER: no putRow call anywhere is left without a transaction client", () => {
  const calls = putRowCalls(serverSrc);
  assert.ok(calls.length > 0);
  calls.forEach((call) => {
    assert.ok(/,\s*client\)$/.test(call), `este putRow escribe fuera de una transacción: ${call}`);
  });
});

test("SERVER: the putRow scanner really does catch an untransacted write", () => {
  // Guards the guard: the previous test is only meaningful if its extractor
  // would actually fail on a bad call, nested arguments included.
  const bad = putRowCalls('await putRow("k", buildValue(a, b));');
  assert.deepEqual(bad, ['await putRow("k", buildValue(a, b))']);
  assert.ok(!/,\s*client\)$/.test(bad[0]), "un putRow sin client debe ser detectado");
});

test("SERVER: submit-bet-answer and set-pin read under the lock and write with the same client", () => {
  for (const marker of ['app.post("/api/submit-bet-answer"', 'app.post("/api/set-pin"']) {
    const slice = handlerSlice(marker);
    assert.ok(slice.includes('await client.query("BEGIN")'), `${marker}: must open a transaction`);
    assert.ok(slice.includes("await getRowLocked(metaKey, client)"), `${marker}: must read the meta under FOR UPDATE`);
    // MON-002B QA fix: both handlers now stamp participant revisions before
    // writing, so the value is no longer the bare `value` — but it is still
    // the same transactional client, which is what this guards.
    assert.ok(/await putRow\(metaKey, stored\w+, client\)/.test(slice), `${marker}: must write with the same client`);
    assert.ok(slice.includes("stampMetaRevisions("), `${marker}: a single-participant change must advance that participant's revision`);
    assert.ok(slice.includes('await client.query("COMMIT")'), `${marker}: must commit`);
    assert.ok(slice.includes('await client.query("ROLLBACK").catch(() => {})'), `${marker}: must roll back on error`);
    assert.ok(slice.includes("client.release()"), `${marker}: must release the connection`);
    assert.ok(!/const value = await getRow\(metaKey\);/.test(slice), `${marker}: must not read the meta unlocked`);
  }
});

test("SERVER: a non-object platform value is refused before it can be reshaped by the version stamp", () => {
  const slice = blockFrom(kvPostHandler, 'if (info.kind === "platform") {');
  assert.ok(slice.includes("invalid_value"), "must reject arrays/primitives explicitly");
  const guardIdx = slice.indexOf("invalid_value");
  const connectIdx = slice.indexOf("await pool.connect()");
  assert.ok(guardIdx < connectIdx, "and reject before opening a transaction");
});

test("SERVER: the platform branch validates the client-sent version before touching the row", () => {
  const slice = blockFrom(kvPostHandler, 'if (info.kind === "platform") {');
  const validateIdx = slice.indexOf("readExpectedVersion(value)");
  const connectIdx = slice.indexOf("await pool.connect()");
  assert.ok(validateIdx !== -1 && connectIdx !== -1);
  assert.ok(validateIdx < connectIdx, "a malformed version must be rejected before opening a transaction");
  assert.ok(slice.includes("invalid_version"));
});

test("SERVER: every quiniela-meta write path still locks platform_index before the meta row", () => {
  // Lock ORDER matters: two-row transactions must always take platform_index
  // first. The new platform path locks exactly one row, so it cannot form a
  // cycle with them — this test guards the pre-existing ordering.
  const slice = blockFrom(kvPostHandler, '} else if (info.kind === "quiniela-meta") {');
  const idxIdx = slice.indexOf('getRowLocked("platform_index", client)');
  const metaIdx = slice.indexOf("getRowLocked(info.metaKey, client)");
  assert.ok(idxIdx !== -1 && metaIdx !== -1);
  assert.ok(idxIdx < metaIdx, "platform_index must be locked first");
});

test("PLATFORM_STATE: the admin-editable allowlist stays narrow and disjoint from server-owned fields", () => {
  // MON-002B narrowed this to a single field. paid/exempt were removed
  // because they granted nothing, and customJornadaLimit because it fed only
  // the client-side gate that has been retired; a per-quiniela round budget
  // is a MANUAL_GRANT now, which enforcement actually reads.
  assert.deepEqual([...ADMIN_EDITABLE_INDEX_FIELDS].sort(), ["name"]);
  const overlap = ADMIN_EDITABLE_INDEX_FIELDS.filter((f) => SERVER_OWNED_INDEX_FIELDS.includes(f));
  assert.deepEqual(overlap, [], "a field can never be both admin-editable and server-owned");
});

test("GRANT: an id reused for a DIFFERENT quiniela is refused, never recorded twice under one id", async () => {
  // The transition rule stops one quiniela being charged twice. This is the
  // other half, kept from MON-001F.3: two different payments sharing an id
  // would not be a double charge, but the log would no longer be able to say
  // which payment is which.
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-shared-0001" });
  const r = await grant(store, "beta", { plan: "PLUS", grantId: "grant-shared-0001" });
  assert.equal(r.status, 400);
  assert.equal(r.error, "grant_id_conflict");
  assert.equal(entryOf(store, "beta").entitlement.plan, "FREE", "and beta is NOT left on a plan with no record");
  assert.equal(paymentsOf(store).length, 1);
});

test("GRANT: a mark and a revoke landing concurrently never produce more than one payment", async () => {
  for (const order of [0, 1]) {
    const store = grantStore();
    const ops = [
      () => grant(store, "alpha", { plan: "PLUS", grantId: "grant-order-00001" }),
      () => grant(store, "alpha", { plan: "FREE", grantId: "grant-order-00002", reason: "cruce" }),
    ];
    await Promise.all(order === 0 ? [ops[0](), ops[1]()] : [ops[1](), ops[0]()]);
    assert.ok(paymentsOf(store).length <= 1, `orden ${order}: a lo más un pago`);
    const entry = entryOf(store, "alpha");
    // Whatever the order, the row is coherent: PLUS implies a payment exists.
    if (entry.entitlement.plan === "PLUS") assert.equal(paymentsOf(store).length, 1);
  }
});

test("GRANT: the rev/version guards are concurrency controls, not authorisation", () => {
  // Stated so nobody later mistakes them for a security boundary: only an
  // owner, the platform password, or an admin's PIN can write a meta row at
  // all (resolveMetaAuthTier), and only the platform password can grant.
  // Forging a revision therefore lets an already-authorised writer do what
  // they were already allowed to do — it cannot escalate anything.
  const tier = blockFrom(serverSrc, "function resolveMetaAuthTier(");
  assert.ok(tier.includes('return "owner"') && tier.includes('return "platform"') && tier.includes('return "admin-pin"'));
  assert.ok(tier.trimEnd().endsWith("return null;\n}"), "anyone else gets no tier at all");
  const granting = blockFrom(serverSrc, 'app.post("/api/platform/quinielas/:slug/entitlement"');
  assert.ok(granting.includes("verifyPassword(providedPlatformAuth, platformHash)"));
});

test("PURCHASE HISTORY 11: the history is append-only and server-owned, so a purchase cannot be edited away", () => {
  // The decision rests on the history, so it matters that nothing can remove
  // an entry from it: it is in the server-owned list (a browser's snapshot
  // never supplies it), and no code path anywhere assigns it a shorter array.
  assert.ok(SERVER_OWNED_INDEX_FIELDS.includes("entitlementHistory"));
  assert.ok(!ADMIN_EDITABLE_INDEX_FIELDS.includes("entitlementHistory"));
  const state = fs.readFileSync(path.join(__dirname, "..", "platformState.js"), "utf8");
  assert.ok(!/entitlementHistory\s*=\s*\[\]/.test(state.slice(state.indexOf("function applyEntitlementGrant"))),
    "the grant path must never reset the history");
  assert.ok(!/entitlementHistory\.(splice|shift|pop|filter)/.test(state), "and never shorten it");
  assert.ok(!/entitlementHistory\.(splice|shift|pop|filter)/.test(serverSrc));
});

test("PURCHASE HISTORY: wiping the PAYMENT LOG does not re-enable a charge", async () => {
  // The payment log is writable through the generic platform key, so it must
  // not be the thing the economic decision depends on. It is the money
  // record; the entitlement history is the authority.
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-wipe-00001" });
  await grant(store, "alpha", { plan: "FREE", grantId: "grant-wipe-00002", reason: "revoke" });
  store.seed("platform_payment_log", { version: 9, payments: [] });   // the log is emptied

  const back = await grant(store, "alpha", { plan: "PLUS", grantId: "grant-wipe-00003" });
  assert.equal(back.recorded, false, "still no second charge");
  assert.equal(back.reason, "reactivated_existing_purchase");
  assert.equal(paymentsOf(store).length, 0, "and no payment is invented to replace the wiped one");
});

test("PURCHASE HISTORY: two concurrent reactivations restore once and charge nothing", async () => {
  const store = grantStore();
  await grant(store, "alpha", { plan: "PLUS", grantId: "grant-conc-00001" });
  await grant(store, "alpha", { plan: "FREE", grantId: "grant-conc-00002", reason: "revoke" });
  const [a, b] = await Promise.all([
    grant(store, "alpha", { plan: "PLUS", grantId: "grant-conc-00003" }),
    grant(store, "alpha", { plan: "PLUS", grantId: "grant-conc-00004" }),
  ]);
  assert.equal([a, b].filter((r) => r.applied).length, 1, "one reactivates, the other finds it already done");
  assert.equal([a, b].filter((r) => r.recorded).length, 0);
  assert.equal(paymentsOf(store).length, 1);
  assert.equal(entryOf(store, "alpha").entitlement.plan, "PLUS");
});
