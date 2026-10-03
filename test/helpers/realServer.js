// test/helpers/realServer.js — the real server against a throwaway LOCAL
// PostgreSQL, for integration tests that must go through the real endpoints.
//
//   pg_ctlcluster 16 main start
//   export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres node --test test/*.test.js
//
// Credentials never go in the URL (scripts/security/pre-commit-secret-check.sh
// blocks connection strings with an embedded password): node-postgres takes
// them from PGUSER/PGPASSWORD or ~/.pgpass, here and in the server it starts.
// Any host other than localhost is refused. Each test file that uses this gets
// its own database (created in setup(), dropped in teardown()) and its own
// server on a free port, with QRACKS_CLIENT_IP_SOURCE=xff:1 so every
// simulated client can have its own address.
//
// Without QRACKS_TEST_DATABASE_URL, every test declared with itest() is
// reported as SKIPPED with the reason: never as a pass, never as "0 tests".

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ADMIN_URL = process.env.QRACKS_TEST_DATABASE_URL || "";
const SKIP = !ADMIN_URL
  ? "set QRACKS_TEST_DATABASE_URL to a LOCAL postgres (see test/helpers/realServer.js)"
  : (!/^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(ADMIN_URL)
    ? "QRACKS_TEST_DATABASE_URL must point at localhost" : false);
// Each test carries the skip itself, so a run without PostgreSQL reports
// every one of them as skipped (with the reason) instead of an empty suite.
const itest = (name, fn) => test(name, { skip: SKIP }, fn);

const PLATFORM_PASSWORD = "it-platform-" + crypto.randomBytes(6).toString("hex");
const SERVER_JS = path.join(__dirname, "..", "..", "server.js");

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

// One query against this file's throwaway database.
async function dbQuery(sql, params) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}
async function setup() {
  if (SKIP) return;
  pg = require("pg");
  dbName = "qracks_it_" + crypto.randomBytes(5).toString("hex");
  await adminQuery(`CREATE DATABASE ${dbName}`);
  dbUrl = ADMIN_URL.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
  port = await freePort();
  await startServer();
}
async function teardown() {
  if (SKIP) return;
  await stopServer();
  if (pg && dbName) await adminQuery(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
}
const serverOutput = () => serverLog;

module.exports = {
  SKIP, itest, PLATFORM_PASSWORD, setup, teardown, startServer, stopServer, dbQuery, serverOutput,
  freshIp, call, Browser, kvPath, quiniela, trustedBrowsers, guessFrom,
};
