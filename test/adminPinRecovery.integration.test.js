// adminPinRecovery.integration.test.js — "¿Olvidaste tu PIN?" for an admin,
// through the REAL server and endpoints (test/helpers/realServer.js: a
// throwaway local PostgreSQL; skipped, with the reason, without one).
//
// The sole admin who forgot their PIN, with no session and no other admin,
// chooses a new one by proving the admin password:
//   POST /api/recover-admin-pin  { metaKey, participantId, newPin }
//   X-Qracks-Auth: <admin password>   (header only, unbound to a participant)
// What must hold: the limiter still applies to the admin password; only an
// admin can be recovered; the old PIN never appears and stops working; old
// sessions and old trusted-device cookies of that person stop counting; the
// device that recovers is trusted for the new PIN.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  itest, setup, teardown, startServer, stopServer, dbQuery,
  freshIp, call, Browser, quiniela, trustedBrowsers, guessFrom,
} = require("./helpers/realServer");

const recover = (q, who, { password, newPin, browser, ip, headers } = {}) => call("POST", "/api/recover-admin-pin", {
  ip: ip || (browser && browser.ip), cookie: browser && browser.cookie,
  headers: { ...(password != null ? { "X-Qracks-Auth": password } : {}), ...(headers || {}) },
  body: { metaKey: q.metaKey, participantId: q[who].id, newPin },
});
const verifyPin = (q, who, pin, browser, ip) => call("POST", "/api/verify-pin", { ip: ip || (browser && browser.ip), cookie: browser && browser.cookie, body: { metaKey: q.metaKey, participantId: q[who].id, pin } });
const storedPin = async (q, who) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value.participants.find((p) => p.id === q[who].id).pin;

test.describe("¿Olvidaste tu PIN? for an admin (real server)", () => {
  test.before(setup);
  test.after(teardown);

  itest("the sole admin, with no session, sets a new PIN with the admin password; the old one stops working and is never shown", async () => {
    const q = await quiniela("rec");
    const laptop = Browser(freshIp()); // a new device: no session, no trust
    const r = laptop.take(await recover(q, "ana", { password: q.owner, newPin: "8642", browser: laptop }));
    assert.deepEqual([r.status, Object.keys(r.body).sort()], [200, ["ok", "participantRevs"]]);
    assert.equal(r.body.ok, true);
    const raw = JSON.stringify(r.body) + r.setCookies.join(";");
    for (const secret of [q.ana.pin, "8642", "scrypt$"]) assert.ok(!raw.includes(secret), "the answer carries no PIN and no hash: " + secret);
    assert.ok(laptop.has("qracks_session_") && laptop.has("qracks_trust_"), "the device that recovered gets a session and trust");
    assert.deepEqual((await verifyPin(q, "ana", "8642", null, freshIp())).body, { ok: true }, "the new PIN works");
    assert.deepEqual((await verifyPin(q, "ana", q.ana.pin, null, freshIp())).body, { ok: false }, "the old one does not");
    const session = await call("POST", "/api/verify-session", { ip: laptop.ip, cookie: laptop.cookie, body: { metaKey: q.metaKey, slug: q.slug } });
    assert.equal(session.body.ok, true, "and the laptop is signed in");
  });

  itest("old sessions and old trusted devices of that admin stop counting", async () => {
    const q = await quiniela("old");
    const net1 = freshIp();
    const old = await trustedBrowsers(3, net1, (b) => verifyPin(q, "ana", q.ana.pin, b));
    const before = await call("POST", "/api/verify-session", { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, body: { metaKey: q.metaKey, slug: q.slug } });
    assert.equal(before.body.ok, true, "Ana's phone had a session");
    const laptop = Browser(freshIp());
    assert.equal(laptop.take(await recover(q, "ana", { password: q.owner, newPin: "1357", browser: laptop })).status, 200);
    const after = await call("POST", "/api/verify-session", { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, body: { metaKey: q.metaKey, slug: q.slug } });
    assert.equal(after.body.ok, false, "the old session ended with the old PIN");
    const t = await guessFrom(old, 10, (b, k) => verifyPin(q, "ana", String(5000 + k), b));
    assert.deepEqual([t.compared, t.refused, t.other], [10, 20, []], "old trusted cookies are ordinary browsers again");
    const mine = await verifyPin(q, "ana", "1357", laptop);
    assert.deepEqual([mine.status, mine.body], [200, { ok: true }], "the device that recovered is trusted for the new PIN, during that wait too");
  });

  itest("the SAME PIN chosen again still makes a new credential (no 'that was your PIN' answer, old trust ends)", async () => {
    const q = await quiniela("same");
    const hashBefore = await storedPin(q, "ana");
    const laptop = Browser(freshIp());
    const r = await recover(q, "ana", { password: q.owner, newPin: q.ana.pin, browser: laptop });
    assert.deepEqual([r.status, Object.keys(r.body).sort()], [200, ["ok", "participantRevs"]], "the same answer as for any other PIN");
    assert.notEqual(await storedPin(q, "ana"), hashBefore, "a fresh salt: a new version of the credential");
    const after = await call("POST", "/api/verify-session", { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, body: { metaKey: q.metaKey, slug: q.slug } });
    assert.equal(after.body.ok, false, "so old sessions end even then");
  });

  itest("a wrong admin password changes nothing, and the attempt limit applies (shared with verify-owner)", async () => {
    const q = await quiniela("wrong");
    const hashBefore = await storedPin(q, "ana");
    const statuses = [];
    for (let k = 0; k < 11; k++) {
      const r = await recover(q, "ana", { password: "nope-" + k, newPin: "1111", ip: freshIp() });
      statuses.push(r.status === 429 ? `429:${r.body.error}:${r.body.retryAfterSeconds > 0}` : `${r.status}:${r.body.error}`);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill("403:wrong_admin_password"));
    assert.equal(statuses[10], "429:too_many_attempts:true", "the 11th waits, with the time left");
    const right = await recover(q, "ana", { password: q.owner, newPin: "1111", ip: freshIp() });
    assert.equal(right.status, 429, "the right password from a new device waits too: no way around the limit");
    const owner = await call("POST", "/api/verify-owner", { ip: freshIp(), body: { metaKey: q.metaKey, password: q.owner } });
    assert.equal(owner.status, 429, "one admin password, one wait: verify-owner sees the same one");
    assert.equal(await storedPin(q, "ana"), hashBefore, "Ana's PIN did not change");
    assert.deepEqual((await verifyPin(q, "ana", q.ana.pin, q.anaPhone)).body, { ok: true }, "and still works on her phone");
  });

  itest("only an admin can be recovered; trying a participant costs nothing and answers nothing about the password", async () => {
    const q = await quiniela("nonadmin");
    const betoBefore = await storedPin(q, "beto");
    for (let k = 0; k < 12; k++) {
      const r = await recover(q, "beto", { password: k === 0 ? q.owner : "nope-" + k, newPin: "9999", ip: freshIp() });
      assert.deepEqual([r.status, r.body.error], [403, "not_admin"], "same answer with the right or a wrong password");
    }
    assert.equal(await storedPin(q, "beto"), betoBefore);
    // None of those counted against the admin password: Ana still has her 10.
    const t = [];
    for (let k = 0; k < 10; k++) t.push((await recover(q, "ana", { password: "nope-" + k, newPin: "1111", ip: freshIp() })).status);
    assert.deepEqual(t, Array(10).fill(403));
  });

  itest("the admin password only counts in the header, alone: not in the body, not bound to a participant", async () => {
    const q = await quiniela("header");
    const inBody = await call("POST", "/api/recover-admin-pin", { ip: freshIp(), body: { metaKey: q.metaKey, participantId: q.ana.id, newPin: "2222", adminPassword: q.owner, password: q.owner } });
    assert.deepEqual([inBody.status, inBody.body.error], [403, "wrong_admin_password"]);
    const bound = await recover(q, "ana", { password: q.owner, newPin: "2222", ip: freshIp(), headers: { "X-Qracks-Participant": q.ana.id } });
    assert.deepEqual([bound.status, bound.body.error], [403, "wrong_admin_password"], "bound to a participant it is a PIN, not the admin password");
    for (const bad of [{ newPin: "12" }, { newPin: "abcd" }, { newPin: "12345" }]) {
      const r = await call("POST", "/api/recover-admin-pin", { ip: freshIp(), headers: { "X-Qracks-Auth": q.owner }, body: { metaKey: q.metaKey, participantId: q.ana.id, ...bad } });
      assert.deepEqual([r.status, r.body.error], [400, "invalid_params"], JSON.stringify(bad));
    }
  });

  itest("a quiniela with no admin password cannot be recovered this way (and says so)", async () => {
    const q = await quiniela("nopw");
    await dbQuery("UPDATE kv SET value = value #- '{settings,ownerPassword}' WHERE key = $1", [q.metaKey]);
    const r = await recover(q, "ana", { password: "anything", newPin: "2222", ip: freshIp() });
    assert.deepEqual([r.status, r.body.error], [409, "no_admin_password"]);
  });

  itest("concurrency: 20 parallel wrong passwords compare 10 at most", async () => {
    const q = await quiniela("conc");
    const rs = await Promise.all(Array.from({ length: 20 }, (_, k) => recover(q, "ana", { password: "nope-" + k, newPin: "1111", ip: freshIp() })));
    const tally = rs.reduce((m, r) => { const key = r.status + ":" + r.body.error; m[key] = (m[key] || 0) + 1; return m; }, {});
    assert.deepEqual(tally, { "403:wrong_admin_password": 10, "429:too_many_attempts": 10 });
  });

  itest("restart: the wait on the admin password survives; a recovery does not reset it; a recovered PIN stays the PIN", async () => {
    const q = await quiniela("restart");
    for (let k = 0; k < 10; k++) await recover(q, "ana", { password: "nope-" + k, newPin: "1111", ip: freshIp() });
    await new Promise((r) => setTimeout(r, 400)); // the 250 ms write batch
    await stopServer("SIGTERM");
    await startServer();
    const r = await recover(q, "ana", { password: q.owner, newPin: "1111", ip: freshIp() });
    assert.equal(r.status, 429, "still waiting after the restart");
    // Once the wait is over the admin recovers, and the new PIN survives a restart.
    await new Promise((res) => setTimeout(res, (r.body.retryAfterSeconds || 0) * 1000 + 300));
    assert.equal((await recover(q, "ana", { password: q.owner, newPin: "4646", ip: freshIp() })).status, 200);
    // That success gave nobody a fresh budget: the next miss is compared and the one after waits the next step (30 s).
    const miss = await recover(q, "ana", { password: "nope-x", newPin: "1111", ip: freshIp() });
    const then = await recover(q, "ana", { password: "nope-y", newPin: "1111", ip: freshIp() });
    assert.deepEqual([miss.status, miss.body.error, then.status, then.body.retryAfterSeconds >= 25], [403, "wrong_admin_password", 429, true]);
    await stopServer("SIGTERM");
    await startServer();
    assert.deepEqual((await verifyPin(q, "ana", "4646", null, freshIp())).body, { ok: true });
  });
});
