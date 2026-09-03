// platformState.js — MON-001F: concurrency rules for the platform-level rows.
//
// WHY THIS EXISTS
// ---------------
// The four platform keys (platform_index, commercial_config,
// platform_settings, platform_payment_log) were written by
// POST /api/kv/:key as a BLIND full-document overwrite: read unlocked,
// mutate in the browser, send the whole document back. Two operations close
// in time therefore lost each other's work silently — reproduced against a
// real Postgres before this fix:
//
//   T0  the admin panel loads platform_index and keeps it in browser memory
//   T1  create-quiniela (locked transaction) adds 'beta' and advances a
//       lifecycle counter
//   T2  the admin toggles paid=true and sends the T0 snapshot back
//   ->  'beta' and its entitlement are GONE, the lifecycle counter is back
//       to its T1 value, and the admin's own change survived
//
// That is not a theoretical race: the panel loads the index ONCE when the
// dashboard opens and every later toggle re-sends that same snapshot, so the
// window is as long as the tab stays open.
//
// This module holds the pure decision logic so it can be tested exhaustively
// without a database. server.js is responsible for running it inside
// BEGIN / SELECT ... FOR UPDATE / COMMIT.

// ---- version protocol -----------------------------------------------------
//
// `version` counts ADMIN EDITS made through POST /api/kv/:key. It is
// deliberately NOT bumped by the server's own transactional writers
// (create-quiniela, the quiniela-meta branch, sync-competition): those change
// server-owned fields, which mergePlatformIndex() already preserves, so
// bumping on them would 409 an admin for activity that cannot conflict with
// what the admin is editing. What the version DOES catch is the case nothing
// else can: two admins (or two tabs) editing the same platform row from the
// same starting point.
//
// The client never gets to choose the stored version — it only states which
// version it read. The server computes the next one itself, so a caller can't
// claim a future version, replay an old one, or smuggle a non-integer in.

// Absent/legacy rows count as version 0, so the very first write under this
// protocol is accepted from a client that has never seen a version, and every
// write after that must carry one.
function readStoredVersion(doc) {
  const v = doc && doc.version;
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

// What the CLIENT claims it read. Three outcomes:
//   { ok: true, expected: n }   a usable expectation
//   { ok: true, expected: null } no expectation stated (legacy client)
//   { ok: false }                present but malformed -> reject the request
// "3" is malformed on purpose: a string that coerces to a number is exactly
// the kind of value that must not silently become a valid expectation.
function readExpectedVersion(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: true, expected: null };
  if (!("version" in doc) || doc.version == null) return { ok: true, expected: null };
  const v = doc.version;
  if (!Number.isSafeInteger(v) || v < 0) return { ok: false };
  return { ok: true, expected: v };
}

// A write is fresh when the client's expectation matches what is actually
// stored right now (read under FOR UPDATE, so it cannot change underneath).
// A client that states no expectation is only allowed to write while the row
// has never been written under this protocol — otherwise omitting the field
// would be a way to opt out of the check entirely.
function isFreshWrite(storedVersion, expected) {
  if (expected === null) return storedVersion === 0;
  return expected === storedVersion;
}

// The next stored version is always computed here, never taken from input.
function stampVersion(doc, storedVersion) {
  return { ...doc, version: storedVersion + 1 };
}

// ---- platform_index merge -------------------------------------------------
//
// The ONLY fields an admin edits on an index entry, from the platform
// dashboard. Everything else on the entry is server-owned and must survive a
// stale admin snapshot untouched.
// MON-002B: `paid`, `exempt` and `customJornadaLimit` were removed from this
// list, and with them
// the last way a browser could write either one. They belonged to the legacy
// cobro model (a "jornadas gratis" threshold, a price of $10 x participants,
// and a bank deposit), and MON-002A established that neither of them granted
// any actual capacity — ticking "Exenta" changed nothing about the limits a
// quiniela then hit. What replaces them is a real grant (see
// applyEntitlementGrant below), which writes an entitlement the enforcement
// code actually reads. Existing paid/exempt values are left untouched in the
// stored rows: they are inert history now, not a live signal, and deleting
// them would destroy the only record of what an operator once decided.
// customJornadaLimit went the same way: it was the per-quiniela version of
// the legacy "jornadas gratis" threshold and fed nothing but that same
// client-side gate. Giving one quiniela a different round budget is now
// expressed as a MANUAL_GRANT, which enforcement actually honours.
const ADMIN_EDITABLE_INDEX_FIELDS = Object.freeze(["name"]);

// Server-owned fields, listed for documentation and for the tests to assert
// against: entitlement + entitlementHistory (what plan this quiniela has),
// lifecycleConsumedRoundIds + lifecycleRoundsConsumed (commercial budget
// already spent — explicitly designed never to be given back), and the
// participantCount/roundCount display cache.
const SERVER_OWNED_INDEX_FIELDS = Object.freeze([
  "entitlement", "entitlementHistory",
  "lifecycleConsumedRoundIds", "lifecycleRoundsConsumed",
  "participantCount", "roundCount",
]);

// Applies an admin's edit onto the CURRENT (locked) index rather than
// replacing it:
//
//   - membership comes from the current row, so a quiniela registered after
//     the admin loaded the page cannot be erased, and an entry the admin's
//     snapshot still contains cannot be resurrected;
//   - server-owned fields always come from the current row, so entitlements
//     and lifecycle budget cannot be rolled back;
//   - only the admin-editable fields are taken from the incoming document,
//     and only for entries that actually exist.
//
// Removing a quiniela from the registry is deliberately NOT expressible here
// — no such flow exists in the product today, and a blind full-document write
// is the wrong mechanism for it. It would need its own endpoint.
function mergePlatformIndex(current, incoming) {
  const currentEntries = Array.isArray(current && current.quinielas) ? current.quinielas : [];
  const incomingEntries = Array.isArray(incoming && incoming.quinielas) ? incoming.quinielas : [];

  const proposedBySlug = new Map();
  incomingEntries.forEach((entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && entry.slug != null) {
      proposedBySlug.set(String(entry.slug), entry);
    }
  });

  const quinielas = currentEntries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const proposed = proposedBySlug.get(String(entry.slug));
    if (!proposed) return entry;
    const merged = { ...entry };
    ADMIN_EDITABLE_INDEX_FIELDS.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(proposed, field)) merged[field] = proposed[field];
    });
    return merged;
  });

  return { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), quinielas };
}

// ---- multi-row admin operations ------------------------------------------
//
// MON-001F.2. The dashboard used to perform these as a SEQUENCE of separate
// whole-document writes, so a conflict partway through left the rows
// disagreeing: a quiniela marked paid with no payment record, or a rename
// committed to the meta row while platform_index kept the old name and lost
// the jornada limit.
//
// Both are expressed here as a single pure decision over the rows as they
// were read under lock, so server.js can apply them in ONE transaction and
// the tests can drive the same shipped logic without a database.

function findEntry(index, slug) {
  const entries = Array.isArray(index && index.quinielas) ? index.quinielas : [];
  return entries.find((q) => q && q.slug === slug) || null;
}

// ---- Operator grants (MON-002B) ------------------------------------------
//
// THE HOLE THIS CLOSES. MON-001 built a complete entitlement model — FREE,
// PLUS, GRANDFATHERED, MANUAL_GRANT, with frozen snapshots and fail-closed
// enforcement — and then nothing ever constructed a PLUS. buildPlusEntitlement
// and buildManualGrantEntitlement existed, were unit-tested, and were never
// imported by server.js, so in production a quiniela could only ever be FREE
// or GRANDFATHERED. An organizer who hit the limit had no reachable action,
// and neither did the operator: the dashboard's own "Pagado" and "Exenta"
// toggles wrote fields that no enforcement path ever read.
//
// A grant is the one operation that changes what a quiniela is entitled to,
// so it is deliberately narrow:
//
//   PLUS          numbers and price come from commercial_config, read under
//                 the same transaction. NOTHING is taken from the caller.
//   MANUAL_GRANT  the deliberate override (support, testing, promotions).
//                 It may name its own limits, which is exactly why those
//                 limits are validated before they get here.
//   FREE          undoing a grant. Returns the quiniela to the live FREE
//                 numbers rather than deleting its history.
//
// The tournament binding is CARRIED OVER, never reset. Dropping it while
// granting would hand out a fresh, unbound quiniela on every grant — which
// is the "one purchase, many tournaments" hole evaluateCompetitionBinding
// exists to prevent.
function applyEntitlementGrant({ index, paymentLog, entitlement, slug, grantId, grantedBy, reason, now }) {
  const entry = findEntry(index, slug);
  if (!entry) return { ok: false, error: "not_found" };
  if (!entitlement || typeof entitlement !== "object") return { ok: false, error: "invalid_grant" };

  // Idempotency is keyed on the grant id recorded in this quiniela's OWN
  // history. A retried request (lost response, double click, two tabs)
  // therefore lands as a no-op that writes nothing at all — not even a
  // version bump — instead of stacking a second identical grant and a second
  // payment record on top of the first.
  const history = Array.isArray(entry.entitlementHistory) ? entry.entitlementHistory : [];
  if (grantId != null && history.some((h) => h && h.grantId != null && h.grantId === grantId)) {
    return { ok: true, index: null, paymentLog: null, applied: false, recorded: false };
  }

  const at = now || new Date().toISOString();
  const granted = { ...entitlement };
  // Carried over from the CURRENT stored entitlement, under lock — not from
  // anything the caller sent.
  const currentIdentity = entry.entitlement && entry.entitlement.competitionIdentity;
  if (currentIdentity && !granted.competitionIdentity) granted.competitionIdentity = currentIdentity;

  const nextIndex = JSON.parse(JSON.stringify(index));
  const nextEntry = findEntry(nextIndex, slug);
  nextEntry.entitlement = granted;
  nextEntry.entitlementHistory = Array.isArray(nextEntry.entitlementHistory) ? nextEntry.entitlementHistory : [];
  nextEntry.entitlementHistory.push({
    action: "grant", at, grantId: grantId != null ? grantId : null,
    grantedBy: grantedBy || granted.grantedBy || null,
    reason: reason || granted.reason || null,
    entitlement: granted,
  });
  const stampedIndex = stampVersion(nextIndex, readStoredVersion(index));

  // Money is recorded only for a PLUS grant, and only for the amount that
  // was actually snapshotted onto the entitlement — never a price the caller
  // sent, and never the legacy "price x participants" arithmetic.
  if (granted.plan !== "PLUS" || !Number.isFinite(granted.pricePaidMXN)) {
    return { ok: true, index: stampedIndex, paymentLog: null, applied: true, recorded: false };
  }
  const log = paymentLog && typeof paymentLog === "object" ? paymentLog : { payments: [] };
  const payments = Array.isArray(log.payments) ? log.payments.slice() : [];
  payments.push({
    id: grantId, slug: entry.slug, name: entry.name || "",
    amount: granted.pricePaidMXN, plan: "PLUS", date: at,
  });
  return { ok: true, index: stampedIndex, paymentLog: { ...log, payments }, applied: true, recorded: true };
}

// Renaming / re-securing a quiniela: meta and platform_index change together
// or not at all. The owner password arrives already hashed —
// hashing is server.js's job, this stays pure.
function applyQuinielaSettings({ index, meta, slug, name, hashedOwnerPassword }) {
  const entry = findEntry(index, slug);
  if (!entry || !meta || typeof meta !== "object") return { ok: false, error: "not_found" };

  const nextIndex = JSON.parse(JSON.stringify(index));
  const nextEntry = findEntry(nextIndex, slug);
  const nextMeta = JSON.parse(JSON.stringify(meta));

  if (name != null) {
    // Written to BOTH rows in the same operation, which is what keeps the
    // name from diverging between the registry and the quiniela itself.
    nextMeta.groupName = name;
    nextEntry.name = name;
  }
  if (hashedOwnerPassword != null) {
    if (!nextMeta.settings) nextMeta.settings = {};
    nextMeta.settings.ownerPassword = hashedOwnerPassword;
  }
  return { ok: true, index: stampVersion(nextIndex, readStoredVersion(index)), meta: nextMeta };
}

module.exports = {
  readStoredVersion,
  readExpectedVersion,
  isFreshWrite,
  stampVersion,
  mergePlatformIndex,
  applyEntitlementGrant,
  applyQuinielaSettings,
  ADMIN_EDITABLE_INDEX_FIELDS,
  SERVER_OWNED_INDEX_FIELDS,
};
