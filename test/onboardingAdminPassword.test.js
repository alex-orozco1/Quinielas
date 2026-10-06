// onboardingAdminPassword.test.js — onboarding B in the screens: /crear without
// the admin password, the "Guarda tu PIN" warning, «Dale tus reglas a la
// quiniela» at the four places a round is published, Ajustes, «¿Olvidaste tu
// PIN?» without a password and «Mostrar / Ocultar». Checked against the real
// source. What the server enforces runs against a real server in
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
const WARNING = "<strong>Guarda tu PIN.</strong> Hasta que configures tu contraseña de administrador, si lo olvidas y no tienes una sesión abierta, no podrás recuperar el acceso por tu cuenta.";

test("CB-1: /crear neither asks for nor sends an admin password", () => {
  const crear = fn("async function renderCrear()").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/qz-c-pass|draft\.password|password|contraseña/i.test(crear));
  assert.ok(!/password/.test(fn("async function apiCreateQuiniela(")));
});

test("CB-2: the exact warning, on the PIN step and in the «PIN guardado» strip, only while there is no admin password", () => {
  assert.ok(indexSrc.includes(`const SAVE_YOUR_PIN_WARNING_HTML = "${WARNING}";`));
  const pinStep = fn("async function renderAdminSetupPin()");
  assert.ok(pinStep.includes('${meta.ownerPasswordSet === false ? `<p class="qz-pin-warning" id="qz-setup-pin-warning">${SAVE_YOUR_PIN_WARNING_HTML}</p>` : ``}'));
  assert.ok(pinStep.indexOf("qz-setup-pin-warning") < pinStep.indexOf('id="qz-setup-pin-continue"'), "above «Guardar PIN»");
  assert.ok(pinStep.includes("const creator = creatorOfMeta() ||"), "the creator, by id");
  const strip = fn("function showPinSavedNotice(name)");
  assert.ok(strip.includes("meta && meta.ownerPasswordSet === false"));
  assert.ok(!/soporte|equipo de QRACKS/.test(strip));
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

test("CB-4: the gate never publishes — saving the password only says to tap «Publicar jornada» again; a co-admin is told who", () => {
  const gate = fn("async function gateFirstPublish(anchor, where)");
  assert.ok(gate.includes("if(!needsAdminPasswordToPublish()) return true;"));
  assert.equal((gate.match(/return true;/g) || []).length, 1, "the only way through is a password that already exists");
  assert.ok(gate.includes("if(await openAdminPasswordSetup()) showPublishPasswordSaved(anchor, where);"));
  assert.ok(gate.includes("(quien creó la quiniela) tiene que configurar la contraseña de administrador."));
  assert.ok(!/setMeta|published|render\(/.test(gate), "it changes nothing and repaints nothing");
  const saved = fn("function showPublishPasswordSaved(anchor, where)");
  assert.ok(saved.includes('"✅ Contraseña guardada. Revisa la jornada y toca «Publicar jornada» para publicarla."'));
  assert.ok(saved.includes('el.setAttribute("role", "status");'));
  assert.equal(fn("function needsAdminPasswordToPublish()").includes("meta.creatorId && !meta.ownerPasswordSet"), true, "quinielas without a creator are never stopped");
});

test("CB-6/CB-10: «Dale tus reglas a la quiniela» says only what exists, and the PIN goes bound to the creator", () => {
  const html = fn("function adminPasswordSetupHtml(prefix, opts)");
  for (const s of [
    "Dale tus reglas a la quiniela", "Aquí puedes:",
    "Cambiar el nombre de tu quiniela.", "Definir cuántos puntos vale cada acierto.",
    "Establecer la cuota que acuerden pagar los participantes.",
    "QRACKS registra la cuota y quién ya pagó, y muestra en la tabla cuánto se ha juntado. El cobro lo gestionas tú.",
    "Tú controlas estos cambios",
    "Crea una contraseña de administrador para autorizar modificaciones a estas reglas. También te servirá para recuperar tu acceso si olvidas el PIN. Para entrar normalmente seguirás usando tu PIN.",
    ">Tu PIN<", ">Contraseña<", ">Confirmar contraseña<", "Mínimo 8 caracteres.", "Guardar contraseña", "Ahora no",
  ]) assert.ok(html.includes(s), s);
  assert.ok(!/plus|premium|desbloque|pago/i.test(html.replace(/ya pagó/g, "")), "not a paid feature, nothing it unlocks");
  const api = fn("async function apiSetAdminPassword(pin, password)");
  assert.ok(api.includes('setAuthHeaders({ "Content-Type": "application/json" }, pin, meta.creatorId)'));
  assert.ok(api.includes("body: JSON.stringify({ metaKey: currentMetaKey(), password })"), "the password in the body, once; never the PIN");
});

test("CB-13: the form checks before sending, keeps what was typed, and reads every server answer", () => {
  const w = fn("function wireAdminPasswordSetup(container, prefix, handlers)");
  for (const s of [
    '"Escribe tu PIN de 4 números."', '"Usa al menos 8 caracteres."', '"Las contraseñas no coinciden."',
    '"Ese PIN no es correcto."', '"Sólo quien creó la quiniela puede configurar la contraseña."',
    '"No pudimos guardar la contraseña. Revisa tu conexión e intenta de nuevo."',
  ]) assert.ok(w.includes(s), s);
  assert.ok(w.indexOf("if(pw !== pw2)") < w.indexOf("await apiSetAdminPassword(pin, pw)"));
  assert.ok(w.includes('if(result.error === "wrong_pin"){ pinInput.value = ""; return fail(pinInput,'), "only a wrong PIN is cleared");
  assert.ok(w.includes('result.error === "too_many_attempts" && startCredentialWait(waitKey, result)'));
  assert.ok(w.includes('const waitKey = "pin:" + meta.creatorId;'), "the same wait as the creator's PIN anywhere else");
  assert.ok(w.includes("if(saving || saveBtn.disabled) return;"), "one request per tap or Enter");
  assert.ok(/if\(e\.key !== "Enter" \|\| e\.target\.tagName !== "INPUT"[^\n]*\) return;\s*e\.preventDefault\(\);\s*submit\(\);/.test(w));
  assert.ok(w.includes("meta.ownerPasswordSet = true;") && w.includes("ownerPasswordCache = pw;"));
  const modal = fn("function openAdminPasswordSetup()");
  assert.ok(modal.includes('overlay.className = "qz-modal-overlay qz-modal-scroll";'));
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
  assert.ok(owner.includes('adminPasswordSetupHtml("qz-setpw-settings", { inModal: false })'));
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
  const recover = fn("async function recoverAdminPin(p)");
  assert.ok(recover.indexOf("meta.ownerPasswordSet === false){ await explainNoAdminPasswordRecovery(p); return null; }") < recover.indexOf("promptCredential("));
  assert.ok(!recover.includes("Pide ayuda al equipo de QRACKS"));
  assert.ok(!indexSrc.includes("la que se eligió al crearla"), "the password is no longer chosen at creation");
  const first = fn("async function setFirstAdminPin(participantId, newPin)");
  assert.ok(first.includes('if(noPassword && meta.creatorId === participantId){'), "no dead-end prompt for the creator's seat");
  assert.ok(first.includes("Pide a otro admin que escriba aquí su PIN."));
});

test("CB-12: a quiniela without creatorId keeps the old screens", () => {
  assert.ok(fn("function needsAdminPasswordToPublish()").includes("meta.creatorId"));
  assert.ok(fn("function renderAdminOwner(body)").includes("if(!ownerUnlocked && needsAdminPasswordToPublish()){"));
  // Publishing, Ajustes by password and naming admins follow the server: no creator, no new rule.
  assert.ok(!/creatorId/.test(fn("function resolveSetupDestination(m, user)")));
});
