#!/usr/bin/env node
// MS2 · D4 — reporte de SÓLO LECTURA de la migración de cierres de preguntas.
//
//   DATABASE_URL=… node scripts/bet-closes-report.js > reporte.json
//
// Una sola transacción READ ONLY: PostgreSQL rechaza cualquier escritura dentro
// de ella. Lista, por quiniela y por categoría, los ids de las preguntas y lo
// que la migración haría con cada una (betCloseMigration.js). No incluye textos
// de preguntas, respuestas ni nombres: sólo ids, números y conteos.
const { Pool } = require("pg");
const { runBetCloseMigration } = require("../betCloseMigration");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("Falta DATABASE_URL."); process.exit(2); }
  const pool = new Pool({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false }, max: 1 });
  try {
    const report = await runBetCloseMigration(pool, { apply: false });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (err) {
    console.error("El reporte falló:", err && err.message ? err.message : "error");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
