// Admin -> Jornadas: deadline-in-the-past protection (reuses
// isSetupDeadlineValid, does not duplicate it) + removal of the old
// pre-creation pricing copy from /crear. Structural + behavioral checks
// against the REAL handler source, same extraction pattern already
// established in test/adminSetupContinuity.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  const braceStart = signature.trimEnd().endsWith("{") ? start + signature.length - 1 : source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

function runIsSetupDeadlineValid(deadlineInputValue, nowMs){
  const body = extractFunctionBody(indexSrc, "function isSetupDeadlineValid(deadlineInputValue, nowMs)");
  const fn = new Function(`return function isSetupDeadlineValid(deadlineInputValue, nowMs)${body.slice(body.indexOf("{"))}`)();
  return fn(deadlineInputValue, nowMs);
}

const NOW = new Date("2026-08-22T15:00:00.000Z").getTime();

// ---- FIX 1: reuses the SAME function as Admin Setup Continuity, not a duplicate ----

test("Admin -> Jornadas' publish-round click handler reuses isSetupDeadlineValid directly -- no new/duplicated date-validation function was introduced", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-publish-round").addEventListener("click"');
  const body = indexSrc.slice(idx, idx + 1400);
  assert.ok(body.includes("isSetupDeadlineValid(draft.deadline, serverNow())"), "must call the existing shared helper");
  const occurrences = [...indexSrc.matchAll(/function isSetupDeadlineValid\(deadlineInputValue, nowMs\)\{/g)];
  assert.equal(occurrences.length, 1, "isSetupDeadlineValid must be defined exactly once in the whole file");
});

// ---- CASE A/B/C behavioral ----

test("CASE A: yesterday is rejected", () => {
  const yesterday = new Date(NOW - 24*3600*1000);
  const pad = n => String(n).padStart(2,"0");
  const val = `${yesterday.getUTCFullYear()}-${pad(yesterday.getUTCMonth()+1)}-${pad(yesterday.getUTCDate())}T${pad(yesterday.getUTCHours())}:${pad(yesterday.getUTCMinutes())}`;
  assert.equal(runIsSetupDeadlineValid(val, NOW), false);
});

test("CASE B: today but an already-past hour is rejected", () => {
  assert.equal(runIsSetupDeadlineValid("2026-08-22T14:00", NOW + 1), false);
});

test("CASE C: a genuine future datetime is accepted", () => {
  assert.equal(runIsSetupDeadlineValid("2099-01-01T18:00", NOW), true);
});

// ---- Structural: validation happens BEFORE any mutation ----

test("CASE D/E: the deadline validation runs BEFORE the editingRound branch's reconcilePenaltyLedger/mutation, and before the create-new-round branch's meta.rounds.push", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-publish-round").addEventListener("click"');
  const body = indexSrc.slice(idx, idx + 4300);
  const validateIdx = body.indexOf("isSetupDeadlineValid(draft.deadline, serverNow())");
  const reconcileIdx = body.indexOf("reconcilePenaltyLedger(meta);");
  const pushIdx = body.indexOf("meta.rounds.push(round);");
  assert.ok(validateIdx !== -1 && reconcileIdx !== -1 && pushIdx !== -1);
  assert.ok(validateIdx < reconcileIdx, "validation must run before reconcilePenaltyLedger/editingRound mutation");
  assert.ok(validateIdx < pushIdx, "validation must run before the new round is pushed");
});

test("CASE D: on a past deadline, editingRound itself is never touched (not even entered) -- the original round stays completely intact", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-publish-round").addEventListener("click"');
  const body = indexSrc.slice(idx, idx + 1200);
  const validateBlockIdx = body.indexOf("if(!isSetupDeadlineValid(draft.deadline, serverNow())){");
  const editingRoundIdx = body.indexOf("if(editingRound){");
  assert.ok(validateBlockIdx !== -1 && editingRoundIdx !== -1 && validateBlockIdx < editingRoundIdx);
});

// ---- CASE G: inline error, never clearing typed data ----

test("CASE G: the exact required inline copy is shown via a real DOM error element, not toast alone -- and nothing about matches/deadline/published is reset alongside it", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-publish-round").addEventListener("click"');
  const body = indexSrc.slice(idx, idx + 1200);
  assert.ok(body.includes('deadlineErrorEl.textContent = "Elige una fecha y hora a partir de ahora.";'));
  assert.ok(body.includes("deadlineErrorEl.style.display = \"block\";"));
  const errBlockIdx = body.indexOf("if(!isSetupDeadlineValid");
  const errBlockEnd = body.indexOf("return;", errBlockIdx);
  const errBlock = body.slice(errBlockIdx, errBlockEnd);
  assert.ok(!errBlock.includes("draft.matches"), "must never clear match data alongside this error");
  assert.ok(!errBlock.includes("draft.deadline = "), "must never clear the typed deadline alongside this error");
  assert.ok(!errBlock.includes(".published"), "must never touch the published flag alongside this error");
});

test("qz-deadline-error is a real DOM element rendered in the form, not just referenced in the handler", () => {
  assert.ok(indexSrc.includes('<p class="muted" id="qz-deadline-error" style="color:var(--red);display:none;margin-top:4px;"></p>'));
});

test("the datetime-local input has a min attribute computed from serverNow(), same helper pattern as Admin Setup Continuity", () => {
  assert.ok(indexSrc.includes('<input type="datetime-local" id="qz-deadline" value="${draft.deadline}" min="${toLocalInputValue(new Date(serverNow()).toISOString())}">'));
});

// ---- Payment Penalty invariant preserved exactly ----

test("Payment Penalty audit: reconcilePenaltyLedger(meta) is still called before editingRound.deadline mutation, unaffected by adding the new validation", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-publish-round").addEventListener("click"');
  const body = indexSrc.slice(idx, idx + 4300);
  const reconcileIdx = body.indexOf("reconcilePenaltyLedger(meta);");
  const deadlineMutationIdx = body.indexOf("editingRound.deadline = new Date(draft.deadline).toISOString();");
  assert.ok(reconcileIdx !== -1 && deadlineMutationIdx !== -1 && reconcileIdx < deadlineMutationIdx);
});

test("the existing full-snapshot rollback (round + participants) on save failure is untouched by this fix", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-publish-round").addEventListener("click"');
  const body = indexSrc.slice(idx, idx + 4300);
  assert.ok(body.includes("const roundSnapshot = JSON.parse(JSON.stringify(editingRound));"));
  assert.ok(body.includes("const participantsSnapshot = JSON.parse(JSON.stringify(meta.participants));"));
});

// ---- FIX 2: old pre-creation pricing copy removed from /crear ----

test("FIX 2: the old pre-creation pricing copy is completely gone from /crear's renderCrear()", () => {
  const body = extractFunctionBody(indexSrc, "async function renderCrear()");
  assert.ok(!body.includes("Gratis las primeras"));
  assert.ok(!body.includes("MXN por participante para toda la quiniela"));
});

test("FIX 2: no replacement price/TBD/pricing-explanation copy was added in its place", () => {
  const body = extractFunctionBody(indexSrc, "async function renderCrear()");
  assert.ok(!/pr[oó]ximamente/i.test(body));
  assert.ok(!/\$\d/.test(body), "no hardcoded price string should appear in the create flow");
});

test("FIX 2: renderCrear no longer fetches platform settings it doesn't use anymore", () => {
  const body = extractFunctionBody(indexSrc, "async function renderCrear()");
  assert.ok(!body.includes("getPlatformSettings()"), "must not keep an unused network call now that its only use (the pricing line) is gone");
});

test("the SAME old pricing copy does not appear anywhere else in the file", () => {
  const occurrences = [...indexSrc.matchAll(/Gratis las primeras.*jornadas\. Después/g)];
  assert.equal(occurrences.length, 0, "the exact old pricing sentence must not exist anywhere in the file anymore");
});
