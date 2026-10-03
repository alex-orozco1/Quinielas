// credentialAttempts.test.js — the limit on FAILED credential checks.
//
// Runs the real limiter from credentialAttempts.js with an injected clock, and
// checks that server.js routes every admin/participant PIN and owner password
// comparison through it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createCredentialAttemptLimiter, DEFAULT_RULES, PROGRESSIVE, progressiveWaitMs } = require("../credentialAttempts");

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

test("defaults: hard windows per network and per trusted device; a progressive wait per credential", () => {
  const byName = Object.fromEntries(DEFAULT_RULES.map((r) => [r.name, r]));
  assert.deepEqual(byName["ip-15m"], { name: "ip-15m", scope: "ip", windowMs: 15 * MIN, max: 20 });
  assert.equal(byName["ip-24h"].max, 100);
  assert.equal(byName["net-15m"].max, 60);
  assert.equal(byName["net-24h"].max, 300);
  assert.equal(byName["device-15m"].max, 10);
  assert.equal(byName["device-24h"].max, 50);
  assert.ok(!DEFAULT_RULES.some((r) => r.scope === "target"), "no hard lockout per credential any more");
  assert.deepEqual(PROGRESSIVE, { rule: "target-progressive", free: 10, baseMs: 15000, capMs: 15 * MIN, forgetMs: 24 * 60 * MIN });
});

test("progressive wait: 10 free, then 15 s × 2^n since the last failure, never more than 15 min", () => {
  const waits = [9, 10, 11, 12, 13, 14, 15, 16, 30].map((n) => progressiveWaitMs(n) / 1000);
  assert.deepEqual(waits, [0, 15, 30, 60, 120, 240, 480, 900, 900]);
});

test("the 21st distinct wrong value from one IP within 15 min is blocked, with a Retry-After", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 20; i++) assert.equal(fail(limiter, "1.1.1.1", "q", "000" + i, "t" + i).blocked, false);
  const eleventh = limiter.begin({ ip: "1.1.1.1", quiniela: "q", target: "p_admin", value: "9999" });
  assert.equal(eleventh.blocked, true);
  assert.ok(eleventh.retryAfterMs > 0 && eleventh.retryAfterMs <= 15 * MIN);
});

test("against one credential: 10 free failures, then the 11th has to wait 15 s, with the exact time left", () => {
  const { limiter, advance } = limiterAt(0);
  for (let i = 0; i < 10; i++) { assert.equal(fail(limiter, "10.0.0." + i, "q", "g" + i).blocked, false); advance(1000); }
  // last failure at t=9s; the 11th is allowed at 9 s + 15 s = 24 s
  const now11 = limiter.begin({ ip: "10.0.1.1", quiniela: "q", target: "p_admin", value: "g10" });
  assert.equal(now11.blocked, true);
  assert.equal(now11.retryAfterMs, 14000, "10 s now, allowed at 24 s");
});

test("asking while you have to wait changes nothing: the wait is not extended and nothing is counted", () => {
  const { limiter, advance } = limiterAt(0);
  for (let i = 0; i < 10; i++) fail(limiter, "10.0.0." + i, "q", "g" + i);
  for (let s = 0; s < 14; s++) {
    const r = limiter.begin({ ip: "10.0.2." + s, quiniela: "q", target: "p_admin", value: "spam" + s });
    assert.equal(r.blocked, true);
    assert.equal(r.retryAfterMs, (15 - s) * 1000, "the countdown keeps going down");
    advance(1000);
  }
  advance(1000); // 15 s after the last real failure
  const allowed = limiter.begin({ ip: "10.0.3.1", quiniela: "q", target: "p_admin", value: "next" });
  assert.equal(allowed.blocked, false, "allowed exactly when it said, despite 14 rejected requests");
  allowed.settle(false);
  // 11 failures on record now: the next wait is 30 s, not more.
  assert.equal(limiter.begin({ ip: "10.0.3.2", quiniela: "q", target: "p_admin", value: "n2" }).retryAfterMs, 30000);
});

test("the reproduced attack — a 4-digit search from one IP — is slowed to a crawl", () => {
  const { limiter } = limiterAt(0);
  let answered = 0;
  for (let pin = 0; pin < 10000; pin++) {
    const a = limiter.begin({ ip: "6.6.6.6", quiniela: "victima", target: "p_admin", value: String(pin).padStart(4, "0") });
    if (a.blocked) continue;
    answered++;
    a.settle(false);
  }
  assert.equal(answered, 10, "an instant burst gets only the 10 free attempts");
});

test("a burst spread across many IPs gets the same 10 free attempts", () => {
  const { limiter } = limiterAt(0);
  let answered = 0;
  for (let pin = 0; pin < 10000; pin++) {
    const ip = "10.0." + Math.floor(pin / 5) + "." + (pin % 5);
    const a = limiter.begin({ ip, quiniela: "victima", target: "p_admin", value: String(pin).padStart(4, "0") });
    if (a.blocked) continue;
    answered++;
    a.settle(false);
  }
  assert.equal(answered, 10);
});

test("sustained attack over 30 days with unlimited IPs, firing the instant it is allowed: ~96 guesses a day", () => {
  const { limiter, advance } = limiterAt(0);
  let answered = 0, ipN = 0;
  const end = 30 * 24 * 60 * MIN;
  for (let t = 0; t < end;) {
    const a = limiter.begin({ ip: "10." + (ipN >> 16 & 255) + "." + (ipN >> 8 & 255) + "." + (ipN++ & 255), quiniela: "victima", target: "p_admin", value: "v" + answered });
    if (a.blocked) { advance(a.retryAfterMs); t += a.retryAfterMs; continue; }
    answered++; a.settle(false); advance(1000); t += 1000;
  }
  const perDay = answered / 30;
  assert.ok(perDay > 95 && perDay < 98, `perDay=${perDay}`);
  // At that pace, 50 % of a 4-digit PIN space takes about 52 days.
  assert.ok(5000 / perDay > 50);
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
  assert.equal(limiter.begin({ ip: "10.2.0.1", quiniela: "q", target: "p_admin", value: "1234" }).blocked, true, "untrusted: has to wait");
  const trusted = limiter.begin({ ip: "10.2.0.1", quiniela: "q", target: "p_admin", value: "1234", trustedDeviceId: "dev1" });
  assert.equal(trusted.blocked, false, "same IP, but a device that already proved this credential");
  trusted.settle(true);
  // ...and logging in from it changes nothing for anyone else: the attacker still waits
  assert.equal(limiter.begin({ ip: "10.2.9.9", quiniela: "q", target: "p_admin", value: "x" }).blocked, true);
  // ...and a trusted device has its own small budget, so a stolen device cookie is not a free pass.
  for (let i = 0; i < 10; i++) fail(limiter, "x", "q", "t" + i, "p_admin", "dev1");
  assert.equal(limiter.begin({ ip: "x", quiniela: "q", target: "p_admin", value: "t99", trustedDeviceId: "dev1" }).blocked, true);
});

test("a login never resets the credential's wait: the owner's success hands the attacker nothing", () => {
  const { limiter, advance } = limiterAt(0);
  for (let i = 0; i < 12; i++) { const a = limiter.begin({ ip: "10.5.0." + i, quiniela: "q", target: "p_admin", value: "g" + i }); if (!a.blocked) a.settle(false); else advance(a.retryAfterMs); }
  const w = limiter.begin({ ip: "203.0.113.5", quiniela: "q", target: "p_admin", value: "right" });
  assert.equal(w.blocked, true, "the right PIN also waits its turn on a new device");
  advance(w.retryAfterMs);
  const ok = limiter.begin({ ip: "203.0.113.5", quiniela: "q", target: "p_admin", value: "right" });
  assert.equal(ok.blocked, false, "once allowed, the owner gets in");
  ok.settle(true);
  // The attacker gets exactly the one slot that was due anyway, then waits longer.
  assert.equal(fail(limiter, "10.5.1.1", "q", "after1").blocked, false, "the slot the owner did not use up");
  const next = limiter.begin({ ip: "10.5.1.2", quiniela: "q", target: "p_admin", value: "after2" });
  assert.equal(next.blocked, true, "no 10 free guesses after the owner's login");
  assert.equal(next.retryAfterMs, progressiveWaitMs(12), "12 failures on record (11 before the login, 1 after): the wait keeps escalating");
});

test("frequent legitimate logins and Ajustes reloads do not add a single guess to the attacker's budget", () => {
  // Same attacker, same 7 days, against the PIN and the admin password at once;
  // once alone, once with an owner who never stops logging in.
  function run(withOwner) {
    const { limiter, advance } = limiterAt(0);
    const end = 7 * 24 * 60 * MIN;
    let t = 0, n = 0, ipN = 0;
    const guesses = { p_admin: 0, owner: 0 };
    const nextFor = { p_admin: 0, owner: 0 };
    const ownerEvery = 10 * MIN;
    let nextOwner = 0, ownerLogins = 0;
    while (t < end) {
      const target = nextFor.p_admin <= nextFor.owner ? "p_admin" : "owner";
      const due = Math.min(nextFor[target], withOwner ? nextOwner : Infinity);
      if (due >= end) break;
      if (due > t) { advance(due - t); t = due; }
      if (withOwner && t >= nextOwner) {
        // Every 10 min: Ajustes reload on the trusted phone (admin password),
        // the PIN resent with each request, and, every hour, an explicit login
        // from a NEW device that waits its turn when it has to.
        for (const [tg, value] of [["owner", "the-password"], ["p_admin", "4321"]]) {
          const trusted = limiter.begin({ ip: "203.0.113.50", quiniela: "q", target: tg, value, trustedDeviceId: "owner-phone" });
          if (!trusted.blocked) { trusted.settle(true); ownerLogins++; }
          const header = limiter.begin({ ip: "203.0.113.50", quiniela: "q", target: tg, value });
          if (!header.blocked) { header.settle(true); ownerLogins++; }
        }
        if (Math.floor(nextOwner / (60 * MIN)) !== Math.floor((nextOwner - ownerEvery) / (60 * MIN))) {
          const fresh = limiter.begin({ ip: "198.51.100." + (ownerLogins & 255), quiniela: "q", target: "p_admin", value: "4321" });
          if (!fresh.blocked) { fresh.settle(true); ownerLogins++; }
        }
        nextOwner += ownerEvery;
        continue;
      }
      const a = limiter.begin({ ip: "10." + (ipN >> 16 & 255) + "." + (ipN >> 8 & 255) + "." + (ipN++ & 255), quiniela: "q", target, value: "g" + n++ });
      if (a.blocked) { nextFor[target] = t + a.retryAfterMs; continue; }
      a.settle(false); guesses[target]++; nextFor[target] = t + 1000;
    }
    return { guesses, ownerLogins };
  }
  const alone = run(false);
  const busy = run(true);
  assert.ok(busy.ownerLogins > 2000, `the owner really was busy: ${busy.ownerLogins} successful logins`);
  assert.deepEqual(busy.guesses, alone.guesses, "exactly the same number of guesses, per credential");
  assert.ok(alone.guesses.p_admin / 7 < 100, `about 96 a day plus the first day's ramp: ${alone.guesses.p_admin / 7}`);
});

test("concurrency: a parallel burst against one credential reserves before it is judged", () => {
  const { limiter } = limiterAt(0);
  const pending = [];
  for (let i = 0; i < 50; i++) pending.push(limiter.begin({ ip: "10.7." + i + ".1", quiniela: "q", target: "p_admin", value: "p" + i }));
  const admitted = pending.filter((a) => !a.blocked);
  assert.equal(admitted.length, 10, "only the 10 free attempts are compared, even all at once");
  assert.ok(pending.filter((a) => a.blocked).every((a) => a.retryAfterMs === 15000));
  admitted.forEach((a) => a.settle(false));
});

test("concurrency: a success settling while failures are in flight does not let more through", () => {
  const { limiter } = limiterAt(0);
  const a = [];
  for (let i = 0; i < 10; i++) a.push(limiter.begin({ ip: "10.8.0." + i, quiniela: "q", target: "p_admin", value: i === 0 ? "right" : "w" + i }));
  assert.equal(limiter.begin({ ip: "10.8.9.9", quiniela: "q", target: "p_admin", value: "z0" }).blocked, true, "all 10 slots reserved while in flight");
  a[0].settle(true); // the right one finishes first: only its own slot comes back
  a.slice(1).forEach((x) => x.settle(false));
  assert.equal(fail(limiter, "10.8.1.1", "q", "n1").blocked, false, "the one slot the success gave back");
  assert.equal(limiter.begin({ ip: "10.8.2.1", quiniela: "q", target: "p_admin", value: "z" }).blocked, true, "and then the wait");
});

test("a credential under a long attack remembers a bounded number of values", () => {
  const { limiter, advance } = limiterAt(0, { maxSeenPerTarget: 50 });
  for (let i = 0; i < 300; i++) {
    const a = limiter.begin({ ip: "10.12." + (i >> 8) + "." + (i & 255), quiniela: "q", target: "p_admin", value: "v" + i });
    if (a.blocked) { advance(a.retryAfterMs); i--; continue; }
    a.settle(false);
  }
  // A value forgotten from the list is counted again if retried: stricter, never looser.
  advance(PROGRESSIVE.capMs);
  const again = limiter.begin({ ip: "10.12.9.9", quiniela: "q", target: "p_admin", value: "v0" });
  assert.equal(again.blocked, false);
  again.settle(false);
  assert.equal(limiter.begin({ ip: "10.12.9.10", quiniela: "q", target: "p_admin", value: "v1" }).retryAfterMs, PROGRESSIVE.capMs, "it counted: the wait started over at the cap");
});

test("forgotten after 24 h without failures", () => {
  const { limiter, advance } = limiterAt(0);
  for (let i = 0; i < 16; i++) { advance(20 * MIN); const a = limiter.begin({ ip: "10.6.0." + i, quiniela: "q", target: "p_admin", value: "g" + i }); if (!a.blocked) a.settle(false); }
  assert.ok(limiter.begin({ ip: "10.6.1.1", quiniela: "q", target: "p_admin", value: "y" }).blocked);
  advance(24 * 60 * MIN);
  for (let i = 0; i < 10; i++) assert.equal(fail(limiter, "10.6.2." + i, "q", "f" + i).blocked, false, "10 free again");
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
  // hashUnlessUnchanged compares a NEW value the caller is setting with the one
  // stored, only after the caller proved the current credential (or holds
  // platform rights): no guess is answered there (see its tests).
  const allowed = offenders.filter(({ line }) =>
    line === "if (!req) return verifyPassword(value, stored);" || line === "const ok = verifyPassword(value, stored);"
    || line === "if (isHashed(stored) && verifyPassword(String(plain), stored)) return stored;");
  assert.deepEqual(offenders, allowed, "every remaining call must be the two inside checkCredential (or hashUnlessUnchanged)");
  assert.equal(serverSrc.split("hashUnlessUnchanged(").length - 1, 5, "the definition and its four callers, nothing else");
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
  // Trust names one VERSION of the credential: a changed PIN or password ends it.
  assert.ok(ctxFn.includes("device.targets.includes(trustedEntry(tKey, version))"));
  const trust = serverSrc.slice(serverSrc.indexOf("function trustDevice("), serverSrc.indexOf("function credentialContext("));
  assert.ok(trust.includes("const key = targetKey(target);") && trust.includes("targets.push(trustedEntry(key, credentialVersion(stored)));"));
  assert.ok(trust.includes("if (!stored) return;"), "nothing stored, nothing to trust");
  assert.ok(serverSrc.includes('const TRUSTED_DEVICE_PURPOSE = "trusted_device_v3";'), "v2 tokens (unversioned) are not recognised");
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
  assert.ok(ctxFn.includes("credentialLimiter.begin({ ip: requestClientIp(req), quiniela, target: tKey, version, value: plain, trustedDeviceId });"));
  assert.ok(!/resetOnSuccess|qzExplicitLogin/.test(serverSrc), "no route can reset a credential's wait by logging in");
  assert.ok(!/resetOnSuccess/.test(fs.readFileSync(path.join(__dirname, "..", "credentialAttempts.js"), "utf8")));
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
  // Each grant names the stored credential it was proven (or set) against.
  assert.ok(routeBody('app.post("/api/verify-pin"').includes("trustDevice(req, res, credSlug, participant.id, participant.pin);"));
  assert.ok(routeBody('app.post("/api/verify-owner"').includes("trustDevice(req, res, credSlug, OWNER_TARGET, stored);"));
  assert.ok(routeBody('app.post("/api/verify-owner"').includes("trustDevice(req, res, credSlug, admin.id, admin.pin);"));
  const setPin = routeBody('app.post("/api/set-pin"');
  assert.ok(setPin.indexOf("participant.pin = hashUnlessUnchanged(newPin, participant.pin);") < setPin.indexOf("trustDevice(req, res, claimSlug, participant.id, participant.pin);"), "the device that changed the PIN is trusted for the NEW one");
  assert.ok(routeBody('app.post("/api/self-register"').includes("trustDevice(req, res, derivedSlug, newParticipant.id, newParticipant.pin);"));
  assert.ok(routeBody('app.post("/api/create-quiniela"').includes("trustDevice(req, res, cleanSlug, OWNER_TARGET, meta.settings.ownerPassword);"));
  const kv = routeBody('app.post("/api/kv/:key"');
  assert.ok(kv.includes('const mayChangeOwnerPw = authTier === "owner" || authTier === "platform" || (authTier === "admin-pin" && !oldOwnerPw);'));
  assert.ok(kv.includes("if (mayChangeOwnerPw && typeof typedOwnerPw === \"string\" && typedOwnerPw && !isHashed(typedOwnerPw)"), "only the writer who typed the new admin password, and may change it, is trusted for it");
  assert.ok(kv.includes("trustDevice(req, res, PLATFORM_SCOPE, PLATFORM_TARGET, finalValue.dashboardPassword);"), "a new platform password: the panel that set it is trusted for it");
  const grants = (serverSrc.match(/trustDevice\(req, res, [^)]*\)/g) || []).filter((g) => !g.includes("slug, target, stored"));
  assert.equal(grants.length, 9, "the nine grants above, each naming a stored credential: " + grants.join(" | "));
  assert.ok(grants.every((g) => g.split(",").length === 5), "five arguments: the last is the stored credential");
  // A trust token is never a session or a setup claim.
  assert.ok(serverSrc.includes("if (session.purpose) return null;"));
});

test("SERVER: credential endpoints answer 429 too_many_attempts when the limit is the reason", () => {
  const send = serverSrc.slice(serverSrc.indexOf("function sendIfCredentialThrottled("), serverSrc.indexOf("function isAuthenticatedAsParticipantReq("));
  assert.ok(send.includes('res.status(429).json({ error: "too_many_attempts", retryAfterSeconds })'), "the time left travels in the body too");
  assert.ok(send.includes('res.set("Retry-After", String(retryAfterSeconds));'));
  const rate = serverSrc.slice(serverSrc.indexOf("function rateLimit(name)"), serverSrc.indexOf("function rateLimit(name)") + 1200);
  assert.ok(rate.includes('return res.status(429).json({ error: "too_many_attempts", retryAfterSeconds });'), "the old request-count limiter says how long too");
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
  assert.ok(vp.includes("if (ok) trustDevice(req, res, PLATFORM_SCOPE, PLATFORM_TARGET, stored);"));
  assert.ok(/function resolveMetaAuthTier[\s\S]{0,400}checkPlatformCredential\(req, providedPlatformAuth, platformHash\)/.test(serverSrc));
});

test("SERVER: a plaintext platform password (env bootstrap) is compared in constant time", () => {
  const fn = serverSrc.slice(serverSrc.indexOf("function verifyPassword("), serverSrc.indexOf("function verifyPassword(") + 500);
  assert.ok(fn.includes("crypto.timingSafeEqual(a, b)"));
  assert.ok(!fn.includes("return String(plain) === String(stored);"));
});

// ---- persistence ------------------------------------------------------------

test("counters survive a restart: the wait continues where it was, with the same time left", () => {
  let now = 1_000_000;
  const saved = new Map();
  const opts = { now: () => now, idKey: () => "stable-secret", onChange: (snap) => saved.set(snap.id, snap) };
  const before = createCredentialAttemptLimiter(opts);
  for (let i = 0; i < 13; i++) {
    const a = before.begin({ ip: "10.4.0." + i, quiniela: "q", target: "pin:p_admin", version: "v1", value: "g" + i });
    if (a.blocked) { now += a.retryAfterMs; i--; continue; }
    a.settle(false);
  }
  // 13 failures: the next one waits 15 s × 2^3 = 120 s after the last.
  const w1 = before.begin({ ip: "203.0.113.1", quiniela: "q", target: "pin:p_admin", version: "v1", value: "x" });
  assert.equal(w1.retryAfterMs, 120000);
  for (const snap of saved.values()) {
    assert.deepEqual(Object.keys(snap).sort(), ["count", "id", "rule", "scope", "version", "windowMs", "windowStart"]);
    assert.ok(!JSON.stringify(snap).includes("10.4.0."), "no IP in what is persisted");
    assert.ok(!JSON.stringify(snap).includes("p_admin"), "no participant in what is persisted");
  }
  now += 30 * 1000; // a restart 30 s later
  const after = createCredentialAttemptLimiter({ now: () => now, idKey: () => "stable-secret" });
  after.load([...saved.values()]);
  const w2 = after.begin({ ip: "203.0.113.1", quiniela: "q", target: "pin:p_admin", version: "v1", value: "y" });
  assert.equal(w2.blocked, true, "still waiting after the restart");
  assert.equal(w2.retryAfterMs, 90000, "same deadline: 120 s − 30 s");
  assert.equal(after.begin({ ip: "203.0.113.1", quiniela: "q", target: "pin:p_admin", version: "v2", value: "y" }).blocked, false, "a reset still recovers");
});

test("load: the old hard-lockout rows (target-15m/24h) are ignored once; progressive rows are restored", () => {
  const now = 10_000_000;
  const l = createCredentialAttemptLimiter({ now: () => now, idKey: () => "k" });
  const restored = l.load([
    { id: "old1", rule: "target-15m", windowStart: now - 1000, windowMs: 15 * MIN, count: 30, version: "v" },
    { id: "old2", rule: "target-24h", windowStart: now - 1000, windowMs: 24 * 60 * MIN, count: 150, version: "v" },
    { id: "p1", rule: "target-progressive", windowStart: now - 1000, windowMs: 24 * 60 * MIN, count: 12, version: "v" },
    { id: "p2", rule: "target-progressive", windowStart: now - 25 * 60 * MIN, windowMs: 24 * 60 * MIN, count: 12, version: "v" },
    { id: "p3", rule: "target-progressive", windowStart: now - 1000, windowMs: 24 * 60 * MIN, count: 0, version: "v" },
  ]);
  assert.equal(restored, 1, "only the live progressive row with failures");
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

// ---- the time left, as people see it ----------------------------------------

const uiFns = new Function(
  "const ERROR_MESSAGES = { too_many_attempts: 'GENERIC', unauthorized: 'NOPE' };\n" +
  extractFunction(indexSrc, "function humanizeError(code, result)") + "\n" +
  extractFunction(indexSrc, "function formatWait(seconds)") + "\n" +
  extractFunction(indexSrc, "function tooManyAttemptsMessage(retryAfterSeconds)") + "\n" +
  "return { humanizeError, formatWait, tooManyAttemptsMessage };"
)();

test("FRONTEND: the wait is shown as the real time left", () => {
  const { formatWait, tooManyAttemptsMessage, humanizeError } = uiFns;
  // A non-breaking space between number and unit: "15 s" never wraps at 375 px.
  assert.equal(formatWait(15), "15\u00a0s");
  assert.equal(formatWait(59), "59\u00a0s");
  assert.equal(formatWait(60), "1\u00a0min");
  assert.equal(formatWait(61), "2\u00a0min", "rounded up: never promises less than the real wait");
  assert.equal(formatWait(900), "15\u00a0min");
  assert.equal(formatWait(7199), "2\u00a0h");
  assert.equal(tooManyAttemptsMessage(120), "Demasiados intentos. Intenta de nuevo en 2\u00a0min, o entra desde un dispositivo donde ya hayas entrado.");
  assert.equal(tooManyAttemptsMessage(undefined), "GENERIC", "no number from the server: the generic copy");
  assert.equal(humanizeError("too_many_attempts", { retryAfterSeconds: 30 }), "Demasiados intentos. Intenta de nuevo en 30\u00a0s, o entra desde un dispositivo donde ya hayas entrado.");
  assert.equal(humanizeError("unauthorized", { retryAfterSeconds: 30 }), "NOPE");
});

test("FRONTEND: every response that can carry too_many_attempts hands retryAfterSeconds to the message", () => {
  assert.equal((indexSrc.match(/if\(!res\.ok\) return \{ ok: false, error: data\.error \|\| null, retryAfterSeconds: data\.retryAfterSeconds \};/g) || []).length, 2, "verify-owner, verify-platform");
  assert.ok(indexSrc.includes("return { ok: false, error: data.error || null, retryAfterSeconds: data.retryAfterSeconds };"), "verify-pin");
  assert.ok(indexSrc.includes("return { ok: res.ok, error: res.ok ? null : (data.error || null), retryAfterSeconds: res.ok ? null : data.retryAfterSeconds };"), "set-pin");
  assert.ok(!/humanizeError\(result\.error\)[^,]/.test(indexSrc), "no call drops the server's answer");
  assert.ok(indexSrc.includes("return result && result.error === \"too_many_attempts\" ? humanizeError(result.error, result) : fallback;"));
});

test("FRONTEND: after 5 wrong PINs the login points at the way out that exists (another admin resets it)", () => {
  const start = indexSrc.indexOf('"pin:" + p.id, (pin) => verifyParticipantPin(p.id, pin));');
  assert.ok(start > 0);
  const block = indexSrc.slice(start, start + 1300);
  assert.ok(block.includes('if(verification.error !== "too_many_attempts") loginPinMisses.set(p.id, (loginPinMisses.get(p.id) || 0) + 1);'));
  assert.ok(block.includes("(loginPinMisses.get(p.id) || 0) >= 5"));
  assert.ok(block.includes("¿Olvidaste tu PIN? Pide a quien organiza (o a otro admin) que lo resetee."));
  assert.ok(!block.includes("contraseña de administrador"), "does not offer a recovery that does not exist yet");
  assert.ok(block.includes("loginPinMisses.delete(p.id);"));
});


// ---- Technical QA findings on d1a05a9 ----------------------------------------

test("P1: the PIN a browser resends on every request does not reset the wait", () => {
  const { limiter, advance } = limiterAt(0);
  let guesses = 0;
  for (let cycle = 0; cycle < 5; cycle++) {
    // attacker until told to wait
    while (true) {
      const a = limiter.begin({ ip: "10.9." + cycle + "." + guesses, quiniela: "q", target: "p_admin", value: "g" + guesses });
      if (a.blocked) break;
      a.settle(false); guesses++;
    }
    // the owner keeps using the app: header-borne successes, not logins
    for (let k = 0; k < 20; k++) { const ok = limiter.begin({ ip: "203.0.113.7", quiniela: "q", target: "p_admin", value: "right" }); if (!ok.blocked) ok.settle(true); advance(100); }
  }
  assert.equal(guesses, 10, "the owner's activity hands the attacker nothing beyond the first 10");
});

test("P1: a header-borne success gives back its own reservation, so the owner's own tries never pile up", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 9; i++) fail(limiter, "10.10.0." + i, "q", "g" + i);
  for (let k = 0; k < 50; k++) { const ok = limiter.begin({ ip: "203.0.113.8", quiniela: "q", target: "p_admin", value: "right" }); assert.equal(ok.blocked, false); ok.settle(true); }
  assert.equal(fail(limiter, "10.10.1.1", "q", "tenth").blocked, false, "still the 10th failure, not the 60th");
  assert.equal(limiter.begin({ ip: "10.10.1.2", quiniela: "q", target: "p_admin", value: "eleventh" }).blocked, true);
});

test("P2: a value tried before waits like any other — no free 'was this tried?' oracle", () => {
  const { limiter } = limiterAt(0);
  fail(limiter, "203.0.113.9", "q", "4312"); // the owner's typo
  for (let i = 0; i < 9; i++) fail(limiter, "10.11.0." + i, "q", "g" + i);
  const probes = ["4312", "1111", "2222", "g3"].map((v) => limiter.begin({ ip: "6.6.6.6", quiniela: "q", target: "p_admin", value: v }));
  assert.ok(probes.every((p) => p.blocked), "every probe, seen or not, gets the same 429");
  assert.ok(probes.every((p) => p.retryAfterMs === probes[0].retryAfterMs), "and the same time left");
});

test("P2: same for the per-network windows", () => {
  const { limiter } = limiterAt(0);
  for (let i = 0; i < 20; i++) fail(limiter, "6.6.6.7", "q", "v" + i, "t" + i);
  assert.equal(limiter.begin({ ip: "6.6.6.7", quiniela: "q", target: "t0", value: "v0" }).blocked, true, "a value already counted from this network is still blocked");
});


// ---- The wait stays next to the form (Product QA: a 2.2 s toast is not enough) ----

// The real helpers from index.html, with a fake clock and a minimal element.
function waitUi() {
  let now = 1_000_000;
  const timers = [];
  const ui = new Function("Date", "setInterval", "clearInterval",
    "const esc = (s) => String(s).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c]);\n" +
    "const ERROR_MESSAGES = { too_many_attempts: 'GENERIC' };\n" +
    extractFunction(indexSrc, "function formatWait(seconds)") + "\n" +
    "const credentialWaitUntil = new Map();\n" +
    extractFunction(indexSrc, "function startCredentialWait(key, result)") + "\n" +
    extractFunction(indexSrc, "function credentialWaitLeft(key)") + "\n" +
    extractFunction(indexSrc, "function formatCountdown(seconds)") + "\n" +
    extractFunction(indexSrc, "function mountCredentialWait(el, key, opts)") + "\n" +
    "return { startCredentialWait, credentialWaitLeft, formatCountdown, mountCredentialWait };"
  )({ now: () => now }, (fn) => { timers.push(fn); return timers.length; }, () => {});
  function el() {
    const left = { textContent: "" };
    const cls = new Set();
    return {
      isConnected: true, hidden: true, innerHTML: "", cls,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) },
      querySelector: () => left, left,
    };
  }
  return { ui, advance(ms) { now += ms; timers.forEach((t) => t()); }, el };
}

test("FRONTEND: the wait notice counts down the real time left and frees the button at zero", () => {
  const { ui, advance, el } = waitUi();
  assert.equal(ui.formatCountdown(45), "45 s");
  assert.equal(ui.formatCountdown(65), "1:05 min");
  assert.equal(ui.formatCountdown(900), "15:00 min");
  assert.equal(ui.formatCountdown(3599), "59:59\u00a0min");
  assert.equal(ui.formatCountdown(3600), "1:00:00\u00a0h", "the 24 h network windows read as hours, not '1439:59 min'");
  assert.equal(ui.formatCountdown(86399), "23:59:59\u00a0h");
  const notice = el();
  const button = { disabled: false };
  let ready = 0;
  assert.equal(ui.mountCredentialWait(notice, "owner", { button }), false, "no wait: nothing shown");
  assert.equal(notice.hidden, true);
  assert.equal(ui.startCredentialWait("owner", { retryAfterSeconds: 65 }), true);
  assert.equal(ui.mountCredentialWait(notice, "owner", { button, onReady: () => ready++ }), true);
  assert.equal(notice.hidden, false);
  assert.ok(notice.innerHTML.includes("Demasiados intentos. Intenta de nuevo en"));
  assert.ok(notice.innerHTML.includes("o entra desde un dispositivo donde ya hayas entrado."));
  assert.ok(notice.innerHTML.includes('<b class="qz-wait-left" aria-hidden="true"></b><span class="qz-sr-only">2 min</span>'), "screen readers hear it once, rounded up");
  assert.equal(notice.left.textContent, "1:05 min");
  assert.equal(button.disabled, true);
  advance(20000);
  assert.equal(notice.left.textContent, "45 s", "it goes down with the clock");
  assert.equal(button.disabled, true);
  advance(45000);
  assert.ok(notice.innerHTML.includes("Ya puedes intentarlo de nuevo."));
  assert.ok(notice.cls.has("qz-wait-over"));
  assert.equal(button.disabled, false);
  assert.equal(ready, 1);
  assert.equal(ui.credentialWaitLeft("owner"), 0);
  assert.equal(ui.startCredentialWait("owner", {}), false, "no number from the server: no countdown");
});

test("FRONTEND: every credential form keeps the wait next to it instead of a toast", () => {
  // The modal itself: a wait shows inside it and keeps confirm (and Enter) off.
  const prompt = extractFunction(indexSrc, "function qzPrompt(message, opts)");
  assert.ok(prompt.includes('${opts.waitKey ? credentialWaitNoticeHtml("qz-prompt-wait") : ""}'));
  assert.ok(prompt.includes('if(opts.waitKey) mountCredentialWait(overlay.querySelector("#qz-prompt-wait"), opts.waitKey, { button: confirmBtn });'));
  assert.ok(prompt.includes("const submit = () => { if(!confirmBtn.disabled) cleanup(input.value); };"));
  // A 429 brings the same modal straight back with the countdown.
  const pc = extractFunction(indexSrc, "async function promptCredential(message, opts, waitKey, check)");
  assert.ok(pc.includes('if(result && result.error === "too_many_attempts" && startCredentialWait(waitKey, result)) continue;'));
  // Login by PIN, first admin PIN (admin password), change PIN, Ajustes re-auth.
  for (const call of [
    '"pin:" + p.id, (pin) => verifyParticipantPin(p.id, pin));',
    '"owner", (password) => apiSetPinResult(participantId, null, newPin, password));',
    'waitKey, (pin) => verifyParticipantPin(currentUser.id, pin));',
    'pinWaitKey, (pin) => verifyParticipantPin(currentUser.id, pin));',
  ]) assert.ok(indexSrc.includes(call), call);
  assert.ok(indexSrc.includes('const waitKey = "pin:" + currentUser.id;') && indexSrc.includes('const pinWaitKey = "pin:" + currentUser.id;'), "change PIN and Ajustes re-auth");
  // Closing the modal leaves the countdown next to the names on the login.
  assert.ok(indexSrc.includes('if(attempt === null){ showLoginWait("pin:" + p.id, "PIN de " + p.name); return; }'));
  assert.ok(indexSrc.includes('${credentialWaitNoticeHtml("qz-login-wait")}'));
  assert.ok(indexSrc.includes("if(loginWait) showLoginWait(loginWait.key, loginWait.label);"), "and it survives a re-render");
  // Inline forms: Ajustes, Panel de plataforma, first admin PIN after creating.
  for (const [id, key] of [["qz-owner-wait", "owner"], ["qz-p-wait", "platform"], ["qz-setup-pin-wait", "owner"]]) {
    assert.ok(indexSrc.includes('${credentialWaitNoticeHtml("' + id + '")}'), id);
  }
  assert.ok(indexSrc.includes('mountCredentialWait(ownerWaitEl, "owner", { button: ownerUnlockBtn, reveal: true });'));
  assert.ok(indexSrc.includes('else if(result.error === "too_many_attempts" && startCredentialWait("platform", result)) mountCredentialWait(platformWaitEl, "platform", { button: platformUnlockBtn, reveal: true });'));
  assert.ok(indexSrc.includes('if(mountCredentialWait(waitEl, "owner", { button: continueBtn, onReady: readyToContinue, reveal: true })){'));
  // On screen at 375 px: between the field and its button, and above the list of names.
  for (const [field, id, btn] of [['id="qz-owner-pw"', "qz-owner-wait", 'id="qz-owner-unlock"'], ['id="qz-p-pass"', "qz-p-wait", 'id="qz-p-unlock"']]) {
    const f = indexSrc.indexOf(field), w = indexSrc.indexOf('credentialWaitNoticeHtml("' + id + '")'), b = indexSrc.indexOf(btn);
    assert.ok(f < w && w < b, id + " sits between the field and the button");
  }
  assert.ok(indexSrc.indexOf('credentialWaitNoticeHtml("qz-login-wait")') < indexSrc.indexOf('<div class="name-grid">${names}</div>'));
  // The notice is a status region, styled, and the number never wraps.
  assert.ok(indexSrc.includes('<div class="qz-wait-notice" id="${id}" role="status" aria-live="polite" hidden></div>'));
  assert.ok(indexSrc.includes(".qz-wait-notice .qz-wait-left{ font-variant-numeric:tabular-nums; white-space:nowrap; }"));
});


// ---- Technical QA on 33809d4 (P3s) ----------------------------------------------

// The real helpers from server.js.
const credHash = new Function("crypto",
  extractFunction(serverSrc, "function hashPassword(plain)") + "\n" +
  extractFunction(serverSrc, "function isHashed(value)") + "\n" +
  extractFunction(serverSrc, "function verifyPassword(plain, stored)") + "\n" +
  extractFunction(serverSrc, "function hashUnlessUnchanged(plain, stored)") + "\n" +
  "return { hashPassword, isHashed, verifyPassword, hashUnlessUnchanged };"
)(require("crypto"));

test("setting a credential to the value it already has keeps its hash, so its failed-attempt state stays", () => {
  const { hashPassword, hashUnlessUnchanged, verifyPassword } = credHash;
  const stored = hashPassword("4321");
  assert.equal(hashUnlessUnchanged("4321", stored), stored, "same PIN: same hash, same version");
  const changed = hashUnlessUnchanged("1234", stored);
  assert.notEqual(changed, stored, "a real change is a new credential");
  assert.ok(verifyPassword("1234", changed));
  assert.ok(verifyPassword("4321", hashUnlessUnchanged("4321", null)), "nothing stored yet: hashed as usual");
  assert.notEqual(hashUnlessUnchanged("legacy", "legacy"), "legacy", "a plaintext legacy value is still upgraded to a hash");
});

test("SERVER: set-pin, the admin password, the panel password and platform settings keep an unchanged hash", () => {
  assert.ok(serverSrc.includes("participant.pin = hashUnlessUnchanged(newPin, participant.pin);"), "set-pin (the current PIN was proven first)");
  assert.ok(serverSrc.includes("merged.settings.ownerPassword = hashUnlessUnchanged(incomingPw, oldSettings && oldSettings.ownerPassword);"));
  assert.ok(serverSrc.includes("merged.dashboardPassword = hashUnlessUnchanged(incomingPw, oldValue && oldValue.dashboardPassword);"));
  assert.ok(serverSrc.includes("hashedOwnerPassword: wantsPassword ? hashUnlessUnchanged(body.ownerPassword.trim(), meta.settings && meta.settings.ownerPassword) : null,"));
  // Not for another participant's PIN written through meta: an admin could tell
  // "same" from "different" by the participant's rev, a free guess at their PIN.
  assert.ok(serverSrc.includes("} else if (p.pin && !isHashed(p.pin)) {\n        p.pin = hashPassword(p.pin);"));
  // set-pin proves the current PIN before it gets there.
  const route = serverSrc.slice(serverSrc.indexOf('app.post("/api/set-pin"'), serverSrc.indexOf("participant.pin = hashUnlessUnchanged(newPin, participant.pin);"));
  assert.ok(route.includes("if (participant.pin && !checkCredential(req, claimSlug, participant.id, currentPin, participant.pin)) {"));
});

test("FRONTEND: Enter on the first-admin-PIN screen does nothing while the button is off", () => {
  const body = extractFunction(indexSrc, "async function renderAdminSetupPin()");
  assert.ok(body.includes("if(currentValue.length !== 4 || continueBtn.disabled) return;"));
});

test("FRONTEND: 'Cambiar mi PIN' proves the current PIN with the one just typed, not only the one in memory", () => {
  // After a reload the session restores the user but not their PIN (memory only).
  assert.ok(indexSrc.includes("verifiedCurrentPin = attempt.value;"));
  assert.ok(indexSrc.includes("const ok = await apiSetPin(currentUser.id, verifiedCurrentPin || currentUserPinCache, cleanPin);"));
});

test("FRONTEND: closing a PIN modal during a wait leaves the countdown where it can still be seen", () => {
  assert.ok(indexSrc.includes('if(attempt === null){ mountCredentialWait(pinWaitEl, pinWaitKey, { label: "Tu PIN", reveal: true }); return; }'), "Ajustes re-auth");
  assert.ok(indexSrc.includes('${credentialWaitNoticeHtml("qz-owner-pin-wait")}'));
  assert.ok(indexSrc.includes("if(left > 0) toast(tooManyAttemptsMessage(left));"), "the user menu has no form: one message");
  assert.ok(indexSrc.includes("#qz-login-wait{ margin-bottom:14px; }"));
});

// ---- Technical QA on 351019f (P3s) ----------------------------------------------

test("fingerprints are encoded from 16 bytes, not sliced from a 64-char string (V8 would keep the parent alive)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "credentialAttempts.js"), "utf8");
  const fn = extractFunction(src, "function fingerprint(quiniela, target, value)");
  assert.ok(fn.includes('.digest().toString("hex", 0, 16);'));
  assert.ok(!/\.slice\(/.test(fn), "one per value tried, up to maxSeenPerTarget per credential");
});

test("FRONTEND: 'Cambiar mi PIN' to the PIN you already have says so instead of 'actualizado'", () => {
  const start = indexSrc.indexOf('document.getElementById("qz-change-pin").addEventListener("click"');
  const block = indexSrc.slice(start, start + 2600);
  const same = block.indexOf('if(cleanPin === (verifiedCurrentPin || currentUserPinCache)){ toast("Ese ya es tu PIN. Elige uno distinto para cambiarlo."); return; }');
  assert.ok(same !== -1 && same < block.indexOf("await apiSetPin("), "checked before calling the server");
});
