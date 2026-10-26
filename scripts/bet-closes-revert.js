#!/usr/bin/env node
// MS2 · D4 — vuelta atrás de la migración de cierres, sin restaurar el respaldo.
//
//   DATABASE_URL=… node scripts/bet-closes-revert.js --applied=aplicado.json
//   DATABASE_URL=… node scripts/bet-closes-revert.js --applied=aplicado.json --apply --database=<nombre>
//
// --applied es la salida de bet-closes-migrate.js --apply. Por cada quiniela
// que esa aplicación escribió, quita SÓLO lo que escribió (closesAt,
// closesRoundId, closeSource y closeFlag de esas preguntas, y la marca
// betCloseMigration), si sigue tal cual. Si algo cambió después (el admin movió
// un cierre, se cerró el torneo, se quitó una pregunta), esa quiniela no se
// toca, sale en needsReview y el código es 3: ahí se decide a mano.
// Respuestas, aciertos, jornadas y lo demás no se tocan; las revisiones avanzan
// (stampMetaWrite), así que una pestaña abierta recarga en vez de pisar.
// Sin --apply, una transacción READ ONLY que sólo dice lo que haría.
// NO se corre contra producción sin autorización explícita.
const fs = require("node:fs");
const { Pool } = require("pg");
const { planRevert } = require("../betCloseOps");
const { stampMetaWrite } = require("../betCloseMigration");

const arg = (name) => {
  const a = process.argv.find((x) => x === "--" + name || x.startsWith("--" + name + "="));
  if (!a) return undefined;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : true;
};

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("Falta DATABASE_URL."); process.exit(2); }
  if (typeof arg("applied") !== "string") { console.error("Falta --applied=<salida de --apply>."); process.exit(2); }
  const applied = JSON.parse(fs.readFileSync(arg("applied"), "utf8"));
  if (applied.mode !== "apply") { console.error("--applied tiene que ser la salida de bet-closes-migrate.js --apply."); process.exit(2); }
  const apply = arg("apply") === true;
  const pool = new Pool({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false }, max: 1 });
  const client = await pool.connect();
  const quinielas = [];
  try {
    const db = (await client.query("SELECT current_database() AS db")).rows[0].db;
    if (apply && arg("database") !== db) {
      console.error(`Para aplicar, confirma la base con --database=${db}. No se escribió nada.`);
      process.exitCode = 2;
      return;
    }
    if (applied.database && applied.database !== db) {
      console.error("--applied es de otra base. No se escribió nada.");
      process.exitCode = 2;
      return;
    }
    if (!apply) await client.query("BEGIN TRANSACTION READ ONLY");
    for (const entry of applied.quinielas || []) {
      if (!entry.applied) continue;
      if (apply) await client.query("BEGIN");
      try {
        const row = await client.query(`SELECT value FROM kv WHERE key = $1${apply ? " FOR UPDATE" : ""}`, [entry.key]);
        if (!row.rows.length) { quinielas.push({ slug: entry.slug, needsReview: ["la_fila_ya_no_existe"] }); if (apply) await client.query("ROLLBACK"); continue; }
        const current = row.rows[0].value;
        const plan = planRevert(current, entry);
        const out = { slug: entry.slug };
        if (!plan.next) out.needsReview = plan.reasons;
        else if (apply) {
          await client.query("UPDATE kv SET value = $2, updated_at = now() WHERE key = $1", [entry.key, JSON.stringify(stampMetaWrite(plan.next, current))]);
          out.reverted = true;
        } else out.wouldRevert = true;
        if (apply) await client.query("COMMIT");
        quinielas.push(out);
      } catch (err) {
        if (apply) await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
    if (!apply) await client.query("COMMIT");
    const needsReview = quinielas.filter((q) => q.needsReview).length;
    process.stdout.write(JSON.stringify({ mode: apply ? "revert" : "revert-report", database: db, quinielas, needsReview }, null, 2) + "\n");
    if (needsReview) { console.error(`${needsReview} quiniela(s) cambiaron después de aplicar: no se tocaron (needsReview).`); process.exitCode = 3; }
  } catch (err) {
    if (!apply) await client.query("ROLLBACK").catch(() => {});
    console.error("La vuelta atrás falló:", err && err.message ? err.message : "error");
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
