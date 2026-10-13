// Comprobación breve en el SANDBOX del onboarding integrado (#30 + #31 + arreglo de #35):
//   crear → PIN → preparar jornada → cancelar y recargar → configurar contraseña → publicar.
// Partidos y cierre se conservan al cancelar y al recargar, y se publican tal cual.
// Uso: SANDBOX=https://qracks-mon003-sandbox.onrender.com VP=movil|escritorio OUT=<dir> TZ=America/Mexico_City node ci/sbx-35-ui.js
// Nunca producción: el script se niega a correr contra otra URL. PIN y contraseña
// aleatorios y desechables; no se imprimen. Crea una quiniela propia (prefijo sbx35-)
// en la base del sandbox, distinta de la de producción. Sin pagos.
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const crypto = require("crypto");

const B = process.env.SANDBOX, OUT = process.env.OUT, VP = process.env.VP;
if (B !== "https://qracks-mon003-sandbox.onrender.com") { console.error("Sólo contra el sandbox."); process.exit(2); }
if (!["movil", "escritorio"].includes(VP) || !OUT) { console.error("Faltan VP=movil|escritorio y OUT."); process.exit(2); }
// El cierre se escribe en hora local del navegador: el proceso debe compartirla.
if (process.env.TZ !== "America/Mexico_City") { console.error("Correr con TZ=America/Mexico_City."); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const MOBILE = VP === "movil";
const RUN = VP[0] + Date.now().toString(36);

let fails = 0, passes = 0;
const log = (s) => console.log(s);
const check = (name, ok, detail = "") => { if (ok) passes++; else fails++; log(`${ok ? "PASS" : "FAIL"} [${VP}] ${name}${detail ? ": " + detail : ""}`); };
const pin4 = () => { let p; do { p = String(crypto.randomInt(0, 10000)).padStart(4, "0"); } while (/^(\d)\1{3}$/.test(p)); return p; };
const secret = () => "sbx-" + crypto.randomBytes(12).toString("base64url");
const kv = (slug) => "/api/kv/" + encodeURIComponent(`quiniela:${slug}:meta`);
const getMeta = async (slug) => { const r = await fetch(B + kv(slug)); return (await r.json()).value; };
const futureLocal = (days, h = 20) => { const d = new Date(Date.now() + days * 864e5); d.setHours(h, 30, 0, 0); const pad = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sameTime = (a, b) => new Date(a).getTime() === new Date(b).getTime();
const PROTEGE = ["Cambiar el nombre de tu quiniela.", "Definir cuántos puntos vale cada acierto.", "Establecer la cuota que acuerden pagar los participantes."];

(async () => {
  const br = await chromium.launch();
  const ctx = await br.newContext({
    viewport: { width: MOBILE ? 375 : 1280, height: 800 }, deviceScaleFactor: MOBILE ? 2 : 1, isMobile: MOBILE, hasTouch: MOBILE,
    locale: "es-MX", timezoneId: "America/Mexico_City",
  });
  const p = await ctx.newPage();
  const pageErrors = [];
  p.on("pageerror", (e) => { pageErrors.push(e.message); log(`PAGEERROR [${VP}] ${e.message}`); });
  const shot = async (name) => { await p.waitForTimeout(400); await p.screenshot({ path: `${OUT}/${VP}-${name}.png` }); };
  const text = async (sel) => (await p.locator(sel).first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const R = "#qz-setup-match-rows";
  const rowsOf = async () => {
    const rows = p.locator(`${R} .match-edit-row`); const out = [];
    for (let i = 0; i < await rows.count(); i++) out.push([await rows.nth(i).locator("[data-role=teamA]").inputValue(), await rows.nth(i).locator("[data-role=teamB]").inputValue()]);
    return out;
  };
  const fillRow = async (i, a, b) => { const row = p.locator(`${R} .match-edit-row`).nth(i); await row.locator("[data-role=teamA]").fill(a); await row.locator("[data-role=teamB]").fill(b); };
  const draftKeys = () => p.evaluate(() => Object.keys(window.sessionStorage).filter((k) => k.startsWith("qracks_round_draft:")));
  const sameForm = async (expected, deadline) => JSON.stringify(await rowsOf()) === JSON.stringify(expected) && (await p.inputValue("#qz-setup-deadline")) === deadline;

  try {
    // 1. Crear (sin contacto ni contraseña)
    await p.goto(B + "/crear", { timeout: 90000 }); await p.waitForSelector("#qz-c-name", { timeout: 90000 });
    await shot("1-crear");
    check("1. /crear sin campos de contraseña ni de contacto",
      (await p.locator("#qz-root input[type=password]").count()) === 0
      && (await p.locator('#qz-root input[id*="contact" i], #qz-root input[type=email], #qz-root input[type=tel]').count()) === 0);
    const slug = `sbx35-${RUN}`;
    await p.fill("#qz-c-name", "Sandbox #35"); await p.fill("#qz-c-creator", "Ana"); await p.fill("#qz-c-slug", slug);
    await p.click("#qz-c-submit");

    // 2. Elegir PIN
    await p.waitForSelector("#qz-setup-pin-input", { timeout: 60000 });
    await shot("2-elegir-pin");
    const anaPin = pin4();
    await p.locator("#qz-setup-pin-input").focus(); await p.keyboard.type(anaPin); await p.keyboard.press("Enter");
    await p.waitForSelector("#qz-setup-cta", { timeout: 60000 });
    let meta = await getMeta(slug);
    check("2. Quiniela creada con su creadora, PIN elegido y sin contraseña", !!meta && !!meta.creatorId && meta.ownerPasswordSet === false);

    // 3. Preparar la jornada
    await fillRow(0, "León", "Santos");
    await fillRow(1, "Toluca", "Pachuca");
    await p.click("#qz-setup-add-match");
    await fillRow(2, "Atlas", "Tigres");
    const deadline = futureLocal(3);
    await p.fill("#qz-setup-deadline", deadline);
    const expected = [["León", "Santos"], ["Toluca", "Pachuca"], ["Atlas", "Tigres"]];
    await shot("3-jornada-preparada");
    check("3. Jornada preparada: 3 partidos y cierre", await sameForm(expected, deadline));

    // 4. Publicar abre la contraseña; cancelar («Ahora no») conserva todo
    await p.click("#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal", { timeout: 30000 });
    const modal = await text("#qz-setpw-modal");
    await shot("4a-contrasena-al-publicar");
    check("4a. El paso explica lo que protege (nombre, puntos y cuota) y la recuperación del PIN",
      PROTEGE.every((t) => modal.includes(t)) && modal.includes("recuperar tu acceso si olvidas el PIN"));
    await p.click("#qz-setpw-modal-cancel");
    await p.waitForSelector("#qz-setpw-modal", { state: "detached", timeout: 15000 });
    meta = await getMeta(slug);
    await shot("4b-tras-cancelar");
    check("4b. Cancelar: nada publicado; partidos y cierre siguen", meta.rounds.length === 0 && meta.ownerPasswordSet === false && await sameForm(expected, deadline));

    // 5. Recargar conserva todo
    await p.reload();
    await p.waitForSelector("#qz-session-yes, #qz-setup-cta", { timeout: 60000 });
    if (await p.locator("#qz-session-yes").count()) await p.click("#qz-session-yes");
    await p.waitForSelector("#qz-setup-cta", { timeout: 60000 });
    const afterReload = { r: await rowsOf(), d: await p.inputValue("#qz-setup-deadline") };
    await shot("5-tras-recargar");
    check("5. Recargar: vuelven partidos y cierre", await sameForm(expected, deadline), JSON.stringify(afterReload));

    // 6. Configurar la contraseña (no publica)
    await p.click("#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal", { timeout: 30000 });
    if (await p.locator("#qz-setpw-modal-pin").isVisible()) await p.fill("#qz-setpw-modal-pin", anaPin);
    const pw = secret();
    await p.fill("#qz-setpw-modal-pw", pw); await p.fill("#qz-setpw-modal-pw2", pw);
    await p.click("#qz-setpw-modal-save");
    await p.waitForSelector("#qz-setpw-modal", { state: "detached", timeout: 30000 });
    await p.waitForTimeout(600);
    meta = await getMeta(slug);
    await shot("6-contrasena-guardada");
    check("6. Contraseña guardada, nada publicado, partidos y cierre siguen", meta.ownerPasswordSet === true && meta.rounds.length === 0 && await sameForm(expected, deadline));

    // 7. Publicar
    await p.click("#qz-setup-cta");
    await p.waitForSelector("#qz-setup-share", { timeout: 60000 });
    meta = await getMeta(slug);
    const r = meta.rounds[0];
    await shot("7-publicada");
    check("7. Publicada con los 3 partidos y el cierre elegido, sin borrador",
      meta.rounds.length === 1 && r.published === true
      && JSON.stringify(r.matches.map((m) => [m.teamA, m.teamB])) === JSON.stringify(expected)
      && sameTime(r.deadline, new Date(deadline).toISOString()) && (await draftKeys()).length === 0,
      JSON.stringify({ partidos: r && r.matches.map((m) => [m.teamA, m.teamB]), cierre: r && r.deadline }));
  } catch (e) {
    fails++; log(`FAIL [${VP}] excepción: ${String(e && e.message || e).split("\n")[0]}`);
    await shot("error").catch(() => {});
  }
  log(`PAGEERRORS [${VP}] ${pageErrors.length}`);
  log(`RESUMEN [${VP}] pass=${passes} fail=${fails}`);
  await br.close();
  process.exit(fails ? 1 : 0);
})();
