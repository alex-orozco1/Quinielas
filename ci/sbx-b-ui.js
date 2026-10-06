// Onboarding B (#30 + #31) en el SANDBOX, en el navegador:
//   crear sin contraseña → elegir PIN → preparar la jornada → configurar la contraseña
//   al publicar → publicar explícitamente.
// Además: cancelar o equivocarse no pierde partidos ni cierre, y un co-admin no se
// adelanta a la creadora.
// Uso: SANDBOX=https://qracks-mon003-sandbox.onrender.com VP=movil|escritorio OUT=<dir> TZ=America/Mexico_City node ci/sbx-b-ui.js
// Nunca producción: el script se niega a correr contra otra URL. PINs y contraseñas
// aleatorios y desechables; no se imprimen.
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

const lines = []; let fails = 0, passes = 0, infos = 0;
const log = (s) => { lines.push(s); console.log(s); };
const check = (name, ok, detail = "") => { if (ok) passes++; else fails++; log(`${ok ? "PASS" : "FAIL"} [${VP}] ${name}${detail ? ": " + detail : ""}`); };
const info = (name, detail = "") => { infos++; log(`INFO [${VP}] ${name}${detail ? ": " + detail : ""}`); };

const pin4 = () => { let p; do { p = String(crypto.randomInt(0, 10000)).padStart(4, "0"); } while (/^(\d)\1{3}$/.test(p)); return p; };
const otherPin = (p) => String((Number(p) + 1 + crypto.randomInt(0, 9000)) % 10000).padStart(4, "0");
const secret = () => "sbx-" + crypto.randomBytes(12).toString("base64url");
const api = async (method, path, body, headers = {}) => {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j, sc: typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [] };
};
const kv = (slug) => "/api/kv/" + encodeURIComponent(`quiniela:${slug}:meta`);
// Hora local del navegador (TZ=America/Mexico_City aquí y en el contexto).
const futureLocal = (days) => { const d = new Date(Date.now() + days * 864e5); d.setSeconds(0, 0); const pad = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sameTime = (a, b) => new Date(a).getTime() === new Date(b).getTime();

const WARNING = "Guarda tu PIN en un lugar seguro. Si lo olvidas y cierras tu sesión, no podrás volver a entrar por tu cuenta.";
const PAYMENTS = "Los participantes te pagan directamente a ti, y tú registras manualmente los pagos en QRACKS.";
const TITLE = "Configura tu contraseña de administrador";
const SAVED_LINE = "✅ Contraseña guardada. Revisa la jornada y toca «Publicar jornada» para publicarla.";
const COADMIN_MSG = "Antes de publicar la primera jornada, Ana (quien creó la quiniela) tiene que configurar la contraseña de administrador.";
const COADMIN_SETTINGS = "Ana (quien creó la quiniela) configurará la contraseña de administrador.";

// Quiniela por API: Ana (creadora, con su PIN y su sesión); opcional Carla co-admin y
// Beto; opcional una jornada importada sin publicar.
async function seed(tag, { prepared = false, team = false } = {}) {
  const slug = `sbx31-${tag}-${RUN}`.slice(0, 40);
  const mkey = `quiniela:${slug}:meta`;
  const c = await api("POST", "/api/create-quiniela", { slug, groupName: "Sandbox " + tag, creatorName: "Ana" });
  if (c.status !== 200 || !c.body || c.body.slug !== slug) throw new Error(`create ${c.status} ${JSON.stringify(c.body)}`);
  const claimCookie = c.sc.find((x) => x.startsWith("qracks_setup_"));
  if (!claimCookie) throw new Error("sin cookie de creación");
  const anaId = (await api("GET", kv(slug))).body.value.creatorId;
  const anaPin = pin4();
  const pinRes = await api("POST", "/api/set-pin", { metaKey: mkey, participantId: anaId, newPin: anaPin, slug }, { Cookie: claimCookie.split(";")[0] });
  if (pinRes.status !== 200) throw new Error("pin " + pinRes.status);
  const anaCookies = pinRes.sc.map((x) => { const kvp = x.split(";")[0]; const i = kvp.indexOf("="); return { name: kvp.slice(0, i), value: kvp.slice(i + 1) }; }).filter((x) => x.value);
  const anaAuth = { "X-Qracks-Auth": anaPin, "X-Qracks-Participant": anaId };
  const q = { slug, mkey, anaId, anaPin, anaCookies, anaAuth };
  if (team) {
    const reg = async (name, pin) => {
      const r = await api("POST", "/api/self-register", { metaKey: mkey, name, pin, slug });
      if (r.status !== 200) throw new Error("register " + r.status);
      return r.body.participant.id;
    };
    q.carlaPin = pin4(); q.carlaId = await reg("Carla", q.carlaPin);
    q.betoId = await reg("Beto", pin4());
    const v = (await api("GET", kv(slug), null, anaAuth)).body.value;
    v.participants.find((p) => p.id === q.carlaId).isAdmin = true;
    const w = await api("POST", kv(slug), { value: v }, anaAuth);
    if (w.status !== 200) throw new Error("promote " + w.status);
  }
  if (prepared) {
    const d = new Date(Date.now() + 4 * 864e5); d.setSeconds(0, 0);
    q.prepDeadline = d.toISOString();
    const v = (await api("GET", kv(slug), null, anaAuth)).body.value;
    v.rounds.push({ id: "r_prep", number: 1, deadline: q.prepDeadline, results: {}, resultsPublished: false, published: false, provider: "thesportsdb",
      matches: [{ id: "m_p1", teamA: "América", teamB: "Chivas" }, { id: "m_p2", teamA: "Pumas", teamB: "Cruz Azul" }] });
    const w = await api("POST", kv(slug), { value: v }, anaAuth);
    if (w.status !== 200) throw new Error("prep " + w.status);
  }
  return q;
}
const stored = async (q) => { const r = await api("GET", kv(q.slug), null, q.anaAuth); return r.body && r.body.value; };

(async () => {
  const br = await chromium.launch();
  const newCtx = async (cookies) => {
    const ctx = await br.newContext({
      viewport: { width: W, height: H }, deviceScaleFactor: MOBILE ? 2 : 1, isMobile: MOBILE, hasTouch: MOBILE,
      locale: "es-MX", timezoneId: "America/Mexico_City",
      userAgent: MOBILE ? "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36" : undefined,
    });
    if (cookies && cookies.length) await ctx.addCookies(cookies.map((c) => ({ ...c, url: B })));
    const p = await ctx.newPage();
    watch(p);
    return { ctx, p };
  };
  const watch = (p) => p.on("pageerror", (e) => log(`PAGEERROR [${VP}] ${e.message}`));
  const shot = async (p, name, full = false) => { await p.waitForTimeout(400); await p.screenshot({ path: `${OUT}/${VP}-${name}.png`, fullPage: full }); };
  const text = async (p, sel) => (await p.locator(sel).first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const overlays = (p) => p.locator(".qz-modal-overlay").count();
  const setpwErr = (p) => text(p, "#qz-setpw-modal-error");
  const formIntact = async (p, rowsSel, deadlineSel, teams, deadline) => {
    const rows = p.locator(`${rowsSel} .match-edit-row`);
    for (let i = 0; i < teams.length; i++) {
      if ((await rows.nth(i).locator("[data-role=teamA]").inputValue()) !== teams[i][0]) return false;
      if ((await rows.nth(i).locator("[data-role=teamB]").inputValue()) !== teams[i][1]) return false;
    }
    return (await p.inputValue(deadlineSel)) === deadline;
  };
  const journey = async (name, fn) => {
    try { await fn(); }
    catch (e) { fails++; log(`FAIL [${VP}] ${name}: excepción ${String(e && e.message || e).split("\n")[0]}`); }
  };

  // ======== J1. El recorrido completo, por la interfaz ========
  await journey("J1 recorrido completo", async () => {
    const { ctx, p } = await newCtx();
    try {
      await p.goto(B + "/crear"); await p.waitForSelector("#qz-c-name", { timeout: 60000 });
      const card = await text(p, "#qz-crear-card");
      await shot(p, "01-crear");
      check("Crear: sin campo ni mención de contraseña", (await p.locator("#qz-crear-card input[type=password]").count()) === 0 && !/contraseña/i.test(card));
      const slug = `sbx31-ui-${RUN}`;
      await p.fill("#qz-c-name", "Quiniela de la oficina"); await p.fill("#qz-c-creator", "Ana"); await p.fill("#qz-c-slug", slug);
      await p.click("#qz-c-submit");
      await p.waitForURL(/\?setup=1/, { timeout: 30000 });
      await p.waitForSelector("#qz-setup-pin-input", { timeout: 30000 });
      const pinCard = await text(p, ".login-card");
      await shot(p, "02-elegir-pin");
      check("PIN: aviso exacto y ninguna mención de la contraseña", pinCard.includes(WARNING) && !/contraseña/i.test(pinCard));
      const anaPin = pin4();
      await p.locator("#qz-setup-pin-input").focus(); await p.keyboard.type(anaPin); await p.keyboard.press("Enter");
      await p.waitForSelector("#qz-setup-pin-input", { state: "detached", timeout: 30000 });
      await p.waitForSelector("#qz-setup-cta", { timeout: 30000 });
      const meta = (await api("GET", kv(slug))).body.value;
      const creator = (meta.participants || []).find((x) => x.id === meta.creatorId);
      check("La quiniela nace sin contraseña y con Ana como creadora", meta.ownerPasswordSet === false && !!creator && creator.name === "Ana" && creator.isAdmin === true);
      const q = { slug, anaAuth: { "X-Qracks-Auth": anaPin, "X-Qracks-Participant": meta.creatorId } };

      const teams = [["América", "Chivas"], ["Pumas", "Toluca"]];
      const rows = p.locator("#qz-setup-match-rows .match-edit-row");
      for (let i = 0; i < teams.length; i++) { await rows.nth(i).locator("[data-role=teamA]").fill(teams[i][0]); await rows.nth(i).locator("[data-role=teamB]").fill(teams[i][1]); }
      const deadline = futureLocal(3);
      await p.fill("#qz-setup-deadline", deadline);
      await shot(p, "03-jornada-preparada", true);
      const intact = () => formIntact(p, "#qz-setup-match-rows", "#qz-setup-deadline", teams, deadline);
      const nothingPublished = async () => { const v = await stored(q); return v.rounds.length === 0 && v.ownerPasswordSet === false; };

      // Publicar abre la configuración de la contraseña (doble toque: un solo modal).
      await p.dblclick("#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal", { timeout: 15000 }); await p.waitForTimeout(500);
      const modal = await text(p, "#qz-setpw-modal");
      await shot(p, "04-modal-contrasena");
      check("Publicar abre «Configura tu contraseña de administrador», un solo modal aunque sea doble toque", (await overlays(p)) === 1 && modal.startsWith(TITLE), modal.slice(0, 60));
      check("Pagos: los participantes pagan directo al admin y él los registra a mano", modal.includes(PAYMENTS));
      check("El PIN recién elegido no se vuelve a pedir", !(await p.locator("#qz-setpw-modal-pin").isVisible()));

      // Cancelar: «Ahora no» y Esc.
      await p.click("#qz-setpw-modal-cancel"); await p.waitForTimeout(500);
      await shot(p, "05-ahora-no-conserva", true);
      check("«Ahora no»: no publica y conserva partidos y cierre", (await overlays(p)) === 0 && await nothingPublished() && await intact());
      await p.click("#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await p.keyboard.press("Escape"); await p.waitForTimeout(500);
      check("Esc: no publica y conserva partidos y cierre", (await overlays(p)) === 0 && await nothingPublished() && await intact());

      // Equivocarse: vacía, corta, no coinciden.
      await p.click("#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await p.click("#qz-setpw-modal-save"); await p.waitForTimeout(300);
      const e1 = await setpwErr(p);
      await p.fill("#qz-setpw-modal-pw", "corta"); await p.fill("#qz-setpw-modal-pw2", "corta");
      await p.click("#qz-setpw-modal-save"); await p.waitForTimeout(300);
      const e2 = await setpwErr(p);
      const pw = secret();
      await p.fill("#qz-setpw-modal-pw", pw); await p.fill("#qz-setpw-modal-pw2", pw + "x");
      await p.click("#qz-setpw-modal-save"); await p.waitForTimeout(300);
      const e3 = await setpwErr(p);
      await shot(p, "06-error-no-coinciden");
      check("Equivocarse: vacía, corta y no coinciden lo dicen sin cerrar el modal", e1 === "Usa al menos 8 caracteres." && e2 === "Usa al menos 8 caracteres." && e3 === "Las contraseñas no coinciden." && (await overlays(p)) === 1, `${e1} | ${e2} | ${e3}`);
      check("Equivocarse: nada publicado y partidos y cierre intactos", await nothingPublished() && await intact());

      // Sin conexión al guardar.
      await p.fill("#qz-setpw-modal-pw2", pw);
      await p.route("**/api/set-admin-password", (r) => r.abort("failed"));
      await p.click("#qz-setpw-modal-save"); await p.waitForTimeout(1000);
      const e4 = await setpwErr(p);
      await shot(p, "07-error-de-red");
      await p.unroute("**/api/set-admin-password");
      check("Sin conexión al guardar: lo dice, el modal sigue y no se pierde nada", e4 === "No pudimos guardar la contraseña. Revisa tu conexión e intenta de nuevo." && (await overlays(p)) === 1 && await nothingPublished() && await intact(), e4);

      // Guardar bien: una petición con el PIN de memoria ligado a la creadora; no publica.
      const reqs = []; const onReq = (r) => { if (r.url().endsWith("/api/set-admin-password")) reqs.push(r.headers()); }; p.on("request", onReq);
      await p.click("#qz-setpw-modal-save");
      await p.waitForSelector("#qz-setpw-modal", { state: "detached", timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(800); p.off("request", onReq);
      let v = await stored(q);
      const savedLine = await text(p, ".qz-pw-saved");
      await shot(p, "08-contrasena-guardada", true);
      check("Guardar: una sola petición, con el PIN ligado a la creadora", reqs.length === 1 && reqs[0]["x-qracks-participant"] === meta.creatorId && reqs[0]["x-qracks-auth"] === anaPin, `peticiones=${reqs.length}`);
      check("Guardar la contraseña no publica", v.ownerPasswordSet === true && v.rounds.length === 0);
      check("Tras guardar: «✅ Contraseña guardada…» y se retira el aviso «Guarda tu PIN»", savedLine === SAVED_LINE && (await p.locator(".qz-pin-saved-warning, .qz-pin-warning").count()) === 0, savedLine);
      check("Tras guardar: partidos y cierre intactos", await intact());

      // Publicar explícitamente.
      await p.click("#qz-setup-cta");
      await p.waitForSelector("text=Invita a tus amigos", { timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(800);
      v = await stored(q);
      await shot(p, "09-jornada-publicada", true);
      const r0 = v.rounds[0] || {};
      check("Publicar explícitamente: publica con los mismos partidos y el mismo cierre",
        v.rounds.length === 1 && r0.published === true && (r0.matches || []).length === 2 && r0.matches[0].teamA === "América" && r0.matches[1].teamB === "Toluca" && sameTime(r0.deadline, deadline),
        `rondas=${v.rounds.length}`);
    } finally { await ctx.close(); }
  });

  // ======== J2. Jornada importada y sesión restaurada: el PIN se pide; equivocarse o recargar no pierde nada ========
  await journey("J2 revisión con PIN", async () => {
    const q = await seed("rev", { prepared: true });
    const { ctx, p } = await newCtx(q.anaCookies);
    try {
      const prepIntact = (v) => { const r = v.rounds.find((x) => x.id === "r_prep"); return !!r && r.published === false && r.matches.length === 2 && sameTime(r.deadline, q.prepDeadline); };
      await p.goto(B + "/q/" + q.slug); await p.waitForSelector("#qz-session-yes", { timeout: 60000 });
      await p.click("#qz-session-yes"); await p.waitForSelector("#qz-setup-cta", { timeout: 30000 });
      await p.click("#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await shot(p, "10-modal-pide-pin");
      check("Sesión restaurada: el modal pide el PIN", await p.locator("#qz-setpw-modal-pin").isVisible());
      const pw = secret();
      await p.fill("#qz-setpw-modal-pin", otherPin(q.anaPin)); await p.fill("#qz-setpw-modal-pw", pw); await p.fill("#qz-setpw-modal-pw2", pw);
      await p.click("#qz-setpw-modal-save"); await p.waitForTimeout(1500);
      const e = await setpwErr(p);
      await shot(p, "11-pin-incorrecto");
      let v = await stored(q);
      check("PIN incorrecto: lo dice y borra sólo el PIN; nada publicado y la jornada intacta",
        e === "Ese PIN no es correcto." && (await p.inputValue("#qz-setpw-modal-pin")) === "" && (await p.inputValue("#qz-setpw-modal-pw")) === pw && v.ownerPasswordSet === false && prepIntact(v), e);
      await p.click("#qz-setpw-modal-cancel"); await p.waitForTimeout(400);
      v = await stored(q);
      check("«Ahora no» tras el error: nada publicado y la jornada intacta", (await overlays(p)) === 0 && v.ownerPasswordSet === false && prepIntact(v));
      await p.click("#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await p.reload(); await p.waitForSelector("#qz-session-yes", { timeout: 60000 });
      v = await stored(q);
      check("Recargar con el modal abierto: no publica y la jornada sigue intacta", v.ownerPasswordSet === false && prepIntact(v));
      await p.click("#qz-session-yes"); await p.waitForSelector("#qz-setup-cta", { timeout: 30000 });
      await shot(p, "12-tras-recargar-sigue-la-jornada", true);
      await p.click("#qz-setup-cta"); await p.waitForSelector("#qz-setpw-modal");
      await p.fill("#qz-setpw-modal-pin", q.anaPin); await p.fill("#qz-setpw-modal-pw", pw); await p.fill("#qz-setpw-modal-pw2", pw);
      await p.click("#qz-setpw-modal-save"); await p.waitForSelector("#qz-setpw-modal", { state: "detached", timeout: 15000 });
      v = await stored(q);
      check("PIN correcto: guarda la contraseña sin publicar", v.ownerPasswordSet === true && prepIntact(v));
      await p.click("#qz-setup-cta");
      await p.waitForSelector("text=Invita a tus amigos", { timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(800);
      v = await stored(q);
      const r = v.rounds.find((x) => x.id === "r_prep");
      await shot(p, "13-importada-publicada", true);
      check("Publicar explícitamente: la jornada importada se publica con sus partidos y su cierre", !!r && r.published === true && r.matches.length === 2 && sameTime(r.deadline, q.prepDeadline));
    } finally { await ctx.close(); }
  });

  // ======== J3. Informativo: recargar el setup manual antes de publicar ========
  await journey("J3 recarga del setup manual", async () => {
    const q = await seed("rec");
    const { ctx, p } = await newCtx(q.anaCookies);
    try {
      await p.goto(B + "/q/" + q.slug); await p.waitForSelector("#qz-session-yes", { timeout: 60000 });
      await p.click("#qz-session-yes"); await p.waitForSelector("#qz-setup-cta", { timeout: 30000 });
      const rows = p.locator("#qz-setup-match-rows .match-edit-row");
      await rows.nth(0).locator("[data-role=teamA]").fill("León"); await rows.nth(0).locator("[data-role=teamB]").fill("Santos");
      const dl = futureLocal(2); await p.fill("#qz-setup-deadline", dl);
      await p.reload(); await p.waitForSelector("#qz-session-yes", { timeout: 60000 });
      await p.click("#qz-session-yes"); await p.waitForSelector("#qz-setup-cta", { timeout: 30000 });
      const a = await rows.nth(0).locator("[data-role=teamA]").inputValue();
      const d = await p.inputValue("#qz-setup-deadline");
      await shot(p, "14-setup-manual-tras-recargar", true);
      info("Recargar el setup manual antes de publicar (no es cancelar ni equivocarse)",
        a === "León" && d === dl ? "se conservan partidos y cierre" : `lo escrito se pierde (equipo 1 = «${a}», cierre ${d === dl ? "igual" : "distinto"}); comportamiento previo a #30/#31`);
    } finally { await ctx.close(); }
  });

  // ======== J4. Co-admin: no se adelanta a la creadora ========
  await journey("J4 co-admin", async () => {
    const q = await seed("coa", { team: true });
    const { ctx, p } = await newCtx();
    try {
      await p.goto(B + "/q/" + q.slug); await p.waitForSelector(".name-btn", { timeout: 60000 });
      await p.click(".name-btn:has-text('Carla')"); await p.waitForSelector("#qz-prompt-input");
      await p.fill("#qz-prompt-input", q.carlaPin); await p.click("#qz-modal-confirm-btn");
      await p.waitForSelector("#qz-setup-cta", { timeout: 30000 });
      const teams = [["Necaxa", "Atlas"]];
      const rows = p.locator("#qz-setup-match-rows .match-edit-row");
      await rows.nth(0).locator("[data-role=teamA]").fill("Necaxa"); await rows.nth(0).locator("[data-role=teamB]").fill("Atlas");
      const dl = futureLocal(2); await p.fill("#qz-setup-deadline", dl);
      await p.click("#qz-setup-cta"); await p.waitForSelector(".qz-modal-card", { timeout: 15000 }); await p.waitForTimeout(400);
      const msg = await text(p, ".qz-modal-card");
      const btns = await p.$$eval(".qz-modal-overlay .qz-modal-actions button", (bs) => bs.map((b) => b.textContent.trim()));
      await shot(p, "15-coadmin-aviso");
      check("Co-admin: no puede publicar antes que la creadora; aviso con un solo botón «Entendido»", JSON.stringify(btns) === '["Entendido"]' && msg.includes(COADMIN_MSG), JSON.stringify(btns));
      check("Co-admin: el aviso no ofrece configurar la contraseña", (await p.locator(".qz-modal-overlay input").count()) === 0);
      await p.click(".qz-modal-overlay .qz-modal-actions button"); await p.waitForTimeout(500);
      let v = await stored(q);
      await shot(p, "16-coadmin-conserva", true);
      check("Co-admin: nada publicado, sigue sin contraseña y conserva partidos y cierre",
        (await overlays(p)) === 0 && v.rounds.length === 0 && v.ownerPasswordSet === false && await formIntact(p, "#qz-setup-match-rows", "#qz-setup-deadline", teams, dl));
      // Ajustes del co-admin, en otra pestaña.
      const p2 = await ctx.newPage(); watch(p2);
      await p2.goto(B + "/a/" + q.slug); await p2.waitForSelector('#qz-session-yes, [data-sub="dueno"]', { timeout: 60000 });
      if (await p2.locator("#qz-session-yes").count()) await p2.click("#qz-session-yes");
      await p2.waitForSelector('[data-sub="dueno"]', { timeout: 30000 });
      await p2.click('[data-sub="dueno"]'); await p2.waitForTimeout(2000);
      const aj = await text(p2, "#qz-admin-body");
      await shot(p2, "17-coadmin-ajustes", true);
      check("Co-admin en Ajustes: le dice que Ana configurará la contraseña, sin campos para crearla",
        aj.includes(COADMIN_SETTINGS) && (await p2.locator("#qz-admin-body input[type=password]").count()) === 0, aj.slice(0, 140));
      await p2.close();
      // La creadora configura la contraseña en otro dispositivo; la pestaña del co-admin está atrasada.
      const s = await api("POST", "/api/set-admin-password", { metaKey: q.mkey, password: secret() }, q.anaAuth);
      if (s.status !== 200) throw new Error("set-admin-password " + s.status);
      await p.click("#qz-setup-cta"); await p.waitForTimeout(3000);
      v = await stored(q);
      await shot(p, "18-coadmin-publica-tras-la-creadora", true);
      const r = v.rounds[0] || {};
      check("Co-admin: cuando la creadora ya configuró la contraseña, publica sin aviso y con lo que había escrito",
        (await overlays(p)) === 0 && v.rounds.length === 1 && r.published === true && r.matches[0].teamA === "Necaxa" && sameTime(r.deadline, dl));
    } finally { await ctx.close(); }
  });

  await br.close();
  log(fails ? `RESULT: ${fails} FAIL / ${passes} PASS / ${infos} INFO` : `RESULT: ALL PASS (${passes}) / ${infos} INFO`);
  fs.writeFileSync(`${OUT}/resultado-${VP}.txt`, lines.join("\n") + "\n");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); fs.writeFileSync(`${OUT}/resultado-${VP}.txt`, lines.join("\n") + "\nERROR " + e.message + "\n"); process.exit(1); });
