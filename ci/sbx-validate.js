// Sandbox validation of PR #28 @ 33809d4 (deployed as 93d906f on qracks-mon003-sandbox).
// One egress IP (this container), so each scenario uses its own quiniela to stay under the
// per-network window (20 failures / 15 min per quiniela). No secrets are printed: PINs and
// passwords are random and throwaway, and the output only shows status codes and timings.
const BASE = process.env.SANDBOX;
const crypto = require("crypto");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => crypto.randomBytes(n).toString("hex");
const pin4 = () => String(1000 + crypto.randomInt(9000));
const forged = () => `${crypto.randomInt(1, 223)}.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;
function Jar() { const m = new Map(); return { add(sc) { for (const c of sc || []) { const [kv] = c.split(";"); const i = kv.indexOf("="); m.set(kv.slice(0, i), kv.slice(i + 1)); } }, get h() { return [...m].map(([k, v]) => k + "=" + v).join("; "); } }; }
async function call(method, path, body, { cookie, auth, pid, xff } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie; if (auth) headers["X-Qracks-Auth"] = auth; if (pid) headers["X-Qracks-Participant"] = pid;
  if (xff) { headers["X-Forwarded-For"] = xff; headers["True-Client-IP"] = xff; headers["X-Real-IP"] = xff; }
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, body: json, raw: json ? null : text.slice(0, 120), sc: r.headers.getSetCookie(), retry: r.headers.get("retry-after") };
}
const fmt = (r) => r.status === 429 ? `429 retryAfterSeconds=${r.body && r.body.retryAfterSeconds} (Retry-After: ${r.retry})` : `${r.status} ${r.body ? JSON.stringify(r.body) : r.raw}`;
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
async function quiniela(tag) {
  const slug = "sbx-" + tag + "-" + Date.now().toString(36), metaKey = `quiniela:${slug}:meta`, K = "/api/kv/" + encodeURIComponent(metaKey);
  const owner = "pw-" + rnd(8), anaPin = pin4(), phone = Jar();
  const c = await call("POST", "/api/create-quiniela", { slug, groupName: "Prueba " + tag, creatorName: "Ana", contact: "sandbox-test", password: owner });
  if (c.status !== 200 && c.status !== 201) throw new Error("create " + fmt(c));
  phone.add(c.sc);
  const ana = (await call("GET", K)).body.value.participants[0];
  const sp = await call("POST", "/api/set-pin", { metaKey, participantId: ana.id, newPin: anaPin }, { cookie: phone.h }); phone.add(sp.sc);
  const vo = await call("POST", "/api/verify-owner", { metaKey, password: owner }, { cookie: phone.h }); phone.add(vo.sc);
  return { slug, metaKey, K, owner, anaPin, ana, phone, setPin: sp.status, verifyOwner: vo.status };
}
(async () => {
  const which = process.argv[2] || "all";
  const home = await call("GET", "/");
  console.log(ts(), "sandbox reachable:", home.status);

  if (which === "all" || which === "noreset") {
    // ---- 1. Frequent legitimate logins do not reset the attacker's wait ----
    const q = await quiniela("nr");
    console.log(ts(), `1. quiniela ${q.slug}: set-pin ${q.setPin}, verify-owner ${q.verifyOwner}`);
    const guessPin = (v) => call("POST", "/api/verify-pin", { metaKey: q.metaKey, participantId: q.ana.id, pin: v }, { xff: forged() });
    const guessPw = (v) => call("POST", "/api/verify-owner", { metaKey: q.metaKey, password: v }, { xff: forged() });
    let acc = 0, r, used = new Set([q.anaPin]);
    const wrongPin = () => { let p; do p = pin4(); while (used.has(p)); used.add(p); return p; };
    while ((r = await guessPin(wrongPin())).status !== 429) acc++;
    console.log(ts(), `1a. attacker (forged XFF each time) on Ana's PIN: ${acc} accepted, then ${fmt(r)}`);
    // rejected requests do not extend the wait
    for (let i = 0; i < 3; i++) { await sleep(3000); console.log(ts(), "1b. another guess during the wait:", fmt(await guessPin(wrongPin()))); }
    // Ana: 10 PIN logins + 10 Ajustes unlocks from her trusted phone, 10 admin views with her PIN header
    let okPin = 0, okOwner = 0, views = 0;
    for (let i = 0; i < 10; i++) {
      const p = await call("POST", "/api/verify-pin", { metaKey: q.metaKey, participantId: q.ana.id, pin: q.anaPin }, { cookie: q.phone.h }); if (p.body && p.body.ok) okPin++;
      const o = await call("POST", "/api/verify-owner", { metaKey: q.metaKey, password: q.owner }, { cookie: q.phone.h }); if (o.body && o.body.ok) okOwner++;
      const g = await call("GET", q.K, null, { cookie: q.phone.h, auth: q.anaPin, pid: q.ana.id }); if (g.body && g.body.value && "roundsRevision" in g.body.value) views++;
    }
    console.log(ts(), `1c. Ana on her trusted phone DURING the wait: PIN logins ok ${okPin}/10, Ajustes unlocks ok ${okOwner}/10, admin views ${views}/10`);
    console.log(ts(), "1d. attacker right after Ana's 30 logins:", fmt(await guessPin(wrongPin())));
    console.log(ts(), "1e. Ana, NEW device (no cookies), correct PIN during the wait:", fmt(await call("POST", "/api/verify-pin", { metaKey: q.metaKey, participantId: q.ana.id, pin: q.anaPin })));
    const w = await guessPin(wrongPin()); await sleep((w.body.retryAfterSeconds || 0) * 1000 + 1500);
    const fresh = Jar(); const l = await call("POST", "/api/verify-pin", { metaKey: q.metaKey, participantId: q.ana.id, pin: q.anaPin }); fresh.add(l.sc);
    console.log(ts(), "1f. Ana, new device, correct PIN once allowed:", fmt(l));
    let acc2 = 0; while ((r = await guessPin(wrongPin())).status !== 429) acc2++;
    console.log(ts(), `1g. attacker right after: ${acc2} accepted, then ${fmt(r)}  (c3c586d: 10 free again)`);
    console.log(ts(), "1h. Ana, the device she just used, during that wait:", fmt(await call("POST", "/api/verify-pin", { metaKey: q.metaKey, participantId: q.ana.id, pin: q.anaPin }, { cookie: fresh.h })));
    // the admin password, in its own quiniela (the per-network window of 20 is per quiniela and this
    // container is one network): 10 failures, Ajustes unlocks from the trusted phone, then the attacker
    const q2 = await quiniela("pw");
    const guessPw2 = (v) => call("POST", "/api/verify-owner", { metaKey: q2.metaKey, password: v }, { xff: forged() });
    let accPw = 0; while ((r = await guessPw2("x-" + rnd(6))).status !== 429) accPw++;
    console.log(ts(), `1i. quiniela ${q2.slug}, attacker on the admin password: ${accPw} accepted, then ${fmt(r)}`);
    let okU = 0; for (let i = 0; i < 10; i++) { const o = await call("POST", "/api/verify-owner", { metaKey: q2.metaKey, password: q2.owner }, { cookie: q2.phone.h }); if (o.body && o.body.ok) okU++; }
    console.log(ts(), `1j. Ana unlocks Ajustes 10 times on her trusted phone during the wait: ok ${okU}/10; attacker right after:`, fmt(await guessPw2("x-" + rnd(6))));
    console.log(ts(), `1k. TOTAL accepted: PIN ${acc + acc2} (10 free + 1 slot), admin password ${accPw}`);
  }

  if (which === "all" || which === "samevalue") {
    // ---- 3. Saving the same PIN / admin password again keeps the attacker waiting ----
    const q = await quiniela("sv");
    const guessPin = (v) => call("POST", "/api/verify-pin", { metaKey: q.metaKey, participantId: q.ana.id, pin: v }, { xff: forged() });
    const guessPw = (v) => call("POST", "/api/verify-owner", { metaKey: q.metaKey, password: v }, { xff: forged() });
    const used = new Set([q.anaPin]); const wrongPin = () => { let p; do p = pin4(); while (used.has(p)); used.add(p); return p; };
    let k = 0, r; while ((r = await guessPin(wrongPin())).status !== 429) k++;
    console.log(ts(), `3a. quiniela ${q.slug}, attacker on Ana's PIN: ${k} accepted, then ${fmt(r)}`);
    const s = await call("POST", "/api/set-pin", { metaKey: q.metaKey, participantId: q.ana.id, currentPin: q.anaPin, newPin: q.anaPin }, { cookie: q.phone.h });
    console.log(ts(), "3b. Ana saves the same PIN again (trusted phone):", s.status, "| attacker right after:", fmt(await guessPin(wrongPin())), "(33809d4: 10 accepted again)");
    k = 0; while ((r = await guessPw("x-" + rnd(6))).status !== 429) k++;
    console.log(ts(), `3c. attacker on the admin password: ${k} accepted, then ${fmt(r)}`);
    const meta = (await call("GET", q.K, null, { cookie: q.phone.h, auth: q.owner })).body.value;
    meta.settings.ownerPassword = q.owner;
    const w = await call("POST", q.K, { value: meta }, { cookie: q.phone.h, auth: q.owner });
    console.log(ts(), "3d. Ajustes saved with the same admin password typed again:", w.status, "| attacker right after:", fmt(await guessPw("x-" + rnd(6))));
  }

  if (which === "all" || which === "ipguard") {
    // ---- 2. The per-network window holds with forged IP headers, on the new version ----
    const q = await quiniela("ip");
    const people = [q.ana.id];
    for (const n of ["Beto", "Dora", "Eli"]) { const r = await call("POST", "/api/self-register", { metaKey: q.metaKey, name: n, pin: pin4(), slug: q.slug }); if (r.body && r.body.participant) people.push(r.body.participant.id); }
    const tally = {}; let last;
    for (let i = 0; i < 21; i++) {
      last = await call("POST", "/api/verify-pin", { metaKey: q.metaKey, participantId: people[i % people.length], pin: String(1000 + i * 7) }, { xff: forged() });
      const k = last.status === 429 ? "429" : last.status + " ok=" + (last.body && last.body.ok); tally[k] = (tally[k] || 0) + 1;
    }
    console.log(ts(), `2. ${people.length} people, 21 distinct wrong PINs (≤6 each, under the 10 free), each with a different forged X-Forwarded-For/True-Client-IP/X-Real-IP:`, JSON.stringify(tally), "| last:", fmt(last));
  }
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
