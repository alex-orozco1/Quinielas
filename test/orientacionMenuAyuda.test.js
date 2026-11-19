// Sprint «Orientación y menú del admin»: menú principal repartido y ayuda de
// «Puntos por acierto» con una sola acción.
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

test("menú principal: sólo las pestañas autorizadas, sin espacios reservados ni Admin para participantes", () => {
  const tabList = new Function("currentUser", `${fn("function tabList()")}\nreturn tabList;`);
  const ids = (user) => tabList(user)().map((t) => t.id);
  assert.deepEqual(ids({ isAdmin: true }), ["jornada", "tabla", "historial", "admin"]);
  assert.deepEqual(ids({ isAdmin: false }), ["jornada", "tabla", "historial"]);
  const app = fn("function renderApp()");
  assert.ok(app.includes('<div class="qz-tabs qz-tabs--main">'), "el menú del encabezado lleva su propia clase");
  assert.ok(app.includes(`\${t.id===activeTab?' aria-current="page"':''}`), "la activa se anuncia");
});

test("menú principal: el reparto sólo toca .qz-tabs--main; filtros de Jornada y subpestañas de Admin no cambian", () => {
  const css = html.slice(0, html.indexOf("</style>"));
  const rules = css.split("}").filter((r) => /qz-tabs--main/.test(r));
  assert.ok(rules.some((r) => /\.qz-tabs--main \.qz-tab\{[^]*flex:1 1 0/.test(r + "}")), "las pestañas se reparten el ancho");
  assert.ok(rules.some((r) => /\.qz-tabs--main \.qz-tab\.active\{/.test(r + "}")), "la activa tiene su fondo");
  assert.ok(rules.some((r) => /\.qz-tabs--main \.qz-tab:focus-visible\{/.test(r + "}")), "foco visible con teclado");
  assert.ok(rules.some((r) => /\.qz-tabs--main \.qz-dot\{ flex:none; $/.test(r + "}") || /\.qz-tabs--main \.qz-dot\{\s*flex:none;/.test(r + "}")), "el punto de «Te faltan votos» no se encoge");
  // Ninguna regla nueva sin el modificador alcanza a las otras barras.
  assert.equal((html.match(/class="qz-tabs qz-tabs--main"/g) || []).length, 1);
  assert.ok(html.includes('<div class="qz-tabs" id="qz-jornada-filters"'));
  assert.ok(html.includes('<div class="qz-tabs" id="qz-admin-subtabs"'));
});

test("ayuda de «Puntos por acierto»: sólo «Entendido» (sin «Ocultar»); las demás ayudas conservan las dos", () => {
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const src = [
    html.match(/  const HELP_TEXTS = Object\.freeze\(\{[^]*?\n  \}\);/)[0],
    "  const helpForced = new Set();",
    html.match(/  const HELP_SINGLE_ACTION = new Set\(\[[^\]]*\]\);/)[0],
    fn("function helpKey(featureId)"), fn("function helpState(featureId)"), fn("function setHelpState(featureId, state)"),
    fn("function helpBlockHtml(featureId)"), fn("function helpLinkHtml(featureId)"), fn("function wireHelp(container, repaint)"),
  ].join("\n");
  const api = new Function("window", "SLUG", "currentUser", "esc", "toast",
    `${src}\nreturn { helpBlockHtml, helpLinkHtml, wireHelp, helpState };`)(
    { localStorage }, "q1", { id: "ana" }, (s) => String(s), () => {});
  const puntos = api.helpBlockHtml("reglas.puntos");
  assert.match(puntos, /data-help-ok="reglas\.puntos">Entendido</);
  assert.doesNotMatch(puntos, /Ocultar/);
  assert.match(api.helpBlockHtml("reglas.pagos"), /data-help-hide="reglas\.pagos">Ocultar</, "no se extiende a otras ayudas");

  // Entendido → se cierra y se recuerda → «Cómo funciona» la reabre.
  const handlers = {};
  const container = { querySelectorAll: (sel) => {
    const attr = sel.slice(1, -1);
    return (handlers[attr] || []).map((id) => ({ dataset: { [attr === "data-help-ok" ? "helpOk" : attr === "data-help-open" ? "helpOpen" : "helpHide"]: id }, addEventListener: (_, f) => { handlers["click:" + attr + ":" + id] = f; } }));
  } };
  handlers["data-help-ok"] = ["reglas.puntos"]; handlers["data-help-open"] = ["reglas.puntos"]; handlers["data-help-hide"] = [];
  let repaints = 0;
  api.wireHelp(container, () => { repaints++; });
  handlers["click:data-help-ok:reglas.puntos"]();
  assert.equal(api.helpState("reglas.puntos"), "learned", "se recuerda");
  assert.equal(api.helpBlockHtml("reglas.puntos"), "", "cerrada");
  assert.match(api.helpLinkHtml("reglas.puntos"), /ⓘ Cómo funciona/);
  handlers["click:data-help-open:reglas.puntos"]();
  assert.match(api.helpBlockHtml("reglas.puntos"), /Entendido/, "«Cómo funciona» la vuelve a abrir");
  assert.equal(repaints, 2);
});
