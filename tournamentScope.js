// tournamentScope.js — MON-002C: the identity of the tournament a quiniela is
// commercially playing, and the lifecycle of that tournament.
//
// WHAT THIS FIXES
// ---------------
// MON-002B made a Plus purchase belong to a "scope", and that scope was
// `leagueId:season` — the string computeCompetitionIdentity() produces. For
// most competitions that is fine: Premier 2026-2027 and 2027-2028 are two
// different strings, so they are two different purchases.
//
// For a split-format league they are the SAME string. Reproduced against the
// shipped code before this ticket:
//
//   Liga MX Apertura 2026  ->  "4350:2026-2027"
//   Liga MX Clausura 2027  ->  "4350:2026-2027"      <- identical
//
// So one Plus purchase covered two commercially distinct tournaments, and no
// amount of care in the payment logic could have caught it: the two editions
// were indistinguishable to everything downstream.
//
// THE MISSING DATUM, STATED PLAINLY
// ---------------------------------
// The provider actually wired into the import path is TheSportsDB, and it
// declares NONE of the five capabilities in providerContract.js — in
// particular:
//
//   MULTI_INSTANCE_SEASONS   can two tournaments live in one provider season,
//                            distinguishably?          -> NO
//   FINISHED_SIGNAL          can it say a season/stage is finished?  -> NO
//
// That is not an oversight in the adapter; DATA-003 established it and the
// adapter says so out loud rather than papering over it with date heuristics.
// Sportmonks declares all five, but it is not connected to the import path.
//
// So the honest conclusion for MON-002C: **today's data cannot tell one
// edition from the next, and cannot tell us a tournament ended.** The reply to
// that is not a cleverer guess. Parsing "Apertura" out of a competition name,
// or deciding a tournament is over because the calendar ran out or a date
// passed, would each be a rule that fails silently and charges — or fails to
// charge — for reasons nobody can audit.
//
// WHAT REPLACES THE GUESS
// -----------------------
// An INTERNAL scope identity, and an explicit product event that moves it.
//
//   ts:1:<sport>:<provider>:<competitionId>:e<editionSeq>    with a competition
//   ts:1:manual:e<editionSeq>                                without one
//
// `editionSeq` is a monotonic counter the SERVER keeps per quiniela. It starts
// at 1 and advances only when an Admin explicitly starts a new tournament.
// That single fact carries the whole design:
//
//   - it is deterministic and stable: the same inputs always give the same id;
//   - it is persisted and auditable: every cycle is recorded, with when it
//     started, what it was called, and how it ended;
//   - it cannot be forged: a browser never supplies it, the server computes it;
//   - it is independent of copy, price, plan and grant id — renaming a
//     competition, changing its price, or granting a plan never moves it;
//   - and it does not depend on any provider field, so a provider that cannot
//     distinguish editions cannot cause two editions to share coverage,
//     because the boundary is drawn by the person who knows.
//
// The provider is still asked, and recorded (providerRefs), so a provider that
// CAN distinguish editions has somewhere to say so — but nothing commercial
// reads those fields directly. That separation is the point of the layering:
// Provider Adapter -> Normalizer -> Sports Domain -> Tournament Scope ->
// product -> monetisation.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// It does not detect that Apertura ended and Clausura began. It cannot, with
// today's data, and it does not pretend to. What it guarantees instead is the
// property that actually protects both sides: **a new edition is always a new
// scope, and a purchase never leaves its scope.** The remaining gap — an Admin
// who plays a second tournament without starting a new cycle — is a provider
// capability question (MULTI_INSTANCE_SEASONS), documented here and in the
// deliverable, not something to fake.

const SCOPE_VERSION = 1;

// The three states a cycle can be in. UNKNOWN is a real answer, not a
// placeholder: with a provider that has no finished signal it is the only
// truthful one, and it must never be read as "still running, so anything
// goes" NOR as "over, so charge again".
const LIFECYCLE = Object.freeze({
  ACTIVE: "ACTIVE",
  ENDED: "ENDED",
  UNKNOWN: "UNKNOWN",
});
const LIFECYCLE_VALUES = Object.freeze(Object.values(LIFECYCLE));

// Reasons a cycle may be marked ENDED. Both are EVIDENCE, never inference:
// somebody said so, or a provider that can answer the question answered it.
const ENDED_REASONS = Object.freeze({
  ADMIN_STARTED_NEW_CYCLE: "admin_started_new_cycle",
  PROVIDER_FINISHED_SIGNAL: "provider_finished_signal",
});

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

// Only characters that keep the id readable in a log and safe in a key. A
// component that cannot be represented is rejected rather than mangled: a
// silently-transformed id would be a different scope, which is the one thing
// this must never produce by accident.
function sanitizeComponent(value) {
  if (!isNonEmptyString(value)) return null;
  const cleaned = String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? null : cleaned.slice(0, 64);
}

// The id, and nothing but the id. Display names are NOT an input: a
// competition that gets renamed must keep the same scope, and two
// competitions that happen to share a name must not collide.
function makeScopeId({ sportKey, provider, competitionId, editionSeq }) {
  if (!Number.isSafeInteger(editionSeq) || editionSeq < 1) return null;
  const hasCompetition = isNonEmptyString(provider) && (competitionId != null && String(competitionId).trim() !== "");
  if (!hasCompetition) return `ts:${SCOPE_VERSION}:manual:e${editionSeq}`;
  const sport = sanitizeComponent(sportKey) || "football";
  const prov = sanitizeComponent(provider);
  const comp = sanitizeComponent(String(competitionId));
  if (!prov || !comp) return null;
  return `ts:${SCOPE_VERSION}:${sport}:${prov}:${comp}:e${editionSeq}`;
}

function isUsableScopeId(value) {
  return typeof value === "string" && /^ts:\d+:[a-z0-9._-]+(:[a-z0-9._-]+:[a-z0-9._-]+)?:e[1-9]\d*$/.test(value);
}

// A scope is an id plus METADATA THAT IS NEVER PART OF THE ID. Everything in
// `meta` can change — a league can be renamed, a season string corrected, a
// provider reference added — without the scope becoming a different scope,
// which is exactly what a stable commercial identity has to guarantee.
function buildScope({
  sportKey, provider, competitionId, editionSeq,
  displayName, providerSeasonId, providerInstanceKey, startedAt,
}) {
  const id = makeScopeId({ sportKey, provider, competitionId, editionSeq });
  if (!id) return null;
  return {
    id,
    editionSeq,
    sportKey: sanitizeComponent(sportKey) || "football",
    // Metadata. Read by screens and by humans reading the audit trail; never
    // read by the code that decides whether to charge.
    displayName: isNonEmptyString(displayName) ? String(displayName).trim().slice(0, 120) : null,
    providerRefs: {
      provider: isNonEmptyString(provider) ? provider : null,
      competitionId: competitionId != null && String(competitionId).trim() !== "" ? String(competitionId) : null,
      seasonId: isNonEmptyString(providerSeasonId) ? providerSeasonId : null,
      // Where a provider that CAN distinguish editions would say which one
      // this is. Nothing reads it for money today; it is recorded so that
      // wiring such a provider later is a change of one function, not an
      // archaeology exercise.
      instanceKey: isNonEmptyString(providerInstanceKey) ? providerInstanceKey : null,
    },
    startedAt: isNonEmptyString(startedAt) ? startedAt : new Date().toISOString(),
    lifecycle: LIFECYCLE.ACTIVE,
    endedAt: null,
    endedReason: null,
  };
}

// The first cycle of a quiniela. Separate from buildScope only to name the
// intent at the call sites, and to keep editionSeq's origin in one place.
function buildInitialScope(opts) {
  return buildScope({ ...opts, editionSeq: 1 });
}

// The next cycle. The sequence is taken from the STORED scope, never from
// input, so a caller cannot skip ahead, reuse a number, or land on a scope
// that already has a purchase attached to it.
//
// A stored scope whose sequence is unreadable produces NOTHING, deliberately.
// The tempting fallback — start again at 1 — would hand the quiniela a scope
// id that a previous purchase is already stamped for, i.e. free coverage
// conjured out of a corrupted row. The caller fails the request instead.
function buildNextScope(currentScope, opts) {
  const seq = currentScope && Number.isSafeInteger(currentScope.editionSeq) && currentScope.editionSeq >= 1
    ? currentScope.editionSeq + 1
    : null;
  if (seq === null) return null;
  return buildScope({ ...opts, editionSeq: seq });
}

function scopeIdOf(scope) {
  return scope && isUsableScopeId(scope.id) ? scope.id : null;
}

function isSameScope(a, b) {
  const ida = typeof a === "string" ? a : scopeIdOf(a);
  const idb = typeof b === "string" ? b : scopeIdOf(b);
  return ida != null && ida === idb;
}

// ---- lifecycle -----------------------------------------------------------
//
// The list of things that must NEVER end a tournament is as important as the
// two that may, so it is written into the code rather than left to memory:
//
//   - the imported rounds ran out            (providers return partial
//                                             calendars all the time)
//   - the provider returned few events       (same)
//   - a hardcoded number of rounds was hit   (competitions differ, and this
//                                             is a commercial cliff nobody
//                                             can audit)
//   - an estimated end date passed           (a guess with money attached)
//
// Only evidence ends a cycle.

function readLifecycle(scope) {
  const v = scope && scope.lifecycle;
  return LIFECYCLE_VALUES.includes(v) ? v : LIFECYCLE.UNKNOWN;
}

// What a cycle's state should be, given what we actually know. Called with
// the provider's own answer ONLY when the provider declares it can answer;
// `providerFinished` is deliberately tri-state: true / false / null, and null
// is not false.
function resolveLifecycle(scope, { providerCanSignalFinish = false, providerFinished = null } = {}) {
  const current = readLifecycle(scope);
  // An ended cycle stays ended. Nothing un-ends a tournament: the way forward
  // is a new cycle, not a resurrection of the old one.
  if (current === LIFECYCLE.ENDED) return LIFECYCLE.ENDED;
  if (providerCanSignalFinish && providerFinished === true) return LIFECYCLE.ENDED;
  if (providerCanSignalFinish && providerFinished === false) return LIFECYCLE.ACTIVE;
  // No provider answer available. ACTIVE if it was ACTIVE — a cycle somebody
  // started is running until there is evidence otherwise — and UNKNOWN when
  // we genuinely do not know, which is what a provider with no finished
  // signal leaves us with for a cycle we did not start ourselves.
  return current === LIFECYCLE.ACTIVE ? LIFECYCLE.ACTIVE : LIFECYCLE.UNKNOWN;
}

function endScope(scope, reason, at) {
  if (!scope) return scope;
  const known = Object.values(ENDED_REASONS).includes(reason) ? reason : null;
  if (!known) return scope; // never end a cycle for a reason we do not recognise
  return {
    ...scope,
    lifecycle: LIFECYCLE.ENDED,
    endedAt: isNonEmptyString(at) ? at : new Date().toISOString(),
    endedReason: known,
  };
}

// ---- per-cycle consumption ----------------------------------------------
//
// A round belongs to the cycle that first published it, forever. That single
// rule gives all four behaviours the ticket asks for:
//
//   - rounds from an old tournament do not spend the new tournament's budget
//   - old results stay visible and untouched
//   - editing or re-publishing an old round costs nothing
//   - a genuinely new round does cost the current cycle
//
// The map is server-owned and append-only. It is keyed by scope id, so it
// survives any number of cycles without the ids of one bleeding into another.

function readConsumedByScope(entry) {
  const raw = entry && entry.consumedRoundIdsByScope;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  Object.keys(raw).forEach((key) => {
    if (Array.isArray(raw[key])) out[key] = raw[key].filter((id) => id != null).map(String);
  });
  return out;
}

// Every round id this quiniela has EVER published, across every cycle.
function allConsumedRoundIds(entry) {
  const byScope = readConsumedByScope(entry);
  const all = new Set();
  Object.keys(byScope).forEach((k) => byScope[k].forEach((id) => all.add(id)));
  return all;
}

// How much of the CURRENT cycle's budget is spent.
function consumedInScope(entry, scopeId) {
  const byScope = readConsumedByScope(entry);
  return Array.isArray(byScope[scopeId]) ? byScope[scopeId].length : 0;
}

// Which of the round ids in this write actually cost the current cycle.
//
// "Already consumed once, therefore free forever" is NOT the rule, and the
// difference is a real bypass that was reproduced against a live server before
// this was written: after starting a new tournament and clearing the board,
// an owner could publish a whole new calendar under the OLD cycle's round ids
// — meta.rounds is owner-written, so the ids are theirs to choose — and pay
// for none of it. Seven free rounds, deliberately obtainable.
//
// What makes an old id free is not the id, it is that the ROUND IS STILL
// THERE: editing or re-publishing a round the stored row already holds costs
// nothing. An id that names a round the stored row does NOT hold is a new
// publication whatever it is called, and it costs the cycle being played.
//
// `existingRoundIds` must come from the STORED row read under lock, never from
// the incoming document — the incoming one is exactly what an attacker writes.
//
//   edit a round that is there              -> free (consumed in this cycle)
//   delete then re-add it in the same cycle -> free (no double charge; the
//                                              budget is never refunded either)
//   a genuinely new round                   -> costs this cycle
//   an old cycle's round, still there       -> free, and it does not spend
//                                              this cycle's budget
//   an old cycle's ID on a round that is
//   gone from the stored row                -> costs this cycle
function newlyConsumedIds(entry, roundIds, opts) {
  const options = opts || {};
  const currentScopeId = options.currentScopeId;
  const byScope = readConsumedByScope(entry);
  const consumedHere = new Set(Array.isArray(byScope[currentScopeId]) ? byScope[currentScopeId] : []);
  const consumedEver = allConsumedRoundIds(entry);
  const stillStored = new Set(
    (Array.isArray(options.existingRoundIds) ? options.existingRoundIds : [])
      .filter((id) => id != null).map(String)
  );
  const out = [];
  const claimed = new Set();
  (Array.isArray(roundIds) ? roundIds : []).forEach((id) => {
    if (id == null) return;
    const key = String(id);
    if (claimed.has(key)) return; // a payload repeating an id counts once
    claimed.add(key);
    if (consumedHere.has(key)) return;
    if (consumedEver.has(key) && stillStored.has(key)) return;
    out.push(key);
  });
  return out;
}

// Returns the updated map; never mutates the input.
function recordConsumption(entry, scopeId, ids) {
  const byScope = readConsumedByScope(entry);
  const existing = Array.isArray(byScope[scopeId]) ? byScope[scopeId] : [];
  const merged = existing.slice();
  const seen = new Set(existing);
  (Array.isArray(ids) ? ids : []).forEach((id) => {
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(key);
  });
  return { ...byScope, [scopeId]: merged };
}

module.exports = {
  SCOPE_VERSION,
  LIFECYCLE,
  LIFECYCLE_VALUES,
  ENDED_REASONS,
  makeScopeId,
  isUsableScopeId,
  buildScope,
  buildInitialScope,
  buildNextScope,
  scopeIdOf,
  isSameScope,
  readLifecycle,
  resolveLifecycle,
  endScope,
  readConsumedByScope,
  allConsumedRoundIds,
  consumedInScope,
  newlyConsumedIds,
  recordConsumption,
};
