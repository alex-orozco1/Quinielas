// MS2 · D4 — operación de la migración de cierres (betCloseMigration.js), la
// parte pura: lo que se revisa ANTES de aplicar y lo que se comprueba DESPUÉS.
//
//   - inventoryOf: excepciones que el reporte no detalla (el «goleador» de
//     antes sin convertir; preguntas de torneo sin cierre propio en quinielas
//     ya migradas; antiguas cuya jornada tiene una fecha ilegible). Sólo ids,
//     números, estados y conteos: ningún texto de pregunta, respuesta o nombre.
//   - decisiones: el archivo que escribe el dueño, con una decisión por cada
//     pregunta ambigua ({ action: "link", roundId, roundNumber, roundDeadline }
//     o { action: "cutoff" }), por slug exacto. toOverrides da el archivo que
//     lee el script de migración (sólo los «link»); checkDecisions lo coteja
//     contra el ensayo (la migración sin --apply, con esos overrides): un slug
//     que no existe, una decisión que no se aplicó tal cual, una ambigua sin
//     decisión o un needsReview son errores. Un exit 0 del ensayo no basta.
//   - checkBackup / verifyApply / planRevert: el respaldo es verificable, lo
//     aplicado se coteja contra lo que el ensayo dijo, y la vuelta atrás sólo
//     quita lo que la migración escribió y nadie cambió después.
//
// Nada de aquí lee ni escribe la base; los scripts de scripts/ lo hacen.

const crypto = require("node:crypto");
const { instantMs, realDeadlineMs, betCloseState } = require("./betCloses");
const { alreadyMigrated, classifyLegacyBet, MIGRATION_VERSION } = require("./betCloseMigration");
const { readTournamentEpoch } = require("./metaParticipants");

const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const stable = (v) => JSON.stringify(v, (k, x) => (isObj(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));

// Los campos de cierre que pone el servidor (y la migración).
const CLOSE_FIELDS = ["closesAt", "closesRoundId", "closeSource", "closeFlag"];
// Lo que la migración escribe en la meta además de esos campos: la marca y los
// sellos de revisión de stampMetaWrite (los tres contadores de arriba y `rev`
// en cada participante). Nada más se ignora al comparar.
const STAMP_FIELDS = ["betCloseMigration", "betsRevision", "roundsRevision", "participantsRevision"];

function slugOfKey(key) {
  return key === "quiniela_meta_v1" ? null : String(key).slice("quiniela:".length, -":meta".length);
}

// El número de jornada del «goleador» de antes, como lo normaliza el cliente.
function scorerRoundNumber(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? v
    : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  return n || null;
}

function answersOf(meta, betId) {
  const ps = list(obj(meta).participants).filter((p) => isObj(p) && isObj(p.customBetAnswers) && isObj(p.customBetAnswers[betId]));
  return { answers: ps.length, hits: ps.filter((p) => p.customBetAnswers[betId].correct === true).length };
}

function deadlineKind(d) {
  if (d === null || d === undefined) return "null";
  if (typeof d === "string") return "texto";
  if (typeof d === "boolean") return "booleano";
  return "otro";
}

// Cómo está una jornada para una pregunta antigua, sin decir su valor.
function legacyRoundState(meta, n, nowMs) {
  const rounds = list(obj(meta).rounds);
  if (!n) return { state: "sin_jornada_de_cierre", roundId: null };
  const matches = rounds.filter((r) => r && r.number === n);
  if (!matches.length) return { state: "jornada_no_existe", roundId: null };
  if (matches.length > 1) return { state: "numero_repetido", roundId: null, roundIds: matches.map((r) => r.id) };
  const r = matches[0];
  const closed = betCloseState({ scope: "temporada", closesAtRound: n }, rounds, nowMs).closed;
  if (realDeadlineMs(r.deadline) === null) return { state: closed ? "fecha_ilegible_cerrada" : "fecha_ilegible_abierta", roundId: r.id, deadlineKind: deadlineKind(r.deadline) };
  return { state: closed ? "cerrada" : "abierta", roundId: r.id };
}

// Pure. Las excepciones de una quiniela (ver arriba). null si no tiene ninguna.
function inventoryOf(meta, nowMs) {
  const m = obj(meta);
  const migrated = alreadyMigrated(m);
  const out = { alreadyMigrated: migrated, epoch: readTournamentEpoch(m), archives: list(m.pastTournaments).length };
  let any = false;
  if (!m.customBetsMigrated && isObj(m.golScorerBet)) {
    const g = m.golScorerBet;
    const n = scorerRoundNumber(g.closesAtRound);
    const ps = list(m.participants).filter(isObj);
    out.legacyScorer = {
      enabled: g.enabled === true,
      closesAtRound: n,
      ...legacyRoundState(m, n, nowMs),
      answers: ps.filter((p) => typeof p.golScorerGuess === "string" && p.golScorerGuess.trim() !== "").length,
      hits: ps.filter((p) => p.golScorerCorrect === true).length,
    };
    any = true;
  }
  const tournament = list(m.customBets).filter((b) => isObj(b) && b.scope === "temporada" && instantMs(b.closesAt) === null);
  if (migrated) {
    const rows = tournament.map((b) => ({
      betId: b.id,
      closesAtRound: b.closesAtRound ?? null,
      closeSource: b.closeSource ?? null,
      category: classifyLegacyBet(b, m).category,
      ...legacyRoundState(m, Number.isInteger(b.closesAtRound) && b.closeSource !== "none" ? b.closesAtRound : null, nowMs),
      ...answersOf(m, b.id),
    }));
    if (rows.length) { out.withoutOwnClose = rows; any = true; }
  } else {
    const rows = tournament
      .filter((b) => b.closeSource !== "none" && Number.isInteger(b.closesAtRound) && b.closesAtRound >= 1)
      .filter((b) => { const ms = list(m.rounds).filter((r) => r && r.number === b.closesAtRound); return ms.length > 0 && ms.every((r) => realDeadlineMs(r.deadline) === null); })
      .map((b) => ({ betId: b.id, closesAtRound: b.closesAtRound, ...legacyRoundState(m, b.closesAtRound, nowMs), ...answersOf(m, b.id) }));
    if (rows.length) { out.unreadableDeadline = rows; any = true; }
  }
  return any ? out : null;
}

function inventoryTotals(quinielas) {
  const t = { quinielas: quinielas.length, legacyScorer: { total: 0, enabled: 0, byState: {} }, withoutOwnClose: { total: 0, byCategory: {} }, unreadableDeadline: { total: 0, byState: {} } };
  const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
  for (const q of quinielas) {
    if (q.legacyScorer) { t.legacyScorer.total++; if (q.legacyScorer.enabled) t.legacyScorer.enabled++; inc(t.legacyScorer.byState, q.legacyScorer.state); }
    for (const r of list(q.withoutOwnClose)) { t.withoutOwnClose.total++; inc(t.withoutOwnClose.byCategory, r.category); }
    for (const r of list(q.unreadableDeadline)) { t.unreadableDeadline.total++; inc(t.unreadableDeadline.byState, r.state); }
  }
  return t;
}

// ---------- Decisiones ----------

// El archivo del dueño → el que lee el script de migración (sólo los «link»).
function toOverrides(decisions) {
  const out = {};
  for (const [slug, bets] of Object.entries(obj(decisions))) {
    for (const [betId, d] of Object.entries(obj(bets))) {
      if (isObj(d) && d.action === "link") {
        (out[slug] = out[slug] || {})[betId] = { action: "link", roundId: d.roundId, roundNumber: d.roundNumber, roundDeadline: d.roundDeadline };
      }
    }
  }
  return out;
}

// Coteja el archivo del dueño contra el ensayo (la migración sin --apply, con
// los overrides de toOverrides). Devuelve { ok, errors, decided, defaults }.
function checkDecisions(decisions, dryRun) {
  const errors = [];
  const err = (slug, betId, reason) => errors.push({ slug, betId: betId ?? null, reason });
  const run = obj(dryRun);
  if (run.mode !== "report") err(null, null, "el_ensayo_no_es_un_reporte");
  if (obj(run.totals).needsReview > 0) err(null, null, "el_ensayo_tiene_needsReview");
  // Una quiniela se nombra por su slug; la heredada (quiniela_meta_v1, sin
  // slug) por esa key, que es como la lee el script de migración.
  const idOf = (q) => q.slug ?? q.key;
  const bySlug = new Map(list(run.quinielas).map((q) => [idOf(q), q]));
  let decided = 0;
  for (const [slug, bets] of Object.entries(obj(decisions))) {
    if (slug !== "quiniela_meta_v1" && (/^quiniela[:_]/.test(slug) || slug.endsWith(":meta"))) { err(slug, null, "usa_el_slug_no_la_key"); continue; }
    const q = bySlug.get(slug);
    if (!q) { err(slug, null, "slug_no_existe_en_el_ensayo"); continue; }
    if (q.alreadyMigrated) { err(slug, null, "quiniela_ya_migrada"); continue; }
    if (list(q.needsReview).length) err(slug, null, "quiniela_con_needsReview");
    const items = new Map(list(q.questions).map((i) => [i.betId, i]));
    for (const [betId, d] of Object.entries(obj(bets))) {
      const i = items.get(betId);
      if (!i) { err(slug, betId, "pregunta_no_existe_en_el_ensayo"); continue; }
      if (i.category !== "ambiguous") { err(slug, betId, "pregunta_no_es_ambigua"); continue; }
      if (!isObj(d) || (d.action !== "link" && d.action !== "cutoff")) { err(slug, betId, "decision_invalida"); continue; }
      if (d.action === "cutoff") {
        if (i.action !== "cerrada_por_proteccion") err(slug, betId, "el_ensayo_no_la_cierra_por_proteccion");
        else decided++;
        continue;
      }
      const cand = list(i.candidates).find((c) => c.roundId === d.roundId);
      if (!cand) { err(slug, betId, "jornada_no_es_candidata"); continue; }
      if (cand.number !== d.roundNumber || instantMs(d.roundDeadline) === null || instantMs(d.roundDeadline) !== instantMs(cand.deadline)) { err(slug, betId, "candidato_cambiado"); continue; }
      if (i.action !== "ligada_por_decision" || i.roundId !== d.roundId || instantMs(i.closesAt) !== instantMs(d.roundDeadline)) { err(slug, betId, "el_ensayo_no_aplico_la_decision"); continue; }
      decided++;
    }
  }
  // Toda ambigua del ensayo tiene que tener su decisión escrita (link o cutoff).
  const defaults = [];
  for (const q of list(run.quinielas)) {
    for (const i of list(q.questions)) {
      if (i.category === "ambiguous" && !Object.prototype.hasOwnProperty.call(obj(obj(decisions)[idOf(q)]), i.betId)) {
        defaults.push({ slug: idOf(q), betId: i.betId });
        err(idOf(q), i.betId, "ambigua_sin_decision");
      }
    }
  }
  return { ok: errors.length === 0, errors, decided, defaults };
}

// ---------- Respaldo ----------

// El respaldo: [{ key, updatedAt, md5, text }], con md5 = md5(value::text) de
// PostgreSQL y text = ese mismo texto. Verificable sin la base: cada text da su
// md5. Con un resumen tomado de la base ({ key, md5 }), se coteja fila a fila.
function checkBackup(backup, summary) {
  const errors = [];
  const rows = list(obj(backup).rows);
  if (obj(backup).count !== rows.length) errors.push({ key: null, reason: "conteo_distinto" });
  for (const r of rows) {
    if (typeof r.text !== "string" || md5(r.text) !== r.md5) errors.push({ key: r.key, reason: "md5_no_cuadra" });
    else { try { JSON.parse(r.text); } catch { errors.push({ key: r.key, reason: "json_invalido" }); } }
  }
  const changedSince = [];
  if (summary) {
    const now = new Map(list(obj(summary).rows).map((r) => [r.key, r.md5]));
    const keys = new Set(rows.map((r) => r.key));
    for (const r of rows) if (now.has(r.key) && now.get(r.key) !== r.md5) changedSince.push(r.key);
    for (const k of now.keys()) if (!keys.has(k)) errors.push({ key: k, reason: "fila_nueva_no_respaldada" });
    for (const k of keys) if (!now.has(k)) errors.push({ key: k, reason: "fila_ya_no_existe" });
  }
  return { ok: errors.length === 0, rows: rows.length, errors, changedSince };
}

// ---------- Después de aplicar ----------

const sinCierre = (b) => { const x = { ...b }; for (const f of CLOSE_FIELDS) delete x[f]; return x; };
const sinSellos = (m) => {
  const x = { ...obj(m) };
  for (const f of STAMP_FIELDS) delete x[f];
  delete x.customBets;
  if (Array.isArray(x.participants)) x.participants = x.participants.map((p) => { if (!isObj(p)) return p; const q = { ...p }; delete q.rev; return q; });
  return x;
};

// Coteja una quiniela antes (respaldo) y después de aplicar, contra lo que la
// migración reportó haber escrito (entry de la salida de --apply). Devuelve la
// lista de diferencias (rutas, nunca valores). Vacía = cuadra.
function verifyQuiniela(before, after, entry) {
  const diffs = [];
  const b = obj(before), a = obj(after);
  if (stable(sinSellos(b)) !== stable(sinSellos(a))) {
    const sb = sinSellos(b), sa = sinSellos(a);
    for (const k of new Set([...Object.keys(sb), ...Object.keys(sa)])) {
      if (stable(sb[k]) !== stable(sa[k])) diffs.push(k === "participants" ? "participants (respuestas, aciertos u otros datos)" : k);
    }
  }
  const mk = obj(a.betCloseMigration);
  if (mk.version !== MIGRATION_VERSION || mk.cutoff !== entry.cutoff) diffs.push("betCloseMigration");
  const bb = new Map(list(b.customBets).filter(isObj).map((x) => [x.id, x]));
  const ab = new Map(list(a.customBets).filter(isObj).map((x) => [x.id, x]));
  if (stable([...bb.keys()].sort()) !== stable([...ab.keys()].sort())) diffs.push("customBets (ids)");
  const items = new Map(list(entry.questions).map((i) => [i.betId, i]));
  for (const [id, x] of bb) {
    const y = ab.get(id);
    if (!y) continue;
    if (stable(sinCierre(x)) !== stable(sinCierre(y))) diffs.push(`customBets.${id} (texto, tipo, puntos o jornada)`);
    const i = items.get(id);
    if (i && (i.action === "ligada" || i.action === "ligada_por_decision")) {
      const r = list(b.rounds).find((rr) => rr && rr.id === i.roundId);
      const ms = r ? realDeadlineMs(r.deadline) : null;
      if (ms === null || instantMs(i.closesAt) !== ms) diffs.push(`customBets.${id}.closesAt (no es el cierre de su jornada en el respaldo)`);
    }
    const expect = expectedClose(x, i, entry);
    for (const f of CLOSE_FIELDS) if (stable(y[f]) !== stable(expect[f])) diffs.push(`customBets.${id}.${f}`);
  }
  return diffs;
}

// Los campos de cierre que la migración debió dejar en una pregunta.
function expectedClose(before, item, entry) {
  const keep = {};
  for (const f of CLOSE_FIELDS) if (before[f] !== undefined) keep[f] = before[f];
  if (!item) return keep;
  switch (item.action) {
    case "ligada":
    case "ligada_por_decision":
      return { closesAt: item.closesAt, closesRoundId: item.roundId, closeSource: "migration_round" };
    case "cerrada_por_proteccion":
      return { closesAt: entry.cutoff, closeSource: "migration_cutoff", closeFlag: item.category };
    case "sin_cierre":
      return { ...keep, closeSource: "none" };
    default:
      return keep;
  }
}

// Una decisión «link» aprobada por el dueño (id, número y fecha de la jornada)
// contra lo que de verdad se usó: la jornada con ese id en el respaldo (su
// número y su cierre), la fecha que dice la salida de --apply y el estado
// después. Mismo instante = igual (dos ISO equivalentes pasan); otro número u
// otro instante, no. Devuelve las diferencias, sin valores.
function linkMatchesApproval(d, item, beforeMeta, afterMeta, betId) {
  const diffs = [];
  const approved = typeof d.roundDeadline === "string" ? instantMs(d.roundDeadline) : null;
  if (approved === null || !Number.isInteger(d.roundNumber)) return [`customBets.${betId}: la decisión aprobada no tiene número o fecha válidos`];
  const r = list(obj(beforeMeta).rounds).find((x) => x && x.id === d.roundId);
  if (!r || r.number !== d.roundNumber) diffs.push(`customBets.${betId}: el número aprobado no es el de esa jornada en el respaldo`);
  if (!r || realDeadlineMs(r.deadline) !== approved) diffs.push(`customBets.${betId}: la fecha aprobada no es el cierre de esa jornada en el respaldo`);
  if (instantMs(item.closesAt) !== approved) diffs.push(`customBets.${betId}: la fecha aplicada no es la aprobada`);
  const b = list(obj(afterMeta).customBets).find((x) => isObj(x) && x.id === betId);
  if (!b || instantMs(b.closesAt) !== approved || b.closesRoundId !== d.roundId) diffs.push(`customBets.${betId}: el estado después no es el aprobado`);
  return diffs;
}

// Respaldo antes + exportación después + salida de --apply (+ el archivo de
// decisiones del dueño, si se da: lo aplicado tiene que ser lo decidido, no
// sólo lo que dijo --apply). Devuelve { ok, checked, problems, notApplied }.
function verifyApply(backup, afterExport, applyResult, decisions) {
  const parse = (rows) => new Map(list(rows).map((r) => [r.key, JSON.parse(r.text)]));
  const before = parse(obj(backup).rows), after = parse(obj(afterExport).rows);
  const problems = [];
  let checked = 0;
  const notApplied = [];
  for (const entry of list(obj(applyResult).quinielas)) {
    if (!entry.applied) { if (!entry.alreadyMigrated) notApplied.push(entry.slug ?? entry.key); continue; }
    checked++;
    if (!before.has(entry.key) || !after.has(entry.key)) { problems.push({ slug: entry.slug, diffs: ["falta_en_respaldo_o_despues"] }); continue; }
    const diffs = verifyQuiniela(before.get(entry.key), after.get(entry.key), entry);
    if (diffs.length) problems.push({ slug: entry.slug, diffs });
  }
  if (obj(applyResult).mode !== "apply") problems.push({ slug: null, diffs: ["la_salida_no_es_de_apply"] });
  if (decisions) {
    const entries = new Map(list(obj(applyResult).quinielas).map((e) => [e.slug ?? e.key, e]));
    // Toda ambigua aplicada (ligada o cerrada por protección) tiene su decisión escrita.
    for (const [slug, e] of entries) {
      if (!e.applied) continue;
      for (const i of list(e.questions)) {
        if (i.category === "ambiguous" && !Object.prototype.hasOwnProperty.call(obj(obj(decisions)[slug]), i.betId)) {
          problems.push({ slug, diffs: [`customBets.${i.betId}: ambigua aplicada sin decisión escrita`] });
        }
      }
    }
    for (const [slug, bets] of Object.entries(obj(decisions))) {
      const e = entries.get(slug);
      const items = new Map(list(e && e.questions).map((i) => [i.betId, i]));
      for (const [betId, d] of Object.entries(obj(bets))) {
        const i = items.get(betId);
        const ok = !!i && !!e.applied && (d && d.action === "link"
          ? i.action === "ligada_por_decision" && i.roundId === d.roundId
          : d && d.action === "cutoff" && i.action === "cerrada_por_proteccion");
        if (!ok) { problems.push({ slug, diffs: [`customBets.${betId}: no se aplicó lo decidido`] }); continue; }
        if (d.action === "link") {
          const diffs = linkMatchesApproval(d, i, before.get(e.key), after.get(e.key), betId);
          if (diffs.length) problems.push({ slug, diffs });
        }
      }
    }
  }
  return { ok: problems.length === 0 && notApplied.length === 0, checked, problems, notApplied };
}

// ---------- Vuelta atrás ----------

// El cierre efectivo de una pregunta por la lectura de antes de migrar (por
// número de jornada): qué jornada y a qué hora, o «sin cierre». Para comparar
// antes de migrar y después de deshacer.
function legacyCloseSignature(bet, meta) {
  const b = obj(bet);
  if (b.scope !== "temporada") return "jornada";
  if (b.closeSource === "none" || !Number.isInteger(b.closesAtRound) || b.closesAtRound < 1) return "sin_cierre";
  const ms = list(obj(meta).rounds).filter((r) => r && r.number === b.closesAtRound);
  if (!ms.length) return "sin_jornada";
  return ms.map((r) => `${r.id}@${realDeadlineMs(r.deadline) ?? stable(r.deadline)}`).join("|");
}

// Pure. Lo que se deshace en una quiniela migrada: sólo los campos que la
// migración escribió (según su salida) y que siguen tal cual, y la marca; y
// sólo si, con las jornadas de ahora, cada pregunta vuelve EXACTAMENTE al
// cierre que tenía antes de migrar (según el respaldo `before`). Si algo cambió
// después (el admin movió un cierre o una jornada, se cerró el torneo, se quitó
// una pregunta), no se toca esa quiniela: { next: null, reasons }.
// `reopens`: las preguntas que hoy están cerradas y quedarían abiertas al
// deshacer (las que la migración cerró por protección y antes estaban
// abiertas): se dicen para que se autoricen de forma explícita.
function planRevert(meta, entry, before, nowMs) {
  const m = obj(meta);
  const reasons = [];
  if (!isObj(before)) return { next: null, reasons: ["falta_el_respaldo_de_antes_de_aplicar"] };
  // Un respaldo de después de aplicar (ya con la marca) no sirve de referencia:
  // compararía contra jornadas que pudieron cambiar después.
  if (isObj(before.betCloseMigration)) return { next: null, reasons: ["el_respaldo_es_de_despues_de_aplicar"] };
  const mk = obj(m.betCloseMigration);
  if (mk.version !== MIGRATION_VERSION || mk.cutoff !== entry.cutoff) return { next: null, reasons: ["la_marca_no_es_la_de_esa_aplicacion"] };
  const next = JSON.parse(JSON.stringify(m));
  const bets = new Map(list(next.customBets).filter(isObj).map((b) => [b.id, b]));
  const prev = new Map(list(before.customBets).filter(isObj).map((b) => [b.id, b]));
  const touched = [];
  for (const i of list(entry.questions)) {
    if (!["ligada", "ligada_por_decision", "cerrada_por_proteccion", "sin_cierre"].includes(i.action)) continue;
    const b = bets.get(i.betId);
    if (!b) { reasons.push(`${i.betId}: ya_no_existe`); continue; }
    const want = expectedClose({}, i, entry);
    const now = {}; for (const f of CLOSE_FIELDS) if (b[f] !== undefined) now[f] = b[f];
    if (stable(now) !== stable(want)) { reasons.push(`${i.betId}: cambio_despues_de_aplicar`); continue; }
    const p = prev.get(i.betId);
    if (!p) { reasons.push(`${i.betId}: no_esta_en_el_respaldo`); continue; }
    const wasClosed = betCloseState(b, m.rounds, nowMs).closed;
    for (const f of CLOSE_FIELDS) delete b[f];
    if (legacyCloseSignature(b, next) !== legacyCloseSignature(p, before)) { reasons.push(`${i.betId}: su_jornada_cambio_despues_de_aplicar`); continue; }
    const closedAfter = betCloseState(b, next.rounds, nowMs).closed;
    // Sólo una cerrada por protección puede volver a abrirse al deshacer (antes
    // estaba abierta). Cualquier otra que se reabriría pide revisión.
    if (wasClosed && !closedAfter && i.action !== "cerrada_por_proteccion") { reasons.push(`${i.betId}: se_reabriria_y_no_la_cerro_la_proteccion`); continue; }
    touched.push({ betId: i.betId, wasClosed, closedAfter });
  }
  if (reasons.length) return { next: null, reasons };
  delete next.betCloseMigration;
  return { next, reasons: [], reopens: touched.filter((x) => x.wasClosed && !x.closedAfter).map((x) => x.betId) };
}

module.exports = {
  CLOSE_FIELDS,
  md5,
  slugOfKey,
  inventoryOf,
  inventoryTotals,
  toOverrides,
  checkDecisions,
  checkBackup,
  verifyQuiniela,
  verifyApply,
  planRevert,
};
