#!/usr/bin/env node
// MS2 · D4 — aplica la migración de cierres de preguntas (betCloseMigration.js).
//
//   Sin --apply es el mismo reporte de sólo lectura que bet-closes-report.js.
//   Para escribir hacen falta las dos cosas:
//     --apply --database=<nombre>   (el nombre de la base a la que apunta
//                                    DATABASE_URL: una confirmación deliberada)
//   Opcional: --overrides=<archivo.json>  { "<slug>": { "<betId>": "link" } }
//             para ligar, por decisión explícita, preguntas marcadas ambiguous.
//
// Cada quiniela se migra en su transacción, con su fila bloqueada, y queda
// marcada; volver a correrlo (o correrlo dos veces a la vez) no cambia nada más.
// NO se corre contra producción sin autorización explícita.
const fs = require("node:fs");
const { Pool } = require("pg");
const { runBetCloseMigration } = require("../betCloseMigration");

const arg = (name) => {
  const a = process.argv.find((x) => x === "--" + name || x.startsWith("--" + name + "="));
  if (!a) return undefined;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : true;
};

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("Falta DATABASE_URL."); process.exit(2); }
  const apply = arg("apply") === true;
  const overridesFile = arg("overrides");
  let overrides = {};
  if (typeof overridesFile === "string") overrides = JSON.parse(fs.readFileSync(overridesFile, "utf8"));
  const pool = new Pool({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false }, max: 1 });
  try {
    if (apply) {
      const db = (await pool.query("SELECT current_database() AS db")).rows[0].db;
      if (arg("database") !== db) {
        console.error(`Para aplicar, confirma la base con --database=${db}. No se escribió nada.`);
        process.exitCode = 2;
        return;
      }
    }
    const result = await runBetCloseMigration(pool, { apply, overrides });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    console.error("La migración falló:", err && err.message ? err.message : "error");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
