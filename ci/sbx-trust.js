// Sandbox: trusted-device cookies earned before a credential change must not
// keep their exemption afterwards (P1 on 8753f8c: 30 compared guesses through
// 3 old cookies). One runner = one IP. Prints statuses only; PINs and
// passwords are random and never printed.
const BASE = process.env.SANDBOX;
const crypto = require("crypto");
const rnd = (n) => crypto.randomBytes(n).toString("hex");
function Browser() { const m = new Map(); return { take(r) { for (const c of r.sc || []) { const kv = c.split(";")[0]; const i = kv.indexOf("="); m.set(kv.slice(0, i), kv.slice(i + 1)); } return r; }, get h() { return [...m].map(([k, v]) => k + "=" + v).join("; "); }, has(p) { return [...m.keys()].some((k) => k.startsWith(p)); } }; }
async function call(method, path, body, { cookie, headers } = {}) {
  const h = { "Content-Type": "application/json", ...(headers || {}) }; if (cookie) h.Cookie = cookie;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: j, sc: r.headers.getSetCookie() };
}
const fmt = (r) => r.status === 429 ? `429 retryAfterSeconds=${r.body && r.body.retryAfterSeconds}` : `${r.status} ${JSON.stringify(r.body)}`;
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
async function tallyOf(results) {
  const t = { compared: 0, refused: 0, other: [] };
  for (const r of results) { if (r.status === 429) t.refused++; else if (r.status === 200 && r.body && r.body.ok === false) t.compared++; else t.other.push(fmt(r)); }
  return t;
}
(async () => {
  const mode = process.argv[2];
  const slug = "sbx-tr" + mode + "-" + Date.now().toString(36), metaKey = `quiniela:${slug}:meta`, K = "/api/kv/" + encodeURIComponent(metaKey);
  const owner = "pw-" + rnd(8), anaPhone = Browser();
  const c = anaPhone.take(await call("POST", "/api/create-quiniela", { slug, groupName: "Prueba trust", creatorName: "Ana", contact: "sandbox-test", password: owner }));
  const ana = (await call("GET", K)).body.value.participants[0];
  anaPhone.take(await call("POST", "/api/set-pin", { metaKey, participantId: ana.id, newPin: String(1000 + crypto.randomInt(9000)) }, { cookie: anaPhone.h }));
  console.log(ts(), `quiniela ${slug}: create ${c.status}`);
  if (mode === "pin" || mode === "pinpar") {
    let pin = String(1000 + crypto.randomInt(9000));
    const betoPhone = Browser();
    const reg = betoPhone.take(await call("POST", "/api/self-register", { metaKey, name: "Beto", pin, slug }));
    const beto = reg.body.participant;
    const old = [];
    for (let i = 0; i < 3; i++) { const b = Browser(); const r = b.take(await call("POST", "/api/verify-pin", { metaKey, participantId: beto.id, pin }, { cookie: b.h })); old.push(b); console.log(ts(), `old browser ${i + 1}: verify-pin with the right PIN ${fmt(r)}, trusted-device cookie: ${b.has("qracks_trust_")}`); }
    let next; do next = String(1000 + crypto.randomInt(9000)); while (next === pin);
    const ch = betoPhone.take(await call("POST", "/api/set-pin", { metaKey, participantId: beto.id, currentPin: pin, newPin: next }, { cookie: betoPhone.h }));
    pin = next;
    console.log(ts(), `Beto changes his PIN on his phone: ${ch.status}`);
    const wrong = (k) => { let p = String(5000 + k); if (p === pin) p = String(4000 + k); return p; };
    const jobs = []; let k = 0;
    for (const b of old) for (let i = 0; i < 10; i++) { const kk = k++; jobs.push(() => call("POST", "/api/verify-pin", { metaKey, participantId: beto.id, pin: wrong(kk) }, { cookie: b.h })); }
    const results = mode === "pinpar" ? await Promise.all(jobs.map((j) => j())) : await (async () => { const out = []; for (const j of jobs) out.push(await j()); return out; })();
    const t = await tallyOf(results);
    console.log(ts(), `${mode === "pinpar" ? "30 PARALLEL" : "30"} wrong guesses through the 3 old cookies, same IP: compared ${t.compared}, refused ${t.refused}, other ${JSON.stringify(t.other)}  (8753f8c: compared 30)`);
    console.log(ts(), "old cookie + the NEW right PIN during the wait:", fmt(await call("POST", "/api/verify-pin", { metaKey, participantId: beto.id, pin }, { cookie: old[0].h })), "(no longer exempt)");
    console.log(ts(), "Beto's phone (made the change) + the new PIN during the wait:", fmt(await call("POST", "/api/verify-pin", { metaKey, participantId: beto.id, pin }, { cookie: betoPhone.h })), "(trusted for the new PIN)");
  }
  if (mode === "owner") {
    const old = [];
    for (let i = 0; i < 3; i++) { const b = Browser(); const r = b.take(await call("POST", "/api/verify-owner", { metaKey, password: owner }, { cookie: b.h })); old.push(b); console.log(ts(), `old browser ${i + 1}: verify-owner with the right password ${fmt(r)}, trusted-device cookie: ${b.has("qracks_trust_")}`); }
    const next = "pw2-" + rnd(8);
    const meta = (await call("GET", K, null, { cookie: anaPhone.h, headers: { "X-Qracks-Auth": owner } })).body.value;
    meta.settings.ownerPassword = next;
    const w = anaPhone.take(await call("POST", K, { value: meta }, { cookie: anaPhone.h, headers: { "X-Qracks-Auth": owner } }));
    console.log(ts(), `Ana changes the admin password in Ajustes: ${w.status}`);
    const results = []; let k = 0;
    for (const b of old) for (let i = 0; i < 10; i++) results.push(await call("POST", "/api/verify-owner", { metaKey, password: "nope-" + (k++) }, { cookie: b.h }));
    const t = await tallyOf(results);
    console.log(ts(), `30 wrong passwords through the 3 old cookies, same IP: compared ${t.compared}, refused ${t.refused}, other ${JSON.stringify(t.other)}  (8753f8c: compared 30)`);
    console.log(ts(), "Ana's phone (made the change) + the new password during the wait:", fmt(await call("POST", "/api/verify-owner", { metaKey, password: next }, { cookie: anaPhone.h })), "(trusted for the new password)");
  }
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
