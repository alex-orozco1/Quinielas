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

const app = express();
// Render puts exactly one reverse proxy in front of this app. Trusting only
// that one hop (instead of blindly trusting any X-Forwarded-For a client
// sends) is what makes req.ip a real client IP instead of something a client
// could spoof to dodge rate limiting.
app.set("trust proxy", 1);
app.use(express.json({ limit: "3mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
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
function stripQuinielaSecrets(value) {
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
  return clone;
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
function resolveMetaAuthTier(oldValue, providedOwnerAuth, providedPlatformAuth, platformHash) {
  if (oldValue && oldValue.settings && verifyPassword(providedOwnerAuth, oldValue.settings.ownerPassword)) {
    return "owner";
  }
  if (providedPlatformAuth && verifyPassword(providedPlatformAuth, platformHash)) {
    return "platform";
  }
  if (oldValue && providedOwnerAuth && (oldValue.participants || []).some(
    (p) => p.isAdmin && p.pin && verifyPassword(providedOwnerAuth, p.pin)
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

async function filterPicksForRequest(req, info, picksValue) {
  const meta = await getRow(info.metaKey);
  if (!meta) return picksValue;
  const providedAuth = req.get("x-qracks-auth") || "";
  const participant = (meta.participants || []).find((p) => p.id === info.participantId);

  const isSelf = isAuthenticatedAsParticipant(participant, providedAuth);
  if (isSelf) return picksValue; // only the participant sees their own open-round answers

  const isOwner = meta.settings && verifyPassword(providedAuth, meta.settings.ownerPassword);
  const isAdminOrOwner = isOwner || (providedAuth && (meta.participants || []).some(
    (p) => p.isAdmin && p.pin && verifyPassword(providedAuth, p.pin)
  ));

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
async function validatePicksDeadline(info, oldValue, newValue) {
  const meta = await getRow(info.metaKey);
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
      value = stripQuinielaSecrets(value);
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
      const authTier = resolveMetaAuthTier(oldValue, providedOwnerAuth, providedPlatformAuth, platformHash);
      if (!authTier) return res.status(403).json({ error: "unauthorized" });
      finalValue = mergeProtectedMetaFields(oldValue, value, authTier);
    } else if (info.kind === "picks") {
      const oldPicks = await getRow(req.params.key);
      const metaValue = await getRow(info.metaKey);
      if (metaValue) {
        const participant = (metaValue.participants || []).find((p) => p.id === info.participantId);
        if (!isAuthenticatedAsParticipant(participant, providedOwnerAuth)) {
          // No PIN yet? They need to activate one first via /api/set-pin — a
          // public request (with or without a guessed PIN) can't read or write
          // picks just because a PIN hasn't been set.
          return res.status(403).json({ error: participant && !participant.pin ? "pin_required" : "unauthorized" });
        }
      }
      // metaValue missing entirely is a bootstrap edge case (shouldn't happen in
      // practice since quinielas are always created before anyone can vote) — no
      // meta means no rounds to validate deadlines against either, so it's a no-op.
      const deadlineCheck = await validatePicksDeadline(info, oldPicks, value);
      if (!deadlineCheck.ok) return res.status(403).json({ error: "round_locked" });
    }

    await putRow(req.params.key, finalValue);
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
    const { metaKey, participantId, pin } = req.body || {};
    if (!metaKey || !participantId) return res.status(400).json({ error: "missing_params" });
    const value = await getRow(metaKey);
    const participant = value ? (value.participants || []).find((p) => p.id === participantId) : null;
    // A participant with no PIN yet isn't "verified" — the frontend should
    // route them to /api/set-pin instead of treating this as a pass.
    res.json({ ok: isAuthenticatedAsParticipant(participant, pin) });
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
    const { metaKey, participantId, currentPin, newPin } = req.body || {};
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
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/self-register", async (req, res) => {
  try {
    const { metaKey, name, pin } = req.body || {};
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
      contact: cleanContact, createdAt: new Date().toISOString()
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
      createdAt: new Date().toISOString(), exempt: true
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
