// Quiniela / QRACKS — backend
// Serves the static frontend and a small key-value API backed by Postgres, plus a
// handful of narrow endpoints for things that need real server-side rules
// (authentication, PIN/password hashing, pick deadlines, safe creation/migration).

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");
const sportsDataProvider = require("./sportsDataProvider");
const { ProviderError } = require("./providers/theSportsDbAdapter");
const { nextSportsDataHealth, DEFAULT_SPORTS_DATA_HEALTH } = require("./sportsDataHealth");
const {
  DEFAULT_COMMERCIAL_CONFIG, isCommercialConfigValid, computeCompetitionIdentity,
  evaluateCompetitionBinding,
  buildFreeEntitlement, buildGrandfatheredEntitlement,
  buildPlusEntitlement, buildManualGrantEntitlement,
  checkParticipantCapacity, checkLifecycleRoundConsumption,
  summarizePlan, buildUpgradeOffer, isValidManualGrantLimits,
  entitlementScopeId,
} = require("./planLimits");
const {
  readStoredVersion, readExpectedVersion, isFreshWrite, stampVersion, mergePlatformIndex,
  applyEntitlementGrant, applyQuinielaSettings,
} = require("./platformState");
const {
  readParticipantsRevision, readParticipantRev, mergeParticipants, stampMetaRevisions,
} = require("./metaParticipants");
const tournamentScope = require("./tournamentScope");
const { planCompetitionSync } = require("./competitionSync");
const { currentDefaultSeason } = require("./seasonDefaults");
const { isRoundEligibleForAutoResults } = require("./autoResults");

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
// Every /api/* response is dynamic and often filtered per requester (draft
// results, open-round picks, platform-only fields) — never safe to cache,
// so this is explicit rather than left to whatever a browser/proxy defaults to.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

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
  // AUTO-004: Sports Data health singleton — a real row from the start
  // (never absent) so the platform endpoint never has to special-case "no
  // row yet" vs. "row exists but nothing recorded" as two different shapes.
  // lastOutcome:null is what the frontend reads as UNKNOWN — never invented
  // as OK just because the row exists.
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ('sports_data_health', $1::jsonb, now())
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify({
      lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null,
      lastOutcome: null, lastReliabilityState: null, lastOperation: null,
      provider: null, statusCode: null,
    })]
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
  // No query filters by this yet (today it's just SELECT * for a manual look),
  // but once one does — e.g. a single quiniela's own funnel — this is what
  // keeps that from becoming a full table scan as the table grows.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_events_competition_slug
    ON analytics_events (competition_slug);
  `);
  // Sprint 14.4 — el nuevo endpoint de lectura (/api/platform-analytics)
  // agrupa por event_name y filtra por created_at en 3 ventanas (7d/30d/total)
  // en una sola consulta. Sin este índice compuesto, eso escanea la tabla
  // completa cada vez que alguien abre /panel-plataforma.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_analytics_events_event_name_created
    ON analytics_events (event_name, created_at);
  `);

  // MON-001B: commercial_config — the dynamic, server-side SSOT for
  // pricing/limits. Seeded once from the code-level defaults; every read
  // after this happens against this row, never against the constants in
  // planLimits.js directly, so Panel Plataforma editing this row is a
  // real, immediate, no-deploy change everywhere that reads it.
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ('commercial_config', $1::jsonb, now())
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_COMMERCIAL_CONFIG)]
  );

  // MON-001B: grandfathering migration. Idempotent, safe to run on every
  // boot (which it does — this whole function runs at startup): any
  // platform_index entry that doesn't yet have an `entitlement` gets one
  // stamped, explicitly marking it as pre-existing/grandfathered rather
  // than leaving it silently un-enforceable (MON-001A's mistake — missing
  // data must never mean "unlimited" as an accident of absence). A
  // pre-existing `exempt:true` flag is preserved as the REASON for the
  // grandfathered entitlement (still auditable — visible in the
  // entitlement itself, not lost), rather than continuing to be its own
  // separate silent bypass mechanism going forward. This makes "missing
  // entitlement" structurally impossible by the time any request can be
  // handled, which is what lets enforcement fail CLOSED (see
  // planLimits.js) without being able to break a real, already-existing
  // quiniela that simply hasn't been touched by this migration in a
  // given deploy cycle — it always has by the time this function returns.
  const idxRow = await pool.query("SELECT value FROM kv WHERE key = 'platform_index'");
  const idx = idxRow.rows[0] ? idxRow.rows[0].value : { quinielas: [] };
  let migrated = false;
  (idx.quinielas || []).forEach((entry) => {
    if (!entry.entitlement) {
      entry.entitlement = buildGrandfatheredEntitlement(new Date().toISOString(), {
        reason: entry.exempt
          ? "Migrated from legacy exempt:true flag."
          : "Existed before commercial enforcement shipped — preserved as-is.",
      });
      entry.entitlementHistory = [{ action: "grant", entitlement: entry.entitlement, at: entry.entitlement.grantedAt }];
      entry.lifecycleRoundsConsumed = 0;
      entry.lifecycleConsumedRoundIds = [];
      migrated = true;
    }

    // MON-002C: give every existing quiniela its FIRST tournament cycle.
    //
    // Conservative by construction, which is what a migration touching money
    // has to be. Whatever a quiniela is playing right now becomes cycle 1, so:
    //
    //   - a Plus already bought keeps covering exactly what it was covering,
    //     because that IS cycle 1 — no right is lost;
    //   - and it covers nothing else, because a second edition would be a
    //     cycle this purchase is not stamped for — no right is invented;
    //   - every round already published is attributed to cycle 1, so the
    //     budget picture does not change and old rounds can never spend a
    //     later cycle's allowance.
    //
    // Idempotent: an entry that already has a scope is left completely alone,
    // so running this on every boot converges after the first one.
    if (!entry.tournamentScope || !tournamentScope.isUsableScopeId(entry.tournamentScope.id)) {
      const boundIdentity = entry.entitlement && entry.entitlement.competitionIdentity;
      // The league id is the first half of the legacy "leagueId:season"
      // identity. It is read only to LABEL the cycle; the id itself comes
      // from the scope builder, never from the provider string.
      const legacyLeagueId = typeof boundIdentity === "string" && boundIdentity.includes(":")
        ? boundIdentity.split(":")[0] : null;
      const legacySeason = typeof boundIdentity === "string" && boundIdentity.includes(":")
        ? boundIdentity.slice(boundIdentity.indexOf(":") + 1) : null;
      entry.tournamentScope = tournamentScope.buildInitialScope({
        sportKey: "football",
        provider: legacyLeagueId ? "thesportsdb" : null,
        competitionId: legacyLeagueId,
        providerSeasonId: legacySeason,
        startedAt: entry.createdAt || new Date().toISOString(),
      });
      // A cycle we did not start and cannot ask a provider about is exactly
      // the case UNKNOWN exists for. It is never ENDED by assumption.
      entry.tournamentScope.lifecycle = tournamentScope.LIFECYCLE.UNKNOWN;
      entry.scopeHistory = Array.isArray(entry.scopeHistory) ? entry.scopeHistory : [];
      migrated = true;
    }

    const scopeId = entry.tournamentScope.id;
    // Everything published so far belongs to cycle 1.
    if (!entry.consumedRoundIdsByScope || typeof entry.consumedRoundIdsByScope !== "object" || Array.isArray(entry.consumedRoundIdsByScope)) {
      entry.consumedRoundIdsByScope = {
        [scopeId]: Array.isArray(entry.lifecycleConsumedRoundIds) ? entry.lifecycleConsumedRoundIds.map(String) : [],
      };
      migrated = true;
    }
    // Stamp the cycle onto the entitlement and onto every purchase in the
    // history, so "which tournament was this bought for" stops depending on
    // the un-stamped fallback.
    if (entry.entitlement && !entitlementScopeId(entry.entitlement)) {
      entry.entitlement.scopeId = scopeId;
      migrated = true;
    }
    (Array.isArray(entry.entitlementHistory) ? entry.entitlementHistory : []).forEach((h) => {
      if (h && h.entitlement && !entitlementScopeId(h.entitlement)) {
        h.entitlement.scopeId = scopeId;
        migrated = true;
      }
    });
  });
  if (migrated) {
    await pool.query(
      "UPDATE kv SET value = $1::jsonb, updated_at = now() WHERE key = 'platform_index'",
      [JSON.stringify(idx)]
    );
    console.error(`MON-001B/MON-002C migration: ${idx.quinielas.length} platform_index entries now carry an entitlement and a tournament cycle`);
  }
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
const PLATFORM_KEYS = new Set(["platform_settings", "platform_index", "platform_payment_log", "commercial_config"]);

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
function stripQuinielaSecrets(value, isAdminOrOwner, selfParticipantId) {
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
      // A temporada-scope custom bet answer is a prediction, same spirit as a
      // match pick — it shouldn't be readable by the rest of the group before
      // it's graded, only by the person who wrote it (or an admin/owner, who
      // needs to see it to grade it). `.correct` always stays, though — every
      // participant's standings total depends on knowing whether everyone
      // else's answer was right, not on seeing what they guessed.
      if (!isAdminOrOwner && p.id !== selfParticipantId && p.customBetAnswers) {
        const masked = {};
        Object.keys(p.customBetAnswers).forEach((betId) => {
          const ans = p.customBetAnswers[betId] || {};
          masked[betId] = { correct: ans.correct === true ? true : (ans.correct === false ? false : null) };
        });
        p.customBetAnswers = masked;
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
    // AUTO-001 HOTFIX (BUG 2): defense in depth — the frontend's own
    // visibleRounds() already hides published:false rounds from
    // participants, but that's UI, not a real barrier. A non-admin/owner
    // must never even RECEIVE an unpublished round's data over the wire in
    // the first place. published === undefined (legacy rounds) stays
    // visible, same as always.
    clone.rounds = clone.rounds.filter((r) => r.published !== false);
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
// Which participant (if any) is this request authenticated as, by their own
// PIN or session — needed so stripQuinielaSecrets can still show someone
// their own custom bet guesses while hiding everyone else's.
function requestSelfParticipantId(req, slug, value) {
  if (!value || !Array.isArray(value.participants)) return null;
  const found = value.participants.find((p) => isAuthenticatedAsParticipantReq(req, slug, p));
  return found ? found.id : null;
}
// MON-002B: a whitelist, not a blacklist. This used to return the whole row
// minus the password, to anybody, with no authentication — which meant
// depositInfo went out too: the platform's own bank, CLABE and account
// holder, readable by anyone who asked, with the slugs to ask about
// available from the public platform_index projection right next door.
// Nothing in platform_settings is public any more, so the public shape is
// empty and stays empty as fields are added; the dashboard reads the real
// row with the platform password, as it should always have.
function stripPlatformSecrets(value, isPlatformAuthed) {
  if (!isPlatformAuthed) return {};
  const clone = JSON.parse(JSON.stringify(value));
  // The password hash never leaves the server, authenticated or not.
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

// { participantId: rev } — small enough to hand back on every write (a
// quiniela tops out at 50 people) and it saves the browser a refetch.
function participantRevMap(doc) {
  const out = {};
  (Array.isArray(doc && doc.participants) ? doc.participants : []).forEach((p) => {
    if (p && p.id != null) out[p.id] = readParticipantRev(p);
  });
  return out;
}

// MON-002C. Names that mean something specific in platform_index, and
// nothing at all here.
//
// A quiniela's meta document is owner-writable by design, so a determined
// owner can store whatever they like in it. What they must not be able to do
// is store a decoy: a key called `tournamentScope` sitting in meta is inert
// today (every commercial decision reads the locked platform_index row, and
// the probe proves an owner writing one cannot move their cycle), but it is
// exactly the kind of thing a future reader mistakes for the authority. So
// the names are refused at the door rather than left lying around looking
// official. This is hygiene, not enforcement — enforcement is that these
// fields are never read from here in the first place.
const META_RESERVED_COMMERCIAL_FIELDS = Object.freeze([
  "tournamentScope", "scopeHistory", "consumedRoundIdsByScope",
  "entitlement", "entitlementHistory",
  "lifecycleConsumedRoundIds", "lifecycleRoundsConsumed",
]);

function mergeProtectedMetaFields(oldValue, newValue, authTier) {
  const merged = JSON.parse(JSON.stringify(newValue));
  META_RESERVED_COMMERCIAL_FIELDS.forEach((f) => { delete merged[f]; });
  const oldSettings = (oldValue && oldValue.settings) || null;
  if (!merged.settings) merged.settings = {};

  const canChangeOwnerFields = authTier === "owner" || authTier === "platform" ||
    (authTier === "admin-pin" && !(oldSettings && oldSettings.ownerPassword));
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

  // MON-002B: the participant LIST no longer comes from the request as-is.
  // mergeParticipants() decides membership against the row that is actually
  // stored (read under lock by the caller), so a writer working from a stale
  // snapshot can no longer delete someone who registered in the meantime —
  // see metaParticipants.js for the reproduction. Per-participant field
  // protection below is unchanged and still applies to whatever survives
  // that merge.
  const participantMerge = mergeParticipants(oldValue, merged);
  merged.participants = participantMerge.participants;

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
      // customBetAnswers: whoever is saving may only have had a masked view of
      // OTHER participants' guesses (correct-only, no guess text) — restore
      // whatever the client couldn't have faithfully echoed back, exactly like
      // pin/ownerPassword above. Only .guess is ever masked, never .correct,
      // so only .guess needs restoring here.
      if (old && old.customBetAnswers) {
        if (!("customBetAnswers" in p)) {
          p.customBetAnswers = old.customBetAnswers;
        } else if (p.customBetAnswers) {
          Object.keys(p.customBetAnswers).forEach((betId) => {
            const newAns = p.customBetAnswers[betId];
            const oldAns = old.customBetAnswers[betId];
            if (newAns && oldAns && !("guess" in newAns) && "guess" in oldAns) {
              newAns.guess = oldAns.guess;
            }
          });
        }
      }
    });
  }
  // Returns the value to store PLUS what the merge had to do, so the caller
  // can tell the Admin their tab was behind instead of quietly disagreeing
  // with them. The stored revision is computed from the merge result, never
  // taken from the request — the incoming one was only ever a claim about
  // what the writer had seen. Nothing about the merge itself is persisted.
  return {
    value: stampMetaRevisions(merged, oldValue),
    participantsRestored: participantMerge.restored,
    participantsRefreshed: participantMerge.refreshed,
  };
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

// Who is asking — computed ONCE per request. Figuring this out involves
// comparing a PIN against scrypt hashes, which is deliberately slow (that's
// what makes brute-forcing a PIN impractical) — fine to pay once per request,
// very much not fine to pay once per participant being filtered in a batch
// (that's what made picks-batch scale linearly with participant count instead
// of being flat).
function computeRequesterIdentity(req, slug, meta) {
  // Cheapest path: a valid session cookie already names the exact participant
  // — no password comparison needed at all.
  const session = readSessionFromCookie(req, slug);
  if (session) {
    const p = (meta.participants || []).find((x) => x.id === session.participantId);
    if (p && session.pinFp === pinFingerprint(p.pin)) {
      return { isAdminOrOwner: !!p.isAdmin, selfParticipantIds: new Set([p.id]) };
    }
  }
  const providedAuth = req.get("x-qracks-auth") || "";
  let isAdminOrOwner = !!(meta.settings && verifyPassword(providedAuth, meta.settings.ownerPassword));
  // One pass over every participant, not one pass per participant being
  // filtered. Two different participants could coincidentally share the same
  // 4-digit PIN, so every match is recorded — not just the first one found —
  // to match the exact semantics the old per-participant checks had.
  const selfParticipantIds = new Set();
  (meta.participants || []).forEach((p) => {
    if (p.pin && verifyPassword(providedAuth, p.pin)) {
      selfParticipantIds.add(p.id);
      if (p.isAdmin) isAdminOrOwner = true;
    }
  });
  return { isAdminOrOwner, selfParticipantIds };
}

async function filterPicksForRequest(req, info, picksValue, preloadedMeta, requesterIdentity) {
  const meta = preloadedMeta || await getRow(info.metaKey);
  if (!meta) return picksValue;
  const identity = requesterIdentity || computeRequesterIdentity(req, info.slug, meta);
  const { isAdminOrOwner, selfParticipantIds } = identity;

  if (selfParticipantIds.has(info.participantId)) return picksValue; // only the participant sees their own open-round answers

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
async function validatePicksDeadline(info, oldValue, newValue, preloadedMeta, nowMs) {
  const meta = preloadedMeta !== undefined ? preloadedMeta : await getRow(info.metaKey);
  if (!meta) return { ok: true };
  const roundsById = {};
  (meta.rounds || []).forEach((r) => { roundsById[r.id] = r; });
  const old = oldValue || {};
  const fresh = newValue || {};
  const now = nowMs != null ? nowMs : Date.now();
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
    // AUTO-001 HOTFIX (BUG 2): real protection at the actual mutation point,
    // not just hiding the round from the UI — a round nobody could see yet
    // must not be able to receive picks at all, regardless of its deadline.
    // published === undefined (legacy rounds) is unaffected, same as always.
    if (round.published === false) {
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
function validateRoundsIntegrity(newValue, oldValue, nowMs) {
  if (!Array.isArray(newValue.rounds)) return { ok: true };
  const now = nowMs != null ? nowMs : Date.now();
  const oldRoundsById = {};
  if (oldValue && Array.isArray(oldValue.rounds)) {
    for (const r of oldValue.rounds) oldRoundsById[r.id] = r;
  }
  for (const round of newValue.rounds) {
    if (!round.resultsPublished) continue;
    // AUTO-001 HOTFIX (validation round, BUG 5 gap found via real end-to-end
    // testing): the "can't publish results for an unpublished round" guard
    // previously only lived in the frontend click handler — a direct API
    // call bypassing the UI could still set resultsPublished:true on a
    // published:false round. This is the real, server-side mutation point;
    // this check is what actually enforces it, same principle already
    // applied to picks writes in validatePicksDeadline().
    if (round.published === false) {
      return { ok: false, reason: "unpublished_round_results", roundNumber: round.number };
    }
    // AUTO-001.1 Admin lifecycle fix (FIX 2) — BLOCKING: official results
    // can only be published the FIRST time once the round is actually
    // closed (deadline passed). Without this, PUBLISHED/OPEN could jump
    // straight to RESULTS PUBLISHED, skipping CLOSED entirely — a real
    // integrity problem, not just a UI nicety, so it's enforced here, the
    // real mutation point, not only in the button's disabled state.
    // Corrections of an ALREADY-published round are explicitly exempt —
    // legacy/historical deadlines that look "future" due to old data must
    // never block a legitimate correction of results already live.
    const oldRound = oldRoundsById[round.id];
    const wasAlreadyPublished = !!(oldRound && oldRound.resultsPublished);
    if (!wasAlreadyPublished) {
      const deadlineMs = new Date(round.deadline).getTime();
      if (Number.isFinite(deadlineMs) && now <= deadlineMs) {
        return { ok: false, reason: "round_not_closed", roundNumber: round.number };
      }
    }
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
      const selfParticipantId = isAdminOrOwner ? null : requestSelfParticipantId(req, info.slug, value);
      value = stripQuinielaSecrets(value, isAdminOrOwner, selfParticipantId);
    } else if (info.kind === "platform") {
      if (req.params.key === "platform_settings") {
        const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
        const platformHash = await getPlatformHash();
        value = stripPlatformSecrets(value, verifyPassword(providedPlatformAuth, platformHash));
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

    // The whole reason this used to be slow: this used to be recomputed
    // (with several scrypt comparisons) inside the loop below, once per
    // participant. Same requester for the whole request, so it only needs
    // to be figured out once.
    const requesterIdentity = computeRequesterIdentity(req, slug, meta);

    for (const pid of requestedIds) {
      const key = slug ? `quiniela:${slug}:picks:${pid}` : `quiniela_picks_${pid}_v1`;
      const raw = rowByKey[key];
      if (raw == null) { picks[pid] = {}; continue; }
      // slug/pid/metaKey are already known here — building info directly skips
      // re-parsing the key we just built with classifyKey's regex, N times.
      const info = { kind: "picks", metaKey, participantId: pid, slug: slug || undefined };
      picks[pid] = await filterPicksForRequest(req, info, raw, meta, requesterIdentity);
    }
    res.json({ ok: true, picks });
  } catch (err) {
    console.error("picks-batch failed", err);
    res.status(500).json({ error: "server_error" });
  }
});

// A season-long custom bet answer ("¿quién será el goleador?") is the
// participant's own guess, same spirit as a match pick — but it lives inside
// meta.participants[].customBetAnswers, and the generic meta write endpoint
// only ever accepted admin/owner credentials. That silently meant a regular
// participant could never actually save their own answer. This is the narrow,
// participant-authenticated write path picks already had, extended to cover
// this one field too — nothing else in meta is touched or even readable here.
app.post("/api/submit-bet-answer", async (req, res) => {
  try {
    const { metaKey, participantId, betId, guess } = req.body || {};
    if (!metaKey || !participantId || !betId || typeof guess !== "string" || !guess.trim()) {
      return res.status(400).json({ error: "invalid_params" });
    }
    const cleanGuess = guess.trim().slice(0, 200);
    let slug = null;
    if (metaKey !== "quiniela_meta_v1") {
      const m = metaKey.match(/^quiniela:([a-z0-9-]{1,60}):meta$/);
      if (!m) return res.status(400).json({ error: "invalid_metaKey" });
      slug = m[1];
    }
    // MON-001F: this used to read the meta unlocked, mutate it, and write the
    // WHOLE document back. Because it writes the whole document, it could
    // revert ANY concurrent change to that quiniela — published results, a new
    // round, a participant — including changes made by the routes that do take
    // the lock, which made their locking incomplete. Same transaction + lock
    // protocol as the picks branch of /api/kv now: everything below reads from
    // the state observed AFTER the lock.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await getRowLocked(metaKey, client);
      if (!value) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "not_found" });
      }
      const participant = (value.participants || []).find((p) => p.id === participantId);
      if (!participant) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "participant_not_found" });
      }
      if (!isAuthenticatedAsParticipantReq(req, slug, participant)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "unauthorized" });
      }
      const bet = (value.customBets || []).find((b) => b.id === betId && b.scope === "temporada");
      if (!bet) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "bet_not_found" });
      }
      // Same lock rule the UI already shows (bet closes when its linked round's
      // deadline passes) — enforced here too, not just hidden in the frontend.
      if (bet.closesAtRound) {
        const closingRound = (value.rounds || []).find((r) => r.number === bet.closesAtRound);
        if (closingRound && Date.now() > new Date(closingRound.deadline).getTime()) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "bet_locked" });
        }
      }
      // Same reason as set-pin: this changes one participant's fields, so it
      // has to advance that participant's revision.
      const beforeAnswer = JSON.parse(JSON.stringify(value));
      if (!participant.customBetAnswers) participant.customBetAnswers = {};
      const prevCorrect = participant.customBetAnswers[betId] ? participant.customBetAnswers[betId].correct : null;
      participant.customBetAnswers[betId] = { guess: cleanGuess, correct: prevCorrect };
      const storedAfterAnswer = stampMetaRevisions(value, beforeAnswer);
      await putRow(metaKey, storedAfterAnswer, client);
      await client.query("COMMIT");
      res.json({ ok: true, participantRevs: participantRevMap(storedAfterAnswer) });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("submit-bet-answer failed", err);
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
      // All four platform-level keys validate against the SAME current
      // password (platform_settings' own hash, or the bootstrap env var if
      // that doesn't exist yet) — never against a per-key field, so
      // changing the password once in the dashboard immediately applies
      // everywhere, consistently.
      const platformHash = await getPlatformHash();
      if (!verifyPassword(providedPlatformAuth, platformHash)) {
        return res.status(403).json({ error: "unauthorized" });
      }
      // Every platform row is a JSON OBJECT. Enforced explicitly because the
      // version stamp below spreads the value: handed an array or a
      // primitive it would silently produce a differently-shaped row
      // ({"0":…,"1":…}) instead of refusing malformed input.
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return res.status(400).json({ error: "invalid_value" });
      }
      if (req.params.key === "commercial_config") {
        // MON-001B: this write becomes the new live SSOT for every future
        // enforcement decision and every UX surface that shows pricing/
        // limits — reject anything that violates the basic invariants
        // (free <= plus, all limits >= 1, price >= 0) BEFORE it's ever
        // persisted, since a corrupt row here would corrupt every
        // enforcement decision made against it afterward.
        if (!isCommercialConfigValid(value)) {
          return res.status(400).json({ error: "invalid_commercial_config" });
        }
      }
      // MON-001F: a version that is PRESENT but not a safe non-negative
      // integer ("3", 1.5, NaN, -1) is rejected outright rather than being
      // coerced or ignored — silently treating it as "no expectation" would
      // be a way to opt out of the freshness check by sending garbage.
      const expectedVersion = readExpectedVersion(value);
      if (!expectedVersion.ok) {
        return res.status(400).json({ error: "invalid_version" });
      }

      // MON-001F: platform state used to be written as a BLIND full-document
      // overwrite from an unlocked read — the lost-update this fix exists to
      // close. Now every platform write is one transaction that locks the row
      // first, checks the client is writing from the version it actually read,
      // and only then persists. Exactly ONE row is locked here, so this path
      // cannot participate in a lock-order cycle with the two-row transactions
      // elsewhere (platform_index then meta).
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await getRowLocked(req.params.key, client);
        const storedVersion = readStoredVersion(current);
        if (!isFreshWrite(storedVersion, expectedVersion.expected)) {
          await client.query("ROLLBACK");
          // 409, never a silent overwrite: the caller reloads and retries on
          // top of the state that actually won.
          return res.status(409).json({ error: "stale_version", currentVersion: storedVersion });
        }

        if (req.params.key === "platform_settings") {
          // Protected fields are carried over from the LOCKED read, not from
          // an unlocked one — otherwise a concurrent password rotation could
          // be reverted by a settings save that simply didn't include it.
          finalValue = mergeProtectedPlatformFields(current, value);
        } else if (req.params.key === "commercial_config") {
          finalValue = { ...value, updatedAt: new Date().toISOString(), updatedBy: "platform" };
        } else if (req.params.key === "platform_index") {
          // Field-level merge onto the current row. Locking alone would only
          // serialize two blind overwrites; this is what actually preserves
          // the concurrent server-side changes (new quinielas, entitlements,
          // lifecycle budget) an admin's snapshot cannot know about.
          finalValue = mergePlatformIndex(current, value);
        }
        finalValue = stampVersion(finalValue, storedVersion);

        await putRow(req.params.key, finalValue, client);
        await client.query("COMMIT");
        return res.json({ key: req.params.key, ok: true, version: finalValue.version });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else if (info.kind === "quiniela-meta") {
      // MON-001B: converted from an unlocked read-then-write (MON-001A's
      // real bug — two concurrent requests could both read the same
      // stale counts and both pass a capacity check that should only
      // have let ONE of them through) into a self-contained transaction,
      // matching the exact pattern the "picks" branch below already
      // established (SEC-001). Lock ORDER is always platform_index
      // first, then this quiniela's own meta row, second — followed
      // consistently everywhere two rows need locking together (see
      // self-register below), specifically to avoid a deadlock between
      // two transactions that might otherwise lock the same two rows in
      // opposite orders.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const platformIdx = await getRowLocked("platform_index", client);
        const oldValue = await getRowLocked(info.metaKey, client);
        if (!oldValue) {
          await client.query("ROLLBACK");
          // Brand-new quinielas are only ever created through POST
          // /api/create-quiniela, which handles the meta + platform_index
          // registration together, atomically.
          return res.status(403).json({ error: "use_create_endpoint" });
        }
        const platformHash = await getPlatformHash();
        const authTier = resolveMetaAuthTier(oldValue, providedOwnerAuth, providedPlatformAuth, platformHash, req, info.slug);
        if (!authTier) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "unauthorized" });
        }
        const metaMerge = mergeProtectedMetaFields(oldValue, value, authTier);
        const mergedValue = metaMerge.value;
        const roundsCheck = validateRoundsIntegrity(mergedValue, oldValue);
        if (!roundsCheck.ok) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: roundsCheck.reason, roundNumber: roundsCheck.roundNumber });
        }

        // MON-001B: real, atomic, server-side enforcement of the actual
        // approved commercial model (see planLimits.js) — fixes both
        // MON-001's original P0 (no backend enforcement existed at all)
        // and MON-001A's own bugs (wrong numbers, a FREE_TRIAL that was
        // never approved, non-atomic checks, and fail-OPEN behavior on
        // unknown data). The entitlement is read fresh from
        // platform_index under lock here — never trusted from the
        // request body, which the quiniela owner controls.
        const entry = platformIdx && Array.isArray(platformIdx.quinielas)
          ? platformIdx.quinielas.find((q) => q.slug === info.slug)
          : null;
        if (info.slug) {
          // MON-001C fix #1: a real per-slug quiniela MUST have a
          // platform_index entry — created atomically alongside its meta
          // by POST /api/create-quiniela. If it's missing here, that's a
          // genuine data-integrity problem, not a legitimate state
          // (unlike the legacy single-tenant quiniela_meta_v1 key, which
          // has no slug at all and predates per-quiniela plans entirely —
          // see the `else` of this `if (info.slug)` for that case, which
          // intentionally skips entitlement enforcement). Silently
          // falling through to an unenforced write here — MON-001B's own
          // residual bug — would let a quiniela with a corrupted/missing
          // platform_index registration add unlimited rounds/participants.
          // Fail closed instead.
          if (!entry) {
            console.error("quiniela-meta write blocked: no platform_index entry found for a per-slug quiniela", { slug: info.slug });
            await client.query("ROLLBACK");
            return res.status(402).json({ error: "entitlement_unavailable" });
          }
          if (!entry.entitlement) {
            // Should be structurally impossible (ensureTable()'s
            // grandfathering migration runs at every boot), but if it
            // somehow still happens, fail CLOSED (deny new capacity)
            // rather than silently allowing it, and make it loud.
            console.error("quiniela-meta write blocked: no entitlement on platform_index entry", { slug: info.slug });
            await client.query("ROLLBACK");
            return res.status(402).json({ error: "entitlement_unavailable" });
          }

          // MON-001C FIX 4: league/season change policy. Selecting a
          // league for the FIRST time (previously unset) is always
          // allowed — that's the legitimate "sin liga -> con liga"
          // transition, and it adopts the tournament's identity from this
          // point on without refunding/resetting any manual lifecycle
          // already consumed. CHANGING an already-selected league/season
          // (or clearing it back to none) once the quiniela is already
          // operating within a commercial cycle — defined durably as
          // "has ever consumed manual lifecycle OR already has a
          // competitionIdentity on its entitlement" — is blocked for a
          // normal owner/admin edit, specifically to prevent
          // "Apertura -> change league -> Clausura -> change league ->
          // Premier" from extending a single quiniela/Plus purchase
          // across multiple real tournaments. A platform-authenticated
          // write (support/correction) is exempt from this restriction.
          const oldLeagueId = oldValue.settings && oldValue.settings.sportsdbLeagueId;
          const oldSeason = oldValue.settings && oldValue.settings.sportsdbSeason;
          const newLeagueId = mergedValue.settings && mergedValue.settings.sportsdbLeagueId;
          const newSeason = mergedValue.settings && mergedValue.settings.sportsdbSeason;
          const leagueOrSeasonChanged = (oldLeagueId || null) !== (newLeagueId || null) || (oldSeason || null) !== (newSeason || null);
          const wasAlreadyOperating = !!(entry.entitlement.competitionIdentity) ||
            (Number.isFinite(entry.lifecycleRoundsConsumed) && entry.lifecycleRoundsConsumed > 0);
          if (leagueOrSeasonChanged && oldLeagueId && wasAlreadyOperating && authTier !== "platform") {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: "league_change_blocked" });
          }
          // Selecting a league for the first time (oldLeagueId was empty)
          // adopts its identity right now, on the entitlement itself —
          // never left null just because the quiniela didn't have one at
          // creation time (that was MON-001C's other fix, for
          // create-quiniela's own path).
          if (newLeagueId && !entry.entitlement.competitionIdentity) {
            entry.entitlement.competitionIdentity = computeCompetitionIdentity(newLeagueId, mergedValue.settings.sportsdbSeason);
          }

          const commercialConfig = (await getRow("commercial_config", client)) || DEFAULT_COMMERCIAL_CONFIG;
          // MON-002C: which tournament cycle this quiniela is playing. Every
          // commercial decision below is made against it, so a plan bought
          // for a previous tournament cannot answer for this one.
          const currentScopeId = entry.tournamentScope && entry.tournamentScope.id;
          const oldParticipantCount = (oldValue.participants || []).length;
          const newParticipantCount = (mergedValue.participants || []).length;
          if (newParticipantCount > oldParticipantCount) {
            const check = checkParticipantCapacity(entry.entitlement, commercialConfig, oldParticipantCount, newParticipantCount - oldParticipantCount, { currentScopeId });
            if (!check.allowed) {
              await client.query("ROLLBACK");
              // MON-002B: the rejection carries everything the paywall needs
              // to render itself — what was hit, and what Plus would give
              // instead. Without it the browser would have to fetch the plan
              // separately, which is both a second round trip and a window in
              // which the two answers can disagree.
              return res.status(402).json({
                error: check.reason, limitType: "participants", plan: check.plan, limit: check.limit,
                upgrade: buildUpgradeOffer(entry.entitlement, commercialConfig),
              });
            }
          }
          // Durable lifecycle: count only round IDs that (a) are
          // published in this write AND (b) have never been counted
          // before, per platform_index's own persisted ID list — NOT
          // meta.rounds.length or a published-count comparison. Deleting
          // a round never removes its ID from this list, so it can never
          // return consumed lifecycle budget; re-publishing a
          // previously-unpublished round with the SAME id (there's no
          // "unpublish" action in the product today, but this is
          // correct regardless) is also never double-counted, since the
          // id simply stays in the list once added.
          // MON-002C: consumption is attributed PER CYCLE, and what exempts a
          // round is that the STORED row still holds it — not merely that its
          // id was spent once. See newlyConsumedIds() for why: an id-only rule
          // let a whole new calendar be published free under the previous
          // cycle's ids, which was reproduced against a live server.
          //
          // oldValue is the row read under lock a few lines above. Passing the
          // INCOMING document here instead would hand the decision to exactly
          // the party the rule exists to constrain.
          const publishedIds = (mergedValue.rounds || [])
            .filter((r) => r && r.published !== false)
            .map((r) => r.id);
          const storedRoundIds = (oldValue.rounds || []).map((r) => r && r.id);
          const newlyConsumedIds = tournamentScope.newlyConsumedIds(entry, publishedIds, {
            currentScopeId, existingRoundIds: storedRoundIds,
          });
          if (newlyConsumedIds.length > 0) {
            const currentConsumed = tournamentScope.consumedInScope(entry, currentScopeId);
            const check = checkLifecycleRoundConsumption(entry.entitlement, commercialConfig, currentConsumed, newlyConsumedIds.length, { currentScopeId });
            if (!check.allowed) {
              await client.query("ROLLBACK");
              return res.status(402).json({
                error: check.reason, limitType: "rounds", plan: check.plan, limit: check.limit,
                upgrade: buildUpgradeOffer(entry.entitlement, commercialConfig),
              });
            }
          }

          // All checks passed — persist the durable lifecycle counters
          // (and the existing display-only participantCount/roundCount
          // cache) in the SAME transaction as the meta write itself, so
          // they can never drift apart under concurrency.
          entry.consumedRoundIdsByScope = tournamentScope.recordConsumption(entry, currentScopeId, newlyConsumedIds);
          // Kept in step for anything still reading the flat pre-MON-002C
          // shape (and for a human reading the row): the durable list of every
          // round ever published, across every cycle.
          entry.lifecycleConsumedRoundIds = [...tournamentScope.allConsumedRoundIds(entry)];
          entry.lifecycleRoundsConsumed = tournamentScope.consumedInScope(entry, currentScopeId);
          entry.participantCount = newParticipantCount;
          entry.roundCount = (mergedValue.rounds || []).length;
          await putRow("platform_index", platformIdx, client);
        }
        // else: info.slug is undefined -- the legacy single-tenant
        // quiniela_meta_v1 key, which predates per-quiniela plans and
        // platform_index entirely. No entitlement concept applies to it,
        // consistent with grandfathering's own spirit -- there is nothing
        // to enforce here, by design, not by omission.

        await putRow(info.metaKey, mergedValue, client);
        await client.query("COMMIT");
        // participantsRevision goes back so the browser's copy stays current
        // and its NEXT write is judged fresh; participantsRestored tells it
        // that entries it did not know about were kept, which is its cue to
        // reload rather than keep editing a list it has already been shown to
        // be behind on.
        return res.json({
          key: req.params.key, ok: true,
          participantsRevision: readParticipantsRevision(mergedValue),
          participantsRestored: metaMerge.participantsRestored,
          // Fields this write claimed for people it had not seen the current
          // state of. The stored values won; saying so is what keeps this
          // from being a silent loss.
          participantsRefreshed: metaMerge.participantsRefreshed,
          // The revs this write produced, so the tab that made it stays
          // current for its OWN next save instead of being judged stale
          // against the very state it just created.
          participantRevs: participantRevMap(mergedValue),
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else if (info.kind === "picks") {
      // SEC-001 — Atomic Round Lock: previously, reading the meta (to check the
      // deadline) and writing the picks were two separate, unlocked operations,
      // with a real gap between them. In that gap, a concurrent request — a
      // second pick attempt, or an admin closing/editing the round — could
      // change what "the deadline" means, and this write would never notice.
      // Locking the meta row for the whole check-then-write, inside one
      // transaction, closes that gap: any other request touching the same
      // quiniela's meta has to wait its turn. Postgres's own clock is the time
      // source (not the Node process's), read from inside the same
      // transaction, so it can't be fooled by drift or a slow event loop.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const metaValue = await getRowLocked(info.metaKey, client);
        if (metaValue) {
          const participant = (metaValue.participants || []).find((p) => p.id === info.participantId);
          if (!isAuthenticatedAsParticipantReq(req, info.slug, participant)) {
            await client.query("ROLLBACK");
            return res.status(403).json({ error: participant && !participant.pin ? "pin_required" : "unauthorized" });
          }
        }
        const oldPicks = await getRowLocked(req.params.key, client);
        const nowRow = await client.query("SELECT NOW() as now");
        const dbNowMs = nowRow.rows[0].now.getTime();
        const deadlineCheck = await validatePicksDeadline(info, oldPicks, value, metaValue, dbNowMs);
        if (!deadlineCheck.ok) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "round_locked" });
        }
        await putRow(req.params.key, value, client);
        await client.query("COMMIT");
        return res.json({ key: req.params.key, ok: true });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // Unreachable by construction: classifyKey only yields platform /
    // quiniela-meta / picks / other, "other" was rejected at the top, and all
    // three remaining branches are now fully self-contained (own transaction,
    // own commit, own return) -- "platform" became so in MON-001F, which is
    // what removed the last unlocked blind write in this handler. Kept as an
    // explicit refusal so a future branch that forgets to return can never
    // silently fall through to an untransactional write again.
    console.error("kv POST reached the unreachable tail for key", req.params.key);
    return res.status(500).json({ error: "server_error" });
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
    if (verifyPassword(password, stored)) return res.json({ ok: true });
    // Recovery fallback — reachable ONLY when there is currently no owner
    // password set at all (never as a bypass while a real one exists, since
    // this whole branch is gated behind `!stored`). In that specific state,
    // the extra owner-password layer is already absent for this quiniela —
    // so falling back to the same admin-or-owner credential already
    // accepted for every other meta write (owner password OR an admin
    // participant's own PIN, see isRequestAdminOrOwner) isn't a new, weaker
    // permission — it's the same rule the rest of the backend already uses,
    // applied here too, so an admin isn't locked out of Ajustes after a
    // PIN-based credential rotation.
    if (!stored) {
      const providedAuth = req.get("x-qracks-auth") || "";
      const adminViaPin = (value.participants || []).some(
        (p) => p.isAdmin && p.pin && verifyPassword(providedAuth, p.pin)
      );
      if (adminViaPin) return res.json({ ok: true });
    }
    res.json({ ok: false });
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
    // MON-001F: same lock-bypass fix as submit-bet-answer — an unlocked
    // read-modify-write of the whole meta document could revert concurrent
    // changes to rounds, results, participants or settings. The current-PIN
    // check now also runs against the state observed AFTER the lock, so it
    // can't validate against a PIN that another request already replaced.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await getRowLocked(metaKey, client);
      if (!value) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "not_found" });
      }
      const participant = (value.participants || []).find((p) => p.id === participantId);
      if (!participant) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "participant_not_found" });
      }
      if (participant.pin && !verifyPassword(currentPin, participant.pin)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "wrong_current_pin" });
      }
      // MON-002B QA fix: the snapshot is taken BEFORE the change so the
      // revision stamp can see it. Without advancing this participant's rev,
      // an Admin tab loaded before the reset would still look fresh, and its
      // next ordinary save would write the OLD pin straight back over it.
      const beforePinChange = JSON.parse(JSON.stringify(value));
      participant.pin = hashPassword(newPin);
      const storedAfterPin = stampMetaRevisions(value, beforePinChange);
      await putRow(metaKey, storedAfterPin, client);
      await client.query("COMMIT");
      issueSessionCookie(res, slug, participant);
      res.json({ ok: true, participantRevs: participantRevMap(storedAfterPin) });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
  const client = await pool.connect();
  try {
    const { metaKey, name, pin, slug } = req.body || {};
    const cleanName = String(name || "").trim();
    if (!metaKey || !cleanName || !/^\d{4}$/.test(String(pin || ""))) {
      // MON-001C fix #2: removed the manual client.release() that used to
      // live here — this `return` is still inside the outer try block, so
      // the `finally` at the bottom of this handler ALREADY runs on this
      // path too. Releasing here AND in finally was a real double-release
      // bug (releasing an already-released pg client back to the pool
      // twice). ONE release strategy now: finally, exclusively, on every
      // path out of this function.
      return res.status(400).json({ error: "invalid_params" });
    }
    // MON-001B: converted from an unlocked read-then-write (the same real
    // race MON-001A left open: two people registering at the exact same
    // moment could both read "9 participants" and both get accepted,
    // landing at 11 on a 10-person plan) into a locked transaction — same
    // lock ORDER as the generic quiniela-meta write path above
    // (platform_index first, then this quiniela's own meta row), so the
    // two paths can never deadlock against each other.
    await client.query("BEGIN");
    const metaKeyMatch = String(metaKey).match(/^quiniela:([a-z0-9-]{1,60}):meta$/);
    const derivedSlug = metaKeyMatch ? metaKeyMatch[1] : null;
    const platformIdx = derivedSlug ? await getRowLocked("platform_index", client) : null;
    const value = await getRowLocked(metaKey, client);
    if (!value) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }
    if (!Array.isArray(value.participants)) value.participants = [];
    if (value.participants.some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "name_taken" });
    }
    // Slug is derived from metaKey itself (the same pattern classifyKey()
    // already uses) rather than trusted from the request body's separate
    // `slug` field, so this can never be pointed at a different
    // quiniela's entitlement than the one actually being written to.
    const entry = platformIdx && Array.isArray(platformIdx.quinielas)
      ? platformIdx.quinielas.find((q) => q.slug === derivedSlug)
      : null;
    if (derivedSlug) {
      // MON-001C fix #1: same residual bypass as the generic write path
      // above — a real per-slug quiniela (derivedSlug present) with no
      // matching platform_index entry is a genuine data-integrity
      // problem, not a legitimate state to silently skip enforcement for.
      // Only the legacy single-tenant key (derivedSlug null) intentionally
      // has no entitlement concept at all.
      if (!entry) {
        console.error("self-register blocked: no platform_index entry found for a per-slug quiniela", { slug: derivedSlug });
        await client.query("ROLLBACK");
        return res.status(402).json({ error: "entitlement_unavailable" });
      }
      if (!entry.entitlement) {
        console.error("self-register blocked: no entitlement on platform_index entry", { slug: derivedSlug });
        await client.query("ROLLBACK");
        return res.status(402).json({ error: "entitlement_unavailable" });
      }
      const commercialConfig = (await getRow("commercial_config", client)) || DEFAULT_COMMERCIAL_CONFIG;
      const check = checkParticipantCapacity(entry.entitlement, commercialConfig, value.participants.length, 1, {
        currentScopeId: entry.tournamentScope && entry.tournamentScope.id,
      });
      if (!check.allowed) {
        await client.query("ROLLBACK");
        // MON-002B: deliberately the BARE code, with no plan name, no limit
        // and no upgrade block. This endpoint answers a participant, and
        // whether the organizer should pay QRACKS is not a participant's
        // business — they are told the quiniela is full and to talk to the
        // organizer, which is all they can act on. Every other capacity
        // rejection in this file is Admin-facing and does carry the details.
        return res.status(402).json({ error: check.reason });
      }
    }
    const newParticipant = {
      id: "p_" + crypto.randomBytes(9).toString("hex"),
      name: cleanName, isAdmin: false, paid: false, pin: hashPassword(pin)
    };
    // MON-002B: this write CHANGES the membership, so it advances the
    // revision — which is precisely what later marks an Admin tab loaded
    // before this moment as stale, so that tab's next save keeps this person
    // instead of overwriting them away (see metaParticipants.js).
    const beforeRegistration = { participants: value.participants, participantsRevision: readParticipantsRevision(value) };
    value.participants = value.participants.concat([newParticipant]);
    if (entry) {
      entry.participantCount = value.participants.length;
      await putRow("platform_index", platformIdx, client);
    }
    const storedAfterRegistration = stampMetaRevisions(value, beforeRegistration);
    await putRow(metaKey, storedAfterRegistration, client);
    await client.query("COMMIT");
    // MON-001C fix #3: the session cookie's quiniela identity must be the
    // SERVER-DERIVED, validated derivedSlug — never the client-supplied
    // `slug` field from the request body. Before this fix, a request
    // could send metaKey pointing at quiniela A (whose capacity was
    // actually checked and whose participant was actually written) but a
    // DIFFERENT `slug` field for quiniela B, and the session cookie would
    // have been scoped to B — a real identity-confusion bug, not just a
    // theoretical one. derivedSlug is null only for the legacy
    // single-tenant key, where the cookie's own scoping has always been
    // slug-less by design; issueSessionCookie handles that null the same
    // way it always has.
    issueSessionCookie(res, derivedSlug, newParticipant);
    res.json({ ok: true, participant: { id: newParticipant.id, name: newParticipant.name, isAdmin: false, paid: false, hasPin: true } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

// ---------- the plan a quiniela is actually on (MON-002B) ----------
//
// The one place the Admin's own screens read their plan from. Before this
// endpoint existed there was NO way for an organizer to see what plan they
// were on, how much of it they had used, or what upgrading would give them —
// the entire commercial model was invisible until it rejected an action, and
// the only thing that had ever been visible was a legacy banner quoting a
// different threshold and a different price than the server enforced.
//
// Backend is the single source of truth here, deliberately: the response is
// shaped so the browser can render the plan line, the warnings and the
// paywall WITHOUT knowing what FREE means, what PLUS costs, or when a round
// budget applies. Duplicating any of that in the client is exactly how the
// two paywalls drifted apart in the first place.
//
// It replaces GET /api/payment-status/:slug, which is gone: that endpoint
// served the legacy "N jornadas gratis, then deposit $10 x participants"
// model, needed no authentication at all, and handed anyone who asked the
// platform's own bank details along with it.
app.get("/api/quinielas/:slug/plan", async (req, res) => {
  try {
    const slug = req.params.slug;
    const meta = await getRow(`quiniela:${slug}:meta`);
    if (!meta) return res.status(404).json({ error: "not_found" });

    // Admin/owner only. A participant has no business seeing what the
    // organizer pays QRACKS, and this is the response that carries the price.
    const { isAdminOrOwner } = computeRequesterIdentity(req, slug, meta);
    if (!isAdminOrOwner) return res.status(403).json({ error: "forbidden" });

    const idx = await getRow("platform_index");
    const entry = idx && Array.isArray(idx.quinielas)
      ? idx.quinielas.find((q) => q.slug === slug)
      : null;
    if (!entry || !entry.entitlement) {
      // Same fail-closed answer the write paths give, rather than inventing
      // a plan to fill the screen with.
      return res.status(200).json({ available: false, error: "entitlement_unavailable" });
    }

    const commercialConfig = (await getRow("commercial_config")) || DEFAULT_COMMERCIAL_CONFIG;
    const participantsUsed = Array.isArray(meta.participants) ? meta.participants.length : 0;
    // MON-002C: the budget shown is the one being enforced — what the CURRENT
    // tournament cycle has spent, not everything the quiniela has ever
    // published. A quiniela on its second tournament starts at zero even
    // though its history is full of rounds.
    const currentScope = entry.tournamentScope || null;
    const roundsUsed = currentScope
      ? tournamentScope.consumedInScope(entry, currentScope.id)
      : (Number.isFinite(entry.lifecycleRoundsConsumed) ? entry.lifecycleRoundsConsumed : 0);

    const summary = summarizePlan(entry.entitlement, commercialConfig, { participantsUsed, roundsUsed });
    // The league's display NAME lives in the browser's own picker list and is
    // not a commercial rule, so it is not duplicated here; what the server
    // does own — which tournament this quiniela is bound to — is returned as
    // the identity itself plus a label that reads correctly on its own.
    const season = meta.settings && meta.settings.sportsdbSeason;
    res.json({
      ...summary,
      competition: {
        ...summary.competition,
        leagueId: (meta.settings && meta.settings.sportsdbLeagueId) || null,
        season: season || null,
        label: summary.competition.bound && season ? `Temporada ${season}` : null,
      },
      // MON-002C. Deliberately carries NO scope id and no provider ids: the
      // screens need to say which tournament is being played and whether it
      // is over, and neither of those is an identifier. Keeping the id out of
      // the response also keeps it out of anything a browser could echo back.
      tournament: currentScope ? {
        cycle: currentScope.editionSeq,
        name: currentScope.displayName || null,
        state: tournamentScope.readLifecycle(currentScope),
        startedAt: currentScope.startedAt || null,
        endedAt: currentScope.endedAt || null,
        // Whether this quiniela has ever played an earlier tournament — what
        // tells the screen to say "tu Plus anterior no se transfiere" rather
        // than explaining cycles to somebody on their first one.
        previousCycles: Array.isArray(entry.scopeHistory) ? entry.scopeHistory.length : 0,
      } : null,
    });
  } catch (err) {
    console.error("plan read failed", err);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- starting the next tournament (MON-002C) ----------
//
// The one action that moves a quiniela from one tournament to the next, and
// the only thing in the product that creates a new commercial scope.
//
// It exists because no provider wired into this server can tell one edition
// from the next. TheSportsDB reports Liga MX Apertura 2026 and Clausura 2027
// under the same season string, and declares neither MULTI_INSTANCE_SEASONS
// nor FINISHED_SIGNAL — so the boundary between two tournaments is drawn by
// the person who knows it happened, not guessed from a calendar that came
// back short or a date that passed.
//
// What it does, and just as importantly what it does NOT do:
//
//   preserves   participants, their PINs and roles, every past round, every
//               result, the whole history, and the record of what was bought
//   creates     a new cycle with its own budget, starting on FREE
//   never       charges anything, transfers the previous Plus, deletes a
//               round, or touches the payment log
//
// Starting a new tournament is also the one piece of EVIDENCE we have that
// the previous one is over, so the cycle being left behind is marked ENDED
// with that as its stated reason — a fact somebody asserted, not an
// inference.
// Rate-limited like every other endpoint that opens a locked multi-row
// transaction. Each call also appends to scopeHistory, so an unthrottled loop
// would grow one JSONB row without bound — a slow way to hurt the whole
// platform from a single authenticated organizer account.
app.post("/api/quinielas/:slug/tournament/new-cycle", rateLimit("new-cycle"), async (req, res) => {
  const slug = req.params.slug;
  const metaKey = `quiniela:${slug}:meta`;
  const body = req.body || {};
  const displayName = typeof body.name === "string" && body.name.trim() !== ""
    ? body.name.trim().slice(0, 120) : null;

  // MON-002C QA-1: the freshness precondition. WITHOUT it, holding a lock only
  // serialises the two writers — it does not stop them both writing. Two tabs
  // both loaded on cycle 1 produced e1->e2 and then e2->e3, and five tabs
  // produced five cycles; a double click or a retry after a commit did the
  // same. Each of those transitions also resets the entitlement, so a Plus
  // bought in between could be destroyed by a stale second click.
  //
  // `expectedCycle` says WHICH cycle the Admin was looking at when they
  // pressed the button. It is a precondition and nothing else:
  //
  //   - it never chooses the next cycle (buildNextScope computes that from the
  //     STORED scope, so expectedCycle=99 can never produce e100);
  //   - it is compared INSIDE the transaction, after the lock, against the row
  //     that was just re-read — which is what makes the second writer see the
  //     first writer's commit;
  //   - a mismatch writes nothing at all and is recoverable: the screen
  //     refreshes and the Admin decides again.
  //
  // Required, not optional. A caller that may omit it is a caller that can
  // opt out of the guard, which is the bug rather than a fallback for it.
  //
  // It is VALIDATED further down, after authorisation — never here. Answering
  // "your body is malformed" to somebody who has not proven they may call this
  // endpoint at all tells them something about the request shape before they
  // have earned any answer but 403.
  const expectedCycle = body.expectedCycle;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Same lock order as every other multi-row transaction in this file:
    // platform_index first, then the quiniela's own meta row.
    const platformIdx = await getRowLocked("platform_index", client);
    const meta = await getRowLocked(metaKey, client);
    if (!meta) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }
    // The organizer's decision, not the platform's: they are the one who
    // knows their group is starting a new tournament.
    const { isAdminOrOwner } = computeRequesterIdentity(req, slug, meta);
    if (!isAdminOrOwner) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "forbidden" });
    }
    // Shape before freshness: a body that is not a whole positive number is not
    // a stale precondition, it is not a precondition at all. Nothing has been
    // written at this point, so this rollback leaves the row untouched.
    if (!Number.isSafeInteger(expectedCycle) || expectedCycle < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "invalid_expected_cycle" });
    }
    const entry = platformIdx && Array.isArray(platformIdx.quinielas)
      ? platformIdx.quinielas.find((q) => q.slug === slug)
      : null;
    if (!entry || !entry.entitlement || !entry.tournamentScope) {
      console.error("new-cycle blocked: incomplete platform_index entry", { slug });
      await client.query("ROLLBACK");
      return res.status(402).json({ error: "entitlement_unavailable" });
    }

    // The precondition, checked against the row read under lock a few lines
    // above. Everything before this point is a read; nothing has been written,
    // so a rollback here leaves the quiniela exactly as it was.
    const storedCycle = entry.tournamentScope.editionSeq;
    if (expectedCycle !== storedCycle) {
      await client.query("ROLLBACK");
      console.log("new-cycle refused: stale cycle", { slug, expectedCycle, storedCycle });
      // The current cycle travels back so the screen can say what actually
      // happened without another round trip. It is the same number /plan
      // already reports, so nothing new is exposed.
      return res.status(409).json({ error: "stale_tournament_cycle", currentCycle: storedCycle });
    }

    const now = new Date().toISOString();
    const previous = entry.tournamentScope;
    const ended = tournamentScope.endScope(previous, tournamentScope.ENDED_REASONS.ADMIN_STARTED_NEW_CYCLE, now);
    const next = tournamentScope.buildNextScope(previous, {
      sportKey: previous.sportKey,
      provider: previous.providerRefs && previous.providerRefs.provider,
      competitionId: previous.providerRefs && previous.providerRefs.competitionId,
      displayName,
      providerSeasonId: (meta.settings && meta.settings.sportsdbSeason) || null,
      startedAt: now,
    });
    if (!next) {
      await client.query("ROLLBACK");
      return res.status(500).json({ error: "server_error" });
    }

    // The previous cycle moves into the history WITH what it spent, so the
    // record of how much each tournament used survives intact.
    entry.scopeHistory = Array.isArray(entry.scopeHistory) ? entry.scopeHistory : [];
    entry.scopeHistory.push({
      scope: ended,
      roundsConsumed: tournamentScope.consumedInScope(entry, previous.id),
      entitlementAtEnd: entry.entitlement,
      closedAt: now,
    });
    entry.tournamentScope = next;
    // The new cycle starts empty. The OLD cycle's ids stay exactly where they
    // are, which is what keeps a re-published old round free and a new round
    // chargeable.
    entry.consumedRoundIdsByScope = tournamentScope.recordConsumption(entry, next.id, []);
    entry.lifecycleRoundsConsumed = 0;

    // ---- what carries into the new tournament, and what does not ----------
    //
    // The rule this ticket states is about a PURCHASE: Plus was bought for one
    // tournament, so the next tournament is a new decision and a new payment.
    // That is the whole no-rollover guarantee, and PLUS is reset here for it.
    //
    // GRANDFATHERED and MANUAL_GRANT are not purchases, and resetting them
    // would be a silent downgrade nobody asked for. Both were reproduced doing
    // real damage before this branch existed: an operator's 40-seat courtesy
    // grant vanished on the next tournament and left a 15-person group stuck
    // under the 10-person FREE cap, unable to admit anyone — and every legacy
    // quiniela grandfathered by MON-001B would have lost its preserved status
    // the first time it played a second tournament. Neither is a renewal
    // decision; both are statuses somebody deliberately granted, and an
    // operator can still revoke either in one click, which is not true of a
    // downgrade that happens by itself.
    //
    // So: the plan carries, re-stamped for the cycle it now covers, and the
    // history records that it carried rather than silently looking like a
    // fresh grant.
    const commercialConfig = (await getRow("commercial_config", client)) || DEFAULT_COMMERCIAL_CONFIG;
    const previousPlan = entry.entitlement && !entry.entitlement.revoked ? entry.entitlement.plan : null;
    const carriesOver = previousPlan === "GRANDFATHERED" || previousPlan === "MANUAL_GRANT";
    let freshEntitlement;
    if (carriesOver) {
      freshEntitlement = { ...entry.entitlement, grantedAt: now, scopeId: next.id };
      freshEntitlement.reason = entry.entitlement.reason
        ? `${entry.entitlement.reason} (se conserva en el torneo nuevo)`
        : "Se conserva en el torneo nuevo: no es una compra por torneo.";
    } else {
      freshEntitlement = buildFreeEntitlement(commercialConfig, now);
      freshEntitlement.source = "new_tournament_cycle";
      freshEntitlement.reason = "Torneo nuevo: el plan anterior no se transfiere.";
      freshEntitlement.scopeId = next.id;
    }
    // The competition binding starts over either way, so the new cycle can
    // adopt whichever tournament it actually imports.
    freshEntitlement.competitionIdentity = null;
    entry.entitlement = freshEntitlement;
    entry.entitlementHistory = Array.isArray(entry.entitlementHistory) ? entry.entitlementHistory : [];
    entry.entitlementHistory.push({
      action: carriesOver ? "new_cycle_carried" : "new_cycle",
      at: now, grantId: null, grantedBy: "admin",
      reason: freshEntitlement.reason, purchase: false,
      entitlement: freshEntitlement,
    });

    await putRow("platform_index", stampVersion(platformIdx, readStoredVersion(platformIdx)), client);
    await client.query("COMMIT");
    res.json({
      ok: true,
      tournament: { cycle: next.editionSeq, name: next.displayName, state: next.lifecycle },
      previousCycles: entry.scopeHistory.length,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("new tournament cycle failed", err);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
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
  const { slug, groupName, creatorName, contact, password, sportsdbLeagueId } = req.body || {};
  const cleanSlug = normalizeSlug(slug) || "quiniela";
  const cleanGroupName = String(groupName || "").trim();
  const cleanCreatorName = String(creatorName || "").trim();
  const cleanContact = String(contact || "").trim();
  const cleanPassword = String(password || "").trim();
  // Optional — a bare numeric id matching TheSportsDB's own id shape. Anything
  // else is ignored rather than rejected, since this only ever drives a
  // convenience autocomplete list, never anything security- or data-critical.
  const cleanLeagueId = /^[0-9]{3,8}$/.test(String(sportsdbLeagueId || "").trim())
    ? String(sportsdbLeagueId).trim() : null;
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
        sportsdbSeason: currentDefaultSeason(),
        pointsPerCorrectPick: 1,
        ...(cleanLeagueId ? { sportsdbLeagueId: cleanLeagueId } : {})
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

    // Note: manual grants/overrides are intentionally never settable here —
    // only the platform dashboard (with the platform password) can grant
    // those (see the entitlement model in planLimits.js). MON-001B: every
    // new quiniela starts on an explicit FREE entitlement — no trial, no
    // time component, and (per MON-001C) FREE never snapshots its limits;
    // it always tracks whatever commercial_config says FREE means at
    // enforcement time. MON-001C fix: if a league was already selected at
    // creation, competitionIdentity is computed and stored on the
    // entitlement right here — a quiniela created WITH a league must never
    // silently start out as competitionIdentity:null (which would make it
    // behave as manual 7/18 lifecycle by mistake, exactly the bug this
    // ticket flagged).
    const commercialConfig = (await getRow("commercial_config", client)) || DEFAULT_COMMERCIAL_CONFIG;
    const entitlement = buildFreeEntitlement(commercialConfig);
    if (cleanLeagueId) {
      entitlement.competitionIdentity = computeCompetitionIdentity(cleanLeagueId, meta.settings.sportsdbSeason);
    }
    // MON-002C: every quiniela starts on cycle 1 of a tournament scope, with
    // or without a league. The scope is what a purchase attaches to, so it has
    // to exist from the first moment — a quiniela with no scope would have
    // nothing to bound a Plus purchase to.
    const scope = tournamentScope.buildInitialScope({
      sportKey: "football",
      provider: cleanLeagueId ? "thesportsdb" : null,
      competitionId: cleanLeagueId,
      displayName: null,
      providerSeasonId: meta.settings.sportsdbSeason || null,
      startedAt: new Date().toISOString(),
    });
    entitlement.scopeId = scope.id;
    idx.quinielas.push({
      slug: cleanSlug, name: cleanGroupName, creatorName: cleanCreatorName,
      contact: cleanContact, createdAt: new Date().toISOString(),
      participantCount: 1, roundCount: 0,
      entitlement,
      entitlementHistory: [{ action: "grant", entitlement, at: entitlement.grantedAt }],
      tournamentScope: scope,
      scopeHistory: [],
      lifecycleRoundsConsumed: 0,
      lifecycleConsumedRoundIds: [],
      consumedRoundIdsByScope: { [scope.id]: [] },
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
// browser.
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
    // MON-002B: this used to push an entry with no entitlement and no
    // lifecycle counters at all, which broke in both directions. Until the
    // next restart every write to the migrated quiniela failed closed with
    // entitlement_unavailable; at that restart the grandfathering migration
    // stamped it GRANDFATHERED, which is a 100,000/100,000 ceiling — so a
    // move to a personal link quietly turned into unlimited-forever.
    //
    // It is grandfathered explicitly instead: this quiniela really does
    // predate commercial enforcement (it is the legacy single-tenant row,
    // which never had a plan), so it keeps exactly the experience it already
    // had — but as a recorded, auditable decision made here, not as an
    // accident of a missing field. The old exempt:true flag is preserved as
    // the stated reason rather than as a separate silent bypass.
    const migratedEntitlement = buildGrandfatheredEntitlement(new Date().toISOString(), {
      source: "migrate_quiniela",
      reason: "Movida desde el link raíz — ya existía antes del cobro por plan.",
    });
    const migratedScope = tournamentScope.buildInitialScope({
      sportKey: "football",
      provider: (meta.settings && meta.settings.sportsdbLeagueId) ? "thesportsdb" : null,
      competitionId: meta.settings && meta.settings.sportsdbLeagueId,
      providerSeasonId: (meta.settings && meta.settings.sportsdbSeason) || null,
      startedAt: new Date().toISOString(),
    });
    migratedEntitlement.scopeId = migratedScope.id;
    idx.quinielas.push({
      slug: cleanSlug, name: meta.groupName, creatorName: creator.name || "",
      createdAt: new Date().toISOString(),
      participantCount: (meta.participants || []).length, roundCount: (meta.rounds || []).length,
      entitlement: migratedEntitlement,
      entitlementHistory: [{ action: "grant", entitlement: migratedEntitlement, at: migratedEntitlement.grantedAt }],
      tournamentScope: migratedScope,
      scopeHistory: [],
      lifecycleRoundsConsumed: 0,
      lifecycleConsumedRoundIds: [],
      consumedRoundIdsByScope: { [migratedScope.id]: [] },
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

// ---------- platform admin operations that span more than one row ----------
//
// MON-001F.2. These exist because the dashboard used to perform multi-row
// admin actions as a SEQUENCE of independent whole-document writes, which
// meant a conflict partway through left the rows disagreeing with each other:
//
//   marking as paid   ->  platform_index.paid=true committed, then the
//                         payment-log append 409s and is silently dropped:
//                         a quiniela billed with no record of the payment
//   editing a quiniela ->  meta (name + owner password) committed, then the
//                         platform_index write 409s: name diverges between
//                         meta and index, and the jornada limit is lost
//
// Both are now single transactions driven by the admin's INTENT (the fields
// actually being changed) rather than by a whole document the browser has
// been holding since the page loaded. There is no stale snapshot to reject,
// so these cannot 409 at all — they read the current rows under lock and
// apply the change to them.
//
// LOCK ORDER, followed by every multi-row transaction in this file:
//   platform_index  ->  quiniela meta  ->  platform_payment_log
// Taking them in one consistent order is what keeps these from deadlocking
// against create-quiniela, the quiniela-meta branch of /api/kv and sync.

// The payment record's id comes from the client so that a retry after a lost
// response is recognisable as the SAME payment rather than a second one.
// An operator-supplied id used to make a grant retry-safe. Same shape rule
// the payment log already used, so ids stay greppable across both.
function isUsableGrantId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

// ---------- granting a plan (MON-002B) ----------
//
// The operation MON-001 was missing entirely. Before this, PLUS existed only
// as a builder function and a unit test: nothing in the running server ever
// created one, so a quiniela could be FREE or GRANDFATHERED and nothing else,
// and an organizer who hit a limit had no reachable path forward. The
// dashboard's "Pagado" and "Exenta" toggles wrote fields that no enforcement
// code read — they looked like an unlock and were not one.
//
// This replaces POST /api/platform/quinielas/:slug/paid. Recording money and
// granting the plan were two separate acts there, and only one of them did
// anything; they are one act now, in one transaction, so a quiniela can never
// again be billed without being upgraded or upgraded without being recorded.
//
// LOCK ORDER: platform_index -> platform_payment_log. The same order every
// other multi-row transaction in this file uses.
app.post("/api/platform/quinielas/:slug/entitlement", async (req, res) => {
  const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
  const platformHash = await getPlatformHash();
  if (!verifyPassword(providedPlatformAuth, platformHash)) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const body = req.body || {};
  const plan = body.plan;
  const grantId = body.grantId;
  if (!isUsableGrantId(grantId)) return res.status(400).json({ error: "invalid_grant_id" });
  if (plan !== "PLUS" && plan !== "MANUAL_GRANT" && plan !== "FREE") {
    return res.status(400).json({ error: "invalid_plan" });
  }
  // A manual override is the ONE grant allowed to name its own numbers, so
  // it is the one whose numbers get validated. PLUS never reads these.
  if (plan === "MANUAL_GRANT" && !isValidManualGrantLimits(body.participantLimit, body.manualRoundLimit)) {
    return res.status(400).json({ error: "invalid_limits" });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : null;
  if (plan === "MANUAL_GRANT" && !reason) return res.status(400).json({ error: "reason_required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const idx = await getRowLocked("platform_index", client);
    const entry = idx && Array.isArray(idx.quinielas)
      ? idx.quinielas.find((q) => q.slug === req.params.slug)
      : null;
    if (!entry) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }

    // Read INSIDE the transaction, and used as the sole source for a PLUS
    // grant's limits and price. Nothing about a purchase comes from the
    // request body — that is what stops a crafted call from minting a
    // 500-participant "PLUS" for zero pesos.
    const commercialConfig = (await getRow("commercial_config", client)) || DEFAULT_COMMERCIAL_CONFIG;
    const now = new Date().toISOString();
    let entitlement;
    if (plan === "PLUS") {
      entitlement = buildPlusEntitlement(commercialConfig, now, {
        source: "platform_grant", grantedBy: "platform", reason,
      });
    } else if (plan === "MANUAL_GRANT") {
      entitlement = buildManualGrantEntitlement(now, {
        grantedBy: "platform", reason,
        participantLimit: body.participantLimit, manualRoundLimit: body.manualRoundLimit,
      });
    } else {
      // Undoing a grant. FREE never snapshots numbers — it tracks whatever
      // commercial_config says FREE means at enforcement time (MON-001C).
      entitlement = buildFreeEntitlement(commercialConfig, now);
      entitlement.source = "platform_revoke";
      entitlement.grantedBy = "platform";
      entitlement.reason = reason;
    }

    // Only locked when there is money to record, and only for PLUS.
    const paymentLog = plan === "PLUS"
      ? ((await getRowLocked("platform_payment_log", client)) || { payments: [] })
      : null;

    const result = applyEntitlementGrant({
      index: idx, paymentLog, entitlement, slug: req.params.slug,
      grantId, grantedBy: "platform", reason, now,
    });
    if (!result.ok) {
      await client.query("ROLLBACK");
      // grant_id_conflict is a caller error (an id replayed for a DIFFERENT
      // quiniela), not a missing quiniela and not a malformed request.
      const status = result.error === "not_found" ? 404 : (result.error === "grant_id_conflict" ? 409 : 400);
      return res.status(status).json({ error: result.error });
    }
    // A replayed grantId applies nothing and writes nothing — not even a
    // version bump — so a retry can never disturb the row it already changed.
    if (result.paymentLog) await putRow("platform_payment_log", result.paymentLog, client);
    if (result.index) await putRow("platform_index", result.index, client);
    await client.query("COMMIT");
    res.json({
      ok: true, plan, applied: result.applied, recorded: result.recorded,
      // Tells the panel WHICH of the three outcomes happened — granted,
      // already on the plan, or purchased coverage restored — so it can say
      // something true instead of one message for all of them.
      reason: result.reason || null,
      indexVersion: result.index ? result.index.version : readStoredVersion(idx),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("platform entitlement grant failed", err);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

app.post("/api/platform/quinielas/:slug/settings", async (req, res) => {
  const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
  const platformHash = await getPlatformHash();
  if (!verifyPassword(providedPlatformAuth, platformHash)) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const body = req.body || {};
  const wantsName = typeof body.name === "string" && body.name.trim() !== "";
  const wantsPassword = typeof body.ownerPassword === "string" && body.ownerPassword.trim() !== "";
  // customJornadaLimit is gone with the rest of the legacy cobro model: it
  // was the per-quiniela version of the "jornadas gratis" threshold and fed
  // nothing but the client-side gate that has been removed. Giving one
  // quiniela a different round budget is a MANUAL_GRANT now, which
  // enforcement actually reads.
  if (!wantsName && !wantsPassword) return res.status(400).json({ error: "invalid_params" });

  const metaKey = `quiniela:${req.params.slug}:meta`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock order: platform_index first, then the meta row — the same order
    // create-quiniela and the quiniela-meta branch already use.
    const idx = await getRowLocked("platform_index", client);
    const entry = idx && Array.isArray(idx.quinielas)
      ? idx.quinielas.find((q) => q.slug === req.params.slug)
      : null;
    const meta = await getRowLocked(metaKey, client);
    if (!entry || !meta) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }

    const result = applyQuinielaSettings({
      index: idx, meta, slug: req.params.slug,
      name: wantsName ? body.name.trim().slice(0, 120) : null,
      hashedOwnerPassword: wantsPassword ? hashPassword(body.ownerPassword.trim()) : null,
    });
    if (!result.ok) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: result.error });
    }
    // Both rows in the SAME transaction: either both changes land or neither
    // does.
    await putRow(metaKey, result.meta, client);
    await putRow("platform_index", result.index, client);
    await client.query("COMMIT");
    res.json({ ok: true, indexVersion: result.index.version });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("platform quiniela settings failed", err);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

// Simple health check (also useful for uptime pingers to avoid free-tier sleep)
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- Sports data (DATA-001) ----------
// Replaces the old flow where the browser called TheSportsDB directly with
// the public free key "123" (public/index.html's fetchSportsdbSeason, now
// removed — see DATA-001). That endpoint truncated to 15 events regardless
// of season size, so any jornada past the first 1-2 rounds silently
// couldn't be auto-detected. This endpoint calls TheSportsDB V2 server-side
// (key never reaches the browser — see providers/theSportsDbAdapter.js) via
// SportsDataProvider, which does not truncate.
//
// Never returns raw provider JSON to the client — only normalized
// suggestions (or a reliability state) per DATA-001 §5/§11.

// AUTO-004: Sports Data Reliability / Observability. Everything the
// provider layer already computes (RELIABILITY_STATES) was being
// calculated, logged, and immediately discarded — this is the one place
// that persists the LATEST outcome of the only two operations that talk
// to TheSportsDB (competition_sync, automatic_results), reusing the
// existing `kv` table as a single singleton row. No new table, no
// scheduler, no polling.
//
// Deliberately excludes competition_not_supported from ever updating this
// row: a specific quiniela's league/season not being supported is a
// per-quiniela configuration fact, not a signal about whether the
// provider itself is reachable — see the ticket's explicit warning
// against marking global Sports Data health as ERROR just because one
// quiniela asked for an unsupported competition. The caller simply never
// invokes this function for that reliabilityState.
//
// Deliberately never throws and never blocks its caller on failure:
// observability must stay strictly secondary to the actual Sports Data
// operation. A DB hiccup writing this row must never turn an otherwise-
// successful Competition Sync/Automatic Results call into a visible error
// for the Admin (see CASE L in the ticket) — the read-then-write below can
// itself fail for any reason and the catch swallows it, logging only.
//
// Read-then-write (not a single atomic UPSERT): given this is a
// low-frequency, admin-triggered action (not high-concurrency background
// traffic), the tiny race window this leaves is an accepted, documented
// tradeoff in exchange for code that's simple to read and simple to test
// deterministically — matching the ticket's own preference for the
// smallest solution over a more sophisticated one.
async function recordSportsDataHealth({ operation, outcome, reliabilityState, statusCode }) {
  try {
    const existingRow = await pool.query("SELECT value FROM kv WHERE key = 'sports_data_health'");
    const prev = (existingRow.rows[0] && existingRow.rows[0].value) || {};
    const next = nextSportsDataHealth(prev, { operation, outcome, reliabilityState, statusCode });
    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ('sports_data_health', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(next)]
    );
  } catch (err) {
    console.error("recordSportsDataHealth failed (non-fatal, ignored)", err.message);
  }
}

// AUTO-002 (bulk validation round): shared by both the single-round and
// whole-quiniela endpoints below, so "search this one round" and "search
// every pending round" produce identical suggestions from identical logic —
// no duplicated matching rules to drift apart.
function buildRoundSuggestions(round, events) {
  const suggestions = [];
  for (const match of round.matches || []) {
    const hit = sportsDataProvider.findMatchingEvent(events, match, round.deadline);
    if (!hit || !hit.score) continue;
    const [home, away] = hit.participants;
    const straight = sportsDataProvider._teamsMatch(match.teamA, home.name);
    const result = straight
      ? (hit.score.home > hit.score.away ? "A" : hit.score.home < hit.score.away ? "B" : "D")
      : (hit.score.home > hit.score.away ? "B" : hit.score.home < hit.score.away ? "A" : "D");
    suggestions.push({
      matchId: match.id,
      externalEventId: hit.externalEventId,
      score: `${hit.score.home}-${hit.score.away}`,
      result,
      date: hit.dateTime,
    });
  }
  return suggestions;
}

app.get("/api/quinielas/:slug/rounds/:roundId/sports-results", rateLimit("sports-results"), async (req, res) => {
  const { slug, roundId } = req.params;
  const metaKey = `quiniela:${slug}:meta`;
  const meta = await getRow(metaKey);
  if (!meta) return res.status(404).json({ error: "not_found" });

  const { isAdminOrOwner } = computeRequesterIdentity(req, slug, meta);
  if (!isAdminOrOwner) return res.status(403).json({ error: "forbidden" });

  const round = (meta.rounds || []).find((r) => r.id === roundId);
  if (!round) return res.status(404).json({ error: "round_not_found" });

  // AUTO-002: 0 requests to TheSportsDB when there's nothing worth asking
  // about — an unpublished round, one still open (deadline hasn't passed),
  // or one whose results QRACKS already has (resultsPublished:true is the
  // source of truth from that point on; TheSportsDB is never consulted
  // again for it). Legacy rounds (published === undefined) are eligible
  // exactly like published:true, same compatibility rule as everywhere else.
  if (!isRoundEligibleForAutoResults(round)) {
    return res.json({ ok: true, reliabilityState: null, suggestions: [] });
  }

  const externalLeagueId = meta.settings && meta.settings.sportsdbLeagueId;
  const season = (meta.settings && meta.settings.sportsdbSeason) || currentDefaultSeason();
  if (!externalLeagueId) {
    // No league configured for this quiniela — not a provider failure, just
    // nothing to look up. Manual capture is unaffected either way.
    return res.json({ ok: true, reliabilityState: "competition_not_supported", suggestions: [] });
  }

  try {
    const events = await sportsDataProvider.getSeasonEvents({
      provider: "thesportsdb",
      externalLeagueId,
      season,
    });
    recordSportsDataHealth({ operation: "automatic_results", outcome: "success" });
    res.json({ ok: true, reliabilityState: null, suggestions: buildRoundSuggestions(round, events) });
  } catch (err) {
    const reliabilityState = err instanceof ProviderError ? err.reliabilityState : "provider_invalid_response";
    if (reliabilityState !== "competition_not_supported") {
      recordSportsDataHealth({
        operation: "automatic_results", outcome: "failure", reliabilityState,
        statusCode: err instanceof ProviderError ? err.meta && err.meta.status : null,
      });
    }
    // Diagnostic context only — never the API key, never raw response bodies
    // that might contain it, never anything the organizer typed. This is the
    // observability DATA-001 was missing: a future truncation or outage
    // shows up here with enough context to diagnose it without an organizer
    // having to report "no aparecen resultados" first.
    console.error("sports-results provider failure", {
      slug,
      roundId,
      externalLeagueId,
      season,
      reliabilityState,
      message: err.message,
    });
    res.json({ ok: false, reliabilityState, suggestions: [] });
  }
});

// AUTO-002 (bulk validation round): "Buscar resultados automáticos" without
// making the admin visit every closed-but-pending round one at a time.
// Computes eligibility for EVERY round up front, then — if there's at least
// one eligible round — makes exactly ONE SportsDataProvider.getSeasonEvents()
// call (subject to its existing provider+league+season cache) and reuses
// those same events to build suggestions for every eligible round. Ineligible
// rounds (unpublished, still open, or already resultsPublished) are never
// touched, never counted against the provider. This is purely additive: the
// single-round endpoint above is untouched and still works exactly as
// before as a fallback for searching one round on its own.
app.get("/api/quinielas/:slug/sports-results", rateLimit("sports-results"), async (req, res) => {
  const { slug } = req.params;
  const metaKey = `quiniela:${slug}:meta`;
  const meta = await getRow(metaKey);
  if (!meta) return res.status(404).json({ error: "not_found" });

  const { isAdminOrOwner } = computeRequesterIdentity(req, slug, meta);
  if (!isAdminOrOwner) return res.status(403).json({ error: "forbidden" });

  const eligibleRounds = (meta.rounds || []).filter((r) => isRoundEligibleForAutoResults(r));
  if (!eligibleRounds.length) {
    // Nothing pending — 0 provider calls, same principle as the per-round endpoint.
    return res.json({ ok: true, reliabilityState: null, results: {} });
  }

  const externalLeagueId = meta.settings && meta.settings.sportsdbLeagueId;
  const season = (meta.settings && meta.settings.sportsdbSeason) || currentDefaultSeason();
  if (!externalLeagueId) {
    return res.json({ ok: true, reliabilityState: "competition_not_supported", results: {} });
  }

  try {
    const events = await sportsDataProvider.getSeasonEvents({
      provider: "thesportsdb",
      externalLeagueId,
      season,
    });
    recordSportsDataHealth({ operation: "automatic_results", outcome: "success" });
    const results = {};
    for (const round of eligibleRounds) {
      results[round.id] = buildRoundSuggestions(round, events);
    }
    res.json({ ok: true, reliabilityState: null, results });
  } catch (err) {
    const reliabilityState = err instanceof ProviderError ? err.reliabilityState : "provider_invalid_response";
    if (reliabilityState !== "competition_not_supported") {
      recordSportsDataHealth({
        operation: "automatic_results", outcome: "failure", reliabilityState,
        statusCode: err instanceof ProviderError ? err.meta && err.meta.status : null,
      });
    }
    console.error("sports-results (bulk) provider failure", {
      slug,
      externalLeagueId,
      season,
      reliabilityState,
      message: err.message,
    });
    // Fail-safe: never touches meta.rounds — this endpoint is read-only,
    // same as the single-round one. Existing results are never at risk.
    res.json({ ok: false, reliabilityState, results: {} });
  }
});

// ---------- AUTO-001: Competition Sync ----------
// Deliberately a SEPARATE endpoint from /api/create-quiniela, called by the
// frontend only after quiniela creation already succeeded — never embedded
// inside create-quiniela's own transaction (see AUTO-001 diagnostic §10):
// a provider call inside that transaction would let a TheSportsDB hiccup
// fail the quiniela creation itself, which must never happen.
//
// Fail-safe (§20): any provider failure rolls back and writes NOTHING —
// never partial rounds, never touches existing data. Idempotent (§9): a
// round already imported from this provider (matched by externalRoundId)
// is never recreated, never modified — re-running this is always safe and
// purely additive. Rounds come out with published:false — see §14/§15 for
// where publishing and participant visibility are handled.
app.post("/api/quinielas/:slug/sync-competition", rateLimit("sync-competition"), async (req, res) => {
  const { slug } = req.params;
  const metaKey = `quiniela:${slug}:meta`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // MON-001D: platform_index is locked FIRST, before this quiniela's own
    // meta row — the SAME order already used by POST /api/kv/:key's
    // quiniela-meta branch and POST /api/self-register (MON-001B/C).
    // Before this ticket, sync-competition locked only metaKey; adding the
    // entitlement read in the opposite order would have introduced a real
    // deadlock risk against those two paths.
    const platformIdx = await getRowLocked("platform_index", client);
    const meta = await getRowLocked(metaKey, client);
    if (!meta) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "not_found" });
    }

    const { isAdminOrOwner } = computeRequesterIdentity(req, slug, meta);
    if (!isAdminOrOwner) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "forbidden" });
    }

    const externalLeagueId = meta.settings && meta.settings.sportsdbLeagueId;
    const season = (meta.settings && meta.settings.sportsdbSeason) || currentDefaultSeason();
    if (!externalLeagueId) {
      // No competition configured for this quiniela — not a provider
      // failure, just nothing to import. Manual creation is unaffected.
      console.log("sync-competition: no league configured", { slug });
      await client.query("ROLLBACK");
      return res.json({ ok: true, reliabilityState: "competition_not_supported", createdRounds: 0, createdMatches: 0, skippedEvents: 0, eventsFetched: 0, distinctProviderRounds: 0 });
    }

    // MON-001D: competition binding enforcement — the real backend guard
    // that stops one quiniela (and one Plus purchase) from being reused
    // for a second tournament. The requested identity is derived from the
    // league+season THIS request would import, and compared against the
    // identity the quiniela's entitlement is bound to (platform_index,
    // platform-tier — not owner-writable). A mismatch is refused before
    // the provider is even called, so no data is fetched, imported, or
    // partially written for the wrong tournament.
    const requestedIdentity = computeCompetitionIdentity(externalLeagueId, season);
    const bindingEntry = platformIdx && Array.isArray(platformIdx.quinielas)
      ? platformIdx.quinielas.find((q) => q.slug === slug)
      : null;
    if (!bindingEntry) {
      // MON-002B: same fail-closed rule the two write paths already applied.
      // A real per-slug quiniela with no platform_index entry is a data
      // integrity problem, and letting the import proceed unbound would hand
      // it a tournament with no commercial identity attached at all.
      console.error("sync-competition blocked: no platform_index entry", { slug });
      await client.query("ROLLBACK");
      return res.status(402).json({ error: "entitlement_unavailable", createdRounds: 0, createdMatches: 0, skippedEvents: 0 });
    }
    let indexTouched = false;
    {
      const binding = evaluateCompetitionBinding(bindingEntry.entitlement, requestedIdentity);
      if (binding.violation) {
        await client.query("ROLLBACK");
        console.error("sync-competition blocked by competition binding", {
          slug, requestedIdentity, boundIdentity: binding.boundIdentity, reason: binding.reason,
        });
        return res.status(402).json({
          error: binding.reason,
          boundIdentity: binding.boundIdentity || null,
          requestedIdentity: requestedIdentity || null,
          createdRounds: 0, createdMatches: 0, skippedEvents: 0,
        });
      }
      // Not yet bound (a quiniela created without a league that has just
      // selected one, or one created before this ticket): adopt this
      // tournament now, forward-looking. Any manual rounds already played
      // keep their consumed lifecycle — adoption never refunds, resets, or
      // deletes anything (MON-001D §8).
      if (binding.adopt) {
        bindingEntry.entitlement.competitionIdentity = binding.identity;
        bindingEntry.entitlementHistory = bindingEntry.entitlementHistory || [];
        bindingEntry.entitlementHistory.push({
          action: "competition_bound", at: new Date().toISOString(),
          competitionIdentity: binding.identity, source: "sync_competition",
        });
        indexTouched = true;
      }

      // MON-002C: record WHICH competition the current cycle is playing, on
      // the scope's metadata. This is labelling only — the scope id does not
      // move, because a scope only ever changes when an Admin starts a new
      // tournament. That is exactly why binding a league to a cycle cannot
      // hand the cycle a different tournament's coverage.
      const scope = bindingEntry.tournamentScope;
      if (scope) {
        const refs = scope.providerRefs || {};
        if (refs.competitionId !== String(externalLeagueId) || refs.seasonId !== season) {
          scope.providerRefs = {
            ...refs,
            provider: "thesportsdb",
            competitionId: String(externalLeagueId),
            seasonId: season,
          };
          indexTouched = true;
        }
        // The provider wired into this path declares no finished signal, so
        // the honest answer about whether the tournament is over is "we do
        // not know" — never inferred from how many events came back.
        const canSignalFinish = false;
        const nextLifecycle = tournamentScope.resolveLifecycle(scope, { providerCanSignalFinish: canSignalFinish });
        if (nextLifecycle !== scope.lifecycle) {
          scope.lifecycle = nextLifecycle;
          indexTouched = true;
        }
      }
      if (indexTouched) await putRow("platform_index", platformIdx, client);
    }

    let events;
    try {
      events = await sportsDataProvider.getSeasonEvents({ provider: "thesportsdb", externalLeagueId, season });
    } catch (err) {
      await client.query("ROLLBACK"); // fail-safe: no partial writes on provider failure
      const reliabilityState = err instanceof ProviderError ? err.reliabilityState : "provider_invalid_response";
      if (reliabilityState !== "competition_not_supported") {
        recordSportsDataHealth({
          operation: "competition_sync", outcome: "failure", reliabilityState,
          statusCode: err instanceof ProviderError ? err.meta && err.meta.status : null,
        });
      }
      console.error("sync-competition provider failure", {
        slug, externalLeagueId, season, reliabilityState, message: err.message,
      });
      return res.json({ ok: false, reliabilityState, createdRounds: 0, createdMatches: 0, skippedEvents: 0 });
    }
    recordSportsDataHealth({ operation: "competition_sync", outcome: "success" });

    // All grouping/idempotency/deadline-seeding decisions live in
    // competitionSync.js (pure, unit-tested) — this endpoint only assigns
    // ids (storage concern) and persists.
    const { newRounds: plannedRounds, skippedEvents } = planCompetitionSync({
      existingRounds: meta.rounds || [],
      events,
      provider: "thesportsdb",
    });
    const newRounds = plannedRounds.map((r) => ({
      id: "r_" + crypto.randomBytes(5).toString("hex"),
      ...r,
      // MON-001D: record which tournament each imported round belongs to.
      // Purely additive and audit-oriented -- enforcement itself is the
      // binding check above, never this field (which lives in
      // owner-writable meta and therefore can never be trusted as an
      // authority). It makes "are these rounds all from one tournament?"
      // answerable after the fact without re-querying the provider.
      competitionIdentity: requestedIdentity,
      matches: r.matches.map((m) => ({ id: "m_" + crypto.randomBytes(5).toString("hex"), ...m })),
    }));

    // AUTO-001.1 production bug fix: always-on diagnostics, not just on
    // failure. createdRounds:0 is ambiguous on its own — it can mean
    // "genuinely everything already imported" OR "the provider returned
    // nothing usable for this league+season" OR "every event collided with
    // an existing round number". These two numbers (how many events came
    // back at all, and how many distinct rounds they represent) are what
    // let that be told apart after the fact, without guessing — see
    // AUTO-001.1 §4 in the ticket that requested this.
    const distinctProviderRounds = new Set(events.map((e) => e.round).filter((r) => r != null)).size;
    console.log("sync-competition diagnostics", {
      slug, externalLeagueId, season,
      eventsFetched: events.length,
      distinctProviderRounds,
      existingRoundCount: (meta.rounds || []).length,
      createdRounds: newRounds.length,
      skippedEvents,
    });

    if (newRounds.length) {
      meta.rounds = [...(meta.rounds || []), ...newRounds].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
      await putRow(metaKey, meta, client);
    }

    await client.query("COMMIT");
    res.json({
      ok: true,
      reliabilityState: null,
      createdRounds: newRounds.length,
      createdMatches: newRounds.reduce((n, r) => n + r.matches.length, 0),
      skippedEvents,
      // Exposed so the frontend can tell "genuinely fully imported" (we got
      // a real calendar back, nothing new in it) apart from "the provider
      // call succeeded technically but returned no usable calendar data at
      // all" (season/league mismatch, empty response, etc.) — see the UI
      // fix below. Not sensitive: just counts, no provider payload.
      eventsFetched: events.length,
      distinctProviderRounds,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("sync-competition failed", err);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

// ---------- Growth Loop funnel events ----------
// Deliberately minimal: no dashboard, no aggregation — just a plain, appendable
// log meant to be queried directly in Postgres when someone wants to look.
const KNOWN_EVENTS = new Set([
  // MON-002B: the paywall's own primary action. Registered here because a
  // trackEvent() the server rejects is worse than no telemetry at all — it
  // looks instrumented and records nothing.
  "upgrade_cta_clicked",
  "access_link_opened",
  "join_started",
  "join_completed",
  "session_restored",
  "session_confirmation_accepted",
  "session_confirmation_rejected",
  // Sprint 14.4 — funnel de activación completo.
  "landing_viewed",
  "create_started",
  "quiniela_created",
  "first_pick_saved",
  "picks_completed",
  "invite_shared",
  "standings_shared",
  // Sprint 15.1 — funnel gap: cuándo (si) una quiniela llega a tener su
  // primera jornada jugable publicada.
  "first_round_published",
  // Sprint 15.1 — S15-3/S15-4: lifecycle del organizador (resultado
  // publicado) y del participante/organizador (regreso real a la tabla).
  "result_published",
  "standings_viewed"
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

// Sprint 14.4 — lectura agregada para /panel-plataforma. Nunca pública: mismo
// patrón de auth (header x-qracks-platform-auth) que /api/delete-quiniela.
// Toda la agregación (conteos, ventanas de 7/30 días, distinct participants)
// ocurre en PostgreSQL en una sola consulta — el frontend nunca recibe filas
// individuales de analytics_events, solo estos totales ya calculados. La
// respuesta no incluye ningún campo que pueda ser PII (no hay nombres,
// emails, picks ni resultados en la tabla en primer lugar).
const FUNNEL_EVENT_NAMES = [
  "landing_viewed",
  "create_started",
  "quiniela_created",
  "access_link_opened",
  "invite_shared",
  "join_completed",
  "first_pick_saved",
  "picks_completed",
  "first_round_published",
  "result_published",
  "standings_viewed",
  "standings_shared"
];
app.get("/api/platform-sports-health", async (req, res) => {
  const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
  const platformHash = await getPlatformHash();
  if (!verifyPassword(providedPlatformAuth, platformHash)) {
    return res.status(403).json({ error: "unauthorized" });
  }
  try {
    const row = await pool.query("SELECT value FROM kv WHERE key = 'sports_data_health'");
    // Seeded in ensureTable() so this row always exists — but fall back to
    // the same never-attempted shape defensively, rather than a 500, if
    // somehow it's ever missing.
    const health = (row.rows[0] && row.rows[0].value) || {
      lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null,
      lastOutcome: null, lastReliabilityState: null, lastOperation: null,
      provider: null, statusCode: null,
    };
    res.json({ ok: true, health });
  } catch (err) {
    console.error("platform-sports-health failed", err);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/platform-analytics", async (req, res) => {
  const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";
  const platformHash = await getPlatformHash();
  if (!verifyPassword(providedPlatformAuth, platformHash)) {
    return res.status(403).json({ error: "unauthorized" });
  }
  try {
    const result = await pool.query(
      `SELECT
         event_name,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')  AS last7_total,
         COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS last30_total,
         COUNT(*)                                                        AS all_total,
         COUNT(DISTINCT participant_id) FILTER (WHERE created_at >= now() - interval '7 days')  AS last7_participants,
         COUNT(DISTINCT participant_id) FILTER (WHERE created_at >= now() - interval '30 days') AS last30_participants,
         COUNT(DISTINCT participant_id)                                                         AS all_participants,
         COUNT(DISTINCT device_id)                                                              AS all_devices
       FROM analytics_events
       WHERE event_name = ANY($1::text[])
       GROUP BY event_name`,
      [FUNNEL_EVENT_NAMES]
    );
    const events = {};
    for (const name of FUNNEL_EVENT_NAMES) {
      events[name] = {
        last7: { total: 0, participants: 0 },
        last30: { total: 0, participants: 0 },
        allTime: { total: 0, participants: 0, devices: 0 }
      };
    }
    for (const row of result.rows) {
      events[row.event_name] = {
        last7: { total: Number(row.last7_total), participants: Number(row.last7_participants) },
        last30: { total: Number(row.last30_total), participants: Number(row.last30_participants) },
        allTime: { total: Number(row.all_total), participants: Number(row.all_participants), devices: Number(row.all_devices) }
      };
    }
    res.json({ ok: true, events });
  } catch (err) {
    console.error("platform-analytics failed", err);
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
    res.set("Cache-Control", "no-cache");
    res.send(html);
  } catch (err) {
    console.error("Error building link preview for /q/:slug", err);
    res.sendFile(INDEX_HTML_PATH);
  }
});

// Static frontend
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (path.basename(filePath) === "index.html") {
      // The app itself changes with every deploy and has no cache-busting
      // filename — must always revalidate so a deploy is never masked by a
      // stale cached copy (still gets a fast 304 when nothing changed).
      res.set("Cache-Control", "no-cache");
    } else {
      // logo.svg / favicon.svg / og-image.png rarely change and aren't
      // security- or correctness-sensitive — safe to cache for a while.
      res.set("Cache-Control", "public, max-age=3600");
    }
  }
}));
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
