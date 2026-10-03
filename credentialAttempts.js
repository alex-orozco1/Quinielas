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
// did not match. A target is one version of one credential: the admin
// password, or one participant's PIN (server.js namespaces them and appends a
// version, so resetting a credential under attack gives it a fresh budget). server.js compares a value
// only against the target the request names (see checkCredential), so a
// match is a real success and is refunded, and a miss is a real guess.
//
// Budgets:
//   ip      one network guessing against one quiniela.
//   net     one network guessing against all quinielas (a looser ceiling).
//   target  everyone guessing one credential, across any number of IPs. One
//           bucket per credential, remembering which version (PIN or password
//           as currently set) it counts against; a new version starts empty,
//           so resetting a credential under attack recovers it, and memory
//           stays bounded by the number of credentials that exist.
//           150 distinct wrong values a day against a 10,000-value PIN space
//           puts a full search at over two months.
//   device  a browser that has already proven this exact credential (it holds
//           a signed trusted-device cookie for it). It skips the ip and target
//           budgets and has its own, so an attack on a credential cannot lock
//           its owner out of the devices they already use.
//
// How it avoids locking out real people:
//   - Only failures count. Sending a correct credential never consumes budget.
//   - The SAME wrong value counts once per window. A tab that keeps a stale PIN
//     in memory after a reset resends it on every request; that is one
//     failure, not hundreds. Guessing needs distinct values.
//   - Being throttled only switches off header/body credentials. Session
//     cookies still work.
//   - Trusted devices are exempt from the ip and target budgets (see above).
//
// Concurrency: the budget is reserved synchronously BEFORE the slow scrypt
// comparison and refunded only if the request matched. Node runs this on one
// thread, so N parallel guesses cannot all slip past the check before the
// first one is recorded. The state lives in this process; render.yaml runs a
// single instance. More instances would each keep their own budget.

const crypto = require("crypto");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const DEFAULT_RULES = [
  // One network against one quiniela: slows spraying one value across its
  // participants. Scoped to the quiniela so that people sharing an IP (a
  // family, a carrier NAT) mistyping in one quiniela never block another.
  { name: "ip-15m", scope: "ip", windowMs: 15 * MINUTE, max: 20 },
  { name: "ip-24h", scope: "ip", windowMs: 24 * HOUR, max: 100 },
  // One network against ALL quinielas: a looser ceiling on spraying across
  // quinielas, which the per-credential budget alone would not see.
  { name: "net-15m", scope: "net", windowMs: 15 * MINUTE, max: 60 },
  { name: "net-24h", scope: "net", windowMs: 24 * HOUR, max: 300 },
  { name: "target-15m", scope: "target", windowMs: 15 * MINUTE, max: 30 },
  { name: "target-24h", scope: "target", windowMs: 24 * HOUR, max: 150 },
  { name: "device-15m", scope: "device", windowMs: 15 * MINUTE, max: 10 },
  { name: "device-24h", scope: "device", windowMs: 24 * HOUR, max: 50 },
];

function createCredentialAttemptLimiter(options = {}) {
  const rules = options.rules || DEFAULT_RULES;
  const ruleByName = new Map(rules.map((r) => [r.name, r]));
  const clock = options.now || Date.now;
  // ip, net and device buckets can be created by anyone (a new address, a new
  // cookie id), so they are capped; target buckets only exist for credentials
  // that exist (server.js never reserves against a missing one).
  const maxOpenBuckets = options.maxOpenBuckets || 50000;
  const fingerprintKey = options.fingerprintKey || crypto.randomBytes(32);
  // Bucket ids are keyed hashes, so what gets persisted (see onChange/load)
  // names no IP address, quiniela or participant. The key must be the same
  // across restarts for persisted buckets to be found again; server.js
  // derives it from the server secret. A function, because that secret is
  // only read from the database after this module is set up.
  const idKey = typeof options.idKey === "function" ? options.idKey : (() => options.idKey || fingerprintKey);
  const onChange = typeof options.onChange === "function" ? options.onChange : null;
  const buckets = { ip: new Map(), net: new Map(), target: new Map(), device: new Map() };

  function fingerprint(quiniela, target, value) {
    return crypto.createHmac("sha256", fingerprintKey)
      .update(String(quiniela) + "\0" + String(target) + "\0" + String(value))
      .digest("hex");
  }
  function bucketId(rule, scopeValue) {
    return crypto.createHmac("sha256", idKey())
      .update("bucket\0" + rule.name + "\0" + String(scopeValue))
      .digest("hex").slice(0, 40);
  }
  function snapshot(id, rule, bucket) {
    return { id, rule: rule.name, scope: rule.scope, windowStart: bucket.windowStart,
      windowMs: rule.windowMs, count: bucket.count, version: bucket.version == null ? null : bucket.version };
  }
  function changed(id, rule, bucket) {
    if (onChange) onChange(snapshot(id, rule, bucket));
  }
  function store(rule, id, bucket) {
    const map = buckets[rule.scope];
    map.delete(id); // re-insert so Map order tracks recency for eviction
    map.set(id, bucket);
    if (rule.scope !== "target" && map.size > maxOpenBuckets) {
      map.delete(map.keys().next().value);
    }
  }

  function bucketFor(rule, scopeValue, now, version) {
    const id = bucketId(rule, scopeValue);
    let bucket = buckets[rule.scope].get(id);
    if (!bucket || now - bucket.windowStart >= rule.windowMs || bucket.version !== version) {
      bucket = { id, rule, windowStart: now, count: 0, seen: new Set(), version, generation: (bucket ? bucket.generation + 1 : 0) };
      store(rule, id, bucket);
    }
    return bucket;
  }

  // Reserve budget for one value against one target. Returns
  //   { blocked: true, retryAfterMs }     when any applicable bucket is full, or
  //   { blocked: false, settle(matched) } otherwise.
  // settle(true) refunds; settle(false) keeps the attempt counted. settle is
  // idempotent.
  // `version` identifies the credential as currently stored (server.js passes
  // a keyed hash of the stored hash); only the target bucket tracks it.
  function begin({ ip, quiniela, target, version, value, trustedDeviceId }) {
    const now = clock();
    const q = quiniela || "_root";
    const t = String(target);
    const v = version == null ? "" : String(version);
    const fp = fingerprint(q, t + "@" + v, value);
    const network = ip || "unknown";
    const scopeValues = trustedDeviceId
      ? { device: String(trustedDeviceId) }
      : { ip: network + "\0" + q, net: network, target: q + "\0" + t };
    const touched = [];
    let blocked = false;
    let retryAfterMs = 0;
    for (const rule of rules) {
      if (!(rule.scope in scopeValues)) continue;
      const bucket = bucketFor(rule, scopeValues[rule.scope], now, rule.scope === "target" ? v : undefined);
      if (bucket.seen.has(fp)) continue; // this exact value already counted here
      if (bucket.count >= rule.max) {
        blocked = true;
        retryAfterMs = Math.max(retryAfterMs, bucket.windowStart + rule.windowMs - now);
      }
      touched.push({ bucket, generation: bucket.generation });
    }
    if (blocked) return { blocked: true, retryAfterMs };
    for (const x of touched) {
      x.bucket.count++;
      x.bucket.seen.add(fp);
      changed(x.bucket.id, x.bucket.rule, x.bucket);
    }
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
            changed(x.bucket.id, x.bucket.rule, x.bucket);
          }
        }
      },
    };
  }

  // Restores persisted buckets (after a restart). Rows for rules that no
  // longer exist, or whose window length changed, or that already expired,
  // are ignored. Which exact values were tried is not persisted, so after a
  // restart a value already counted may be counted once more: stricter, never
  // looser.
  function load(rows) {
    const now = clock();
    let restored = 0;
    for (const row of rows || []) {
      const rule = row && ruleByName.get(row.rule);
      if (!rule || Number(row.windowMs) !== rule.windowMs) continue;
      const windowStart = Number(row.windowStart);
      const count = Math.max(0, Math.min(Number(row.count) || 0, rule.max));
      if (!Number.isFinite(windowStart) || now - windowStart >= rule.windowMs || windowStart > now) continue;
      const id = String(row.id);
      const existing = buckets[rule.scope].get(id);
      if (existing && existing.windowStart >= windowStart && existing.count >= count) continue;
      store(rule, id, { id, rule, windowStart, count, seen: new Set(),
        version: rule.scope === "target" ? (row.version == null ? "" : String(row.version)) : undefined, generation: 0 });
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
  }

  function size() { return buckets.ip.size + buckets.net.size + buckets.target.size + buckets.device.size; }

  return { begin, load, sweep, size };
}

module.exports = { createCredentialAttemptLimiter, DEFAULT_RULES };
