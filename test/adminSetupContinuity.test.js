// Admin post-creation continuity — executes the REAL resolveSetupDestination()
// extracted verbatim from public/index.html, plus structural checks
// confirming the reentry/anti-trap wiring described in the ticket.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  // If the signature itself already ends at the body-opening brace (e.g.
  // a destructured-parameter function like "function f({ a, b }){"), use
  // THAT exact brace -- otherwise source.indexOf("{", start) would find
  // the destructuring pattern's own opening brace first and mis-count
  // depth from there instead of from the real function body.
  const braceStart = signature.trimEnd().endsWith("{") ? start + signature.length - 1 : source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

function runResolveSetupDestination(meta, user){
  const body = extractFunctionBody(indexSrc, "function resolveSetupDestination(m, user)");
  const fn = new Function(`return function resolveSetupDestination(m, user)${body.slice(body.indexOf("{"))}`)();
  return fn(meta, user);
}

const admin = { id: "p1", isAdmin: true, hasPin: true };
const participant = { id: "p2", isAdmin: false, hasPin: true };

function round(number, published){ return { id: "r"+number, number, published, matches: [] }; }

test("no rounds at all -> manual", () => {
  const meta = { rounds: [], participants: [admin] };
  assert.equal(runResolveSetupDestination(meta, admin), "manual");
});

test("rounds exist, none published -> review", () => {
  const meta = { rounds: [round(1, false), round(2, false)], participants: [admin] };
  assert.equal(runResolveSetupDestination(meta, admin), "review");
});

test("a published round, admin still the only participant -> invite", () => {
  const meta = { rounds: [round(1, true)], participants: [admin] };
  assert.equal(runResolveSetupDestination(meta, admin), "invite");
});

test("a published round AND another participant exists -> app (normal, no more continuity)", () => {
  const meta = { rounds: [round(1, true)], participants: [admin, participant] };
  assert.equal(runResolveSetupDestination(meta, admin), "app");
});

test("a published round exists alongside OTHER still-unpublished rounds -> never 'review' again, resolves via the published-round path", () => {
  const meta = { rounds: [round(1, true), round(2, false), round(3, false)], participants: [admin] };
  const dest = runResolveSetupDestination(meta, admin);
  assert.notEqual(dest, "review");
  assert.notEqual(dest, "manual");
  assert.equal(dest, "invite");
});

test("documented limitation: 0 current rounds always resolves to manual regardless of history (acceptable, since the only way to reach it is the admin deleting their own only published round, and 'prepare your first round' remains a coherent screen either way)", () => {
  const meta = { rounds: [], participants: [admin, participant] };
  assert.equal(runResolveSetupDestination(meta, admin), "manual");
});

test("CASE S: legacy round (published undefined) counts as published -- never misread as still-preparing", () => {
  const meta = { rounds: [{ id: "r1", number: 1, matches: [] }], participants: [admin, participant] };
  assert.equal(runResolveSetupDestination(meta, admin), "app");
});

test("CASE S: an established legacy quiniela (many published rounds, many participants) never enters review/manual/invite", () => {
  const meta = {
    rounds: [round(1, true), round(2, true), round(3, true)],
    participants: [admin, participant, { id: "p3", isAdmin: false }, { id: "p4", isAdmin: false }],
  };
  assert.equal(runResolveSetupDestination(meta, admin), "app");
});

test("CASE Q: a non-admin participant always resolves to 'app', regardless of quiniela state", () => {
  const meta = { rounds: [], participants: [admin] };
  assert.equal(runResolveSetupDestination(meta, participant), "app");
});

test("no user at all -> app (defensive default, never crashes)", () => {
  const meta = { rounds: [], participants: [admin] };
  assert.equal(runResolveSetupDestination(meta, null), "app");
});

test("CASE F/P: the 'Ver mi jornada' button sets setupContinuityResolved=true BEFORE calling render()", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-setup-view-round").addEventListener("click"');
  const slice = indexSrc.slice(idx, idx + 300);
  const flagIdx = slice.indexOf("setupContinuityResolved = true;");
  const renderIdx = slice.indexOf("render();");
  assert.ok(flagIdx !== -1 && renderIdx !== -1 && flagIdx < renderIdx, "must set the flag before calling render(), otherwise the gate would immediately re-enter the invite screen");
});

test("render()'s admin continuity gate is itself guarded by !setupContinuityResolved", () => {
  const body = extractFunctionBody(indexSrc, "async function render()");
  assert.ok(body.includes("if(currentUser.isAdmin && !setupContinuityResolved){"), "the gate must check the resolved flag, not run unconditionally on every render()");
});

test("CASE F (PIN save failure): the PIN input's value/state is never cleared on a failed apiSetPin call", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminSetupPin()");
  const submitIdx = body.indexOf("const submit = async ()");
  const submitBody = body.slice(submitIdx);
  assert.ok(!submitBody.includes('currentValue = ""'), "must never reset currentValue back to empty on failure");
  assert.ok(!/input\.value\s*=\s*["']{2}/.test(submitBody), "must never clear the actual input element's value on failure");
  assert.ok(submitBody.includes('errorEl.textContent = "No pudimos guardar tu PIN. Intenta de nuevo.";'));
});

test("CASE G: renderAdminSetupReview's publish failure restores the round from a snapshot AND keeps the admin on the same screen", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round, opts)");
  assert.ok(body.includes("const snapshot = JSON.parse(JSON.stringify(liveRound));"), "must snapshot before mutating");
  assert.ok(body.includes('errorEl.textContent = "No pudimos publicar la jornada. Tus cambios siguen aquí.";'));
  assert.ok(!body.includes("renderAdminSetupManual()"), "failure path must not navigate to a different screen");
});

test("QA fix (Blocker 2): every click re-fetches the round CURRENTLY living in meta.rounds by id, never reusing a stale reference across a failed retry", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round, opts)");
  assert.ok(body.includes("const roundId = round.id;"), "must capture the id once, independent of the round object reference");
  assert.ok(body.includes("const liveRound = meta.rounds.find(r => r.id === roundId);"), "must re-look-up the live object fresh on every click, not reuse a captured closure reference");
  assert.ok(!body.includes("round.matches = clean;"), "must never mutate the original stale `round` parameter directly -- only the freshly re-fetched liveRound");
  const failIdx = body.indexOf("} else {");
  const failBody = body.slice(failIdx, failIdx + 400);
  assert.ok(failBody.includes("meta.rounds = meta.rounds.map(r => r.id === roundId ? snapshot : r);"), "rollback must key off the stable roundId, not a stale object reference");
});

test("CASE G: renderAdminSetupManual's publish failure removes only the failed round, keeps typed content for retry", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupManual()");
  assert.ok(body.includes("meta.rounds = meta.rounds.filter(r => r.id !== round.id);"), "must roll back the optimistic push on failure");
  assert.ok(body.includes('errorEl.textContent = "No pudimos publicar la jornada. Tus cambios siguen aquí.";'));
});

test("CASE C: renderAdminSetupResolve AWAITS the sync-competition fetch before deciding review vs manual", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminSetupResolve()");
  const fetchIdx = body.indexOf("await fetch(`/api/quinielas/");
  const destIdx = body.indexOf("const dest = resolveSetupDestination(meta, currentUser);");
  assert.ok(fetchIdx !== -1 && destIdx !== -1 && fetchIdx < destIdx, "the sync fetch must be awaited before resolveSetupDestination runs, closing the described race");
});

test("CASE C: the waiting skeleton is shown BEFORE the sync fetch starts", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminSetupResolve()");
  const waitingIdx = body.indexOf("renderAdminSetupWaiting();");
  const fetchIdx = body.indexOf("await fetch(`/api/quinielas/");
  assert.ok(waitingIdx !== -1 && fetchIdx !== -1 && waitingIdx < fetchIdx);
});

test("CASE D: renderAdminSetupResolve never surfaces reliabilityState/technical text -- any outcome falls through to safe manual fallback", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminSetupResolve()");
  assert.ok(!body.includes("reliabilityState"), "must never inspect/branch on the technical reliabilityState during setup");
  assert.ok(!body.includes("sportsDataFailureMessage"), "must never show the technical failure-category copy during this continuity flow");
});

test("CASE E: the setup PIN input only accepts digits and is capped at 4 characters", () => {
  const body = extractFunctionBody(indexSrc, "function wirePinBoxes(inputId, boxesId, onChange)");
  assert.ok(body.includes('input.value.replace(/\\D/g, "").slice(0, 4)'));
});

test("CASE E: the Continuar button is disabled until exactly 4 digits are entered", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminSetupPin()");
  assert.ok(body.includes("continueBtn.disabled = val.length !== 4;"));
});

test("CASE N: navigator.share()'s catch block does nothing -- cancelling the share sheet must stay silent, not show an error", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupInvite()");
  const shareIdx = body.indexOf("if(navigator.share){");
  const shareBlockEnd = body.indexOf("return;", shareIdx);
  const shareBlock = body.slice(shareIdx, shareBlockEnd);
  const catchIdx = shareBlock.indexOf("catch(e){");
  const catchBody = shareBlock.slice(catchIdx, shareBlock.indexOf("}", catchIdx) + 1);
  assert.ok(!catchBody.includes("feedback.textContent"), "the catch for navigator.share must not set any error feedback -- cancelling is not a failure");
});

test("CASE M: when navigator.share is unavailable, falls back to clipboard with '✓ Invitación copiada' feedback", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupInvite()");
  assert.ok(body.includes("await navigator.clipboard.writeText(text);"));
  assert.ok(body.includes('feedback.textContent = "✓ Invitación copiada";'));
});

test("no persisted onboardingStep or progress-bar pattern is introduced anywhere in the new setup functions", () => {
  const fns = [
    "function resolveSetupDestination(m, user)",
    "async function renderAdminSetupPin()",
    "async function renderAdminSetupResolve()",
    "function renderAdminSetupReview(round, opts)",
    "function renderAdminSetupManual()",
    "function renderAdminSetupInvite()",
  ];
  fns.forEach(sig => {
    const body = extractFunctionBody(indexSrc, sig);
    assert.ok(!/onboardingStep/i.test(body), `${sig} must not reference onboardingStep`);
    assert.ok(!/progress.?bar/i.test(body), `${sig} must not reference a progress bar`);
  });
});

test("the 3-minute headline appears on the PIN screen and is not repeated on review/manual/invite", () => {
  const pinBody = extractFunctionBody(indexSrc, "async function renderAdminSetupPin()");
  assert.ok(pinBody.includes("Configura tu quiniela en 3 minutos"));
  ["function renderAdminSetupReview(round, opts)", "function renderAdminSetupManual()", "function renderAdminSetupInvite()"].forEach(sig => {
    const body = extractFunctionBody(indexSrc, sig);
    assert.ok(!body.includes("Configura tu quiniela en 3 minutos"), `${sig} must not repeat the headline`);
  });
});

test("/crear's submit handler redirects immediately with ?setup=1 and no longer calls sync-competition itself", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-c-submit").addEventListener("click"');
  const body = indexSrc.slice(idx, idx + 1750);
  assert.ok(body.includes('"/q/" + encodeURIComponent(result.slug || slug) + "?setup=1"'));
  assert.ok(!body.includes("sync-competition"), "the old inline sync-competition call during creation must be gone -- it now happens from the setup page itself");
});

test("no forbidden onboarding-wizard UI patterns anywhere in the new setup code", () => {
  const fns = [
    "async function renderAdminSetupPin()",
    "function renderAdminSetupWaiting()",
    "function renderAdminSetupReview(round, opts)",
    "function renderAdminSetupManual()",
    "function renderAdminSetupInvite()",
  ];
  fns.forEach(sig => {
    const body = extractFunctionBody(indexSrc, sig);
    assert.ok(!/paso \d/i.test(body));
    assert.ok(!/confetti/i.test(body));
    assert.ok(!/\bQR\b/.test(body));
    assert.ok(!/tour/i.test(body));
  });
});

test("the review screen keeps the word 'picks' as instructed, never substituting 'pronósticos'", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round, opts)");
  assert.ok(body.includes("mandar sus picks"));
});

// ---- Blocker 1 (QA fix): persisted exit signal from the invite screen ----

test("CASE W: published round + admin left invite screen once -> app, never invite again, using ONLY existing data + the new persisted flag", () => {
  const meta = { rounds: [round(1, true)], participants: [admin], settings: { adminLeftInviteScreen: true } };
  assert.equal(runResolveSetupDestination(meta, admin), "app");
});

test("CASE X: shared invitation (flag set), nobody joined yet -> app, not invite", () => {
  // Sharing sets the SAME flag as "Ver mi jornada" -- confirmed structurally below.
  const meta = { rounds: [round(1, true)], participants: [admin], settings: { adminLeftInviteScreen: true } };
  assert.equal(runResolveSetupDestination(meta, admin), "app");
});

test("CASE Y: admin had already left the invite screen in an earlier session -- a later session with the SAME persisted meta still resolves to app, not invite (proves this is NOT memory-only)", () => {
  // Simulates a completely fresh page load: a brand new meta object read
  // from Postgres, no relation at all to any earlier in-memory state.
  const freshlyReadMeta = JSON.parse(JSON.stringify({ rounds: [round(1, true)], participants: [admin], settings: { adminLeftInviteScreen: true } }));
  assert.equal(runResolveSetupDestination(freshlyReadMeta, admin), "app");
});

test("CASE Z: admin abandons BEFORE publishing -- the flag is irrelevant/absent, must still resolve review/manual correctly (never marks setup complete prematurely)", () => {
  const metaNoRounds = { rounds: [], participants: [admin], settings: {} };
  assert.equal(runResolveSetupDestination(metaNoRounds, admin), "manual");
  const metaUnpublished = { rounds: [round(1, false)], participants: [admin], settings: {} };
  assert.equal(runResolveSetupDestination(metaUnpublished, admin), "review");
});

test("without the flag and without other participants, a published round still correctly resolves to invite (the flag is additive, not a replacement for the existing signal)", () => {
  const meta = { rounds: [round(1, true)], participants: [admin], settings: {} };
  assert.equal(runResolveSetupDestination(meta, admin), "invite");
});

test("Blocker 1 fix: markLeftInviteScreen() persists via setMetaWithError (real server round-trip), not just an in-memory variable", () => {
  const body = extractFunctionBody(indexSrc, "async function markLeftInviteScreen()");
  assert.ok(body.includes("meta.settings.adminLeftInviteScreen = true;"));
  assert.ok(body.includes("await setMetaWithError(meta);"), "must actually persist to the server, not just set a JS variable");
});

test("Blocker 1 fix: 'Ver mi jornada' awaits markLeftInviteScreen() before transitioning away", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-setup-view-round").addEventListener("click"');
  const body = indexSrc.slice(idx, idx + 300);
  assert.ok(body.includes("await markLeftInviteScreen();"));
});

test("Blocker 1 fix: both the Web Share success path AND the clipboard fallback path call markLeftInviteScreen()", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupInvite()");
  const shareHandlerIdx = body.indexOf('document.getElementById("qz-setup-share").addEventListener');
  const shareHandlerEnd = body.indexOf('document.getElementById("qz-setup-add-participants")');
  const shareHandlerBody = body.slice(shareHandlerIdx, shareHandlerEnd);
  const occurrences = [...shareHandlerBody.matchAll(/markLeftInviteScreen\(\);/g)];
  assert.equal(occurrences.length, 2, "both the navigator.share success branch and the clipboard fallback branch must mark the exit");
});

test("Blocker 1 fix: cancelling the native share sheet does NOT call markLeftInviteScreen() (the admin hasn't actually left/done anything yet)", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupInvite()");
  const shareIdx = body.indexOf("if(navigator.share){");
  const catchIdx = body.indexOf("catch(e){", shareIdx);
  const catchBody = body.slice(catchIdx, body.indexOf("}", catchIdx) + 1);
  assert.ok(!catchBody.includes("markLeftInviteScreen"), "a cancelled share sheet must not be treated as having left the screen");
});

// ---- Blocker 2 (QA fix): CASE AA/AB retry correctness ----

test("CASE AA (structural): a second click after a failed publish targets the object CURRENTLY in meta.rounds, so a successful retry actually persists the retried edits, not the pre-edit snapshot", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round, opts)");
  // The handler is defined once (addEventListener called once), and its
  // body re-derives liveRound fresh on every invocation via roundId --
  // confirmed by the absence of any mutation of the original `round` param.
  const clickHandlerIdx = body.indexOf('cta.addEventListener("click"');
  const handlerBody = body.slice(clickHandlerIdx);
  assert.ok(handlerBody.includes("meta.rounds.find(r => r.id === roundId)"), "must look up by the stable id inside the click handler itself, not once outside it");
});

test("CASE AB (structural): the retry path never reconstructs match objects from scratch -- `clean` (built from the preserved local `matches` array, itself seeded via {...m} spread) is applied directly to liveRound, preserving any field neither teamA/teamB editing nor the filter touches", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round, opts)");
  assert.ok(body.includes("const matches = round.matches.map(m => ({...m}));"), "the local editable copy must be a full spread of each original match, preserving external metadata fields");
  assert.ok(body.includes("liveRound.matches = clean;"), "clean (filtered from that same preserved array) must be assigned directly, not rebuilt field-by-field");
});

// ---- Payment Penalty audit on the new deadline-mutation site ----

test("Payment Penalty audit: renderAdminSetupReview calls reconcilePenaltyLedger(meta) before mutating liveRound.deadline, matching the exact invariant already used in Admin -> Jornadas -> Editar", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round, opts)");
  const reconcileIdx = body.indexOf("reconcilePenaltyLedger(meta);");
  const deadlineMutationIdx = body.indexOf("liveRound.deadline = new Date(deadlineVal).toISOString();");
  assert.ok(reconcileIdx !== -1 && deadlineMutationIdx !== -1 && reconcileIdx < deadlineMutationIdx, "reconciliation must run before this new deadline-mutation site too, exactly like the existing Editar-jornada flow");
});

// ---- Bug found during my own E2E validation (not from the QA ticket, but
// a real bug caught while testing FLOW 3): the very first, pre-PIN meta
// fetch has no admin credential yet, so the backend correctly strips
// published:false rounds from it (a non-admin visitor must never see
// prepared-but-unpublished jornadas). Without an unconditional re-fetch
// using the now-available admin credential, an imported-but-unpublished
// round would be invisible and the admin would incorrectly land on
// "Prepara tu primera jornada" (manual) instead of "Revisa tu primera
// jornada" (review) for a round that genuinely already exists. ----

test("renderAdminSetupResolve unconditionally re-fetches meta with the admin credential BEFORE checking rounds/resolving destination -- not only inside the sync-competition branch", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminSetupResolve()");
  const firstFetchIdx = body.indexOf("const freshWithAuth = await getMeta({ owner: adminOrOwnerCred() });");
  const leagueCheckIdx = body.indexOf("const leagueId = meta.settings");
  const destIdx = body.indexOf("const dest = resolveSetupDestination(meta, currentUser);");
  assert.ok(firstFetchIdx !== -1, "must unconditionally re-fetch meta with admin credentials at the top of this function");
  assert.ok(firstFetchIdx < leagueCheckIdx, "the unconditional refresh must happen before the league/sync-competition branch, not only inside it");
  assert.ok(firstFetchIdx < destIdx, "the unconditional refresh must happen before resolveSetupDestination reads meta.rounds");
});

// ---- P1 fixes: deadline-in-the-past validation + usable-round selection ----

function runIsSetupDeadlineValid(deadlineInputValue, nowMs){
  const body = extractFunctionBody(indexSrc, "function isSetupDeadlineValid(deadlineInputValue, nowMs)");
  const fn = new Function(`return function isSetupDeadlineValid(deadlineInputValue, nowMs)${body.slice(body.indexOf("{"))}`)();
  return fn(deadlineInputValue, nowMs);
}
function runIsRoundUsableForSetup(r, nowMs){
  const body = extractFunctionBody(indexSrc, "function isRoundUsableForSetup(round, nowMs)");
  const fn = new Function(`return function isRoundUsableForSetup(round, nowMs)${body.slice(body.indexOf("{"))}`)();
  return fn(r, nowMs);
}
function runPickSetupRound(rounds, nowMs){
  const usableBody = extractFunctionBody(indexSrc, "function isRoundUsableForSetup(round, nowMs)");
  const pickBody = extractFunctionBody(indexSrc, "function pickSetupRound(rounds, nowMs)");
  const fn = new Function(`
    function isRoundUsableForSetup(round, nowMs)${usableBody.slice(usableBody.indexOf("{"))}
    return function pickSetupRound(rounds, nowMs)${pickBody.slice(pickBody.indexOf("{"))};
  `)();
  return fn(rounds, nowMs);
}

const NOW = new Date("2026-08-22T15:00:00.000Z").getTime();
function roundFull(number, published, deadlineIso){ return { id: "r"+number, number, published, deadline: deadlineIso, matches: [{id:"m"+number, teamA:"A", teamB:"B"}] }; }

// ---- CASE A/B/C: deadline-in-the-past validation ----

test("CASE A: a datetime-local value from yesterday is rejected", () => {
  const yesterday = new Date(NOW - 24*3600*1000);
  const pad = n => String(n).padStart(2,"0");
  const val = `${yesterday.getUTCFullYear()}-${pad(yesterday.getUTCMonth()+1)}-${pad(yesterday.getUTCDate())}T${pad(yesterday.getUTCHours())}:${pad(yesterday.getUTCMinutes())}`;
  assert.equal(runIsSetupDeadlineValid(val, NOW), false);
});

test("CASE B: today but an hour that already passed is rejected", () => {
  // NOW is 15:00 UTC -- 14:00 same day must be rejected.
  assert.equal(runIsSetupDeadlineValid("2026-08-22T14:00", new Date("2026-08-22T14:00:00.000Z").getTime() + 1), false);
});

test("CASE C: a genuinely future datetime is accepted", () => {
  assert.equal(runIsSetupDeadlineValid("2099-01-01T18:00", NOW), true);
});

test("empty/blank deadline is rejected, not treated as valid", () => {
  assert.equal(runIsSetupDeadlineValid("", NOW), false);
  assert.equal(runIsSetupDeadlineValid(null, NOW), false);
});

test("CASE H (deadline validation side): an unparseable deadline string is rejected, never crashes, never treated as valid", () => {
  assert.equal(runIsSetupDeadlineValid("not-a-date", NOW), false);
});

// ---- CASE D/E: usable round selection ----

test("CASE D: J1/J2 expired, J3 future, all published:false -> setup picks J3", () => {
  const rounds = [
    roundFull(1, false, "2026-08-20T00:00:00.000Z"),
    roundFull(2, false, "2026-08-21T00:00:00.000Z"),
    roundFull(3, false, "2099-01-01T00:00:00.000Z"),
  ];
  const picked = runPickSetupRound(rounds, NOW);
  assert.equal(picked.number, 3);
});

test("CASE E: multiple future rounds -> picks the lowest round.number (documented as the real chronological order QRACKS uses everywhere else)", () => {
  const rounds = [
    roundFull(5, false, "2099-03-01T00:00:00.000Z"),
    roundFull(3, false, "2099-01-01T00:00:00.000Z"),
    roundFull(4, false, "2099-02-01T00:00:00.000Z"),
  ];
  const picked = runPickSetupRound(rounds, NOW);
  assert.equal(picked.number, 3, "must pick by round.number ascending, not array order or deadline order");
});

test("CASE F: every prepared round is expired -> pickSetupRound returns null (no usable round to auto-select)", () => {
  const rounds = [
    roundFull(1, false, "2026-08-20T00:00:00.000Z"),
    roundFull(2, false, "2026-08-21T00:00:00.000Z"),
  ];
  assert.equal(runPickSetupRound(rounds, NOW), null);
});

test("CASE H (round side): a round with a null/missing deadline is never treated as usable/future", () => {
  const r = { id: "r1", number: 1, published: false, deadline: null, matches: [] };
  assert.equal(runIsRoundUsableForSetup(r, NOW), false);
});

test("CASE H (round side): a round with an unparseable deadline string is never treated as usable, never crashes", () => {
  const r = { id: "r1", number: 1, published: false, deadline: "garbage", matches: [] };
  assert.equal(runIsRoundUsableForSetup(r, NOW), false);
});

test("CASE J: a legacy round (published undefined) is never selected as a 'usable prepared' round -- it's already-published history, not prepared", () => {
  const r = { id: "r1", number: 1, deadline: "2099-01-01T00:00:00.000Z", matches: [] }; // no `published` field at all
  assert.equal(runIsRoundUsableForSetup(r, NOW), false);
});

test("a round already published:true is never selected by pickSetupRound either", () => {
  const rounds = [roundFull(1, true, "2099-01-01T00:00:00.000Z")];
  assert.equal(runPickSetupRound(rounds, NOW), null);
});

// ---- Structural: renderAdminSetupResolve uses pickSetupRound, and falls back correctly when nothing is usable ----

test("renderAdminSetupResolve uses pickSetupRound(meta.rounds, serverNow()) instead of blindly taking the first published:false round", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminSetupResolve()");
  assert.ok(body.includes("const usableRound = pickSetupRound(meta.rounds, now);"));
  assert.ok(!body.includes('meta.rounds.find(r => r.published === false) || meta.rounds[0]'), "the old naive selection must be gone");
});

test("CASE F fallback: when no round is usable but prepared rounds exist, renderAdminSetupResolve reuses the earliest-numbered one via renderAdminSetupReview with forceBlankDeadline, never renderAdminSetupManual (never discards imported match data)", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminSetupResolve()");
  const elseIdx = body.indexOf("} else {", body.indexOf("if(usableRound){"));
  const fallbackBody = body.slice(elseIdx, elseIdx + 1300);
  assert.ok(fallbackBody.includes("preparedRounds.slice().sort((a, b) => a.number - b.number)[0]"));
  assert.ok(fallbackBody.includes("renderAdminSetupReview(earliestExpired, { forceBlankDeadline: true });"));
});

test("CASE F fallback: only falls through to renderAdminSetupManual() (a brand-new empty round) when there are NO prepared rounds at all -- never when there are expired-but-real ones", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminSetupResolve()");
  const elseIdx = body.indexOf("} else {", body.indexOf("if(usableRound){"));
  const fallbackBody = body.slice(elseIdx, elseIdx + 1300);
  const innerElseIdx = fallbackBody.indexOf("} else {", fallbackBody.indexOf("if(preparedRounds.length > 0){"));
  const innerElseBody = fallbackBody.slice(innerElseIdx, innerElseIdx + 100);
  assert.ok(innerElseBody.includes("renderAdminSetupManual();"));
});

// ---- forceBlankDeadline never pre-fills an expired deadline ----

test("renderAdminSetupReview(round, {forceBlankDeadline:true}) renders an EMPTY deadline field, never the round's own (expired) deadline", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round, opts)");
  assert.ok(body.includes('deadlineValue: forceBlankDeadline ? "" : toLocalInputValue(round.deadline),'));
});

// ---- Submit-time validation wired into BOTH screens, never relying on `min` alone ----

test("CASE G: renderAdminSetupReview's submit handler validates isSetupDeadlineValid against serverNow() at click time, before persisting anything", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round, opts)");
  const clickIdx = body.indexOf('cta.addEventListener("click"');
  const validateIdx = body.indexOf("isSetupDeadlineValid(deadlineVal, serverNow())", clickIdx);
  const mutateIdx = body.indexOf("liveRound.matches = clean;", clickIdx);
  assert.ok(validateIdx !== -1 && validateIdx < mutateIdx, "the deadline-in-the-past check must run before any mutation/persistence is attempted");
});

test("CASE A/B (manual side): renderAdminSetupManual's submit handler has the same isSetupDeadlineValid check before persisting", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupManual()");
  const clickIdx = body.indexOf('cta.addEventListener("click"');
  const validateIdx = body.indexOf("isSetupDeadlineValid(deadlineVal, serverNow())", clickIdx);
  const pushIdx = body.indexOf("meta.rounds.push(round);", clickIdx);
  assert.ok(validateIdx !== -1 && validateIdx < pushIdx);
});

test("the inline error copy is exactly 'Elige una fecha y hora a partir de ahora.' in both screens, and nothing gets cleared alongside it (no reset of matches/deadline input)", () => {
  [
    "function renderAdminSetupReview(round, opts)",
    "function renderAdminSetupManual()",
  ].forEach(sig => {
    const body = extractFunctionBody(indexSrc, sig);
    const msgIdx = body.indexOf('errorEl.textContent = "Elige una fecha y hora a partir de ahora.";');
    assert.ok(msgIdx !== -1, `${sig} must show the exact required copy`);
    const surroundingSlice = body.slice(Math.max(0, msgIdx - 300), msgIdx + 150);
    assert.ok(!surroundingSlice.includes(".value = \"\""), `${sig} must never clear an input's value alongside this error`);
    assert.ok(!surroundingSlice.includes("matches.length = 0") && !surroundingSlice.includes("matches.splice(0"), `${sig} must never clear the matches array alongside this error`);
  });
});

test("`min` is set on the deadline input as a UX hint, computed from serverNow() via the same toLocalInputValue used everywhere else -- but is documented as defense-in-depth only, not the real guard", () => {
  const body = extractFunctionBody(indexSrc, "function setupRoundShellHtml({ headline, supporting, matchesHtml, deadlineValue, ctaLabel }){");
  assert.ok(body.includes("const minDeadline = toLocalInputValue(new Date(serverNow()).toISOString());"));
  assert.ok(body.includes('min="${minDeadline}"'));
});

// ---- CASE I/K/L/M: no regressions to unrelated invariants ----

test("CASE I: this fix does not touch resolveSetupDestination's own review/manual/invite/app branching logic (anti-trap and hasPublishedRound checks untouched)", () => {
  const body = extractFunctionBody(indexSrc, "function resolveSetupDestination(m, user)");
  assert.ok(body.includes("const hasPublishedRound = rounds.some(r => r.published !== false);"));
  assert.ok(body.includes("if(hasOtherParticipants || leftInviteScreen) return \"app\";"));
});

test("CASE K: Admin -> Jornadas (renderAdminRondas) still reads meta.rounds directly and unfiltered -- this fix only changes the setup continuity's OWN round selection, never what Admin -> Jornadas displays", () => {
  const body = indexSrc.slice(indexSrc.indexOf("async function renderAdminRondas(body)"), indexSrc.indexOf("async function renderAdminRondas(body)") + 8000);
  assert.ok(body.includes("meta.rounds.length ? meta.rounds.slice().reverse()"));
  assert.ok(!body.includes("isRoundUsableForSetup"), "Admin -> Jornadas must never filter by setup-usability");
});

test("CASE L: pickSetupRound/isRoundUsableForSetup are pure read-only functions that never reference competitionSync/planCompetitionSync -- Competition Sync's own idempotency logic is untouched by this fix", () => {
  ["function isRoundUsableForSetup(round, nowMs)", "function pickSetupRound(rounds, nowMs)"].forEach(sig => {
    const body = extractFunctionBody(indexSrc, sig);
    assert.ok(!/competitionSync|planCompetitionSync|sync-competition/.test(body));
  });
});

test("CASE M: reconcilePenaltyLedger(meta) is still called before liveRound.deadline mutation in renderAdminSetupReview, unaffected by the round-selection change", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round, opts)");
  const reconcileIdx = body.indexOf("reconcilePenaltyLedger(meta);");
  const deadlineMutationIdx = body.indexOf("liveRound.deadline = new Date(deadlineVal).toISOString();");
  assert.ok(reconcileIdx !== -1 && deadlineMutationIdx !== -1 && reconcileIdx < deadlineMutationIdx);
});
