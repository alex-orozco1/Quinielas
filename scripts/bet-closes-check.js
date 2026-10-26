#!/usr/bin/env node
// MS2 · D4 — comprobaciones SIN BASE (sólo archivos) alrededor de la migración.
//
//   node scripts/bet-closes-check.js overrides --decisions=decisiones.json > overrides.json
//       El archivo del dueño (una decisión por cada ambigua, por slug exacto:
//       { "<slug>": { "<betId>": { "action": "link", "roundId", "roundNumber",
//       "roundDeadline" } | { "action": "cutoff" } } }) → el que lee
//       bet-closes-migrate.js --overrides (sólo los «link»).
//   node scripts/bet-closes-check.js decisions --decisions=decisiones.json --dry-run=ensayo.json
//       Coteja las decisiones contra el ensayo (bet-closes-migrate.js
//       --overrides=overrides.json, SIN --apply). Falla (código 3) si un slug no
//       existe, si una decisión no se aplicó tal cual, si una ambigua no tiene
//       decisión o si hay needsReview. Un exit 0 del ensayo no basta.
//   node scripts/bet-closes-check.js backup --backup=respaldo-meta.json [--summary=resumen-meta.json]
//       Cada fila del respaldo da su md5; con un resumen recién tomado de la
//       base, también que no falte ni sobre ninguna fila.
//   node scripts/bet-closes-check.js verify --backup=respaldo-meta.json --after=despues-meta.json --applied=aplicado.json
//       Después de aplicar: preguntas, fechas, respuestas y aciertos, contra lo
//       que la migración dijo haber escrito. Sólo cambian los campos de cierre
//       esperados, la marca y los sellos de revisión.
//
// La salida no lleva valores de las filas: sólo slugs, ids y razones.
const fs = require("node:fs");
const ops = require("../betCloseOps");

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith("--" + name + "="));
  return a ? a.slice(a.indexOf("=") + 1) : undefined;
};
const read = (name) => {
  const f = arg(name);
  if (!f) { console.error(`Falta --${name}=<archivo>.`); process.exit(2); }
  return JSON.parse(fs.readFileSync(f, "utf8"));
};
const done = (result) => {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 3;
};

const cmd = process.argv[2];
try {
  if (cmd === "overrides") process.stdout.write(JSON.stringify(ops.toOverrides(read("decisions")), null, 2) + "\n");
  else if (cmd === "decisions") done(ops.checkDecisions(read("decisions"), read("dry-run")));
  else if (cmd === "backup") done(ops.checkBackup(read("backup"), arg("summary") ? read("summary") : null));
  else if (cmd === "verify") done(ops.verifyApply(read("backup"), read("after"), read("applied")));
  else { console.error("Uso: bet-closes-check.js overrides|decisions|backup|verify …"); process.exitCode = 2; }
} catch (err) {
  console.error("La comprobación falló:", err && err.message ? err.message : "error");
  process.exitCode = 1;
}
