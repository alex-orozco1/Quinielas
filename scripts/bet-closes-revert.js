#!/usr/bin/env node
// MS2 · D4 — vuelta atrás de la migración de cierres, sin restaurar el respaldo.
//
//   DATABASE_URL=… node scripts/bet-closes-revert.js --applied=aplicado.json --backup=respaldo-meta.json
//   DATABASE_URL=… node scripts/bet-closes-revert.js --applied=aplicado.json --backup=respaldo-meta.json --apply --database=<nombre>
//
// --applied es la salida de bet-closes-migrate.js --apply. Por cada quiniela
// que esa aplicación escribió, quita SÓLO lo que escribió (closesAt,
// closesRoundId, closeSource y closeFlag de esas preguntas, y la marca
// betCloseMigration), si sigue tal cual. Si algo cambió después (el admin movió
// un cierre, se cerró el torneo, se quitó una pregunta), esa quiniela no se
// toca, sale en needsReview y el código es 3: ahí se decide a mano.
// --backup es el respaldo tomado justo antes de aplicar: una pregunta sólo se
// deshace si, con las jornadas de ahora, vuelve EXACTAMENTE al cierre que tenía
// antes de migrar (misma jornada, misma hora); si su jornada cambió después,
// esa quiniela pide revisión. `reopens` lista las que hoy están cerradas y
// quedarían abiertas (las cerradas por protección): deshacer las reabre a
// propósito, así que eso se autoriza de forma explícita antes de --apply.
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
  if (typeof arg("backup") !== "string") { console.error("Falta --backup=<respaldo tomado antes de aplicar>."); process.exit(2); }
  const applied = JSON.parse(fs.readFileSync(arg("applied"), "utf8"));
  if (applied.mode !== "apply" || typeof applied.database !== "string") { console.error("--applied tiene que ser la salida de bet-closes-migrate.js --apply (con su base)."); process.exit(2); }
  const backup = JSON.parse(fs.readFileSync(arg("backup"), "utf8"));
  // El respaldo tiene que ser el de ANTES de aplicar: una exportación tomada
  // antes de la aplicación, de la misma base. Si no, nada.
  if (backup.mode !== "export" || typeof backup.at !== "string" || typeof applied.at !== "string" || !(Date.parse(backup.at) <= Date.parse(applied.at)) || backup.database !== applied.database) {
    console.error("--backup tiene que ser la exportación tomada ANTES de esa aplicación, de la misma base. No se escribió nada.");
    process.exit(2);
  }
  const backupRows = new Map((backup.rows || []).map((r) => [r.key, r.text]));
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
    if (applied.database !== db) {
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
        const nowMs = (await client.query("SELECT now() AS now")).rows[0].now.getTime();
        const before = backupRows.has(entry.key) ? JSON.parse(backupRows.get(entry.key)) : null;
        const plan = planRevert(current, entry, before, nowMs);
        const out = { slug: entry.slug };
        if (plan.next && plan.reopens.length) out.reopens = plan.reopens;
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
    const reopens = quinielas.reduce((n, q) => n + (q.reopens ? q.reopens.length : 0), 0);
    process.stdout.write(JSON.stringify({ mode: apply ? "revert" : "revert-report", database: db, quinielas, needsReview, reopens }, null, 2) + "\n");
    if (needsReview) { console.error(`${needsReview} quiniela(s) cambiaron después de aplicar: no se tocaron (needsReview).`); process.exitCode = 3; }
  } catch (err) {
    if (!apply) await client.query("ROLLBACK").catch(() => {});
    // Lo que ya se hizo antes del error, para no tener que adivinarlo.
    process.stdout.write(JSON.stringify({ mode: apply ? "revert" : "revert-report", error: true, quinielas }, null, 2) + "\n");
    console.error("La vuelta atrás falló:", err && err.message ? err.message : "error");
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
