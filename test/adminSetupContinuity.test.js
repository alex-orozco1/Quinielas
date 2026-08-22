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
  const braceStart = source.indexOf("{", start);
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
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round)");
  assert.ok(body.includes("const snapshot = JSON.parse(JSON.stringify(round));"), "must snapshot before mutating");
  assert.ok(body.includes('errorEl.textContent = "No pudimos publicar la jornada. Tus cambios siguen aquí.";'));
  assert.ok(!body.includes("renderAdminSetupManual()"), "failure path must not navigate to a different screen");
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
    "function renderAdminSetupReview(round)",
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
  ["function renderAdminSetupReview(round)", "function renderAdminSetupManual()", "function renderAdminSetupInvite()"].forEach(sig => {
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
    "function renderAdminSetupReview(round)",
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
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round)");
  assert.ok(body.includes("mandar sus picks"));
});
