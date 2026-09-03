// metaParticipants.js — MON-002B: making a stale meta write unable to delete
// someone who registered while the Admin's tab was sitting open.
//
// THE BUG THIS EXISTS FOR
// -----------------------
// A quiniela's meta row is written as a whole document: the browser holds the
// meta it loaded, mutates it, and posts the entire thing back. MON-001F put
// that write inside a locked transaction, which stopped two writes from
// interleaving — but locking only decides WHO WRITES SECOND, not what the
// second write is allowed to contain. The participant list still arrived
// straight from the browser and replaced the stored one outright.
//
// Reproduced against a real Postgres before this fix:
//
//   T0  the Admin opens Participantes with 9 people on screen
//   T1  someone follows the invite link and self-registers -> the row is now 10
//   T2  the Admin adds one name and posts their T0 snapshot back, which has
//       9 + 1 = 10 entries
//   ->  the capacity check is `newCount > oldCount`, and 10 > 10 is false, so
//       it never runs; the write commits; the person from T1 is GONE, the
//       count still reads 10, and nobody is told anything
//
// The same shape deletes people on any save at all — flipping a "pagó"
// checkbox, renaming the group, publishing a round — because every one of
// those posts the whole document too.
//
// THE FIX
// -------
// The server stamps a `participantsRevision` on the meta every time the SET
// OF PARTICIPANT IDS changes, and the browser echoes back whatever revision
// it loaded (it already round-trips the whole document, so this costs the
// client nothing). That single number answers the question the merge actually
// needs: did this writer see the membership as it stands right now?
//
//   revision matches   the writer saw the current list, so a missing entry is
//                      a deliberate removal and is honoured
//   revision differs   the writer never saw the current list, so a missing
//                      entry is something they could not have known about —
//                      it is kept, never dropped
//
// Deletions from a stale writer are therefore ignored rather than applied,
// and the caller is told how many entries were restored so it can refresh
// instead of silently disagreeing with the server. Edits to participants the
// writer DID know about (renames, paid flags, PIN resets) always apply, stale
// or not — those are about a person the writer was genuinely looking at.
//
// Only the revision the SERVER computed is ever stored; the incoming one is
// read purely as a claim, exactly like MON-001F's platform version protocol.

// Absent/legacy metas count as revision 0, so the first write under this
// protocol is accepted from a client that has never seen one.
function readParticipantsRevision(doc) {
  const v = doc && doc.participantsRevision;
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

function idsOf(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((p) => {
    if (p && typeof p === "object" && !Array.isArray(p) && p.id != null) out.push(String(p.id));
  });
  return out;
}

function sameMembership(a, b) {
  const setA = new Set(idsOf(a));
  const setB = new Set(idsOf(b));
  if (setA.size !== setB.size) return false;
  for (const id of setA) if (!setB.has(id)) return false;
  return true;
}

// Produces the participant list that should actually be stored.
//
//   { participants, restored, removedByClient, sawCurrentMembership }
//
// `restored` counts entries the incoming document was missing and that were
// kept anyway because the writer was stale — the number the caller surfaces
// to the Admin.
//
// Order follows the STORED list (so a merge never silently reshuffles the
// table), with genuinely new entries appended in the order they arrived, which
// is how the array grows normally anyway.
function mergeParticipants(oldValue, incomingValue) {
  const oldList = (Array.isArray(oldValue && oldValue.participants) ? oldValue.participants : [])
    .filter((p) => p && typeof p === "object" && !Array.isArray(p) && p.id != null);

  // A payload whose `participants` is not an array has not STATED a
  // membership, so it does not get to define one. Reading it as "the empty
  // list" would let `{participants: null}` — or a serialisation bug, or a
  // crafted body — delete everybody, Admin included, in a single write that
  // otherwise looks entirely ordinary. Fail closed: keep what is stored.
  if (!Array.isArray(incomingValue && incomingValue.participants)) {
    return {
      participants: oldList,
      restored: 0,
      removedByClient: 0,
      sawCurrentMembership: false,
      membershipStated: false,
    };
  }

  const incomingList = incomingValue.participants
    .filter((p) => p && typeof p === "object" && !Array.isArray(p) && p.id != null);

  // An array that claims entries but contains not one usable participant —
  // [null, 7, "x"] — is corruption, not a membership. Reading it as "the
  // empty list" would silently turn three unusable claims into a deletion of
  // everybody. An actually EMPTY array is different: that is a writer saying
  // "no participants", which is a coherent (if drastic) statement, and it is
  // honoured subject to the Admin guarantee below.
  if (incomingValue.participants.length > 0 && incomingList.length === 0 && oldList.length > 0) {
    return {
      participants: oldList,
      restored: 0,
      removedByClient: 0,
      sawCurrentMembership: false,
      membershipStated: false,
    };
  }

  const sawCurrentMembership = readParticipantsRevision(incomingValue) === readParticipantsRevision(oldValue);

  // First occurrence wins, so a payload repeating an id — whether by a UI bug
  // or on purpose — can never produce two rows for one person.
  const incomingById = new Map();
  incomingList.forEach((p) => {
    const key = String(p.id);
    if (!incomingById.has(key)) incomingById.set(key, p);
  });

  const participants = [];
  const taken = new Set();
  let restored = 0;
  let removedByClient = 0;

  oldList.forEach((old) => {
    const key = String(old.id);
    if (taken.has(key)) return; // a duplicate already in the STORED row: collapse it
    const incoming = incomingById.get(key);
    if (incoming) {
      participants.push(incoming);
      taken.add(key);
      return;
    }
    if (sawCurrentMembership) {
      // The writer was looking at this person and chose to drop them.
      removedByClient += 1;
      return;
    }
    // The writer never saw them. Keep the STORED record, untouched.
    participants.push(old);
    taken.add(key);
    restored += 1;
  });

  incomingById.forEach((p, key) => {
    if (taken.has(key)) return;
    participants.push(p);
    taken.add(key);
  });

  // A quiniela with no Admin left has nobody who can administer it and no
  // way back in — there is no product flow that produces that, so a write
  // heading there is a bug or an attack either way. The stored Admins are
  // put back rather than the whole write being refused: the rest of the
  // change is usually legitimate, and this keeps the quiniela reachable.
  // (Removing an Admin while ANOTHER one remains is untouched and still
  // works.)
  const hadAdmin = oldList.some((p) => p.isAdmin);
  if (hadAdmin && !participants.some((p) => p.isAdmin)) {
    oldList.forEach((p) => {
      if (!p.isAdmin || taken.has(String(p.id))) return;
      participants.push(p);
      taken.add(String(p.id));
      restored += 1;
    });
    // An Admin the write tried to demote rather than delete is restored to
    // being one, for the same reason.
    participants.forEach((p, i) => {
      const stored = oldList.find((o) => String(o.id) === String(p.id));
      if (stored && stored.isAdmin && !p.isAdmin) participants[i] = { ...p, isAdmin: true };
    });
  }

  return { participants, restored, removedByClient, sawCurrentMembership, membershipStated: true };
}

// The stored revision is always computed here, never taken from input. It
// advances only when the SET OF IDS changes, so the ordinary saves that
// dominate real use — results, deadlines, penalty settings, a renamed group —
// do not invalidate an Admin's open tab for no reason.
function stampParticipantsRevision(doc, oldValue) {
  const previous = readParticipantsRevision(oldValue);
  const changed = !sameMembership(oldValue && oldValue.participants, doc && doc.participants);
  return { ...doc, participantsRevision: changed ? previous + 1 : previous };
}

module.exports = {
  readParticipantsRevision,
  mergeParticipants,
  stampParticipantsRevision,
  sameMembership,
};
