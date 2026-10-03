// credentialAttempts.js — a limit on FAILED credential checks.
//
// Every admin PIN, participant PIN and owner password is checked by comparing
// what the caller sent against a scrypt hash. Before this, only a few
// endpoints (/api/verify-pin, /api/set-pin, /api/verify-owner) were behind a
// per-IP request limit, while GET/POST /api/kv and every other route that
// reads X-Qracks-Auth answered as many guesses as anyone cared to send. The
// difference between the admin view and the public view of a quiniela was
// enough of an oracle to find a 4-digit admin PIN in about 20 seconds.
//
// What is counted: one attempt per (quiniela, target, value) per request that
// did not match. A target is one credential: the admin password, or one
// participant's PIN (server.js namespaces them and passes a version, so
// resetting a credential gives it a fresh state). server.js compares a value
// only against the target the request names (see checkCredential), so a match
// is a real success and a miss is a real guess.
//
// Budgets:
//   ip      one network guessing against one quiniela (fixed windows).
//   net     one network guessing against all quinielas (fixed windows).
//   target  everyone guessing one credential, across any number of networks:
//           a PROGRESSIVE WAIT, not a hard lockout (see PROGRESSIVE below).
//           The first FREE failures cost nothing; after that each attempt has
//           to wait base × 2^(failures − FREE) since the last failure, capped
//           at cap. The count is forgotten after forget without failures, on
//           a successful EXPLICIT login (resetOnSuccess: a person typed the
//           credential into verify-pin / verify-owner / verify-platform /
//           set-pin), and when the credential changes (new version). Any
//           other success (the PIN a browser resends in X-Qracks-Auth on
//           every request) only gives back its own reservation: otherwise an
//           active owner would hand an attacker a fresh 10 free guesses on
//           every page load.
//           With the defaults a sustained attacker gets about 96 guesses a day
//           (one per 15 minutes); a person never waits more than 15 minutes
//           for their next try.
//   device  a browser that has already proven this exact credential (signed
//           trusted-device cookie). It skips the ip, net and target budgets
//           and has its own windows, so an attack on a credential cannot lock
//           its owner out of the devices they already use.
//
// Rejected requests change nothing: a request that arrives while it has to
// wait is answered with the time left and neither counts as a failure nor
// moves the wait. Only a request that was allowed through, and then did not
// match, counts.
//
// How it avoids locking out real people:
//   - Only failures count; an explicit login resets the credential's state.
//   - The SAME wrong value counts once: a tab that keeps a stale PIN in memory
//     resends it on every request; that is one failure, not hundreds. It is
//     still subject to the wait (otherwise "was this value tried before?"
//     could be asked for free while everyone else waits).
//   - Being throttled only switches off header/body credentials. Session
//     cookies still work.
//
// Concurrency: the attempt is reserved synchronously BEFORE the slow scrypt
// comparison (window counts go up, the progressive state records a failure
// "now"), and undone only if it matched. Node runs this on one thread, so N
// parallel guesses cannot all slip past the check before the first one is
// recorded. The state lives in this process (persisted for restarts, see
// onChange/load); render.yaml runs a single instance. More instances would
// each keep their own budget.

const crypto = require("crypto");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const DEFAULT_RULES = [
  // One network against one quiniela: slows spraying one value across its
  // participants. Scoped to the quiniela so that people sharing an IP (a
  // family, a carrier NAT) mistyping in one quiniela never block another.
  { name: "ip-15m", scope: "ip", windowMs: 15 * MINUTE, max: 20 },
  { name: "ip-24h", scope: "ip", windowMs: 24 * HOUR, max: 100 },
  // One network against ALL quinielas: a looser ceiling on spraying across
  // quinielas, which the per-credential state alone would not see.
  { name: "net-15m", scope: "net", windowMs: 15 * MINUTE, max: 60 },
  { name: "net-24h", scope: "net", windowMs: 24 * HOUR, max: 300 },
  { name: "device-15m", scope: "device", windowMs: 15 * MINUTE, max: 10 },
  { name: "device-24h", scope: "device", windowMs: 24 * HOUR, max: 50 },
];

const PROGRESSIVE = {
  rule: "target-progressive",
  free: 10,
  baseMs: 15 * SECOND,
  capMs: 15 * MINUTE,
  forgetMs: 24 * HOUR,
};

// How long after the last failure the next attempt is allowed, for a target
// that has `failures` failures on record.
function progressiveWaitMs(failures, cfg = PROGRESSIVE) {
  if (failures < cfg.free) return 0;
  const exp = failures - cfg.free;
  if (exp >= 40) return cfg.capMs;
  return Math.min(cfg.baseMs * 2 ** exp, cfg.capMs);
}

function createCredentialAttemptLimiter(options = {}) {
  const rules = options.rules || DEFAULT_RULES;
  const cfg = { ...PROGRESSIVE, ...(options.progressive || {}) };
  const ruleByName = new Map(rules.map((r) => [r.name, r]));
  const clock = options.now || Date.now;
  // ip, net and device buckets can be created by anyone (a new address, a new
  // cookie id), so they are capped; target states only exist for credentials
  // that exist (server.js never reserves against a missing one).
  const maxOpenBuckets = options.maxOpenBuckets || 50000;
  const fingerprintKey = options.fingerprintKey || crypto.randomBytes(32);
  // Ids are keyed hashes, so what gets persisted (see onChange/load) names no
  // IP address, quiniela or participant. The key must be the same across
  // restarts for persisted state to be found again; server.js derives it
  // from the server secret. A function, because that secret is only read
  // from the database after this module is set up.
  const idKey = typeof options.idKey === "function" ? options.idKey : (() => options.idKey || fingerprintKey);
  const onChange = typeof options.onChange === "function" ? options.onChange : null;
  const buckets = { ip: new Map(), net: new Map(), device: new Map() };
  const targets = new Map();

  function fingerprint(quiniela, target, value) {
    return crypto.createHmac("sha256", fingerprintKey)
      .update(String(quiniela) + "\0" + String(target) + "\0" + String(value))
      .digest("hex");
  }
  function hashId(label, scopeValue) {
    return crypto.createHmac("sha256", idKey())
      .update("bucket\0" + label + "\0" + String(scopeValue))
      .digest("hex").slice(0, 40);
  }

  // ---- fixed windows (ip, net, device) ----
  function windowSnapshot(bucket) {
    return { id: bucket.id, rule: bucket.rule.name, scope: bucket.rule.scope, windowStart: bucket.windowStart,
      windowMs: bucket.rule.windowMs, count: bucket.count, version: null };
  }
  function storeWindow(rule, id, bucket) {
    const map = buckets[rule.scope];
    map.delete(id); // re-insert so Map order tracks recency for eviction
    map.set(id, bucket);
    if (map.size > maxOpenBuckets) map.delete(map.keys().next().value);
  }
  function windowFor(rule, scopeValue, now) {
    const id = hashId(rule.name, scopeValue);
    let bucket = buckets[rule.scope].get(id);
    if (!bucket || now - bucket.windowStart >= rule.windowMs) {
      bucket = { id, rule, windowStart: now, count: 0, seen: new Set(), generation: (bucket ? bucket.generation + 1 : 0) };
      storeWindow(rule, id, bucket);
    }
    return bucket;
  }

  // ---- progressive state per credential (target) ----
  function targetSnapshot(t) {
    return { id: t.id, rule: cfg.rule, scope: "target", windowStart: t.lastFailAt,
      windowMs: cfg.forgetMs, count: t.failures, version: t.version };
  }
  function changed(snap) { if (onChange) onChange(snap); }
  // The state for this credential as it stands at `now`: a new version, or
  // `forget` without failures, starts from zero.
  function targetFor(scopeValue, version, now, create) {
    const id = hashId(cfg.rule, scopeValue);
    let t = targets.get(id);
    if (t && (t.version !== version || now - t.lastFailAt >= cfg.forgetMs)) {
      t.failures = 0; t.version = version; t.seen = new Set(); t.generation++;
    }
    if (!t && create) {
      t = { id, version, failures: 0, lastFailAt: now, seen: new Set(), generation: 0 };
      targets.set(id, t);
    }
    return t || null;
  }

  // Reserve one attempt of `value` against `target`. Returns
  //   { blocked: true, retryAfterMs }     when it has to wait (nothing changes), or
  //   { blocked: false, settle(matched) } otherwise.
  // settle(true) undoes the window reservations and resets the credential's
  // progressive state; settle(false) keeps the failure. settle is idempotent.
  function begin({ ip, quiniela, target, version, value, trustedDeviceId, resetOnSuccess }) {
    const now = clock();
    const q = quiniela || "_root";
    const tKey = String(target);
    const v = version == null ? "" : String(version);
    const fp = fingerprint(q, tKey + "@" + v, value);
    const targetScope = q + "\0" + tKey;
    const network = ip || "unknown";
    const windowScopes = trustedDeviceId
      ? { device: String(trustedDeviceId) }
      : { ip: network + "\0" + q, net: network };

    let blocked = false;
    let retryAfterMs = 0;
    const touched = [];
    for (const rule of rules) {
      if (!(rule.scope in windowScopes)) continue;
      const bucket = windowFor(rule, windowScopes[rule.scope], now);
      if (bucket.count >= rule.max) {
        blocked = true;
        retryAfterMs = Math.max(retryAfterMs, bucket.windowStart + rule.windowMs - now);
      }
      // This exact value already counted here: it waits like any other, but
      // is not counted twice.
      if (!bucket.seen.has(fp)) touched.push({ bucket, generation: bucket.generation });
    }

    // A trusted device does not wait on the credential's state, but a success
    // from it still resets that state.
    const t = targetFor(targetScope, v, now, !trustedDeviceId);
    let countsOnTarget = false;
    if (!trustedDeviceId) {
      const allowedAt = t.lastFailAt + progressiveWaitMs(t.failures, cfg);
      if (t.failures >= cfg.free && now < allowedAt) {
        blocked = true;
        retryAfterMs = Math.max(retryAfterMs, allowedAt - now);
      }
      countsOnTarget = !t.seen.has(fp);
    }

    // Rejected: nothing is recorded, so waiting is never prolonged by asking.
    if (blocked) return { blocked: true, retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)) };

    for (const x of touched) {
      x.bucket.count++;
      x.bucket.seen.add(fp);
      changed(windowSnapshot(x.bucket));
    }
    let undo = null;
    if (countsOnTarget) {
      undo = { failuresAfter: t.failures + 1, lastFailBefore: t.lastFailAt };
      t.failures++;
      t.lastFailAt = now;
      t.seen.add(fp);
      changed(targetSnapshot(t));
    }
    const targetGeneration = t ? t.generation : null;
    let settled = false;
    return {
      blocked: false,
      settle(matched) {
        if (settled) return;
        settled = true;
        if (!matched) return;
        for (const x of touched) {
          // A window that rolled over in the meantime already forgot this.
          if (x.bucket.generation !== x.generation) continue;
          if (x.bucket.seen.delete(fp)) {
            x.bucket.count = Math.max(0, x.bucket.count - 1);
            changed(windowSnapshot(x.bucket));
          }
        }
        if (!t || t.generation !== targetGeneration || t.version !== v) return;
        if (resetOnSuccess) {
          // A person typed the right credential: it starts over.
          if (t.failures > 0) {
            t.failures = 0; t.seen = new Set(); t.generation++; t.lastFailAt = clock();
            changed(targetSnapshot(t));
          }
        } else if (undo && t.seen.delete(fp)) {
          // Any other success only gives back its own reservation; the last
          // failure time is restored only if nothing was recorded after it.
          if (t.failures === undo.failuresAfter) t.lastFailAt = undo.lastFailBefore;
          t.failures = Math.max(0, t.failures - 1);
          changed(targetSnapshot(t));
        }
      },
    };
  }

  // Restores persisted state (after a restart). Rows for rules that no longer
  // exist, whose window length changed, or that already expired are ignored.
  // Which exact values were tried is not persisted, so after a restart a value
  // already counted may be counted once more: stricter, never looser.
  function load(rows) {
    const now = clock();
    let restored = 0;
    for (const row of rows || []) {
      if (!row) continue;
      const start = Number(row.windowStart);
      if (!Number.isFinite(start) || start > now) continue;
      if (row.rule === cfg.rule) {
        if (Number(row.windowMs) !== cfg.forgetMs || now - start >= cfg.forgetMs) continue;
        const failures = Math.max(0, Math.floor(Number(row.count) || 0));
        if (failures === 0) continue;
        const id = String(row.id);
        const existing = targets.get(id);
        if (existing && existing.lastFailAt >= start && existing.failures >= failures) continue;
        targets.set(id, { id, version: row.version == null ? "" : String(row.version), failures, lastFailAt: start, seen: new Set(), generation: 0 });
        restored++;
        continue;
      }
      const rule = ruleByName.get(row.rule);
      if (!rule || Number(row.windowMs) !== rule.windowMs || now - start >= rule.windowMs) continue;
      const count = Math.max(0, Math.min(Number(row.count) || 0, rule.max));
      const id = String(row.id);
      const existing = buckets[rule.scope].get(id);
      if (existing && existing.windowStart >= start && existing.count >= count) continue;
      storeWindow(rule, id, { id, rule, windowStart: start, count, seen: new Set(), generation: 0 });
      restored++;
    }
    return restored;
  }

  function sweep() {
    const now = clock();
    for (const map of Object.values(buckets)) {
      for (const [id, bucket] of map) {
        if (now - bucket.windowStart >= bucket.rule.windowMs) map.delete(id);
      }
    }
    for (const [id, t] of targets) {
      if (t.failures === 0 || now - t.lastFailAt >= cfg.forgetMs) targets.delete(id);
    }
  }

  function size() { return buckets.ip.size + buckets.net.size + buckets.device.size + targets.size; }

  return { begin, load, sweep, size };
}

module.exports = { createCredentialAttemptLimiter, DEFAULT_RULES, PROGRESSIVE, progressiveWaitMs };
