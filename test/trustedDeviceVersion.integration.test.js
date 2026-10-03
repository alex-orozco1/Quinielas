// trustedDeviceVersion.integration.test.js — a trusted-device cookie only
// counts for the version of the credential it was earned with.
//
// Reproduces the P1 found on 8753f8c against the REAL server and endpoints:
// trusted-device cookies collected while a PIN (or password) was known kept
// their exemption after that credential changed, so three old cookies gave
// 30 guesses against the NEW PIN from one IP (10 per cookie, the device
// budget) where a cookie-less attacker stopped at 10.
//
// Needs a local PostgreSQL the test may create a throwaway database in:
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
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ADMIN_URL = process.env.QRACKS_TEST_DATABASE_URL || "";
const SKIP = !ADMIN_URL
  ? "set QRACKS_TEST_DATABASE_URL to a LOCAL postgres (see the header of this file)"
  : (!/^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(ADMIN_URL)
    ? "QRACKS_TEST_DATABASE_URL must point at localhost" : false);
// Each test carries the skip itself, so a run without PostgreSQL reports
// every one of them as skipped (with the reason) instead of an empty suite.
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

const PLATFORM_PASSWORD = "it-platform-" + crypto.randomBytes(6).toString("hex");
const SERVER_JS = path.join(__dirname, "..", "server.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on("error", reject);
  });
}

let pg, dbName, dbUrl, port, child, serverLog = "";
async function adminQuery(sql) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}
async function startServer() {
  serverLog = "";
  child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, DATABASE_URL: dbUrl, PORT: String(port), PLATFORM_PASSWORD, QRACKS_CLIENT_IP_SOURCE: "xff:1", RENDER: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { serverLog += d; });
  child.stderr.on("data", (d) => { serverLog += d; });
  for (let i = 0; i < 100; i++) {
    if (/listening on port/.test(serverLog)) return;
    if (child.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start:\n" + serverLog.slice(-2000));
}
async function stopServer(signal = "SIGTERM") {
  if (!child || child.exitCode != null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill(signal);
  await exited;
}

// ---- HTTP helpers --------------------------------------------------------
let ipN = 0;
const freshIp = () => `198.18.${(ipN >> 8) & 255}.${ipN++ & 255}`;
async function call(method, urlPath, { body, ip, cookie, headers } = {}) {
  const h = { "Content-Type": "application/json", "X-Forwarded-For": ip || freshIp(), ...(headers || {}) };
  if (cookie) h.Cookie = cookie;
  const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, body: json, setCookies: r.headers.getSetCookie() };
}
// One browser: keeps the latest value of each cookie it was given.
function Browser(ip) {
  const jar = new Map();
  return {
    ip,
    take(res) { for (const c of res.setCookies || []) { const kv = c.split(";")[0]; const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } return res; },
    get cookie() { return [...jar].map(([k, v]) => k + "=" + v).join("; "); },
    has(prefix) { return [...jar.keys()].some((k) => k.startsWith(prefix)); },
  };
}
const kvPath = (slug) => "/api/kv/" + encodeURIComponent(`quiniela:${slug}:meta`);

// A quiniela with Ana (admin, PIN, admin password) and Beto (participant, PIN).
async function quiniela(tag) {
  const slug = `it-${tag}-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const metaKey = `quiniela:${slug}:meta`;
  const owner = "owner-" + crypto.randomBytes(6).toString("hex");
  const anaPhone = Browser(freshIp());
  const created = anaPhone.take(await call("POST", "/api/create-quiniela", { ip: anaPhone.ip, body: { slug, groupName: "IT " + tag, creatorName: "Ana", contact: "it", password: owner } }));
  assert.ok(created.status === 200 || created.status === 201, "create " + created.status);
  const ana = (await call("GET", kvPath(slug), { ip: anaPhone.ip })).body.value.participants[0];
  const anaPin = "4321";
  assert.equal(anaPhone.take(await call("POST", "/api/set-pin", { ip: anaPhone.ip, cookie: anaPhone.cookie, body: { metaKey, participantId: ana.id, newPin: anaPin } })).status, 200);
  const betoPin = "2468";
  const betoPhone = Browser(freshIp());
  const reg = betoPhone.take(await call("POST", "/api/self-register", { ip: betoPhone.ip, body: { metaKey, name: "Beto", pin: betoPin, slug } }));
  assert.equal(reg.status, 200);
  return { slug, metaKey, owner, ana: { id: ana.id, pin: anaPin }, beto: { id: reg.body.participant.id, pin: betoPin }, anaPhone, betoPhone };
}

// N browsers on ONE network that each prove `login` once (a real, successful
// authentication), so each holds its own trusted-device cookie.
async function trustedBrowsers(n, ip, login) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const b = Browser(ip);
    const r = b.take(await login(b));
    assert.equal(r.status, 200, "login " + JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.ok(b.has("qracks_trust_"), "the login handed out a trusted-device cookie");
    list.push(b);
  }
  return list;
}

// `perBrowser` distinct wrong guesses from each browser, all from the same
// network as the browsers; how many were compared (200) and how many refused (429).
async function guessFrom(browsers, perBrowser, guess, { parallel = false } = {}) {
  let n = 0;
  const jobs = [];
  for (const b of browsers) for (let i = 0; i < perBrowser; i++) { const k = n++; jobs.push(() => guess(b, k)); }
  const results = parallel ? await Promise.all(jobs.map((j) => j())) : [];
  if (!parallel) for (const j of jobs) results.push(await j());
  const tally = { compared: 0, refused: 0, other: [] };
  for (const r of results) {
    if (r.status === 429 && r.body && r.body.error === "too_many_attempts") tally.refused++;
    else if (r.status === 200 && r.body && r.body.ok === false) tally.compared++;
    else tally.other.push(r.status + " " + JSON.stringify(r.body));
  }
  return tally;
}
const wrongPin = (k, avoid) => { let p = String(5000 + k); while (avoid.includes(p)) p = String(Number(p) + 1); return p; };
const pinGuess = (q, who) => (b, k) => call("POST", "/api/verify-pin", { ip: b.ip, cookie: b.cookie, body: { metaKey: q.metaKey, participantId: q[who].id, pin: wrongPin(k, [q[who].pin]) } });

test.describe("trusted-device cookies after a credential change (real server)", () => {
  test.before(async () => {
    if (SKIP) return;
    pg = require("pg");
    dbName = "qracks_it_" + crypto.randomBytes(5).toString("hex");
    await adminQuery(`CREATE DATABASE ${dbName}`);
    dbUrl = ADMIN_URL.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
    port = await freePort();
    await startServer();
  });
  test.after(async () => {
    if (SKIP) return;
    await stopServer();
    if (pg && dbName) await adminQuery(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
  });

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
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query("UPDATE kv SET value = jsonb_set(value, '{settings,ownerPassword}', to_jsonb($2::text)) WHERE key = $1", [q.metaKey, legacyPw]);
    } finally { await client.end(); }
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
