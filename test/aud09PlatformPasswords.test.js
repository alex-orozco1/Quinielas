// AUD-09 — Panel de Plataforma: las contraseñas nuevas (del panel y de admin
// de una quiniela) se escriben ocultas, con «Mostrar/Ocultar». Comprobación
// estructural sobre el HTML real; el recorrido en navegador lo hace la
// verificación manual del parche.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

for (const id of ["qz-p-newpass", "qz-edit-pass"]) {
  test(`AUD-09 · #${id} usa el campo de contraseña con «Mostrar/Ocultar», con etiqueta`, () => {
    assert.doesNotMatch(html, new RegExp(`<input type="text" id="${id}"`), "ya no es un campo de texto visible");
    assert.match(html, new RegExp(`<label for="${id}">[^<]+</label>\\$\\{passwordFieldHtml\\("${id}", \`[^\`]*autocomplete="new-password"`));
  });
}

test("AUD-09 · el componente empieza oculto y el botón no envía formularios", () => {
  const start = html.indexOf("function passwordFieldHtml(id, extraAttrs){");
  const fn = html.slice(start, html.indexOf("function wirePasswordToggles", start));
  assert.match(fn, /type="password"/);
  assert.match(fn, /<button type="button" class="qz-pass-toggle" data-pass-toggle="\$\{id\}" aria-controls="\$\{id\}" aria-pressed="false">Mostrar<\/button>/);
});

test("AUD-09 · el panel conecta los botones de los dos campos", () => {
  assert.ok(html.includes('wirePasswordToggles(document.getElementById("qz-p-newpass").closest(".field"));'));
  assert.ok(html.includes('if(editPassField) wirePasswordToggles(editPassField.closest(".field"));'));
});
