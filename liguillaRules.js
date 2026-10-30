// liguillaRules.js — lo que el SERVIDOR decide sobre la liguilla.
//
// Puro (sin I/O ni reloj propio): server.js le pasa la fila guardada, el
// documento ya fusionado, el ciclo de torneo y la hora, y aplica la respuesta
// dentro de la misma transacción que escribe la meta.
//
// Lo que hace cumplir (sprint de liguilla, D1–D7):
//
//   D1  Las reglas de liguilla se FIJAN al publicar la primera jornada de
//       liguilla del torneo en curso. El candado vive en `liguillaLocks`, que
//       sólo escribe el servidor (la fila guardada siempre gana), y está atado
//       al ciclo de torneo: borrar o retirar la jornada no lo quita, cambiarle
//       la fase tampoco, y un torneo nuevo empieza sin candado.
//   D2  Una jornada de liguilla puede publicar resultados PARCIALES: cada
//       partido tiene resultado o un estado explícito (pendiente, aplazado,
//       anulado). Nunca un hueco sin explicación.
//   D5  Una jornada publicada conserva su tipo y sus reglas. No se convierte
//       en liguilla (ni deja de serlo) después de publicada, y su copia de
//       reglas (`scoring`) es del servidor.
//   D6  No se publica una jornada de liguilla con rivales por definir.
//   D7  Marcadores: enteros de 0 a 30 (liguillaScoring.js).
//
// La fase regular no pasa por nada de esto: una jornada sin `stage` sigue
// exactamente las reglas de siempre.
const L = require("./liguillaScoring");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const isPublished = (r) => !!r && r.published !== false;
const LEGACY_SCOPE = "legacy";

function lockFor(locks, scopeId) {
  return (Array.isArray(locks) ? locks : []).find((l) => l && l.scopeId === scopeId) || null;
}

function fail(status, error, extra) {
  return { ok: false, status, error, ...(extra || {}) };
}

// Revisa los resultados de una jornada de liguilla publicada.
function checkLiguillaResults(round) {
  const rules = L.roundRules(round);
  if (!rules) return fail(409, "liguilla_rules_missing", { roundNumber: round.number });
  const matches = Array.isArray(round.matches) ? round.matches : [];
  const ids = new Set(matches.map((m) => m && m.id));
  const results = isObj(round.results) ? round.results : {};
  const scores = isObj(round.scores) ? round.scores : {};
  const status = isObj(round.matchStatus) ? round.matchStatus : {};
  for (const k of Object.keys(status)) {
    if (!ids.has(k)) return fail(400, "invalid_value", { field: "rounds.matchStatus", roundNumber: round.number });
  }
  let resolved = 0;
  for (const m of matches) {
    const st = status[m.id];
    if (st != null) {
      if (!L.STATUSES.includes(st)) return fail(400, "invalid_value", { field: "rounds.matchStatus", roundNumber: round.number });
      // Un partido con estado no lleva resultado: dos verdades sobre el mismo
      // partido es justo lo que no se puede calificar.
      if (results[m.id] != null || scores[m.id] != null) {
        return fail(400, "liguilla_result_with_status", { roundNumber: round.number, matchId: m.id });
      }
      if (st === L.MATCH_STATUS.VOID) resolved += 1;
      continue;
    }
    if (!L.OUTCOMES.includes(results[m.id])) return fail(400, "incomplete_results", { roundNumber: round.number });
    if (rules.capture === "score") {
      if (!L.isScore(scores[m.id])) return fail(400, "invalid_score", { roundNumber: round.number, matchId: m.id });
      if (L.outcomeOfScore(scores[m.id]) !== results[m.id]) {
        return fail(400, "liguilla_result_mismatch", { roundNumber: round.number, matchId: m.id });
      }
    } else if (scores[m.id] != null) {
      return fail(400, "invalid_score", { roundNumber: round.number, matchId: m.id });
    }
    resolved += 1;
  }
  if (!resolved) return fail(400, "incomplete_results", { roundNumber: round.number });
  return { ok: true };
}

/**
 * Aplica las reglas de liguilla a un guardado de la meta. MUTA `merged` (es
 * la copia fusionada que se va a guardar) y devuelve { ok:true, locked } o
 * { ok:false, status, error, ... }.
 *
 * @param oldValue  la fila guardada, leída bajo lock
 * @param merged    el documento fusionado (mergeProtectedMetaFields)
 * @param scopeId   el ciclo de torneo en curso (platform_index), o null
 * @param nowIso    la hora del servidor
 */
function applyLiguillaWrite({ oldValue, merged, scopeId, nowIso }) {
  const scope = scopeId || LEGACY_SCOPE;
  const old = isObj(oldValue) ? oldValue : {};
  // El candado lo escribe sólo el servidor: la fila guardada siempre gana.
  const locks = Array.isArray(old.liguillaLocks) ? JSON.parse(JSON.stringify(old.liguillaLocks)) : [];
  delete merged.liguillaLocks;
  delete merged.liguillaLock;   // se calcula en cada lectura, nunca se guarda
  const settings = isObj(merged.settings) ? merged.settings : (merged.settings = {});
  const oldSettings = isObj(old.settings) ? old.settings : {};

  // La configuración, si viene, tiene que ser una configuración posible.
  const incomingRules = settings.liguilla;
  if (incomingRules != null && !same(incomingRules, oldSettings.liguilla)) {
    const v = L.validateRules(incomingRules);
    if (!v.ok) return fail(400, v.reason);
    settings.liguilla = { ...v.rules };
  }
  let lock = lockFor(locks, scope);
  if (lock && !L.sameRules(settings.liguilla, oldSettings.liguilla)) {
    return fail(409, "liguilla_rules_locked", { lockedAt: lock.lockedAt });
  }

  const oldRounds = new Map((Array.isArray(old.rounds) ? old.rounds : []).filter(isObj).map((r) => [r.id, r]));
  const rounds = Array.isArray(merged.rounds) ? merged.rounds : [];
  let lockedNow = false;
  for (const round of rounds) {
    if (!isObj(round)) continue;
    const before = oldRounds.get(round.id) || null;
    if (round.stage != null && round.stage !== "liguilla") {
      return fail(400, "invalid_value", { field: "rounds.stage", roundNumber: round.number });
    }
    if (!L.validPhase(round.phase)) {
      return fail(400, "invalid_value", { field: "rounds.phase", roundNumber: round.number });
    }
    const wasPublished = !!before && isPublished(before);
    // D5: el tipo de una jornada publicada no cambia.
    if (wasPublished && (before.stage || null) !== (round.stage || null)) {
      return fail(409, "liguilla_stage_locked", { roundNumber: round.number });
    }
    // La copia de reglas es del servidor: la de una jornada ya publicada se
    // conserva; cualquier otra que traiga el request se descarta.
    if (wasPublished) {
      if (before.scoring) round.scoring = JSON.parse(JSON.stringify(before.scoring));
      else delete round.scoring;
    } else {
      delete round.scoring;
    }
    // D3: una jornada de liguilla publicada conserva su cierre una vez que
    // pasó. Moverlo (reabrir, o «reprogramar» un aplazado) reabriría
    // pronósticos ya cerrados.
    if (wasPublished && before.stage === "liguilla" && round.deadline !== before.deadline) {
      const closedAt = new Date(before.deadline).getTime();
      const now = new Date(nowIso).getTime();
      if (Number.isFinite(closedAt) && closedAt <= now) {
        return fail(409, "liguilla_round_closed", { roundNumber: round.number });
      }
    }
    const newlyPublished = isPublished(round) && !wasPublished;
    if (round.stage === "liguilla" && newlyPublished) {
      if (!lock) {
        const v = L.validateRules(settings.liguilla);
        if (!v.ok) return fail(409, "liguilla_rules_required", { roundNumber: round.number });
        lock = { scopeId: scope, lockedAt: nowIso, roundId: round.id, roundNumber: round.number, rules: { ...v.rules } };
        locks.push(lock);
        lockedNow = true;
      }
      const pending = (Array.isArray(round.matches) ? round.matches : []).filter((m) => !m || !m.teamA || !m.teamB).length;
      if (pending) return fail(409, "liguilla_rival_pending", { roundNumber: round.number, pending });
      round.scoring = { ...lock.rules };
    }
    if (round.stage === "liguilla" && isPublished(round) && round.resultsPublished) {
      const check = checkLiguillaResults(round);
      if (!check.ok) return check;
    }
    // Fuera de la liguilla no hay marcadores ni estados de partido.
    if (round.stage !== "liguilla") {
      for (const k of ["scores", "matchStatus", "draftScores", "draftMatchStatus"]) {
        if (round[k] != null && !(before && same(before[k], round[k]))) {
          return fail(400, "invalid_value", { field: "rounds." + k, roundNumber: round.number });
        }
      }
    }
  }
  if (locks.length) merged.liguillaLocks = locks;
  return { ok: true, lockedNow };
}

// Un guardado GENÉRICO de pronósticos (POST /api/kv/<picks>) no toca los
// pronósticos de liguilla: ésos se guardan partido a partido por
// /api/quinielas/:slug/picks/:pid/match, que compara contra lo guardado y
// nunca pisa en silencio. Si el documento trae para una jornada de liguilla
// publicada algo distinto de lo guardado (una pestaña antigua, otra sesión
// que guardó antes), se rechaza entero.
function validateLiguillaPicksWrite(meta, oldPicks, newPicks) {
  const rounds = Array.isArray(meta && meta.rounds) ? meta.rounds : [];
  const oldDoc = isObj(oldPicks) ? oldPicks : {};
  const newDoc = isObj(newPicks) ? newPicks : {};
  for (const r of rounds) {
    if (!L.isLiguillaRound(r) || !isPublished(r)) continue;
    const o = isObj(oldDoc[r.id]) ? oldDoc[r.id] : {};
    const n = isObj(newDoc[r.id]) ? newDoc[r.id] : {};
    for (const m of (Array.isArray(r.matches) ? r.matches : [])) {
      if (!same(o[m.id], n[m.id])) return { ok: false, roundId: r.id };
    }
    if (!same(o.__score, n.__score)) return { ok: false, roundId: r.id };
  }
  return { ok: true };
}

// El valor guardado de UN partido, en la forma de la captura.
function storedMatchPick(picksDoc, round, matchId) {
  const rp = isObj(picksDoc) && isObj(picksDoc[round.id]) ? picksDoc[round.id] : {};
  const rules = L.roundRules(round);
  if (rules && rules.capture === "score") {
    const s = isObj(rp.__score) ? rp.__score[matchId] : null;
    return L.isScore(s) ? { a: s.a, b: s.b } : null;
  }
  return L.OUTCOMES.includes(rp[matchId]) ? rp[matchId] : null;
}

/**
 * Un pronóstico de UN partido de liguilla. Pura: decide sobre la meta y los
 * pronósticos leídos bajo lock y la hora de Postgres.
 * Devuelve { ok:true, doc, accepted } o { ok:false, status, error, current }.
 */
function applyMatchPick({ meta, picksDoc, roundId, matchId, value, expected, nowMs }) {
  const round = (Array.isArray(meta && meta.rounds) ? meta.rounds : []).find((r) => r && r.id === roundId);
  if (!round) return fail(404, "round_not_found");
  if (!L.isLiguillaRound(round)) return fail(400, "not_liguilla");
  const rules = L.roundRules(round);
  if (!rules || !isPublished(round)) return fail(403, "round_locked");
  const match = (round.matches || []).find((m) => m && m.id === matchId);
  if (!match) return fail(404, "match_not_found");
  const current = storedMatchPick(picksDoc, round, matchId);
  const deadline = new Date(round.deadline).getTime();
  if (!Number.isFinite(deadline) || nowMs > deadline) return fail(403, "round_locked", { current });
  const norm = L.normalizePick(rules.capture, value);
  if (!norm.ok) return fail(400, norm.reason, { current });
  // Lo que el navegador cree que está guardado. Si otra sesión guardó otra
  // cosa mientras tanto, no se pisa: se devuelve lo guardado para que la
  // persona decida.
  if (!same(current, expected === undefined ? null : expected)) {
    return fail(409, "pick_conflict", { current });
  }
  const doc = isObj(picksDoc) ? JSON.parse(JSON.stringify(picksDoc)) : {};
  const rp = isObj(doc[roundId]) ? doc[roundId] : (doc[roundId] = {});
  rp[matchId] = norm.pick;
  if (rules.capture === "score") {
    rp.__score = isObj(rp.__score) ? rp.__score : {};
    rp.__score[matchId] = norm.score;
  }
  return { ok: true, doc, accepted: rules.capture === "score" ? norm.score : norm.pick };
}

module.exports = {
  LEGACY_SCOPE, lockFor, applyLiguillaWrite, checkLiguillaResults,
  validateLiguillaPicksWrite, storedMatchPick, applyMatchPick,
};
