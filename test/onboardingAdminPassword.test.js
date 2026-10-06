// onboardingAdminPassword.test.js — onboarding B in the screens: /crear without
// the admin password, the "Guarda tu PIN" warning, «Configura tu contraseña de
// administrador» at the four places a round is published, Ajustes, «¿Olvidaste
// tu PIN?» without a password, «Mostrar / Ocultar», the PIN kept in memory,
// a password set in another tab, one-button notices and the focus trap.
// Checked against the real source. What the server enforces runs against a real server in
// adminPasswordOnPublish.integration.test.js; the browser journey (375 and
// 1280 px) is outside the suite, in the delivery evidence.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunction(source, signature, from = 0) {
  const start = source.indexOf(signature, from);
  assert.ok(start !== -1, `could not locate ${signature}`);
  let depth = 0, i = source.indexOf("{", start);
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}
const fn = (sig) => extractFunction(indexSrc, sig);
// The Founder's exact text: no reference to the password.
const WARNING = "<strong>Guarda tu PIN en un lugar seguro.</strong> Si lo olvidas y cierras tu sesión, no podrás volver a entrar por tu cuenta.";

test("CB-1: /crear neither asks for nor sends an admin password", () => {
  const crear = fn("async function renderCrear()").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/qz-c-pass|draft\.password|password|contraseña/i.test(crear));
  assert.ok(!/password/.test(fn("async function apiCreateQuiniela(")));
});

test("CB-2: the exact warning, without mentioning the password, on the PIN step and in the «PIN guardado» strip, only while there is none", () => {
  assert.ok(indexSrc.includes(`const SAVE_YOUR_PIN_WARNING_HTML = "${WARNING}";`));
  assert.ok(!/contraseña/i.test(WARNING));
  const pinStep = fn("async function renderAdminSetupPin()");
  assert.ok(pinStep.includes('${meta.ownerPasswordSet === false ? `<p class="qz-pin-warning" id="qz-setup-pin-warning">${SAVE_YOUR_PIN_WARNING_HTML}</p>` : ``}'));
  assert.ok(pinStep.indexOf("qz-setup-pin-warning") < pinStep.indexOf('id="qz-setup-pin-continue"'), "above «Guardar PIN»");
  assert.ok(pinStep.includes("const creator = creatorOfMeta() ||"), "the creator, by id");
  const strip = fn("function showPinSavedNotice(name)");
  assert.ok(strip.includes("meta && meta.ownerPasswordSet === false"));
  assert.ok(strip.includes('<p class="qz-pin-saved-warning">${SAVE_YOUR_PIN_WARNING_HTML}</p>'));
  assert.ok(!/soporte|equipo de QRACKS/.test(strip));
  // Retired the moment a password exists: saved here, already set, or found set by another tab.
  assert.ok(fn("function retireSavePinWarnings()").includes('document.querySelectorAll(".qz-pin-warning, .qz-pin-saved-warning").forEach(el => el.remove());'));
  const w = fn("function wireAdminPasswordSetup(container, prefix, handlers, opts)");
  assert.equal((w.match(/retireSavePinWarnings\(\);/g) || []).length, 2, "on save and on already_set");
  assert.ok(fn("async function refreshOwnerPasswordSet()").includes("if(meta && meta.ownerPasswordSet) retireSavePinWarnings();"));
});

test("CB-4: the four publish points stop before anything changes, and a server 409 brings the same question back", () => {
  const review = fn("function renderAdminSetupReview(round)");
  assert.ok(review.indexOf('if(!(await gateFirstPublish(cta, "before"))) return;') < review.indexOf("reconcilePenaltyLedger(meta);"));
  assert.ok(review.indexOf("gateFirstPublish(cta") < review.indexOf("liveRound.published = true;"));
  assert.ok(review.indexOf("isSetupDeadlineValid(deadlineVal") < review.indexOf("gateFirstPublish(cta"), "after the form's own checks");
  assert.ok(/result\.error === "admin_password_required"\)\{[\s\S]{0,200}meta\.ownerPasswordSet = false;[\s\S]{0,80}await gateFirstPublish\(cta, "before"\);/.test(review));

  const manual = fn("function renderAdminSetupManual(opts)");
  assert.ok(manual.indexOf('if(!(await gateFirstPublish(cta, "before"))) return;') < manual.indexOf("meta.rounds.push(round);"));
  assert.ok(/result\.error === "admin_password_required"\)\{[\s\S]{0,200}await gateFirstPublish\(cta, "before"\);/.test(manual));

  const rondas = fn("async function renderAdminRondas(body)");
  const imported = rondas.slice(rondas.indexOf('body.querySelectorAll("[data-publish-round]")'));
  assert.ok(imported.indexOf('if(!(await gateFirstPublish(rowEl, "after"))) return;') < imported.indexOf("round.published = true;"));
  assert.ok(/result\.error === "admin_password_required"\)\{[\s\S]{0,120}await gateFirstPublish\(rowEl, "after"\);/.test(imported));
  const create = rondas.slice(rondas.indexOf('document.getElementById("qz-publish-round").addEventListener("click"'));
  const editAt = create.indexOf("if(editingRound){");
  const gateAt = create.indexOf('if(!(await gateFirstPublish(publishRow, "before"))) return;');
  assert.ok(editAt !== -1 && gateAt > editAt, "only a NEW round asks: editing never publishes");
  assert.ok(gateAt < create.indexOf("meta.rounds.push(round);"));
  assert.ok(/result\.error === "admin_password_required"\)\{[\s\S]{0,120}await gateFirstPublish\(publishRow, "before"\);/.test(create));
});

test("CB-4: the gate never publishes — saving the password only says to tap «Publicar jornada» again; a co-admin is told who, with one button", () => {
  const gate = fn("async function gateFirstPublish(anchor, where)");
  assert.ok(gate.includes("if(!needsAdminPasswordToPublish()) return true;"));
  assert.equal((gate.match(/return true;/g) || []).length, 2, "the only ways through: no password needed, or the server says it already exists");
  assert.ok(gate.includes("if(await refreshOwnerPasswordSet()) return true;"), "a password set in another tab or device neither asks nor blocks");
  assert.ok(gate.indexOf("refreshOwnerPasswordSet()") < gate.indexOf("openAdminPasswordSetup()"), "asked to the server before showing the form");
  assert.ok(gate.indexOf("refreshOwnerPasswordSet()") < gate.indexOf("qzAlert("), "and before telling a co-admin it is missing");
  assert.ok(gate.includes("if(await openAdminPasswordSetup()) showPublishPasswordSaved(anchor, where);"));
  assert.ok(gate.includes("(quien creó la quiniela) tiene que configurar la contraseña de administrador."));
  assert.ok(gate.includes('{ title: "Falta la contraseña de administrador" });') && !gate.includes("qzConfirm("), "the co-admin notice is a one-button alert");
  assert.ok(!/setMeta|published|render\(/.test(gate), "it changes nothing and repaints nothing");
  const saved = fn("function showPublishPasswordSaved(anchor, where)");
  assert.ok(saved.includes('"✅ Contraseña guardada. Revisa la jornada y toca «Publicar jornada» para publicarla."'));
  assert.ok(saved.includes('el.setAttribute("role", "status");'));
  assert.equal(fn("function needsAdminPasswordToPublish()").includes("meta.creatorId && !meta.ownerPasswordSet"), true, "quinielas without a creator are never stopped");
});

test("CB-6/CB-10: «Configura tu contraseña de administrador» says only what exists, and the PIN goes bound to the creator", () => {
  const html = fn("function adminPasswordSetupHtml(prefix, opts)");
  assert.ok(!indexSrc.includes("Dale tus reglas a la quiniela"), "the title describes setting the password");
  for (const s of [
    "Configura tu contraseña de administrador", "Aquí puedes:",
    "Cambiar el nombre de tu quiniela.", "Definir cuántos puntos vale cada acierto.",
    "Establecer la cuota que acuerden pagar los participantes.",
    // Participants pay the admin directly; the admin records the payments by hand.
    "Los participantes te pagan directamente a ti, y tú registras manualmente los pagos en QRACKS.",
    "Tú controlas estos cambios",
    "Crea una contraseña de administrador para autorizar modificaciones a estas reglas. También te servirá para recuperar tu acceso si olvidas el PIN. Para entrar normalmente seguirás usando tu PIN.",
    ">Tu PIN<", ">Contraseña<", ">Confirmar contraseña<", "Mínimo 8 caracteres.", "Guardar contraseña", "Ahora no",
  ]) assert.ok(html.includes(s), s);
  assert.ok(!/plus|premium|desbloque/i.test(html), "not a paid feature, nothing it unlocks");
  const api = fn("async function apiSetAdminPassword(pin, password)");
  assert.ok(api.includes('setAuthHeaders({ "Content-Type": "application/json" }, pin, meta.creatorId)'));
  assert.ok(api.includes("body: JSON.stringify({ metaKey: currentMetaKey(), password })"), "the password in the body, once; never the PIN");
});

test("CB-13: the form checks before sending, keeps what was typed, and reads every server answer", () => {
  const w = fn("function wireAdminPasswordSetup(container, prefix, handlers, opts)");
  for (const s of [
    '"Escribe tu PIN de 4 números."', '"Usa al menos 8 caracteres."', '"Las contraseñas no coinciden."',
    '"Ese PIN no es correcto."', '"Sólo quien creó la quiniela puede configurar la contraseña."',
    '"No pudimos guardar la contraseña. Revisa tu conexión e intenta de nuevo."',
  ]) assert.ok(w.includes(s), s);
  assert.ok(w.indexOf("if(pw !== pw2)") < w.indexOf("await apiSetAdminPassword(pin, pw)"));
  assert.ok(/if\(result\.error === "wrong_pin"\)\{[\s\S]{0,600}pinInput\.value = "";[\s\S]{0,40}return fail\(pinInput,/.test(w), "only a wrong PIN is cleared");
  assert.ok(w.includes('result.error === "too_many_attempts" && startCredentialWait(waitKey, result)'));
  assert.ok(w.includes('const waitKey = "pin:" + meta.creatorId;'), "the same wait as the creator's PIN anywhere else");
  assert.ok(w.includes("if(saving || saveBtn.disabled) return;"), "one request per tap or Enter");
  assert.ok(/if\(e\.key !== "Enter" \|\| e\.target\.tagName !== "INPUT"[^\n]*\) return;\s*e\.preventDefault\(\);\s*submit\(\);/.test(w));
  assert.ok(w.includes("meta.ownerPasswordSet = true;") && w.includes("ownerPasswordCache = pw;"));
  const modal = fn("function openAdminPasswordSetup()");
  assert.ok(modal.includes('overlay.className = "qz-modal-overlay qz-modal-scroll";'));
  const guardAt = modal.indexOf('if(document.getElementById("qz-setpw-modal")) return Promise.resolve(false);');
  assert.ok(guardAt !== -1 && guardAt < modal.indexOf("new Promise(") && guardAt < modal.indexOf("document.createElement("), "never two at once: checked before anything is built");
  assert.ok(modal.includes('if(e.key === "Escape" && !control.isSaving()){ e.preventDefault(); close(false); }'));
  assert.ok(!/addEventListener\("click"[^\n]*e\.target === overlay/.test(modal), "a stray tap on the backdrop does not close it");
  assert.ok(modal.includes('overlay.querySelector(".qz-modal-card").focus();'));
  assert.ok(/\.qz-modal-overlay\.qz-modal-scroll\{ overflow-y:auto; align-items:flex-start; \}/.test(indexSrc));
});

test("CB-11: «Mostrar / Ocultar» on every password field that lacked it — never on a PIN, always starting hidden", () => {
  const toggle = fn("function wirePasswordToggles(container)");
  assert.ok(toggle.includes('input.type = show ? "text" : "password";') && toggle.includes('btn.setAttribute("aria-pressed", show ? "true" : "false");'));
  assert.ok(fn("function passwordFieldHtml(id, extraAttrs)").includes('type="password"'));
  const prompt = fn("function qzPrompt(message, opts)");
  assert.ok(prompt.includes('${isSecret && !isPin ? `<button type="button" class="qz-pass-toggle" data-pass-toggle="qz-prompt-input"'));
  assert.ok(prompt.includes("wirePasswordToggles(overlay);"));
  const owner = fn("function renderAdminOwner(body)");
  assert.ok(owner.includes('passwordFieldHtml("qz-owner-pw",'), "unlocking Ajustes");
  assert.ok(owner.includes('passwordFieldHtml("qz-owner-pw-set",') && owner.includes('passwordFieldHtml("qz-owner-pw-set2",'), "changing it, with a confirmation");
  assert.ok(!owner.includes('type="text" id="qz-owner-pw-set"'), "the new password is no longer a visible text field");
});

test("CB-7/CB-8: Ajustes — the creator sets the password there, a co-admin is told who will, and no PIN opens them", () => {
  const owner = fn("function renderAdminOwner(body)");
  const b = owner.indexOf("if(!ownerUnlocked && needsAdminPasswordToPublish()){");
  assert.ok(b !== -1 && b < owner.indexOf("if(!ownerUnlocked){"));
  assert.ok(owner.includes('adminPasswordSetupHtml("qz-setpw-settings", { inModal: false, askPin: !knownPin })'));
  // A password set in another tab: asked to the server before offering to create one.
  const refreshAt = owner.indexOf("await refreshOwnerPasswordSet();");
  assert.ok(refreshAt !== -1 && refreshAt < owner.indexOf('adminPasswordSetupHtml("qz-setpw-settings"') && refreshAt < owner.indexOf("configurará la contraseña de administrador."));
  assert.ok(owner.includes("if(!body.isConnected) return;"), "nothing painted on a screen the user already left");
  const loadingAt = owner.indexOf('body.innerHTML = `<div class="card"><p class="muted" role="status">Cargando…</p></div>`;');
  assert.ok(loadingAt !== -1 && loadingAt < refreshAt, "a slow answer shows «Cargando…», not an empty screen");
  assert.ok(owner.includes('wireAdminPasswordSetup(document.getElementById("qz-setpw-settings-card"), "qz-setpw-settings",'), "wired on its own card, not on the long-lived body");
  assert.ok(owner.includes("configurará la contraseña de administrador."));
  assert.ok(owner.includes("${currentUser.isAdmin && meta.ownerPasswordSet === false && !meta.creatorId ? `"), "the PIN shortcut only where the server still accepts it");
  // Saving: the confirmation is checked before meta changes, and kept rules are said.
  const save = owner.slice(owner.indexOf('document.getElementById("qz-save-settings").addEventListener("click"'));
  assert.ok(save.indexOf("pwProblem") < save.indexOf("meta.groupName = "));
  assert.ok(save.includes("if(saved.ruleFieldsKept){"));
});

test("CB-9: «¿Olvidaste tu PIN?» without a password says so, offers what really works, and promises no support", () => {
  const explain = fn("async function explainNoAdminPasswordRecovery(p)");
  assert.ok(explain.includes("Esta quiniela todavía no tiene contraseña de administrador, así que no es posible recuperar tu PIN desde aquí."));
  assert.ok(explain.includes("Si tienes una sesión abierta en otro dispositivo, entra desde ahí."));
  assert.ok(!/soporte|equipo de QRACKS|ayuda/i.test(explain));
  assert.ok(explain.includes('await qzAlert(lines.join("\\n\\n"), { title: "¿Olvidaste tu PIN?" });'), "a notice: one button");
  const recover = fn("async function recoverAdminPin(p)");
  assert.ok(recover.indexOf("meta.ownerPasswordSet === false && !(await refreshOwnerPasswordSet())){ await explainNoAdminPasswordRecovery(p); return null; }") < recover.indexOf("promptCredential("), "asked to the server before saying there is none");
  assert.ok(!recover.includes("Pide ayuda al equipo de QRACKS"));
  assert.ok(!indexSrc.includes("la que se eligió al crearla"), "the password is no longer chosen at creation");
  const first = fn("async function setFirstAdminPin(participantId, newPin)");
  assert.ok(first.includes("const noPassword = !!(meta && meta.ownerPasswordSet === false) && !(await refreshOwnerPasswordSet());"));
  assert.ok(first.includes('if(noPassword && meta.creatorId === participantId){'), "no dead-end prompt for the creator's seat");
  assert.ok(first.includes("Pide a otro admin que escriba aquí su PIN."));
});

test("CB-12: a quiniela without creatorId keeps the old screens", () => {
  assert.ok(fn("function needsAdminPasswordToPublish()").includes("meta.creatorId"));
  assert.ok(fn("function renderAdminOwner(body)").includes("if(!ownerUnlocked && needsAdminPasswordToPublish()){"));
  // Publishing, Ajustes by password and naming admins follow the server: no creator, no new rule.
  assert.ok(!/creatorId/.test(fn("function resolveSetupDestination(m, user)")));
});

// ---- Second round (Founder's review of the screens) -------------------------

test("PIN in memory: the setup does not ask for it again in the same visit; the server still checks it", () => {
  const known = fn("function creatorPinInMemory()");
  assert.ok(known.includes('return isCreator(currentUser) && /^\\d{4}$/.test(currentUserPinCache || "") ? currentUserPinCache : null;'), "only the creator's own PIN, typed in this visit");
  const html = fn("function adminPasswordSetupHtml(prefix, opts)");
  assert.ok(html.includes('const askPin = !(opts && opts.askPin === false);'));
  assert.ok(html.includes('<div class="qz-setpw-field" id="${prefix}-pin-field"${askPin ? "" : " hidden"}>'));
  const modal = fn("function openAdminPasswordSetup()");
  assert.ok(modal.includes("const knownPin = creatorPinInMemory();") && modal.includes("askPin: !knownPin") && modal.includes("}, { knownPin });"));
  const w = fn("function wireAdminPasswordSetup(container, prefix, handlers, opts)");
  assert.ok(w.includes("const usingKnownPin = !!(pinField.hidden && knownPin);"));
  assert.ok(w.includes("const pin = usingKnownPin ? knownPin : pinInput.value.trim();"));
  assert.ok(w.indexOf("const pin = usingKnownPin") < w.indexOf("await apiSetAdminPassword(pin, pw)"), "the same request carries the PIN: the server validates it as before");
  // A PIN in memory the server no longer accepts (changed elsewhere): ask once.
  assert.ok(/if\(result\.error === "wrong_pin"\)\{\s*[\s\S]{0,600}knownPin = null;\s*pinField\.hidden = false;/.test(w));
  assert.ok(w.includes('"Escribe tu PIN para continuar."'));
  // Rejected once, forgotten: reopening the form does not send it again.
  assert.ok(/if\(result\.error === "wrong_pin"\)\{[\s\S]{0,600}if\(usingKnownPin && currentUserPinCache === knownPin\) currentUserPinCache = null;/.test(w));
  // A reload forgets it (memory only): nothing new is stored.
  assert.ok(!/localStorage|sessionStorage/.test(known + w + modal));
});

test("A password set in another tab or device: no form and no block, for the creator and for a co-admin", () => {
  const refresh = fn("async function refreshOwnerPasswordSet()");
  assert.ok(refresh.includes("const fresh = await getMeta({});"), "the public view says whether it exists, never more");
  assert.ok(refresh.includes('if(fresh && typeof fresh.ownerPasswordSet === "boolean") meta.ownerPasswordSet = fresh.ownerPasswordSet;'), "only the flag is adopted: the form on screen is untouched");
  const gate = fn("async function gateFirstPublish(anchor, where)");
  const refreshAt = gate.indexOf("if(await refreshOwnerPasswordSet()) return true;");
  assert.ok(refreshAt !== -1 && refreshAt < gate.indexOf("const creator = creatorOfMeta();"), "before choosing between the creator's form and the co-admin's notice");
});

test("One modal at a time and no focus escape: a second tap or a stray Enter cannot open another one", () => {
  const gate = fn("async function gateFirstPublish(anchor, where)");
  assert.ok(gate.includes('if(firstPublishGateBusy || document.querySelector(".qz-modal-overlay")) return false;'));
  assert.ok(/firstPublishGateBusy = true;\s*try\{[\s\S]*\} finally \{\s*firstPublishGateBusy = false;\s*\}/.test(gate), "released whatever happens");
  const trap = fn("function attachModalFocusTrap(overlay)");
  assert.ok(trap.includes("if(overlays.length && overlays[overlays.length - 1] !== overlay) return;"), "only the modal on top answers");
  assert.ok(/if\(!focusable\.includes\(document\.activeElement\)\)\{\s*e\.preventDefault\(\);\s*\(e\.shiftKey \? last : first\)\.focus\(\);/.test(trap), "focus on the card itself (tabindex=-1) enters the dialog instead of leaving it");
  assert.ok(trap.includes("if(!focusable.length){ e.preventDefault(); return; }"));
});

test("Notices with nothing to decide have one button: «Entendido»", () => {
  const alert = fn("function qzAlert(message, opts)");
  assert.ok(alert.includes('return qzConfirm(message, { ...opts, destructive: false, single: true, confirmLabel: opts.confirmLabel || "Entendido" });'));
  const confirm = fn("function qzConfirm(message, opts)");
  assert.ok(confirm.includes('${single ? `` : `<button class="qz-modal-cancel" id="qz-modal-cancel-btn">${esc(cancelLabel)}</button>`}'));
  assert.ok(confirm.includes("if(cancelBtn) cancelBtn.addEventListener"));
  assert.ok(!indexSrc.includes('confirmLabel: "Entendido", cancelLabel: "Cerrar"'), "no notice keeps two buttons that do the same");
});
