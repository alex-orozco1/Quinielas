// Payment Penalty Persistence — Cases A-S, executing the REAL
// penaltyPointsFor()/reconcilePenaltyLedger()/isRoundEligibleForPenalty()
// extracted from production, not a reimplementation.
//
// QA-corrected model: a penalty is CAUSED the moment an eligible round's
// deadline passes while unpaid, and once caused it survives ANY later
// non-monotonic change to that round (reopen, deadline edit, deletion).
// This is implemented as a persisted per-participant ledger
// (p.penalizedRounds: { [roundId]: pointsAtTimeOfPenalty }), promoted by
// reconcilePenaltyLedger() -- called before any action that could make an
// eligible-closed round's closed-state stop being monotonic.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  const braceStart = source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

function loadPenaltyModel(){
  const isRoundLockedSrc = extractFunctionBody(indexSrc, "function isRoundLocked(round)");
  const isRoundEligibleSrc = extractFunctionBody(indexSrc, "function isRoundEligibleForPenalty(round, penalty)");
  const reconcileSrc = extractFunctionBody(indexSrc, "function reconcilePenaltyLedger(meta)");
  const penaltyPointsForSrc = extractFunctionBody(indexSrc, "function penaltyPointsFor(p, cutoffRoundNumber)");
  return new Function("meta", "p", "cutoffRoundNumber", "serverNow", "action", `
    ${isRoundLockedSrc}
    ${isRoundEligibleSrc}
    ${reconcileSrc}
    ${penaltyPointsForSrc}
    if (action === "reconcile") { reconcilePenaltyLedger(meta); return null; }
    return penaltyPointsFor(p, cutoffRoundNumber);
  `);
}

function runPenaltyPointsFor(meta, p, cutoffRoundNumber, nowMs){
  return loadPenaltyModel()(meta, p, cutoffRoundNumber, () => nowMs, "read");
}
function runReconcile(meta, nowMs){
  loadPenaltyModel()(meta, null, null, () => nowMs, "reconcile");
}

const NOW = new Date("2026-08-20T12:00:00.000Z").getTime();
const OPEN = "2099-01-01T00:00:00.000Z";
const CLOSED = "2020-01-01T00:00:00.000Z";

function round(id, number, deadline, resultsPublished){
  return { id, number, deadline, resultsPublished: !!resultsPublished, published: true };
}
function penalty(overrides){
  return { enabled: true, startsAtRound: 5, pointsPerRound: 1, ...overrides };
}

// ---- CASE A-D ----

test("CASE A: J5 still open, unpaid -> penalty 0", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, OPEN)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: false }, null, NOW), 0);
});

test("CASE B: J5 closed, unpaid -> penalty -1 (does NOT require resultsPublished)", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED, false)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: false }, null, NOW), 1);
});

test("CASE C: J5 closed + J6 open, unpaid -> penalty -1", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED), round("r6", 6, OPEN)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: false }, null, NOW), 1);
});

test("CASE D: J5+J6 both closed, unpaid -> penalty -2", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED), round("r6", 6, CLOSED)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: false }, null, NOW), 2);
});

// ---- CASE E-H ----

test("CASE E: J5 closed unpaid, reconciled+paid -> penalty stays -1", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED)], participants: [{ id: "x", paid: false }] };
  runReconcile(meta, NOW);
  const p = meta.participants[0];
  p.paid = true;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1);
});

test("CASE F: J5+J6 closed unpaid, reconciled+paid after J6, THEN J7 closes -> stays -2 (not -3, not 0)", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED), round("r6", 6, CLOSED)], participants: [{ id: "x", paid: false }] };
  runReconcile(meta, NOW);
  const p = meta.participants[0];
  p.paid = true;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2);
  meta.rounds.push(round("r7", 7, CLOSED));
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2, "J7 closing while paid must not add to the total");
});

test("CASE G: participant pays BEFORE J5's deadline -> J5 never penalizes", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, OPEN)], participants: [{ id: "x", paid: false }] };
  runReconcile(meta, NOW);
  const p = meta.participants[0];
  p.paid = true;
  meta.rounds[0].deadline = CLOSED;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 0);
});

test("CASE H: J5 closes unpaid (-1), pays before J6 closes -> J5=-1, J6=0, total=-1", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED), round("r6", 6, OPEN)], participants: [{ id: "x", paid: false }] };
  runReconcile(meta, NOW);
  const p = meta.participants[0];
  p.paid = true;
  meta.rounds[1].deadline = CLOSED;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1);
});

// ---- CASE I ----

test("CASE I: J5 closed+unpaid penalizes regardless of resultsPublished, before AND after publication", () => {
  const metaBefore = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED, false)] };
  assert.equal(runPenaltyPointsFor(metaBefore, { paid: false }, null, NOW), 1);
  const metaAfter = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED, true)] };
  assert.equal(runPenaltyPointsFor(metaAfter, { paid: false }, null, NOW), 1);
});

// ---- CASE J/K ----

test("CASE J: legacy paid (paid:true, no penalizedRounds ledger at all) -> historical penalty 0, never inferred", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED), round("r6", 6, CLOSED)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: true }, null, NOW), 0);
});

test("CASE K: legacy unpaid (paid:false, no ledger) with J5+J6 already closed -> full live penalty applies", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED), round("r6", 6, CLOSED)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: false }, null, NOW), 2);
});

// ---- CASE M ----

test("CASE M: false->true->false->true across closing rounds never double-counts, never erases, never counts rounds closed while paid", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED)], participants: [{ id: "x", paid: false }] };
  runReconcile(meta, NOW);
  const p = meta.participants[0];
  p.paid = true;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1);

  meta.rounds.push(round("r6", 6, CLOSED));
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "J6 closing while paid must not increase the penalty");

  runReconcile(meta, NOW); // no-op: p.paid is true, reconcile skips paid participants
  p.paid = false;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2, "back to unpaid: J6 is now live-counted (not yet ledgered, but currently closed+unpaid) alongside the ledgered J5");

  meta.rounds.push(round("r7", 7, CLOSED));
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 3, "J7 also live-counts now: J5(ledgered)+J6+J7(live) = 3");

  runReconcile(meta, NOW); // promotes J6 and J7 into the ledger too
  p.paid = true;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 3, "frozen at 3 after the full sequence");
});

// ---- CASE N-S (QA-blocking): non-monotonic lifecycle changes ----

test("CASE N: J5 closes unpaid -> 1, THEN J5 reopens (deadline back to the future) -> penalty stays 1", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED)], participants: [{ id: "x", paid: false }] };
  const p = meta.participants[0];
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "live top-up shows 1 before any reconciliation");
  runReconcile(meta, NOW); // mirrors the real reopen handler reconciling before moving the deadline
  meta.rounds[0].deadline = OPEN;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "penalty must survive the round becoming open again");
});

test("CASE O: J5 closes unpaid -> 1, reopens, participant marked paid, J5 closes again while paid -> stays 1", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED)], participants: [{ id: "x", paid: false }] };
  const p = meta.participants[0];
  runReconcile(meta, NOW);
  meta.rounds[0].deadline = OPEN;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1);
  runReconcile(meta, NOW);
  p.paid = true;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1);
  meta.rounds[0].deadline = CLOSED;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "re-closing while paid must not add a second penalty for the same round");
});

test("CASE P: J5 closes unpaid -> 1, reopens, closes again unpaid -> still 1, not 2", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED)], participants: [{ id: "x", paid: false }] };
  const p = meta.participants[0];
  runReconcile(meta, NOW);
  meta.rounds[0].deadline = OPEN;
  meta.rounds[0].deadline = CLOSED;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "the SAME round closing twice must only ever cause its penalty once -- it's already in the ledger");
});

test("CASE Q: J5 closes unpaid -> 1, admin edits deadline back to the future -> stays 1", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED)], participants: [{ id: "x", paid: false }] };
  const p = meta.participants[0];
  runReconcile(meta, NOW);
  meta.rounds[0].deadline = OPEN;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1);
});

test("CASE R: J5+J6 already caused -2, THEN J5 reopens -> stays -2", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED), round("r6", 6, CLOSED)], participants: [{ id: "x", paid: false }] };
  const p = meta.participants[0];
  runReconcile(meta, NOW);
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2);
  meta.rounds[0].deadline = OPEN;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2);
});

test("CASE S: J5/J6 caused 2, reopen J6, mark paid -> 2 frozen forever, surviving further changes", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED), round("r6", 6, CLOSED)], participants: [{ id: "x", paid: false }] };
  const p = meta.participants[0];
  runReconcile(meta, NOW);
  meta.rounds[1].deadline = OPEN;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2, "penalty survives J6 reopening");
  runReconcile(meta, NOW);
  p.paid = true;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2, "frozen at 2 once paid");
  meta.rounds[1].deadline = CLOSED;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2, "still 2 -- J6 re-closing while paid adds nothing");
});

test("a penalized round's contribution survives even after the round is deleted from meta.rounds entirely", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round("r5", 5, CLOSED)], participants: [{ id: "x", paid: false }] };
  const p = meta.participants[0];
  runReconcile(meta, NOW);
  assert.ok(p.penalizedRounds && ("r5" in p.penalizedRounds), "reconciliation must have written r5 into the ledger");
  meta.rounds = [];
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "the ledger entry must still count even though the round object no longer exists");
});

// ---- Configuration respect ----

test("respects the configured pointsPerRound at time of penalization, never hardcodes 1", () => {
  const meta = { paymentPenalty: penalty({ pointsPerRound: 3 }), rounds: [round("r5", 5, CLOSED), round("r6", 6, CLOSED)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: false }, null, NOW), 6);
});

test("changing pointsPerRound later never rewrites an already-ledgered penalty's frozen value", () => {
  const meta = { paymentPenalty: penalty({ pointsPerRound: 1 }), rounds: [round("r5", 5, CLOSED)], participants: [{ id: "x", paid: false }] };
  runReconcile(meta, NOW);
  const p = meta.participants[0];
  meta.paymentPenalty.pointsPerRound = 5;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "the already-ledgered round must keep its original frozen point value");
});

test("respects a custom startsAtRound, never hardcodes 5", () => {
  const meta = { paymentPenalty: penalty({ startsAtRound: 10 }), rounds: [round("r9", 9, CLOSED), round("r10", 10, CLOSED)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: false }, null, NOW), 1, "round 9 is below startsAtRound=10 and must not count");
});

test("penalty disabled entirely -> always 0 regardless of paid status or ledger contents", () => {
  const meta = { paymentPenalty: penalty({ enabled: false }), rounds: [round("r5", 5, CLOSED)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: false, penalizedRounds: { r5: 1 } }, null, NOW), 0);
});

test("disabling then re-enabling the penalty does not lose the ledger -- it resumes counting once re-enabled", () => {
  const meta = { paymentPenalty: penalty({ enabled: false }), rounds: [round("r5", 5, CLOSED)] };
  const p = { paid: false, penalizedRounds: { r5: 1 } };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 0);
  meta.paymentPenalty.enabled = true;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "re-enabling must resume showing the preserved ledger");
});

test("reconcilePenaltyLedger does not accrue new penalties while disabled (no silent background accrual)", () => {
  const meta = { paymentPenalty: penalty({ enabled: false }), rounds: [round("r5", 5, CLOSED)], participants: [{ id: "x", paid: false }] };
  runReconcile(meta, NOW);
  const p = meta.participants[0];
  assert.ok(!p.penalizedRounds || !("r5" in p.penalizedRounds), "no ledger entry should be created while the feature is disabled");
});

// ---- Scoring-surface consistency ----

test("standingsList()/pointsFor()/penaltyFor() all route through the same shared penaltyPointsFor()", () => {
  const standingsListBody = extractFunctionBody(indexSrc, "function standingsList()");
  assert.ok(standingsListBody.includes("penaltyFor(p.id, participantMap)"));
  const pointsForBody = extractFunctionBody(indexSrc, "function pointsFor(participantId, participantMap, cutoffRoundNumber)");
  assert.ok(pointsForBody.includes("penaltyPointsFor(p, cutoffRoundNumber)"));
  const penaltyForBody = extractFunctionBody(indexSrc, "function penaltyFor(participantId, participantMap)");
  assert.ok(penaltyForBody.includes("penaltyPointsFor(p, null)"));
});

test("the platform-panel diagnostic duplicate (pointsForInspect) uses the same ledger model (p.penalizedRounds)", () => {
  const body = extractFunctionBody(indexSrc, "function pointsForInspect(pid, participantMap)");
  assert.ok(body.includes("p.penalizedRounds"));
  assert.ok(!body.includes("p.accruedPenaltyPoints") && !body.includes("p.penaltyCheckpointCount"));
});

test("no leftover reference anywhere to the old checkpoint-count model fields", () => {
  assert.ok(!indexSrc.includes("accruedPenaltyPoints"));
  assert.ok(!indexSrc.includes("penaltyCheckpointCount"));
});

test("no leftover reference to the original buggy formula (resultsPublished combined with payment penalty)", () => {
  assert.ok(!indexSrc.includes("r.resultsPublished && r.number >= penalty.startsAtRound"));
});

// ---- reconcilePenaltyLedger called before every lifecycle action that could un-close a round ----

test("reconcilePenaltyLedger is called before the reopen-round deadline mutation", () => {
  const body = extractFunctionBody(indexSrc, 'const reopenBtn = document.getElementById("qz-reopen-round");');
  const reconcileIdx = body.indexOf("reconcilePenaltyLedger(meta);");
  const deadlineMutationIdx = body.indexOf("round.deadline = newDeadlineIso;");
  assert.ok(reconcileIdx !== -1 && reconcileIdx < deadlineMutationIdx);
});

test("reconcilePenaltyLedger is called before the manual round-editor deadline mutation", () => {
  const body = extractFunctionBody(indexSrc, "if(editingRound){");
  const reconcileIdx = body.indexOf("reconcilePenaltyLedger(meta);");
  const deadlineMutationIdx = body.indexOf("editingRound.deadline = new Date(draft.deadline).toISOString();");
  assert.ok(reconcileIdx !== -1 && reconcileIdx < deadlineMutationIdx);
});

test("reconcilePenaltyLedger is called before deleteRoundWithRollback removes the round from meta.rounds", () => {
  const body = extractFunctionBody(indexSrc, "async function deleteRoundWithRollback(btn, roundId)");
  const reconcileIdx = body.indexOf("reconcilePenaltyLedger(meta);");
  const filterIdx = body.indexOf("meta.rounds = meta.rounds.filter(r => r.id !== roundId);");
  assert.ok(reconcileIdx !== -1 && reconcileIdx < filterIdx);
});
