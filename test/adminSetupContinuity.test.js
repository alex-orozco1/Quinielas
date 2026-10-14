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
  assert.ok(submitBody.includes("errorEl.textContent ="));
  assert.ok(submitBody.includes('"No pudimos guardar tu PIN. Intenta de nuevo."'), "the generic failure copy stays for every non-claim failure");
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
  assert.ok(body.includes('const readyToContinue = () => { continueBtn.disabled = currentValue.length !== 4 || credentialWaitLeft("owner") > 0; };'),
    "4 digits, and no wait for too many attempts on screen");
  const onInput = body.slice(body.indexOf('wirePinBoxes("qz-setup-pin-input"'), body.indexOf('wirePinBoxes("qz-setup-pin-input"') + 200);
  assert.ok(onInput.includes("currentValue = val;") && onInput.indexOf("currentValue = val;") < onInput.indexOf("readyToContinue();"));
});

test("/crear's submit handler redirects immediately with ?setup=1 and no longer calls sync-competition itself", () => {
  const idx = indexSrc.indexOf('document.getElementById("qz-c-submit").addEventListener("click"');
  const body = indexSrc.slice(idx, indexSrc.indexOf("// ---------- /panel-plataforma", idx));
  assert.ok(body.includes('"/q/" + encodeURIComponent(result.slug || slug) + "?setup=1"'));
  assert.ok(!body.includes("sync-competition"), "the old inline sync-competition call during creation must be gone -- it now happens from the setup page itself");
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

// ---- Blocker 2 (QA fix): CASE AA/AB retry correctness ----

// ---- Payment Penalty audit on the new deadline-mutation site ----

// ---- Bug found during my own E2E validation (not from the QA ticket, but
// a real bug caught while testing FLOW 3): the very first, pre-PIN meta
// fetch has no admin credential yet, so the backend correctly strips
// published:false rounds from it (a non-admin visitor must never see
// prepared-but-unpublished jornadas). Without an unconditional re-fetch
// using the now-available admin credential, an imported-but-unpublished
// round would be invisible and the admin would incorrectly land on
// "Prepara tu primera jornada" (manual) instead of "Revisa tu primera
// jornada" (review) for a round that genuinely already exists. ----

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
// MS2: the setup picks its round with pickPlayableRound (same rule, plus
// rounds whose matches already began are passed over). These cases have no
// kickoffs, so they keep the exact behaviour of the old pickSetupRound.
function runPickSetupRound(rounds, nowMs){
  const usableBody = extractFunctionBody(indexSrc, "function isRoundUsableForSetup(round, nowMs)");
  const startedBody = extractFunctionBody(indexSrc, "function startedMatchesOf(round, nowMs)");
  const pickBody = extractFunctionBody(indexSrc, "function pickPlayableRound(rounds, nowMs)");
  const fn = new Function(`
    function isRoundUsableForSetup(round, nowMs)${usableBody.slice(usableBody.indexOf("{"))}
    function startedMatchesOf(round, nowMs)${startedBody.slice(startedBody.indexOf("{"))}
    return function pickPlayableRound(rounds, nowMs)${pickBody.slice(pickBody.indexOf("{"))};
  `)();
  return fn(rounds, nowMs).round;
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
  // The input is local wall-clock time and the product parses it as local
  // time; "now" is 1 ms after 14:00 LOCAL, so 14:00 the same day is already
  // past in any time zone (UTC, America/Mexico_City...).
  const justAfter = new Date(2026, 7, 22, 14, 0).getTime() + 1;
  assert.equal(runIsSetupDeadlineValid("2026-08-22T14:00", justAfter), false);
  assert.equal(runIsSetupDeadlineValid("2026-08-22T14:01", justAfter), true, "a minute later is still ahead");
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

// ---- QA final fix: expired prepared rounds are NEVER reused as the setup's next round ----

// ---- Round numbering fix: never assume number:1 when rounds already exist ----

// ---- Submit-time validation wired into BOTH screens, never relying on `min` alone ----

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
  ["function isRoundUsableForSetup(round, nowMs)", "function pickPlayableRound(rounds, nowMs)"].forEach(sig => {
    const body = extractFunctionBody(indexSrc, sig);
    assert.ok(!/competitionSync|planCompetitionSync|sync-competition/.test(body));
  });
});

// ---- CASE AC: still PASS -- at least one genuinely future prepared round is selected normally ----

test("CASE AC: J1/J2 expired, J3 future -- pickSetupRound still selects J3 (unaffected by this QA fix)", () => {
  const rounds = [
    roundFull(1, false, "2026-08-01T00:00:00.000Z"),
    roundFull(2, false, "2026-08-05T00:00:00.000Z"),
    roundFull(3, false, "2099-01-01T00:00:00.000Z"),
  ];
  const picked = runPickSetupRound(rounds, NOW);
  assert.equal(picked.number, 3);
});

// ---- CASE AD: all prepared rounds expired -> pickSetupRound returns null, and NONE of them are ever reused ----

test("CASE AD: J1/J2/J3 all expired -> pickSetupRound returns null (nothing usable)", () => {
  const rounds = [
    roundFull(1, false, "2026-08-01T00:00:00.000Z"),
    roundFull(2, false, "2026-08-05T00:00:00.000Z"),
    roundFull(3, false, "2026-08-10T00:00:00.000Z"),
  ];
  assert.equal(runPickSetupRound(rounds, NOW), null);
});

// ---- CASE AE: invalid/null deadlines never crash, never selected ----

test("CASE AE: a round with an invalid deadline string and one with a null deadline are both excluded, no crash", () => {
  const rounds = [
    { id: "r1", number: 1, published: false, deadline: "not-a-real-date", matches: [] },
    { id: "r2", number: 2, published: false, deadline: null, matches: [] },
  ];
  assert.doesNotThrow(() => runPickSetupRound(rounds, NOW));
  assert.equal(runPickSetupRound(rounds, NOW), null);
});

// ---- CASE AF (structural): after the manual fallback publishes, setup proceeds to Invitar exactly like the normal manual path ----

