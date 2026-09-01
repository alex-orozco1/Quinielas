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
const ADMIN_EDITABLE_INDEX_FIELDS = Object.freeze(["name", "paid", "exempt", "customJornadaLimit"]);

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

module.exports = {
  readStoredVersion,
  readExpectedVersion,
  isFreshWrite,
  stampVersion,
  mergePlatformIndex,
  ADMIN_EDITABLE_INDEX_FIELDS,
  SERVER_OWNED_INDEX_FIELDS,
};
