// UX-ADM-006 (Admin -> Participantes) + UX-ADM-007 (Eliminar Jornada) —
// persistence reliability: every mutation handler must depend on a REAL
// confirmed write (setMetaWithError, not the boolean-only setMeta) before
// showing success, and must roll back completely on failure.
//
// public/index.html is a monolithic SPA without jsdom — these are
// structural checks against the real source (same precedent as prior
// rounds: extractFunctionBody + assertions on control flow order), plus
// real E2E/failure-injection coverage lives in
// test/adminPersistenceE2E.manual-notes.md and was run against a real
// server (see delivery report) — DOM-level structural checks alone would
// not prove failure-path behavior, so this file focuses on confirming the
// EXACT rollback mechanics (snapshot before mutate, restore on !ok, no
// success feedback before result.ok) are present in the real handlers.

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

const participantesBody = extractFunctionBody(indexSrc, "function renderAdminParticipantes(body)");

// ---- CASE A/B: agregar participante ----

test("CASE A/B: add-participant snapshots before mutating, uses setMetaWithError, and only re-renders/toasts success after result.ok", () => {
  const idx = participantesBody.indexOf('addBtn.addEventListener("click"');
  const slice = participantesBody.slice(idx, idx + 900);
  assert.ok(slice.includes("const snapshot = meta.participants.slice();"), "must snapshot before the optimistic push");
  assert.ok(slice.includes("await setMetaWithError(meta);"), "must use the error-aware save, not the boolean-only setMeta");
  const resultOkIdx = slice.indexOf("if(result.ok){");
  const successToastIdx = slice.indexOf('toast("✅ Listo, el participante quedó agregado.");');
  assert.ok(resultOkIdx !== -1 && successToastIdx > resultOkIdx, "success toast must be gated behind a confirmed result.ok");
  assert.ok(slice.includes("meta.participants = snapshot;"), "failure path must restore the exact prior array");
});

test("CASE A/B: bulk-add rolls back the pushed-but-unpersisted participants on failure (not left dangling in meta)", () => {
  const idx = participantesBody.indexOf('document.getElementById("qz-bulk-add")');
  const slice = participantesBody.slice(idx, idx + 1600);
  assert.ok(slice.includes("const snapshot = meta.participants.slice();"), "must snapshot before pushing any bulk-added participants");
  assert.ok(slice.includes("if(!result.ok){"));
  const failBranch = slice.slice(slice.indexOf("if(!result.ok){"), slice.indexOf("if(!result.ok){") + 450);
  assert.ok(failBranch.includes("meta.participants = snapshot;"), "on failure, the pushed names must be rolled back, not left as phantom local state");
});

// ---- CASE C/D: eliminar participante ----

test("CASE C/D: remove-participant snapshots the full array and restores it (same objects, same order) on failure, never toasts/renders success before result.ok", () => {
  const idx = participantesBody.indexOf('const removeBtn = row.querySelector("[data-role=remove]");');
  const slice = participantesBody.slice(idx, idx + 900);
  assert.ok(slice.includes("const snapshot = meta.participants.slice();"), "must snapshot the full array (preserves order) before filtering");
  assert.ok(slice.includes("await setMetaWithError(meta);"));
  assert.ok(slice.includes("if(result.ok){"));
  assert.ok(slice.includes("renderAdminParticipantes(body);"));
  const failIdx = slice.indexOf("}else{");
  const failSlice = slice.slice(failIdx, failIdx + 200);
  assert.ok(failSlice.includes("meta.participants = snapshot;"), "failure path must restore the full snapshot");
});

// ---- CASE E/F: PIN reset ----

test("CASE E/F: PIN reset snapshots pin+hasPin together and restores both on failure", () => {
  const idx = participantesBody.indexOf('resetBtn.addEventListener("click"');
  const slice = participantesBody.slice(idx, idx + 900);
  assert.ok(slice.includes("const previousPin = p.pin;"));
  assert.ok(slice.includes("const previousHasPin = p.hasPin;"));
  assert.ok(slice.includes("await setMetaWithError(meta);"));
  assert.ok(slice.includes("p.pin = previousPin;") && slice.includes("p.hasPin = previousHasPin;"), "both related fields must be restored together, not just one");
});

// ---- rename / admin-toggle / paid-toggle: also use the reliable pattern ----

test("rename: restores both the meta field AND the visible input value on failure", () => {
  const idx = participantesBody.indexOf("renameInput.addEventListener(\"change\"");
  const slice = participantesBody.slice(idx, idx + 700);
  assert.ok(slice.includes("const previousName = p.name;"));
  assert.ok(slice.includes("await setMetaWithError(meta);"));
  assert.ok(slice.includes("p.name = previousName;") && slice.includes("e.target.value = previousName;"), "must restore both the data model AND the DOM input, since the browser already shows the typed value");
});

test("admin-toggle: restores both meta.isAdmin AND the checkbox's checked state on failure", () => {
  const idx = participantesBody.indexOf("adminCheckbox.addEventListener(\"change\"");
  const slice = participantesBody.slice(idx, idx + 700);
  assert.ok(slice.includes("const previousValue = p.isAdmin;"));
  assert.ok(slice.includes("await setMetaWithError(meta);"));
  assert.ok(slice.includes("p.isAdmin = previousValue;") && slice.includes("e.target.checked = previousValue;"), "must restore both the data model AND the checkbox's own already-flipped DOM state");
});

test("paid-toggle: also upgraded to setMetaWithError with rollback (was previously a silent boolean-only save with no error handling at all)", () => {
  const idx = participantesBody.indexOf("paidCheckbox.addEventListener(\"change\"");
  const slice = participantesBody.slice(idx, idx + 1700);
  assert.ok(slice.includes("const previousValue = p.paid;"));
  assert.ok(slice.includes("await setMetaWithError(meta);"));
  assert.ok(slice.includes("e.target.checked = previousValue;"));
});

// ---- CASE L (QA-corrected): reconciliation can touch MULTIPLE participants'
// permanent penalty ledgers, so rollback must restore the whole
// participants array, not just this one participant's fields ----

test("CASE L: paid-toggle failure restores the FULL participants array (reconcilePenaltyLedger can touch more than one participant's permanent ledger)", () => {
  const idx = participantesBody.indexOf("paidCheckbox.addEventListener(\"change\"");
  const slice = participantesBody.slice(idx, idx + 1700);
  assert.ok(slice.includes("const participantsSnapshot = JSON.parse(JSON.stringify(meta.participants));"), "must deep-snapshot the whole array before reconciling, since reconciliation isn't scoped to just this participant");
  const failIdx = slice.indexOf("if(!result.ok){");
  const failSlice = slice.slice(failIdx, failIdx + 250);
  assert.ok(failSlice.includes("meta.participants = participantsSnapshot;"), "failure must restore the full array, undoing both the paid flip AND any ledger entries reconciliation just promoted");
});

test("paidAt is only set on the false->true transition, not on every save", () => {
  const idx = participantesBody.indexOf("paidCheckbox.addEventListener(\"change\"");
  const slice = participantesBody.slice(idx, idx + 1700);
  assert.ok(slice.includes("if(newValue && !previousValue) p.paidAt = new Date().toISOString();"), "paidAt must only be stamped on the false->true transition");
});

test("reconcilePenaltyLedger runs BEFORE p.paid actually flips, using the OLD state", () => {
  const idx = participantesBody.indexOf("paidCheckbox.addEventListener(\"change\"");
  const slice = participantesBody.slice(idx, idx + 1700);
  const reconcileIdx = slice.indexOf("reconcilePenaltyLedger(meta);");
  const flipIdx = slice.indexOf("p.paid = newValue;");
  assert.ok(reconcileIdx !== -1 && reconcileIdx < flipIdx, "reconciliation must run while p.paid still holds the OLD value, before being reassigned");
});

// ---- No handler in this screen still uses the boolean-only setMeta() ----

test("no mutation handler in renderAdminParticipantes still calls the boolean-only setMeta() -- all upgraded to setMetaWithError", () => {
  assert.ok(!/\bawait setMeta\(meta\)/.test(participantesBody), "every persistent mutation in this screen must use setMetaWithError, not the boolean-only setMeta");
});

// ---- CASE I: double-click guards on button-driven actions ----

test("CASE I: add-participant, remove, and reset-pin buttons disable themselves while the request is in flight", () => {
  assert.ok(participantesBody.includes("addBtn.disabled = true;"), "add-participant button must disable itself during the save");
  assert.ok(/removeBtn\.disabled = true;/.test(participantesBody), "remove button must disable itself during the save");
  assert.ok(/resetBtn\.disabled = true;/.test(participantesBody), "reset-pin button must disable itself during the save");
});

// ---- UX-ADM-007: eliminar jornada ----

const rondaSrc = indexSrc; // deleteRoundWithRollback is module-level, search whole file

test("CASE G/H: deleteRoundWithRollback snapshots the full rounds array, uses setMetaWithError, and only proceeds to render on result.ok", () => {
  const body = extractFunctionBody(rondaSrc, "async function deleteRoundWithRollback(btn, roundId)");
  assert.ok(body.includes("const snapshot = meta.rounds.slice();"), "must snapshot the full array (preserves order+all fields) before filtering");
  assert.ok(body.includes("await setMetaWithError(meta);"));
  assert.ok(body.includes("if(result.ok){"));
  assert.ok(body.includes("meta.rounds = snapshot;"), "failure path must restore the exact prior rounds array, same objects, same order");
  assert.ok(!body.includes("toast(") || body.includes("toast(humanizeError(result.error));"), "no success toast is shown here (existing pattern relies on the re-render itself), but failures must surface a real error message");
});

test("CASE I: deleteRoundWithRollback disables the trigger button while the delete is in flight, re-enables it only on failure", () => {
  const body = extractFunctionBody(rondaSrc, "async function deleteRoundWithRollback(btn, roundId)");
  assert.ok(body.includes("btn.disabled = true;"));
  const failIdx = body.indexOf("}else{");
  const failSlice = body.slice(failIdx, failIdx + 150);
  assert.ok(failSlice.includes("btn.disabled = false;"), "must re-enable the button on failure so the admin can retry -- a successful delete removes the row/re-renders instead, no re-enable needed there");
});

test("'Eliminar jornada' has exactly ONE wiring, through deleteRoundWithRollback", () => {
  // MON-002B: there used to be two identical wirings because the screen had
  // a second, payment-blocked rendering path that re-wired the few actions
  // still allowed while blocked. That client-side gate is gone -- it was
  // never enforced server-side, so it only hid the form from honest people
  // -- and with it the duplicate wiring. One entry point now, same helper.
  const occurrences = indexSrc.split("deleteRoundWithRollback(btn, btn.dataset.delRound)").length - 1;
  assert.equal(occurrences, 1, "one entry point, going through the shared helper rather than duplicating the logic");
});

test("deleteRoundWithRollback keeps the existing confirmation dialog copy unchanged", () => {
  const body = extractFunctionBody(rondaSrc, "async function deleteRoundWithRollback(btn, roundId)");
  assert.ok(body.includes("Se van a borrar los partidos y cualquier resultado capturado en esta jornada. Esta acción no se puede deshacer."), "confirmation copy must be unchanged -- no redesign");
});
