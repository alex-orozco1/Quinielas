// onboardingCreate.test.js — MS1 «Crear con claridad»: /crear explains what
// QRACKS does and asks only for what a live feature uses; the admin password
// and the personal PIN are told apart; activating a PIN leaves a confirmation
// the person can actually see. Checked against the real source.
// The server side (create without contact) runs against a real server in
// createQuiniela.integration.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate ${signature}`);
  let depth = 0, i = source.indexOf("{", start);
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}
const crear = extractFunction(indexSrc, "async function renderCrear()");
const setupPin = extractFunction(indexSrc, "async function renderAdminSetupPin()");

test("CA-1: /crear says what QRACKS does and what the organizer does, before the form (no prices, limits or automation promises)", () => {
  const value = crear.indexOf("Comparte un link y tus amigos eligen sus resultados antes del cierre de cada jornada. QRACKS cuenta los puntos y arma la tabla.");
  const role = crear.indexOf("Tú armas las jornadas y publicas los resultados. Después de crearla: tu PIN y tu primera jornada.");
  const firstField = crear.indexOf('id="qz-c-name"');
  assert.ok(value !== -1 && role !== -1 && value < firstField && role < firstField, "both lines sit between the title and the first field");
  const copy = crear.slice(crear.indexOf("Crea tu quiniela"), firstField);
  assert.ok(!/\$|MXN|gratis|Plus|automátic|participantes|jornadas máximo/i.test(copy), "no price, plan, limit or automation promise in the intro");
});

test("CA-2: /crear no longer asks for WhatsApp or email; the fields are name, your name, league (optional), link and admin password", () => {
  assert.ok(!/qz-c-contact|WhatsApp o correo|draft\.contact|contact:/.test(crear), "no contact field, draft key or payload");
  const ids = [...crear.matchAll(/<(?:input|select)[^>]*id="(qz-c-[a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["qz-c-name", "qz-c-creator", "qz-c-league", "qz-c-slug", "qz-c-pass"]);
  const api = extractFunction(indexSrc, "async function apiCreateQuiniela(");
  assert.ok(!/contact/.test(api), "the create call does not send a contact");
  // The QRACKS contact for Plus (platform settings) is a different thing and stays.
  assert.ok(indexSrc.includes('upgradeContact: document.getElementById("qz-c-contact").value.trim()'));
});

test("CA-3 (server): the organizer contact is optional; group, creator and password are still required", () => {
  const start = serverSrc.indexOf('app.post("/api/create-quiniela"');
  const route = serverSrc.slice(start, serverSrc.indexOf("\napp.", start + 10));
  assert.ok(route.includes("if (!cleanGroupName || !cleanCreatorName || !cleanPassword) {"));
  assert.ok(!/!cleanContact/.test(route), "a missing contact is not a 400");
  assert.ok(route.includes("contact: cleanContact,"), "an older client that still sends it keeps it stored");
});

test("CA-4: one name for the admin password, told apart from the personal PIN", () => {
  const visible = indexSrc.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/contraseña de dueño/i.test(visible), "Ajustes no longer calls it «contraseña de dueño»");
  assert.ok(crear.includes("Es distinta de tu PIN. La usarás poco: para los ajustes protegidos de tu quiniela y para recuperar tu PIN si lo olvidas. Anótala en un lugar seguro."));
  assert.ok(setupPin.includes("Crea tu PIN personal"));
  // The PIN help, exactly as the Founder set it.
  assert.ok(setupPin.includes('<p class="login-sub">4 números para entrar como ${esc(creator.name)} desde cualquier teléfono</p>'));
  const modal = extractFunction(indexSrc, "async function setFirstAdminPin(participantId, newPin)");
  assert.ok(modal.includes("Escribe la contraseña de administrador de esta quiniela (no es un PIN)."));
});

test("CA-5: path A (after /crear) — the PIN step confirms the quiniela, and the saved PIN is confirmed ON the next screen", () => {
  assert.ok(setupPin.includes('setupEyebrowHtml("Tu quiniela ya está creada ✅")'));
  assert.ok(!indexSrc.includes("Configura tu quiniela en 3 minutos"));
  assert.ok(setupPin.includes(">Guardar PIN</button>") && setupPin.includes('continueBtn.textContent = "Guardar PIN";'));
  const resolve = setupPin.indexOf("await renderAdminSetupResolve();");
  const notice = setupPin.indexOf("showPinSavedNotice(creator.name);");
  assert.ok(resolve !== -1 && notice > resolve, "the notice is added after the next screen is on");
  const fn = extractFunction(indexSrc, "function showPinSavedNotice(name)");
  assert.ok(fn.includes('el.setAttribute("role", "status");'), "announced to screen readers");
  assert.ok(fn.includes("root.prepend(el);"), "lives on the next screen, replaced by the following one");
  assert.ok(fn.includes("Entras como ${esc(name)} con esos 4 números. Si lo olvidas, lo recuperas con tu contraseña de administrador."));
  // The app branch of the resolver is awaited, so the notice never lands before it.
  const resolver = extractFunction(indexSrc, "async function renderAdminSetupResolve()");
  assert.ok(resolver.includes('activeTab = "jornada";\n      await render();'));
  // Nothing stores it: a reload does not bring it back.
  assert.ok(!/localStorage|sessionStorage/.test(fn));
});

test("CA-6 / UX-PIN-001: path B (first PIN from the names, admin or participant) — the confirmation is shown after the render, 5 s", () => {
  const login = indexSrc.slice(indexSrc.indexOf("function renderLogin()"), indexSrc.indexOf("function tabList()"));
  assert.ok(!login.includes('toast("PIN configurado ✅'), "the toast the render wiped is gone");
  assert.ok(login.includes('afterEntry = "✅ PIN guardado. Entras como " + p.name + " con esos 4 números.";'));
  assert.ok(login.indexOf('afterEntry = "✅ PIN guardado.') < login.indexOf("await render();\n        if(afterEntry) toast(afterEntry, 5000);"));
  const toastFn = extractFunction(indexSrc, "function toast(msg, ms)");
  assert.ok(toastFn.includes("ms || 2200") && toastFn.includes('t.setAttribute("role", "status");'));
});

test("CA-7: errors name the field and move focus there; a wrong admin password keeps the chosen PIN", () => {
  assert.ok(crear.includes('statusEl.textContent = "Falta: " + joinEs(missing.map(f => f.label)) + ".";'));
  assert.ok(crear.includes("document.getElementById(missing[0].id).focus();"));
  assert.ok(crear.includes('setAttribute("aria-invalid", "true")'));
  assert.ok(crear.includes('slugError.textContent = "Ese link ya está en uso. Cambia el link.";') && crear.includes("slugInput.focus();"));
  assert.equal(extractFunction(indexSrc, "function joinEs(items)").length > 0, true);
  const modal = extractFunction(indexSrc, "async function setFirstAdminPin(participantId, newPin)");
  assert.ok(modal.includes("while(true){"), "asks again in the same window");
  assert.ok(modal.includes('if(attempt.result.ok || attempt.result.error !== "admin_claim_required") return attempt.result;'));
  assert.ok(modal.includes("Esa no es la contraseña de administrador. Inténtalo otra vez"));
  assert.ok(modal.includes('"owner", (password) => apiSetPinResult(participantId, null, newPin, password)'), "same PIN, same limiter target");
});

test("CA-8: Enter creates; double submits are ignored; «Mostrar» toggles the password", () => {
  assert.ok(crear.includes('if(e.key !== "Enter" || e.target.tagName !== "INPUT") return;'));
  assert.ok(crear.includes('document.getElementById("qz-c-submit").click();'));
  assert.ok(crear.includes("if(creating) return;") && crear.includes("submitBtn.disabled = true;"));
  assert.ok(crear.includes('id="qz-c-pass-toggle" aria-pressed="false"'));
  assert.ok(crear.includes('passInput.type = show ? "text" : "password";'));
});

test("CA-9: the /crear draft survives a reload of the tab, never with the admin password", () => {
  const save = extractFunction(indexSrc, "function saveCrearDraft(draft)");
  assert.ok(save.includes("window.sessionStorage.setItem(CREAR_DRAFT_KEY"));
  assert.ok(!/password/.test(save), "the password is never written");
  const load = extractFunction(indexSrc, "function loadCrearDraft()");
  assert.ok(load.includes('password: ""'));
  assert.ok(crear.includes("const draft = renderCrear._draft || loadCrearDraft();"));
  assert.ok(crear.indexOf("clearCrearDraft();") < crear.indexOf('window.location.href = "/q/"'), "cleared once the quiniela exists");
});
