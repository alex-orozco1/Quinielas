// trustedDeviceVersion.integration.test.js — a trusted-device cookie only
// counts for the version of the credential it was earned with.
//
// Reproduces the P1 found on 8753f8c against the REAL server and endpoints:
// trusted-device cookies collected while a PIN (or password) was known kept
// their exemption after that credential changed, so three old cookies gave
// 30 guesses against the NEW PIN from one IP (10 per cookie, the device
// budget) where a cookie-less attacker stopped at 10.
//
// Uses the real server and a throwaway local PostgreSQL (test/helpers/realServer.js):
//
//   pg_ctlcluster 16 main start
//   export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/trustedDeviceVersion.integration.test.js
//
// Credentials never go in the URL (scripts/security/pre-commit-secret-check.sh
// blocks connection strings with an embedded password): node-postgres takes
// them from PGUSER/PGPASSWORD or ~/.pgpass, here and in the server this test
// starts. Any host other than localhost is refused: this test never points at
// a shared or production database. It starts server.js itself on a free port,
// with QRACKS_CLIENT_IP_SOURCE=xff:1 so each simulated client can have its own
// address, and drops its database at the end.
//
// Without QRACKS_TEST_DATABASE_URL every test here is reported as SKIPPED,
// with the reason ("# skipped 9" in the summary): never as a pass, and never
// as a suite that silently ran 0 tests.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  itest, PLATFORM_PASSWORD, setup, teardown, startServer, stopServer, dbQuery,
  freshIp, call, Browser, kvPath, quiniela, trustedBrowsers, guessFrom,
} = require("./helpers/realServer");

const wrongPin = (k, avoid) => { let p = String(5000 + k); while (avoid.includes(p)) p = String(Number(p) + 1); return p; };
const pinGuess = (q, who) => (b, k) => call("POST", "/api/verify-pin", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, participantId: q[who].id, pin: wrongPin(k, [q[who].pin]) } });

test.describe("trusted-device cookies after a credential change (real server)", () => {
  test.before(setup);
  test.after(teardown);

  itest("participant PIN: three cookies earned before the change get no more than a cookie-less attacker", async () => {
    const q = await quiniela("pin");
    const net1 = freshIp();
    const old = await trustedBrowsers(3, net1, (b) => call("POST", "/api/verify-pin", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: q.beto.pin } }));
    // Beto changes his PIN on his phone (the device that completes the change).
    const newPin = "1357";
    const ch = q.betoPhone.take(await call("POST", "/api/set-pin", { ip: q.betoPhone.ip, cookie: q.betoPhone.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, currentPin: q.beto.pin, newPin } }));
    assert.equal(ch.status, 200);
    q.beto.pin = newPin;
    const t = await guessFrom(old, 10, pinGuess(q, "beto"));
    assert.deepEqual(t.other, []);
    assert.equal(t.compared, 10, `old cookies are ordinary browsers now: 10 free, then the wait (got ${JSON.stringify(t)})`);
    assert.equal(t.refused, 20);
    // An old cookie no longer exempts even the right PIN from the wait...
    const oldRight = await call("POST", "/api/verify-pin", { ip: net1, cookie: old[0].cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: newPin } });
    assert.equal(oldRight.status, 429);
    // ...but the phone that changed the PIN was trusted again, for the new one.
    const phone = await call("POST", "/api/verify-pin", { ip: q.betoPhone.ip, cookie: q.betoPhone.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: newPin } });
    assert.deepEqual([phone.status, phone.body], [200, { ok: true }]);
  });

  itest("admin PIN, through verify-pin and the header-PIN admin view: old cookies are not trusted after the change", async () => {
    const q = await quiniela("admin");
    const net1 = freshIp();
    const old = await trustedBrowsers(3, net1, (b) => call("POST", "/api/verify-pin", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, participantId: q.ana.id, pin: q.ana.pin } }));
    const newPin = "8642";
    assert.equal(q.anaPhone.take(await call("POST", "/api/set-pin", { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, body: { metaKey: q.metaKey, participantId: q.ana.id, currentPin: q.ana.pin, newPin } })).status, 200);
    q.ana.pin = newPin;
    // The admin view is an oracle too (GET /api/kv with the PIN in a header):
    // 10 header guesses through old cookies, then verify-pin must already wait.
    for (let k = 0; k < 10; k++) {
      const g = await call("GET", kvPath(q.slug), { ip: net1, cookie: old[k % 3].cookie, headers: { "X-Qracks-Auth": wrongPin(k, [newPin]), "X-Qracks-Participant": q.ana.id } });
      assert.equal(g.status, 200);
      assert.ok(!("roundsRevision" in g.body.value), "never the admin view with a wrong PIN");
    }
    const t = await guessFrom(old, 5, (b, k) => call("POST", "/api/verify-pin", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, participantId: q.ana.id, pin: wrongPin(100 + k, [newPin]) } }));
    assert.deepEqual(t.other, []);
    assert.equal(t.compared, 0, `the 10 header guesses already used the free attempts (got ${JSON.stringify(t)})`);
    // The right PIN, from the phone that changed it, still opens the admin view.
    const view = await call("GET", kvPath(q.slug), { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, headers: { "X-Qracks-Auth": newPin, "X-Qracks-Participant": q.ana.id } });
    assert.ok("roundsRevision" in view.body.value);
  });

  itest("a PIN reset by an admin, then a new PIN, also ends the old trust", async () => {
    const q = await quiniela("reset");
    const net1 = freshIp();
    const old = await trustedBrowsers(3, net1, (b) => call("POST", "/api/verify-pin", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: q.beto.pin } }));
    // Ana (admin password) resets Beto's PIN, as Participantes → Resetear does.
    const meta = (await call("GET", kvPath(q.slug), { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, headers: { "X-Qracks-Auth": q.owner } })).body.value;
    meta.participants.find((p) => p.id === q.beto.id).pin = null;
    const w = await call("POST", kvPath(q.slug), { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, headers: { "X-Qracks-Auth": q.owner }, body: { value: meta } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    // Beto chooses a new one on a new phone.
    const phone2 = Browser(freshIp());
    assert.equal(phone2.take(await call("POST", "/api/set-pin", { ip: phone2.ip, body: { metaKey: q.metaKey, participantId: q.beto.id, newPin: "9753" } })).status, 200);
    q.beto.pin = "9753";
    const t = await guessFrom(old, 10, pinGuess(q, "beto"));
    assert.deepEqual([t.compared, t.refused, t.other], [10, 20, []]);
  });

  itest("admin password: cookies from verify-owner stop counting once the password changes in Ajustes", async () => {
    const q = await quiniela("owner");
    const net1 = freshIp();
    const old = await trustedBrowsers(3, net1, (b) => call("POST", "/api/verify-owner", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, password: q.owner } }));
    const newOwner = "owner2-" + crypto.randomBytes(6).toString("hex");
    const meta = (await call("GET", kvPath(q.slug), { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, headers: { "X-Qracks-Auth": q.owner } })).body.value;
    meta.settings.ownerPassword = newOwner;
    const w = q.anaPhone.take(await call("POST", kvPath(q.slug), { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, headers: { "X-Qracks-Auth": q.owner }, body: { value: meta } }));
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const t = await guessFrom(old, 10, (b, k) => call("POST", "/api/verify-owner", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, password: "nope-" + k } }));
    assert.deepEqual(t.other, []);
    assert.deepEqual([t.compared, t.refused], [10, 20], JSON.stringify(t));
    // The device that changed it was trusted for the new password.
    const mine = await call("POST", "/api/verify-owner", { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, body: { metaKey: q.metaKey, password: newOwner } });
    assert.deepEqual([mine.status, mine.body], [200, { ok: true }]);
  });

  itest("new trust only for the writer who typed the new admin password: an admin by PIN saving over a legacy one gets none", async () => {
    const q = await quiniela("legacy");
    // A legacy quiniela whose admin password is still stored in plaintext.
    const legacyPw = "legacy-" + crypto.randomBytes(4).toString("hex");
    await dbQuery("UPDATE kv SET value = jsonb_set(value, '{settings,ownerPassword}', to_jsonb($2::text)) WHERE key = $1", [q.metaKey, legacyPw]);
    // Ana writes as an admin (her PIN), not with the admin password, and even
    // types a "new" one: she may not change it, and her save migrates the
    // legacy value to a hash. No trust for the admin password may come of it.
    const laptop = Browser(freshIp());
    const auth = { "X-Qracks-Auth": q.ana.pin, "X-Qracks-Participant": q.ana.id };
    const meta = (await call("GET", kvPath(q.slug), { ip: laptop.ip, headers: auth })).body.value;
    meta.settings = { ...(meta.settings || {}), ownerPassword: "typed-by-an-admin" };
    const w = await call("POST", kvPath(q.slug), { ip: laptop.ip, headers: auth, body: { value: meta } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.ok(!(w.setCookies || []).some((c) => c.startsWith("qracks_trust_")), "no trusted-device cookie for a password this writer never proved");
    const still = await call("POST", "/api/verify-owner", { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, body: { metaKey: q.metaKey, password: legacyPw } });
    assert.deepEqual([still.status, still.body], [200, { ok: true }], "the admin password did not change (only its storage)");
  });

  itest("platform password: cookies from verify-platform stop counting once it changes", async () => {
    const net1 = freshIp();
    let current = PLATFORM_PASSWORD;
    const old = await trustedBrowsers(3, net1, (b) => call("POST", "/api/verify-platform", { ip: b.ip, cookie: b.cookie, body: { password: current } }));
    const panel = Browser(freshIp());
    assert.equal(panel.take(await call("POST", "/api/verify-platform", { ip: panel.ip, body: { password: current } })).body.ok, true);
    const next = "it-platform2-" + crypto.randomBytes(6).toString("hex");
    const settings = (await call("GET", "/api/kv/platform_settings", { ip: panel.ip, cookie: panel.cookie, headers: { "X-Qracks-Platform-Auth": current } })).body;
    const value = { ...((settings && settings.value) || {}), dashboardPassword: next };
    const w = panel.take(await call("POST", "/api/kv/platform_settings", { ip: panel.ip, cookie: panel.cookie, headers: { "X-Qracks-Platform-Auth": current }, body: { value } }));
    assert.equal(w.status, 200, JSON.stringify(w.body));
    current = next;
    const t = await guessFrom(old, 10, (b, k) => call("POST", "/api/verify-platform", { ip: b.ip, cookie: b.cookie, body: { password: "nope-" + k } }));
    assert.deepEqual(t.other, []);
    assert.deepEqual([t.compared, t.refused], [10, 20], JSON.stringify(t));
    const mine = await call("POST", "/api/verify-platform", { ip: panel.ip, cookie: panel.cookie, body: { password: next } });
    assert.deepEqual([mine.status, mine.body], [200, { ok: true }], "the panel that changed it was trusted for the new password");
  });

  itest("saving the SAME PIN keeps the counters (and the credential, so its trusted devices too)", async () => {
    const q = await quiniela("same");
    const net1 = freshIp();
    const kept = await trustedBrowsers(1, net1, (b) => call("POST", "/api/verify-pin", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: q.beto.pin } }));
    const attacker = Browser(freshIp());
    const before = await guessFrom([attacker], 11, pinGuess(q, "beto"));
    assert.deepEqual([before.compared, before.refused], [10, 1]);
    assert.equal(q.betoPhone.take(await call("POST", "/api/set-pin", { ip: q.betoPhone.ip, cookie: q.betoPhone.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, currentPin: q.beto.pin, newPin: q.beto.pin } })).status, 200);
    const after = await call("POST", "/api/verify-pin", { ip: attacker.ip, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: "0000" } });
    assert.equal(after.status, 429, "the wait is still there: nothing was reset");
    const stillTrusted = await call("POST", "/api/verify-pin", { ip: net1, cookie: kept[0].cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: q.beto.pin } });
    assert.deepEqual([stillTrusted.status, stillTrusted.body], [200, { ok: true }], "same credential, same trust");
  });

  itest("concurrency: 30 parallel guesses through three old cookies right after the change", async () => {
    const q = await quiniela("conc");
    const net1 = freshIp();
    const old = await trustedBrowsers(3, net1, (b) => call("POST", "/api/verify-pin", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: q.beto.pin } }));
    assert.equal(q.betoPhone.take(await call("POST", "/api/set-pin", { ip: q.betoPhone.ip, cookie: q.betoPhone.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, currentPin: q.beto.pin, newPin: "1593" } })).status, 200);
    q.beto.pin = "1593";
    const t = await guessFrom(old, 10, pinGuess(q, "beto"), { parallel: true });
    assert.deepEqual(t.other, []);
    assert.deepEqual([t.compared, t.refused], [10, 20], JSON.stringify(t));
  });

  itest("restart: old cookies stay untrusted and the new trust survives (state from the database, trust from the version)", async () => {
    const q = await quiniela("restart");
    const net1 = freshIp();
    const old = await trustedBrowsers(3, net1, (b) => call("POST", "/api/verify-pin", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: q.beto.pin } }));
    assert.equal(q.betoPhone.take(await call("POST", "/api/set-pin", { ip: q.betoPhone.ip, cookie: q.betoPhone.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, currentPin: q.beto.pin, newPin: "7531" } })).status, 200);
    q.beto.pin = "7531";
    const first = await guessFrom(old.slice(0, 1), 5, pinGuess(q, "beto"));
    assert.deepEqual([first.compared, first.refused], [5, 0]);
    await new Promise((r) => setTimeout(r, 400)); // the 250 ms write batch
    await stopServer("SIGTERM");
    await startServer();
    const rest = await guessFrom(old, 5, (b, k) => pinGuess(q, "beto")(b, 50 + k));
    assert.deepEqual(rest.other, []);
    assert.deepEqual([rest.compared, rest.refused], [5, 10], `5 before + 5 after the restart = the 10 free, no more (got ${JSON.stringify(rest)})`);
    const phone = await call("POST", "/api/verify-pin", { ip: q.betoPhone.ip, cookie: q.betoPhone.cookie, body: { metaKey: q.metaKey, participantId: q.beto.id, pin: q.beto.pin } });
    assert.deepEqual([phone.status, phone.body], [200, { ok: true }], "the phone that changed it is still trusted after the restart");
  });
});
