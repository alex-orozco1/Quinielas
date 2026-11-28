// Las pruebas que evalúan funciones de public/index.html fuera del navegador
// (new Function sobre su código) necesitan el módulo de la Tabla igual que la
// página: standings.js, expuesto como QS (y window.QracksStandings).
const QS = require("../../standings");
globalThis.QS = QS;
globalThis.QracksStandings = QS;
module.exports = QS;
