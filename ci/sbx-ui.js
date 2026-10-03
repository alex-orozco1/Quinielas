// Sandbox UI check (375 px): the wait notice next to the PIN form, with a live countdown.
// Prints only texts and states; the random PINs and passwords are never printed.
const { chromium } = require("playwright");
const crypto = require("crypto");
const B = process.env.SANDBOX;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => crypto.randomBytes(n).toString("hex");
const pin4 = () => String(1000 + crypto.randomInt(9000));
async function api(method, path, body, cookie) {
  const headers = { "Content-Type": "application/json" }; if (cookie) headers.Cookie = cookie;
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: j, sc: r.headers.getSetCookie() };
}
const log = (k, v) => console.log("UI " + k + ": " + v);
(async () => {
  const slug = "sbx-ui-" + Date.now().toString(36), metaKey = `quiniela:${slug}:meta`;
  const c = await api("POST", "/api/create-quiniela", { slug, groupName: "Prueba UI", creatorName: "Ana", contact: "sandbox-test", password: "pw-" + rnd(8) });
  const claim = c.sc.map((x) => x.split(";")[0]).join("; ");
  const ana = (await api("GET", "/api/kv/" + encodeURIComponent(metaKey))).body.value.participants[0];
  await api("POST", "/api/set-pin", { metaKey, participantId: ana.id, newPin: pin4() }, claim);
  let betoPin = pin4(); const reg = await api("POST", "/api/self-register", { metaKey, name: "Beto", pin: betoPin, slug });
  const beto = reg.body.participant;
  log("quiniela", slug + " | create " + c.status + " | Beto registered " + reg.status);
  const wrong = () => { let p; do p = pin4(); while (p === betoPin); return p; };
  let n = 0, r; while ((r = await api("POST", "/api/verify-pin", { metaKey, participantId: beto.id, pin: wrong() })).status !== 429) n++;
  log("attacker", `${n} wrong PINs accepted, then 429 retryAfterSeconds=${r.body.retryAfterSeconds}`);

  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 375, height: 800 } });
  const p = await ctx.newPage(); p.on("pageerror", (e) => log("PAGEERROR", e.message));
  const txt = async (sel) => (await p.locator(sel).innerText().catch(() => "(none)")).replace(/\s+/g, " ").trim();
  await p.goto(B + "/q/" + slug); await p.waitForTimeout(1500);
  if (await p.locator("text=No, soy").count()) await p.click("text=No, soy");
  await p.waitForSelector(".name-btn");
  await p.click(".name-btn:has-text('Beto')"); await p.waitForSelector("#qz-prompt-input");
  await p.fill("#qz-prompt-input", wrong()); await p.click("#qz-modal-confirm-btn"); await p.waitForTimeout(1500);
  log("1 modal still open after the 429", await p.locator("#qz-prompt-input").isVisible());
  log("1 modal notice", await txt("#qz-prompt-wait .qz-wait-left") + " | " + await txt("#qz-prompt-wait"));
  log("1 'Entrar' disabled", await p.locator("#qz-modal-confirm-btn").isDisabled());
  await p.screenshot({ path: "shots/sbx-1-modal-wait.png" });
  await sleep(3000);
  log("2 three seconds later", await txt("#qz-prompt-wait .qz-wait-left"));
  await p.click("#qz-modal-cancel-btn"); await p.waitForTimeout(300);
  log("3 login card after closing the modal", await txt("#qz-login-wait .qz-wait-left") + " | " + await txt("#qz-login-wait"));
  await p.screenshot({ path: "shots/sbx-2-login-wait.png" });
  await sleep(4000);
  log("4 four seconds later (a toast would be gone)", (await p.locator("#qz-login-wait").isVisible()) + " | " + await txt("#qz-login-wait .qz-wait-left"));
  for (let i = 0; i < 60 && !(await txt("#qz-login-wait")).includes("Ya puedes"); i++) await sleep(1000);
  log("5 at zero", await txt("#qz-login-wait"));
  await p.screenshot({ path: "shots/sbx-3-login-ready.png" });
  await p.click(".name-btn:has-text('Beto')"); await p.waitForSelector("#qz-prompt-input");
  log("6 modal after the wait: notice hidden / 'Entrar' enabled", (!(await p.locator("#qz-prompt-wait").isVisible())) + " / " + (!(await p.locator("#qz-modal-confirm-btn").isDisabled())));
  await p.fill("#qz-prompt-input", betoPin); await p.click("#qz-modal-confirm-btn"); await p.waitForTimeout(2500);
  log("7 Beto's correct PIN once allowed: logged in", (await p.locator(".qz-user-toggle").count()) > 0);
  await br.close();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
