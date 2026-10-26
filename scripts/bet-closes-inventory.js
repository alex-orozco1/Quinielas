#!/usr/bin/env node
// MS2 · D4 — inventario y respaldo de SÓLO LECTURA para la migración de cierres.
//
//   DATABASE_URL=… node scripts/bet-closes-inventory.js            > inventario.json
//   DATABASE_URL=… node scripts/bet-closes-inventory.js --export   > respaldo-meta.json
//   DATABASE_URL=… node scripts/bet-closes-inventory.js --summary  > resumen-meta.json
//
// Una sola transacción READ ONLY: PostgreSQL rechaza cualquier escritura.
//   - Sin opción: las excepciones que el reporte de la migración no detalla
//     (betCloseOps.inventoryOf): el «goleador» de antes sin convertir, las
//     preguntas de torneo sin cierre propio en quinielas ya migradas y las
//     antiguas cuya jornada tiene una fecha ilegible. Sólo ids, números,
//     estados y conteos; ningún texto de pregunta, respuesta ni nombre.
//   - --export: el respaldo de las filas de meta, con el texto exacto de cada
//     una y su md5 calculado por PostgreSQL. CONTIENE DATOS PERSONALES (PIN con
//     hash, respuestas): se guarda fuera del repo y de cualquier chat.
//   - --summary: sólo key + md5 de cada fila, para cotejar un respaldo
//     (bet-closes-check.js backup).
const { Pool } = require("pg");
const { inventoryOf, inventoryTotals, slugOfKey } = require("../betCloseOps");

const META_ROWS_SQL = "SELECT key, updated_at, md5(value::text) AS md5, value::text AS text FROM kv WHERE (key = 'quiniela_meta_v1' OR key LIKE 'quiniela:%:meta') AND jsonb_typeof(value) = 'object' ORDER BY key";
const has = (name) => process.argv.includes("--" + name);

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("Falta DATABASE_URL."); process.exit(2); }
  const pool = new Pool({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false }, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const head = (await client.query("SELECT current_database() AS db, now() AS now")).rows[0];
    const rows = (await client.query(META_ROWS_SQL)).rows;
    await client.query("COMMIT");
    const base = { database: head.db, at: head.now.toISOString(), count: rows.length };
    let out;
    if (has("export")) {
      out = { mode: "export", ...base, rows: rows.map((r) => ({ key: r.key, updatedAt: r.updated_at ? r.updated_at.toISOString() : null, md5: r.md5, text: r.text })) };
    } else if (has("summary")) {
      out = { mode: "summary", ...base, rows: rows.map((r) => ({ key: r.key, md5: r.md5 })) };
    } else {
      const quinielas = [];
      for (const r of rows) {
        const inv = inventoryOf(JSON.parse(r.text), head.now.getTime());
        if (inv) quinielas.push({ slug: slugOfKey(r.key), key: r.key, ...inv });
      }
      out = { mode: "inventory", ...base, quinielas, totals: inventoryTotals(quinielas) };
    }
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("El inventario falló:", err && err.message ? err.message : "error");
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
