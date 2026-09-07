// MON-002B — the P1 from the MON-002A audit: a stale whole-document meta
// write could silently delete a participant who had registered in the
// meantime, and the capacity check could be skipped entirely while it
// happened.
//
// THE REPRODUCTION, from the audit:
//
//   T0  the Admin has Participantes open with 9 people on screen
//   T1  someone follows the invite link and self-registers -> the row is 10
//   T2  the Admin adds one name and posts their T0 snapshot back, which
//       therefore contains 9 + 1 = 10 entries
//   ->  the guard is `newCount > oldCount`, and 10 > 10 is false, so the
//       capacity check never runs; the write commits; the person from T1
//       is gone; the count still reads 10 and nobody is told
//
// These drive the SHIPPED merge (metaParticipants.js) and the SHIPPED
// capacity rule (planLimits.js) through a transactional store that behaves
// like BEGIN / SELECT ... FOR UPDATE / COMMIT, so the semantics under test
// are the ones that actually run, not a restatement of them.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  readParticipantsRevision, readParticipantRev, mergeParticipants,
  stampParticipantsRevision, stampMetaRevisions, claimsConflict,
} = require("../metaParticipants");
const { DEFAULT_COMMERCIAL_CONFIG, buildFreeEntitlement, buildPlusEntitlement, checkParticipantCapacity } = require("../planLimits");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// ---- a meta row with a real row lock -------------------------------------

function createMetaStore(meta) {
  let row = JSON.parse(JSON.stringify(meta));
  let lock = null;
  return {
    raw() { return JSON.parse(JSON.stringify(row)); },
    async transaction(fn) {
      while (lock) await lock;
      let release;
      lock = new Promise((r) => { release = r; });
      try {
        const current = JSON.parse(JSON.stringify(row));
        return await fn({ current, write(v) { row = JSON.parse(JSON.stringify(v)); } });
      } finally {
        lock = null;
        release();
      }
    },
  };
}

// Mirrors POST /api/kv/:key's quiniela-meta branch: merge participants
// against the LOCKED row, then check capacity on what the merge produced,
// then stamp the revision the server computes.
async function metaWrite(store, incoming, { entitlement, config = DEFAULT_COMMERCIAL_CONFIG } = {}) {
  return store.transaction(async ({ current, write }) => {
    const merge = mergeParticipants(current, incoming);
    // Mirrors mergeProtectedMetaFields: the API never sends `pin` to a
    // browser, so a client echo arrives without it and the server restores it
    // from the stored row. A harness that skipped this would be testing a
    // payload no client can produce, and would see phantom field changes on
    // every write.
    const storedById = new Map((current.participants || []).map((p) => [String(p.id), p]));
    const merged = {
      ...incoming,
      participants: merge.participants.map((p) => {
        if (!p || p.id == null) return p;
        const stored = storedById.get(String(p.id));
        if (!("pin" in p) && stored && "pin" in stored) return { ...p, pin: stored.pin };
        return p;
      }),
    };

    const oldCount = (current.participants || []).length;
    const newCount = merged.participants.length;
    if (newCount > oldCount) {
      const check = checkParticipantCapacity(entitlement, config, oldCount, newCount - oldCount);
      if (!check.allowed) {
        return { status: 402, error: check.reason, limit: check.limit };
      }
    }
    const stored = stampMetaRevisions(merged, current);
    write(stored);
    return {
      status: 200,
      participantsRevision: readParticipantsRevision(stored),
      participantsRestored: merge.restored,
      participantsRefreshed: merge.refreshed,
    };
  });
}

// Mirrors POST /api/self-register: locked read, capacity check, append, and
// a revision bump because the membership changed.
async function selfRegister(store, name, { entitlement, config = DEFAULT_COMMERCIAL_CONFIG } = {}) {
  return store.transaction(async ({ current, write }) => {
    const check = checkParticipantCapacity(entitlement, config, current.participants.length, 1);
    if (!check.allowed) return { status: 402, error: check.reason };
    const before = { participants: current.participants, participantsRevision: readParticipantsRevision(current) };
    const added = { id: "p_" + name.toLowerCase(), name, isAdmin: false, paid: false, pin: "hash:" + name };
    current.participants = current.participants.concat([added]);
    write(stampMetaRevisions(current, before));
    return { status: 200, participant: added };
  });
}

// Mirrors POST /api/set-pin: a single-participant change, under lock, that
// must advance that participant's own revision.
async function resetPin(store, id, pin) {
  return store.transaction(async ({ current, write }) => {
    const before = JSON.parse(JSON.stringify(current));
    const p = current.participants.find((x) => x.id === id);
    if (!p) return { status: 404 };
    p.pin = "hash:" + pin;
    write(stampMetaRevisions(current, before));
    return { status: 200 };
  });
}

// Mirrors POST /api/submit-bet-answer, for the same reason.
async function answerBet(store, id, betId, guess) {
  return store.transaction(async ({ current, write }) => {
    const before = JSON.parse(JSON.stringify(current));
    const p = current.participants.find((x) => x.id === id);
    if (!p) return { status: 404 };
    if (!p.customBetAnswers) p.customBetAnswers = {};
    p.customBetAnswers[betId] = { guess, correct: null };
    write(stampMetaRevisions(current, before));
    return { status: 200 };
  });
}

// What the browser actually posts back: the API never sends `pin`, it sends
// the boolean `hasPin`. Using the raw stored objects in these tests would
// quietly test a payload no client can produce.
function asClientSees(meta) {
  const copy = JSON.parse(JSON.stringify(meta));
  copy.participants = copy.participants.map((p) => {
    const { pin, ...rest } = p;
    return { ...rest, hasPin: !!pin };
  });
  return copy;
}
const find = (m, id) => m.participants.find((p) => p.id === id);

const person = (id, over = {}) => ({ id, name: id.toUpperCase(), isAdmin: false, paid: false, pin: "hash:" + id, ...over });

function metaWith(n, over = {}) {
  const participants = [person("admin", { isAdmin: true, name: "Admin" })];
  for (let i = 1; i < n; i++) participants.push(person("p" + i, { name: "P" + i }));
  return { groupName: "Alpha", participants, rounds: [], settings: {}, participantsRevision: 1, ...over };
}

const FREE = buildFreeEntitlement(DEFAULT_COMMERCIAL_CONFIG);
const PLUS = buildPlusEntitlement(DEFAULT_COMMERCIAL_CONFIG);
const names = (m) => m.participants.map((p) => p.id).sort();

// ==== the audited T0/T1/T2 =================================================

test("LOST UPDATE: the audited T0/T1/T2 — a stale Admin save can no longer delete the person who just registered", async () => {
  const store = createMetaStore(metaWith(9));       // 9 on screen

  // T0 — the Admin's tab holds this exact document.
  const adminSnapshot = store.raw();
  assert.equal(adminSnapshot.participants.length, 9);

  // T1 — someone self-registers. Now 10.
  const reg = await selfRegister(store, "nuevo", { entitlement: FREE });
  assert.equal(reg.status, 200);
  assert.equal(store.raw().participants.length, 10);

  // T2 — the Admin adds one name and posts the T0 snapshot back: 9 + 1 = 10.
  adminSnapshot.participants.push(person("delAdmin", { name: "Del Admin" }));
  const res = await metaWrite(store, adminSnapshot, { entitlement: FREE });

  // The merge would produce 11 (10 stored + 1 new), which is over the FREE
  // limit, so this is REFUSED rather than silently deleting someone to make
  // the arithmetic work.
  assert.equal(res.status, 402, "the write must be refused, not quietly applied");
  assert.equal(res.error, "plan_participant_limit_reached");

  const final = store.raw();
  assert.equal(final.participants.length, 10, "nothing was written");
  assert.ok(final.participants.some((p) => p.id === "p_nuevo"), "the person from T1 is still there");
  assert.ok(!final.participants.some((p) => p.id === "delAdmin"), "and the refused addition did not land");
});

test("LOST UPDATE: the same race below the limit keeps BOTH people instead of one overwriting the other", async () => {
  const store = createMetaStore(metaWith(5));
  const adminSnapshot = store.raw();

  await selfRegister(store, "nuevo", { entitlement: FREE });          // 6
  adminSnapshot.participants.push(person("delAdmin"));                 // stale 5 + 1
  const res = await metaWrite(store, adminSnapshot, { entitlement: FREE });

  assert.equal(res.status, 200);
  assert.equal(res.participantsRestored, 1, "the caller is told an entry was kept for it");
  const final = store.raw();
  assert.equal(final.participants.length, 7, "both additions survive");
  assert.ok(final.participants.some((p) => p.id === "p_nuevo"));
  assert.ok(final.participants.some((p) => p.id === "delAdmin"));
});

test("LOST UPDATE: a stale save that adds NOBODY still cannot delete the concurrent registration", async () => {
  // The quietest version of the bug: the Admin only flips a "pagó" checkbox,
  // which posts the whole document with one fewer participant than the row
  // now holds.
  const store = createMetaStore(metaWith(5));
  const adminSnapshot = store.raw();
  await selfRegister(store, "nuevo", { entitlement: FREE });

  adminSnapshot.participants[2].paid = true;
  const res = await metaWrite(store, adminSnapshot, { entitlement: FREE });
  assert.equal(res.status, 200);
  const final = store.raw();
  assert.ok(final.participants.some((p) => p.id === "p_nuevo"), "the registration survives an unrelated save");
  assert.equal(final.participants.find((p) => p.id === "p2").paid, true, "and the Admin's own edit applies");
});

// ==== the concurrent-operation matrix the ticket asks for ==================

test("add / add: two stale writers each adding a different person keep both", async () => {
  const store = createMetaStore(metaWith(4));
  const a = store.raw();
  const b = store.raw();
  a.participants.push(person("fromA"));
  b.participants.push(person("fromB"));
  await metaWrite(store, a, { entitlement: FREE });
  await metaWrite(store, b, { entitlement: FREE });
  assert.deepEqual(names(store.raw()), ["admin", "fromA", "fromB", "p1", "p2", "p3"].sort());
});

test("add / remove: a FRESH writer's removal is honoured; a STALE writer's removal is not", async () => {
  // Fresh: the writer is looking at the current membership, so dropping
  // someone is a deliberate act and must work.
  const fresh = createMetaStore(metaWith(4));
  const freshDoc = fresh.raw();
  freshDoc.participants = freshDoc.participants.filter((p) => p.id !== "p2");
  const okRes = await metaWrite(fresh, freshDoc, { entitlement: FREE });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.participantsRestored, 0);
  assert.deepEqual(names(fresh.raw()), ["admin", "p1", "p3"]);

  // Stale: someone registered after this document was loaded, so a missing
  // entry can no longer be read as intent.
  const stale = createMetaStore(metaWith(4));
  const staleDoc = stale.raw();
  await selfRegister(stale, "nuevo", { entitlement: FREE });
  staleDoc.participants = staleDoc.participants.filter((p) => p.id !== "p2");
  const staleRes = await metaWrite(stale, staleDoc, { entitlement: FREE });
  assert.equal(staleRes.status, 200);
  assert.equal(staleRes.participantsRestored, 2, "p2 and the new registration were both kept");
  assert.deepEqual(names(stale.raw()), ["admin", "p1", "p2", "p3", "p_nuevo"]);
});

test("rename / update vs add: an edit to a person the writer DID see always applies, stale or not", async () => {
  const store = createMetaStore(metaWith(4));
  const staleDoc = store.raw();
  await selfRegister(store, "nuevo", { entitlement: FREE });

  staleDoc.participants[1].name = "Renombrado";
  staleDoc.participants[2].paid = true;
  const res = await metaWrite(store, staleDoc, { entitlement: FREE });
  assert.equal(res.status, 200);
  const final = store.raw();
  assert.equal(final.participants.find((p) => p.id === "p1").name, "Renombrado");
  assert.equal(final.participants.find((p) => p.id === "p2").paid, true);
  assert.ok(final.participants.some((p) => p.id === "p_nuevo"), "and the concurrent registration is untouched");
});

test("no duplicates: a payload repeating the same id collapses to one row", async () => {
  const store = createMetaStore(metaWith(3));
  const doc = store.raw();
  doc.participants.push(person("p1", { name: "Duplicado" }));
  doc.participants.push(person("nuevo"));
  doc.participants.push(person("nuevo", { name: "Otra vez" }));
  await metaWrite(store, doc, { entitlement: FREE });
  const ids = store.raw().participants.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "every id appears exactly once");
  assert.deepEqual(ids.sort(), ["admin", "nuevo", "p1", "p2"]);
});

test("no duplicates: re-adding someone the merge already restored does not double them", async () => {
  const store = createMetaStore(metaWith(3));
  const staleDoc = store.raw();
  await selfRegister(store, "nuevo", { entitlement: FREE });
  // The stale writer happens to make up a participant with the SAME id the
  // registration produced.
  staleDoc.participants.push(person("p_nuevo", { name: "Choque" }));
  await metaWrite(store, staleDoc, { entitlement: FREE });
  const ids = store.raw().participants.map((p) => p.id);
  assert.equal(ids.filter((id) => id === "p_nuevo").length, 1);
});

test("the Admin never disappears, whatever the stale writer sends", async () => {
  const store = createMetaStore(metaWith(4));
  const doc = store.raw();
  await selfRegister(store, "nuevo", { entitlement: FREE });
  doc.participants = []; // a payload that dropped everyone
  await metaWrite(store, doc, { entitlement: FREE });
  const final = store.raw();
  assert.ok(final.participants.some((p) => p.id === "admin" && p.isAdmin), "the Admin is still there and still Admin");
  assert.equal(final.participants.length, 5, "and so is everyone else");
});

test("PINs survive a merge that restores someone", async () => {
  const store = createMetaStore(metaWith(4));
  const doc = store.raw();
  await selfRegister(store, "nuevo", { entitlement: FREE });
  doc.participants = doc.participants.filter((p) => p.id === "admin"); // stale + destructive
  await metaWrite(store, doc, { entitlement: FREE });
  const final = store.raw();
  final.participants.forEach((p) => {
    assert.ok(p.pin, `${p.id} must keep its PIN through the merge`);
  });
  assert.equal(final.participants.find((p) => p.id === "p_nuevo").pin, "hash:nuevo");
});

test("participantCount is a display cache, never the thing capacity is measured from", () => {
  // The audit's other half: a stale count must not be able to authorise a
  // write. The server measures from the participant ARRAY it just read under
  // lock, in both write paths.
  assert.ok(serverSrc.includes("const oldParticipantCount = (oldValue.participants || []).length;"));
  assert.ok(serverSrc.includes("const newParticipantCount = (mergedValue.participants || []).length;"));
  assert.ok(serverSrc.includes("checkParticipantCapacity(entry.entitlement, commercialConfig, value.participants.length, 1, {"));
  assert.ok(!serverSrc.includes("checkParticipantCapacity(entry.entitlement, commercialConfig, entry.participantCount"),
    "the cached count must never be the input to a capacity decision");
});

// ==== the revision protocol itself ========================================

test("REVISION: only the server computes it — an incoming value is a claim, never the stored one", async () => {
  const store = createMetaStore(metaWith(3));
  const doc = store.raw();
  doc.participantsRevision = 9999;              // a forged claim
  doc.participants.push(person("nuevo"));
  const res = await metaWrite(store, doc, { entitlement: FREE });
  assert.equal(res.status, 200);
  assert.equal(store.raw().participantsRevision, 2, "computed from the stored value, not the request");
});

test("REVISION: it advances only when the SET OF IDS changes, so ordinary saves don't invalidate an open tab", async () => {
  const store = createMetaStore(metaWith(4));
  const doc = store.raw();
  doc.groupName = "Otro nombre";
  doc.participants[1].paid = true;
  doc.rounds = [{ id: "r1", published: true }];
  await metaWrite(store, doc, { entitlement: FREE });
  assert.equal(store.raw().participantsRevision, 1, "membership unchanged -> revision unchanged");

  const doc2 = store.raw();
  doc2.participants.push(person("nuevo"));
  await metaWrite(store, doc2, { entitlement: FREE });
  assert.equal(store.raw().participantsRevision, 2, "membership changed -> revision advances");
});

test("REVISION: a malformed or absent revision is treated as 0, never coerced from a string", async () => {
  for (const bad of [undefined, null, "1", 1.5, NaN, -1, {}, [], true]) {
    assert.equal(readParticipantsRevision({ participantsRevision: bad }), 0, `must not accept ${JSON.stringify(bad)}`);
  }
  assert.equal(readParticipantsRevision({ participantsRevision: 7 }), 7);
  assert.equal(readParticipantsRevision(null), 0);
});

test("REVISION: a legacy meta with no revision at all still writes, and starts the protocol", async () => {
  const legacy = metaWith(3);
  delete legacy.participantsRevision;
  const store = createMetaStore(legacy);
  const doc = store.raw();
  doc.participants.push(person("nuevo"));
  const res = await metaWrite(store, doc, { entitlement: FREE });
  assert.equal(res.status, 200);
  assert.equal(store.raw().participantsRevision, 1);
});

test("REVISION: the browser adopts the server's values, so its own next save is not judged stale", () => {
  const i = indexSrc.indexOf("async function setMetaWithError(meta, opts)");
  assert.ok(i !== -1);
  const body = indexSrc.slice(i, i + 2200);
  assert.ok(body.includes("meta.participantsRevision = result.participantsRevision"),
    "without this, a tab's own successful save would leave it holding the previous revision");
  assert.ok(body.includes("adoptParticipantRevs(result.participantRevs)"),
    "and the same for each participant's own rev, or consecutive edits from one tab would be refused");
  assert.ok(body.includes("result.participantsRestored") && body.includes("result.participantsRefreshed"),
    "and it must react when entries were kept for it, or field values were");
  // setMeta() must route through the same place, or the boolean-returning
  // call sites would silently skip the adoption.
  const setMetaIdx = indexSrc.indexOf("async function setMeta(meta, opts)");
  const setMetaBody = indexSrc.slice(setMetaIdx, setMetaIdx + 400);
  assert.ok(setMetaBody.includes("await setMetaWithError(meta, opts)"), "setMeta must delegate, not duplicate");
});

// ==== malformed input ======================================================

test("malformed participant payloads fail closed instead of corrupting the list", async () => {
  const store = createMetaStore(metaWith(3));
  // Every one of these is sent by a FRESH writer (matching revision), which
  // is the case that actually mattered: a stale writer was already protected
  // by the merge, so testing only that would have proved nothing.
  const rev = readParticipantsRevision(store.raw());
  for (const participants of [null, undefined, "nope", 42, {}, [null, 7, "x"], [null], ["", 0]]) {
    const before = store.raw();
    const merged = mergeParticipants(before, { participantsRevision: rev, participants });
    assert.deepEqual(merged.participants.map((p) => p.id).sort(), ["admin", "p1", "p2"],
      `a malformed payload must leave the stored list intact: ${JSON.stringify(participants)}`);
    assert.equal(merged.membershipStated, false, "and it must be reported as having stated nothing");
  }
  // A payload that is not an object at all is the same story.
  for (const bad of [null, undefined, "nope", 42]) {
    assert.deepEqual(mergeParticipants(store.raw(), bad).participants.map((p) => p.id).sort(), ["admin", "p1", "p2"]);
  }
});

test("an ACTUALLY empty array is a real statement and is honoured — minus the Admin guarantee", () => {
  const stored = metaWith(3);
  const merged = mergeParticipants(stored, { participantsRevision: 1, participants: [] });
  assert.equal(merged.membershipStated, true, "an empty list is a statement, not corruption");
  assert.deepEqual(merged.participants.map((p) => p.id), ["admin"], "everyone goes except the Admin");
});

test("the last Admin is never removed or demoted, however the write is shaped", () => {
  const stored = metaWith(3);
  // deleted outright
  const removed = mergeParticipants(stored, { participantsRevision: 1, participants: [person("p1"), person("p2")] });
  assert.ok(removed.participants.some((p) => p.id === "admin" && p.isAdmin), "the Admin is restored");
  // demoted instead of deleted
  const demoted = mergeParticipants(stored, {
    participantsRevision: 1,
    participants: [person("admin", { isAdmin: false }), person("p1"), person("p2")],
  });
  assert.ok(demoted.participants.some((p) => p.id === "admin" && p.isAdmin), "and re-promoted");
  // removing ONE admin while another remains is untouched
  const two = { participantsRevision: 1, participants: [person("a1", { isAdmin: true }), person("a2", { isAdmin: true }), person("p1")] };
  const oneGone = mergeParticipants(two, { participantsRevision: 1, participants: [person("a2", { isAdmin: true }), person("p1")] });
  assert.deepEqual(oneGone.participants.map((p) => p.id), ["a2", "p1"], "a co-admin can still be removed");
});

test("entries without an id are dropped rather than stored as anonymous rows", () => {
  const stored = metaWith(2);
  const incoming = { participantsRevision: 1, participants: [{ name: "Sin id" }, { id: "admin", name: "Admin" }] };
  const merged = mergeParticipants(stored, incoming);
  assert.deepEqual(merged.participants.map((p) => p.id), ["admin"]);
});

test("a duplicate id already sitting in the STORED row is collapsed, not propagated", () => {
  const stored = { participantsRevision: 1, participants: [person("a"), person("a", { name: "Copia" }), person("b")] };
  const merged = mergeParticipants(stored, { participantsRevision: 1, participants: [person("a"), person("b")] });
  assert.deepEqual(merged.participants.map((p) => p.id), ["a", "b"]);
});

// ==== the SECOND lost update: participant FIELDS ==========================
//
// participantsRevision guards who is in the quiniela. It says nothing about
// what each person IS, and the first version of this file took the incoming
// participant object whole whenever the id matched. So a tab that was stale
// about a PERSON could revert them while doing something else entirely.

test("FIELDS 1: a stale generic save cannot undo a PIN reset", async () => {
  const store = createMetaStore(metaWith(4));
  const staleTab = asClientSees(store.raw());          // T0 — old PIN on screen

  await resetPin(store, "p1", "9999");                 // T1 — Beto resets his PIN

  staleTab.rounds.push({ id: "r1", number: 1, published: true });  // T2 — publish a round
  const res = await metaWrite(store, staleTab, { entitlement: FREE });
  assert.equal(res.status, 200);

  assert.equal(find(store.raw(), "p1").pin, "hash:9999", "the new PIN survives");
  assert.equal(store.raw().rounds.length, 1, "and the round the tab actually wanted still lands");
});

test("FIELDS 2: a stale generic save cannot undo a rename", async () => {
  const store = createMetaStore(metaWith(4));
  const staleTab = asClientSees(store.raw());

  // Another tab renames P1.
  const fresh = asClientSees(store.raw());
  find(fresh, "p1").name = "Renombrado por B";
  await metaWrite(store, fresh, { entitlement: FREE });

  staleTab.groupName = "Otro nombre de grupo";
  const res = await metaWrite(store, staleTab, { entitlement: FREE });
  assert.equal(find(store.raw(), "p1").name, "Renombrado por B", "the rename survives");
  assert.equal(store.raw().groupName, "Otro nombre de grupo", "and the stale tab's own edit applies");
  assert.equal(res.participantsRefreshed, 1, "and the tab is told it was behind");
});

test("FIELDS 3: a stale generic save cannot undo an admin role change", async () => {
  const store = createMetaStore(metaWith(4));
  const staleTab = asClientSees(store.raw());

  const fresh = asClientSees(store.raw());
  find(fresh, "p1").isAdmin = true;                    // P1 is promoted
  await metaWrite(store, fresh, { entitlement: FREE });

  staleTab.rounds.push({ id: "r1", number: 1, published: true });
  await metaWrite(store, staleTab, { entitlement: FREE });
  assert.equal(find(store.raw(), "p1").isAdmin, true, "the promotion survives");
});

test("FIELDS 4: a stale generic save cannot undo a payment flag or a penalty ledger entry", async () => {
  const store = createMetaStore(metaWith(4));
  const staleTab = asClientSees(store.raw());

  const fresh = asClientSees(store.raw());
  find(fresh, "p2").paid = true;
  find(fresh, "p2").paidAt = "2026-09-03T00:00:00.000Z";
  find(fresh, "p1").penalizedRounds = { r1: 1 };       // the Payment Penalty ledger
  await metaWrite(store, fresh, { entitlement: FREE });

  staleTab.settings.pointsPerCorrectPick = 2;
  await metaWrite(store, staleTab, { entitlement: FREE });
  assert.equal(find(store.raw(), "p2").paid, true, "the payment flag survives");
  assert.equal(find(store.raw(), "p2").paidAt, "2026-09-03T00:00:00.000Z");
  assert.deepEqual(find(store.raw(), "p1").penalizedRounds, { r1: 1 }, "and so does the penalty ledger");
  assert.equal(store.raw().settings.pointsPerCorrectPick, 2, "the stale tab's own edit still applies");
});

test("FIELDS 5: an explicit PIN reset from a FRESH tab does apply", async () => {
  const store = createMetaStore(metaWith(3));
  const r = await resetPin(store, "p1", "1111");
  assert.equal(r.status, 200);
  assert.equal(find(store.raw(), "p1").pin, "hash:1111");
  // ...and through the generic path too, which is how the Admin screen does it
  const fresh = asClientSees(store.raw());
  find(fresh, "p1").hasPin = false;                    // "reset PIN" clears it
  const res = await metaWrite(store, fresh, { entitlement: FREE });
  assert.equal(res.status, 200);
  assert.equal(res.participantsRefreshed, 0, "a fresh writer is never in conflict");
});

test("FIELDS 6: an explicit rename from a FRESH tab does apply", async () => {
  const store = createMetaStore(metaWith(3));
  const fresh = asClientSees(store.raw());
  find(fresh, "p1").name = "Nombre Nuevo";
  const res = await metaWrite(store, fresh, { entitlement: FREE });
  assert.equal(res.status, 200);
  assert.equal(find(store.raw(), "p1").name, "Nombre Nuevo");
  assert.equal(res.participantsRefreshed, 0);
});

test("FIELDS 7: two tabs editing the SAME field — the second is refused and TOLD, never silently lost", async () => {
  const store = createMetaStore(metaWith(3));
  const tabA = asClientSees(store.raw());
  const tabB = asClientSees(store.raw());

  find(tabA, "p1").name = "Nombre de A";
  const resA = await metaWrite(store, tabA, { entitlement: FREE });
  assert.equal(resA.participantsRefreshed, 0, "the first writer wins cleanly");

  find(tabB, "p1").name = "Nombre de B";
  const resB = await metaWrite(store, tabB, { entitlement: FREE });
  assert.equal(find(store.raw(), "p1").name, "Nombre de A", "the winner's value stands");
  assert.equal(resB.participantsRefreshed, 1, "and the loser is told, rather than believing it won");

  // Recovery: reload and the same edit succeeds.
  const reloaded = asClientSees(store.raw());
  find(reloaded, "p1").name = "Nombre de B";
  const retry = await metaWrite(store, reloaded, { entitlement: FREE });
  assert.equal(retry.participantsRefreshed, 0);
  assert.equal(find(store.raw(), "p1").name, "Nombre de B");
});

test("FIELDS 8: stale membership AND a stale field edit still cannot delete a concurrent registration", async () => {
  const store = createMetaStore(metaWith(4));
  const staleTab = asClientSees(store.raw());

  await selfRegister(store, "nuevo", { entitlement: FREE });   // membership moves
  await resetPin(store, "p1", "7777");                          // and a field moves

  find(staleTab, "p1").name = "Intento obsoleto";
  const res = await metaWrite(store, staleTab, { entitlement: FREE });
  assert.equal(res.status, 200);
  const final = store.raw();
  assert.ok(final.participants.some((p) => p.id === "p_nuevo"), "the registration survives");
  assert.equal(find(final, "p1").pin, "hash:7777", "so does the PIN");
  assert.equal(find(final, "p1").name, "P1", "and the stale rename is refused");
  assert.equal(res.participantsRestored, 1);
  assert.equal(res.participantsRefreshed, 1);
});

test("FIELDS 12: publishing a round, moving a deadline or saving results never touches a participant", async () => {
  const store = createMetaStore(metaWith(4));
  const before = JSON.parse(JSON.stringify(store.raw().participants));

  const tab = asClientSees(store.raw());
  tab.rounds.push({ id: "r1", number: 1, published: true, deadline: "2026-10-01T00:00:00.000Z", results: {}, matches: [] });
  await metaWrite(store, tab, { entitlement: FREE });

  const tab2 = asClientSees(store.raw());
  tab2.rounds[0].deadline = "2026-10-02T00:00:00.000Z";
  tab2.rounds[0].results = { m1: "L" };
  tab2.rounds[0].resultsPublished = true;
  tab2.groupName = "Renombrada";
  await metaWrite(store, tab2, { entitlement: FREE });

  // Compared on the fields that actually mean something, named explicitly
  // rather than by whole-object equality: a client echo also carries the
  // transport-only `hasPin` boolean the API sends in place of the hash, and
  // that landing in the row is pre-existing behaviour, not a mutation of
  // anything a person would recognise.
  const MEANINGFUL = ["name", "isAdmin", "paid", "paidAt", "pin", "customBetAnswers", "penalizedRounds"];
  const shape = (p) => JSON.stringify(MEANINGFUL.map((k) => [k, p[k] === undefined ? null : p[k]]));
  const after = store.raw().participants;
  assert.deepEqual(after.map(shape), before.map(shape), "no participant field changed");
  after.forEach((p) => assert.equal(readParticipantRev(p), 0, "and no revision moved, because nothing changed"));
  assert.equal(store.raw().rounds[0].resultsPublished, true, "while the round work landed");
});

// ==== the revision protocol for fields ====================================

test("FIELD REVISION: only the server computes it, and a forged rev buys nothing", async () => {
  const store = createMetaStore(metaWith(3));
  await resetPin(store, "p1", "5555");
  const forged = asClientSees(store.raw());
  find(forged, "p1").rev = 999999;                 // claim to be current
  find(forged, "p1").name = "Robado";
  const res = await metaWrite(store, forged, { entitlement: FREE });
  assert.equal(find(store.raw(), "p1").name, "P1", "a claimed rev that does not match is still stale");
  assert.equal(res.participantsRefreshed, 1);
});

test("FIELD REVISION: it advances only for the participant that actually changed", async () => {
  const store = createMetaStore(metaWith(4));
  const fresh = asClientSees(store.raw());
  find(fresh, "p1").name = "Solo este";
  await metaWrite(store, fresh, { entitlement: FREE });
  const after = store.raw();
  assert.equal(readParticipantRev(find(after, "p1")), 1, "the edited one moves");
  assert.equal(readParticipantRev(find(after, "p2")), 0, "the others do not");
  assert.equal(readParticipantRev(find(after, "admin")), 0);
});

test("FIELD REVISION: a client echo that omits `pin` is not treated as a claim about it", async () => {
  // The API sends hasPin, never the hash. If the absence of `pin` counted as
  // a claim, every stale comparison would report a conflict that isn't one.
  const stored = { id: "b", name: "Beto", paid: false, pin: "hash:secreto", rev: 3 };
  assert.equal(claimsConflict({ id: "b", name: "Beto", paid: false, hasPin: true, rev: 0 }, stored), false);
  assert.equal(claimsConflict({ id: "b", name: "Otro", paid: false, hasPin: true, rev: 0 }, stored), true);
  assert.equal(claimsConflict({ id: "b", name: "Beto", paid: true, hasPin: true, rev: 0 }, stored), true);
});

test("FIELD REVISION: key order never counts as a change", () => {
  // Postgres jsonb normalises key order; a browser echo does not. Comparing
  // raw JSON would report changes that are not changes.
  const a = { id: "x", name: "N", customBetAnswers: { b2: { correct: null, guess: "g" }, b1: { guess: "h", correct: true } } };
  const b = { id: "x", customBetAnswers: { b1: { correct: true, guess: "h" }, b2: { guess: "g", correct: null } }, name: "N" };
  assert.equal(claimsConflict(a, b), false);
  assert.equal(claimsConflict({ ...a, name: "Otro" }, b), true);
});

test("FIELD REVISION: a bet answer and a PIN reset each advance only their own participant", async () => {
  const store = createMetaStore(metaWith(4));
  await answerBet(store, "p2", "bet1", "Chivas");
  await resetPin(store, "p1", "2222");
  const after = store.raw();
  assert.equal(readParticipantRev(find(after, "p1")), 1);
  assert.equal(readParticipantRev(find(after, "p2")), 1);
  assert.equal(readParticipantRev(find(after, "p3")), 0);

  // And a tab loaded before both cannot revert either one.
  const stale = asClientSees(metaWith(4));
  stale.participantsRevision = readParticipantsRevision(after);
  await metaWrite(store, stale, { entitlement: FREE });
  const final = store.raw();
  assert.equal(find(final, "p1").pin, "hash:2222");
  assert.deepEqual(find(final, "p2").customBetAnswers, { bet1: { guess: "Chivas", correct: null } });
});
