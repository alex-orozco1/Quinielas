// Quiniela Liga MX — minimal backend
// Serves the static frontend and a tiny generic key-value API backed by Postgres.
// The frontend already treats persistence as get(key)/set(key,value), so this
// server just needs to implement that contract — no app-specific logic here.

const express = require("express");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

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

// GET a value by key
app.get("/api/kv/:key", async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM kv WHERE key = $1", [req.params.key]);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ key: req.params.key, value: r.rows[0].value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// SET a value by key (upsert)
app.post("/api/kv/:key", async (req, res) => {
  try {
    const value = req.body ? req.body.value : undefined;
    if (value === undefined) return res.status(400).json({ error: "missing_value" });
    await pool.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [req.params.key, JSON.stringify(value)]
    );
    res.json({ key: req.params.key, ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// DELETE a value by key
app.delete("/api/kv/:key", async (req, res) => {
  try {
    await pool.query("DELETE FROM kv WHERE key = $1", [req.params.key]);
    res.json({ key: req.params.key, deleted: true });
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
