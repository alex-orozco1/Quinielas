// adminPasswordOnPublish.integration.test.js — onboarding B through the REAL
// server and endpoints (test/helpers/realServer.js: a throwaway local
// PostgreSQL; skipped, with the reason, without one).
//
// A new quiniela is created without the admin password and remembers its
// creator (creatorId). The creator prepares without it and sets it when
// publishing the first round, through POST /api/set-admin-password:
//   X-Qracks-Participant: <creator id>, X-Qracks-Auth: <creator PIN>
//   body { metaKey, password }
// What must hold, by API and not only in the screens:
// - name, entry fee and points per correct pick change only with the admin
//   password (or the platform), before it exists AND after; no co-admin, and
//   not the creator with a PIN, can change them;
// - only the creator, with their PIN and under the limiter, sets the first
//   password, once, also against concurrent requests;
// - nobody else can remove, demote or reset the creator, or authorize the
//   creator's first PIN with their own;
// - nothing is published until the password exists; preparing stays open;
// - quinielas without creatorId keep their behaviour, and get no creator.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  itest, setup, teardown, dbQuery, PLATFORM_PASSWORD,
  freshIp, call, Browser, kvPath,
} = require("./helpers/realServer");

const slugOf = (tag) => `it-b-${tag}-${crypto.randomBytes(3).toString("hex")}`;
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const indexEntry = async (slug) => (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value
  .quinielas.find((x) => x.slug === slug);
const pinHeaders = (who) => ({ "X-Qracks-Auth": who.pin, "X-Qracks-Participant": who.id });

// Ana creates it (no admin password) and sets her first PIN with the creation
// claim; Beto and Carla register with their PINs; Ana, the creator, makes
// Carla an admin — which she may do before the password exists.
async function newQuiniela(tag, { password } = {}) {
  const slug = slugOf(tag);
  const metaKey = `quiniela:${slug}:meta`;
  const anaPhone = Browser(freshIp());
  const created = anaPhone.take(await call("POST", "/api/create-quiniela", {
    ip: anaPhone.ip, body: { slug, groupName: "B " + tag, creatorName: "Ana", ...(password ? { password } : {}) },
  }));
  assert.equal(created.status, 200, "create " + JSON.stringify(created.body));
  const anaId = (await call("GET", kvPath(slug), { ip: anaPhone.ip })).body.value.participants[0].id;
  const ana = { id: anaId, pin: "4321" };
  assert.equal(anaPhone.take(await call("POST", "/api/set-pin", {
    ip: anaPhone.ip, cookie: anaPhone.cookie, body: { metaKey, participantId: ana.id, newPin: ana.pin },
  })).status, 200);
  const reg = async (name, pin) => {
    const phone = Browser(freshIp());
    const r = phone.take(await call("POST", "/api/self-register", { ip: phone.ip, body: { metaKey, name, pin, slug } }));
    assert.equal(r.status, 200);
    return { who: { id: r.body.participant.id, pin }, phone };
  };
  const b = await reg("Beto", "2468");
  const c = await reg("Carla", "1357");
  const q = { slug, metaKey, ana, beto: b.who, carla: c.who, anaPhone, betoPhone: b.phone, carlaPhone: c.phone };
  const promoted = await writeAs(q, q.ana, (m) => { m.participants.find((p) => p.id === q.carla.id).isAdmin = true; });
  assert.equal(promoted.status, 200, "the creator names an admin before the password: " + JSON.stringify(promoted.body));
  return q;
}

// The Admin view, read and written back by `who` with their PIN (bound).
async function writeAs(q, who, mutate, { headers, cookie, ip } = {}) {
  const h = headers || pinHeaders(who);
  const view = await call("GET", kvPath(q.slug), { ip, cookie, headers: h });
  assert.equal(view.status, 200);
  const value = view.body.value;
  mutate(value);
  return call("POST", kvPath(q.slug), { ip, cookie, headers: h, body: { value } });
}
const ownerHeaders = (password) => ({ "X-Qracks-Auth": password });
const platformHeaders = { "X-Qracks-Platform-Auth": PLATFORM_PASSWORD };
// The platform reads the full row through the same GET (as admin it is not:
// GET answers it as public), so its writes start from the stored document.
async function writeAsPlatform(q, mutate) {
  const value = await stored(q);
  delete value.settings.ownerPassword;
  value.participants.forEach((p) => { delete p.pin; });
  mutate(value);
  return call("POST", kvPath(q.slug), { headers: platformHeaders, body: { value } });
}
const setAdminPassword = (q, { headers, password, browser, ip } = {}) => call("POST", "/api/set-admin-password", {
  ip: ip || (browser && browser.ip) || freshIp(), cookie: browser && browser.cookie, headers: headers || {},
  body: { metaKey: q.metaKey, password },
});
const verifyOwner = (q, password, ip) => call("POST", "/api/verify-owner", { ip: ip || freshIp(), body: { metaKey: q.metaKey, password } });
const rules = (m) => ({ groupName: m.groupName, entryFee: m.settings.entryFee, points: m.settings.pointsPerCorrectPick });
const changeRules = (m) => { m.groupName = "Cambiado " + crypto.randomBytes(2).toString("hex"); m.settings.entryFee = 500; m.settings.pointsPerCorrectPick = 3; };
const futureDeadline = () => new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
const preparedRound = (id) => ({
  id, number: 1, deadline: futureDeadline(), results: {}, resultsPublished: false, published: false,
  matches: [{ id: id + "-m1", home: "América", away: "Chivas" }, { id: id + "-m2", home: "Pumas", away: "Toluca" }],
});

// A quiniela created before onboarding B: the same row without creatorId.
async function makeLegacy(q) {
  const value = await stored(q);
  delete value.creatorId;
  await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(value)]);
}

test.describe("onboarding B: admin password before publishing (real server)", () => {
  test.before(setup);
  test.after(teardown);

  itest("CB-1: a quiniela is created without the admin password and remembers its creator; an older client that sends one keeps it", async () => {
    const q = await newQuiniela("create");
    const row = await stored(q);
    assert.equal(row.creatorId, q.ana.id, "the creator is the first participant");
    assert.ok(!row.settings.ownerPassword, "no admin password yet");
    const pub = (await call("GET", kvPath(q.slug))).body.value;
    assert.deepEqual([pub.creatorId, pub.ownerPasswordSet, "ownerPassword" in pub.settings], [q.ana.id, false, false]);

    const older = slugOf("older");
    const laptop = Browser(freshIp());
    const r = laptop.take(await call("POST", "/api/create-quiniela", { ip: laptop.ip, body: { slug: older, groupName: "Vieja", creatorName: "Eva", password: "clave-vieja-1" } }));
    assert.equal(r.status, 200);
    assert.ok(laptop.has("qracks_trust_"), "the device that typed it is trusted for it, as before");
    const olderRow = (await dbQuery("SELECT value FROM kv WHERE key = $1", [`quiniela:${older}:meta`])).rows[0].value;
    assert.ok(/^scrypt\$/.test(olderRow.settings.ownerPassword), "stored hashed");
    assert.equal(olderRow.creatorId, olderRow.participants[0].id);
    const olderPub = (await call("GET", kvPath(older))).body.value;
    assert.deepEqual([olderPub.ownerPasswordSet, JSON.stringify(olderPub).includes("scrypt$")], [true, false], "the flag, never the hash");

    for (const [missing, body] of [["groupName", { creatorName: "Ana" }], ["creatorName", { groupName: "G" }]]) {
      const slug = slugOf("miss");
      const m = await call("POST", "/api/create-quiniela", { body: { slug, ...body } });
      assert.deepEqual([m.status, m.body.error], [400, "invalid_params"], missing);
      assert.equal(await indexEntry(slug), undefined, missing + ": nothing created");
    }
  });

  itest("creatorId and ownerPasswordSet are the server's: a write cannot change them or give a creator to a quiniela without one", async () => {
    const q = await newQuiniela("cid");
    const w = await writeAs(q, q.carla, (m) => { m.creatorId = q.carla.id; m.ownerPasswordSet = true; });
    assert.equal(w.status, 200);
    const row = await stored(q);
    assert.deepEqual([row.creatorId, "ownerPasswordSet" in row], [q.ana.id, false]);
    const p = await writeAsPlatform(q, (m) => { m.creatorId = q.beto.id; });
    assert.equal(p.status, 200);
    assert.equal((await stored(q)).creatorId, q.ana.id, "not even the platform rewrites it");

    const legacy = await newQuiniela("cid-legacy");
    await makeLegacy(legacy);
    assert.equal((await writeAs(legacy, legacy.ana, (m) => { m.creatorId = legacy.ana.id; })).status, 200);
    assert.ok(!("creatorId" in (await stored(legacy))), "nobody is inferred or declared creator of an existing quiniela");
  });

  itest("name, entry fee and points BEFORE the password: no PIN changes them — co-admin, creator, by header or session; the platform can", async () => {
    const q = await newQuiniela("rules-before");
    const original = rules(await stored(q));
    for (const [who, opts] of [
      ["co-admin Carla, PIN", { who: q.carla }],
      ["creator Ana, PIN", { who: q.ana }],
      ["creator Ana, session cookie only", { who: q.ana, headers: {}, cookie: q.anaPhone.cookie, ip: q.anaPhone.ip }],
      ["co-admin Carla, session cookie only", { who: q.carla, headers: {}, cookie: q.carlaPhone.cookie, ip: q.carlaPhone.ip }],
    ]) {
      const r = await writeAs(q, opts.who, changeRules, opts);
      assert.deepEqual([r.status, r.body.ruleFieldsKept], [200, true], who + " " + JSON.stringify(r.body));
      assert.deepEqual(rules(await stored(q)), original, who + ": stored rules unchanged");
    }
    // Carla cannot slip the password in through a generic write either.
    assert.equal((await writeAs(q, q.carla, (m) => { m.settings.ownerPassword = "carla-se-adelanta"; })).status, 200);
    assert.ok(!(await stored(q)).settings.ownerPassword, "a generic write never sets the first password");
    assert.equal((await writeAs(q, q.ana, (m) => { m.settings.ownerPassword = "ana-por-la-puerta-de-atras"; })).status, 200);
    assert.ok(!(await stored(q)).settings.ownerPassword, "not even the creator's: the dedicated route asks for her PIN");
    // A participant or nobody: refused outright, as always.
    const beto = await call("POST", kvPath(q.slug), { headers: pinHeaders(q.beto), body: { value: (await call("GET", kvPath(q.slug))).body.value } });
    assert.equal(beto.status, 403);
    assert.equal((await call("POST", kvPath(q.slug), { body: { value: { ...(await stored(q)), groupName: "anon" } } })).status, 403);
    assert.deepEqual(rules(await stored(q)), original);
    // The platform (support) keeps its level.
    const plat = await writeAsPlatform(q, changeRules);
    assert.deepEqual([plat.status, plat.body.ruleFieldsKept], [200, false]);
    const byPlatform = rules(await stored(q));
    assert.deepEqual([byPlatform.entryFee, byPlatform.points, byPlatform.groupName !== original.groupName], [500, 3, true]);
  });

  itest("name, entry fee and points AFTER the password: still no PIN or session; the admin password changes them", async () => {
    const q = await newQuiniela("rules-after");
    const pw = "ana-clave-segura";
    assert.equal((await setAdminPassword(q, { headers: pinHeaders(q.ana), password: pw, browser: q.anaPhone })).status, 200);
    const original = rules(await stored(q));
    for (const [who, opts] of [
      ["co-admin Carla, PIN", { who: q.carla }],
      ["creator Ana, PIN", { who: q.ana }],
      ["creator Ana, session cookie only", { who: q.ana, headers: {}, cookie: q.anaPhone.cookie, ip: q.anaPhone.ip }],
    ]) {
      const r = await writeAs(q, opts.who, changeRules, opts);
      assert.deepEqual([r.status, r.body.ruleFieldsKept], [200, true], who);
      assert.deepEqual(rules(await stored(q)), original, who + ": stored rules unchanged");
    }
    const wrong = await writeAs(q, null, changeRules, { headers: ownerHeaders("not-the-password") });
    assert.equal(wrong.status, 403, "a wrong admin password is not a tier");
    const owner = await writeAs(q, null, (m) => { m.groupName = "Con contraseña"; m.settings.entryFee = 250; m.settings.pointsPerCorrectPick = 2; }, { headers: ownerHeaders(pw) });
    assert.deepEqual([owner.status, owner.body.ruleFieldsKept], [200, false]);
    assert.deepEqual(rules(await stored(q)), { groupName: "Con contraseña", entryFee: 250, points: 2 });
    // Changing the password itself takes the current one; with it, the new one
    // must be long enough too.
    assert.equal((await writeAs(q, q.ana, (m) => { m.settings.ownerPassword = "otra-clave-larga"; })).status, 200);
    assert.deepEqual((await verifyOwner(q, "otra-clave-larga")).body, { ok: false }, "a PIN does not change it");
    const short = await writeAs(q, null, (m) => { m.settings.ownerPassword = "corta"; }, { headers: ownerHeaders(pw) });
    assert.deepEqual([short.status, short.body.error, short.body.minLength], [400, "admin_password_too_short", 8]);
    assert.equal((await writeAs(q, null, (m) => { m.settings.ownerPassword = "otra-clave-larga"; }, { headers: ownerHeaders(pw) })).status, 200);
    assert.deepEqual((await verifyOwner(q, "otra-clave-larga")).body, { ok: true });
  });

  itest("settings that are not an object are refused (400) and change nothing, with or without a creator; null keeps the rules", async () => {
    for (const legacy of [false, true]) {
      const q = await newQuiniela(legacy ? "shape-legacy" : "shape");
      if (legacy) await makeLegacy(q);
      const before = await stored(q);
      for (const shape of ["texto", 7, ["x"], true]) {
        const r = await writeAs(q, q.carla, (m) => { m.settings = shape; });
        assert.deepEqual([r.status, r.body.error], [400, "invalid_value"], (legacy ? "legacy " : "") + JSON.stringify(shape));
      }
      assert.deepEqual((await stored(q)).settings, before.settings, "nothing written");
      assert.equal((await call("GET", kvPath(q.slug))).status, 200, "the quiniela still reads");
    }
    const q = await newQuiniela("shape-null");
    const original = rules(await stored(q));
    const r = await writeAs(q, q.carla, (m) => { m.settings = null; });
    assert.deepEqual([r.status, r.body.ruleFieldsKept], [200, true]);
    assert.deepEqual(rules(await stored(q)), original, "with a creator, sending no settings does not drop the fee or the points");
  });

  itest("CB-6: only the creator, with her PIN in the request, sets the first password, once", async () => {
    const q = await newQuiniela("setpw");
    const pw = "primera-clave-ana";
    const tries = [
      ["co-admin Carla with her own PIN", { headers: pinHeaders(q.carla) }, 403, "not_creator"],
      ["participant Beto with his PIN", { headers: pinHeaders(q.beto) }, 403, "not_creator"],
      ["nobody", { headers: {} }, 403, "not_creator"],
      ["Ana's PIN, not bound to her", { headers: { "X-Qracks-Auth": q.ana.pin } }, 403, "not_creator"],
      ["Carla claiming to be Ana with Carla's PIN", { headers: { "X-Qracks-Auth": q.carla.pin, "X-Qracks-Participant": q.ana.id } }, 403, "wrong_pin"],
      ["Ana's session alone, no PIN typed", { headers: {}, browser: q.anaPhone }, 403, "not_creator"],
      ["Ana, password too short", { headers: pinHeaders(q.ana), password: "1234567" }, 400, "admin_password_too_short"],
    ];
    for (const [who, opts, status, error] of tries) {
      const r = await setAdminPassword(q, { password: pw, ...opts });
      assert.deepEqual([r.status, r.body.error], [status, error], who);
      assert.ok(!(await stored(q)).settings.ownerPassword, who + ": nothing set");
    }
    const ok = q.anaPhone.take(await setAdminPassword(q, { headers: pinHeaders(q.ana), password: "  " + pw + "  ", browser: q.anaPhone }));
    assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
    assert.ok(!JSON.stringify(ok.body).includes(pw) && !ok.setCookies.join(";").includes(pw), "never echoed");
    assert.equal((await call("GET", kvPath(q.slug))).body.value.ownerPasswordSet, true);
    assert.deepEqual((await verifyOwner(q, pw)).body, { ok: true }, "trimmed, like every admin password");
    const again = await setAdminPassword(q, { headers: pinHeaders(q.ana), password: "otra-clave-distinta" });
    assert.deepEqual([again.status, again.body.error], [409, "already_set"]);
    assert.deepEqual((await verifyOwner(q, pw)).body, { ok: true }, "the first one stands");
    const legacy = await newQuiniela("setpw-legacy");
    await makeLegacy(legacy);
    const l = await setAdminPassword(legacy, { headers: pinHeaders(legacy.ana), password: pw });
    assert.deepEqual([l.status, l.body.error], [409, "not_applicable"], "existing quinielas keep Ajustes as before");
  });

  itest("CB-6: the creator's PIN goes through the limiter (10 failures, then a wait); her trusted phone still gets through", async () => {
    const q = await newQuiniela("setpw-limit");
    const statuses = [];
    for (let k = 0; k < 11; k++) {
      const r = await setAdminPassword(q, { headers: { "X-Qracks-Auth": String(7000 + k), "X-Qracks-Participant": q.ana.id }, password: "clave-del-atacante" });
      statuses.push(r.status === 429 ? `429:${r.body.error}:${r.body.retryAfterSeconds > 0}` : `${r.status}:${r.body.error}`);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill("403:wrong_pin"));
    assert.equal(statuses[10], "429:too_many_attempts:true", "the 11th waits, with the time left");
    const right = await setAdminPassword(q, { headers: pinHeaders(q.ana), password: "clave-de-ana-ok" });
    assert.equal(right.status, 429, "the right PIN from a new device waits too");
    assert.ok(!(await stored(q)).settings.ownerPassword);
    const phone = await setAdminPassword(q, { headers: pinHeaders(q.ana), password: "clave-de-ana-ok", browser: q.anaPhone });
    assert.equal(phone.status, 200, "the phone where she already entered has its own budget");
  });

  itest("CB-6: concurrent first passwords — exactly one wins, the rest get 409, and the stored one is the winner's", async () => {
    const q = await newQuiniela("setpw-race");
    const passwords = Array.from({ length: 6 }, (_, k) => "clave-carrera-" + k);
    const results = await Promise.all(passwords.map((password) =>
      setAdminPassword(q, { headers: pinHeaders(q.ana), password, browser: q.anaPhone })));
    const won = results.map((r, k) => [r.status, r.body.error || "ok", k]);
    assert.equal(won.filter(([s]) => s === 200).length, 1, JSON.stringify(won));
    assert.deepEqual(won.filter(([s]) => s !== 200).map(([s, e]) => s + ":" + e), Array(5).fill("409:already_set"));
    const winner = passwords[won.find(([s]) => s === 200)[2]];
    for (const pw of passwords) {
      assert.equal((await verifyOwner(q, pw)).body.ok, pw === winner, pw);
    }
  });

  itest("CB-7: before the password, a co-admin cannot remove, demote or reset the creator, nor name or remove admins; the creator can", async () => {
    const q = await newQuiniela("creator");
    const before = await stored(q);
    const anaOf = (m) => m.participants.find((p) => p.id === q.ana.id);
    for (const [what, mutate, error] of [
      ["remove Ana", (m) => { m.participants = m.participants.filter((p) => p.id !== q.ana.id); }, "creator_protected"],
      ["demote Ana", (m) => { anaOf(m).isAdmin = false; }, "creator_protected"],
      ["reset Ana's PIN", (m) => { anaOf(m).pin = null; }, "creator_protected"],
      ["set Ana's PIN", (m) => { anaOf(m).pin = "0000"; }, "creator_protected"],
      ["make Beto admin", (m) => { m.participants.find((p) => p.id === q.beto.id).isAdmin = true; }, "creator_only"],
      ["add a new admin", (m) => { m.participants.push({ id: "p_intruso", name: "Intruso", isAdmin: true, paid: false, pin: "9999" }); }, "creator_only"],
    ]) {
      const r = await writeAs(q, q.carla, mutate);
      assert.deepEqual([r.status, r.body.error], [403, error], what);
      const now = await stored(q);
      assert.deepEqual(now.participants, before.participants, what + ": nothing written");
    }
    // Carla's session cookie is no different from her PIN.
    const viaSession = await writeAs(q, q.carla, (m) => { anaOf(m).isAdmin = false; }, { headers: {}, cookie: q.carlaPhone.cookie, ip: q.carlaPhone.ip });
    assert.deepEqual([viaSession.status, viaSession.body.error], [403, "creator_protected"]);
    // The creator herself: names and removes admins.
    assert.equal((await writeAs(q, q.ana, (m) => { m.participants.find((p) => p.id === q.beto.id).isAdmin = true; })).status, 200);
    assert.equal((await writeAs(q, q.ana, (m) => { m.participants.find((p) => p.id === q.beto.id).isAdmin = false; })).status, 200);
    // ...but cannot demote herself into a quiniela with no one to set the password.
    const self = await writeAs(q, q.ana, (m) => { anaOf(m).isAdmin = false; });
    assert.deepEqual([self.status, self.body.error], [403, "creator_protected"]);
    // Everything else a co-admin does is unchanged: editing a participant.
    assert.equal((await writeAs(q, q.carla, (m) => { m.participants.find((p) => p.id === q.beto.id).paid = true; })).status, 200);
  });

  itest("CB-7: a co-admin's PIN never authorizes the creator's first PIN; the creation claim or the admin password does", async () => {
    const q = await newQuiniela("creator-pin");
    // Support clears Ana's PIN (the platform keeps its level), so her seat is open.
    assert.equal((await writeAsPlatform(q, (m) => { m.participants.find((p) => p.id === q.ana.id).pin = null; })).status, 200);
    const firstPin = (headers, browser) => call("POST", "/api/set-pin", {
      ip: (browser && browser.ip) || freshIp(), cookie: browser && browser.cookie, headers,
      body: { metaKey: q.metaKey, participantId: q.ana.id, newPin: "6666" },
    });
    for (const [who, headers, browser] of [
      ["Carla's PIN typed on this device", { "X-Qracks-Auth": q.carla.pin }],
      ["Carla's PIN, bound to her", pinHeaders(q.carla)],
      ["Carla's session", {}, q.carlaPhone],
    ]) {
      const r = await firstPin(headers, browser);
      assert.deepEqual([r.status, r.body.error], [403, "admin_claim_required"], who);
    }
    assert.equal((await stored(q)).participants.find((p) => p.id === q.ana.id).pin, null, "the seat is still hers");
    // Legacy: the same situation is unchanged — another admin's PIN still works.
    const legacy = await newQuiniela("creator-pin-legacy");
    await makeLegacy(legacy);
    assert.equal((await writeAs(legacy, legacy.carla, (m) => { m.participants.find((p) => p.id === legacy.ana.id).pin = null; })).status, 200, "legacy: a co-admin may reset another admin");
    const l = await call("POST", "/api/set-pin", { headers: { "X-Qracks-Auth": legacy.carla.pin }, body: { metaKey: legacy.metaKey, participantId: legacy.ana.id, newPin: "6666" } });
    assert.equal(l.status, 200, "legacy unchanged");
  });

  itest("CB-7/CB-8: after the password, a co-admin still cannot touch the creator; the admin password can", async () => {
    const q = await newQuiniela("creator-after");
    const pw = "clave-ana-despues";
    assert.equal((await setAdminPassword(q, { headers: pinHeaders(q.ana), password: pw, browser: q.anaPhone })).status, 200);
    const anaOf = (m) => m.participants.find((p) => p.id === q.ana.id);
    const r = await writeAs(q, q.carla, (m) => { anaOf(m).pin = null; });
    assert.deepEqual([r.status, r.body.error], [403, "creator_protected"]);
    const role = await writeAs(q, q.carla, (m) => { m.participants.find((p) => p.id === q.beto.id).isAdmin = true; });
    assert.deepEqual([role.status, role.body.error], [403, "owner_password_required"], "as in every quiniela with a password");
    const asAna = await writeAs(q, q.ana, (m) => { m.participants.find((p) => p.id === q.beto.id).isAdmin = true; });
    assert.deepEqual([asAna.status, asAna.body.error], [403, "owner_password_required"], "after the password, the creator's PIN no longer names admins");
    const owner = await writeAs(q, null, (m) => { m.participants.find((p) => p.id === q.beto.id).isAdmin = true; }, { headers: ownerHeaders(pw) });
    assert.equal(owner.status, 200);
    // Verify-owner: the password opens Ajustes; a PIN does not.
    const pinOnly = await call("POST", "/api/verify-owner", { headers: pinHeaders(q.ana), body: { metaKey: q.metaKey, password: "" } });
    assert.deepEqual(pinOnly.body, { ok: false });
    // ¿Olvidaste tu PIN? works as in #29.
    const rec = await call("POST", "/api/recover-admin-pin", { headers: ownerHeaders(pw), body: { metaKey: q.metaKey, participantId: q.ana.id, newPin: "8080" } });
    assert.equal(rec.status, 200);
    assert.deepEqual((await call("POST", "/api/verify-pin", { body: { metaKey: q.metaKey, participantId: q.ana.id, pin: "8080" } })).body, { ok: true });
    assert.deepEqual((await call("POST", "/api/verify-pin", { body: { metaKey: q.metaKey, participantId: q.ana.id, pin: q.ana.pin } })).body, { ok: false });
  });

  itest("CB-3/CB-5: preparing is open without the password; publishing is refused with 409 for everyone until it exists", async () => {
    const q = await newQuiniela("publish");
    const prep = await writeAs(q, q.ana, (m) => { m.rounds.push(preparedRound("r1")); });
    assert.equal(prep.status, 200, "prepare: " + JSON.stringify(prep.body));
    const edit = await writeAs(q, q.carla, (m) => { m.rounds[0].matches.push({ id: "r1-m3", home: "Cruz Azul", away: "Santos" }); });
    assert.equal(edit.status, 200, "a co-admin prepares too");
    const prepared = await stored(q);
    for (const [who, run] of [
      ["creator publishes", () => writeAs(q, q.ana, (m) => { m.rounds[0].published = true; })],
      ["creator by session", () => writeAs(q, q.ana, (m) => { m.rounds[0].published = true; }, { headers: {}, cookie: q.anaPhone.cookie, ip: q.anaPhone.ip })],
      ["co-admin publishes", () => writeAs(q, q.carla, (m) => { m.rounds[0].published = true; })],
      ["a new round straight as published", () => writeAs(q, q.ana, (m) => { m.rounds.push({ ...preparedRound("r2"), number: 2, published: true }); })],
      ["a new round with no published flag (legacy = visible)", () => writeAs(q, q.ana, (m) => { const r = preparedRound("r3"); delete r.published; m.rounds.push({ ...r, number: 3 }); })],
      ["platform", () => writeAsPlatform(q, (m) => { m.rounds[0].published = true; })],
    ]) {
      const r = await run();
      assert.deepEqual([r.status, r.body.error], [409, "admin_password_required"], who);
      const now = await stored(q);
      assert.deepEqual([now.rounds, now.roundsRevision], [prepared.rounds, prepared.roundsRevision], who + ": nothing written");
    }
    assert.equal((await indexEntry(q.slug)).lifecycleRoundsConsumed, 0, "a refused publish consumes nothing");
    // The creator sets the password; nothing is published by that alone.
    assert.equal((await setAdminPassword(q, { headers: pinHeaders(q.ana), password: "clave-para-publicar", browser: q.anaPhone })).status, 200);
    const afterPw = await stored(q);
    assert.deepEqual([afterPw.rounds, afterPw.roundsRevision], [prepared.rounds, prepared.roundsRevision], "matches and deadline intact, still unpublished");
    // Publishing is then exactly as today: an admin's PIN publishes.
    const pub = await writeAs(q, q.ana, (m) => { m.rounds[0].published = true; });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const live = (await stored(q)).rounds[0];
    assert.deepEqual([live.published, live.matches.length, live.deadline], [true, 3, prepared.rounds[0].deadline]);
    assert.equal((await indexEntry(q.slug)).lifecycleRoundsConsumed, 1);
    const pubCarla = await writeAs(q, q.carla, (m) => { m.rounds.push({ ...preparedRound("r4"), number: 2, published: true }); });
    assert.equal(pubCarla.status, 200, "a co-admin publishes once the password exists, as today");
  });

  itest("CB-9: without the password, «¿Olvidaste tu PIN?» cannot recover, no PIN opens Ajustes, and the open session keeps working", async () => {
    const q = await newQuiniela("recover");
    const rec = await call("POST", "/api/recover-admin-pin", { headers: ownerHeaders("cualquier-cosa"), body: { metaKey: q.metaKey, participantId: q.ana.id, newPin: "1212" } });
    assert.deepEqual([rec.status, rec.body.error], [409, "no_admin_password"]);
    for (const who of [q.ana, q.carla]) {
      const v = await call("POST", "/api/verify-owner", { headers: pinHeaders(who), body: { metaKey: q.metaKey, password: "" } });
      assert.deepEqual(v.body, { ok: false }, "no PIN opens the protected settings while there is no password");
    }
    const session = await call("POST", "/api/verify-session", { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, body: { metaKey: q.metaKey, slug: q.slug } });
    assert.equal(session.body.ok, true, "the phone where she entered stays in");
    const view = await call("GET", kvPath(q.slug), { ip: q.anaPhone.ip, cookie: q.anaPhone.cookie });
    assert.ok("roundsRevision" in view.body.value, "as an admin");
  });

  itest("CB-12: a quiniela without creatorId keeps its behaviour (password from PINs, roles, Ajustes by PIN, publishing)", async () => {
    const q = await newQuiniela("legacy");
    await makeLegacy(q);
    // Publishing without a password: as before.
    assert.equal((await writeAs(q, q.carla, (m) => { m.rounds.push({ ...preparedRound("l1"), published: true }); })).status, 200);
    // An admin opens Ajustes with their PIN while there is no password: as before.
    const v = await call("POST", "/api/verify-owner", { headers: pinHeaders(q.carla), body: { metaKey: q.metaKey, password: "" } });
    assert.deepEqual(v.body, { ok: true });
    // Any admin names admins and sets the first password through Ajustes: as before.
    assert.equal((await writeAs(q, q.carla, (m) => { m.participants.find((p) => p.id === q.beto.id).isAdmin = true; })).status, 200);
    assert.equal((await writeAs(q, q.carla, (m) => { m.settings.ownerPassword = "x"; })).status, 200);
    assert.deepEqual((await verifyOwner(q, "x")).body, { ok: true }, "no minimum is imposed on existing quinielas");
    assert.ok(!("creatorId" in (await stored(q))));
  });

  // Registered, not accepted: in a quiniela created before onboarding B the
  // rules are still protected only by the Ajustes screen. A separate
  // correction (backlog) closes it without inferring a creator; until then
  // this test documents the gap instead of passing it as expected behaviour.
  test("BACKLOG: existing quinielas — an admin PIN still changes name, fee and points by API (separate correction)", {
    skip: require("./helpers/realServer").SKIP,
    todo: "corrección separada: proteger nombre, cuota y puntos en el servidor para quinielas sin creatorId",
  }, async () => {
    const q = await newQuiniela("legacy-gap");
    await makeLegacy(q);
    const original = rules(await stored(q));
    await writeAs(q, q.carla, changeRules);
    assert.deepEqual(rules(await stored(q)), original, "the desired behaviour; today it fails");
  });
});
