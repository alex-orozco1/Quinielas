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
// Comparación canónica: PostgreSQL (jsonb) no conserva el orden de las
// claves, así que {a,b} y {b,a} son el mismo valor.
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
const same = (a, b) => canonical(a === undefined ? null : a) === canonical(b === undefined ? null : b);
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
// La competencia guardada, como texto comparable ("" si no hay).
function leagueKey(settings) {
  const id = isObj(settings) ? settings.sportsdbLeagueId : null;
  return typeof id === "string" || typeof id === "number" ? String(id).trim() : "";
}
// Hay liguilla en curso: candado del torneo actual o alguna jornada de
// liguilla en el tablero (publicada o borrador).
function hasLiguillaInProgress(value, scope) {
  if (!isObj(value)) return false;
  if (lockFor(value.liguillaLocks, scope)) return true;
  return (Array.isArray(value.rounds) ? value.rounds : []).some((r) => isObj(r) && r.stage === "liguilla");
}

function applyLiguillaWrite({ oldValue, merged, scopeId, nowIso }) {
  const scope = scopeId || LEGACY_SCOPE;
  const old = isObj(oldValue) ? oldValue : {};
  // El candado lo escribe sólo el servidor: la fila guardada siempre gana.
  const locks = Array.isArray(old.liguillaLocks) ? JSON.parse(JSON.stringify(old.liguillaLocks)) : [];
  delete merged.liguillaLocks;
  delete merged.liguillaLock;   // se calcula en cada lectura, nunca se guarda
  // Qué jornadas de liguilla se publicaron alguna vez, con su cierre. Lo
  // escribe sólo el servidor y sobrevive a borrar la jornada: retirarla y
  // volverla a publicar, o recrearla con el mismo id, no la reabre ni le
  // cambia el tipo (Technical QA, P1).
  const publishedRec = isObj(old.liguillaPublished) ? JSON.parse(JSON.stringify(old.liguillaPublished)) : {};
  delete merged.liguillaPublished;
  // El historial de correcciones de reglas (correctLiguillaRules) también es
  // sólo del servidor: un guardado normal no lo escribe ni lo borra.
  delete merged.liguillaRulesHistory;
  if (Array.isArray(old.liguillaRulesHistory)) merged.liguillaRulesHistory = JSON.parse(JSON.stringify(old.liguillaRulesHistory));
  const settings = isObj(merged.settings) ? merged.settings : (merged.settings = {});
  const oldSettings = isObj(old.settings) ? old.settings : {};

  // La competencia que se guarda: un id numérico de TheSportsDB como texto
  // ("4350"), o nada. Lo que no tiene esa forma no se guarda (Technical QA,
  // P3). Lo ya guardado de antes no se toca si este guardado no lo cambia.
  if (Object.prototype.hasOwnProperty.call(settings, "sportsdbLeagueId") && !same(settings.sportsdbLeagueId, oldSettings.sportsdbLeagueId)) {
    const raw = settings.sportsdbLeagueId;
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) delete settings.sportsdbLeagueId;
    else if ((typeof raw === "string" || typeof raw === "number") && /^[0-9]{3,8}$/.test(String(raw).trim())) settings.sportsdbLeagueId = String(raw).trim();
    else return fail(400, "invalid_value", { field: "settings.sportsdbLeagueId" });
  }

  // La liguilla es sólo de Liga MX. Tiene que serlo la competencia GUARDADA y
  // también la que trae este guardado: cambiar de competencia y estrenar
  // liguilla en la misma escritura no la habilita.
  const ligaMx = L.isLigaMxSettings(oldSettings) && L.isLigaMxSettings(settings);
  // Cambiar de competencia con una liguilla en curso dejaría reglas y jornadas
  // de liguilla en una quiniela que ya no es de Liga MX (o al revés). La única
  // excepción es declarar Liga MX en una quiniela que no tenía competencia:
  // no deja nada huérfano, sólo dice qué es (Technical QA, P2-2).
  if (leagueKey(oldSettings) !== leagueKey(settings) && hasLiguillaInProgress(old, scope)
      && !(leagueKey(oldSettings) === "" && L.isLigaMxSettings(settings))) {
    return fail(409, "liguilla_league_change_blocked");
  }

  let lock = lockFor(locks, scope);
  // Una pestaña abierta antes de que el propietario corrigiera la puntuación
  // todavía trae las reglas anteriores. No es un intento de cambiarlas: se
  // conservan las vigentes y el guardado sigue (sin esto, cualquier guardado
  // de esa pestaña fallaría con «reglas fijas» o, fuera de Liga MX, con
  // «sólo Liga MX»: va antes de esa comprobación, Technical QA P2-1).
  if (lock && settings.liguilla != null && !L.sameRules(settings.liguilla, oldSettings.liguilla) && Array.isArray(old.liguillaRulesHistory)
      && old.liguillaRulesHistory.some((h) => isObj(h) && h.scopeId === scope && L.sameRules(h.from, settings.liguilla))) {
    settings.liguilla = isObj(oldSettings.liguilla) ? { ...oldSettings.liguilla } : oldSettings.liguilla;
  }

  // La configuración, si viene, tiene que ser una configuración posible.
  const incomingRules = settings.liguilla;
  if (incomingRules != null && !same(incomingRules, oldSettings.liguilla)) {
    if (!ligaMx) return fail(409, "liguilla_not_available");
    const v = L.validateRules(incomingRules);
    if (!v.ok) return fail(400, v.reason);
    settings.liguilla = { ...v.rules };
  }
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
    // Fuera de Liga MX no nace ninguna jornada de liguilla (ni nueva ni
    // cambiando el tipo de una existente). Las que ya existían se conservan.
    if (!ligaMx && round.stage === "liguilla" && !(before && before.stage === "liguilla")) {
      return fail(409, "liguilla_not_available", { roundNumber: round.number });
    }
    const wasPublished = !!before && isPublished(before);
    const rec = Object.prototype.hasOwnProperty.call(publishedRec, round.id) ? publishedRec[round.id] : null;
    const nowMs = new Date(nowIso).getTime();
    if (rec || (wasPublished && before.stage === "liguilla")) {
      // Una jornada de liguilla publicada sigue siendo de liguilla y publicada.
      if (round.stage !== "liguilla") return fail(409, "liguilla_stage_locked", { roundNumber: round.number });
      if (!isPublished(round)) return fail(409, "liguilla_unpublish_blocked", { roundNumber: round.number });
      const closeMs = new Date(rec ? rec.deadline : before.deadline).getTime();
      const closed = Number.isFinite(closeMs) && closeMs <= nowMs;
      if (closed && round.deadline !== (rec ? rec.deadline : before.deadline)) {
        return fail(409, "liguilla_round_closed", { roundNumber: round.number });
      }
      // D4: nada publicado se mueve. Ningún partido sale de una jornada de
      // liguilla publicada; y después del cierre tampoco entran partidos ni
      // cambian los equipos (eso cambiaría lo que significa cada pronóstico).
      // Sin versión anterior (la jornada se borró y se recrea), manda el
      // registro: sus partidos tampoco pueden salir (Technical QA ronda 2).
      const prevMatches = new Map(((before && before.matches) || []).filter(isObj).map((m) => [m.id, m]));
      if (!before && rec && Array.isArray(rec.matchIds)) rec.matchIds.forEach((id) => prevMatches.set(id, null));
      const nextMatches = new Map((Array.isArray(round.matches) ? round.matches : []).filter(isObj).map((m) => [m.id, m]));
      for (const id of prevMatches.keys()) {
        if (!nextMatches.has(id)) return fail(409, "liguilla_matches_locked", { roundNumber: round.number });
      }
      if (closed && before) {
        if (nextMatches.size !== prevMatches.size) return fail(409, "liguilla_matches_locked", { roundNumber: round.number });
        for (const [id, m] of nextMatches) {
          const o = prevMatches.get(id);
          if (o === null) continue;   // sólo sabemos que existía (registro)
          if (!o || o.teamA !== m.teamA || o.teamB !== m.teamB) return fail(409, "liguilla_matches_locked", { roundNumber: round.number });
        }
      }
    }
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
      // Ni se publica (ni fija el candado) fuera de Liga MX.
      if (!ligaMx) return fail(409, "liguilla_not_available", { roundNumber: round.number });
      if (!lock) {
        const v = L.validateRules(settings.liguilla);
        if (!v.ok) return fail(409, "liguilla_rules_required", { roundNumber: round.number });
        lock = { scopeId: scope, lockedAt: nowIso, roundId: round.id, roundNumber: round.number, rules: { ...v.rules } };
        locks.push(lock);
        lockedNow = true;
      }
      const pending = (Array.isArray(round.matches) ? round.matches : []).filter((m) => !m || !m.teamA || !m.teamB).length;
      if (pending) return fail(409, "liguilla_rival_pending", { roundNumber: round.number, pending });
      // Recrear una jornada ya publicada conserva las reglas con que se publicó,
      // aunque el torneo en curso tenga otras (Technical QA ronda 2).
      round.scoring = rec && rec.scoring ? { ...rec.scoring } : { ...lock.rules };
    }
    // El registro del cierre de cada jornada de liguilla publicada; se
    // actualiza mientras todavía no cierra (el Admin puede ajustarlo antes).
    if (round.stage === "liguilla" && isPublished(round)) {
      const prevClose = rec ? new Date(rec.deadline).getTime() : NaN;
      const ids = (Array.isArray(round.matches) ? round.matches : []).filter(isObj).map((m) => m.id);
      const prevIds = rec && Array.isArray(rec.matchIds) ? rec.matchIds : [];
      publishedRec[round.id] = {
        deadline: !rec || !(Number.isFinite(prevClose) && prevClose <= nowMs) ? round.deadline : rec.deadline,
        matchIds: [...new Set([...prevIds, ...ids])],
        scoring: round.scoring ? { ...round.scoring } : (rec && rec.scoring) || null,
      };
      // El torneo en que se publicó por primera vez: lo usa la corrección de
      // reglas (correctLiguillaRules) para saber qué jornadas le tocan. Un
      // registro anterior a este campo no se adivina.
      if (rec && rec.scopeId) publishedRec[round.id].scopeId = rec.scopeId;
      else if (!rec) publishedRec[round.id].scopeId = scope;
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
  if (Object.keys(publishedRec).length) merged.liguillaPublished = publishedRec;
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
  // Con resultados publicados ya se jugó, aunque su cierre esté en el futuro
  // (igual que validatePicksDeadline en server.js).
  if (round.resultsPublished) return fail(403, "round_locked", { current });
  const deadline = new Date(round.deadline).getTime();
  if (!Number.isFinite(deadline) || nowMs > deadline) return fail(403, "round_locked", { current });
  const norm = L.normalizePick(rules.capture, value);
  if (!norm.ok) return fail(400, norm.reason, { current });
  // Lo mismo que ya está guardado es un éxito, no un conflicto: es el
  // reintento de un guardado cuya respuesta se perdió (Product QA, H1).
  const wanted = rules.capture === "score" ? norm.score : norm.pick;
  if (same(current, wanted)) return { ok: true, doc: picksDoc, accepted: current, unchanged: true };
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

// HOTFIX · Corregir las reglas de puntuación de liguilla DESPUÉS de publicar.
//
// Las reglas viven en cuatro sitios y los cuatro tienen que decir lo mismo:
//   settings.liguilla                 la configuración
//   liguillaLocks[ciclo].rules        el candado del torneo en curso
//   round.scoring                     la copia de cada jornada de liguilla
//                                     publicada: CON ESTA se califica
//   liguillaPublished[id].scoring     el registro, para recrear una jornada
// Esta función cambia los cuatro en una sola copia del documento (el servidor
// la guarda en la misma transacción, con la fila bloqueada), y sólo para el
// torneo en curso: una jornada de un torneo anterior que siga en el tablero
// conserva sus reglas.
//
// No toca pronósticos, resultados, marcadores, estados de partido, fase
// regular, preguntas ni penalizaciones. No cambia el formato de captura: con
// bono por exacto se escribe el marcador y sin él se elige 1X2, así que pasar
// de uno a otro con una jornada ya publicada se rechaza.
//
// `expected`: las reglas que vio quien corrige; si ya no son las vigentes
// (otra pestaña corrigió antes), se rechaza sin cambiar nada.
// `scopeRoundIds`: los ids de las jornadas publicadas en el torneo en curso
// (platform_index), o null cuando no hay ciclos (quiniela sin registro).
function correctLiguillaRules({ value, scopeId, scopeRoundIds, expected, next, actor, nowIso }) {
  const scope = scopeId || LEGACY_SCOPE;
  if (!isObj(value)) return fail(404, "not_found");
  if (!L.isLigaMxSettings(value.settings)) return fail(409, "liguilla_not_available");
  const locks = Array.isArray(value.liguillaLocks) ? value.liguillaLocks : [];
  const lock = lockFor(locks, scope);
  if (!lock) return fail(409, "liguilla_not_locked");
  const current = L.validateRules(lock.rules);
  if (!current.ok) return fail(409, "liguilla_rules_invalid");
  const exp = L.validateRules(expected);
  if (!exp.ok || !L.sameRules(exp.rules, current.rules)) {
    return fail(409, "liguilla_rules_changed", { current: { ...current.rules } });
  }
  const v = L.validateRules(next);
  if (!v.ok) return fail(400, v.reason);
  if (v.rules.capture !== current.rules.capture) {
    return fail(409, "liguilla_capture_change_blocked", { capture: current.rules.capture });
  }
  if (L.sameRules(v.rules, current.rules)) return fail(400, "liguilla_rules_unchanged");

  const doc = JSON.parse(JSON.stringify(value));
  const newRules = { ...v.rules };
  const recs = isObj(doc.liguillaPublished) ? doc.liguillaPublished : {};
  // Qué jornadas son de este torneo: primero el torneo en que el servidor
  // registró su publicación; sin ese dato (registros anteriores), el registro
  // de consumo del torneo. La jornada que fijó el candado siempre cuenta.
  const inScope = (id) => {
    const r = recs[id];
    if (isObj(r) && typeof r.scopeId === "string") return r.scopeId === scope;
    if (lock.roundId != null && String(lock.roundId) === String(id)) return true;
    return !scopeRoundIds || scopeRoundIds.has(String(id));
  };
  const changedRounds = [];
  for (const r of Array.isArray(doc.rounds) ? doc.rounds : []) {
    if (!isObj(r) || r.stage !== "liguilla" || !isPublished(r) || !r.scoring) continue;
    if (!inScope(r.id) || !L.sameRules(r.scoring, current.rules)) continue;
    r.scoring = { ...newRules };
    changedRounds.push(r.id);
  }
  Object.keys(recs).forEach((id) => {
    const e = recs[id];
    if (isObj(e) && e.scoring && inScope(id) && L.sameRules(e.scoring, current.rules)) e.scoring = { ...newRules };
  });
  const docLock = lockFor(doc.liguillaLocks, scope);
  docLock.rules = { ...newRules };
  doc.settings = isObj(doc.settings) ? doc.settings : {};
  doc.settings.liguilla = { ...newRules };
  const entry = {
    at: nowIso, scopeId: scope,
    by: actor && actor.participantId ? { participantId: String(actor.participantId), via: "admin_password" } : { via: "admin_password" },
    from: { ...current.rules }, to: { ...newRules }, rounds: changedRounds.map(String),
  };
  doc.liguillaRulesHistory = [...(Array.isArray(doc.liguillaRulesHistory) ? doc.liguillaRulesHistory : []), entry].slice(-50);
  delete doc.liguillaLock;
  return { ok: true, value: doc, entry };
}

module.exports = {
  LEGACY_SCOPE, lockFor, canonical, applyLiguillaWrite, checkLiguillaResults, correctLiguillaRules,
  validateLiguillaPicksWrite, storedMatchPick, applyMatchPick,
};
