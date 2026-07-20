// Quiniela / QRACKS — backend
// Serves the static frontend and a small key-value API backed by Postgres, plus a
// handful of narrow endpoints for things that need real server-side rules
// (authentication, PIN/password hashing, pick deadlines, safe migration).

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
// Stored format: "scrypt$<salt-hex>$<hash-hex>". Anything else is treated as a
// legacy plaintext value — verified by direct comparison, then transparently
// re-hashed the next time that record is written. This lets existing quinielas
// keep working without a manual migration step.
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
app.set("trust proxy", true); // Render sits behind a proxy — needed for real client IPs (rate limiting)
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
}

async function getRow(key, client) {
  const q = client || pool;
  const r = await q.query("SELECT value FROM kv WHERE key = $1", [key]);
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
// Simple in-memory fixed-window counter, keyed by client IP + endpoint name.
// No new dependency, good enough for this app's scale. Old buckets get swept
// periodically so this doesn't grow forever.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX = 40; // attempts per window, per IP+endpoint — generous enough for a
// household/office WiFi where many participants log in around the same time (e.g. right
// before a jornada closes), while still making a 4-digit PIN brute force impractical
// (10,000 combinations at 40 tries per 5 min is many hours, not the few seconds it'd take unlimited).
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

const PLATFORM_KEYS = new Set(["platform_settings", "platform_index", "platform_payment_log"]);

// Figures out what kind of record a key represents, since that determines what
// credential (if any) a write to it should require.
function classifyKey(key) {
  if (PLATFORM_KEYS.has(key)) return { kind: "platform" };
  if (key === "quiniela_meta_v1") return { kind: "quiniela-meta", metaKey: "quiniela_meta_v1" };
  let m = key.match(/^quiniela:(.+):meta$/);
  if (m) return { kind: "quiniela-meta", metaKey: key, slug: m[1] };
  m = key.match(/^quiniela_picks_(.+)_v1$/);
  if (m) return { kind: "picks", metaKey: "quiniela_meta_v1", participantId: m[1] };
  m = key.match(/^quiniela:(.+):picks:(.+)$/);
  if (m) return { kind: "picks", metaKey: `quiniela:${m[1]}:meta`, participantId: m[2], slug: m[1] };
  return { kind: "other" };
}

// Removes credentials from a quiniela-meta value before it's ever sent to a client.
// Participant PINs become a plain "hasPin" boolean so the UI can still show its
// lock icon without the app (or anyone calling the API directly) seeing the PIN.
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

// Who is allowed to write to an existing quiniela's meta, and at what tier.
// "owner": the real owner password. "admin-pin": any participant flagged isAdmin,
// verified by their own PIN — that's how the app already treats "logged in as an
// admin" everywhere except the extra-sensitive Ajustes screen. "platform": the
// platform owner, for support/recovery. Returns the highest tier that matches,
// or null if none do.
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

// A write only ever includes the fields the client actually changed — because
// the client's own copy never has the real password/PINs (they're stripped on
// the way out, above). This restores whatever the client didn't explicitly set,
// hashes anything it did, and — this is the important part — refuses to let an
// "admin-pin" tier request touch owner-only fields (the owner password itself,
// or granting/revoking someone else's admin rights). Only "owner" or "platform"
// tier requests can change those.
function mergeProtectedMetaFields(oldValue, newValue, authTier) {
  const merged = JSON.parse(JSON.stringify(newValue));
  const oldSettings = (oldValue && oldValue.settings) || null;
  if (!merged.settings) merged.settings = {};

  const canChangeOwnerFields = authTier === "owner" || authTier === "platform" || !oldValue;
  const incomingPw = merged.settings.ownerPassword;
  if (!canChangeOwnerFields) {
    // admin-pin — never allowed to set a new password, always keep the real one.
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
        : hashPassword(oldSettings.ownerPassword); // opportunistically migrate on any write
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
      // PIN: preserve if omitted (opportunistically migrating to a hash if it
      // was still plaintext); hash if present and not already hashed.
      if (!("pin" in p)) {
        if (old && "pin" in old && old.pin) {
          p.pin = isHashed(old.pin) ? old.pin : hashPassword(old.pin);
        } else if (old && "pin" in old) {
          p.pin = old.pin; // null/empty — nothing to hash
        }
      } else if (p.pin && !isHashed(p.pin)) {
        p.pin = hashPassword(p.pin);
      }
      // isAdmin: admin-pin tier can't grant or revoke anyone's admin flag.
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

// Filters a participant's picks for anyone who ISN'T that participant (own PIN)
// or an admin/owner of that quiniela: picks for rounds that haven't closed yet
// are removed, so a public/anonymous request can never see in-progress
// predictions — only ones for rounds whose deadline already passed (which is
// also when the app already shows everyone's picks to everyone, on purpose).
async function filterPicksForRequest(req, info, picksValue) {
  const meta = await getRow(info.metaKey);
  if (!meta) return picksValue;
  const providedAuth = req.get("x-qracks-auth") || "";
  const participant = (meta.participants || []).find((p) => p.id === info.participantId);

  const isSelf = participant && (!participant.pin || verifyPassword(providedAuth, participant.pin));
  const isOwner = meta.settings && verifyPassword(providedAuth, meta.settings.ownerPassword);
  const isAdminPin = !isOwner && providedAuth && (meta.participants || []).some(
    (p) => p.isAdmin && p.pin && verifyPassword(providedAuth, p.pin)
  );
  if (isSelf || isOwner || isAdminPin) return picksValue;

  const now = Date.now();
  const openRoundIds = new Set(
    (meta.rounds || [])
      .filter((r) => new Date(r.deadline).getTime() > now)
      .map((r) => r.id)
  );
  const filtered = {};
  for (const roundId in picksValue) {
    if (!openRoundIds.has(roundId)) filtered[roundId] = picksValue[roundId];
  }
  return filtered;
}

// Rejects a picks write if it tries to change anything for a round whose
// deadline has already passed — checked here, not just hidden in the UI.
async function validatePicksDeadline(info, oldValue, newValue) {
  const meta = await getRow(info.metaKey);
  if (!meta) return { ok: true }; // no meta yet — can't check deadlines, allow (bootstrap)
  const roundsById = {};
  (meta.rounds || []).forEach((r) => { roundsById[r.id] = r; });
  const old = oldValue || {};
  const now = Date.now();
  for (const roundId in newValue) {
    const round = roundsById[roundId];
    if (!round) continue; // unknown round id — ignore rather than block on it
    if (now <= new Date(round.deadline).getTime()) continue; // still open, fine
    const oldRoundPicks = JSON.stringify(old[roundId] || {});
    const newRoundPicks = JSON.stringify(newValue[roundId] || {});
    if (oldRoundPicks !== newRoundPicks) return { ok: false };
  }
  return { ok: true };
}

async function getPlatformHash() {
  const platValue = await getRow("platform_settings");
  return platValue && platValue.dashboardPassword ? platValue.dashboardPassword : process.env.PLATFORM_PASSWORD;
}

// GET a value by key — quiniela/platform records never leave the server with
// their real password or PINs, regardless of who's asking. Picks additionally
// get filtered down to closed-round-only unless the requester proves they're
// the owning participant or an admin/owner of that quiniela.
app.get("/api/kv/:key", async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [req.params.key]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    const info = classifyKey(req.params.key);
    let value = r.rows[0].value;
    if (info.kind === "quiniela-meta") value = stripQuinielaSecrets(value);
    else if (info.kind === "platform") value = stripPlatformSecrets(value);
    else if (info.kind === "picks") value = await filterPicksForRequest(req, info, value);
    res.json({ key: req.params.key, value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// SET a value by key (upsert) — writes to quiniela/platform records require the
// matching credential, checked here on the server, not just in the browser.
app.post("/api/kv/:key", async (req, res) => {
  try {
    const value = req.body ? req.body.value : undefined;
    if (value === undefined) return res.status(400).json({ error: "missing_value" });
    const info = classifyKey(req.params.key);
    const providedOwnerAuth = req.get("x-qracks-auth") || "";
    const providedPlatformAuth = req.get("x-qracks-platform-auth") || "";

    let finalValue = value;

    if (info.kind === "platform") {
      const oldValue = await getRow(req.params.key);
      const currentHash = oldValue && oldValue.dashboardPassword ? oldValue.dashboardPassword : process.env.PLATFORM_PASSWORD;
      if (!verifyPassword(providedPlatformAuth, currentHash)) {
        return res.status(403).json({ error: "unauthorized" });
      }
      finalValue = mergeProtectedPlatformFields(oldValue, value);
    } else if (info.kind === "quiniela-meta") {
      const oldValue = await getRow(info.metaKey);
      let authTier = null;
      if (oldValue) {
        const platformHash = await getPlatformHash();
        authTier = resolveMetaAuthTier(oldValue, providedOwnerAuth, providedPlatformAuth, platformHash);
        if (!authTier) return res.status(403).json({ error: "unauthorized" });
      }
      // If oldValue is null, this is a brand-new quiniela being created — nothing to protect yet.
      finalValue = mergeProtectedMetaFields(oldValue, value, authTier);
    } else if (info.kind === "picks") {
      const oldPicks = await getRow(req.params.key);
      const metaValue = await getRow(info.metaKey);
      if (metaValue) {
        const participant = (metaValue.participants || []).find((p) => p.id === info.participantId);
        if (participant && participant.pin) {
          if (!verifyPassword(providedOwnerAuth, participant.pin)) {
            return res.status(403).json({ error: "unauthorized" });
          }
        }
        // No PIN set for this participant (or participant not found yet, e.g. brand-new
        // quiniela still being set up) — picks stay open, matching today's behavior.
      }
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

// DELETE a value by key — only ever used by the platform dashboard in this app
// (deleting a whole quiniela), so it requires the platform password.
app.delete("/api/kv/:key", async (req, res) => {
  try {
    const info = classifyKey(req.params.key);
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
// These exist so participants can register themselves and manage their own PIN
// without needing the quiniela admin's password — while everything else that
// touches quiniela-meta (results, rounds, settings, other people's PINs) still
// goes through the authenticated POST /api/kv/:key above. All three
// "verify-*" endpoints are rate-limited and answer with the same generic
// {ok:false} shape whether the record doesn't exist or the credential is
// simply wrong — never revealing which.

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
    const ok = !!participant && (!participant.pin || verifyPassword(pin, participant.pin));
    res.json({ ok });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

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
    participant.pin = hashPassword(newPin); // hashed at rest, never returned by GET
    await putRow(metaKey, value);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/register-quiniela", async (req, res) => {
  try {
    const { slug, name, creatorName, contact, exempt } = req.body || {};
    const cleanSlug = String(slug || "").trim();
    if (!cleanSlug || !name) return res.status(400).json({ error: "invalid_params" });
    const idx = (await getRow("platform_index")) || { quinielas: [] };
    if (!Array.isArray(idx.quinielas)) idx.quinielas = [];
    if (idx.quinielas.some((q) => q.slug === cleanSlug)) {
      return res.status(409).json({ error: "slug_taken" });
    }
    const entry = { slug: cleanSlug, name, creatorName: creatorName || "", createdAt: new Date().toISOString() };
    if (contact) entry.contact = contact;
    if (exempt) entry.exempt = true;
    idx.quinielas.push(entry);
    await putRow("platform_index", idx);
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

// Moving a quiniela from the shared root link to its own /q/:slug is done
// entirely here, in one transaction: the server reads the real (unstripped)
// meta and every participant's picks straight from the database and copies
// them — the browser never sees the password hash or anyone's PIN in transit.
// If anything fails partway through, the whole thing rolls back and the
// original quiniela is left exactly as it was.
app.post("/api/migrate-quiniela", async (req, res) => {
  const { toSlug } = req.body || {};
  const fromKey = "quiniela_meta_v1";
  const cleanSlug = String(toSlug || "").trim();
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
    if (existing) { await client.query("ROLLBACK"); return res.status(409).json({ error: "slug_taken" }); }

    await putRow(targetKey, meta, client);

    for (const p of (meta.participants || [])) {
      const oldPicksKey = `quiniela_picks_${p.id}_v1`;
      const picks = await getRow(oldPicksKey, client);
      if (picks) await putRow(`quiniela:${cleanSlug}:picks:${p.id}`, picks, client);
    }

    const idx = (await getRow("platform_index", client)) || { quinielas: [] };
    if (!Array.isArray(idx.quinielas)) idx.quinielas = [];
    if (!idx.quinielas.some((q) => q.slug === cleanSlug)) {
      const creator = (meta.participants || []).find((p) => p.isAdmin) || meta.participants[0] || {};
      idx.quinielas.push({
        slug: cleanSlug, name: meta.groupName, creatorName: creator.name || "",
        createdAt: new Date().toISOString(), exempt: true
      });
      await putRow("platform_index", idx, client);
    }

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

// Simple health check (also useful for uptime pingers to avoid free-tier sleep)
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- Dynamic link previews for /q/:slug ----------
// WhatsApp/Facebook/etc. read <meta property="og:*"> tags from the raw HTML they fetch —
// they don't run our JavaScript. So for a specific quiniela's link to show its own name
// instead of the generic "QRACKS" text, we rewrite those tags on the server before sending
// the page, only for this one route. Everything else (the actual app) is untouched;
// the browser gets the exact same index.html and boots the SPA normally either way.
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
