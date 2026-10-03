// credentialAttempts.test.js — the limit on FAILED credential checks.
//
// Runs the real limiter from credentialAttempts.js with an injected clock, and
// checks that server.js routes every admin/participant PIN and owner password
// comparison through it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createCredentialAttemptLimiter, DEFAULT_RULES } = require("../credentialAttempts");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

const MIN = 60 * 1000;
function limiterAt(startMs, opts = {}) {
  let now = startMs;
  const limiter = createCredentialAttemptLimiter({ now: () => now, ...opts });
  return { limiter, advance(ms) { now += ms; } };
}
// One failed check of `value` against `target` of quiniela `q`.
const fail = (limiter, ip, q, value, target = "p_admin", trustedDeviceId) => {
  const a = limiter.begin({ ip, quiniela: q, target, value, trustedDeviceId });
  if (!a.blocked) a.settle(false);
  return a;
};

test("defaults: per IP, per credential (target) and per trusted device, short and long windows", () => {
  const byName = Object.fromEntries(DEFAULT_RULES.map((r) => [r.name, r]));
  assert.deepEqual(byName["ip-15m"], { name: "ip-15m", scope: "ip", windowMs: 15 * MIN, max: 20 });
  assert.equal(byName["ip-24h"].max, 100);
  assert.equal(byName["net-15m"].max, 60);
  assert.equal(byName["net-24h"].max, 300);
  assert.equal(byName["target-15m"].max, 30);
  assert.equal(byName["target-24h"].max, 150);
  assert.equal(byName["device-15m"].max, 10);
  assert.equal(byName["device-24h"].max, 50);
});

test("the 21st distinct wrong value from one IP within 15 min is blocked, with a Retry-After", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 20; i++) assert.equal(fail(limiter, "1.1.1.1", "q", "000" + i, "t" + i).blocked, false);
  const eleventh = limiter.begin({ ip: "1.1.1.1", quiniela: "q", target: "p_admin", value: "9999" });
  assert.equal(eleventh.blocked, true);
  assert.ok(eleventh.retryAfterMs > 0 && eleventh.retryAfterMs <= 15 * MIN);
});

test("the reproduced attack — a 4-digit search from one IP — stops after the budget", () => {
  const { limiter } = limiterAt(0);
  let answered = 0;
  for (let pin = 0; pin < 10000; pin++) {
    const a = limiter.begin({ ip: "6.6.6.6", quiniela: "victima", target: "p_admin", value: String(pin).padStart(4, "0") });
    if (a.blocked) continue;
    answered++;
    a.settle(false);
  }
  assert.equal(answered, 20, "only 20 guesses per 15 minutes are ever compared");
});

test("a search spread across many IPs is stopped by the credential's own budget", () => {
  const { limiter } = limiterAt(0);
  let answered = 0;
  for (let pin = 0; pin < 10000; pin++) {
    const ip = "10.0." + Math.floor(pin / 5) + "." + (pin % 5); // 5 guesses per IP
    const a = limiter.begin({ ip, quiniela: "victima", target: "p_admin", value: String(pin).padStart(4, "0") });
    if (a.blocked) continue;
    answered++;
    a.settle(false);
  }
  assert.equal(answered, 30);
});

test("over a full day one credential gets at most 150 distinct guesses", () => {
  const { limiter, advance } = limiterAt(0);
  let answered = 0, pin = 0;
  for (let slot = 0; slot < 96; slot++) { // 96 × 15 min = 24 h
    for (let k = 0; k < 40; k++, pin++) {
      const a = limiter.begin({ ip: "10.9." + pin, quiniela: "victima", target: "p_admin", value: String(pin) });
      if (!a.blocked) { answered++; a.settle(false); }
    }
    advance(15 * MIN);
  }
  assert.equal(answered, 150);
});

test("an attack on one credential does not lock the others of the same quiniela", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 40; i++) fail(limiter, "10.1.0." + i, "q", "g" + i, "p_admin");
  assert.equal(limiter.begin({ ip: "203.0.113.5", quiniela: "q", target: "p_admin", value: "1234" }).blocked, true);
  assert.equal(limiter.begin({ ip: "203.0.113.5", quiniela: "q", target: "p_bob", value: "1234" }).blocked, false);
  assert.equal(limiter.begin({ ip: "203.0.113.5", quiniela: "q", target: "owner", value: "pw" }).blocked, false);
});

test("a trusted device keeps working while its credential is under attack", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 40; i++) fail(limiter, "10.2.0." + i, "q", "g" + i, "p_admin");
  assert.equal(limiter.begin({ ip: "10.2.0.1", quiniela: "q", target: "p_admin", value: "1234" }).blocked, true, "untrusted: blocked");
  const trusted = limiter.begin({ ip: "10.2.0.1", quiniela: "q", target: "p_admin", value: "1234", trustedDeviceId: "dev1" });
  assert.equal(trusted.blocked, false, "same IP, but a device that already proved this credential");
  trusted.settle(true);
  // ...and it has its own small budget, so a stolen device cookie is not a free pass.
  for (let i = 0; i < 10; i++) fail(limiter, "x", "q", "t" + i, "p_admin", "dev1");
  assert.equal(limiter.begin({ ip: "x", quiniela: "q", target: "p_admin", value: "t99", trustedDeviceId: "dev1" }).blocked, true);
});

test("a correct credential never consumes budget", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 500; i++) {
    const a = limiter.begin({ ip: "2.2.2.2", quiniela: "q", target: "p_bob", value: "1234" });
    assert.equal(a.blocked, false);
    a.settle(true);
  }
  for (let i = 0; i < 20; i++) assert.equal(fail(limiter, "2.2.2.2", "q", "x" + i, "t" + i).blocked, false);
});

test("the same wrong value counts once: a stale PIN resent by an open tab does not lock anyone out", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 200; i++) assert.equal(fail(limiter, "3.3.3.3", "q", "1111").blocked, false);
  for (let i = 0; i < 19; i++) assert.equal(fail(limiter, "3.3.3.3", "q", "x" + i, "t" + i).blocked, false);
  assert.equal(limiter.begin({ ip: "3.3.3.3", quiniela: "q", target: "p_admin", value: "y" }).blocked, true);
});

test("the IP budget is per quiniela: typos behind a shared IP in one quiniela never block another", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 20; i++) fail(limiter, "100.64.0.1", "q", "1234", "p_" + i); // same value, 20 people
  assert.equal(limiter.begin({ ip: "100.64.0.1", quiniela: "q", target: "p_x", value: "1234" }).blocked, true, "this quiniela, from this IP: blocked");
  assert.equal(limiter.begin({ ip: "100.64.0.1", quiniela: "otra", target: "p_admin", value: "1234" }).blocked, false, "another quiniela from the same IP: fine");
});

test("one IP spraying across many quinielas hits the network-wide ceiling", () => {
  const { limiter } = limiterAt(0);
  let answered = 0;
  for (let i = 0; i < 200; i++) {
    const a = limiter.begin({ ip: "6.6.6.7", quiniela: "q" + i, target: "p_admin", value: "1234" });
    if (!a.blocked) { answered++; a.settle(false); }
  }
  assert.equal(answered, 60);
});

test("a new version of a credential starts with an empty budget, in the same bucket", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 40; i++) fail(limiter, "10.3.0." + i, "q", "g" + i, "pin:bob");
  assert.equal(limiter.begin({ ip: "203.0.113.9", quiniela: "q", target: "pin:bob", value: "1357" }).blocked, true);
  const afterReset = limiter.begin({ ip: "203.0.113.9", quiniela: "q", target: "pin:bob", version: "v2", value: "8080" });
  assert.equal(afterReset.blocked, false, "the reset PIN is a fresh credential");
});

test("rotating a PIN many times does not grow memory without bound", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 5000; i++) {
    const a = limiter.begin({ ip: "203.0.113.20", quiniela: "q", target: "pin:mallory", version: "v" + i, value: "x" + i });
    if (!a.blocked) a.settle(true);
  }
  assert.ok(limiter.size() <= 2 + 2 + 2, `one bucket per rule, not per version (size ${limiter.size()})`);
});

test("one attacker exhausting their IP budget does not block another IP", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 20; i++) fail(limiter, "6.6.6.6", "q", "g" + i, "t" + i);
  assert.equal(limiter.begin({ ip: "6.6.6.6", quiniela: "q", target: "p_admin", value: "1234" }).blocked, true);
  assert.equal(limiter.begin({ ip: "7.7.7.7", quiniela: "q", target: "p_admin", value: "1234" }).blocked, false);
});

test("concurrency: parallel guesses reserve budget before they are judged", () => {
  const { limiter } = limiterAt(0);
  const pending = [];
  for (let i = 0; i < 45; i++) pending.push(limiter.begin({ ip: "5.5.5.5", quiniela: "q", target: "t" + (i % 2), value: "p" + i }));
  assert.equal(pending.filter((a) => !a.blocked).length, 20, "only 20 of 45 simultaneous guesses get compared");
  const admitted = pending.filter((a) => !a.blocked);
  admitted[0].settle(true); admitted[0].settle(true); // idempotent
  admitted.slice(1).forEach((a) => a.settle(false));
  assert.equal(limiter.begin({ ip: "5.5.5.5", quiniela: "q", target: "t9", value: "next" }).blocked, false, "one refunded slot");
  assert.equal(limiter.begin({ ip: "5.5.5.5", quiniela: "q", target: "t9", value: "next2" }).blocked, true);
});

test("the window rolls over, and a refund from the old window does not leak into the new one", () => {
  const { limiter, advance } = limiterAt(0);
  const early = limiter.begin({ ip: "8.8.8.8", quiniela: "q", target: "p_admin", value: "a" });
  for (let i = 0; i < 19; i++) fail(limiter, "8.8.8.8", "q", "b" + i, "t" + i);
  assert.equal(limiter.begin({ ip: "8.8.8.8", quiniela: "q", target: "p_admin", value: "c" }).blocked, true);
  advance(15 * MIN);
  for (let i = 0; i < 20; i++) assert.equal(fail(limiter, "8.8.8.8", "q", "d" + i, "t" + i).blocked, false);
  early.settle(true); // late refund for a request from the previous window
  assert.equal(limiter.begin({ ip: "8.8.8.8", quiniela: "q", target: "p_admin", value: "e" }).blocked, true);
});

test("sweep forgets expired windows; ip and device buckets are capped", () => {
  const { limiter, advance } = limiterAt(0, { maxOpenBuckets: 100 });
  for (let i = 0; i < 1000; i++) fail(limiter, "ip" + i, "q", "v" + (i % 20), "p_" + (i % 3));
  for (let i = 0; i < 1000; i++) fail(limiter, "z", "q", "v", "p_a", "dev" + i);
  assert.ok(limiter.size() <= 100 * 2 + 100 * 2 + 3 * 2, "bounded");
  advance(25 * 60 * 60 * 1000);
  limiter.sweep();
  assert.equal(limiter.size(), 0);
});

// ---- server.js wiring ---------------------------------------------------

function routeBody(marker) {
  const start = serverSrc.indexOf(marker);
  assert.ok(start !== -1, `could not locate ${marker}`);
  const next = serverSrc.indexOf("\napp.", start + marker.length);
  return serverSrc.slice(start, next === -1 ? undefined : next);
}

test("SERVER: no PIN or owner password is compared outside checkCredential", () => {
  const offenders = serverSrc.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /verifyPassword\(/.test(line))
    .filter(({ line }) => !/^function verifyPassword\(/.test(line))
    .filter(({ line }) => !/^\/\//.test(line))
    .filter(({ line }) => !/Platform|platform|platHash/.test(line)) // platform password: separate credential
    // /api/verify-platform: the platform password, behind rateLimit("verify-platform").
    .filter(({ line }) => !(line === "res.json({ ok: verifyPassword(password, stored) });"
      && routeBody('app.post("/api/verify-platform"').includes(line)));
  const allowed = offenders.filter(({ line }) =>
    line === "if (!req) return verifyPassword(value, stored);" || line === "const ok = verifyPassword(value, stored);");
  assert.deepEqual(offenders, allowed, "every remaining call must be the two inside checkCredential");
  assert.ok(!/function isAuthenticatedAsParticipant\(/.test(serverSrc), "the unguarded helper is gone");
});

test("SERVER: the shared helpers bind a header PIN to the participant it names", () => {
  const isAuth = serverSrc.slice(serverSrc.indexOf("function isAuthenticatedAsParticipantReq("), serverSrc.indexOf("function isAuthenticatedAsParticipantReq(") + 400);
  assert.ok(isAuth.includes("boundParticipantId(req) === participant.id"));
  assert.ok(isAuth.includes('checkCredential(req, slug, participant.id, req.get("x-qracks-auth") || "", participant.pin)'));
  const owner = serverSrc.slice(serverSrc.indexOf("function headerIsOwnerPassword("), serverSrc.indexOf("function sendIfCredentialThrottled("));
  assert.ok(owner.includes("if (!req || boundParticipantId(req)) return false;"), "a bound header is never the admin password");
  assert.ok(owner.includes("checkCredential(req, slug, OWNER_TARGET,"));
  assert.ok(/function isRequestAdminOrOwner[\s\S]{0,120}if \(headerIsOwnerPassword\(req, slug, value\)\) return true;/.test(serverSrc));
  assert.ok(/function resolveMetaAuthTier[\s\S]{0,200}!boundParticipantId\(req\)\s*&& checkCredential\(req, slug, OWNER_TARGET, providedOwnerAuth/.test(serverSrc));
  const identity = serverSrc.slice(serverSrc.indexOf("function computeRequesterIdentity("), serverSrc.indexOf("async function filterPicksForRequest("));
  assert.ok(identity.includes("const p = bound ? (meta.participants || []).find((x) => x.id === bound) : null;"));
  assert.equal((identity.match(/checkCredential\(/g) || []).length, 1, "one participant, never a loop over everyone");
  assert.ok(!/\.forEach\(\(p\) => \{\s*if \(p\.pin && checkCredential/.test(identity));
});

test("SERVER: the admin password and participant PINs can never share a target", () => {
  const tk = serverSrc.slice(serverSrc.indexOf("const OWNER_TARGET ="), serverSrc.indexOf("function credentialVersion("));
  assert.ok(tk.includes('const OWNER_TARGET = Object.freeze({ credential: "owner" });'), "a sentinel, not a string a participant id could equal");
  assert.ok(tk.includes('const PLATFORM_TARGET = Object.freeze({ credential: "platform" });'));
  assert.ok(tk.includes('if (target === OWNER_TARGET) return "owner";') && tk.includes('if (target === PLATFORM_TARGET) return "platform";') && tk.includes('return "pin:" + String(target);'));
  assert.ok(tk.includes('const PLATFORM_SCOPE = "__platform__";'), "a scope no [a-z0-9-] slug can equal");
  const ver = serverSrc.slice(serverSrc.indexOf("function credentialVersion("), serverSrc.indexOf("function credentialVersion(") + 900);
  assert.ok(/if \(!isHashed\(stored\)\) \{[\s\S]*crypto\.scryptSync\(material, salt, 32\)/.test(ver), "a plaintext credential goes through scrypt first: no fast digest is persisted, and rotating it changes the version");
  assert.ok(ver.includes('crypto.createHmac("sha256", sessionSecret).update("credential-version\\0" + material)'), "keyed, not a bare hash");
  const ctxFn = serverSrc.slice(serverSrc.indexOf("function credentialContext("), serverSrc.indexOf("function checkCredential("));
  assert.ok(ctxFn.includes("const tKey = targetKey(target);"));
  assert.ok(ctxFn.includes("const version = credentialVersion(stored);"), "the budget knows which version of the credential it counts against");
  assert.ok(ctxFn.includes("device.targets.includes(tKey)"));
  const trust = serverSrc.slice(serverSrc.indexOf("function trustDevice("), serverSrc.indexOf("function credentialContext("));
  assert.ok(trust.includes("const key = targetKey(target);") && trust.includes("targets.push(key);"));
  assert.ok(serverSrc.includes('const TRUSTED_DEVICE_PURPOSE = "trusted_device_v2";'));
});

test("SERVER: every checkCredential call names one target", () => {
  const calls = serverSrc.match(/checkCredential\(req[^)]*\)/g) || [];
  assert.ok(calls.length >= 9);
  for (const c of calls) {
    assert.ok(/checkCredential\(req, [^,]+, (OWNER_TARGET|PLATFORM_TARGET|participant\.id|p\.id|target),/.test(c), c);
  }
});

test("SERVER: the budget is reserved before scrypt, only for a credential that exists, and settled when the response ends", () => {
  const ctxFn = serverSrc.slice(serverSrc.indexOf("function credentialContext("), serverSrc.indexOf("function checkCredential("));
  assert.ok(ctxFn.includes("credentialLimiter.begin({ ip: requestClientIp(req), quiniela, target: tKey, version, value: plain, trustedDeviceId })"));
  assert.ok(ctxFn.includes('req.res.once("finish", settle)') && ctxFn.includes('req.res.once("close", settle)'));
  const check = serverSrc.slice(serverSrc.indexOf("function checkCredential("), serverSrc.indexOf("function headerIsOwnerPassword("));
  const guardAt = check.indexOf("if (!value || !stored) return false;");
  const ctxAt = check.indexOf("credentialContext(req, slug, target, value, stored)");
  const verifyAt = check.indexOf("const ok = verifyPassword(value, stored);");
  assert.ok(guardAt !== -1 && guardAt < ctxAt && ctxAt < verifyAt, "no reservation without a stored credential; reserve first, compare second");
  assert.ok(check.indexOf("if (ctx.blocked) return false;") < verifyAt, "a throttled request never reaches scrypt");
  assert.ok(ctxFn.includes("requestClientIp(req)"), "the client as clientIp.js resolves it, not req.ip (see clientIp.test.js)");
});

test("SERVER: trusted-device cookies are signed, scoped, and handed out only after a proven credential", () => {
  const read = serverSrc.slice(serverSrc.indexOf("function readTrustedDevice("), serverSrc.indexOf("function trustDevice("));
  assert.ok(read.includes("verifySessionToken(raw)") && read.includes("token.purpose === TRUSTED_DEVICE_PURPOSE") && read.includes('token.slug === (slug || "_root")'));
  const issue = serverSrc.slice(serverSrc.indexOf("function trustDevice("), serverSrc.indexOf("function credentialContext("));
  assert.ok(issue.includes("SESSION_COOKIE_OPTIONS") && issue.includes(".slice(-TRUSTED_DEVICE_MAX_TARGETS)"));
  assert.ok(routeBody('app.post("/api/verify-pin"').includes("trustDevice(req, res, credSlug, participant.id);"));
  assert.ok(routeBody('app.post("/api/verify-owner"').includes("trustDevice(req, res, credSlug, OWNER_TARGET);"));
  assert.ok(routeBody('app.post("/api/set-pin"').includes("trustDevice(req, res, claimSlug, participant.id);"));
  assert.ok(routeBody('app.post("/api/self-register"').includes("trustDevice(req, res, derivedSlug, newParticipant.id);"));
  assert.ok(routeBody('app.post("/api/create-quiniela"').includes("trustDevice(req, res, cleanSlug, OWNER_TARGET);"));
  // A trust token is never a session or a setup claim.
  assert.ok(serverSrc.includes("if (session.purpose) return null;"));
});

test("SERVER: credential endpoints answer 429 too_many_attempts when the limit is the reason", () => {
  const send = serverSrc.slice(serverSrc.indexOf("function sendIfCredentialThrottled("), serverSrc.indexOf("function isAuthenticatedAsParticipantReq("));
  assert.ok(send.includes('res.status(429).json({ error: "too_many_attempts" })'));
  assert.ok(send.includes('res.set("Retry-After"'));
  for (const marker of ['app.post("/api/verify-pin"', 'app.post("/api/verify-owner"', 'app.post("/api/set-pin"', 'app.post("/api/migrate-quiniela"', 'app.post("/api/kv/:key"', 'app.post("/api/submit-bet-answer"']) {
    assert.ok(routeBody(marker).includes("sendIfCredentialThrottled(req, res)"), marker);
  }
  const verifyPin = routeBody('app.post("/api/verify-pin"');
  assert.ok(verifyPin.includes("checkCredential(req, credSlug, participant.id, pin, participant.pin)"));
  assert.ok(verifyPin.includes("issueSessionCookie(res, credSlug, participant);"), "cookie scoped to the metaKey's quiniela");
  const verifyOwner = routeBody('app.post("/api/verify-owner"');
  assert.ok(verifyOwner.includes("if (!value) return res.json({ ok: false });"));
  assert.ok(verifyOwner.includes("p.id === bound && checkCredential(req, credSlug, p.id, providedAuth, p.pin)"));
});

test("FRONTEND: a PIN goes out bound to the current user; the admin password goes out alone", () => {
  const fn = indexSrc.slice(indexSrc.indexOf("function setAuthHeaders(headers, cred){"), indexSrc.indexOf("function setAuthHeaders(headers, cred){") + 500);
  assert.ok(fn.includes('headers["X-Qracks-Auth"] = cred;'));
  assert.ok(fn.includes('if(cred === currentUserPinCache && cred !== ownerPasswordCache && currentUser && currentUser.id != null){'));
  assert.ok(fn.includes('headers["X-Qracks-Participant"] = String(currentUser.id);'));
  assert.equal((indexSrc.match(/X-Qracks-Auth/g) || []).length, 1, "every request sets the header through setAuthHeaders");
});

// ---- P2: an admin role change the server refuses is said out loud ---------

test("SERVER: an admin-role change the writer may not make refuses the whole write with owner_password_required", () => {
  const merge = serverSrc.slice(serverSrc.indexOf("function mergeProtectedMetaFields("), serverSrc.indexOf("function mergeProtectedPlatformFields("));
  assert.ok(merge.includes("if (!!p.isAdmin !== !!old.isAdmin) adminRoleChangesRefused += 1;"));
  assert.ok(/if \(!canChangeOwnerFields && !old && p\.isAdmin\) \{[\s\S]{0,250}adminRoleChangesRefused \+= 1;/.test(merge), "adding a new admin is refused too");
  assert.ok(merge.includes("adminRoleChangesRefused,"));
  const post = routeBody('app.post("/api/kv/:key"');
  const refuseAt = post.indexOf("if (metaMerge.adminRoleChangesRefused > 0) {");
  assert.ok(refuseAt !== -1);
  const after = post.slice(refuseAt, refuseAt + 700);
  assert.ok(after.includes('await client.query("ROLLBACK");') && after.includes('res.status(403).json({ error: "owner_password_required" })'));
  assert.ok(refuseAt < post.indexOf("putRow(info.metaKey"), "refused before anything is written");
});

test("FRONTEND: the admin toggle asks for the admin password instead of claiming success", () => {
  const start = indexSrc.indexOf('adminCheckbox.addEventListener("change"');
  const body = indexSrc.slice(start, start + 1800);
  assert.ok(body.includes('if(!result.ok && result.error === "owner_password_required"){'));
  assert.ok(/qzPrompt\([^)]*secret: true/.test(body));
  assert.ok(body.includes("result = await setMetaWithError(meta, { owner: pw.trim() });"));
  assert.ok(body.includes("p.isAdmin = previousValue;"), "still rolls back on failure");
  assert.ok(/owner_password_required: "Para cambiar quién es admin/.test(indexSrc));
  assert.ok(/wrong_owner_password: "❌ Contraseña de administrador incorrecta"/.test(indexSrc));
});

test("FRONTEND: PIN and password screens say 'too many attempts' when that is the reason", () => {
  assert.ok(/function pinFailureMessage\(result, fallback\)\{\s*return result && result\.error === "too_many_attempts"/.test(indexSrc));
  assert.equal((indexSrc.match(/toast\(pinFailureMessage\(/g) || []).length, 5, "PIN login, change PIN, admin re-auth, Ajustes, Panel de plataforma");
});

// ---- "éxito falso" after a participants refresh (Product QA F4) ----------

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
const adoptFreshMeta = new Function(extractFunction(indexSrc, "function adoptFreshMeta(target, fresh)") + "; return adoptFreshMeta;")();

test("FRONTEND: a refresh keeps the participant objects screens already hold, so a later edit is not lost", () => {
  const carla = { id: "p_c", name: "Carla", paid: false, rev: 1, hasPin: true };
  const beto = { id: "p_b", name: "Beto", paid: true, rev: 2, staleField: "x" };
  const meta = { groupName: "Q", participants: [beto, carla], participantsRevision: 1 };
  const rowHandle = carla; // what a rendered row's handler closed over
  const fresh = {
    groupName: "Q", participantsRevision: 2,
    participants: [{ id: "p_b", name: "Beto", paid: true, rev: 3 }, { id: "p_c", name: "Carla", paid: false, rev: 1, hasPin: true }, { id: "p_z", name: "Zeta", rev: 0 }],
  };
  adoptFreshMeta(meta, fresh);
  assert.equal(meta.participants.length, 3);
  assert.equal(meta.participants[1], rowHandle, "same object, not a copy");
  assert.equal(meta.participants[0], beto);
  assert.equal(beto.rev, 3, "fields come from the server");
  assert.ok(!("staleField" in beto), "fields the server no longer has are dropped");
  assert.equal(meta.participantsRevision, 2);
  rowHandle.name = "Carla2"; // the rename handler mutates what it holds...
  assert.equal(meta.participants.find((p) => p.id === "p_c").name, "Carla2", "...and the next save carries it");
});

test("FRONTEND: every post-save refresh of meta goes through adoptFreshMeta", () => {
  assert.equal((indexSrc.match(/Object\.assign\(meta, fresh\)/g) || []).length, 0);
  assert.ok((indexSrc.match(/if\(fresh\) adoptFreshMeta\(meta, fresh\);/g) || []).length >= 5);
});

test("SERVER: an owner action refused while the admin password was throttled says 429, not 'wrong password'", () => {
  const post = routeBody('app.post("/api/kv/:key"');
  const at = post.indexOf("if (metaMerge.adminRoleChangesRefused > 0) {");
  const block = post.slice(at, at + 600);
  assert.ok(block.indexOf("if (sendIfCredentialThrottled(req, res)) return;") < block.indexOf('error: "owner_password_required"'));
});


// ---- platform password ----------------------------------------------------

test("SERVER: every platform-password check goes through the limiter", () => {
  assert.ok(!/verifyPassword\(providedPlatformAuth/.test(serverSrc));
  assert.ok(!/verifyPassword\(password, stored\)/.test(serverSrc));
  const uses = serverSrc.match(/checkPlatformCredential\(req, [^)]*\)/g) || [];
  assert.ok(uses.length >= 13, `found ${uses.length}`);
  // Every 403 after a failed platform check first says 429 when the limit is the reason.
  const blocks = serverSrc.split("if (!checkPlatformCredential(req, providedPlatformAuth,").slice(1);
  for (const b of blocks) {
    const head = b.slice(0, 220);
    assert.ok(head.indexOf("sendIfCredentialThrottled(req, res)") !== -1 && head.indexOf("sendIfCredentialThrottled(req, res)") < head.indexOf("res.status(403)"), head);
  }
  const vp = routeBody('app.post("/api/verify-platform"');
  assert.ok(vp.includes("const ok = checkPlatformCredential(req, password, stored);"));
  assert.ok(vp.includes("if (!ok && sendIfCredentialThrottled(req, res)) return;"));
  assert.ok(vp.includes("if (ok) trustDevice(req, res, PLATFORM_SCOPE, PLATFORM_TARGET);"));
  assert.ok(/function resolveMetaAuthTier[\s\S]{0,400}checkPlatformCredential\(req, providedPlatformAuth, platformHash\)/.test(serverSrc));
});

test("SERVER: a plaintext platform password (env bootstrap) is compared in constant time", () => {
  const fn = serverSrc.slice(serverSrc.indexOf("function verifyPassword("), serverSrc.indexOf("function verifyPassword(") + 500);
  assert.ok(fn.includes("crypto.timingSafeEqual(a, b)"));
  assert.ok(!fn.includes("return String(plain) === String(stored);"));
});

// ---- persistence ------------------------------------------------------------

test("counters survive a restart: a reloaded limiter keeps blocking", () => {
  let now = 1_000_000;
  const saved = new Map();
  const opts = { now: () => now, idKey: () => "stable-secret", onChange: (snap) => saved.set(snap.id, snap) };
  const before = createCredentialAttemptLimiter(opts);
  for (let i = 0; i < 30; i++) {
    const a = before.begin({ ip: "10.4.0." + Math.floor(i / 5), quiniela: "q", target: "pin:p_admin", version: "v1", value: "g" + i });
    if (!a.blocked) a.settle(false);
  }
  assert.equal(before.begin({ ip: "203.0.113.1", quiniela: "q", target: "pin:p_admin", version: "v1", value: "x" }).blocked, true);
  for (const snap of saved.values()) {
    assert.deepEqual(Object.keys(snap).sort(), ["count", "id", "rule", "scope", "version", "windowMs", "windowStart"]);
    assert.ok(!JSON.stringify(snap).includes("10.4.0."), "no IP in what is persisted");
    assert.ok(!JSON.stringify(snap).includes("p_admin"), "no participant in what is persisted");
  }
  now += 60 * 1000; // a restart a minute later
  const after = createCredentialAttemptLimiter({ now: () => now, idKey: () => "stable-secret" });
  after.load([...saved.values()]);
  assert.equal(after.begin({ ip: "203.0.113.1", quiniela: "q", target: "pin:p_admin", version: "v1", value: "y" }).blocked, true, "still blocked after the restart");
  assert.equal(after.begin({ ip: "203.0.113.1", quiniela: "q", target: "pin:p_admin", version: "v2", value: "y" }).blocked, false, "a reset still recovers");
});

test("load ignores expired rows, unknown rules, changed windows and future timestamps", () => {
  const now = 10_000_000;
  const l = createCredentialAttemptLimiter({ now: () => now, idKey: () => "k" });
  const restored = l.load([
    { id: "a", rule: "target-15m", windowStart: now - 16 * 60 * 1000, windowMs: 15 * 60 * 1000, count: 30, version: "v" },
    { id: "b", rule: "nope", windowStart: now, windowMs: 1, count: 1 },
    { id: "c", rule: "target-15m", windowStart: now, windowMs: 99, count: 1 },
    { id: "d", rule: "target-15m", windowStart: now + 1000, windowMs: 15 * 60 * 1000, count: 1 },
    { id: "e", rule: "ip-15m", windowStart: now - 1000, windowMs: 15 * 60 * 1000, count: 9999 },
  ]);
  assert.equal(restored, 1);
});

test("SERVER: the counters are loaded before listening, written in batches, flushed on SIGTERM", () => {
  assert.ok(serverSrc.includes("CREATE TABLE IF NOT EXISTS credential_attempt_buckets ("));
  assert.ok(serverSrc.includes("ALTER TABLE credential_attempt_buckets ENABLE ROW LEVEL SECURITY"), "not readable through Supabase's public API roles");
  const start = serverSrc.slice(serverSrc.indexOf("async function start(retriesLeft)"), serverSrc.indexOf("async function start(retriesLeft)") + 600);
  assert.ok(start.indexOf("await loadCredentialAttempts();") !== -1 && start.indexOf("await loadCredentialAttempts();") < start.indexOf("app.listen("));
  assert.ok(serverSrc.includes('process.once("SIGTERM"'));
  assert.ok(/idKey: \(\) => crypto\.createHmac\("sha256", sessionSecret\)/.test(serverSrc));
});


test("SERVER: non-string credentials from a JSON body never count as a credential", () => {
  const check = serverSrc.slice(serverSrc.indexOf("function checkCredential("), serverSrc.indexOf("function checkCredential(") + 500);
  assert.ok(check.includes('if (plain != null && typeof plain !== "string" && typeof plain !== "number") return false;'));
});

test("SERVER: persistence writes one batch at a time and its queues are bounded", () => {
  const f = serverSrc.slice(serverSrc.indexOf("async function flushCredentialAttempts()"), serverSrc.indexOf("async function loadCredentialAttempts()"));
  assert.ok(f.includes("if (credentialAttemptsFlushing) {"), "flushes are serialized");
  assert.ok(f.includes("!credentialAttemptsDirty.has(r.id) && credentialAttemptsDirty.size < 100000"));
  assert.ok(serverSrc.includes("if (credentialAttemptsDirty.size > 100000) credentialAttemptsDirty.delete("));
  const load = serverSrc.slice(serverSrc.indexOf("async function loadCredentialAttempts()"), serverSrc.indexOf("async function loadCredentialAttempts()") + 1600);
  assert.ok(/WHERE scope = 'target' AND window_start \+ window_ms > \$1`/.test(load), "every credential bucket, no limit");
  assert.ok(/WHERE scope <> 'target'[\s\S]*ORDER BY updated_at DESC\s*LIMIT 200000\s*\) recent ORDER BY updated_at ASC/.test(load), "newest network buckets, inserted oldest-first");
  assert.ok(serverSrc.includes("if (rateBuckets.size > 100000) rateBuckets.delete(rateBuckets.keys().next().value);"));
});


test("load keeps the newest network buckets when they exceed the in-memory cap (rows given oldest-first)", () => {
  let now = 50_000_000;
  const rules = [{ name: "net-15m", scope: "net", windowMs: 15 * 60 * 1000, max: 1 }];
  const saved = [];
  const before = createCredentialAttemptLimiter({ rules, now: () => now, idKey: () => "k", onChange: (snap) => saved.push(snap) });
  for (let i = 1; i <= 5; i++) { now += 1000; fail(before, "net" + i, "q", "v", "t"); } // net1 oldest … net5 newest
  const after = createCredentialAttemptLimiter({ rules, now: () => now, idKey: () => "k", maxOpenBuckets: 3 });
  after.load(saved); // oldest-first, as loadCredentialAttempts orders them
  const blocked = (net) => after.begin({ ip: net, quiniela: "q", target: "t", value: "other" }).blocked;
  assert.equal(blocked("net5"), true, "newest kept");
  assert.equal(blocked("net4"), true);
  assert.equal(blocked("net3"), true);
  assert.equal(blocked("net1"), false, "oldest evicted by the cap");
});
