// Quiniela / QRACKS — backend
// Serves the static frontend and a small key-value API backed by Postgres, plus a
// handful of narrow endpoints for things that need real server-side rules
// (authentication, PIN/password hashing, pick deadlines, safe creation/migration).

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

// ---------- required configuration ----------
// No default secrets, ever. If these aren't set, the server refuses to boot
// rather than silently running with a guessable password.
const REQUIRED_ENV = ["DATABASE_URL", "PLATFORM_PASSWORD"];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error(
    "Missing required environment variable(s): " + missingEnv.join(", ") + ".\n" +
    "Set them in Render (or your .env locally) before starting the server:\n" +
    "  DATABASE_URL      — your Postgres connection string\n" +
    "  PLATFORM_PASSWORD — the password for /panel-plataforma the FIRST time it's ever used " +
    "(after that, whatever password is saved in the dashboard takes over)"
  );
  process.exit(1);
}

// ---------- password/PIN hashing (scrypt, no extra dependency needed) ----------
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(plain), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
function isHashed(value) {
  return typeof value === "string" && value.startsWith("scrypt$");
}
function verifyPassword(plain, stored) {
  if (plain == null || plain === "" || !stored) return false;
  if (!isHashed(stored)) return String(plain) === String(stored);
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const [, salt, hash] = parts;
  try {
    const check = crypto.scryptSync(String(plain), salt, 64).toString("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(check, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

// ---------- signed session tokens (Access Link "remember this device") ----------
// The token itself lives ONLY in an HttpOnly cookie — the frontend never sees it,
// only the {name, isAdmin, hasPin} state that comes back from verifying it.
// Signed with a server secret (generated once, stored in the DB — no new env var
// needed) so nothing can be forged without the server's cooperation. A PIN reset
// invalidates every outstanding session for that participant automatically,
// because the token embeds a fingerprint of the PIN at the time it was issued.
let sessionSecret = null; // set at boot, see ensureSessionSecret()

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(str) {
  str = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}
function pinFingerprint(pin) {
  if (!pin) return "";
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}
function signSessionToken(payload) {
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.createHmac("sha256", sessionSecret).update(payloadB64).digest("hex");
  return payloadB64 + "." + sig;
}
function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  try {
    const expectedSig = crypto.createHmac("sha256", sessionSecret).update(payloadB64).digest("hex");
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expectedSig, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return JSON.parse(fromBase64url(payloadB64).toString());
  } catch (e) {
    return null;
  }
}
// Minimal manual cookie reader — no new dependency (Express already has
// res.cookie()/res.clearCookie() built in for writing, just not a reader).
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  });
  return out;
}
function sessionCookieName(slug) {
  return "qracks_session_" + (slug || "_root");
}
// Secure only outside local dev (a plain-HTTP localhost can't set/send Secure
// cookies at all) — matches the same DATABASE_URL-based local/prod check
// already used for the Postgres SSL setting.
const IS_LOCAL = process.env.DATABASE_URL.includes("localhost");
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: !IS_LOCAL,
  sameSite: "lax",
  path: "/",
  maxAge: 365 * 24 * 60 * 60 * 1000
};
// clearCookie must NOT carry maxAge — Max-Age outranks Expires per the cookie
// spec, so reusing SESSION_COOKIE_OPTIONS as-is would set a fresh 1-year
// cookie instead of actually clearing it.
const SESSION_COOKIE_CLEAR_OPTIONS = {
  httpOnly: true,
  secure: !IS_LOCAL,
  sameSite: "lax",
  path: "/"
};
const SESSION_TOKEN_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // matches the cookie's own maxAge
function issueSessionCookie(res, slug, participant) {
  const token = signSessionToken({
    participantId: participant.id,
    slug: slug || "_root",
    pinFp: pinFingerprint(participant.pin),
    issuedAt: Date.now()
  });
  res.cookie(sessionCookieName(slug), token, SESSION_COOKIE_OPTIONS);
}
function readSessionFromCookie(req, slug) {
  const cookies = parseCookies(req.headers.cookie || "");
  const raw = cookies[sessionCookieName(slug)];
  if (!raw) return null;
  const session = verifySessionToken(raw);
  if (!session || session.slug !== (slug || "_root")) return null;
  if (!session.issuedAt || Date.now() - session.issuedAt > SESSION_TOKEN_MAX_AGE_MS) return null;
  return session;
}
// The extra check alongside a PIN header, everywhere a participant needs to
// prove it's them: either their PIN matches, OR they have a valid session
// cookie for this exact participant whose fingerprint still matches their
// CURRENT pin (so resetting someone's PIN silently logs out every device
// that was resting on the old one).
function isAuthenticatedAsParticipantReq(req, slug, participant) {
  if (isAuthenticatedAsParticipant(participant, req.get("x-qracks-auth") || "")) return true;
  const session = readSessionFromCookie(req, slug);
  if (!session || !participant) return false;
  return session.participantId === participant.id && session.pinFp === pinFingerprint(participant.pin);
}

const app = express();
// Render puts exactly one reverse proxy in front of this app. Trusting only
// that one hop (instead of blindly trusting any X-Forwarded-For a client
// sends) is what makes req.ip a real client IP instead of something a client
// could spoof to dodge rate limiting.
app.set("trust proxy", 1);
app.use(express.json({ limit: "3mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  // Explicit instead of relying on pg's defaults, so this is a deliberate,
  // documented choice rather than an implicit one. PG_POOL_MAX is optional —
  // only set it in Render if this default ever needs tuning for a specific
  // Postgres provider's own connection limit (e.g. Supabase's pooler).
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Seeded once so create/migrate can take a real row lock on it (SELECT ... FOR
  // UPDATE) from the very first request onward, instead of racing on an INSERT.
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ('platform_index', '{"quinielas":[]}'::jsonb, now())
     ON CONFLICT (key) DO NOTHING`
  );
  // Session-signing secret — generated once, reused forever after. Stored in
  // the DB (not an env var) so nothing new has to be configured in Render.
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ('__session_secret__', $1::jsonb, now())
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(crypto.randomBytes(32).toString("hex"))]
  );
  const secretRow = await pool.query("SELECT value FROM kv WHERE key = '__session_secret__'");
  sessionSecret = secretRow.rows[0].value;

  // Growth Loop funnel events — a plain table (not the kv blob store) since
  // this grows by appending rows, and needs to stay simply queryable
  // (SELECT * FROM analytics_events ORDER BY created_at DESC) without a
  // dashboard. No PII beyond an anonymous device id and whatever participant
  // id was already public within that quiniela.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id SERIAL PRIMARY KEY,
      event_name TEXT NOT NULL,
      competition_slug TEXT,
      participant_id TEXT,
      is_new_user BOOLEAN,
      device_id TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getRow(key, client) {
  const q = client || pool;
  const r = await q.query("SELECT value FROM kv WHERE key = $1", [key]);
  return r.rows.length ? r.rows[0].value : null;
}
// Locks the row for the rest of the transaction, so a second concurrent
// transaction reading the same key has to wait its turn instead of both
// reading a stale snapshot and one silently overwriting the other's change.
async function getRowLocked(key, client) {
  const r = await client.query("SELECT value FROM kv WHERE key = $1 FOR UPDATE", [key]);
  return r.rows.length ? r.rows[0].value : null;
}
async function putRow(key, value, client) {
  const q = client || pool;
  await q.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

// ---------- rate limiting for the endpoints that check a secret ----------
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX = 40; // attempts per window, per IP+endpoint
const rateBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function rateLimit(name) {
  return (req, res, next) => {
    const ip = req.ip || "unknown";
    const bucketKey = name + ":" + ip;
    const now = Date.now();
    let bucket = rateBuckets.get(bucketKey);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      rateBuckets.set(bucketKey, bucket);
    }
    bucket.count++;
    if (bucket.count > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: "too_many_attempts" });
    }
    next();
  };
}

// ---------- key classification ----------
// Only these exact keys/patterns are recognized. Anything else is rejected —
// the generic store/read/delete endpoints are for QRACKS's own data shapes,
// not an arbitrary key-value bucket anyone can stash unrelated things in.
const PLATFORM_KEYS = new Set(["platform_settings", "platform_index", "platform_payment_log"]);

function classifyKey(key) {
  if (PLATFORM_KEYS.has(key)) return { kind: "platform" };
  if (key === "quiniela_meta_v1") return { kind: "quiniela-meta", metaKey: "quiniela_meta_v1" };
  let m = key.match(/^quiniela:([a-z0-9-]{1,60}):meta$/);
  if (m) return { kind: "quiniela-meta", metaKey: key, slug: m[1] };
  m = key.match(/^quiniela_picks_([a-z0-9_]{1,60})_v1$/i);
  if (m) return { kind: "picks", metaKey: "quiniela_meta_v1", participantId: m[1] };
  m = key.match(/^quiniela:([a-z0-9-]{1,60}):picks:([a-z0-9_]{1,60})$/i);
  if (m) return { kind: "picks", metaKey: `quiniela:${m[1]}:meta`, participantId: m[2], slug: m[1] };
  return { kind: "other" };
}

// ---------- secret stripping for reads ----------
function stripQuinielaSecrets(value, isAdminOrOwner) {
  const clone = JSON.parse(JSON.stringify(value));
  if (clone.settings && "ownerPassword" in clone.settings) {
    delete clone.settings.ownerPassword;
  }
  if (Array.isArray(clone.participants)) {
    clone.participants.forEach((p) => {
      if ("pin" in p) {
        p.hasPin = !!p.pin;
        delete p.pin;
      }
    });
  }
  if (!isAdminOrOwner && Array.isArray(clone.rounds)) {
    // Draft/pending-correction results are for the admin's eyes only, until
    // they're actually published — same rule whether it's a brand-new round
    // being captured for the first time or a correction to one that's already
    // live (which keeps its old, real `results` untouched and visible the
    // whole time this is happening).
    clone.rounds.forEach((r) => { delete r.draftResults; });
  }
  return clone;
}
// Used only for GET — is this request proven to be the quiniela's own admin
// or owner (PIN or password, header or session cookie — same rules as writes)?
function isRequestAdminOrOwner(req, slug, value) {
  const providedAuth = req.get("x-qracks-auth") || "";
  if (value && value.settings && verifyPassword(providedAuth, value.settings.ownerPassword)) return true;
  return (value && value.participants || []).some(
    (p) => p.isAdmin && p.pin && isAuthenticatedAsParticipantReq(req, slug, p)
  );
}
function stripPlatformSecrets(value) {
  const clone = JSON.parse(JSON.stringify(value));
  if ("dashboardPassword" in clone) delete clone.dashboardPassword;
  return clone;
}
// Public callers only get enough to render a plain list / check a slug is
// taken — nothing about contact info, payment/exemption status, or per-
// quiniela overrides. The authenticated platform dashboard gets everything.
function stripPlatformIndexForPublic(value) {
  const quinielas = Array.isArray(value.quinielas) ? value.quinielas : [];
  return { quinielas: quinielas.map((q) => ({ slug: q.slug, name: q.name })) };
}

// ---------- auth tiers ----------
function resolveMetaAuthTier(oldValue, providedOwnerAuth, providedPlatformAuth, platformHash, req, slug) {
  if (oldValue && oldValue.settings && verifyPassword(providedOwnerAuth, oldValue.settings.ownerPassword)) {
    return "owner";
  }
  if (providedPlatformAuth && verifyPassword(providedPlatformAuth, platformHash)) {
    return "platform";
  }
  if (oldValue && (oldValue.participants || []).some(
    (p) => p.isAdmin && p.pin && req && isAuthenticatedAsParticipantReq(req, slug, p)
  )) {
    return "admin-pin";
  }
  return null;
}

function mergeProtectedMetaFields(oldValue, newValue, authTier) {
  const merged = JSON.parse(JSON.stringify(newValue));
  const oldSettings = (oldValue && oldValue.settings) || null;
  if (!merged.settings) merged.settings = {};

  const canChangeOwnerFields = authTier === "owner" || authTier === "platform";
  const incomingPw = merged.settings.ownerPassword;
  if (!canChangeOwnerFields) {
    if (oldSettings && oldSettings.ownerPassword) {
      merged.settings.ownerPassword = isHashed(oldSettings.ownerPassword)
        ? oldSettings.ownerPassword
        : hashPassword(oldSettings.ownerPassword);
    } else {
      delete merged.settings.ownerPassword;
    }
  } else if (!incomingPw) {
    if (oldSettings && oldSettings.ownerPassword) {
      merged.settings.ownerPassword = isHashed(oldSettings.ownerPassword)
        ? oldSettings.ownerPassword
        : hashPassword(oldSettings.ownerPassword);
    }
  } else if (!isHashed(incomingPw)) {
    merged.settings.ownerPassword = hashPassword(incomingPw);
  }

  const oldParticipants = (oldValue && Array.isArray(oldValue.participants)) ? oldValue.participants : [];
  const oldById = {};
  oldParticipants.forEach((p) => { oldById[p.id] = p; });
  if (Array.isArray(merged.participants)) {
    merged.participants.forEach((p) => {
      const old = oldById[p.id];
      if (!("pin" in p)) {
        if (old && "pin" in old && old.pin) {
          p.pin = isHashed(old.pin) ? old.pin : hashPassword(old.pin);
        } else if (old && "pin" in old) {
          p.pin = old.pin;
        }
      } else if (p.pin && !isHashed(p.pin)) {
        p.pin = hashPassword(p.pin);
      }
      if (!canChangeOwnerFields && old && p.isAdmin !== old.isAdmin) {
        p.isAdmin = old.isAdmin;
      }
    });
  }
  return merged;
}

function mergeProtectedPlatformFields(oldValue, newValue) {
  const merged = JSON.parse(JSON.stringify(newValue));
  const incomingPw = merged.dashboardPassword;
  if (!incomingPw) {
    if (oldValue && oldValue.dashboardPassword) {
      merged.dashboardPassword = isHashed(oldValue.dashboardPassword)
        ? oldValue.dashboardPassword
        : hashPassword(oldValue.dashboardPassword);
    }
  } else if (!isHashed(incomingPw)) {
    merged.dashboardPassword = hashPassword(incomingPw);
  }
  return merged;
}

// A participant only counts as "authenticated as themselves" if they have a
// PIN AND it matches. No PIN does NOT mean open access anymore — it means
// they haven't activated yet, and activation only happens through
// /api/set-pin (see below), never implicitly via a public request.
function isAuthenticatedAsParticipant(participant, providedAuth) {
  return !!(participant && participant.pin && verifyPassword(providedAuth, participant.pin));
}

async function filterPicksForRequest(req, info, picksValue, preloadedMeta) {
  const meta = preloadedMeta || await getRow(info.metaKey);
  if (!meta) return picksValue;
  const providedAuth = req.get("x-qracks-auth") || "";
  const participant = (meta.participants || []).find((p) => p.id === info.participantId);

  const isSelf = isAuthenticatedAsParticipantReq(req, info.slug, participant);
  if (isSelf) return picksValue; // only the participant sees their own open-round answers

  const isOwner = meta.settings && verifyPassword(providedAuth, meta.settings.ownerPassword);
  const isAdminOrOwner = isOwner || (meta.participants || []).some(
    (p) => p.isAdmin && p.pin && isAuthenticatedAsParticipantReq(req, info.slug, p)
  );

  const now = Date.now();
  const openRoundIds = new Set(
    (meta.rounds || [])
      .filter((r) => new Date(r.deadline).getTime() > now)
      .map((r) => r.id)
  );
  const filtered = {};
  for (const roundId in picksValue) {
    if (!openRoundIds.has(roundId)) {
      // Closed round — already visible to everyone once it locks (existing behavior).
      filtered[roundId] = picksValue[roundId];
    } else if (isAdminOrOwner) {
      // Open round, admin/owner asking — reveal only that an answer exists per
      // match (and per jornada-scope bet, under __extra), never what it says.
      const entry = picksValue[roundId] || {};
      const revealed = {};
      Object.keys(entry).forEach((k) => {
        if (k === "__extra" && entry.__extra && typeof entry.__extra === "object") {
          const extraRevealed = {};
          Object.keys(entry.__extra).forEach((betId) => { extraRevealed[betId] = true; });
          revealed.__extra = extraRevealed;
        } else {
          revealed[k] = true;
        }
      });
      filtered[roundId] = revealed;
    }
    // Open round, requester is neither self nor admin/owner — omitted entirely.
  }
  return filtered;
}

// Rejects a picks write if it touches ANY round whose deadline already
// passed — including a round that's missing from the new value entirely
// (deleting/omitting a closed round's picks is exactly as forbidden as
// editing them, so this compares the UNION of old and new round ids).
async function validatePicksDeadline(info, oldValue, newValue, preloadedMeta) {
  const meta = preloadedMeta !== undefined ? preloadedMeta : await getRow(info.metaKey);
  if (!meta) return { ok: true };
  const roundsById = {};
  (meta.rounds || []).forEach((r) => { roundsById[r.id] = r; });
  const old = oldValue || {};
  const fresh = newValue || {};
  const now = Date.now();
  const allRoundIds = new Set([...Object.keys(old), ...Object.keys(fresh)]);
  for (const roundId of allRoundIds) {
    const round = roundsById[roundId];
    const oldRoundPicks = JSON.stringify(old[roundId] || {});
    const newRoundPicks = JSON.stringify(fresh[roundId] || {});
    if (!round) {
      // The round no longer exists in the quiniela's config (e.g. an admin
      // deleted it after it closed). We can no longer check its deadline, so
      // — rather than silently treat that as "anything goes" — anything that
      // already had picks stays exactly as it was; nothing new can be added
      // under a round id that isn't real.
      if (oldRoundPicks !== newRoundPicks) return { ok: false };
      continue;
    }
    if (now <= new Date(round.deadline).getTime()) continue; // still open, fine
    if (oldRoundPicks !== newRoundPicks) return { ok: false };
  }
  return { ok: true };
}

// A round can only be marked resultsPublished if it has a real, valid result
// (win / draw / loss) for every one of ITS OWN matches — never a hardcoded
// count, always round.matches.length for that specific round. This runs on
// every quiniela-meta write, so it also catches a correction that publishes
// an incomplete draft, not just the first time.
const VALID_RESULT_VALUES = new Set(["A", "D", "B"]);
function validateRoundsIntegrity(newValue) {
  if (!Array.isArray(newValue.rounds)) return { ok: true };
  for (const round of newValue.rounds) {
    if (!round.resultsPublished) continue;
    const results = round.results || {};
    const matches = Array.isArray(round.matches) ? round.matches : [];
    for (const m of matches) {
      if (!VALID_RESULT_VALUES.has(results[m.id])) {
        return { ok: false, reason: "incomplete_results", roundNumber: round.number };
      }
    }
  }
  return { ok: true };
}

async function getPlatformHash() {
  const platValue = await getRow("platform_settings");
  return platValue && platValue.dashboardPassword ? platValue.dashboardPassword : process.env.PLATFORM_PASSWORD;
}

// Keeps the platform dashboard's participant/round counts fresh WITHOUT it
// ever having to download each quiniela's full meta — this is the write side
// of that: whenever a quiniela's own meta is saved, its two counts get synced
// onto its platform_index entry. Best-effort and never awaited by the caller
// (a stale dashboard number for a moment is a fine tradeoff for never slowing
// down someone's own save); skips the write entirely if nothing changed.
async function updatePlatformIndexCounts(slug, meta) {
  try {
    const newCount = Array.isArray(meta.participants) ? meta.participants.length : 0;
    const newRounds = Array.isArray(meta.rounds) ? meta.rounds.length : 0;
    const idx = await getRow("platform_index");
    if (!idx || !Array.isArray(idx.quinielas)) return;
    const entry = idx.quinielas.find((q) => q.slug === slug);
    if (!entry) return;
    if (entry.participantCount === newCount && entry.roundCount === newRounds) return;
    entry.participantCount = newCount;
    entry.roundCount = newRounds;
    await putRow("platform_index", idx);
  } catch (err) {
    console.error("updatePlatformIndexCounts failed", err);
  }
}

// ---------- generic KV endpoints (QRACKS's own key shapes only) ----------

app.get("/api/kv/:key", async (req, res) => {
  try {
    const info = classifyKey(req.params.key);
    if (info.kind === "other") return res.status(400).json({ error: "invalid_key" });

    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [req.params.key]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    let value = r.rows[0].value;

    if (info.kind === "quiniela-meta") {
      const isAdminOrOwner = isRequestAdminOrOwner(req, info.slug, value);
      value = stripQuinielaSecrets(value, isAdminOrOwner);
    } else if (info.kind === "platform") {
      if (req.params.key === "platform_settings") {
        value = stripPlatformSecrets(value);
      } else if (req.params.key === "platform_index") {
        const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
        const platformHash = await getPlatformHash();
        const isPlatformAuthed = verifyPassword(providedPlatformAuth, platformHash);
        value = isPlatformAuthed ? value : stripPlatformIndexForPublic(value);
      } else if (req.params.key === "platform_payment_log") {
        const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
        const platformHash = await getPlatformHash();
        if (!verifyPassword(providedPlatformAuth, platformHash)) {
          return res.status(403).json({ error: "unauthorized" });
        }
      }
    } else if (info.kind === "picks") {
      value = await filterPicksForRequest(req, info, value);
    }
    res.json({ key: req.params.key, value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// Same rules as GET /api/kv/quiniela:<slug>:picks:<pid>, one participant at a
// time — just batched. The meta is read exactly once here (instead of once
// per participant, which is what made the old N+1 pattern expensive on the
// database too), and every participant's picks still go through the SAME
// filterPicksForRequest() used by the single-participant endpoint, so a
// closed round stays visible to everyone, an open round stays hidden from
// everyone except that participant or an admin/owner — identical to before,
// just in one round trip instead of N.
app.post("/api/picks-batch", async (req, res) => {
  try {
    const { metaKey, participantIds } = req.body || {};
    if (!metaKey || !Array.isArray(participantIds)) {
      return res.status(400).json({ error: "invalid_params" });
    }
    let slug = null;
    if (metaKey !== "quiniela_meta_v1") {
      const m = metaKey.match(/^quiniela:([a-z0-9-]{1,60}):meta$/);
      if (!m) return res.status(400).json({ error: "invalid_metaKey" });
      slug = m[1];
    }
    const meta = await getRow(metaKey);
    if (!meta) return res.status(404).json({ error: "not_found" });

    // Dedup, drop anything that isn't an actual participant of this quiniela
    // (defends against unknown/forged ids without a DB round trip), then apply
    // the same hard cap as before — a sane ceiling, not a business rule.
    const validIds = new Set((meta.participants || []).map((p) => p.id));
    const requestedIds = [...new Set(participantIds)]
      .filter((pid) => validIds.has(pid))
      .slice(0, 2000);

    const picks = {};
    if (requestedIds.length === 0) return res.json({ ok: true, picks });

    const picksKeys = requestedIds.map((pid) =>
      slug ? `quiniela:${slug}:picks:${pid}` : `quiniela_picks_${pid}_v1`
    );
    // One query for every participant's picks, instead of one query per
    // participant — this was the last sequential-per-participant DB cost left
    // after the meta read was already deduplicated to a single call.
    const r = await pool.query("SELECT key, value FROM kv WHERE key = ANY($1)", [picksKeys]);
    const rowByKey = {};
    r.rows.forEach((row) => { rowByKey[row.key] = row.value; });

    for (const pid of requestedIds) {
      const key = slug ? `quiniela:${slug}:picks:${pid}` : `quiniela_picks_${pid}_v1`;
      const raw = rowByKey[key];
      if (raw == null) { picks[pid] = {}; continue; }
      // slug/pid/metaKey are already known here — building info directly skips
      // re-parsing the key we just built with classifyKey's regex, N times.
      const info = { kind: "picks", metaKey, participantId: pid, slug: slug || undefined };
      picks[pid] = await filterPicksForRequest(req, info, raw, meta);
    }
    res.json({ ok: true, picks });
  } catch (err) {
    console.error("picks-batch failed", err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/kv/:key", async (req, res) => {
  try {
    const value = req.body ? req.body.value : undefined;
    if (value === undefined) return res.status(400).json({ error: "missing_value" });
    const info = classifyKey(req.params.key);
    if (info.kind === "other") return res.status(400).json({ error: "invalid_key" });

    const providedOwnerAuth = req.get("x-qracks-auth") || "";
    const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
    let finalValue = value;

    if (info.kind === "platform") {
      // All three platform-level keys validate against the SAME current password
      // (platform_settings' own hash, or the bootstrap env var if that doesn't
      // exist yet) — never against a per-key field, so changing the password
      // once in the dashboard immediately applies everywhere, consistently.
      const platformHash = await getPlatformHash();
      if (!verifyPassword(providedPlatformAuth, platformHash)) {
        return res.status(403).json({ error: "unauthorized" });
      }
      if (req.params.key === "platform_settings") {
        const oldValue = await getRow(req.params.key);
        finalValue = mergeProtectedPlatformFields(oldValue, value);
      }
    } else if (info.kind === "quiniela-meta") {
      const oldValue = await getRow(info.metaKey);
      if (!oldValue) {
        // Brand-new quinielas are only ever created through POST /api/create-quiniela,
        // which handles the meta + platform_index registration together, atomically.
        return res.status(403).json({ error: "use_create_endpoint" });
      }
      const platformHash = await getPlatformHash();
      const authTier = resolveMetaAuthTier(oldValue, providedOwnerAuth, providedPlatformAuth, platformHash, req, info.slug);
      if (!authTier) return res.status(403).json({ error: "unauthorized" });
      finalValue = mergeProtectedMetaFields(oldValue, value, authTier);
      const roundsCheck = validateRoundsIntegrity(finalValue);
      if (!roundsCheck.ok) return res.status(400).json({ error: roundsCheck.reason, roundNumber: roundsCheck.roundNumber });
    } else if (info.kind === "picks") {
      const oldPicks = await getRow(req.params.key);
      const metaValue = await getRow(info.metaKey);
      if (metaValue) {
        const participant = (metaValue.participants || []).find((p) => p.id === info.participantId);
        if (!isAuthenticatedAsParticipantReq(req, info.slug, participant)) {
          // No PIN yet? They need to activate one first via /api/set-pin — a
          // public request (with or without a guessed PIN) can't read or write
          // picks just because a PIN hasn't been set.
          return res.status(403).json({ error: participant && !participant.pin ? "pin_required" : "unauthorized" });
        }
      }
      // metaValue missing entirely is a bootstrap edge case (shouldn't happen in
      // practice since quinielas are always created before anyone can vote) — no
      // meta means no rounds to validate deadlines against either, so it's a no-op.
      const deadlineCheck = await validatePicksDeadline(info, oldPicks, value, metaValue);
      if (!deadlineCheck.ok) return res.status(403).json({ error: "round_locked" });
    }

    await putRow(req.params.key, finalValue);
    if (info.kind === "quiniela-meta" && info.slug) {
      updatePlatformIndexCounts(info.slug, finalValue); // not awaited on purpose
    }
    res.json({ key: req.params.key, ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.delete("/api/kv/:key", async (req, res) => {
  try {
    const info = classifyKey(req.params.key);
    if (info.kind === "other") return res.status(400).json({ error: "invalid_key" });
    if (info.kind === "quiniela-meta" || info.kind === "picks" || info.kind === "platform") {
      const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
      const platHash = await getPlatformHash();
      if (!verifyPassword(providedPlatformAuth, platHash)) {
        return res.status(403).json({ error: "unauthorized" });
      }
    }
    await pool.query("DELETE FROM kv WHERE key = $1", [req.params.key]);
    res.json({ key: req.params.key, deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- narrow self-service endpoints ----------

app.post("/api/verify-owner", rateLimit("verify-owner"), async (req, res) => {
  try {
    const { metaKey, password } = req.body || {};
    if (!metaKey) return res.status(400).json({ error: "missing_metaKey" });
    const value = await getRow(metaKey);
    const stored = value && value.settings ? value.settings.ownerPassword : null;
    res.json({ ok: verifyPassword(password, stored) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/verify-platform", rateLimit("verify-platform"), async (req, res) => {
  try {
    const { password } = req.body || {};
    const stored = await getPlatformHash();
    res.json({ ok: verifyPassword(password, stored) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/verify-pin", rateLimit("verify-pin"), async (req, res) => {
  try {
    const { metaKey, participantId, pin, slug } = req.body || {};
    if (!metaKey || !participantId) return res.status(400).json({ error: "missing_params" });
    const value = await getRow(metaKey);
    const participant = value ? (value.participants || []).find((p) => p.id === participantId) : null;
    // A participant with no PIN yet isn't "verified" — the frontend should
    // route them to /api/set-pin instead of treating this as a pass.
    const ok = isAuthenticatedAsParticipant(participant, pin);
    if (ok) issueSessionCookie(res, slug, participant);
    res.json({ ok });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// This IS the controlled activation path for participants who don't have a
// PIN yet (old or new): if they have no PIN on file, no proof is required to
// set their first one (there's nothing to prove yet); if they already have
// one, the current PIN must match. Either way, this is the only way a PIN
// ever gets set — never implicitly through a public picks request.
app.post("/api/set-pin", rateLimit("verify-pin"), async (req, res) => {
  try {
    const { metaKey, participantId, currentPin, newPin, slug } = req.body || {};
    if (!metaKey || !participantId || !/^\d{4}$/.test(String(newPin || ""))) {
      return res.status(400).json({ error: "invalid_params" });
    }
    const value = await getRow(metaKey);
    if (!value) return res.status(404).json({ error: "not_found" });
    const participant = (value.participants || []).find((p) => p.id === participantId);
    if (!participant) return res.status(404).json({ error: "participant_not_found" });
    if (participant.pin && !verifyPassword(currentPin, participant.pin)) {
      return res.status(403).json({ error: "wrong_current_pin" });
    }
    participant.pin = hashPassword(newPin);
    await putRow(metaKey, value);
    issueSessionCookie(res, slug, participant);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// Silent, read-only check used when the Access Link is opened: is there a
// still-valid session for this device? Only the resulting user state goes
// back to the frontend — the token itself never leaves this handler.
app.post("/api/verify-session", async (req, res) => {
  try {
    const { slug, metaKey } = req.body || {};
    if (!metaKey) return res.status(400).json({ error: "missing_params" });
    const session = readSessionFromCookie(req, slug);
    if (!session) {
      res.clearCookie(sessionCookieName(slug), SESSION_COOKIE_CLEAR_OPTIONS);
      return res.json({ ok: false });
    }
    const value = await getRow(metaKey);
    const participant = value ? (value.participants || []).find((p) => p.id === session.participantId) : null;
    if (!participant || session.pinFp !== pinFingerprint(participant.pin)) {
      res.clearCookie(sessionCookieName(slug), SESSION_COOKIE_CLEAR_OPTIONS);
      return res.json({ ok: false });
    }
    res.json({
      ok: true,
      participantId: participant.id,
      name: participant.name,
      isAdmin: !!participant.isAdmin,
      hasPin: !!participant.pin
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/clear-session", async (req, res) => {
  try {
    const { slug } = req.body || {};
    res.clearCookie(sessionCookieName(slug), SESSION_COOKIE_CLEAR_OPTIONS);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/self-register", async (req, res) => {
  try {
    const { metaKey, name, pin, slug } = req.body || {};
    const cleanName = String(name || "").trim();
    if (!metaKey || !cleanName || !/^\d{4}$/.test(String(pin || ""))) {
      return res.status(400).json({ error: "invalid_params" });
    }
    const value = await getRow(metaKey);
    if (!value) return res.status(404).json({ error: "not_found" });
    if (!Array.isArray(value.participants)) value.participants = [];
    if (value.participants.some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return res.status(409).json({ error: "name_taken" });
    }
    const newParticipant = {
      id: "p_" + crypto.randomBytes(9).toString("hex"),
      name: cleanName, isAdmin: false, paid: false, pin: hashPassword(pin)
    };
    value.participants.push(newParticipant);
    await putRow(metaKey, value);
    issueSessionCookie(res, slug, newParticipant);
    res.json({ ok: true, participant: { id: newParticipant.id, name: newParticipant.name, isAdmin: false, paid: false, hasPin: true } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// A quiniela's own payment status (used to show/hide the "you owe a payment"
// banner) needs a few platform_index/platform_settings fields, but the admin
// asking shouldn't need the platform password just to see their own status.
// This hands back only the one quiniela's own fields — nothing about anyone
// else's contact info, exemptions, or overrides.
app.get("/api/payment-status/:slug", async (req, res) => {
  try {
    const idx = await getRow("platform_index");
    const entry = idx && Array.isArray(idx.quinielas)
      ? idx.quinielas.find((q) => q.slug === req.params.slug)
      : null;
    if (!entry) return res.json({ exists: false });
    const settings = (await getRow("platform_settings")) || {};
    res.json({
      exists: true,
      exempt: !!entry.exempt,
      paid: !!entry.paid,
      customJornadaLimit: entry.customJornadaLimit != null ? entry.customJornadaLimit : null,
      jornadaLimit: settings.jornadaLimit != null ? settings.jornadaLimit : 5,
      pricePerParticipant: settings.pricePerParticipant != null ? settings.pricePerParticipant : 10,
      depositInfo: settings.depositInfo || ""
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// Slug rules shared by creation: lowercase letters/numbers/hyphens only, no
// leading/trailing hyphens, reasonable length. Anything else gets normalized
// the same way the frontend already does, so what the user typed and what
// gets stored always match.
function normalizeSlug(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Creating a brand-new quiniela is one atomic operation: validate everything,
// make sure the slug is free in BOTH the meta table and the platform index,
// write the hashed-password meta with its first (admin) participant, and add
// the platform_index entry — all inside one transaction. If anything fails,
// nothing is left behind: no orphaned meta with no index entry, no orphaned
// index entry with no meta.
app.post("/api/create-quiniela", async (req, res) => {
  const { slug, groupName, creatorName, contact, password } = req.body || {};
  const cleanSlug = normalizeSlug(slug) || "quiniela";
  const cleanGroupName = String(groupName || "").trim();
  const cleanCreatorName = String(creatorName || "").trim();
  const cleanContact = String(contact || "").trim();
  const cleanPassword = String(password || "").trim();
  if (!cleanGroupName || !cleanCreatorName || !cleanContact || !cleanPassword) {
    return res.status(400).json({ error: "invalid_params" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existingMeta = await getRow(`quiniela:${cleanSlug}:meta`, client);
    const idx = (await getRowLocked("platform_index", client)) || { quinielas: [] };
    if (!Array.isArray(idx.quinielas)) idx.quinielas = [];
    const slugTaken = !!existingMeta || idx.quinielas.some((q) => q.slug === cleanSlug);
    if (slugTaken) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "slug_taken" });
    }

    const creatorId = "p_" + crypto.randomBytes(9).toString("hex");
    const meta = {
      groupName: cleanGroupName,
      participants: [{ id: creatorId, name: cleanCreatorName, isAdmin: true, paid: false, pin: null }],
      rounds: [],
      settings: {
        ownerPassword: hashPassword(cleanPassword),
        entryFee: 0,
        sportsdbSeason: "2025-2026",
        pointsPerCorrectPick: 1
      }
    };
    // A plain INSERT (not upsert) so the database itself is the final word on
    // uniqueness: if another request created this exact slug a moment ago, this
    // throws instead of silently overwriting it.
    try {
      await client.query(
        `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())`,
        [`quiniela:${cleanSlug}:meta`, JSON.stringify(meta)]
      );
    } catch (insertErr) {
      if (insertErr.code === "23505") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "slug_taken" });
      }
      throw insertErr;
    }

    // Note: exempt is intentionally never settable here — only the platform
    // dashboard (with the platform password) can grant that.
    idx.quinielas.push({
      slug: cleanSlug, name: cleanGroupName, creatorName: cleanCreatorName,
      contact: cleanContact, createdAt: new Date().toISOString(),
      participantCount: 1, roundCount: 0
    });
    await putRow("platform_index", idx, client);

    await client.query("COMMIT");
    res.json({ ok: true, slug: cleanSlug });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("create-quiniela failed", err);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

// Moving a quiniela from the shared root link to its own /q/:slug — also one
// transaction, also never sends the password hash or anyone's PIN to the
// browser. Exempt:true here is fine (unlike create-quiniela): this is
// re-registering a quiniela the caller already proved they own, not letting
// the public grant themselves an exemption.
app.post("/api/migrate-quiniela", async (req, res) => {
  const { toSlug } = req.body || {};
  const fromKey = "quiniela_meta_v1";
  const cleanSlug = normalizeSlug(toSlug);
  if (!cleanSlug) return res.status(400).json({ error: "invalid_slug" });
  const providedOwnerAuth = req.get("x-qracks-auth") || "";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const meta = await getRow(fromKey, client);
    if (!meta) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    if (!(meta.settings && verifyPassword(providedOwnerAuth, meta.settings.ownerPassword))) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "unauthorized" });
    }

    const targetKey = `quiniela:${cleanSlug}:meta`;
    const existing = await getRow(targetKey, client);
    const idx = (await getRowLocked("platform_index", client)) || { quinielas: [] };
    if (!Array.isArray(idx.quinielas)) idx.quinielas = [];
    if (existing || idx.quinielas.some((q) => q.slug === cleanSlug)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "slug_taken" });
    }

    await putRow(targetKey, meta, client);

    for (const p of (meta.participants || [])) {
      const oldPicksKey = `quiniela_picks_${p.id}_v1`;
      const picks = await getRow(oldPicksKey, client);
      if (picks) await putRow(`quiniela:${cleanSlug}:picks:${p.id}`, picks, client);
    }

    const creator = (meta.participants || []).find((p) => p.isAdmin) || (meta.participants || [])[0] || {};
    idx.quinielas.push({
      slug: cleanSlug, name: meta.groupName, creatorName: creator.name || "",
      createdAt: new Date().toISOString(), exempt: true,
      participantCount: (meta.participants || []).length, roundCount: (meta.rounds || []).length
    });
    await putRow("platform_index", idx, client);

    await putRow(fromKey, { migratedTo: cleanSlug }, client);

    await client.query("COMMIT");
    res.json({ ok: true, slug: cleanSlug });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("migrate-quiniela failed", err);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

// Deleting a quiniela — its meta, every participant's picks, and its
// platform_index entry — is one transaction: validate the platform password
// first, then either all of it goes away or (on any failure) none of it does.
app.post("/api/delete-quiniela", async (req, res) => {
  const { slug } = req.body || {};
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) return res.status(400).json({ error: "invalid_slug" });
  const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
  const platformHash = await getPlatformHash();
  if (!verifyPassword(providedPlatformAuth, platformHash)) {
    return res.status(403).json({ error: "unauthorized" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const metaKey = `quiniela:${cleanSlug}:meta`;

    // Prefix delete — catches picks belonging to participants who may have
    // since been removed from metadata, not just the ones currently listed.
    await client.query("DELETE FROM kv WHERE key LIKE $1", [`quiniela:${cleanSlug}:picks:%`]);
    await client.query("DELETE FROM kv WHERE key = $1", [metaKey]);

    const idx = await getRowLocked("platform_index", client);
    if (idx && Array.isArray(idx.quinielas)) {
      idx.quinielas = idx.quinielas.filter((q) => q.slug !== cleanSlug);
      await putRow("platform_index", idx, client);
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("delete-quiniela failed", err);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

// Simple health check (also useful for uptime pingers to avoid free-tier sleep)
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- Growth Loop funnel events ----------
// Deliberately minimal: no dashboard, no aggregation — just a plain, appendable
// log meant to be queried directly in Postgres when someone wants to look.
const KNOWN_EVENTS = new Set([
  "access_link_opened",
  "join_started",
  "join_completed",
  "session_restored",
  "session_confirmation_accepted",
  "session_confirmation_rejected"
]);
app.post("/api/track-event", rateLimit("track-event"), async (req, res) => {
  try {
    const { event, competitionSlug, participantId, isNewUser, deviceId, source } = req.body || {};
    if (!KNOWN_EVENTS.has(event)) return res.status(400).json({ error: "unknown_event" });
    await pool.query(
      `INSERT INTO analytics_events (event_name, competition_slug, participant_id, is_new_user, device_id, source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event,
        competitionSlug ? String(competitionSlug).slice(0, 80) : null,
        participantId ? String(participantId).slice(0, 80) : null,
        typeof isNewUser === "boolean" ? isNewUser : null,
        deviceId ? String(deviceId).slice(0, 80) : null,
        source ? String(source).slice(0, 40) : null
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("track-event failed", err);
    // Analytics failures should never surface to the user or block anything.
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- Dynamic link previews for /q/:slug ----------
const INDEX_HTML_PATH = path.join(__dirname, "public", "index.html");
let indexHtmlCache = null;
function getIndexHtml() {
  if (!indexHtmlCache) indexHtmlCache = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  return indexHtmlCache;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function injectMeta(html, { title, description, url }) {
  let out = html;
  if (title != null) {
    out = out.replace(/(<title id="page-title">)[^<]*(<\/title>)/, `$1${title}$2`);
    out = out.replace(/(<meta property="og:title" content=")[^"]*("\s+id="og-title">)/, `$1${title}$2`);
  }
  if (description != null) {
    out = out.replace(/(<meta property="og:description" content=")[^"]*("\s+id="og-description">)/, `$1${description}$2`);
  }
  if (url != null) {
    out = out.replace(/(<meta property="og:url" content=")[^"]*("\s+id="og-url">)/, `$1${url}$2`);
  }
  return out;
}

app.get("/q/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    const value = await getRow("quiniela:" + slug + ":meta");
    let html = getIndexHtml();
    if (value && value.groupName) {
      const name = escapeHtml(value.groupName);
      html = injectMeta(html, {
        title: `${name} · QRACKS`,
        description: `Vota tus pronósticos, checa la tabla de posiciones y no te quedes fuera de ${name}.`,
        url: `https://qracks.net/q/${encodeURIComponent(slug)}`
      });
    }
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("Error building link preview for /q/:slug", err);
    res.sendFile(INDEX_HTML_PATH);
  }
});

// Static frontend
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;

async function start(retriesLeft){
  try{
    await ensureTable();
    app.listen(PORT, () => console.log("Quiniela server listening on port " + PORT));
  }catch(err){
    console.error("Database not ready yet:", err.message);
    if(retriesLeft > 0){
      console.log("Retrying in 3s... (" + retriesLeft + " attempts left)");
      setTimeout(() => start(retriesLeft - 1), 3000);
    }else{
      console.error("Giving up waiting for the database. Check DATABASE_URL.");
      process.exit(1);
    }
  }
}
start(5);
