// clientIp.js — which network a request comes from, for attempt limits.
//
// Never the left end of X-Forwarded-For: that part is whatever the client
// wrote. On Render the chain reaches the app as
//
//   X-Forwarded-For: <anything the client sent>, <client>, <Cloudflare edge>, <Render internal>
//
// (Render's proxy appends; it does not strip what the client sent). With
// Express's `trust proxy 1`, req.ip is the right-most entry, i.e. an address
// inside Render shared by many people, so a per-IP limit keyed on req.ip
// would be one global limit. Cloudflare, which Render puts in front of every
// service, sets CF-Connecting-IP from the TCP connection it accepted, so that
// header is the client as Cloudflare saw it and a client cannot choose it.
//
// Sources (QRACKS_CLIENT_IP_SOURCE, default chosen from the environment):
//   render   CF-Connecting-IP; if it is missing, the X-Forwarded-For entry
//            three from the right (<client> above). Default when RENDER=true,
//            which Render sets on every service.
//   socket   the TCP peer. Default everywhere else (local, tests).
//   xff:N    the entry N from the right of X-Forwarded-For, for a deployment
//            behind exactly N proxies that each append one entry. Used by the
//            local probes to simulate distinct clients.
//
// IPv6 addresses are reduced to their /64: one subscriber normally holds a
// whole /64, and counting each address separately would let them rotate
// through 2^64 of them.

const net = require("net");

function resolveSource(env) {
  const raw = String((env && env.QRACKS_CLIENT_IP_SOURCE) || "").trim().toLowerCase();
  if (raw === "render" || raw === "socket") return { kind: raw };
  const m = raw.match(/^xff:([1-9][0-9]?)$/);
  if (m) return { kind: "xff", hops: Number(m[1]) };
  return { kind: env && env.RENDER === "true" ? "render" : "socket" };
}

// A normalized network key, or null when `value` is not one IP address.
function normalizeIp(value) {
  if (value == null) return null;
  let ip = String(value).trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  const v = net.isIP(ip);
  if (v === 4) return ip;
  if (v !== 6) return null;
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped && net.isIP(mapped[1]) === 4) return mapped[1];
  return ipv6Prefix64(ip);
}

function ipv6Prefix64(ip) {
  // Expand "::" so the first four hextets can be read.
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  // An embedded IPv4 tail counts as two hextets.
  const width = (parts) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const fill = tail !== undefined ? Array(Math.max(0, 8 - width(h) - width(t))).fill("0") : [];
  const groups = [...h, ...fill, ...t];
  const first4 = groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16));
  return first4.join(":") + "::/64";
}

function xffEntries(req) {
  const raw = req.headers && req.headers["x-forwarded-for"];
  const joined = Array.isArray(raw) ? raw.join(",") : String(raw || "");
  return joined.split(",").map((s) => s.trim()).filter(Boolean);
}

function socketAddress(req) {
  return (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || null;
}

// { ip, via } — `via` says which rule produced it, for the diagnostics
// endpoint. `ip` is never null: an unreadable source collapses into one
// shared "unknown" key, which errs toward limiting, not toward letting
// unlimited guesses through.
function clientIpInfo(req, source) {
  const src = source || { kind: "socket" };
  if (src.kind === "render") {
    const cf = normalizeIp(req.headers && req.headers["cf-connecting-ip"]);
    if (cf) return { ip: cf, via: "cf-connecting-ip" };
    const entries = xffEntries(req);
    if (entries.length >= 3) {
      const candidate = normalizeIp(entries[entries.length - 3]);
      if (candidate) return { ip: candidate, via: "xff-3rd-from-right" };
    }
    return { ip: "unknown", via: "unknown" };
  }
  if (src.kind === "xff") {
    const entries = xffEntries(req);
    if (entries.length >= src.hops) {
      const candidate = normalizeIp(entries[entries.length - src.hops]);
      if (candidate) return { ip: candidate, via: "xff-" + src.hops + "-from-right" };
    }
    const sock = normalizeIp(socketAddress(req));
    return { ip: sock || "unknown", via: sock ? "socket" : "unknown" };
  }
  const sock = normalizeIp(socketAddress(req));
  return { ip: sock || "unknown", via: sock ? "socket" : "unknown" };
}

module.exports = { resolveSource, normalizeIp, clientIpInfo, xffEntries };
