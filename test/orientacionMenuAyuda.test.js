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
  // Ninguna regla nueva sin el modificador alcanza a las otras barras.
  assert.equal((html.match(/class="qz-tabs qz-tabs--main"/g) || []).length, 1);
  assert.ok(html.includes('<div class="qz-tabs" id="qz-jornada-filters"'));
  assert.ok(html.includes('<div class="qz-tabs" id="qz-admin-subtabs"'));
});
