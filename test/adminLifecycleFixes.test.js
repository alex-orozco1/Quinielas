// AUTO-001.1 Admin Lifecycle Fixes (Grupo A) — structural checks against
// the real public/index.html source for the frontend-only pieces (FIX 1's
// filtering, FIX 2's UI gating, FIX 3's reopen flow) that can't be
// isolate-evaluated the way pure functions can (too many closures over
// module state: meta, round, form, toast, etc. — same documented
// limitation as prior QA rounds). Backend behavioral coverage for FIX 2
// (CASE C/D/E/F/B) lives in test/quinielaMetaGuards.test.js, executing the
// real validateRoundsIntegrity() in isolation. CASE J lives in
// test/autoResults.test.js (already covers published:false exclusion).

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

// ---- CASE A: prepared (published:false) rounds excluded from Resultados ----

test("CASE A: renderAdminResultados derives candidateRounds/closedRounds/dropdown from published !== false, not raw meta.rounds", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  assert.ok(body.includes("meta.rounds.filter(r => r.published !== false)"), "must filter out published:false before anything else");
  assert.ok(body.includes("eligibleRounds.filter(r => !r.resultsPublished)"), "candidateRounds must derive from the filtered set");
  assert.ok(body.includes("eligibleRounds.filter(r => r.resultsPublished)"), "closedRounds must derive from the filtered set");
  assert.ok(body.includes("eligibleRounds.slice().reverse().map"), "the dropdown must list only eligible rounds");
  assert.ok(!body.includes("meta.rounds.filter(r => !r.resultsPublished)"), "must not read raw meta.rounds for candidateRounds anymore");
});

test("Admin -> Jornadas (renderAdminRondas) is untouched by FIX 1 -- still shows every round including prepared ones", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminRondas(body)");
  assert.ok(body.includes("meta.rounds.length ? meta.rounds.slice().reverse()"), "Admin -> Jornadas must keep reading meta.rounds directly, unaffected");
});

// ---- CASE C (frontend): publish button disabled + explained while still open ----

test("CASE C (frontend): stillOpenForVoting uses isRoundLocked(), the SAME closed-definition used for picks/classifyRound, not a new concept", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  assert.ok(body.includes("const stillOpenForVoting = !isPublished && !isRoundLocked(round);"), "must reuse isRoundLocked(), not invent a second temporal concept");
});

test("CASE C (frontend): the publish button is disabled while stillOpenForVoting, regardless of isComplete", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  assert.ok(body.includes('${(isComplete && !stillOpenForVoting) ? "" : "disabled"}'), "the button must require BOTH isComplete AND !stillOpenForVoting to be enabled");
  assert.ok(body.includes("el plazo para votar de esta jornada no ha cerrado"), "must show a clear explanation, not just silently disable");
});

test("CASE C (frontend): the click handler itself also blocks the transition (defense in depth, not just a disabled attribute)", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  // NOTE: "const publishBtn = document.getElementById(...)" appears twice —
  // once inline where a pick-row handler flips its .disabled state, and
  // once as the actual click-handler definition. Anchoring on the
  // definition's own follow-up ("if(publishBtn){") disambiguates the two.
  const publishHandlerIdx = body.indexOf('const publishBtn = document.getElementById("qz-publish-results");\n    if(publishBtn){');
  assert.ok(publishHandlerIdx !== -1, "could not locate the actual publish click-handler definition");
  const handlerSlice = body.slice(publishHandlerIdx, publishHandlerIdx + 1200);
  assert.ok(handlerSlice.includes("if(stillOpenForVoting){"), "the click handler must re-check stillOpenForVoting, not trust the disabled attribute alone");
});

// ---- CASE F/correction: "Guardar borrador" is never blocked by the deadline guard (only official publish is) ----

test("Guardar borrador is not gated by stillOpenForVoting -- drafting ahead of the deadline remains allowed", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  const saveDraftIdx = body.indexOf('id="qz-save-draft"');
  const publishIdx = body.indexOf('id="qz-publish-results"');
  const saveDraftMarkup = body.slice(saveDraftIdx - 20, saveDraftIdx + 100);
  assert.ok(!saveDraftMarkup.includes("stillOpenForVoting"), "the draft-save button's markup must not reference the open/closed gate");
  assert.ok(saveDraftIdx < publishIdx, "sanity: draft button precedes publish button in the markup");
});

// ---- CASE G/H/I: reopen must set a real future deadline, chosen by the admin, atomically ----

test("CASE G/H: qzPromptDeadline never resolves with a past/invalid date -- keeps the modal open and shows an inline error instead", () => {
  const body = extractFunctionBody(indexSrc, "function qzPromptDeadline(message, opts)");
  assert.ok(body.includes("chosenMs <= serverNow()"), "must compare against serverNow(), the same clock used elsewhere for deadlines");
  assert.ok(body.includes("La nueva fecha límite debe ser en el futuro."), "must show a clear inline validation message");
  assert.ok(!/return\s+cleanup\(null\)/.test(body.slice(body.indexOf("const submit"), body.indexOf("const onKey"))), "the submit path must never silently resolve null on an invalid date -- it must show the error and keep the modal open");
});

test("CASE H: reopen does not invent a deadline -- no automatic +24h/tomorrow anywhere in the flow", () => {
  const body = extractFunctionBody(indexSrc, "function qzPromptDeadline(message, opts)");
  assert.ok(!/86400000|\+\s*1\s*\*\s*24|setDate\(.*\+\s*1\)/.test(body), "must not auto-add a day or any fixed offset -- the admin always picks the exact date/time");
});

test("CASE I: reopen rolls back BOTH resultsPublished and deadline together on save failure -- never a stale success toast", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  const reopenIdx = body.indexOf('const reopenBtn = document.getElementById("qz-reopen-round");');
  const reopenSlice = body.slice(reopenIdx, reopenIdx + 2400);
  assert.ok(reopenSlice.includes("const previousResultsPublished = round.resultsPublished;"), "must snapshot the previous resultsPublished before mutating");
  assert.ok(reopenSlice.includes("const previousDeadline = round.deadline;"), "must snapshot the previous deadline before mutating");
  assert.ok(reopenSlice.includes("round.resultsPublished = previousResultsPublished;"), "failure path must restore resultsPublished");
  assert.ok(reopenSlice.includes("round.deadline = previousDeadline;"), "failure path must restore deadline");
  const successToastIdx = reopenSlice.indexOf('toast("🔓 Jornada reabierta');
  const resultOkIdx = reopenSlice.indexOf("if(result.ok){");
  assert.ok(resultOkIdx !== -1 && successToastIdx > resultOkIdx, "the success toast must be gated behind a confirmed successful save, not shown optimistically");
});

test("CASE H: reopen requires setMetaWithError (real success/failure signal), not the boolean-only setMeta", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  const reopenIdx = body.indexOf('const reopenBtn = document.getElementById("qz-reopen-round");');
  const reopenSlice = body.slice(reopenIdx, reopenIdx + 2400);
  assert.ok(reopenSlice.includes("await setMetaWithError(meta);"), "must use the error-aware save so failure can be distinguished from success");
});

test("reopen cancels cleanly (no toast, no mutation) if the admin cancels the new-deadline prompt", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  const reopenIdx = body.indexOf('const reopenBtn = document.getElementById("qz-reopen-round");');
  const reopenSlice = body.slice(reopenIdx, reopenIdx + 2400);
  assert.ok(reopenSlice.includes("if(newDeadlineIso === null) return;"), "cancelling the deadline prompt must exit before any mutation happens");
});

// ---- Real E2E bug found via Playwright: the live pick-click incremental
// update path also re-enables the publish button, must respect
// stillOpenForVoting too, not just completeness ----

test("CASE C (live update path): the pick-click handler's incremental disabled-state update also respects stillOpenForVoting, not just completeness", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  const nowCompleteIdx = body.indexOf("const nowComplete = round.matches.every");
  assert.ok(nowCompleteIdx !== -1, "could not locate the incremental pick-click update block");
  const slice = body.slice(nowCompleteIdx, nowCompleteIdx + 300);
  assert.ok(slice.includes("publishBtn.disabled = !(nowComplete && !stillOpenForVoting);"), "the live incremental update must factor in stillOpenForVoting too, or completing all picks on a still-open round silently re-enables the button");
});
