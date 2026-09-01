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
  mergePlatformIndex, applyPaidToggle, applyQuinielaSettings,
  ADMIN_EDITABLE_INDEX_FIELDS, SERVER_OWNED_INDEX_FIELDS,
} = require("../platformState");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ---- minimal transactional KV -------------------------------------------
// One writer at a time per key, committed-state reads, whole-document writes.
function createStore(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const locks = new Map();
  return {
    raw(key) { const v = rows.get(key); return v === undefined ? null : JSON.parse(JSON.stringify(v)); },
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
      { slug: "alpha", paid: false, entitlement: { plan: "FREE" }, lifecycleRoundsConsumed: 3, lifecycleConsumedRoundIds: ["r1", "r2", "r3"] },
    ] },
  });

  // T0 — the admin panel loads the index and keeps it in browser memory.
  const adminSnapshot = store.raw("platform_index");

  // T1 — a server-side transaction registers 'beta' and advances alpha's
  // lifecycle budget, exactly as create-quiniela + a meta save would.
  await store.transaction("platform_index", async ({ current, write }) => {
    current.quinielas[0].lifecycleRoundsConsumed = 4;
    current.quinielas[0].lifecycleConsumedRoundIds = ["r1", "r2", "r3", "r4"];
    current.quinielas.push({ slug: "beta", paid: false, entitlement: { plan: "PLUS" }, lifecycleRoundsConsumed: 0, lifecycleConsumedRoundIds: [] });
    write(current); // server-side writers deliberately do NOT bump the version
  });

  // T2 — the admin toggles paid on the T0 snapshot and sends it back.
  adminSnapshot.quinielas[0].paid = true;
  const res = await indexWrite(store, adminSnapshot);
  assert.equal(res.status, 200, "server activity must not 409 the admin");

  const final = store.raw("platform_index");
  const bySlug = Object.fromEntries(final.quinielas.map((q) => [q.slug, q]));

  assert.ok(bySlug.beta, "the quiniela registered at T1 must survive");
  assert.equal(bySlug.beta.entitlement.plan, "PLUS", "and keep its entitlement");
  assert.equal(bySlug.alpha.lifecycleRoundsConsumed, 4, "consumed lifecycle budget is never given back");
  assert.deepEqual(bySlug.alpha.lifecycleConsumedRoundIds, ["r1", "r2", "r3", "r4"]);
  assert.equal(bySlug.alpha.paid, true, "and the admin's own change still applies");
});

test("PLATFORM_INDEX: every server-owned field survives a stale admin snapshot", async () => {
  const serverEntry = {
    slug: "alpha", paid: false, exempt: false,
    entitlement: { plan: "PLUS" }, entitlementHistory: [{ action: "grant" }],
    lifecycleConsumedRoundIds: ["r1"], lifecycleRoundsConsumed: 1,
    participantCount: 9, roundCount: 4,
  };
  const store = createStore({ platform_index: { version: 1, quinielas: [serverEntry] } });

  // A snapshot where EVERY server-owned field is stale/wrong.
  const stale = { version: 1, quinielas: [{
    slug: "alpha", paid: true,
    entitlement: { plan: "FREE" }, entitlementHistory: [],
    lifecycleConsumedRoundIds: [], lifecycleRoundsConsumed: 0,
    participantCount: 0, roundCount: 0,
  }] };

  assert.equal((await indexWrite(store, stale)).status, 200);
  const entry = store.raw("platform_index").quinielas[0];
  SERVER_OWNED_INDEX_FIELDS.forEach((field) => {
    assert.deepEqual(entry[field], serverEntry[field], `${field} must come from the locked row, never the client`);
  });
  assert.equal(entry.paid, true, "the admin-editable field still applies");
});

test("PLATFORM_INDEX: an admin snapshot can neither delete nor invent registry entries", async () => {
  const store = createStore({ platform_index: { version: 1, quinielas: [
    { slug: "alpha", paid: false }, { slug: "beta", paid: false },
  ] } });
  // Snapshot that dropped 'beta' and made up 'ghost'.
  await indexWrite(store, { version: 1, quinielas: [{ slug: "alpha", paid: true }, { slug: "ghost", paid: true, entitlement: { plan: "PLUS" } }] });
  const slugs = store.raw("platform_index").quinielas.map((q) => q.slug).sort();
  assert.deepEqual(slugs, ["alpha", "beta"], "beta survives, ghost is never created");
});

test("PLATFORM_INDEX: two admins editing from the same version -> one wins, the other gets 409", async () => {
  const store = createStore({ platform_index: { version: 4, quinielas: [{ slug: "alpha", paid: false, exempt: false }] } });
  const a = store.raw("platform_index");
  const b = store.raw("platform_index");
  a.quinielas[0].paid = true;
  b.quinielas[0].exempt = true;

  const resA = await indexWrite(store, a);
  const resB = await indexWrite(store, b);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 409, "the second admin must not silently win");
  assert.equal(resB.currentVersion, 5);

  const final = store.raw("platform_index");
  assert.equal(final.version, 5, "exactly one write landed");
  assert.equal(final.quinielas[0].paid, true);
  assert.equal(final.quinielas[0].exempt, false, "the rejected edit was NOT applied");

  // Recovery: reload and retry succeeds, on top of the write that won.
  const reloaded = store.raw("platform_index");
  reloaded.quinielas[0].exempt = true;
  assert.equal((await indexWrite(store, reloaded)).status, 200);
  const after = store.raw("platform_index");
  assert.equal(after.version, 6);
  assert.equal(after.paid, undefined);
  assert.equal(after.quinielas[0].paid, true, "and both changes now coexist");
  assert.equal(after.quinielas[0].exempt, true);
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
    { slug: "alpha", paid: false, exempt: false }, { slug: "beta", paid: false, exempt: false },
  ] } });
  const panelIdx = store.raw("platform_index"); // loaded once, like the dashboard does

  panelIdx.quinielas[0].paid = true;
  const first = await indexWrite(store, panelIdx);
  assert.equal(first.status, 200);
  panelIdx.version = first.version; // what savePlatformRow now does

  panelIdx.quinielas[1].exempt = true;
  const second = await indexWrite(store, panelIdx);
  assert.equal(second.status, 200, "a second toggle from the same open panel must not be treated as stale");

  const final = store.raw("platform_index");
  assert.equal(final.quinielas[0].paid, true, "both edits survive");
  assert.equal(final.quinielas[1].exempt, true);
  assert.equal(final.version, 3);
});

test("SEQUENTIAL EDITS: a panel that does NOT refresh its version is correctly refused on the second edit", async () => {
  const store = createStore({ platform_index: { version: 1, quinielas: [{ slug: "alpha", paid: false, exempt: false }] } });
  const stalePanel = store.raw("platform_index");
  stalePanel.quinielas[0].paid = true;
  assert.equal((await indexWrite(store, stalePanel)).status, 200);
  stalePanel.quinielas[0].exempt = true; // version still 1 -> genuinely stale now
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
// These drive the shipped applyPaidToggle/applyQuinielaSettings logic through
// the same transactional store, as one atomic operation per admin action.

async function markPaid(store, slug, paid, paymentId, { settings = { pricePerParticipant: 10 } } = {}) {
  // Mirrors the endpoint: lock platform_index, then platform_payment_log.
  return store.transaction("platform_index", async ({ current: index, write: writeIndex }) =>
    store.transaction("platform_payment_log", async ({ current: paymentLog, write: writeLog }) => {
      const r = applyPaidToggle({ index, paymentLog, settings, slug, paid, paymentId });
      if (!r.ok) return { status: 404, error: r.error };
      if (r.paymentLog) writeLog(r.paymentLog);
      writeIndex(r.index);
      return { status: 200, recorded: r.recorded, indexVersion: r.index.version };
    }));
}

const paidStore = () => createStore({
  platform_index: { version: 1, quinielas: [
    { slug: "alpha", name: "Alpha", paid: false, participantCount: 4 },
    { slug: "beta", name: "Beta", paid: false, participantCount: 7 },
  ] },
  platform_payment_log: { version: 1, payments: [] },
});

test("PAID FLOW: two admins marking DIFFERENT quinielas as paid -> both paid, both payments recorded exactly once", async () => {
  const store = paidStore();
  const [a, b] = await Promise.all([
    markPaid(store, "alpha", true, "pay-alpha-0001"),
    markPaid(store, "beta", true, "pay-beta-0001"),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const idx = store.raw("platform_index");
  assert.equal(idx.quinielas.find((q) => q.slug === "alpha").paid, true);
  assert.equal(idx.quinielas.find((q) => q.slug === "beta").paid, true);

  const payments = store.raw("platform_payment_log").payments;
  assert.equal(payments.length, 2, "ningún pago se perdió");
  assert.deepEqual(payments.map((p) => p.slug).sort(), ["alpha", "beta"]);
  // Amounts come from the locked server state, not from the browser.
  assert.equal(payments.find((p) => p.slug === "alpha").amount, 40);
  assert.equal(payments.find((p) => p.slug === "beta").amount, 70);
});

test("PAID FLOW: a retry after a lost response records the SAME payment once, never twice", async () => {
  const store = paidStore();
  const first = await markPaid(store, "alpha", true, "pay-alpha-0001");
  assert.equal(first.recorded, true);
  // The response never reached the browser; the admin clicks again and the
  // client reuses the id it already generated for this intent.
  const retry = await markPaid(store, "alpha", true, "pay-alpha-0001");
  assert.equal(retry.status, 200);
  assert.equal(retry.recorded, false, "el reintento no registra un segundo pago");
  assert.equal(store.raw("platform_payment_log").payments.length, 1);
});

test("PAID FLOW: two tabs marking the SAME quiniela paid record one payment, not two", async () => {
  const store = paidStore();
  await Promise.all([
    markPaid(store, "alpha", true, "pay-alpha-0001"),
    markPaid(store, "alpha", true, "pay-alpha-0001"),
  ]);
  assert.equal(store.raw("platform_payment_log").payments.length, 1);
  assert.equal(store.raw("platform_index").quinielas[0].paid, true);
});

test("PAID FLOW: paid=true and its payment record are always coherent -- never one without the other", async () => {
  const store = paidStore();
  await markPaid(store, "alpha", true, "pay-alpha-0001");
  const idx = store.raw("platform_index");
  const payments = store.raw("platform_payment_log").payments;
  const paidSlugs = idx.quinielas.filter((q) => q.paid).map((q) => q.slug);
  const loggedSlugs = [...new Set(payments.map((p) => p.slug))];
  assert.deepEqual(paidSlugs, loggedSlugs, "cada quiniela pagada tiene su registro y viceversa");
});

test("PAID FLOW: un-marking as paid never deletes the historical payment record", async () => {
  const store = paidStore();
  await markPaid(store, "alpha", true, "pay-alpha-0001");
  const un = await markPaid(store, "alpha", false, null);
  assert.equal(un.status, 200);
  assert.equal(store.raw("platform_index").quinielas[0].paid, false);
  assert.equal(store.raw("platform_payment_log").payments.length, 1, "el pago ocurrió: borrarlo sería reescribir la historia");
});

test("PAID FLOW: marking an unknown quiniela is refused and writes nothing", async () => {
  const store = paidStore();
  const before = store.raw("platform_index");
  const r = await markPaid(store, "ghost", true, "pay-ghost-0001");
  assert.equal(r.status, 404);
  assert.deepEqual(store.raw("platform_index"), before);
  assert.equal(store.raw("platform_payment_log").payments.length, 0);
});

test("PAID FLOW: the toggle bumps the index version, so a stale generic write can no longer revert it", async () => {
  const store = paidStore();
  const stalePanel = store.raw("platform_index"); // version 1
  await markPaid(store, "alpha", true, "pay-alpha-0001"); // -> version 2

  // The panel still believes alpha is unpaid and tries a generic index write.
  stalePanel.quinielas[0].exempt = true;
  const res = await indexWrite(store, stalePanel);
  assert.equal(res.status, 409, "debe rechazarse en vez de revertir paid=true");
  assert.equal(store.raw("platform_index").quinielas[0].paid, true);
});

// ==== MON-001F.2 — product-flow: editing a quiniela (meta + index) =========

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
  platform_index: { version: 1, quinielas: [{ slug: "alpha", name: "Alpha", customJornadaLimit: null, paid: false }] },
  "quiniela:alpha:meta": { groupName: "Alpha", settings: { ownerPassword: "hash-old" }, rounds: [] },
});

test("EDIT FLOW: the audited T0/T1/T2 -> all three changes land coherently", async () => {
  const store = editStore();
  // T1 — another valid operation advances platform_index while the edit form
  // is open (a new quiniela is registered).
  await store.transaction("platform_index", async ({ current, write }) => {
    current.quinielas.push({ slug: "beta", name: "Beta", paid: false });
    write(current);
  });

  // T2 — the admin saves name + password + limit.
  const r = await saveSettings(store, "alpha", { name: "Alpha Renombrada", hashedOwnerPassword: "hash-new", customJornadaLimit: 9 });
  assert.equal(r.status, 200);

  const idx = store.raw("platform_index");
  const meta = store.raw("quiniela:alpha:meta");
  const entry = idx.quinielas.find((q) => q.slug === "alpha");
  assert.equal(entry.name, "Alpha Renombrada");
  assert.equal(meta.groupName, "Alpha Renombrada", "el nombre no puede divergir entre meta e índice");
  assert.equal(meta.settings.ownerPassword, "hash-new");
  assert.equal(entry.customJornadaLimit, 9);
  assert.ok(idx.quinielas.some((q) => q.slug === "beta"), "y la operación concurrente sobrevive");
});

test("EDIT FLOW: a refused edit leaves NOTHING partially applied", async () => {
  const store = editStore();
  const idxBefore = store.raw("platform_index");
  const metaBefore = store.raw("quiniela:alpha:meta");

  const r = await saveSettings(store, "ghost", { name: "X", hashedOwnerPassword: "hash-new", customJornadaLimit: 3 });
  assert.equal(r.status, 404);
  assert.deepEqual(store.raw("platform_index"), idxBefore);
  assert.deepEqual(store.raw("quiniela:alpha:meta"), metaBefore);
});

test("EDIT FLOW: the forbidden outcomes from the ticket are unreachable", async () => {
  const store = editStore();
  await saveSettings(store, "alpha", { name: "Nuevo", hashedOwnerPassword: "hash-new", customJornadaLimit: 4 });
  const meta = store.raw("quiniela:alpha:meta");
  const entry = store.raw("platform_index").quinielas[0];
  // prohibido: password actualizado pero index no
  assert.ok(meta.settings.ownerPassword === "hash-new" && entry.customJornadaLimit === 4);
  // prohibido: name divergente meta vs index
  assert.equal(meta.groupName, entry.name);
  // prohibido: customJornadaLimit perdido mientras otros cambios aterrizan
  assert.equal(entry.customJornadaLimit, 4);
});

test("EDIT FLOW: a partial intent only changes what it names, and still atomically", async () => {
  const store = editStore();
  await saveSettings(store, "alpha", { name: null, hashedOwnerPassword: null, customJornadaLimit: 6 });
  const meta = store.raw("quiniela:alpha:meta");
  const entry = store.raw("platform_index").quinielas[0];
  assert.equal(entry.customJornadaLimit, 6);
  assert.equal(meta.groupName, "Alpha", "sin nombre en la intención, el nombre no cambia");
  assert.equal(meta.settings.ownerPassword, "hash-old", "sin contraseña en la intención, no se toca");
});

test("EDIT FLOW: editing bumps the index version, so a stale generic write cannot revert the rename", async () => {
  const store = editStore();
  const stalePanel = store.raw("platform_index");
  await saveSettings(store, "alpha", { name: "Nuevo", customJornadaLimit: 2 });
  stalePanel.quinielas[0].exempt = true; // panel still on version 1
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
  for (const marker of ['app.post("/api/platform/quinielas/:slug/paid"', 'app.post("/api/platform/quinielas/:slug/settings"']) {
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
  const paid = src.slice(src.indexOf("function applyPaidToggle"), src.indexOf("function applyQuinielaSettings"));
  assert.ok(paid.includes("stampVersion("), "applyPaidToggle debe avanzar la versión");
  assert.ok(src.slice(src.indexOf("function applyQuinielaSettings")).includes("stampVersion("), "applyQuinielaSettings debe avanzar la versión");
});

test("SERVER: the paid endpoint locks platform_index BEFORE platform_payment_log", () => {
  const slice = blockFrom(serverSrc, 'app.post("/api/platform/quinielas/:slug/paid"');
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

test("FRONTEND: the dashboard uses the atomic endpoints and checks their result", () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(indexHtml.includes("markQuinielaPaid("), "el toggle de pago debe usar el endpoint atómico");
  assert.ok(indexHtml.includes("saveQuinielaSettings("), "la edición debe usar el endpoint atómico");
  // El bug era exactamente este: no comprobar el retorno del append.
  assert.ok(!/await setPlatformPaymentLog\(paymentLog\);/.test(indexHtml),
    "el append del payment log por documento completo ya no debe existir en el flujo de pago");
  // Anclar en el HANDLER, no en el markup de la plantilla.
  const handlerStart = indexHtml.indexOf('root.querySelectorAll("[data-paid-toggle]")');
  assert.ok(handlerStart !== -1, "debe existir el handler del toggle de pago");
  const handler = indexHtml.slice(handlerStart, handlerStart + 1800);
  assert.ok(handler.includes("if(r.ok)"), "el caller debe comprobar el resultado");
  assert.ok(handler.includes("paymentId"), "y mandar un id idempotente");
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

test("SERVER: no putRow call anywhere is left without a transaction client", () => {
  const calls = serverSrc.match(/await putRow\([^)]*\)/g) || [];
  assert.ok(calls.length > 0);
  calls.forEach((call) => {
    assert.ok(/,\s*client\)$/.test(call), `este putRow escribe fuera de una transacción: ${call}`);
  });
});

test("SERVER: submit-bet-answer and set-pin read under the lock and write with the same client", () => {
  for (const marker of ['app.post("/api/submit-bet-answer"', 'app.post("/api/set-pin"']) {
    const slice = handlerSlice(marker);
    assert.ok(slice.includes('await client.query("BEGIN")'), `${marker}: must open a transaction`);
    assert.ok(slice.includes("await getRowLocked(metaKey, client)"), `${marker}: must read the meta under FOR UPDATE`);
    assert.ok(slice.includes("await putRow(metaKey, value, client)"), `${marker}: must write with the same client`);
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
  assert.deepEqual([...ADMIN_EDITABLE_INDEX_FIELDS].sort(), ["customJornadaLimit", "exempt", "name", "paid"]);
  const overlap = ADMIN_EDITABLE_INDEX_FIELDS.filter((f) => SERVER_OWNED_INDEX_FIELDS.includes(f));
  assert.deepEqual(overlap, [], "a field can never be both admin-editable and server-owned");
});
