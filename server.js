// Quiniela Liga MX — minimal backend
// Serves the static frontend and a tiny generic key-value API backed by Postgres.
// The frontend already treats persistence as get(key)/set(key,value), so this
// server just needs to implement that contract — no app-specific logic here.

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

// ---------- password hashing (scrypt, no extra dependency needed) ----------
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
  if (plain == null || !stored) return false;
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
app.use(express.json({ limit: "3mb" }));

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL environment variable. Set it to your Postgres connection string.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
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

const PLATFORM_KEYS = new Set(["platform_settings", "platform_index", "platform_payment_log"]);
const DEFAULT_PLATFORM_PASSWORD = "plataforma2026"; // matches the client-side default in index.html

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

// A write only ever includes the fields the client actually changed — because
// the client's own copy never has the real password/PINs (they're stripped on
// the way out, above). This restores whatever the client didn't explicitly set,
// and hashes anything it did.
function mergeProtectedMetaFields(oldValue, newValue) {
  const merged = JSON.parse(JSON.stringify(newValue));
  const oldSettings = (oldValue && oldValue.settings) || null;
  if (!merged.settings) merged.settings = {};
  const incomingPw = merged.settings.ownerPassword;
  if (!incomingPw) {
    if (oldSettings && oldSettings.ownerPassword) {
      merged.settings.ownerPassword = isHashed(oldSettings.ownerPassword)
        ? oldSettings.ownerPassword
        : hashPassword(oldSettings.ownerPassword); // opportunistically migrate on any write, not just password changes
    }
  } else if (!isHashed(incomingPw)) {
    merged.settings.ownerPassword = hashPassword(incomingPw);
  }
  const oldParticipants = (oldValue && Array.isArray(oldValue.participants)) ? oldValue.participants : [];
  const oldById = {};
  oldParticipants.forEach((p) => { oldById[p.id] = p; });
  if (Array.isArray(merged.participants)) {
    merged.participants.forEach((p) => {
      if (!("pin" in p)) {
        const old = oldById[p.id];
        if (old && "pin" in old) p.pin = old.pin;
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

// GET a value by key — quiniela/platform records never leave the server with
// their real password or PINs, regardless of who's asking.
app.get("/api/kv/:key", async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [req.params.key]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    const info = classifyKey(req.params.key);
    let value = r.rows[0].value;
    if (info.kind === "quiniela-meta") value = stripQuinielaSecrets(value);
    else if (info.kind === "platform") value = stripPlatformSecrets(value);
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
      const oldRow = await pool.query("SELECT value FROM kv WHERE key = $1", [req.params.key]);
      const oldValue = oldRow.rows.length ? oldRow.rows[0].value : null;
      const currentHash = oldValue && oldValue.dashboardPassword ? oldValue.dashboardPassword : DEFAULT_PLATFORM_PASSWORD;
      if (!verifyPassword(providedPlatformAuth, currentHash)) {
        return res.status(403).json({ error: "unauthorized" });
      }
      finalValue = mergeProtectedPlatformFields(oldValue, value);
    } else if (info.kind === "quiniela-meta") {
      const oldRow = await pool.query("SELECT value FROM kv WHERE key = $1", [info.metaKey]);
      const oldValue = oldRow.rows.length ? oldRow.rows[0].value : null;
      if (oldValue) {
        // Existing quiniela: must prove you're its admin (either the owner password,
        // or the PIN of a participant flagged as admin — that's how the app already
        // treats "logged in as an admin" everywhere except the extra-sensitive
        // Ajustes screen), OR be the platform owner.
        const ownerOk = oldValue.settings && verifyPassword(providedOwnerAuth, oldValue.settings.ownerPassword);
        const adminPinOk = !ownerOk && providedOwnerAuth && (oldValue.participants || []).some(
          (p) => p.isAdmin && p.pin && verifyPassword(providedOwnerAuth, p.pin)
        );
        let platformOk = false;
        if (!ownerOk && !adminPinOk && providedPlatformAuth) {
          const platRow = await pool.query("SELECT value FROM kv WHERE key = $1", ["platform_settings"]);
          const platValue = platRow.rows.length ? platRow.rows[0].value : null;
          const platHash = platValue && platValue.dashboardPassword ? platValue.dashboardPassword : DEFAULT_PLATFORM_PASSWORD;
          platformOk = verifyPassword(providedPlatformAuth, platHash);
        }
        if (!ownerOk && !adminPinOk && !platformOk) return res.status(403).json({ error: "unauthorized" });
      }
      // If oldValue is null, this is a brand-new quiniela being created — nothing to protect yet.
      finalValue = mergeProtectedMetaFields(oldValue, value);
    } else if (info.kind === "picks") {
      const metaRow = await pool.query("SELECT value FROM kv WHERE key = $1", [info.metaKey]);
      const metaValue = metaRow.rows.length ? metaRow.rows[0].value : null;
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
    }

    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [req.params.key, JSON.stringify(finalValue)]
    );
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
      const platRow = await pool.query("SELECT value FROM kv WHERE key = $1", ["platform_settings"]);
      const platValue = platRow.rows.length ? platRow.rows[0].value : null;
      const platHash = platValue && platValue.dashboardPassword ? platValue.dashboardPassword : DEFAULT_PLATFORM_PASSWORD;
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
// goes through the authenticated POST /api/kv/:key above.

app.post("/api/verify-owner", async (req, res) => {
  try {
    const { metaKey, password } = req.body || {};
    if (!metaKey) return res.status(400).json({ error: "missing_metaKey" });
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [metaKey]);
    if (!r.rows.length) return res.json({ ok: false });
    const stored = r.rows[0].value && r.rows[0].value.settings ? r.rows[0].value.settings.ownerPassword : null;
    res.json({ ok: verifyPassword(password, stored) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/verify-platform", async (req, res) => {
  try {
    const { password } = req.body || {};
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", ["platform_settings"]);
    const stored = r.rows.length && r.rows[0].value.dashboardPassword ? r.rows[0].value.dashboardPassword : DEFAULT_PLATFORM_PASSWORD;
    res.json({ ok: verifyPassword(password, stored) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/verify-pin", async (req, res) => {
  try {
    const { metaKey, participantId, pin } = req.body || {};
    if (!metaKey || !participantId) return res.status(400).json({ error: "missing_params" });
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [metaKey]);
    if (!r.rows.length) return res.json({ ok: false });
    const participant = (r.rows[0].value.participants || []).find((p) => p.id === participantId);
    if (!participant) return res.json({ ok: false });
    if (!participant.pin) return res.json({ ok: true, noPinSet: true }); // nothing to check against
    res.json({ ok: verifyPassword(pin, participant.pin) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/set-pin", async (req, res) => {
  try {
    const { metaKey, participantId, currentPin, newPin } = req.body || {};
    if (!metaKey || !participantId || !/^\d{4}$/.test(String(newPin || ""))) {
      return res.status(400).json({ error: "invalid_params" });
    }
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [metaKey]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    const value = r.rows[0].value;
    const participant = (value.participants || []).find((p) => p.id === participantId);
    if (!participant) return res.status(404).json({ error: "participant_not_found" });
    if (participant.pin && !verifyPassword(currentPin, participant.pin)) {
      return res.status(403).json({ error: "wrong_current_pin" });
    }
    participant.pin = newPin; // PINs are 4-digit and low-stakes by design — stored as-is, never returned by GET
    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [metaKey, JSON.stringify(value)]
    );
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
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", ["platform_index"]);
    const idx = r.rows.length ? r.rows[0].value : { quinielas: [] };
    if (!Array.isArray(idx.quinielas)) idx.quinielas = [];
    if (idx.quinielas.some((q) => q.slug === cleanSlug)) {
      return res.status(409).json({ error: "slug_taken" });
    }
    const entry = { slug: cleanSlug, name, creatorName: creatorName || "", createdAt: new Date().toISOString() };
    if (contact) entry.contact = contact;
    if (exempt) entry.exempt = true;
    idx.quinielas.push(entry);
    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      ["platform_index", JSON.stringify(idx)]
    );
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
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [metaKey]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    const value = r.rows[0].value;
    if (!Array.isArray(value.participants)) value.participants = [];
    if (value.participants.some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return res.status(409).json({ error: "name_taken" });
    }
    const newParticipant = {
      id: "p_" + crypto.randomBytes(9).toString("hex"),
      name: cleanName, isAdmin: false, paid: false, pin
    };
    value.participants.push(newParticipant);
    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [metaKey, JSON.stringify(value)]
    );
    res.json({ ok: true, participant: { id: newParticipant.id, name: newParticipant.name, isAdmin: false, paid: false, hasPin: true } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
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
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", ["quiniela:" + slug + ":meta"]);
    let html = getIndexHtml();
    if (r.rows.length && r.rows[0].value && r.rows[0].value.groupName) {
      const name = escapeHtml(r.rows[0].value.groupName);
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
