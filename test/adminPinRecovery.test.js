// adminPinRecovery.test.js — "¿Olvidaste tu PIN?" for an admin: the rules
// the route and the screen must keep, checked against the real source.
// The behaviour itself, through the real endpoints, is in
// adminPinRecovery.integration.test.js (needs a local PostgreSQL).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function routeBody(marker) {
  const start = serverSrc.indexOf(marker);
  assert.ok(start !== -1, `could not locate ${marker}`);
  const next = serverSrc.indexOf("\napp.", start + marker.length);
  return serverSrc.slice(start, next === -1 ? undefined : next);
}
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate ${signature}`);
  let depth = 0, i = source.indexOf("{", start);
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

const route = routeBody('app.post("/api/recover-admin-pin", rateLimit("recover-admin-pin"),');
const at = (s) => { const i = route.indexOf(s); assert.ok(i !== -1, "missing in the route: " + s); return i; };

test("SERVER: the route is rate limited and takes only metaKey, participantId and a 4-digit PIN from the body", () => {
  assert.ok(route.includes("const { metaKey, participantId, newPin } = req.body || {};"));
  assert.ok(route.includes("!/^\\d{4}$/.test(String(newPin || \"\"))"));
  assert.ok(!/req\.body\.(adminPassword|password|ownerPassword)/.test(route), "the admin password never comes from the body");
});

test("SERVER: under the row lock, an admin first, then the admin password (header, unbound) through the limiter", () => {
  const lock = at("const value = await getRowLocked(metaKey, client);");
  const admin = at("if (!participant || !participant.isAdmin) {");
  const noPw = at('return res.status(409).json({ error: "no_admin_password" });');
  const pw = at("if (!headerIsOwnerPassword(req, slug, value)) {");
  const throttled = at("if (sendIfCredentialThrottled(req, res)) return;");
  const wrong = at('return res.status(403).json({ error: "wrong_admin_password" });');
  assert.ok(lock < admin && admin < noPw && noPw < pw && pw < throttled && throttled < wrong);
  assert.ok(route.includes('return res.status(403).json({ error: "not_admin" });'));
  // headerIsOwnerPassword: X-Qracks-Auth, refused when bound to a participant, via checkCredential.
  const helper = extractFunction(serverSrc, "function headerIsOwnerPassword(req, slug, value)");
  assert.ok(helper.includes("if (!req || boundParticipantId(req)) return false;"));
  assert.ok(helper.includes('checkCredential(req, slug, OWNER_TARGET, req.get("x-qracks-auth") || "", stored)'));
  // The slug the password is judged against comes from the metaKey, never the body.
  assert.ok(route.includes("const slug = slugFromMetaKey(metaKey);"));
});

test("SERVER: the new PIN always gets a fresh hash (new version: old trust and sessions end, nothing to compare with the old one)", () => {
  assert.ok(route.includes("participant.pin = hashPassword(newPin);"));
  assert.ok(!route.includes("hashUnlessUnchanged"), "never kept, even if it is the same value");
  assert.ok(!/verifyPassword\(/.test(route), "the new PIN is never compared with the old one");
  const write = at("await putRow(metaKey, storedAfterPin, client);");
  assert.ok(at("participant.pin = hashPassword(newPin);") < write && write < at('await client.query("COMMIT");'));
});

test("SERVER: the device that recovers gets a session and trust for the NEW PIN; the answer carries no PIN", () => {
  const commit = at('await client.query("COMMIT");');
  assert.ok(commit < at("issueSessionCookie(res, slug, participant);"));
  assert.ok(commit < at("trustDevice(req, res, slug, participant.id, participant.pin);"));
  assert.ok(route.includes("trustDevice(req, res, slug, OWNER_TARGET, ownerPassword);"));
  assert.ok(route.includes("res.json({ ok: true, participantRevs: participantRevMap(storedAfterPin) });"));
  // 400 invalid_params ×2, 404, 403 not_admin, 409, 403 wrong_admin_password, the ok above, 500.
  assert.equal((route.match(/res(\.status\(\d+\))?\.json\(/g) || []).length, 8, "every answer is accounted for");
  const errors = (route.match(/json\(\{ error: "([a-z_]+)" \}\)/g) || []).map((s) => s.match(/"([a-z_]+)"/)[1]);
  assert.deepEqual(errors, ["invalid_params", "invalid_params", "not_found", "not_admin", "no_admin_password", "wrong_admin_password", "server_error"]);
  // No PIN (old or new) and no hash in any answer: the only keys ever sent back.
  const keys = (route.match(/\.json\(\{[^}]*\}/g) || []).flatMap((s) => [...s.matchAll(/([A-Za-z]+):/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(keys)].sort(), ["error", "ok", "participantRevs"], "no PIN in any answer");
  assert.ok(extractFunction(serverSrc, "function participantRevMap(").includes("out[p.id] = readParticipantRev(p);"), "participantRevs carries revisions only");
  assert.ok(route.includes('console.log("admin_pin_recovered", { slug, hadPin });'), "logged without the PIN or the participant");
});

test("FRONTEND: the PIN modal offers «¿Olvidaste tu PIN?»: admins recover with the admin password, others ask an admin", () => {
  const login = indexSrc.slice(indexSrc.indexOf('"pin:" + p.id, (pin) => verifyParticipantPin(p.id, pin));') - 400, indexSrc.indexOf('"pin:" + p.id, (pin) => verifyParticipantPin(p.id, pin));') + 1600);
  assert.ok(login.includes('altLabel: "¿Olvidaste tu PIN?"'));
  assert.ok(login.includes("if(attempt.alt){"));
  assert.ok(login.includes("if(!p.isAdmin){") && login.includes("Pide a quien organiza la quiniela (o a otro admin) que resetee tu PIN"));
  assert.ok(login.includes("const newPin = await recoverAdminPin(p);"));
  // The confirmation is shown once the app is on screen (rendering it replaces the login screen and its toast).
  assert.ok(login.includes('afterEntry = "✅ Listo. Tu PIN nuevo quedó guardado.";'));
  assert.ok(indexSrc.includes("await render();\n        if(afterEntry) toast(afterEntry, 5000);"));
  const pc = extractFunction(indexSrc, "async function promptCredential(message, opts, waitKey, check)");
  assert.ok(pc.includes("if(raw === QZ_PROMPT_ALT) return { alt: true };"), "the link is never mistaken for a typed PIN");
  const prompt = extractFunction(indexSrc, "function qzPrompt(message, opts)");
  assert.ok(prompt.includes('if(altBtn) altBtn.addEventListener("click", () => cleanup(QZ_PROMPT_ALT));'));
  assert.ok(indexSrc.includes("const QZ_PROMPT_ALT = Object.freeze({ qzPromptAlt: true });"));
});

test("FRONTEND: the recovery asks the admin password first (with the wait notice), then the new PIN twice; never the old one", () => {
  const flow = extractFunction(indexSrc, "async function recoverAdminPin(p)");
  const pw = flow.indexOf('"owner", (password) => verifyOwnerPasswordResult(password));');
  const first = flow.indexOf('qzPrompt("Elige tu nuevo PIN (4 números):"');
  const again = flow.indexOf('qzPrompt("Escríbelo otra vez para confirmarlo:"');
  const save = flow.indexOf("await apiRecoverAdminPin(p.id, password, newPin);");
  assert.ok(pw !== -1 && pw < first && first < again && again < save);
  assert.ok(flow.includes('if(again.trim() !== newPin){ toast("Los dos PIN no coinciden. Elige uno otra vez."); continue; }'));
  assert.ok(!/actual|anterior|viejo/i.test(flow.replace(/\/\/.*$/gm, "")), "never asks for (or mentions) the old PIN");
  const api = extractFunction(indexSrc, "async function apiRecoverAdminPin(participantId, adminPassword, newPin)");
  assert.ok(api.includes('headers: setAuthHeaders({ "Content-Type": "application/json" }, adminPassword),'));
  assert.ok(api.includes("body: JSON.stringify({ metaKey: currentMetaKey(), participantId, newPin })"), "the admin password is not in the body");
});

test("FRONTEND: Enter in a prompt is handled once (keyboard-only recovery does not reopen the PIN modal)", () => {
  const prompt = extractFunction(indexSrc, "function qzPrompt(message, opts)");
  const onKey = prompt.slice(prompt.indexOf("const onKey = (e) => {"), prompt.indexOf('document.addEventListener("keydown", onKey);'));
  // Enter on the modal's own buttons (Cancelar, «¿Olvidaste tu PIN?») is their click, not a submit.
  assert.ok(onKey.includes('if(e.target !== input && e.target.tagName === "BUTTON" && overlay.contains(e.target)) return;'));
  // Otherwise it submits and the browser must not act on it as well: cleanup() returns the focus to the
  // button that opened the modal, and the same Enter would click it.
  assert.ok(onKey.indexOf("e.preventDefault();") !== -1 && onKey.indexOf("e.preventDefault();") < onKey.indexOf("submit();"));
});

test("FRONTEND: one login at a time (a second Enter or tap while a login is on does not start another on top)", () => {
  const guard = extractFunction(indexSrc, "function oneLoginAtATime(fn)");
  assert.ok(guard.includes("if(loginInProgress) return;"));
  assert.ok(guard.includes("try { return await fn(...args); } finally { loginInProgress = false; }"), "released however the login ends");
  assert.ok(indexSrc.includes('btn.addEventListener("click", oneLoginAtATime(async () => {\n        const p = meta.participants.find(x => x.id === btn.dataset.id);'));
  // An empty confirmation (Enter twice on the new PIN) asks again instead of "no coinciden".
  const flow = extractFunction(indexSrc, "async function recoverAdminPin(p)");
  assert.ok(flow.includes("while(!again.trim()){"));
});
