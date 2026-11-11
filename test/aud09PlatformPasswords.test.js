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
  const start = html.indexOf("function passwordFieldHtml(id, extraAttrs, maxLength = 200){");
  const fn = html.slice(start, html.indexOf("function wirePasswordToggles", start));
  assert.match(fn, /type="password"/);
  assert.match(fn, /function passwordFieldHtml\(id, extraAttrs, maxLength = 200\)/, "por omisión, el mismo tope de 200 de siempre");
  assert.match(fn, /<button type="button" class="qz-pass-toggle" data-pass-toggle="\$\{id\}" aria-controls="\$\{id\}" aria-pressed="false">Mostrar<\/button>/);
});

test("AUD-09 · el panel conecta los botones de los dos campos", () => {
  assert.ok(html.includes('wirePasswordToggles(document.getElementById("qz-p-newpass").closest(".field"));'));
  assert.ok(html.includes('if(editPassField) wirePasswordToggles(editPassField.closest(".field"));'));
});

test("AUD-09 · la contraseña nueva del panel no se corta: su campo de acceso (#qz-p-pass) tampoco tiene tope", () => {
  assert.match(html, /passwordFieldHtml\("qz-p-newpass", `[^`]*`, null\)/);
  const login = html.slice(html.indexOf('id="qz-p-pass"') - 200, html.indexOf('id="qz-p-pass"') + 200);
  assert.doesNotMatch(login, /maxlength/, "si el acceso al panel tuviera tope, el campo nuevo debe tener el mismo");
  // La contraseña de admin de una quiniela sigue con el tope de 200, igual que todos sus campos.
  assert.match(html, /passwordFieldHtml\("qz-edit-pass", `[^`]*`\)\}/);
});
