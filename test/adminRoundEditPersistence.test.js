// UX-ADM: Admin -> Jornadas -> Editar -- reliable persistence + full
// rollback. Same P1 pattern already applied to Participantes/Eliminar
// jornada/Reabrir jornada/Payment Penalty config. public/index.html is a
// monolithic SPA without jsdom -- these are structural checks against the
// real handler source (same precedent as prior rounds), confirming the
// EXACT mechanics (deep snapshot before mutation, full array-level
// restore on failure, reconcile-before-deadline-move preserved, button
// disabled during save, no success feedback before result.ok) rather than
// just searching for the string "setMetaWithError".

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractHandlerBody(source, anchor, windowSize){
  const idx = source.indexOf(anchor);
  assert.ok(idx !== -1, `could not locate anchor "${anchor}"`);
  return source.slice(idx, idx + windowSize);
}

// The "if(editingRound){" branch inside the qz-publish-round click handler.
const editHandler = extractHandlerBody(indexSrc, "if(editingRound){", 2700);

test("CASE C/D/G: deep-snapshots the ENTIRE round object before any mutation, not just matches/deadline", () => {
  assert.ok(editHandler.includes("const roundSnapshot = JSON.parse(JSON.stringify(editingRound));"), "must deep-clone the whole round -- a shallow {matches, deadline} snapshot would silently drop published/provider/externalRoundId/results/resultsPublished/customBetResults etc.");
  const snapshotIdx = editHandler.indexOf("const roundSnapshot = JSON.parse(JSON.stringify(editingRound));");
  const mutationIdx = editHandler.indexOf("editingRound.matches = clean;");
  assert.ok(snapshotIdx < mutationIdx, "the snapshot must be taken BEFORE any field is mutated");
});

test("CASE G: also deep-snapshots meta.participants BEFORE reconcilePenaltyLedger runs, so the round-edit + reconciliation are rolled back together", () => {
  const snapshotIdx = editHandler.indexOf("const participantsSnapshot = JSON.parse(JSON.stringify(meta.participants));");
  const reconcileIdx = editHandler.indexOf("reconcilePenaltyLedger(meta);");
  assert.ok(snapshotIdx !== -1 && reconcileIdx !== -1 && snapshotIdx < reconcileIdx, "participants must be snapshotted before reconciliation can mutate any participant's penalizedRounds ledger");
});

test("reconcilePenaltyLedger is still called before the deadline actually moves (payment-penalty atomicity preserved)", () => {
  const reconcileIdx = editHandler.indexOf("reconcilePenaltyLedger(meta);");
  const deadlineMutationIdx = editHandler.indexOf("editingRound.deadline = new Date(draft.deadline).toISOString();");
  assert.ok(reconcileIdx !== -1 && deadlineMutationIdx !== -1 && reconcileIdx < deadlineMutationIdx, "reconciliation must still run before the deadline mutation, exactly as the payment-penalty fix requires");
});

test("uses setMetaWithError (real success/failure signal), not the boolean-only setMeta", () => {
  assert.ok(editHandler.includes("await setMetaWithError(meta);"));
  assert.ok(!editHandler.includes("await setMeta(meta);"), "must not still use the boolean-only save");
});

test("CASE C/D/G: on failure, restores the round to its exact snapshot AND restores the full participants array -- never a partial rollback", () => {
  const failIdx = editHandler.indexOf("} else {");
  assert.ok(failIdx !== -1, "could not locate the failure branch");
  const failSlice = editHandler.slice(failIdx, failIdx + 500);
  assert.ok(failSlice.includes("meta.rounds = meta.rounds.map(r => r.id === editingRound.id ? roundSnapshot : r);"), "must replace the edited round with its pristine snapshot, leaving every other round untouched by reference");
  assert.ok(failSlice.includes("meta.participants = participantsSnapshot;"), "must restore the full participants array too, undoing reconciliation's ledger writes");
});

test("no success toast/exit-edit-mode happens before result.ok is confirmed true", () => {
  const resultOkIdx = editHandler.indexOf("if(result.ok){");
  const successToastIdx = editHandler.indexOf('toast("✅ Listo, la Jornada " + editingRound.number + " quedó actualizada.");');
  assert.ok(resultOkIdx !== -1 && successToastIdx > resultOkIdx, "the success toast must be gated behind a confirmed successful save");
});

test("CASE H (double submit): the save button disables itself before the async save, preventing a second concurrent submit", () => {
  const disableIdx = editHandler.indexOf("saveBtn.disabled = true;");
  const awaitIdx = editHandler.indexOf("await setMetaWithError(meta);");
  assert.ok(disableIdx !== -1 && disableIdx < awaitIdx, "must disable the button before starting the save request");
});

test("on failure, the form re-renders (fresh button, draft rebuilt from the restored round) so the admin can retry -- not left in a stuck/disabled state", () => {
  const failIdx = editHandler.indexOf("} else {");
  const failSlice = editHandler.slice(failIdx, failIdx + 900);
  assert.ok(failSlice.includes("renderAdminRondas._draft = null;"), "must clear the cached draft so it rebuilds from the restored (rolled-back) round, not the failed edit");
  assert.ok(failSlice.includes("renderAdminRondas(body);"), "must re-render so a fresh, enabled Guardar button replaces the disabled one");
  assert.ok(!failSlice.includes("_editingId = null"), "failure must NOT exit edit mode -- the admin stays on the same editor to retry");
});

test("failure shows a real, humanized error message, not a generic hardcoded string", () => {
  const failIdx = editHandler.indexOf("} else {");
  const failSlice = editHandler.slice(failIdx, failIdx + 900);
  assert.ok(failSlice.includes("toast(humanizeError(result.error));"), "must surface the actual error via the existing humanizeError() pattern");
  assert.ok(!failSlice.includes('"No se pudo guardar, intenta otra vez"'), "the old generic hardcoded message must be gone");
});

// ---- CASE J: editing must never publish an unpublished round (published field untouched) ----

test("CASE J: the edit handler never assigns editingRound.published -- editing a prepared/unpublished round must not publish it", () => {
  assert.ok(!editHandler.includes("editingRound.published ="), "editing must never touch the published flag -- only Publicar jornada does that");
});

// ---- CASE K: editing must never touch results/resultsPublished ----

test("CASE K: the edit handler never assigns editingRound.results or resultsPublished -- editing a round with existing results must not affect them", () => {
  assert.ok(!editHandler.includes("editingRound.results ="), "editing must never overwrite captured results");
  assert.ok(!editHandler.includes("editingRound.resultsPublished ="), "editing must never touch resultsPublished -- only the results-publish/reopen flows do that");
});

// ---- CASE E: metadata preservation is a direct consequence of the deep-snapshot + only-mutate-matches-and-deadline approach ----

test("CASE E: the handler only ever mutates .matches and .deadline on the round -- provider/externalRoundId/kickoffAt and any other imported metadata is never touched, so it survives untouched on both success and rollback", () => {
  const assignmentPattern = /editingRound\.(\w+)\s*=/g;
  const assignedFields = new Set();
  let match;
  while ((match = assignmentPattern.exec(editHandler)) !== null) {
    assignedFields.add(match[1]);
  }
  assert.deepEqual([...assignedFields].sort(), ["deadline", "matches"], "the edit handler must only ever assign .matches and .deadline on the round object -- any other field must be left completely alone");
});
