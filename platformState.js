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
// The purchase history for one scope: the PLUS entitlement this quiniela was
// actually sold for that tournament, or null.
//
// A revoke appends a FREE entry but never removes the PLUS one, and a
// MANUAL_GRANT in between does not either — which is the point: the history is
// append-only, so "was this scope ever bought" survives anything an operator
// does to the CURRENT entitlement.
//
// `purchase: true` is stamped on entries this module records a payment for.
// The pricePaidMXN fallback is for rows written before that marker existed;
// both mean the same thing, and a PLUS entitlement carrying a price it was
// sold at is exactly what a purchase is.
function findPurchaseForScope(history, scope) {
  const entries = Array.isArray(history) ? history : [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const h = entries[i];
    const ent = h && h.entitlement;
    if (!ent || ent.plan !== "PLUS") continue;
    if (!(h.purchase === true || Number.isFinite(ent.pricePaidMXN))) continue;
    if ((ent.competitionIdentity || null) !== (scope || null)) continue;
    return ent;
  }
  return null;
}

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
    return { ok: true, index: null, paymentLog: null, applied: false, recorded: false, reason: "replayed_grant_id" };
  }

  const at = now || new Date().toISOString();
  const granted = { ...entitlement };
  // Carried over from the CURRENT stored entitlement, under lock — not from
  // anything the caller sent.
  const currentIdentity = entry.entitlement && entry.entitlement.competitionIdentity;
  if (currentIdentity && !granted.competitionIdentity) granted.competitionIdentity = currentIdentity;

  // ---- one purchase per quiniela per tournament (MON-002B QA fix) --------
  //
  // Keying idempotency on the grant id ALONE was wrong, and wrong in exactly
  // the way MON-001F.3 had already found for the old payment toggle: an id is
  // a token the browser makes up, and two dashboard tabs each make up their
  // own. Two operators — or one operator with two tabs — both looking at a
  // FREE quiniela and both clicking "Activar Plus" produced TWO grants and
  // TWO payment records for ONE purchase. The lock serialised them; it did
  // not make the second one wrong under the rule as written.
  //
  // The source of truth is the TRANSITION, read from the locked row, not the
  // token:
  //
  //   FREE (or any non-PLUS) -> PLUS, this scope    a real purchase: one
  //                                                 grant, one payment
  //   PLUS -> PLUS, same scope                      no-op: already bought.
  //                                                 No re-snapshot, so a
  //                                                 later price change can
  //                                                 never rewrite what was
  //                                                 paid for, and no second
  //                                                 charge
  //   FREE -> FREE                                  no-op: nothing to undo
  //
  // "Same scope" is the tournament the entitlement is bound to. Today a
  // grant always carries the current binding over, so the scope is identical
  // by construction and PLUS -> PLUS is always a no-op. RENEWAL — buying the
  // next tournament — is deliberately NOT invented here: it is MON-002C's,
  // and this comparison is written out in full so that ticket has the right
  // shape to change rather than a hidden assumption to discover.
  //
  const currentPlan = entry.entitlement && !entry.entitlement.revoked ? entry.entitlement.plan : null;
  const scope = granted.competitionIdentity || null;
  const sameScope = (currentIdentity || null) === scope;
  if (currentPlan === granted.plan && sameScope && granted.plan !== "MANUAL_GRANT") {
    // MANUAL_GRANT is excluded on purpose: re-issuing one is how an operator
    // ADJUSTS the numbers on an override, and it never records money, so it
    // cannot reintroduce a double charge.
    return { ok: true, index: null, paymentLog: null, applied: false, recorded: false, reason: "already_on_plan" };
  }

  // ---- a revoke does not un-buy the tournament (MON-002B QA fix 2) -------
  //
  // The rule above reads only the CURRENT entitlement, and that left one way
  // back to charging twice for the same tournament:
  //
  //   FREE -> PLUS     a purchase, recorded
  //   PLUS -> FREE     an administrative revoke
  //   FREE -> PLUS     ...which looks like a fresh purchase, and charged again
  //
  // The first version of this called that "a deliberate re-sale". It is not:
  // Plus is one payment per quiniela per tournament, and an operator undoing
  // a mistake does not erase the economic fact that this scope was already
  // paid for. Refunds, credits and renewal are MON-003's and MON-002C's, and
  // none of them exist yet to justify a second charge.
  //
  // So the PURCHASE HISTORY takes part in the decision, not just the current
  // entitlement. Granting PLUS to a scope that has already been bought is a
  // REACTIVATION: the coverage that was purchased is restored exactly as it
  // was sold — the original snapshot, with its original numbers and its
  // original price — and NO new payment is recorded.
  //
  // Restoring rather than refusing is the simpler and kinder of the two
  // options: an operator who revoked by accident wants the coverage back,
  // and there is no other action in the product that would give it to them.
  // Rebuilding the entitlement from today's config instead of restoring the
  // stored one would also let a price or limit change between the revoke and
  // the reactivation quietly alter what someone already paid for.
  //
  // A genuinely NEW tournament is not assumed here: it would be a different
  // scope, findPurchaseForScope would find nothing, and it would be a real
  // purchase. Which identity counts as a new tournament is MON-002C's to
  // decide — this only has to ask the question in the right shape.
  if (granted.plan === "PLUS") {
    const purchase = findPurchaseForScope(history, scope);
    if (purchase) {
      const restored = { ...purchase, revoked: false };
      const nextIdx = JSON.parse(JSON.stringify(index));
      const nextEnt = findEntry(nextIdx, slug);
      nextEnt.entitlement = restored;
      nextEnt.entitlementHistory = Array.isArray(nextEnt.entitlementHistory) ? nextEnt.entitlementHistory : [];
      nextEnt.entitlementHistory.push({
        action: "reactivate", at, grantId: grantId != null ? grantId : null,
        grantedBy: grantedBy || "platform",
        reason: reason || "Se restauró la cobertura Plus ya pagada para este torneo.",
        entitlement: restored,
      });
      return {
        ok: true, index: stampVersion(nextIdx, readStoredVersion(index)), paymentLog: null,
        applied: true, recorded: false, reason: "reactivated_existing_purchase",
      };
    }
  }

  const nextIndex = JSON.parse(JSON.stringify(index));
  const nextEntry = findEntry(nextIndex, slug);
  nextEntry.entitlement = granted;
  nextEntry.entitlementHistory = Array.isArray(nextEntry.entitlementHistory) ? nextEntry.entitlementHistory : [];
  // Named so an auditor can read the sequence without inferring it from the
  // entitlement's own fields.
  const isRevoke = granted.plan === "FREE" && granted.source === "platform_revoke";
  const willRecordPayment = granted.plan === "PLUS" && Number.isFinite(granted.pricePaidMXN);
  nextEntry.entitlementHistory.push({
    action: isRevoke ? "revoke" : "grant", at, grantId: grantId != null ? grantId : null,
    grantedBy: grantedBy || granted.grantedBy || null,
    reason: reason || granted.reason || null,
    purchase: willRecordPayment,
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
  // The transition rule above already stops one quiniela being charged twice.
  // This is the other half, kept from MON-001F.3: an id REUSED ACROSS
  // quinielas would put two different payments in the log under the same id,
  // which is not a double charge but does destroy the log's ability to
  // identify a payment. Refused rather than half-applied, so a plan can never
  // land without a record of its own.
  if (payments.some((p) => p && p.id != null && p.id === grantId)) {
    return { ok: false, error: "grant_id_conflict" };
  }
  payments.push({
    id: grantId, slug: entry.slug, name: entry.name || "",
    amount: granted.pricePaidMXN, plan: "PLUS", date: at,
    // Which tournament this bought, so the log can be audited on its own
    // without joining back to the index.
    competitionIdentity: granted.competitionIdentity || null,
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
  findPurchaseForScope,
  applyQuinielaSettings,
  ADMIN_EDITABLE_INDEX_FIELDS,
  SERVER_OWNED_INDEX_FIELDS,
};
