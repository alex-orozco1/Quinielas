// Product QA (independiente) · Onboarding B (#30 + #31) en el SANDBOX, desde la experiencia del usuario.
// Criterios del Founder:
//   1  recorrido completo (móvil y escritorio): crear sin contraseña -> PIN -> jornada -> contraseña al publicar -> publicar explícito.
//   2  cancelar o equivocarse no pierde partidos ni cierre (Ahora no, Esc, vacía/corta/no coincide, PIN incorrecto, red, 429, 5xx, recargar).
//   3  un co-admin no se adelanta a la creadora; lo que escribió no se pierde; cuando ella ya la configuró, publica sin trabas.
// Uso: SANDBOX=https://qracks-mon003-sandbox.onrender.com VP=movil|escritorio OUT=<dir> TZ=America/Mexico_City node pqa-sbx31-ui.js
// Se niega a correr contra otra URL. PINs y contraseñas aleatorios por corrida: no se imprimen ni se guardan.
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const crypto = require("crypto");

const B = process.env.SANDBOX, OUT = process.env.OUT, VP = process.env.VP;
if (B !== "https://qracks-mon003-sandbox.onrender.com") { console.error("Sólo contra el sandbox."); process.exit(2); }
if (!["movil", "escritorio"].includes(VP) || !OUT) { console.error("Faltan VP=movil|escritorio y OUT."); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const MOBILE = VP === "movil";
const W = MOBILE ? 375 : 1280, H = 800;
const RUN = VP[0] + Date.now().toString(36);
const NAV_TIMEOUT = 90000;

const lines = []; let fails = 0, passes = 0, infos = 0;
const log = (s) => { lines.push(s); console.log(s); };
const check = (name, ok, detail = "") => { if (ok) passes++; else fails++; log(`${ok ? "PASS" : "FAIL"} [${VP}] ${name}${detail ? ": " + detail : ""}`); return !!ok; };
const info = (name, detail = "") => { infos++; log(`INFO [${VP}] ${name}${detail ? ": " + detail : ""}`); };

// ---------- credenciales aleatorias, nunca impresas ----------
const pin4 = () => { let p; do { p = String(crypto.randomInt(0, 10000)).padStart(4, "0"); } while (/^(\d)\1{3}$/.test(p) || /0123|1234|2345|3456|4567|5678|6789|3210|4321|5432|6543|7654|8765|9876/.test(p)); return p; };
const otherPin = (p) => { let q; do { q = pin4(); } while (q === p); return q; };
const secret = () => "pqa-" + crypto.randomBytes(12).toString("base64url");

const api = async (method, path, body, headers = {}) => {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j, raw: t, sc: typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [] };
};
const kv = (slug) => "/api/kv/" + encodeURIComponent(`quiniela:${slug}:meta`);
const pad = (n) => String(n).padStart(2, "0");
// Hora local del navegador (TZ=America/Mexico_City aquí y en el contexto).
const futureLocal = (days) => { const d = new Date(Date.now() + days * 864e5); d.setSeconds(0, 0); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const toLocalStr = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sameTime = (a, b) => new Date(a).getTime() === new Date(b).getTime();
const cookiesFrom = (sc) => sc.map((x) => { const kvp = x.split(";")[0]; const i = kvp.indexOf("="); return { name: kvp.slice(0, i), value: kvp.slice(i + 1) }; }).filter((x) => x.value);

// ---------- textos que pidió el Founder ----------
const WARNING = "Guarda tu PIN en un lugar seguro. Si lo olvidas y cierras tu sesión, no podrás volver a entrar por tu cuenta.";
const PAYMENTS = "Los participantes te pagan directamente a ti, y tú registras manualmente los pagos en QRACKS.";
const TITLE = "Configura tu contraseña de administrador";
const SAVED_LINE = "✅ Contraseña guardada. Revisa la jornada y toca «Publicar jornada» para publicarla.";

// ---------- quiniela sembrada por API (la creadora con PIN y sesión; opcional equipo y jornada preparada) ----------
async function seed(tag, { prepared = false, team = false } = {}) {
  const slug = `pqa31-${tag}-${RUN}`.slice(0, 40);
  const mkey = `quiniela:${slug}:meta`;
  const c = await api("POST", "/api/create-quiniela", { slug, groupName: "PQA " + tag, creatorName: "Ana" });
  if (c.status !== 200 || !c.body || c.body.slug !== slug) throw new Error(`create ${c.status}`);
  const claim = c.sc.find((x) => x.startsWith("qracks_setup_"));
  if (!claim) throw new Error("sin cookie de creación");
  const anaId = (await api("GET", kv(slug))).body.value.creatorId;
  const anaPin = pin4();
  const pinRes = await api("POST", "/api/set-pin", { metaKey: mkey, participantId: anaId, newPin: anaPin, slug }, { Cookie: claim.split(";")[0] });
  if (pinRes.status !== 200) throw new Error("pin " + pinRes.status);
  const q = { slug, mkey, anaId, anaPin, anaCookies: cookiesFrom(pinRes.sc), anaAuth: { "X-Qracks-Auth": anaPin, "X-Qracks-Participant": anaId } };
  const readMeta = async () => (await api("GET", kv(slug), null, q.anaAuth)).body.value;
  const writeMeta = async (v) => { const w = await api("POST", kv(slug), { value: v }, q.anaAuth); if (w.status !== 200) throw new Error("write " + w.status + " " + (w.body && w.body.error)); };
  if (team) {
    const reg = async (name, pin) => { const r = await api("POST", "/api/self-register", { metaKey: mkey, name, pin, slug }); if (r.status !== 200) throw new Error("register " + r.status); return r.body.participant.id; };
    q.carlaPin = pin4(); q.carlaId = await reg("Carla", q.carlaPin);
    q.betoPin = pin4(); q.betoId = await reg("Beto", q.betoPin);
    const v = await readMeta();
    v.participants.find((p) => p.id === q.carlaId).isAdmin = true;
    await writeMeta(v);
  }
  if (prepared) {
    const d = new Date(Date.now() + 4 * 864e5); d.setSeconds(0, 0);
    q.prepDeadline = d.toISOString();
    const v = await readMeta();
    v.rounds.push({ id: "r_prep", number: 1, deadline: q.prepDeadline, results: {}, resultsPublished: false, published: false, provider: "thesportsdb",
      matches: [{ id: "m_p1", teamA: "América", teamB: "Chivas" }, { id: "m_p2", teamA: "Pumas", teamB: "Cruz Azul" }] });
    await writeMeta(v);
  }
  return q;
}
const stored = async (q) => { const r = await api("GET", kv(q.slug), null, q.anaAuth); return r.body && r.body.value; };

(async () => {
  // Espera a que el sandbox despierte (Render lo duerme): hasta ~3 minutos.
  let up = false;
  for (let i = 0; i < 36 && !up; i++) { try { const r = await fetch(B + "/"); up = r.status < 500; } catch {} if (!up) await new Promise((r) => setTimeout(r, 5000)); }
  if (!up) { log(`FAIL [${VP}] el sandbox no respondió`); log("RESULT: 1 FAIL / 0 PASS / 0 INFO"); fs.writeFileSync(`${OUT}/resultado-pqa-${VP}.txt`, lines.join("\n") + "\n"); process.exit(1); }

  const br = await chromium.launch();
  const newCtx = async (cookies) => {
    const ctx = await br.newContext({
      viewport: { width: W, height: H }, deviceScaleFactor: MOBILE ? 2 : 1, isMobile: MOBILE, hasTouch: MOBILE,
      locale: "es-MX", timezoneId: "America/Mexico_City",
      userAgent: MOBILE ? "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36" : undefined,
    });
    ctx.setDefaultTimeout(30000);
    if (cookies && cookies.length) await ctx.addCookies(cookies.map((c) => ({ ...c, url: B })));
    const p = await ctx.newPage();
    watch(p);
    return { ctx, p };
  };
  const watch = (p) => p.on("pageerror", (e) => { fails++; const at = String(e.stack || "").split("\n").slice(1, 3).map((x) => x.trim()).join(" <- "); log(`FAIL [${VP}] error de JavaScript en la página (${new URL(p.url()).pathname.split("/")[1] || "/"}): ${String(e.message).split("\n")[0]} ${at}`); });
  const shot = async (p, name, full = false) => { await p.waitForTimeout(350); await p.screenshot({ path: `${OUT}/pqa-${VP}-${name}.png`, fullPage: full }).catch(() => {}); };
  const tap = (p, sel) => (MOBILE ? p.tap(sel) : p.click(sel));
  const text = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const rawText = async (p, sel) => (await p.locator(sel).first().textContent().catch(() => "") || "").replace(/\s+/g, " ").trim();
  const overlays = (p) => p.locator(".qz-modal-overlay").count();
  const setpwErr = (p) => text(p, "#qz-setpw-modal-error");
  const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const inViewport = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth; }, sel);
  const boxH = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().height : 0; }, sel);
  const fillTeams = async (p, teams) => {
    const rows = p.locator("#qz-setup-match-rows .match-edit-row");
    for (let i = 0; i < teams.length; i++) { await rows.nth(i).locator("[data-role=teamA]").fill(teams[i][0]); await rows.nth(i).locator("[data-role=teamB]").fill(teams[i][1]); }
  };
  const formIntact = async (p, teams, deadline) => {
    const rows = p.locator("#qz-setup-match-rows .match-edit-row");
    if ((await rows.count()) < teams.length) return false;
    for (let i = 0; i < teams.length; i++) {
      if ((await rows.nth(i).locator("[data-role=teamA]").inputValue()) !== teams[i][0]) return false;
      if ((await rows.nth(i).locator("[data-role=teamB]").inputValue()) !== teams[i][1]) return false;
    }
    return (await p.inputValue("#qz-setup-deadline")) === deadline;
  };
  const journey = async (name, fn) => {
    if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return;
    try { await fn(); }
    catch (e) { fails++; log(`FAIL [${VP}] ${name}: excepción inesperada: ${String((e && e.message) || e).split("\n")[0]}`); }
  };
  const openSession = async (p, url) => { await p.goto(B + url, { timeout: NAV_TIMEOUT }); await p.waitForSelector("#qz-session-yes", { timeout: NAV_TIMEOUT }); await tap(p, "#qz-session-yes"); await p.waitForSelector("#qz-setup-cta", { timeout: 45000 }); };

  // =====================================================================
  // J1. CA1: el recorrido completo por la interfaz, desde /crear
  // =====================================================================
  await journey("J1 recorrido completo", async () => {
    const { ctx, p } = await newCtx();
    try {
      await p.goto(B + "/crear", { timeout: NAV_TIMEOUT }); await p.waitForSelector("#qz-c-name", { timeout: NAV_TIMEOUT });
      const card = await text(p, "#qz-crear-card");
      await shot(p, "j1-01-crear", true);
      check("Crear: no hay campo de contraseña ni se menciona la contraseña", (await p.locator("#qz-crear-card input[type=password]").count()) === 0 && !/contraseña|password/i.test(card));
      check("Crear: sin desbordamiento horizontal", await noHScroll(p));
      // faltan campos: no avanza y no se pierde lo escrito
      await p.fill("#qz-c-name", "Quiniela PQA " + RUN);
      await tap(p, "#qz-c-submit"); await p.waitForTimeout(500);
      const miss = await text(p, "#qz-c-status");
      check("Crear: si falta el nombre propio lo dice y conserva lo escrito", /Tu nombre/.test(miss) && (await p.inputValue("#qz-c-name")).startsWith("Quiniela PQA"), miss);
      const slug = `pqa31-${VP[0]}-ui-${RUN}`.slice(0, 40);
      await p.fill("#qz-c-creator", "Ana"); await p.fill("#qz-c-slug", slug);
      // recargar a medias: el borrador de /crear sobrevive
      await p.reload(); await p.waitForSelector("#qz-c-name");
      check("Crear: recargar a mitad conserva el borrador (nombre, tu nombre, link)", (await p.inputValue("#qz-c-name")).startsWith("Quiniela PQA") && (await p.inputValue("#qz-c-creator")) === "Ana" && (await p.inputValue("#qz-c-slug")) === slug);
      await p.dblclick("#qz-c-submit");
      await p.waitForURL(/\?setup=1/, { timeout: 45000 });
      await p.waitForSelector("#qz-setup-pin-input", { timeout: 45000 });
      const pinCard = await rawText(p, ".login-card");
      await shot(p, "j1-02-elegir-pin", true);
      check("PIN: el aviso del Founder aparece tal cual", pinCard.includes(WARNING));
      const warnEl = await rawText(p, "#qz-setup-pin-warning");
      check("PIN: el aviso no menciona la contraseña", warnEl === WARNING && !/contraseña/i.test(warnEl), warnEl.slice(0, 80));
      check("PIN: sin desbordamiento horizontal", await noHScroll(p));
      // recargar en la pantalla del PIN: sigue ahí con el aviso
      await p.reload(); await p.waitForSelector("#qz-setup-pin-input", { timeout: 45000 });
      check("PIN: recargar mantiene la pantalla y el aviso", (await rawText(p, "#qz-setup-pin-warning")) === WARNING);
      // sólo se guarda con 4 dígitos
      await p.locator("#qz-setup-pin-input").focus(); await p.keyboard.type("12");
      check("PIN: con 2 dígitos «Guardar PIN» sigue desactivado", await p.locator("#qz-setup-pin-continue").isDisabled());
      await p.fill("#qz-setup-pin-input", "");
      const anaPin = pin4();
      await p.locator("#qz-setup-pin-input").focus(); await p.keyboard.type(anaPin);
      if (MOBILE) await tap(p, "#qz-setup-pin-continue"); else await p.keyboard.press("Enter");
      await p.waitForSelector("#qz-setup-pin-input", { state: "detached", timeout: 45000 });
      await p.waitForSelector("#qz-setup-cta", { timeout: 45000 });
      const stripWarn = await rawText(p, "#qz-pin-saved");
      await shot(p, "j1-03-tras-pin", true);
      check("Tras el PIN: la franja «PIN guardado» repite el aviso exacto, sin mencionar la contraseña", stripWarn.includes(WARNING) && !/contraseña/i.test(stripWarn), stripWarn.slice(0, 120));
      const meta = (await api("GET", kv(slug))).body.value;
      const creator = (meta.participants || []).find((x) => x.id === meta.creatorId);
      check("La quiniela nace sin contraseña y con Ana como creadora/admin", meta.ownerPasswordSet === false && !!creator && creator.name === "Ana" && creator.isAdmin === true);
      check("La vista pública no expone PIN ni hash de contraseña", !/"pin"\s*:\s*"?\d|ownerPassword"\s*:\s*"/.test((await api("GET", kv(slug))).raw));
      const q = { slug, anaAuth: { "X-Qracks-Auth": anaPin, "X-Qracks-Participant": meta.creatorId } };

      // la jornada manual
      check("Jornada: sin desbordamiento y «Publicar jornada» a la vista", await noHScroll(p) && await inViewport(p, "#qz-setup-cta"));
      const teams = [["América", "Chivas"], ["Pumas", "Toluca"]];
      await fillTeams(p, teams);
      const deadline = futureLocal(3);
      await p.fill("#qz-setup-deadline", deadline);
      await shot(p, "j1-04-jornada-preparada", true);
      const intact = () => formIntact(p, teams, deadline);
      const nothingPublished = async () => { const v = await stored(q); return v.rounds.length === 0 && v.ownerPasswordSet === false; };

      // sin cierre: error y nada cambia
      // Publicar abre la configuración de la contraseña (doble toque: un solo modal).
      await p.dblclick("#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal", { timeout: 20000 }); await p.waitForTimeout(500);
      const modalText = await rawText(p, "#qz-setpw-modal");
      await shot(p, "j1-05-modal-contrasena");
      check("Publicar abre el modal «Configura tu contraseña de administrador»; doble toque = un solo modal", (await overlays(p)) === 1 && modalText.startsWith(TITLE), modalText.slice(0, 60));
      check("Modal: el texto de pagos del Founder aparece tal cual", modalText.includes(PAYMENTS));
      check("Modal: el PIN recién elegido no se vuelve a pedir", !(await p.locator("#qz-setpw-modal-pin").isVisible()));
      check("Modal: sin desbordamiento horizontal", await noHScroll(p));
      const attrs = await p.evaluate(() => ({ a: document.getElementById("qz-setpw-modal-pw").autocomplete, b: document.getElementById("qz-setpw-modal-pw2").autocomplete, t: document.getElementById("qz-setpw-modal-pw").type }));
      check("Modal: los campos son de contraseña nueva (autocomplete=new-password, ocultos)", attrs.a === "new-password" && attrs.b === "new-password" && attrs.t === "password", JSON.stringify(attrs));
      // Mostrar / Ocultar
      await tap(p, "[data-pass-toggle=qz-setpw-modal-pw]");
      const shown = await p.evaluate(() => document.getElementById("qz-setpw-modal-pw").type);
      await tap(p, "[data-pass-toggle=qz-setpw-modal-pw]");
      const hidden = await p.evaluate(() => document.getElementById("qz-setpw-modal-pw").type);
      check("Modal: «Mostrar/Ocultar» alterna sólo ese campo", shown === "text" && hidden === "password");
      // el toque fuera del modal no lo cierra ni pierde nada
      await p.mouse.click(3, 3).catch(() => {}); await p.waitForTimeout(300);
      check("Modal: un toque en el fondo no lo cierra", (await overlays(p)) === 1);

      // Cancelar: «Ahora no» y Esc
      await tap(p, "#qz-setpw-modal-cancel"); await p.waitForTimeout(500);
      await shot(p, "j1-06-ahora-no", true);
      check("«Ahora no»: no publica y conserva partidos y cierre", (await overlays(p)) === 0 && await nothingPublished() && await intact());
      check("«Ahora no»: «Publicar jornada» sigue disponible y a la vista", !(await p.locator("#qz-setup-cta").isDisabled()) && await inViewport(p, "#qz-setup-cta"));
      await tap(p, "#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await p.keyboard.press("Escape"); await p.waitForTimeout(500);
      check("Esc: no publica y conserva partidos y cierre", (await overlays(p)) === 0 && await nothingPublished() && await intact());

      // Equivocarse: vacía, corta, no coinciden
      await tap(p, "#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await tap(p, "#qz-setpw-modal-save"); await p.waitForTimeout(300);
      const e1 = await setpwErr(p);
      await p.fill("#qz-setpw-modal-pw", "corta"); await p.fill("#qz-setpw-modal-pw2", "corta");
      await tap(p, "#qz-setpw-modal-save"); await p.waitForTimeout(300);
      const e2 = await setpwErr(p);
      const pw = secret();
      await p.fill("#qz-setpw-modal-pw", pw); await p.fill("#qz-setpw-modal-pw2", pw + "x");
      await tap(p, "#qz-setpw-modal-save"); await p.waitForTimeout(300);
      const e3 = await setpwErr(p);
      await shot(p, "j1-07-error-no-coinciden");
      check("Equivocarse: vacía, corta y no coincide se dicen sin cerrar el modal", e1 === "Usa al menos 8 caracteres." && e2 === "Usa al menos 8 caracteres." && e3 === "Las contraseñas no coinciden." && (await overlays(p)) === 1, `${e1} | ${e2} | ${e3}`);
      check("Equivocarse: lo escrito en el modal sigue ahí y nada se publicó", (await p.inputValue("#qz-setpw-modal-pw")) === pw && await nothingPublished() && await intact());

      // Sin conexión
      await p.fill("#qz-setpw-modal-pw2", pw);
      await p.route("**/api/set-admin-password", (r) => r.abort("failed"));
      await tap(p, "#qz-setpw-modal-save"); await p.waitForTimeout(1200);
      const e4 = await setpwErr(p);
      await shot(p, "j1-08-error-de-red");
      check("Sin conexión: lo dice, el modal sigue, nada se pierde y se puede reintentar", e4 === "No pudimos guardar la contraseña. Revisa tu conexión e intenta de nuevo." && (await overlays(p)) === 1 && !(await p.locator("#qz-setpw-modal-save").isDisabled()) && await nothingPublished() && await intact(), e4);
      // Error de servidor
      await p.unroute("**/api/set-admin-password");
      await p.route("**/api/set-admin-password", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "server_error" }) }));
      await tap(p, "#qz-setpw-modal-save"); await p.waitForTimeout(800);
      const e5 = await setpwErr(p);
      check("Error 500 al guardar: mensaje claro, sin detalles técnicos, el modal sigue y nada se pierde", /No pudimos guardar/.test(e5) && !/server_error|500|undefined/.test(e5) && (await overlays(p)) === 1 && await nothingPublished() && await intact(), e5);
      // Demasiados intentos (429 simulado)
      await p.unroute("**/api/set-admin-password");
      await p.route("**/api/set-admin-password", (r) => r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "too_many_attempts", retryAfterSeconds: 20 }) }));
      await tap(p, "#qz-setpw-modal-save"); await p.waitForTimeout(900);
      const waitTxt = await text(p, "#qz-setpw-modal");
      await shot(p, "j1-09-espera-429");
      check("429 al guardar: aparece una espera con cuenta regresiva, el modal sigue y nada se pierde", /\b\d+\s*(s|seg)/i.test(waitTxt) && (await overlays(p)) === 1 && await nothingPublished() && await intact());
      await p.unroute("**/api/set-admin-password");
      // «Ahora no» sigue funcionando durante la espera
      await tap(p, "#qz-setpw-modal-cancel"); await p.waitForTimeout(400);
      check("Durante la espera «Ahora no» cierra y conserva todo", (await overlays(p)) === 0 && await nothingPublished() && await intact());
      // Sesión que vence a mitad: se borran las cookies con el modal abierto; el PIN en memoria basta
      await tap(p, "#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await ctx.clearCookies();
      await p.fill("#qz-setpw-modal-pw", pw); await p.fill("#qz-setpw-modal-pw2", pw);
      // esperar a que termine la espera del limitador del cliente si la hubiera
      await p.waitForFunction(() => { const b = document.getElementById("qz-setpw-modal-save"); return b && !b.disabled; }, null, { timeout: 40000 }).catch(() => {});

      // Guardar bien: una petición, ligada a la creadora, no publica
      const reqs = []; const onReq = (r) => { if (r.url().endsWith("/api/set-admin-password")) reqs.push(r.headers()); }; p.on("request", onReq);
      await p.dblclick("#qz-setpw-modal-save");
      await p.waitForSelector("#qz-setpw-modal", { state: "detached", timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(900); p.off("request", onReq);
      let v = await stored(q);
      const savedLine = await text(p, ".qz-pw-saved");
      await shot(p, "j1-10-contrasena-guardada", true);
      check("Guardar (doble toque): una sola petición, con el PIN ligado a la creadora", reqs.length === 1 && reqs[0]["x-qracks-participant"] === meta.creatorId && reqs[0]["x-qracks-auth"] === anaPin, `peticiones=${reqs.length}`);
      check("Guardar la contraseña no publica la jornada", v.ownerPasswordSet === true && v.rounds.length === 0);
      check("Tras guardar: «✅ Contraseña guardada…» visible", savedLine === SAVED_LINE, savedLine.slice(0, 100));
      check("Tras guardar: se retira el aviso «Guarda tu PIN» (en pantalla)", (await p.locator(".qz-pin-saved-warning, .qz-pin-warning").count()) === 0 && !(await p.evaluate(() => document.body.innerText)).includes("Guarda tu PIN en un lugar seguro"));
      check("Tras guardar: partidos y cierre intactos, y «Publicar jornada» sigue a la vista", await intact() && await inViewport(p, "#qz-setup-cta") && await inViewport(p, ".qz-pw-saved"));
      check("Tras guardar: sin desbordamiento horizontal", await noHScroll(p));

      // Publicar explícitamente (doble toque: una sola jornada)
      await p.dblclick("#qz-setup-cta");
      await p.waitForSelector("text=Invita a tus amigos", { timeout: 25000 }).catch(() => {});
      await p.waitForTimeout(900);
      v = await stored(q);
      await shot(p, "j1-11-jornada-publicada", true);
      const r0 = v.rounds[0] || {};
      check("Publicar explícitamente (doble toque): una sola jornada publicada, con los mismos partidos y cierre",
        v.rounds.length === 1 && r0.published === true && (r0.matches || []).length === 2 && r0.matches[0].teamA === "América" && r0.matches[1].teamB === "Toluca" && sameTime(r0.deadline, deadline), `rondas=${v.rounds.length}`);
      check("Tras publicar: pantalla «Invita a tus amigos» y sin desbordamiento", (await p.locator("text=Invita a tus amigos").count()) > 0 && await noHScroll(p));
      // la jornada es visible para un visitante anónimo
      const pub = (await api("GET", kv(slug))).body.value;
      check("Un visitante ve la jornada publicada y la quiniela ya marca contraseña configurada", pub.ownerPasswordSet === true && (pub.rounds || []).some((r) => r.published));
    } finally { await ctx.close(); }
  });

  // =====================================================================
  // J2. CA2: jornada importada (preparada sin publicar), sesión restaurada
  // =====================================================================
  await journey("J2 jornada importada", async () => {
    const q = await seed("imp", { prepared: true });
    const { ctx, p } = await newCtx(q.anaCookies);
    try {
      const prepIntact = (v) => { const r = v.rounds.find((x) => x.id === "r_prep"); return !!r && r.published === false && r.matches.length === 2 && sameTime(r.deadline, q.prepDeadline); };
      await openSession(p, "/q/" + q.slug);
      const reviewTeams = [["América", "Chivas"], ["Pumas", "Cruz Azul"]];
      check("Jornada importada: la pantalla de revisión trae los partidos y el cierre importados", await formIntact(p, reviewTeams, toLocalStr(q.prepDeadline)) && (await text(p, "body")).includes("Revisa tu primera jornada"));
      await shot(p, "j2-01-revision", true);
      await tap(p, "#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await shot(p, "j2-02-modal-pide-pin");
      check("Sesión restaurada: el modal pide el PIN (no está en memoria)", await p.locator("#qz-setpw-modal-pin").isVisible());
      check("Modal con PIN: sin desbordamiento horizontal", await noHScroll(p));
      // Viewport bajo (teclado abierto): el modal se desplaza y «Guardar contraseña» es alcanzable
      await p.setViewportSize({ width: W, height: 520 }); await p.waitForTimeout(300);
      await p.locator("#qz-setpw-modal-save").scrollIntoViewIfNeeded();
      check("Viewport bajo (teclado): «Guardar contraseña» se alcanza desplazando el modal", await inViewport(p, "#qz-setpw-modal-save"));
      await shot(p, "j2-03-viewport-bajo");
      await p.setViewportSize({ width: W, height: H }); await p.waitForTimeout(300);
      // Faltan campos: sin PIN -> pide PIN, sin gastar intentos
      const pw = secret();
      await p.fill("#qz-setpw-modal-pw", pw); await p.fill("#qz-setpw-modal-pw2", pw);
      await tap(p, "#qz-setpw-modal-save"); await p.waitForTimeout(400);
      check("Sin PIN: pide el PIN de 4 números y no pierde la contraseña escrita", (await setpwErr(p)) === "Escribe tu PIN de 4 números." && (await p.inputValue("#qz-setpw-modal-pw")) === pw);
      // PIN incorrecto
      await p.fill("#qz-setpw-modal-pin", otherPin(q.anaPin));
      await tap(p, "#qz-setpw-modal-save"); await p.waitForTimeout(1800);
      const e = await setpwErr(p);
      await shot(p, "j2-04-pin-incorrecto");
      let v = await stored(q);
      check("PIN incorrecto: «Ese PIN no es correcto.», borra sólo el PIN; nada publicado; jornada intacta",
        e === "Ese PIN no es correcto." && (await p.inputValue("#qz-setpw-modal-pin")) === "" && (await p.inputValue("#qz-setpw-modal-pw")) === pw && v.ownerPasswordSet === false && prepIntact(v), e);
      await tap(p, "#qz-setpw-modal-cancel"); await p.waitForTimeout(400);
      v = await stored(q);
      check("«Ahora no» tras el error: nada publicado, jornada intacta", (await overlays(p)) === 0 && v.ownerPasswordSet === false && prepIntact(v));
      check("«Ahora no» tras el error: la revisión sigue con sus partidos y su cierre", await formIntact(p, reviewTeams, toLocalStr(q.prepDeadline)));
      // Esc con el modal abierto
      await tap(p, "#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await p.keyboard.press("Escape"); await p.waitForTimeout(400);
      v = await stored(q);
      check("Esc: cierra sin publicar y la jornada sigue intacta", (await overlays(p)) === 0 && prepIntact(v));
      // Recargar con el modal abierto
      await tap(p, "#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await p.reload(); await p.waitForSelector("#qz-session-yes", { timeout: NAV_TIMEOUT });
      v = await stored(q);
      check("Recargar con el modal abierto: no publica y la jornada importada sigue intacta", v.ownerPasswordSet === false && prepIntact(v));
      await tap(p, "#qz-session-yes"); await p.waitForSelector("#qz-setup-cta", { timeout: 45000 });
      await shot(p, "j2-05-tras-recargar", true);
      check("Tras recargar: la revisión vuelve con los mismos partidos y el mismo cierre", await formIntact(p, reviewTeams, toLocalStr(q.prepDeadline)));
      // Atrás con el modal abierto
      await tap(p, "#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await p.goBack().catch(() => {}); await p.waitForTimeout(1500);
      v = await stored(q);
      info("Botón atrás con el modal abierto", `URL ${new URL(p.url()).pathname}; modal abierto: ${(await overlays(p)) > 0}; jornada importada intacta en el servidor: ${prepIntact(v)}`);
      check("Botón atrás: no publica y la jornada importada sigue intacta", v.ownerPasswordSet === false && prepIntact(v));
      await p.goto(B + "/q/" + q.slug, { timeout: NAV_TIMEOUT });
      await p.waitForSelector("#qz-session-yes, #qz-setup-cta", { timeout: NAV_TIMEOUT });
      if (await p.locator("#qz-session-yes").count()) { await tap(p, "#qz-session-yes"); }
      await p.waitForSelector("#qz-setup-cta", { timeout: 45000 });
      // PIN correcto, guardar
      await tap(p, "#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await p.fill("#qz-setpw-modal-pin", q.anaPin); await p.fill("#qz-setpw-modal-pw", pw); await p.fill("#qz-setpw-modal-pw2", pw);
      await p.locator("#qz-setpw-modal-pw2").press("Enter");
      await p.waitForSelector("#qz-setpw-modal", { state: "detached", timeout: 20000 });
      v = await stored(q);
      check("PIN correcto (Enter en el campo): guarda la contraseña sin publicar", v.ownerPasswordSet === true && prepIntact(v));
      check("Tras guardar: aviso «✅ Contraseña guardada…» y «Publicar jornada» a la vista", (await text(p, ".qz-pw-saved")) === SAVED_LINE && await inViewport(p, "#qz-setup-cta"));
      await shot(p, "j2-06-guardada", true);
      // Falla la red al publicar: «Tus cambios siguen aquí» y se puede reintentar
      await p.route("**/api/kv/**", (r) => (r.request().method() === "POST" ? r.abort("failed") : r.continue()));
      await tap(p, "#qz-setup-cta"); await p.waitForTimeout(1500);
      const pubErr = await text(p, "#qz-setup-error");
      v = await stored(q);
      await shot(p, "j2-07-error-publicar", true);
      check("Sin red al publicar: dice «Tus cambios siguen aquí», no publica y el botón vuelve", /Tus cambios siguen aquí/.test(pubErr) && prepIntact(v) && !(await p.locator("#qz-setup-cta").isDisabled()) && (await text(p, "#qz-setup-cta")) === "Publicar jornada", pubErr);
      await p.unroute("**/api/kv/**");
      await tap(p, "#qz-setup-cta");
      await p.waitForSelector("text=Invita a tus amigos", { timeout: 25000 }).catch(() => {});
      await p.waitForTimeout(800);
      v = await stored(q);
      const r = v.rounds.find((x) => x.id === "r_prep");
      await shot(p, "j2-08-publicada", true);
      check("Reintentar publica la jornada importada con sus partidos y su cierre (una sola jornada)", !!r && v.rounds.length === 1 && r.published === true && r.matches.length === 2 && sameTime(r.deadline, q.prepDeadline));
    } finally { await ctx.close(); }
  });

  // =====================================================================
  // J3. Setup manual: ¿qué pasa si el usuario sale a otra app (guardar la contraseña) y la página se recarga?
  // =====================================================================
  await journey("J3 salir y volver (manual)", async () => {
    const q = await seed("man");
    const { ctx, p } = await newCtx(q.anaCookies);
    try {
      await openSession(p, "/q/" + q.slug);
      const teams = [["León", "Santos"], ["Tigres", "Monterrey"]];
      await fillTeams(p, teams); const dl = futureLocal(2); await p.fill("#qz-setup-deadline", dl);
      await tap(p, "#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      // Simula el cambio a otra app y que el navegador recargue la pestaña
      await p.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("blur")); });
      await p.waitForTimeout(500);
      check("Salir y volver a la pestaña (blur/visibilidad) sin recargar: el modal y lo escrito siguen", (await overlays(p)) === 1);
      await p.reload(); await p.waitForSelector("#qz-session-yes", { timeout: NAV_TIMEOUT });
      await tap(p, "#qz-session-yes"); await p.waitForSelector("#qz-setup-cta", { timeout: 45000 });
      const a = await p.locator("#qz-setup-match-rows .match-edit-row").nth(0).locator("[data-role=teamA]").inputValue();
      const d = await p.inputValue("#qz-setup-deadline");
      await shot(p, "j3-01-manual-tras-recargar", true);
      const lost = !(a === "León" && d === dl);
      const v = await stored(q);
      info("Setup manual: la pestaña se recarga con el modal abierto (equivale a volver de otra app donde el navegador la descartó)", lost ? "SE PIERDEN los partidos y el cierre escritos (sin aviso). Ya ocurría en main 4e5cbec; el paso nuevo da más motivo para salir de la página" : "se conservan");
      info("Setup manual tras recargar: estado del servidor", `rondas=${v.rounds.length}, contraseña=${v.ownerPasswordSet}`);
      // ¿Hay aviso al salir de la página?
      const guard = await p.evaluate(() => typeof window.onbeforeunload);
      info("Setup manual: aviso al salir (beforeunload)", guard === "function" ? "hay" : "no hay");
    } finally { await ctx.close(); }
  });

  // =====================================================================
  // J4. CA3: co-admin
  // =====================================================================
  await journey("J4 co-admin", async () => {
    const q = await seed("coa", { team: true });
    const { ctx, p } = await newCtx();
    try {
      await p.goto(B + "/q/" + q.slug, { timeout: NAV_TIMEOUT }); await p.waitForSelector(".name-btn", { timeout: NAV_TIMEOUT });
      await tap(p, ".name-btn:has-text('Carla')"); await p.waitForSelector("#qz-prompt-input");
      await p.fill("#qz-prompt-input", q.carlaPin); await tap(p, "#qz-modal-confirm-btn");
      await p.waitForSelector("#qz-setup-cta", { timeout: 45000 });
      const teams = [["Necaxa", "Atlas"]];
      await fillTeams(p, teams);
      const dl = futureLocal(2); await p.fill("#qz-setup-deadline", dl);
      const nothing = async () => { const v = await stored(q); return v.rounds.length === 0 && v.ownerPasswordSet === false; };
      // doble toque en Publicar: un solo aviso
      await p.evaluate(() => { const b = document.getElementById("qz-setup-cta"); b.click(); b.click(); });
      await p.waitForSelector(".qz-modal-card", { timeout: 20000 }); await p.waitForTimeout(700);
      const cards = await p.locator(".qz-modal-card").count();
      const msg = await rawText(p, ".qz-modal-card");
      const btns = await p.$$eval(".qz-modal-overlay .qz-modal-actions button", (bs) => bs.map((b) => b.textContent.trim()));
      await shot(p, "j4-01-coadmin-aviso");
      check("Co-admin: al publicar antes que la creadora ve un aviso que nombra a Ana, con un solo botón «Entendido»", cards === 1 && JSON.stringify(btns) === '["Entendido"]' && /Ana \(quien creó la quiniela\) tiene que configurar la contraseña de administrador/.test(msg), `avisos=${cards} botones=${JSON.stringify(btns)}`);
      check("Co-admin: el aviso no ofrece crear la contraseña (sin campos ni «Guardar contraseña»)", (await p.locator(".qz-modal-overlay input").count()) === 0 && !/Guardar contraseña|Configura tu contraseña/.test(msg));
      check("Co-admin: aviso sin desbordamiento horizontal", await noHScroll(p));
      await tap(p, ".qz-modal-overlay .qz-modal-actions button"); await p.waitForTimeout(500);
      check("Co-admin: tras «Entendido» nada se publicó, sigue sin contraseña y conserva partidos y cierre", (await overlays(p)) === 0 && await nothing() && await formIntact(p, teams, dl));
      await shot(p, "j4-02-coadmin-conserva", true);
      // Otra vez, con Esc
      await tap(p, "#qz-setup-cta"); await p.waitForSelector(".qz-modal-card");
      await p.keyboard.press("Escape"); await p.waitForTimeout(500);
      check("Co-admin: Esc también cierra el aviso sin perder nada", (await overlays(p)) === 0 && await nothing() && await formIntact(p, teams, dl));
      // Servidor: un co-admin no puede publicar ni configurar la contraseña por la API
      const carlaAuth = { "X-Qracks-Auth": q.carlaPin, "X-Qracks-Participant": q.carlaId };
      const mv = (await api("GET", kv(q.slug), null, carlaAuth)).body.value;
      mv.rounds.push({ id: "r_x", number: 1, deadline: new Date(Date.now() + 2 * 864e5).toISOString(), results: {}, resultsPublished: false, published: true, matches: [{ id: "m_x", teamA: "A", teamB: "B" }] });
      const pubApi = await api("POST", kv(q.slug), { value: mv }, carlaAuth);
      const setApi = await api("POST", "/api/set-admin-password", { metaKey: q.mkey, password: secret() }, carlaAuth);
      const betoApi = await api("POST", "/api/set-admin-password", { metaKey: q.mkey, password: secret() }, { "X-Qracks-Auth": q.betoPin, "X-Qracks-Participant": q.betoId });
      check("Servidor: el co-admin no publica sin contraseña (admin_password_required) ni la configura (not_creator); un participante tampoco",
        pubApi.status === 409 && pubApi.body && pubApi.body.error === "admin_password_required" && setApi.status === 403 && setApi.body && setApi.body.error === "not_creator" && betoApi.status === 403, `publicar=${pubApi.status} configurar=${setApi.status} participante=${betoApi.status}`);
      check("Servidor: tras esos intentos sigue sin rondas ni contraseña", await nothing());
      // Quiniela ajena: la sesión/PIN de Ana no sirve en otra quiniela
      const other = await seed("otra");
      const cross = await api("POST", "/api/set-admin-password", { metaKey: other.mkey, password: secret() }, q.anaAuth);
      check("Otra quiniela: el PIN de Ana de esta quiniela no configura la contraseña de la ajena", cross.status === 403 || cross.status === 404, `estado=${cross.status}`);
      check("Anónimo: no puede configurar la contraseña", (await api("POST", "/api/set-admin-password", { metaKey: q.mkey, password: secret() })).status === 403);

      // Ajustes del co-admin
      const p2 = await ctx.newPage(); watch(p2);
      await p2.goto(B + "/a/" + q.slug, { timeout: NAV_TIMEOUT }); await p2.waitForSelector('#qz-session-yes, [data-sub="dueno"]', { timeout: NAV_TIMEOUT });
      if (await p2.locator("#qz-session-yes").count()) await tap(p2, "#qz-session-yes");
      await p2.waitForSelector('[data-sub="dueno"]', { timeout: 45000 });
      await p2.waitForSelector("#qz-add-match", { timeout: 30000 }).catch(() => {}); // deja terminar el render de Jornadas antes de cambiar de pestaña
      await tap(p2, '[data-sub="dueno"]'); await p2.waitForTimeout(2500);
      const aj = await text(p2, "#qz-admin-body");
      await shot(p2, "j4-03-coadmin-ajustes", true);
      check("Co-admin en Ajustes: dice que Ana configurará la contraseña y no ve cómo crearla",
        /Ana \(quien creó la quiniela\) configurará la contraseña de administrador/.test(aj) && (await p2.locator("#qz-admin-body input[type=password]").count()) === 0, aj.slice(0, 120));
      await p2.close();

      // La creadora configura la contraseña (otro dispositivo); la pestaña del co-admin va atrasada
      const s = await api("POST", "/api/set-admin-password", { metaKey: q.mkey, password: secret() }, q.anaAuth);
      if (s.status !== 200) throw new Error("set-admin-password " + s.status);
      await tap(p, "#qz-setup-cta"); await p.waitForTimeout(3500);
      const v = await stored(q);
      await shot(p, "j4-04-coadmin-publica", true);
      const r = v.rounds[0] || {};
      check("Co-admin: cuando Ana ya configuró la contraseña, publica sin trabas y con lo que había escrito",
        (await overlays(p)) === 0 && v.rounds.length === 1 && r.published === true && r.matches[0].teamA === "Necaxa" && sameTime(r.deadline, dl), `rondas=${v.rounds.length}`);
      check("Co-admin: tras publicar ve «Invita a tus amigos»", (await p.locator("text=Invita a tus amigos").count()) > 0);
    } finally { await ctx.close(); }
  });

  // =====================================================================
  // J5. CA3 (variante): el co-admin entra cuando la contraseña ya existe: publica a la primera
  // =====================================================================
  await journey("J5 co-admin con contraseña ya configurada", async () => {
    const q = await seed("coa2", { team: true });
    const s = await api("POST", "/api/set-admin-password", { metaKey: q.mkey, password: secret() }, q.anaAuth);
    if (s.status !== 200) throw new Error("set-admin-password " + s.status);
    const { ctx, p } = await newCtx();
    try {
      await p.goto(B + "/q/" + q.slug, { timeout: NAV_TIMEOUT }); await p.waitForSelector(".name-btn", { timeout: NAV_TIMEOUT });
      await tap(p, ".name-btn:has-text('Carla')"); await p.waitForSelector("#qz-prompt-input");
      await p.fill("#qz-prompt-input", q.carlaPin); await tap(p, "#qz-modal-confirm-btn");
      await p.waitForSelector("#qz-setup-cta", { timeout: 45000 });
      const pinWarn = (await p.evaluate(() => document.body.innerText)).includes("Guarda tu PIN en un lugar seguro");
      check("Con contraseña ya existente no se muestra el aviso «Guarda tu PIN»", !pinWarn);
      await fillTeams(p, [["Cruz Azul", "Puebla"]]); const dl = futureLocal(2); await p.fill("#qz-setup-deadline", dl);
      await tap(p, "#qz-setup-cta");
      await p.waitForSelector("text=Invita a tus amigos", { timeout: 25000 }).catch(() => {});
      await p.waitForTimeout(600);
      const v = await stored(q); const r = v.rounds[0] || {};
      await shot(p, "j5-01-publicada", true);
      check("Co-admin con contraseña ya configurada: publica a la primera, sin avisos", (await overlays(p)) === 0 && v.rounds.length === 1 && r.published === true && sameTime(r.deadline, dl));
    } finally { await ctx.close(); }
  });

  // =====================================================================
  // J6. La creadora ve el setup de contraseña también en Ajustes (/a/<slug>) antes de publicar
  // =====================================================================
  await journey("J6 creadora en Ajustes", async () => {
    const q = await seed("aju", { prepared: true });
    const { ctx, p } = await newCtx(q.anaCookies);
    try {
      await p.goto(B + "/a/" + q.slug, { timeout: NAV_TIMEOUT });
      await p.waitForSelector('#qz-session-yes, #qz-setup-cta, [data-sub="dueno"]', { timeout: NAV_TIMEOUT });
      if (await p.locator("#qz-session-yes").count()) await tap(p, "#qz-session-yes");
      await p.waitForSelector('#qz-setup-cta, [data-sub="dueno"]', { timeout: 45000 });
      if (await p.locator('[data-sub="dueno"]').count() === 0) {
        info("Creadora en /a/<slug> antes de publicar", "la pantalla de preparación de la primera jornada toma el control; Ajustes no es alcanzable hasta publicar");
        await shot(p, "j6-01-a-slug", true);
        return;
      }
      await p.waitForSelector("#qz-add-match", { timeout: 30000 }).catch(() => {});
      await tap(p, '[data-sub="dueno"]'); await p.waitForSelector("#qz-setpw-settings-card", { timeout: 20000 });
      const t = await rawText(p, "#qz-setpw-settings-card");
      await shot(p, "j6-02-ajustes-creadora", true);
      check("Ajustes de la creadora: mismo título y texto de pagos, sin «Ahora no»", t.startsWith(TITLE) && t.includes(PAYMENTS) && (await p.locator("#qz-setpw-settings-cancel").count()) === 0);
      const pw = secret();
      await p.fill("#qz-setpw-settings-pin", q.anaPin); await p.fill("#qz-setpw-settings-pw", pw); await p.fill("#qz-setpw-settings-pw2", pw);
      await tap(p, "#qz-setpw-settings-save"); await p.waitForTimeout(2500);
      const v = await stored(q);
      check("Ajustes: guardar la contraseña no publica la jornada preparada", v.ownerPasswordSet === true && v.rounds.every((x) => x.published === false));
    } finally { await ctx.close(); }
  });

  await br.close();
  log(fails ? `RESULT: ${fails} FAIL / ${passes} PASS / ${infos} INFO` : `RESULT: ALL PASS (${passes}) / ${infos} INFO`);
  fs.writeFileSync(`${OUT}/resultado-pqa-${VP}.txt`, lines.join("\n") + "\n");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e && e.message); try { fs.writeFileSync(`${OUT}/resultado-pqa-${VP}.txt`, lines.join("\n") + "\nERROR " + (e && e.message) + "\n"); } catch {} process.exit(1); });
