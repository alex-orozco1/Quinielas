// adminPinClaim.test.js — the first PIN of an admin is not up for grabs.
//
// Before this fix a quiniela was created with its creator as admin and
// `pin: null`, and /api/set-pin let anyone choose a participant's first PIN
// with no proof. If the creator left the onboarding before the PIN step, the
// first visitor who tapped the creator's name became the admin. These tests
// run the real decision logic from adminPinClaim.js and check that server.js
// and public/index.html actually wire it in.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ADMIN_SETUP_CLAIM_PURPOSE, ADMIN_SETUP_CLAIM_MAX_AGE_MS,
  adminSetupClaimCookieName, buildAdminSetupClaimPayload,
  isValidAdminSetupClaim, decideFirstPin,
} = require("../adminPinClaim");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function routeBody(marker) {
  const start = serverSrc.indexOf(marker);
  assert.ok(start !== -1, `could not locate ${marker}`);
  const next = serverSrc.indexOf("\napp.", start + marker.length);
  return serverSrc.slice(start, next === -1 ? undefined : next);
}

const NOW = 1_800_000_000_000;
const admin = { id: "p_admin", isAdmin: true, pin: null };

test("a pin-less ADMIN with no claim and no credential is refused", () => {
  assert.deepEqual(
    decideFirstPin({ participant: admin, hasValidSetupClaim: false, isAdminOrOwner: false }),
    { ok: false, error: "admin_claim_required" }
  );
});

test("a pin-less ADMIN may choose a first PIN with the setup claim or an admin/owner credential", () => {
  assert.equal(decideFirstPin({ participant: admin, hasValidSetupClaim: true, isAdminOrOwner: false }).ok, true);
  assert.equal(decideFirstPin({ participant: admin, hasValidSetupClaim: false, isAdminOrOwner: true }).ok, true);
});

test("a pin-less regular participant keeps the open first-PIN activation", () => {
  const p = { id: "p_x", isAdmin: false, pin: null };
  assert.equal(decideFirstPin({ participant: p, hasValidSetupClaim: false, isAdminOrOwner: false }).ok, true);
});

test("a participant who already has a PIN is left to the current-PIN check", () => {
  const p = { id: "p_admin", isAdmin: true, pin: "scrypt$..." };
  assert.equal(decideFirstPin({ participant: p, hasValidSetupClaim: false, isAdminOrOwner: false }).ok, true);
});

test("the setup claim is bound to its purpose, slug, participant and age", () => {
  const claim = buildAdminSetupClaimPayload({ slug: "mi-quiniela", participantId: "p_admin", now: NOW });
  const ctx = { slug: "mi-quiniela", participantId: "p_admin", now: NOW + 1000 };
  assert.equal(claim.purpose, ADMIN_SETUP_CLAIM_PURPOSE);
  assert.equal(isValidAdminSetupClaim(claim, ctx), true);
  assert.equal(isValidAdminSetupClaim(null, ctx), false);
  assert.equal(isValidAdminSetupClaim({ ...claim, purpose: undefined }, ctx), false, "a session token is not a claim");
  assert.equal(isValidAdminSetupClaim(claim, { ...ctx, slug: "otra" }), false, "another quiniela");
  assert.equal(isValidAdminSetupClaim(claim, { ...ctx, slug: null }), false, "the legacy root quiniela");
  assert.equal(isValidAdminSetupClaim(claim, { ...ctx, participantId: "p_other" }), false, "another participant");
  assert.equal(isValidAdminSetupClaim(claim, { ...ctx, participantId: undefined }), false);
  assert.equal(isValidAdminSetupClaim(claim, { ...ctx, now: NOW + ADMIN_SETUP_CLAIM_MAX_AGE_MS + 1 }), false, "expired");
  assert.equal(isValidAdminSetupClaim(claim, { ...ctx, now: NOW - 1 }), false, "issued in the future");
  assert.equal(isValidAdminSetupClaim({ ...claim, issuedAt: "x" }, ctx), false);
});

test("the claim cookie has its own name, separate from the session cookie", () => {
  assert.equal(adminSetupClaimCookieName("mi-quiniela"), "qracks_setup_mi-quiniela");
  assert.equal(adminSetupClaimCookieName(null), "qracks_setup__root");
});

test("SERVER: create-quiniela hands the setup claim for the creator, only after COMMIT", () => {
  const body = routeBody('app.post("/api/create-quiniela"');
  const commitIdx = body.lastIndexOf('await client.query("COMMIT");');
  const claimIdx = body.indexOf("issueAdminSetupClaim(res, cleanSlug, creatorId);");
  assert.ok(claimIdx !== -1, "the creator's browser must get the claim");
  assert.ok(commitIdx !== -1 && commitIdx < claimIdx, "never hand out a claim for a quiniela that was rolled back");
  assert.ok(/pin: null/.test(body), "the creator still starts with no PIN; the claim is what protects it");
});

test("SERVER: set-pin runs decideFirstPin under the lock and refuses with 403", () => {
  const body = routeBody('app.post("/api/set-pin"');
  const lockIdx = body.indexOf("getRowLocked(metaKey, client)");
  const decideIdx = body.indexOf("adminPinClaim.decideFirstPin(");
  const writeIdx = body.indexOf("participant.pin = hashPassword(newPin);");
  assert.ok(lockIdx !== -1 && lockIdx < decideIdx && decideIdx < writeIdx, "decide on the locked row, before writing");
  assert.ok(body.includes("res.status(403).json({ error: firstPin.error })"));
  assert.ok(body.includes("hasValidAdminSetupClaim(req, claimSlug, participant.id)"));
  assert.ok(body.includes("isAdminClaimAuthorized(req, claimSlug, value)"));
  const claim = serverSrc.slice(serverSrc.indexOf("function isAdminClaimAuthorized("), serverSrc.indexOf('app.post("/api/set-pin"'));
  assert.ok(claim.includes("if (isRequestAdminOrOwner(req, slug, value)) return true;"));
  assert.ok(claim.includes("(p) => p.isAdmin && p.pin && checkCredential(req, slug, p.id, provided, p.pin)"), "only admin-level credentials, each as its own target");
  // The slug used to judge the claim comes from the metaKey being written,
  // never from the client-supplied `slug`.
  assert.ok(body.includes("const claimSlug = slugFromMetaKey(metaKey);"));
  assert.ok(/function slugFromMetaKey\(metaKey\) \{\s*const m = String\(metaKey \|\| ""\)\.match\(\/\^quiniela:\(\[a-z0-9-\]\{1,60\}\):meta\$\/\);\s*return m \? m\[1\] : null;/.test(serverSrc));
  assert.ok(!/hasValidAdminSetupClaim\(req, slug,/.test(body));
});

test("SERVER: the claim is signed and verified, and never accepted as a session", () => {
  assert.ok(/function hasValidAdminSetupClaim[\s\S]*?verifySessionToken\(raw\)/.test(serverSrc), "the cookie's signature is verified");
  assert.ok(/function issueAdminSetupClaim[\s\S]*?signSessionToken\(/.test(serverSrc));
  const issue = serverSrc.slice(serverSrc.indexOf("function issueAdminSetupClaim"), serverSrc.indexOf("function hasValidAdminSetupClaim"));
  assert.ok(issue.includes("...SESSION_COOKIE_CLEAR_OPTIONS,"), "same HttpOnly/Secure/SameSite options as the session cookie");
  assert.ok(issue.includes("maxAge: adminPinClaim.ADMIN_SETUP_CLAIM_MAX_AGE_MS"), "with the claim's own lifetime");
  const readSession = serverSrc.slice(serverSrc.indexOf("function readSessionFromCookie"), serverSrc.indexOf("function issueAdminSetupClaim"));
  assert.ok(readSession.includes("if (session.purpose) return null;"), "a claim moved into the session cookie must not log anyone in");
});

test("FRONTEND: both first-PIN paths for an admin go through setFirstAdminPin", () => {
  const setupStart = indexSrc.indexOf("async function renderAdminSetupPin()");
  const setupBody = indexSrc.slice(setupStart, indexSrc.indexOf("async function renderAdminSetupResolve()", setupStart));
  assert.ok(setupBody.includes("await setFirstAdminPin(creator.id, currentValue)"));
  const loginStart = indexSrc.indexOf("function renderLogin()");
  const loginBody = indexSrc.slice(loginStart, loginStart + 12000);
  assert.ok(/if\(p\.isAdmin\)\{\s*const result = await setFirstAdminPin\(p\.id, cleanPin\);/.test(loginBody));
});

test("FRONTEND: the admin password is asked for in a masked field and sent only as a header", () => {
  const fn = indexSrc.slice(indexSrc.indexOf("async function setFirstAdminPin("), indexSrc.indexOf("async function setFirstAdminPin(") + 1200);
  assert.ok(fn.includes('first.error !== "admin_claim_required"'), "asks only when the server says so");
  assert.ok(/qzPrompt\([^)]*secret: true/.test(fn), "masked input");
  const api = indexSrc.slice(indexSrc.indexOf("async function apiSetPinResult("), indexSrc.indexOf("async function apiSetPin("));
  assert.ok(api.includes("setAuthHeaders(headers, adminPassword);"));
  assert.ok(!/body: JSON\.stringify\([^)]*adminPassword/.test(api), "never in the body");
  assert.ok(/const isSecret = isPin \|\| !!opts\.secret;/.test(indexSrc));
  assert.ok(indexSrc.includes('type="${isSecret ? "password" : "text"}"'));
});

test("FRONTEND: resetting or promoting an admin says what they'll need, instead of promising an open reset", () => {
  const start = indexSrc.indexOf('const resetBtn = row.querySelector("[data-role=resetpin]");');
  const resetBody = indexSrc.slice(start, start + 2000);
  assert.ok(/const resetMessage = p\.isAdmin\s*\?\s*`Como es admin/.test(resetBody));
  assert.ok(resetBody.includes("qzConfirm(resetMessage,"));
  assert.ok(indexSrc.includes('(p.hasPin ? "" : ". Para poner su PIN necesitará la contraseña de administrador'));
  const fn = indexSrc.slice(indexSrc.indexOf("async function setFirstAdminPin("), indexSrc.indexOf("async function setFirstAdminPin(") + 1200);
  assert.ok(fn.includes("pide a otro admin que escriba aquí su PIN"), "the prompt names every credential the server accepts");
  assert.ok(/too_many_attempts: "Demasiados intentos/.test(indexSrc));
});

test("SERVER: set-pin scopes the session it issues to the metaKey's quiniela", () => {
  const body = routeBody('app.post("/api/set-pin"');
  assert.ok(body.includes("issueSessionCookie(res, claimSlug, participant);"));
  assert.ok(!body.includes("issueSessionCookie(res, slug, participant);"));
});
