// betsConcurrency.js — MS2 · who is allowed to replace meta.customBets.
//
// THE BUG THIS EXISTS FOR (Technical QA, ronda 4; also in ff7bd12 and main)
// --------------------------------------------------------------------------
// The tournament and round questions live in meta.customBets, and the generic
// meta save took that array from the REQUEST, whole:
//
//   1. Admin A reaches «Publicar» in the setup; the password prompt opens.
//   2. Admin B adds a question from Admin → Tus reglas: 200.
//   3. A confirms the password and publishes: 200.
//   4. B's question is gone, and nothing in either response says so.
//
// The same shape loses any question edit to any stale save (a fee changed in a
// tab opened earlier, say). It is the lost update roundsConcurrency.js closes
// for the board, on a different field.
//
// THE RULE, IN ONE LINE
// ---------------------
// A write may replace the questions only if it can show it saw the questions it
// is replacing. Anything else is refused (409 bets_conflict) and writes nothing.
//
// Same protocol as the board, deliberately: a server-owned revision that moves
// only when the content changes, echoed back by the browser as a claim of what
// it saw, compared by CONTENT so a retry that proposes exactly what is stored
// is a no-op, and a row written before this existed adopts the first write
// (and is backfilled at boot, so that window is closed for existing data).

const { canonical } = require("./roundsConcurrency");

function storedBetsRevision(doc) {
  const v = doc && doc.betsRevision;
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

// Absence is not a claim of 0: "I did not say" never matches anything.
function claimedBetsRevision(doc) {
  const v = doc && doc.betsRevision;
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function hasStoredBetsRevision(doc) {
  return !!doc && typeof doc === "object" && Object.prototype.hasOwnProperty.call(doc, "betsRevision");
}

// Only an ARRAY is a statement about the questions. A save without
// `customBets` keeps the stored ones instead of wiping them.
function statesBets(doc) {
  return Array.isArray(doc && doc.customBets);
}

function sameBets(a, b) {
  return canonical(Array.isArray(a) ? a : []) === canonical(Array.isArray(b) ? b : []);
}

// `stored` is the row read UNDER LOCK; `incoming` is the request body.
function resolveBetsWrite({ stored, incoming } = {}) {
  const storedRevision = storedBetsRevision(stored);
  const claimedRevision = claimedBetsRevision(incoming);
  const base = { storedRevision, claimedRevision };
  if (!statesBets(incoming)) return { ...base, outcome: "no_statement", ok: true };
  if (sameBets(incoming.customBets, stored && stored.customBets)) return { ...base, outcome: "unchanged", ok: true };
  if (!hasStoredBetsRevision(stored)) return { ...base, outcome: "adopted", ok: true };
  if (claimedRevision === storedRevision) return { ...base, outcome: "replaced", ok: true };
  return { ...base, outcome: "conflict", ok: false };
}

// Never goes back. `doc` keeps the stored revision on every server-side write
// that starts from the stored row (an answer, a PIN, a registration…); the
// meta save removes the client's claim before stamping. Taking the larger of
// the two means a "before" copy that left the questions out can at worst move
// the revision forward (a tab is asked to reload), never back (a stale tab
// would pass as current and delete what it never saw).
function stampBetsRevision(doc, oldValue) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  const previous = Math.max(storedBetsRevision(oldValue), hasStoredBetsRevision(doc) ? storedBetsRevision(doc) : 0);
  const changed = !sameBets(oldValue && oldValue.customBets, doc.customBets);
  return { ...doc, betsRevision: changed ? previous + 1 : previous };
}

module.exports = {
  storedBetsRevision,
  claimedBetsRevision,
  hasStoredBetsRevision,
  statesBets,
  sameBets,
  resolveBetsWrite,
  stampBetsRevision,
};
