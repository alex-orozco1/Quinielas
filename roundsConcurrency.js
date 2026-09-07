// roundsConcurrency.js — HOTFIX-001: who is allowed to replace meta.rounds.
//
// THE BUG THIS EXISTS FOR
// -----------------------
// A quiniela's board lives in meta.rounds, and the generic meta save takes
// that array from the REQUEST, whole. Reproduced against a live PostgreSQL 16:
//
//   1. Tab A loads the quiniela.
//   2. Tab B publishes a jornada.
//   3. Tab A saves anything at all — a renamed group, a changed setting.
//   4. The server answers 200 OK.
//   5. B's jornada is gone, and nothing in the response says so.
//
// It is not a Liguilla problem and it is not a sync problem: it is the whole
// class of lost updates on a field that is replaced wholesale by a writer that
// may be arbitrarily far behind. The same shape destroys a manually created
// round, reverts a deadline or a published result, and — because publishing is
// what consumes commercial budget — leaves plan.rounds.used charged for a
// jornada that no longer exists.
//
// WHY tournamentEpoch DID NOT ALREADY COVER IT
// --------------------------------------------
// MON-002C added exactly the right defence, anchored to the wrong event. The
// epoch counts CLOSES, so `rounds` is protected only across the boundary
// between two tournaments. Every edit that matters happens INSIDE one
// tournament, where the epoch is constant and the guard never fires. The epoch
// stays — it answers "this board was archived", which is a different question —
// and this module answers "this board has moved on since you read it".
//
// WHY NOT A COPY OF participantsRevision
// --------------------------------------
// Participants have two levels (membership, then per-participant fields)
// because the two change for different reasons and a results save must not
// invalidate a tab that is only behind on somebody's PIN. Rounds have no such
// split: the browser sends ONE array and the server either keeps what it has or
// takes what it was handed. So the comparison here is on CONTENT, not on the
// set of ids — reverting a deadline is a lost update just as surely as deleting
// the round is, and an id-set rule would wave it straight through.
//
// THE RULE, IN ONE LINE
// ---------------------
// A write may replace the board only if it can show it saw the board it is
// replacing. Anything else keeps the stored board and says so out loud.

// Stable across key ORDER: the stored row comes back from Postgres jsonb
// (which normalises order) while the browser's echo does not necessarily
// preserve it, so a raw JSON.stringify would report changes that are not
// changes — and a false "changed" here would turn an ordinary retry into a
// conflict. Deliberately a local copy of the same four lines in
// metaParticipants.js rather than a shared import: these two modules answer
// unrelated questions and neither should be able to break the other.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) || "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

// A doc that never had a revision is at 0 — a legacy row written before this
// ticket, or a brand new one. Anything unreadable is also 0: for the STORED
// side that is the safe direction, because it makes an incoming claim have to
// match 0 exactly rather than letting garbage pass as agreement.
function storedRoundsRevision(doc) {
  const v = doc && doc.roundsRevision;
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

// The INCOMING side is different, and the difference is the point: "I did not
// say" and "I said 0" are not the same claim, so absence must survive as null
// rather than collapsing into a number that could accidentally match. A
// negative, fractional, non-numeric or unsafely large value is not a claim
// either — it is noise, and noise never counts as having seen anything.
function claimedRoundsRevision(doc) {
  const v = doc && doc.roundsRevision;
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// A row written by any version of the server that has this module ALWAYS
// carries the field (stampRoundsRevision runs on every meta write, and the
// merge deletes whatever the client sent before it does). So a stored row with
// no `roundsRevision` at all can only be one thing: a document last written
// before this ticket shipped. It has no revision for anyone to have seen, which
// would otherwise deadlock its Admin — every edit refused, and a reload unable
// to supply the number that would make the next one succeed.
//
// Such a row therefore ADOPTS the first board it is handed and is stamped on
// the way out, after which it is an ordinary protected row forever. The window
// is one write per pre-existing quiniela, and the boot backfill in server.js
// closes even that for data that already exists.
function hasStoredRoundsRevision(doc) {
  return !!doc && typeof doc === "object" && Object.prototype.hasOwnProperty.call(doc, "roundsRevision");
}

// Only an ARRAY is a statement about the board. A payload with no `rounds` at
// all, or with `rounds: null`, is not claiming an empty board — it is not
// claiming anything, and treating it as an empty board is how a save that
// merely forgot the field wipes a whole tournament. (Reproduced: before this
// ticket, a meta POST omitting `rounds` stored a document with no board and
// set roundCount to 0.)
function statesRounds(doc) {
  return Array.isArray(doc && doc.rounds);
}

// Everything in a round counts, including order. A reorder is a real change to
// what the Admin sees, and a signature that ignored it would let one tab
// silently undo another tab's reordering. No field is excluded: `results`,
// `draftResults`, `published`, `deadline` and the provider's own bookkeeping
// are all state somebody can lose.
function roundsSignature(rounds) {
  return canonical(Array.isArray(rounds) ? rounds : []);
}

function sameRounds(a, b) {
  return roundsSignature(a) === roundsSignature(b);
}

// States that cannot be produced by any product flow and that quietly corrupt
// everything downstream if stored: scoring indexes rounds by id, picks are
// nested by round id and then by match id, and commercial consumption is
// keyed on round id. Two rounds sharing an id make all three ambiguous. This
// is refused rather than de-duplicated — guessing which of the two the writer
// meant is exactly the kind of silent repair this ticket exists to remove.
function validateRoundIdentity(rounds) {
  if (!Array.isArray(rounds)) return { ok: true };
  const seenRounds = new Set();
  for (const round of rounds) {
    if (!round || typeof round !== "object" || Array.isArray(round)) {
      return { ok: false, reason: "malformed_round" };
    }
    if (round.id == null || String(round.id).trim() === "") {
      return { ok: false, reason: "missing_round_id", roundNumber: round.number };
    }
    const roundId = String(round.id);
    if (seenRounds.has(roundId)) {
      return { ok: false, reason: "duplicate_round_id", roundId, roundNumber: round.number };
    }
    seenRounds.add(roundId);
    // A round with no matches yet is perfectly legal (one being drafted), so
    // only the LIST's contents are checked, never its length.
    const matches = Array.isArray(round.matches) ? round.matches : [];
    const seenMatches = new Set();
    for (const match of matches) {
      if (!match || typeof match !== "object" || Array.isArray(match)) {
        return { ok: false, reason: "malformed_match", roundId, roundNumber: round.number };
      }
      if (match.id == null || String(match.id).trim() === "") {
        return { ok: false, reason: "missing_match_id", roundId, roundNumber: round.number };
      }
      const matchId = String(match.id);
      // Match ids only have to be unique WITHIN their round: picks are stored
      // as { [roundId]: { [matchId]: "A"|"D"|"B" } }, so the same id under two
      // different rounds is unambiguous and does happen.
      if (seenMatches.has(matchId)) {
        return { ok: false, reason: "duplicate_match_id", roundId, matchId, roundNumber: round.number };
      }
      seenMatches.add(matchId);
    }
  }
  return { ok: true };
}

// The whole decision, in one pure function, so every write path reaches the
// same verdict from the same inputs and none of them can invent its own rule.
//
// `stored` is the row read UNDER LOCK by the caller. `incoming` is the request
// body. The returned `rounds` is what must be persisted — callers never take
// incoming.rounds directly, which is the mistake this replaces.
function resolveRoundsWrite({ stored, incoming } = {}) {
  const storedRounds = Array.isArray(stored && stored.rounds) ? stored.rounds : [];
  const storedRevision = storedRoundsRevision(stored);
  const claimedRevision = claimedRoundsRevision(incoming);
  const base = { storedRevision, claimedRevision, reason: null };

  // 1. The write says nothing about the board. Keep what is stored. This is
  //    not a conflict: nothing the writer asked for is being dropped.
  if (!statesRounds(incoming)) {
    return { ...base, outcome: "no_statement", ok: true, rounds: storedRounds };
  }

  // 2. An impossible board is refused whatever the revision says. Freshness
  //    cannot make a duplicate id safe.
  const identity = validateRoundIdentity(incoming.rounds);
  if (!identity.ok) {
    return { ...base, outcome: "invalid", ok: false, rounds: storedRounds, ...identity };
  }

  // 3. The same board. Nothing can be lost, so the revision is not consulted
  //    at all — and this is what makes a RETRY safe: a request replayed after
  //    a lost response carries a revision that is now behind, but proposes
  //    exactly the board that is already stored. It is applied as the no-op it
  //    is, the revision does not move, and nothing is consumed twice.
  //    The STORED array is returned, not the incoming one: they are equal by
  //    content, and keeping the server's own copy means a client's key order
  //    can never rewrite the row for no reason.
  if (sameRounds(incoming.rounds, storedRounds)) {
    return { ...base, outcome: "unchanged", ok: true, rounds: storedRounds };
  }

  // 4. A different board is a REPLACEMENT of everything currently stored, and
  //    only a writer that demonstrably saw what it is replacing may make one.
  //    Not stating a revision is not agreement. Claiming a revision the server
  //    has never issued (higher than stored) is not agreement either — it is
  //    an impossible claim, and it fails closed with the rest.
  //    The one exception is a row that has never been stamped at all (see
  //    hasStoredRoundsRevision): there is no revision to have seen, so refusing
  //    would lock its Admin out of their own board with no way back.
  const sawCurrentBoard = claimedRevision !== null && claimedRevision === storedRevision;
  if (!sawCurrentBoard) {
    if (!hasStoredRoundsRevision(stored)) {
      return { ...base, outcome: "adopted", ok: true, rounds: incoming.rounds };
    }
    return { ...base, outcome: "conflict", ok: false, rounds: storedRounds, reason: "rounds_conflict" };
  }

  return { ...base, outcome: "applied", ok: true, rounds: incoming.rounds };
}

// The stored revision is computed HERE and only here, from the stored row —
// exactly like participantsRevision, and for the same reason: an incoming
// revision is a claim about what a writer saw, never a value it gets to set.
//
// It advances only when the board actually changed, so the saves that dominate
// real use (a setting, a PIN, somebody's bet answer) leave every other open tab
// valid instead of invalidating it for nothing.
function stampRoundsRevision(doc, oldValue) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  const previous = storedRoundsRevision(oldValue);
  const changed = !sameRounds(oldValue && oldValue.rounds, doc.rounds);
  return { ...doc, roundsRevision: changed ? previous + 1 : previous };
}

module.exports = {
  canonical,
  hasStoredRoundsRevision,
  storedRoundsRevision,
  claimedRoundsRevision,
  statesRounds,
  roundsSignature,
  sameRounds,
  validateRoundIdentity,
  resolveRoundsWrite,
  stampRoundsRevision,
};
