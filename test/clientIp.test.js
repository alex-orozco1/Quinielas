// clientIp.test.js — which network a request comes from, for attempt limits.
//
// The Render cases replay the header chain Render delivers to an app:
//   X-Forwarded-For: <client-written...>, <client>, <Cloudflare edge>, <Render internal>
//   CF-Connecting-IP: <client>   (set by Cloudflare from the TCP connection)
// and check that nothing a client writes changes the result.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolveSource, normalizeIp, clientIpInfo, xffEntries } = require("../clientIp");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function req(headers = {}, remoteAddress = "10.0.0.5") {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower, socket: { remoteAddress } };
}
// What Cloudflare + Render hand the app for a client at `client` that wrote
// `forged` headers of its own.
function viaRender(client, forged = {}) {
  const written = forged["x-forwarded-for"] ? forged["x-forwarded-for"] + ", " : "";
  return req({
    ...forged,
    "x-forwarded-for": written + client + ", 172.71.195.123, 10.226.90.65",
    "cf-connecting-ip": client, // Cloudflare overwrites whatever the client sent
  }, "10.226.90.66");
}

test("source: Render by default on Render, socket elsewhere, explicit override", () => {
  assert.deepEqual(resolveSource({ RENDER: "true" }), { kind: "render" });
  assert.deepEqual(resolveSource({}), { kind: "socket" });
  assert.deepEqual(resolveSource({ RENDER: "true", QRACKS_CLIENT_IP_SOURCE: "socket" }), { kind: "socket" });
  assert.deepEqual(resolveSource({ QRACKS_CLIENT_IP_SOURCE: "xff:1" }), { kind: "xff", hops: 1 });
  assert.deepEqual(resolveSource({ QRACKS_CLIENT_IP_SOURCE: "xff:0" }), { kind: "socket" }, "nonsense falls back");
  assert.deepEqual(resolveSource({ QRACKS_CLIENT_IP_SOURCE: "trust-everything" }), { kind: "socket" });
});

test("normalize: IPv4, IPv4-mapped IPv6, IPv6 reduced to its /64, garbage rejected", () => {
  assert.equal(normalizeIp(" 81.97.145.24 "), "81.97.145.24");
  assert.equal(normalizeIp("::ffff:81.97.145.24"), "81.97.145.24");
  assert.equal(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(normalizeIp("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(normalizeIp("2001:db8:1:2::ffff"), normalizeIp("2001:db8:1:2:9:9:9:9"), "same /64, same network");
  assert.notEqual(normalizeIp("2001:db8:1:2::1"), normalizeIp("2001:db8:1:3::1"));
  assert.equal(normalizeIp("[2001:db8::1]"), "2001:db8:0:0::/64");
  assert.equal(normalizeIp("fe80::1%eth0"), "fe80:0:0:0::/64");
  for (const bad of ["", "unknown", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1.2.3.4, 5.6.7.8", "<script>", null, undefined]) {
    assert.equal(normalizeIp(bad), null, String(bad));
  }
});

test("Render: the client is CF-Connecting-IP, whatever the client wrote in X-Forwarded-For", () => {
  const src = { kind: "render" };
  const honest = clientIpInfo(viaRender("81.97.145.24"), src);
  assert.deepEqual(honest, { ip: "81.97.145.24", via: "cf-connecting-ip" });
  for (const forged of [
    { "x-forwarded-for": "1.1.1.1" },
    { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" },
    { "x-forwarded-for": "garbage, , ;" },
    { "true-client-ip": "9.9.9.9" },
    { "x-real-ip": "8.8.8.8" },
  ]) {
    assert.deepEqual(clientIpInfo(viaRender("81.97.145.24", forged), src), honest, JSON.stringify(forged));
  }
});

test("Render: Express's req.ip under trust proxy 1 would be Render's internal address — shared by everyone", () => {
  const entries = xffEntries(viaRender("81.97.145.24"));
  assert.equal(entries[entries.length - 1], "10.226.90.65", "right-most entry is not the client");
  assert.notEqual(clientIpInfo(viaRender("81.97.145.24"), { kind: "render" }).ip, entries[entries.length - 1]);
});

test("Render without CF-Connecting-IP: third from the right, still immune to a client-written prefix", () => {
  const src = { kind: "render" };
  const r = req({ "x-forwarded-for": "6.6.6.6, 81.97.145.24, 172.71.195.123, 10.226.90.65" });
  assert.deepEqual(clientIpInfo(r, src), { ip: "81.97.145.24", via: "xff-3rd-from-right" });
  // A chain too short to contain the client is not trusted at all.
  assert.deepEqual(clientIpInfo(req({ "x-forwarded-for": "6.6.6.6, 10.226.90.65" }), src), { ip: "unknown", via: "unknown" });
  // A forged, unparsable CF-Connecting-IP cannot reach this point on Render (Cloudflare overwrites it),
  // and if it ever did it would not be used.
  assert.equal(clientIpInfo(req({ "cf-connecting-ip": "nope", "x-forwarded-for": "6.6.6.6, 5.5.5.5, 172.71.195.123, 10.226.90.65" }), src).ip, "5.5.5.5");
});

test("socket source ignores every header", () => {
  const r = req({ "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "2.2.2.2", "true-client-ip": "3.3.3.3" }, "::ffff:127.0.0.1");
  assert.deepEqual(clientIpInfo(r, { kind: "socket" }), { ip: "127.0.0.1", via: "socket" });
});

test("xff:N counts from the right; a client-written prefix never matters", () => {
  const src = { kind: "xff", hops: 1 };
  assert.equal(clientIpInfo(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), src).ip, "203.0.113.9");
  assert.equal(clientIpInfo(req({ "x-forwarded-for": "203.0.113.9" }), src).ip, "203.0.113.9");
  assert.equal(clientIpInfo(req({}, "127.0.0.1"), src).ip, "127.0.0.1", "no header: socket");
});

test("SERVER: attempt limits and the request-count limiter both key on requestClientIp, never req.ip", () => {
  assert.ok(serverSrc.includes("const CLIENT_IP_SOURCE = clientIp.resolveSource(process.env);"));
  const rate = serverSrc.slice(serverSrc.indexOf("function rateLimit(name)"), serverSrc.indexOf("function rateLimit(name)") + 300);
  assert.ok(rate.includes("const ip = requestClientIp(req);"));
  const ctx = serverSrc.slice(serverSrc.indexOf("function credentialContext("), serverSrc.indexOf("function checkCredential("));
  assert.ok(ctx.includes("ip: requestClientIp(req)"));
  const uses = serverSrc.split("\n").filter((l) => /\breq\.ip\b/.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(uses.map((l) => l.trim()), ["expressReqIp: req.ip || null,"], "only the diagnostics endpoint shows req.ip, for comparison");
});

test("SERVER: the client-ip check is platform-only and limited", () => {
  const start = serverSrc.indexOf('app.get("/api/platform/client-ip-check"');
  const body = serverSrc.slice(start, serverSrc.indexOf("\napp.", start + 10));
  assert.ok(body.includes('rateLimit("client-ip-check")'));
  assert.ok(body.includes("if (!checkPlatformCredential(req, providedPlatformAuth, platformHash)) {"));
  assert.ok(body.indexOf("checkPlatformCredential") < body.indexOf("res.json({"));
});
