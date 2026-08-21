// Payment Penalty Persistence — Cases A-M, executing the REAL
// penaltyPointsFor()/isRoundEligibleForPenalty() extracted from production,
// not a reimplementation. Deadline-based (isRoundLocked), never
// resultsPublished-based — matches the ticket's explicit requirement that
// a penalty is caused the moment QRACKS' own deadline passes, independent
// of when/whether results get captured or published.

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

// isRoundLocked() and penaltyPointsFor()/isRoundEligibleForPenalty() are
// module-scope functions in the same closure; extract all three together
// so penaltyPointsFor's internal call to isRoundLocked resolves correctly,
// and wire `meta`/`serverNow` as controlled inputs.
function runPenaltyPointsFor(meta, p, cutoffRoundNumber, nowMs){
  const isRoundLockedSrc = extractFunctionBody(indexSrc, "function isRoundLocked(round)");
  const isRoundEligibleSrc = extractFunctionBody(indexSrc, "function isRoundEligibleForPenalty(round, penalty)");
  const penaltyPointsForSrc = extractFunctionBody(indexSrc, "function penaltyPointsFor(p, cutoffRoundNumber)");
  const wrapped = new Function("meta", "p", "cutoffRoundNumber", "serverNow", `
    ${isRoundLockedSrc}
    ${isRoundEligibleSrc}
    ${penaltyPointsForSrc}
    return penaltyPointsFor(p, cutoffRoundNumber);
  `);
  return wrapped(meta, p, cutoffRoundNumber, () => nowMs);
}

const NOW = new Date("2026-08-20T12:00:00.000Z").getTime();
const OPEN = "2099-01-01T00:00:00.000Z"; // deadline in the future relative to NOW
const CLOSED = "2020-01-01T00:00:00.000Z"; // deadline in the past relative to NOW

function round(number, deadline, resultsPublished){
  return { number, deadline, resultsPublished: !!resultsPublished, published: true };
}
function penalty(overrides){
  return { enabled: true, startsAtRound: 5, pointsPerRound: 1, ...overrides };
}

test("CASE A: J5 still open, unpaid -> penalty 0", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round(5, OPEN)] };
  const p = { paid: false };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 0);
});

test("CASE B: J5 closed, unpaid -> penalty -1 (does NOT require resultsPublished)", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED, false)] };
  const p = { paid: false };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1);
});

test("CASE C: J5 closed + J6 open, unpaid -> penalty -1", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, OPEN)] };
  const p = { paid: false };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1);
});

test("CASE D: J5+J6 both closed, unpaid -> penalty -2", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, CLOSED)] };
  const p = { paid: false };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2);
});

test("CASE E: J5 closed unpaid, THEN checkpointed+paid -> penalty stays -1", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED)] };
  // Simulates the checkpoint the paid-toggle handler performs BEFORE flipping paid:
  const pBeforeToggle = { paid: false };
  const accruedAtToggle = runPenaltyPointsFor(meta, pBeforeToggle, null, NOW);
  const p = { paid: true, accruedPenaltyPoints: accruedAtToggle, penaltyCheckpointCount: 1 };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1);
});

test("CASE F: J5+J6 closed unpaid, checkpointed+paid after J6, THEN J7 closes -> stays -2 (not -3, not 0)", () => {
  const metaAtCheckpoint = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, CLOSED)] };
  const accrued = runPenaltyPointsFor(metaAtCheckpoint, { paid: false }, null, NOW);
  const checkpointCount = 2; // 2 eligible closed rounds at checkpoint time
  const p = { paid: true, accruedPenaltyPoints: accrued, penaltyCheckpointCount: checkpointCount };
  // Now J7 also closes, while still paid:
  const metaAfterJ7 = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, CLOSED), round(7, CLOSED)] };
  assert.equal(runPenaltyPointsFor(metaAfterJ7, p, null, NOW), 2);
});

test("CASE G: participant pays BEFORE J5's deadline -> J5 never penalizes", () => {
  // Paid before J5 closes: checkpoint happened while J5 was still open (0 eligible closed rounds).
  const p = { paid: true, accruedPenaltyPoints: 0, penaltyCheckpointCount: 0 };
  const meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED)] }; // J5 closes AFTER they'd already paid
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 0);
});

test("CASE H: J5 closes unpaid (-1), pays before J6 closes -> J5=-1, J6=0, total=-1", () => {
  const metaAtJ5Close = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, OPEN)] };
  const accrued = runPenaltyPointsFor(metaAtJ5Close, { paid: false }, null, NOW);
  const p = { paid: true, accruedPenaltyPoints: accrued, penaltyCheckpointCount: 1 };
  const metaAfterJ6Closes = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, CLOSED)] };
  assert.equal(runPenaltyPointsFor(metaAfterJ6Closes, p, null, NOW), 1);
});

test("CASE I: results-independence -- J5 closed+unpaid penalizes regardless of resultsPublished, before AND after publication", () => {
  const metaBeforeResults = { paymentPenalty: penalty(), rounds: [round(5, CLOSED, false)] };
  const p = { paid: false };
  assert.equal(runPenaltyPointsFor(metaBeforeResults, p, null, NOW), 1);
  const metaAfterResults = { paymentPenalty: penalty(), rounds: [round(5, CLOSED, true)] };
  assert.equal(runPenaltyPointsFor(metaAfterResults, p, null, NOW), 1);
});

test("CASE J: legacy paid (paid:true, no accrued/checkpoint fields at all) -> historical penalty 0, never inferred", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, CLOSED)] };
  const p = { paid: true }; // no accruedPenaltyPoints, no penaltyCheckpointCount -- true legacy shape
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 0);
});

test("CASE K: legacy unpaid (paid:false, no accrued/checkpoint fields) with J5+J6 already closed -> full live penalty applies", () => {
  const meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, CLOSED)] };
  const p = { paid: false }; // legacy shape, defaults to 0/0
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2);
});

test("CASE M: false->true->false->true across closing rounds never double-counts, never erases, never counts rounds closed while paid", () => {
  // J5 closes while unpaid.
  let meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED)] };
  let p = { paid: false };
  // toggle to paid: checkpoint under OLD (unpaid) state
  p.accruedPenaltyPoints = runPenaltyPointsFor(meta, p, null, NOW);
  p.penaltyCheckpointCount = meta.rounds.filter(r => r.number >= 5 && CLOSED === r.deadline).length; // =1
  p.paid = true;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "after first toggle to paid, penalty is 1");

  // J6 closes while paid -- must not add anything while still paid.
  meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, CLOSED)] };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "J6 closing while paid must not increase the penalty");

  // toggle back to unpaid: checkpoint under OLD (paid) state -- accrued stays 1, watermark advances to 2 (J5+J6 now closed)
  const accruedBeforeSecondToggle = runPenaltyPointsFor(meta, p, null, NOW); // still 1 (frozen, paid)
  p.accruedPenaltyPoints = accruedBeforeSecondToggle;
  p.penaltyCheckpointCount = meta.rounds.length; // 2 eligible closed rounds now
  p.paid = false;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "immediately after toggling back to unpaid, penalty is still just 1 -- J6 never counted");

  // J7 closes while unpaid (second unpaid interval) -- only this one should add.
  meta = { paymentPenalty: penalty(), rounds: [round(5, CLOSED), round(6, CLOSED), round(7, CLOSED)] };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2, "only J7 (closed during the SECOND unpaid interval) adds to the total -- final is 2, not 3, not 0");

  // toggle to paid again: freeze at 2.
  p.accruedPenaltyPoints = runPenaltyPointsFor(meta, p, null, NOW);
  p.penaltyCheckpointCount = meta.rounds.length;
  p.paid = true;
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 2, "final frozen total after the whole false->true->false->true sequence is 2");
});

test("respects the configured pointsPerRound, never hardcodes 1", () => {
  const meta = { paymentPenalty: penalty({ pointsPerRound: 3 }), rounds: [round(5, CLOSED), round(6, CLOSED)] };
  const p = { paid: false };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 6);
});

test("respects a custom startsAtRound, never hardcodes 5", () => {
  const meta = { paymentPenalty: penalty({ startsAtRound: 10 }), rounds: [round(9, CLOSED), round(10, CLOSED)] };
  const p = { paid: false };
  assert.equal(runPenaltyPointsFor(meta, p, null, NOW), 1, "round 9 is below startsAtRound=10 and must not count");
});

test("penalty disabled entirely -> always 0 regardless of paid status", () => {
  const meta = { paymentPenalty: penalty({ enabled: false }), rounds: [round(5, CLOSED)] };
  assert.equal(runPenaltyPointsFor(meta, { paid: false }, null, NOW), 0);
});

// ---- Scoring-surface consistency: single source of truth ----

test("standingsList() (Tabla, Compartir, platform final standings) and pointsFor() (Historial cutoff snapshots) both route through the same penaltyPointsFor()", () => {
  const standingsListBody = extractFunctionBody(indexSrc, "function standingsList()");
  assert.ok(standingsListBody.includes("penaltyFor(p.id, participantMap)"), "standingsList must use penaltyFor for its displayed penalty badge");
  const pointsForBody = extractFunctionBody(indexSrc, "function pointsFor(participantId, participantMap, cutoffRoundNumber)");
  assert.ok(pointsForBody.includes("penaltyPointsFor(p, cutoffRoundNumber)"), "pointsFor must subtract via the shared penaltyPointsFor, not a duplicated inline formula");
  const penaltyForBody = extractFunctionBody(indexSrc, "function penaltyFor(participantId, participantMap)");
  assert.ok(penaltyForBody.includes("penaltyPointsFor(p, null)"), "penaltyFor must delegate to the same shared function too");
});

test("the platform-panel diagnostic duplicate (pointsForInspect) uses the same deadline-based, checkpoint-based model, not the old resultsPublished/paid-only formula", () => {
  const body = extractFunctionBody(indexSrc, "function pointsForInspect(pid, participantMap)");
  assert.ok(body.includes("isRoundLocked(r)"), "must use the same deadline-based closed check as the main app");
  assert.ok(!body.includes("r.resultsPublished && r.number >= penalty.startsAtRound"), "must not still use the old resultsPublished-based formula");
  assert.ok(body.includes("p.accruedPenaltyPoints") && body.includes("p.penaltyCheckpointCount"), "must use the same checkpoint fields, so it never disagrees with what participants/admins see in the real app");
});

test("no leftover reference to the old buggy formula (r.resultsPublished combined with payment penalty) anywhere in the file", () => {
  // The old bug: `r.resultsPublished && r.number >= penalty.startsAtRound` — confirm it's gone everywhere.
  assert.ok(!indexSrc.includes("r.resultsPublished && r.number >= penalty.startsAtRound"));
});
