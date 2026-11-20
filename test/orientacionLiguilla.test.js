// Sprint «Orientación y menú del admin»: «Cancelar» y explicación en la
// tarjeta de liguilla, y el recordatorio de liguilla desde la jornada 15 (sólo
// Liga MX guardada como competencia).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
function fn(signature) {
  const start = html.indexOf(signature);
  assert.ok(start >= 0, "no encontré " + signature);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error("sin cierre: " + signature);
}
const LG = require("../liguillaScoring.js");

function reminder({ isAdmin = true, league, rounds, liguilla, lock, lgModule = LG } = {}) {
  const meta = { settings: { ...(league !== undefined ? { sportsdbLeagueId: league } : {}), ...(liguilla ? { liguilla } : {}) }, rounds: rounds || [], ...(lock ? { liguillaLock: lock } : {}) };
  const src = [
    html.match(/  const LIGA_MX_LEAGUE_ID = "4350";/)[0],
    html.match(/  const LG_REMINDER_FROM_ROUND = 15;/)[0],
    fn("function lgConfigRules()"),
    fn("function liguillaReminderDue()"),
    fn("function liguillaReminderHtml()"),
  ].join("\n");
  return new Function("LG", "meta", "currentUser", "isLg", `${src}\nreturn { due: liguillaReminderDue(), html: liguillaReminderHtml() };`)(
    lgModule, meta, { isAdmin }, (r) => !!(r && r.stage === "liguilla"));
}
const R = (number, extra) => ({ id: "r" + number, number, published: true, ...extra });

test("recordatorio: Liga MX guardada, jornada publicada 15 y sin reglas → aparece; 14 → no", () => {
  const at15 = reminder({ league: "4350", rounds: [R(14), R(15)] });
  assert.equal(at15.due, true);
  assert.match(at15.html, /La liguilla se acerca\. Configura cómo se ganarán los puntos antes de publicar su primera jornada\./);
  assert.match(at15.html, /data-lg-remind>Configurar liguilla</);
  assert.equal(reminder({ league: "4350", rounds: [R(13), R(14)] }).due, false, "J14");
  assert.equal(reminder({ league: 4350, rounds: [R(17)] }).due, true, "id guardado como número");
});

test("recordatorio: no para otra liga, liga desconocida ni el respaldo del editor manual", () => {
  assert.equal(reminder({ league: "4328", rounds: [R(20)] }).due, false, "otra liga");
  assert.equal(reminder({ rounds: [R(20)] }).due, false, "sin liga guardada (el editor usa 4350 de respaldo)");
  assert.equal(reminder({ league: null, rounds: [R(20)] }).due, false);
  assert.equal(reminder({ league: "", rounds: [R(20)] }).due, false);
});

test("recordatorio: no por borradores futuros importados ni por jornadas de liguilla", () => {
  assert.equal(reminder({ league: "4350", rounds: [R(14), R(15, { published: false }), R(16, { published: false })] }).due, false);
  assert.equal(reminder({ league: "4350", rounds: [R(14), R(15, { stage: "liguilla" })] }).due, false);
});

test("recordatorio: sólo para el admin; desaparece con reglas guardadas válidas o fijas", () => {
  assert.equal(reminder({ isAdmin: false, league: "4350", rounds: [R(15)] }).due, false, "participante");
  assert.equal(reminder({ league: "4350", rounds: [R(15)], liguilla: { resultPoints: 2, exactBonus: 0 } }).due, false, "guardadas");
  assert.equal(reminder({ league: "4350", rounds: [R(15)], liguilla: { resultPoints: 0 } }).due, true, "una regla inválida no cuenta como guardada");
  assert.equal(reminder({ league: "4350", rounds: [R(15)], lock: { rules: { resultPoints: 1, exactBonus: 0 } } }).due, false, "fijas");
  assert.equal(reminder({ league: "4350", rounds: [R(15)], lgModule: null }).due, false, "sin el módulo de liguilla");
});

test("recordatorio: una sola tarjeta por pantalla (Jornada y Admin → Jornadas) y el botón lleva a la tarjeta", () => {
  assert.equal((html.match(/\$\{liguillaReminderHtml\(\)\}/g) || []).length, 2);
  const jornada = html.slice(html.indexOf('${screenHeaderHtml("jornada", "Jornada", inviteBtnHtml, !!nextStep)}'), html.indexOf('<div id="qz-pending-banner">'));
  assert.equal((jornada.match(/liguillaReminderHtml/g) || []).length, 1);
  const wire = fn("function wireLiguillaReminder(container)");
  assert.ok(wire.includes('adminSubTab = "reglas";') && wire.includes("renderAdminReglas._scrollToLg = true;"));
  assert.ok(html.includes("if(renderAdminReglas._scrollToLg){ renderAdminReglas._scrollToLg = false; lgScrollToCard(); }"));
});

test("tarjeta de liguilla: explica que lo sugerido no es regla activa y que hay que guardar antes de publicar", () => {
  const card = fn("function reglasLiguillaCardHtml(st, unlocked, noPasswordYet)");
  const src = [fn("function lgConfigRules()"), card].join("\n");
  const render = (settings, unlocked = true, lock = null) => new Function(
    "LG", "meta", "esc", "pointsWord", "lgRulesSummary", "lgLockedRoundLabel", "fmtWhenTz", "lgExampleHtml", "lgRulesFromForm", "lgRulesStripHtml", "passwordFieldHtml", "renderAdminReglas",
    `${src}\nreturn reglasLiguillaCardHtml;`)(
    LG, { settings: { pointsPerCorrectPick: 3, ...settings }, ...(lock ? { liguillaLock: lock } : {}) }, (s) => String(s), (n) => (n === 1 ? "punto" : "puntos"),
    (r) => `${r.resultPoints} pts`, () => "J1", () => "fecha", () => "", () => ({ rules: { resultPoints: 1, exactBonus: 0 } }), () => "", () => "", {})({ resultPts: "1", bonusOn: false, bonusPts: "1" }, unlocked, false);
  const fresh = render({});
  assert.match(fresh, /Sin configurar/);
  assert.match(fresh, /Los valores sugeridos todavía no son reglas activas\./);
  assert.match(fresh, /Hay que guardar las reglas antes de publicar la primera jornada de liguilla\./);
  assert.match(fresh, /La fase regular sigue con <strong>3 puntos por acierto<\/strong>/);
  assert.match(fresh, /id="qz-r-lg-save">Guardar reglas de liguilla<\/button>\s*<button class="btn btn-ghost" id="qz-r-lg-cancel">Cancelar<\/button>/);
  const saved = render({ liguilla: { resultPoints: 2, exactBonus: 0 } });
  assert.match(saved, /Configurada/);
  assert.match(saved, /Los cambios que hagas aquí no cuentan hasta que los guardes\./);
  const locked = render({}, true, { rules: { resultPoints: 2, exactBonus: 0 }, lockedAt: "x" });
  assert.match(locked, /Fijas/);
  assert.doesNotMatch(locked, /qz-r-lg-cancel|qz-r-lg-save/, "con candado no hay nada que guardar ni cancelar");
  assert.match(render({}, false), /Hay que guardar las reglas antes de publicar la primera jornada de liguilla\./, "también bloqueada con contraseña");
});

test("«Cancelar» de liguilla: vuelve a lo guardado vigente, sin guardar, publicar ni tocar el candado", () => {
  const wire = fn("function wireReglasLiguilla(body, st, repaint, saveProtected)");
  const cancel = wire.slice(wire.indexOf('const cancel = document.getElementById("qz-r-lg-cancel");'), wire.indexOf('const save = document.getElementById("qz-r-lg-save");'));
  assert.ok(cancel.includes("const fresh = await getMeta({ owner: adminOrOwnerCred() });"), "lee lo vigente en el servidor");
  assert.ok(cancel.includes("Object.assign(st, lgFormFromSettings());"), "descarta el formulario de liguilla");
  assert.ok(cancel.includes("sec.outerHTML = reglasLiguillaCardHtml(st, true, false);"), "sólo repinta su tarjeta (lo escrito en las demás se queda)");
  assert.doesNotMatch(cancel.slice(0, cancel.indexOf("}else{")), /await repaint\(\)/, "no repinta toda la pantalla");
  assert.doesNotMatch(cancel, /saveProtected\(|setMeta|liguillaLock\s*=|publish|_lgReturn\s*=/, "no escribe nada ni publica (sólo vuelve a conectar la tarjeta)");
  assert.match(cancel, /La liguilla sigue sin configurar\./);
});
