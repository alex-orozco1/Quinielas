// betCloseMigration.js — MS2 · D4: dar su cierre propio a las preguntas de
// torneo guardadas antes de D4, sólo con evidencia.
//
// Una pregunta antigua tiene `closesAtRound` (un NÚMERO de jornada) y nada más.
// Buscar ese número en las jornadas actuales o en el último archivo no prueba
// nada: después de cerrar un torneo, la J1 de hoy es otra jornada de otro
// torneo. Por eso:
//
//   - linked_open / linked_closed: hay evidencia de identidad y pertenencia —
//     la quiniela nunca cerró un torneo (tournamentEpoch 0, sin archivo), así
//     que su tablero es el único que ha existido, y hay UNA jornada con ese
//     número. La pregunta toma el cierre de esa jornada y su id
//     (closeSource "migration_round"). Para una abierta no cambia nada de lo
//     que se ve; para una cerrada, su cierre real queda fijo.
//   - lost_link: ninguna jornada actual tiene ese número (se borró, se
//     renumeró o se archivó). Se cierra por protección: closesAt = el corte de
//     la migración (la hora en que se aplica en esa quiniela), nunca una fecha
//     histórica; closeSource "migration_cutoff", closeFlag "lost_link".
//   - pending_round: en una quiniela de un solo ciclo, su número es mayor que
//     el de cualquier jornada actual: la ligaron a una jornada que todavía no
//     se crea, o se borró la última. Hoy sigue abierta y cerrará con esa
//     jornada cuando exista. No se toca. El reporte separa las que tienen
//     rastro de una jornada borrada (pronósticos o penalizaciones de una
//     jornada que ya no está) de las que no; decidir cerrar alguna es una
//     operación explícita aparte, que no existe todavía.
//   - ambiguous: hay una jornada con ese número pero no hay evidencia de que
//     sea la suya (la quiniela ya cerró algún torneo, o el número se repite).
//     Por defecto, el mismo cierre de protección (closeFlag "ambiguous"); se
//     puede ligar a una jornada sólo con una decisión explícita por pregunta
//     Y por id de jornada, con lo que se revisó en el reporte (D4-03/04):
//       { "<slug>": { "<betId>": { "action": "link", "roundId": "…",
//                                  "roundNumber": N, "roundDeadline": "…" } } }
//     Al aplicar, bajo el candado de la fila, se revalida: que la pregunta siga
//     siendo ambigua, que esa jornada sea una de sus candidatas, que su fecha
//     sea válida y que número y cierre sigan siendo los del reporte. Si algo no
//     cuadra, esa quiniela no se escribe y se pide revisión (needsReview). El
//     orden del arreglo nunca decide.
//   - no_close: nunca tuvo cierre. Sigue «Sin cierre» en el torneo activo
//     (closeSource "none", sin fecha) y se cierra y archiva al terminarlo.
//   - own_close: ya tiene su cierre propio (creada con D4). No se toca.
//   - round_question: de jornada; cierra con cada jornada. No se toca.
//
// No se borra, mueve ni recalifica ninguna respuesta. Lo que una quiniela con
// torneos cerrados todavía cuenta de preguntas antiguas con aciertos se reporta
// (points_unattributed), sin decidir a qué torneo pertenecen.
//
// Idempotente: cada quiniela queda marcada (`betCloseMigration`, del servidor)
// en la misma transacción, bajo el candado de su fila; una segunda pasada, otra
// instancia o un reinicio la saltan y el corte no se mueve.

const { stampMetaRevisions } = require("./metaParticipants");
const { stampRoundsRevision } = require("./roundsConcurrency");
const { stampBetsRevision } = require("./betsConcurrency");
const { readTournamentEpoch } = require("./metaParticipants");
const { instantMs, sameInstant } = require("./betCloses");

const MIGRATION_VERSION = 1;
const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const isBet = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// La misma composición que stampMetaWrite() en server.js (una prueba lo
// comprueba): toda escritura de la meta avanza las revisiones que cambian.
function stampMetaWrite(doc, oldValue) {
  return stampBetsRevision(stampRoundsRevision(stampMetaRevisions(doc, oldValue), oldValue), oldValue);
}

function alreadyMigrated(meta) {
  const m = obj(obj(meta).betCloseMigration);
  return Number.isInteger(m.version) && m.version >= MIGRATION_VERSION;
}

// Pure. Clasifica UNA pregunta de torneo antigua (sin closesAt) contra la meta
// en que vive. Devuelve { category, evidence, round? }.
function classifyLegacyBet(bet, meta) {
  const m = obj(meta);
  const b = obj(bet);
  if (b.scope !== "temporada") return { category: "round_question" };
  if (instantMs(b.closesAt) !== null) return { category: "own_close" };
  if (b.closeSource === "none" || !Number.isInteger(b.closesAtRound) || b.closesAtRound < 1) return { category: "no_close" };
  const matches = list(m.rounds).filter((r) => r && r.number === b.closesAtRound);
  const epoch = readTournamentEpoch(m);
  const archives = list(m.pastTournaments).length;
  const singleCycle = epoch === 0 && archives === 0;
  if (!matches.length) {
    const inArchive = list(m.pastTournaments).some((t) => list(obj(t).rounds).some((r) => r && r.number === b.closesAtRound));
    const maxNumber = Math.max(0, ...list(m.rounds).filter((r) => r && Number.isInteger(r.number)).map((r) => r.number));
    if (singleCycle && b.closesAtRound > maxNumber) return { category: "pending_round", evidence: { epoch, archives, maxRoundNumber: maxNumber } };
    return { category: "lost_link", evidence: { epoch, archives, numberInArchive: inArchive } };
  }
  const round = matches[0];
  if (!singleCycle || matches.length > 1 || instantMs(String(round.deadline)) === null) {
    return { category: "ambiguous", candidates: matches, evidence: { epoch, archives, roundsWithNumber: matches.length } };
  }
  return { category: "linked", round, evidence: { epoch: 0, archives: 0, roundsWithNumber: 1 } };
}

const candidateOf = (r) => ({ roundId: r.id, number: r.number, deadline: typeof r.deadline === "string" ? r.deadline : null, published: r.published !== false });

// Pure. Las decisiones explícitas de una quiniela, revalidadas contra la meta
// leída bajo candado. Devuelve { decisions: Map(betId → jornada), review: [] }.
function checkOverrides(m, overrides) {
  const decisions = new Map();
  const review = [];
  const bets = new Map(list(m.customBets).filter(isBet).map((b) => [b.id, b]));
  for (const [betId, o] of Object.entries(obj(overrides))) {
    const bet = bets.get(betId);
    if (!bet) { review.push({ betId, reason: "override_unknown_bet" }); continue; }
    const c = classifyLegacyBet(bet, m);
    if (c.category !== "ambiguous") { review.push({ betId, reason: "override_not_applicable" }); continue; }
    if (typeof o === "string") { review.push({ betId, reason: "override_needs_round_id" }); continue; }
    if (!isBet(o) || o.action !== "link" || typeof o.roundId !== "string") { review.push({ betId, reason: "override_invalid" }); continue; }
    const cand = c.candidates.find((r) => r && r.id === o.roundId);
    if (!cand) { review.push({ betId, reason: "override_round_not_candidate" }); continue; }
    if (instantMs(String(cand.deadline)) === null) { review.push({ betId, reason: "override_round_invalid_deadline" }); continue; }
    if (o.roundNumber !== cand.number || typeof o.roundDeadline !== "string" || !sameInstant(o.roundDeadline, String(cand.deadline))) {
      review.push({ betId, reason: "override_stale" }); continue;
    }
    decisions.set(betId, cand);
  }
  return { decisions, review };
}

// Pure. El plan para una quiniela. `nowMs` y `cutoffIso` salen del reloj de la
// base, dentro de la transacción. `overrides`: las decisiones explícitas de
// esta quiniela (ver arriba). `traces`: rastros de jornadas borradas
// ({ orphanRoundIds }), para separar las pendientes.
//   Devuelve { migrated, items, next, needsReview } — `next` es la meta a
//   guardar, o null si ya estaba migrada o si alguna decisión pide revisión
//   (entonces no se escribe nada de esta quiniela).
function planBetCloseMigration(meta, { nowMs, cutoffIso, overrides = {}, traces = {} } = {}) {
  const m = obj(meta);
  const epoch = readTournamentEpoch(m);
  const archives = list(m.pastTournaments).length;
  const items = [];
  const pendingScorer = !m.customBetsMigrated && obj(m.golScorerBet).enabled === true;
  if (alreadyMigrated(m)) {
    const needsReview = Object.keys(obj(overrides)).map((betId) => ({ betId, reason: "already_migrated" }));
    return { migrated: true, items, next: null, epoch, archives, pendingScorer, needsReview };
  }
  const { decisions, review } = checkOverrides(m, overrides);
  const orphans = Number.isInteger(obj(traces).orphanRoundIds) ? traces.orphanRoundIds : 0;
  const next = JSON.parse(JSON.stringify(m));
  next.customBets = list(next.customBets).map((bet) => {
    if (!isBet(bet)) return bet;
    const c = classifyLegacyBet(bet, m);
    const hits = list(m.participants).filter((p) => isBet(p) && isBet(p.customBetAnswers) && isBet(p.customBetAnswers[bet.id]) && p.customBetAnswers[bet.id].correct === true).length;
    const answers = list(m.participants).filter((p) => isBet(p) && isBet(p.customBetAnswers) && isBet(p.customBetAnswers[bet.id])).length;
    const item = { betId: bet.id, category: c.category, closesAtRound: bet.closesAtRound ?? null, answers, hits };
    if (c.evidence) item.evidence = { ...c.evidence };
    if (c.category === "ambiguous") item.candidates = c.candidates.map(candidateOf);
    if (c.category === "pending_round") {
      item.evidence.deletedRoundTraces = orphans;
      item.evidence.gapFromMax = bet.closesAtRound - c.evidence.maxRoundNumber;
      item.subcategory = orphans ? "con_rastro_de_jornada_borrada" : "sin_rastro_de_jornada_borrada";
    }
    // Lo que una quiniela con torneos cerrados cuenta hoy de una pregunta
    // antigua sin pertenencia probada: se reporta, no se decide.
    if (bet.scope === "temporada" && hits > 0 && (epoch > 0 || archives > 0) && c.category !== "own_close") item.pointsUnattributed = true;
    const out = { ...bet };
    if (c.category === "no_close") {
      out.closeSource = "none";
      item.action = "sin_cierre";
    } else if (c.category === "pending_round") {
      item.action = "sin_cambio_pendiente";
    } else if (c.category === "linked" || (c.category === "ambiguous" && decisions.has(bet.id))) {
      // Ligada con evidencia, o por decisión explícita ya revalidada (fecha
      // válida, la jornada del reporte, sin cambios). Nunca otra.
      const round = c.category === "linked" ? c.round : decisions.get(bet.id);
      const ms = instantMs(String(round.deadline));
      out.closesAt = new Date(ms).toISOString();
      out.closesRoundId = round.id;
      out.closeSource = "migration_round";
      delete out.closeFlag;
      item.category = c.category === "linked" ? (ms <= nowMs ? "linked_closed" : "linked_open") : "ambiguous";
      item.action = c.category === "linked" ? "ligada" : "ligada_por_decision";
      item.roundId = round.id;
      item.closesAt = out.closesAt;
    } else if (c.category === "lost_link" || c.category === "ambiguous") {
      out.closesAt = cutoffIso;
      out.closeSource = "migration_cutoff";
      out.closeFlag = c.category;
      item.action = "cerrada_por_proteccion";
      item.closesAt = cutoffIso;
    } else {
      item.action = "sin_cambio";
    }
    items.push(item);
    return out;
  });
  next.betCloseMigration = { version: MIGRATION_VERSION, cutoff: cutoffIso, appliedAt: cutoffIso };
  if (review.length) return { migrated: false, items, next: null, epoch, archives, pendingScorer, needsReview: review };
  return { migrated: false, items, next, epoch, archives, pendingScorer, needsReview: [] };
}

// Rastros de jornadas que existieron y ya no están: ids de jornada en los
// pronósticos de los participantes o en su registro de penalizaciones que no
// son de ninguna jornada actual. Sólo se cuentan; no se lee ningún pronóstico.
async function deletedRoundTraces(client, key, meta) {
  const m = obj(meta);
  const current = new Set(list(m.rounds).filter((r) => r && r.id != null).map((r) => r.id));
  const seen = new Set();
  for (const p of list(m.participants)) for (const id of Object.keys(obj(obj(p).penalizedRounds))) if (!current.has(id)) seen.add(id);
  const pattern = key === "quiniela_meta_v1" ? "quiniela\\_picks\\_%\\_v1" : key.slice(0, -":meta".length) + ":picks:%";
  const rows = (await client.query("SELECT value FROM kv WHERE key LIKE $1 AND jsonb_typeof(value) = 'object'", [pattern])).rows;
  for (const r of rows) for (const id of Object.keys(obj(r.value))) if (!id.startsWith("__") && !current.has(id)) seen.add(id);
  return { orphanRoundIds: seen.size };
}

const META_KEYS_SQL = "SELECT key FROM kv WHERE (key = 'quiniela_meta_v1' OR key LIKE 'quiniela:%:meta') AND jsonb_typeof(value) = 'object' ORDER BY key";

// Corre la migración (apply) o sólo el reporte (sin apply) sobre una base.
//   - Reporte: una transacción READ ONLY para todo; no escribe nada.
//   - Aplicar: una transacción por quiniela, con su fila bloqueada (FOR UPDATE),
//     el corte del reloj de la base y la marca en la misma escritura.
// Devuelve { mode, database, at, quinielas: [...], totals }.
async function runBetCloseMigration(pool, { apply = false, overrides = {} } = {}) {
  const client = await pool.connect();
  const quinielas = [];
  let database = null, at = null;
  try {
    database = (await client.query("SELECT current_database() AS db")).rows[0].db;
    if (!apply) await client.query("BEGIN TRANSACTION READ ONLY");
    const keys = (await client.query(META_KEYS_SQL)).rows.map((r) => r.key);
    for (const key of keys) {
      const slug = key === "quiniela_meta_v1" ? null : key.slice("quiniela:".length, -":meta".length);
      if (apply) await client.query("BEGIN");
      try {
        const row = await client.query(`SELECT value, now() AS now FROM kv WHERE key = $1${apply ? " FOR UPDATE" : ""}`, [key]);
        if (!row.rows.length) { if (apply) await client.query("ROLLBACK"); continue; }
        const value = row.rows[0].value;
        const nowDate = row.rows[0].now;
        at = nowDate.toISOString();
        const traces = await deletedRoundTraces(client, key, value);
        const plan = planBetCloseMigration(value, { nowMs: nowDate.getTime(), cutoffIso: nowDate.toISOString(), overrides: obj(overrides[slug || key]), traces });
        const entry = { slug, key, epoch: plan.epoch, archives: plan.archives, alreadyMigrated: plan.migrated, pendingLegacyScorer: plan.pendingScorer, questions: plan.items };
        if (plan.needsReview.length) entry.needsReview = plan.needsReview;
        if (apply && plan.next) {
          await client.query("UPDATE kv SET value = $2, updated_at = now() WHERE key = $1", [key, JSON.stringify(stampMetaWrite(plan.next, value))]);
          entry.applied = true;
          entry.cutoff = plan.next.betCloseMigration.cutoff;
        }
        if (apply) await client.query("COMMIT");
        quinielas.push(entry);
      } catch (err) {
        if (apply) await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
    if (!apply) await client.query("COMMIT");
  } catch (err) {
    if (!apply) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { mode: apply ? "apply" : "report", database, at, quinielas, totals: totalsOf(quinielas) };
}

function totalsOf(quinielas) {
  const t = { quinielas: quinielas.length, alreadyMigrated: 0, withTournamentQuestions: 0, pendingLegacyScorer: 0, pointsUnattributed: 0, needsReview: 0, byCategory: {}, pendingBySubcategory: {} };
  for (const q of quinielas) {
    if (q.alreadyMigrated) t.alreadyMigrated++;
    if (q.needsReview) t.needsReview += q.needsReview.length;
    if (q.pendingLegacyScorer) t.pendingLegacyScorer++;
    if (q.questions.some((i) => i.category !== "round_question")) t.withTournamentQuestions++;
    for (const i of q.questions) {
      t.byCategory[i.category] = (t.byCategory[i.category] || 0) + 1;
      if (i.subcategory) t.pendingBySubcategory[i.subcategory] = (t.pendingBySubcategory[i.subcategory] || 0) + 1;
      if (i.pointsUnattributed) t.pointsUnattributed++;
    }
  }
  return t;
}

module.exports = {
  MIGRATION_VERSION,
  stampMetaWrite,
  alreadyMigrated,
  classifyLegacyBet,
  planBetCloseMigration,
  runBetCloseMigration,
};
