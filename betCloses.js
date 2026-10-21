// betCloses.js — MS2 · D4: cada pregunta de torneo con su propio cierre, del
// servidor.
//
// EL PROBLEMA (seis caminos, todos reproducidos con la API real)
// --------------------------------------------------------------
// Una pregunta de torneo («una vez por torneo») cerraba con «la jornada número
// N», buscada por número cada vez. Por eso se reabría sola: al borrar esa
// jornada (A), al renumerarla (B), al mover su cierre más tarde (C), al cambiarle
// el número de jornada a una pregunta ya cerrada (D), al cerrar el torneo, que
// vacía las jornadas (E), y al publicarse la J1 del torneo siguiente (F).
//
// LA REGLA
// --------
// - La pregunta guarda SU cierre (`closesAt`), y el vínculo con su jornada va
//   por id (`closesRoundId`), no por número. Los pone el servidor; lo que mande
//   una petición en esos campos no cuenta.
// - Una pregunta cerrada no se reabre: ni su cierre, ni su jornada, ni su tipo
//   cambian (409 bet_close_locked). No hay reapertura deliberada en MS2.
// - Antes de vencer, su cierre sólo cambia de forma explícita: ligándola a otra
//   jornada abierta, o pidiendo que siga la hora nueva de SU jornada al editarla
//   (la pantalla pregunta; el servidor sólo acepta esa hora exacta). Editar una
//   jornada nunca mueve, por sí solo, el cierre de una pregunta.
// - Una pregunta que se quita, o que se archiva al cerrar el torneo, no vuelve
//   con el mismo id (409 bet_retired): su identidad no se recicla.
// - Las preguntas de jornada no llevan reloj propio: cierran con cada jornada,
//   como los pronósticos de partidos.
//
// LO ANTIGUO
// ----------
// Las preguntas guardadas antes de D4 no tienen `closesAt`. Sin migrar, su
// cierre se sigue leyendo por número, pero ninguna escritura lo cambia sin
// pedirlo: una cerrada no se reabre (409 bet_close_locked) y una abierta no
// cambia de cierre porque se borre, renumere o mueva su jornada (409
// bet_close_legacy); para eso se liga por id o se fija el cierre que tiene hoy.
// La migración (betCloseMigration.js) les da su estado con evidencia, y sin
// evidencia las cierra por protección. Las que nunca tuvieron cierre siguen
// «Sin cierre» en el torneo activo (`closeSource: "none"`) y se cierran y
// archivan al terminarlo.

const { readTournamentEpoch } = require("./metaParticipants");
const { canonical } = require("./roundsConcurrency");

const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const isBet = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Los campos que sólo escribe el servidor.
//   closesAt       ISO: el cierre propio de la pregunta.
//   closesRoundId  la jornada con la que se ligó (por id).
//   closeSource    de dónde salió su cierre: "round" (su jornada, al ligarla o al
//                  moverlo de forma explícita), "tournament_end" (al cerrar el
//                  torneo), "migration_round" (la migración lo recuperó con
//                  evidencia), "migration_cutoff" (la migración la cerró por
//                  protección; la fecha es el corte, no una fecha histórica),
//                  "none" (antigua, nunca tuvo cierre: «Sin cierre»).
//   closeFlag      con migration_cutoff: "lost_link" | "ambiguous". Con
//                  tournament_end: "closed_by_round" si una antigua sin cierre
//                  propio ya había cerrado antes por su jornada (la fecha
//                  registrada es la del fin del torneo, no una inventada).
//   epoch          el torneo (tournamentEpoch) en que se creó. Sin evidencia,
//                  no se pone.
const SERVER_BET_FIELDS = Object.freeze(["closesAt", "closesRoundId", "closeSource", "closeFlag", "epoch"]);
// Los ids retirados (quitados) que se recuerdan, para que no vuelvan.
const MAX_RETIRED_BET_IDS = 2000;

function instantMs(v) {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}
function sameInstant(a, b) {
  const x = instantMs(a), y = instantMs(b);
  return x !== null && x === y;
}
function roundByNumber(rounds, n) {
  if (!Number.isInteger(n) || n < 1) return null;
  const found = list(rounds).filter((r) => r && r.number === n);
  return found.length ? found[0] : null;
}

// Pure. El estado de cierre de una pregunta a la hora `nowMs`.
//   kind: "jornada" (sin reloj propio), "own" (con closesAt), "none" (antigua,
//   sin cierre) o "legacy" (antigua, sin migrar: por número, como antes).
// La jornada no cambió de cierre: el mismo instante, o el mismo valor guardado
// tal cual aunque no sea una fecha (null, «pendiente»). Sin lo segundo, una
// jornada con un cierre ilegible contaba como «cambiada» en cada guardado,
// aunque nadie la tocara (Technical QA sobre d4af509).
function sameStoredDeadline(a, b) {
  return a === b || sameInstant(String(a), String(b));
}
function betCloseState(bet, rounds, nowMs) {
  const b = obj(bet);
  if (b.scope !== "temporada") return { kind: "jornada", closed: false };
  const own = instantMs(b.closesAt);
  if (own !== null) return { kind: "own", closed: own <= nowMs, closesAtMs: own };
  if (b.closeSource === "none" || !Number.isInteger(b.closesAtRound) || b.closesAtRound < 1) {
    return { kind: "none", closed: false };
  }
  const r = list(rounds).find((x) => x && x.number === b.closesAtRound);
  if (!r) return { kind: "legacy", closed: false, roundFound: false };
  const ms = new Date(r.deadline).getTime();
  return { kind: "legacy", closed: Number.isFinite(ms) && ms <= nowMs, roundFound: true };
}

// Los ids que ya no pueden volver: quitados antes, archivados en un torneo
// anterior, o con respuestas guardadas de alguna pregunta que ya no está.
function retiredBetIds(stored) {
  const prev = obj(stored);
  const ids = new Set(list(prev.retiredBetIds).filter((x) => typeof x === "string" || typeof x === "number"));
  for (const t of list(prev.pastTournaments)) {
    for (const b of list(obj(t).customBets)) if (isBet(b) && b.id != null) ids.add(b.id);
  }
  for (const p of list(prev.participants)) {
    for (const id of Object.keys(obj(obj(p).customBetAnswers))) ids.add(id);
  }
  return ids;
}

// Un cliente que no conoce estos campos (o una pantalla que rehace la pregunta
// con sus campos de siempre) los omite. Omitirlos no es borrarlos: se rellenan
// con lo guardado, antes de comparar (betsConcurrency) y de resolver. Un valor
// distinto, en cambio, sí es una petición, y se juzga en resolveBetCloses.
function withStoredBetFields(stored, incoming) {
  const doc = obj(incoming);
  if (!Array.isArray(doc.customBets)) return incoming;
  const before = new Map();
  for (const b of list(obj(stored).customBets)) if (isBet(b) && !before.has(b.id)) before.set(b.id, b);
  const customBets = doc.customBets.map((b) => {
    if (!isBet(b) || !before.has(b.id)) return b;
    const old = before.get(b.id);
    const out = { ...b };
    for (const f of SERVER_BET_FIELDS) if (!has(out, f) && has(old, f)) out[f] = old[f];
    return out;
  });
  return { ...doc, customBets };
}

function stampFromRound(bet, round) {
  bet.closesAt = new Date(instantMs(String(round.deadline))).toISOString();
  bet.closesRoundId = round.id;
  bet.closesAtRound = round.number;
  bet.closeSource = "round";
  delete bet.closeFlag;
}

// La jornada con la que una petición quiere ligar una pregunta: por id si lo
// pidió (`closesRoundId`), si no por número. Tiene que existir en este guardado
// y no haber cerrado; si no, el mismo error que validateBetClosures.
function linkTarget(rounds, raw, wantedId, now) {
  const r = wantedId !== undefined
    ? list(rounds).find((x) => x && x.id === wantedId) || null
    : roundByNumber(rounds, raw.closesAtRound);
  if (!r) return { error: "bet_close_required" };
  const ms = instantMs(String(r.deadline));
  if (ms === null || ms <= now) return { error: "bet_close_past" };
  return { round: r };
}

// El número de jornada del «goleador» de antes, normalizado como lo muda el
// cliente (ensureCustomBets): número, texto numérico o nada.
function legacyRoundNumber(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? v
    : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  return n || null;
}

// MS2 · D4-01. El «goleador» de antes (golScorerBet) es un dato antiguo del
// servidor: su cierre y su estado son los guardados. Ninguna escritura lo
// cambia, lo enciende, lo apaga ni lo crea (omitirlo conserva el guardado), así
// que no se le puede mover el cierre antes de mudarlo. Devuelve el que debe
// guardarse, o el rechazo.
function resolveLegacyScorer(prev, next) {
  const has0 = has(prev, "golScorerBet");
  if (!has(next, "golScorerBet")) return { ok: true, keep: has0, value: prev.golScorerBet };
  if (canonical(next.golScorerBet === undefined ? null : next.golScorerBet) !== canonical(has0 ? prev.golScorerBet : null)) {
    return fail(409, "bet_close_locked", "golScorerBet");
  }
  return { ok: true, keep: has0, value: prev.golScorerBet };
}

function fail(status, error, betId) {
  return { ok: false, status, error, betId };
}

// Pure. Aplica la regla a las preguntas de un guardado de meta.
//   stored: la fila leída bajo candado; merged: lo que se va a guardar, con el
//   tablero (rounds) ya resuelto; legacyId: la pregunta que es la mudanza del
//   «goleador» antiguo en este guardado, o null.
// Devuelve { ok: true, customBets, retiredBetIds } o
//          { ok: false, status, error, betId } (no se escribe nada).
function resolveBetCloses({ stored, merged, nowMs, legacyId = null } = {}) {
  const prev = obj(stored);
  const next = obj(merged);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const scorer = resolveLegacyScorer(prev, next);
  if (!scorer.ok) return scorer;
  if (!Array.isArray(next.customBets)) {
    return { ok: true, customBets: next.customBets, retiredBetIds: list(prev.retiredBetIds).slice(), legacyScorer: scorer };
  }
  const storedBets = new Map();
  for (const b of list(prev.customBets)) if (isBet(b) && !storedBets.has(b.id)) storedBets.set(b.id, b);
  const retired = retiredBetIds(prev);
  const rounds = list(next.rounds);
  const storedRounds = list(prev.rounds);
  const epoch = readTournamentEpoch(prev);
  const out = [];
  for (const raw of next.customBets) {
    if (!isBet(raw)) { out.push(raw); continue; }
    const bet = { ...raw };
    const before = storedBets.get(bet.id);

    if (!before) {
      if (retired.has(bet.id)) return fail(409, "bet_retired", bet.id);
      for (const f of SERVER_BET_FIELDS) delete bet[f];
      if (bet.scope === "temporada" && legacyId !== null && bet.id === legacyId) {
        // La mudanza del «goleador» antiguo: datos viejos, sin evidencia de a qué
        // torneo pertenecen. Sin migración, se quedan como estaban (por número).
        // En una quiniela ya migrada, llegan tarde a ella y reciben su misma
        // regla, con el corte en este momento (betCloseMigration.js).
        // D4-01: se muda con el cierre que guarda el servidor, nunca con el que
        // proponga la petición; y la mudanza no puede dejar abierta una que
        // estaba cerrada ni mover en silencio el cierre de una abierta.
        const trusted = legacyRoundNumber(obj(prev.golScorerBet).closesAtRound);
        if (legacyRoundNumber(bet.closesAtRound) !== trusted) return fail(409, "bet_close_locked", bet.id);
        const pseudo = { scope: "temporada", closesAtRound: trusted };
        const was = betCloseState(pseudo, storedRounds, now);
        if (was.kind === "legacy") {
          // La mudanza no viene junto con un cambio de su propia jornada.
          const sr = roundByNumber(storedRounds, trusted);
          const nr = roundByNumber(rounds, trusted);
          if (sr && (!nr || nr.id !== sr.id || !sameStoredDeadline(nr.deadline, sr.deadline))) {
            return fail(409, was.closed ? "bet_close_locked" : "bet_close_legacy", bet.id);
          }
        }
        bet.closesAtRound = trusted;
        if (obj(prev.betCloseMigration).version >= 1) {
          const { classifyLegacyBet } = require("./betCloseMigration");
          const c = classifyLegacyBet(bet, { ...prev, rounds });
          // pending_round: se queda por número, como en la migración.
          if (c.category === "no_close") bet.closeSource = "none";
          else if (c.category === "linked") {
            bet.closesAt = new Date(instantMs(String(c.round.deadline))).toISOString();
            bet.closesRoundId = c.round.id;
            bet.closeSource = "migration_round";
          } else if (c.category === "lost_link" || c.category === "ambiguous") {
            bet.closesAt = new Date(now).toISOString();
            bet.closeSource = "migration_cutoff";
            bet.closeFlag = c.category;
          }
        }
        if (was.closed && !betCloseState(bet, rounds, now).closed) return fail(409, "bet_close_locked", bet.id);
        out.push(bet);
        continue;
      }
      bet.epoch = epoch;
      if (bet.scope === "temporada") {
        // Nace con el cierre de su jornada en este mismo guardado, que existe y
        // no ha cerrado. Nunca sin cierre.
        const t = linkTarget(rounds, raw, has(raw, "closesRoundId") ? raw.closesRoundId : undefined, now);
        if (t.error) return fail(400, t.error, bet.id);
        stampFromRound(bet, t.round);
      }
      out.push(bet);
      continue;
    }

    // Ya existía: sus campos del servidor son los guardados, diga lo que diga la
    // petición. Lo que pidió en closesAt se juzga abajo.
    const claimedAt = has(raw, "closesAt") ? raw.closesAt : undefined;
    const claimedRoundId = has(raw, "closesRoundId") ? raw.closesRoundId : undefined;
    for (const f of SERVER_BET_FIELDS) {
      delete bet[f];
      if (has(before, f)) bet[f] = JSON.parse(JSON.stringify(before[f]));
    }
    const was = betCloseState(before, storedRounds, now);
    const scopeChanged = bet.scope !== before.scope;
    const roundChanged = (bet.closesAtRound ?? null) !== (before.closesAtRound ?? null);
    const atChanged = claimedAt !== undefined && !(claimedAt === before.closesAt || sameInstant(claimedAt, before.closesAt));
    const relinkById = claimedRoundId !== undefined && claimedRoundId !== (has(before, "closesRoundId") ? before.closesRoundId : undefined);

    if (was.closed) {
      // Antigua sin migrar ya cerrada por su jornada: puede guardar, de forma
      // explícita, el cierre que ya tiene (la hora guardada de esa jornada,
      // la que el servidor le aplica hoy); así su jornada se puede editar o
      // borrar sin reabrirla. Nunca otra hora.
      if (was.kind === "legacy" && atChanged && !scopeChanged && !roundChanged && !relinkById) {
        const sr = roundByNumber(storedRounds, before.closesAtRound);
        if (!sr || !sameInstant(claimedAt, String(sr.deadline))) return fail(409, "bet_close_locked", bet.id);
        bet.closesAt = new Date(instantMs(String(sr.deadline))).toISOString();
        bet.closesRoundId = sr.id;
        bet.closeSource = "round";
        delete bet.closeFlag;
        out.push(bet);
        continue;
      }
      // Cerrada: nada de lo que decide si se puede responder cambia. Y ningún
      // cambio del tablero la deja abierta: eso sólo le puede pasar a una
      // pregunta antigua sin migrar, que todavía se lee por número (borrar,
      // renumerar o mover su jornada). Se rechaza sin escribir nada.
      if (scopeChanged || roundChanged || atChanged || relinkById) return fail(409, "bet_close_locked", bet.id);
      if (!betCloseState(bet, rounds, now).closed) return fail(409, "bet_close_locked", bet.id);
      out.push(bet);
      continue;
    }
    if (bet.scope !== "temporada") {
      // De jornada (o pasa a serlo estando abierta): cierra con cada jornada.
      delete bet.closesAt; delete bet.closesRoundId; delete bet.closeSource; delete bet.closeFlag;
      out.push(bet);
      continue;
    }
    if (scopeChanged || roundChanged || relinkById) {
      // Un vínculo nuevo, pedido de forma explícita: con una jornada de este
      // guardado que existe y sigue abierta (por id si lo pidió así).
      const t = linkTarget(rounds, raw, relinkById ? claimedRoundId : undefined, now);
      if (t.error) return fail(400, t.error, bet.id);
      delete bet.closeFlag;
      stampFromRound(bet, t.round);
      out.push(bet);
      continue;
    }
    if (was.kind === "legacy") {
      // Antigua sin migrar y abierta: su cierre es el de la jornada con su
      // número. Que cambie sin pedirlo (borrar, renumerar o mover esa jornada,
      // u otra que tome su número) sería cambiarlo en silencio: 409. Lo
      // explícito se acepta: ligarla por id (arriba) o fijar el cierre que
      // tiene hoy, que pasa a ser suyo (`closesAt` = la hora guardada de esa
      // jornada, ligada a ella por id).
      const sr = roundByNumber(storedRounds, before.closesAtRound);
      if (atChanged) {
        if (!sr || !sameInstant(claimedAt, String(sr.deadline)) || instantMs(String(sr.deadline)) <= now) return fail(400, "bet_close_invalid", bet.id);
        bet.closesAt = new Date(instantMs(String(sr.deadline))).toISOString();
        bet.closesRoundId = sr.id;
        bet.closeSource = "round";
        delete bet.closeFlag;
        out.push(bet);
        continue;
      }
      if (sr) {
        const nr = roundByNumber(rounds, before.closesAtRound);
        if (!nr || nr.id !== sr.id || !sameStoredDeadline(nr.deadline, sr.deadline)) return fail(409, "bet_close_legacy", bet.id);
      }
      out.push(bet);
      continue;
    }
    if (atChanged) {
      // Mover el cierre de una pregunta abierta: sólo a la hora actual de SU
      // jornada (la que se acaba de editar o reabrir), nunca a otra hora.
      const r = before.closesRoundId != null ? rounds.find((x) => x && x.id === before.closesRoundId) : null;
      if (!r || !sameInstant(claimedAt, String(r.deadline))) return fail(400, "bet_close_invalid", bet.id);
      stampFromRound(bet, r);
      out.push(bet);
      continue;
    }
    out.push(bet);
  }
  // Las que se quitaron en este guardado no vuelven con el mismo id.
  const kept = new Set(out.filter(isBet).map((b) => b.id));
  const removed = [...storedBets.keys()].filter((id) => !kept.has(id));
  let retiredList = list(prev.retiredBetIds).filter((x) => typeof x === "string" || typeof x === "number");
  for (const id of removed) if (!retiredList.includes(id)) retiredList.push(id);
  if (retiredList.length > MAX_RETIRED_BET_IDS) retiredList = retiredList.slice(-MAX_RETIRED_BET_IDS);
  return { ok: true, customBets: out, retiredBetIds: retiredList, legacyScorer: scorer };
}

// Pure. Al cerrar el torneo: las preguntas de torneo que siguen abiertas se
// cierran a esa hora (archivar no sustituye cerrar), y todas, de los dos tipos,
// pasan al archivo con sus definiciones, respuestas y aciertos. El torneo nuevo
// empieza sin preguntas: si se reutiliza una plantilla, es una pregunta nueva,
// con otro id, sin respuestas ni aciertos.
//   Devuelve { customBets, betAnswers, legacyScorer } para la entrada del
//   archivo; `meta` (copia de trabajo) queda sin preguntas ni sus respuestas.
function archiveBetsForClose(meta, nowIso, nowMs) {
  const m = meta;
  const rounds = list(m.rounds);
  const bets = list(m.customBets).filter(isBet);
  const archived = bets.map((b) => {
    const c = JSON.parse(JSON.stringify(b));
    if (c.scope !== "temporada") return c;
    const st = betCloseState(b, rounds, nowMs);
    // Con cierre propio ya vencido, se archiva tal cual. Cualquier otra queda
    // cerrada ahora, con esa hora: abierta, «Sin cierre», o antigua sin cierre
    // propio (si ya había cerrado por su jornada, se dice, sin inventar cuándo).
    if (st.kind === "own" && st.closed) return c;
    c.closesAt = nowIso;
    c.closeSource = "tournament_end";
    if (st.kind === "legacy" && st.closed) c.closeFlag = "closed_by_round";
    else delete c.closeFlag;
    return c;
  });
  const ids = new Set(archived.map((b) => b.id));
  const betAnswers = {};
  for (const p of list(m.participants)) {
    if (!isBet(p) || !isBet(p.customBetAnswers)) continue;
    const mine = {};
    for (const id of Object.keys(p.customBetAnswers)) {
      if (!ids.has(id)) continue;
      mine[id] = JSON.parse(JSON.stringify(p.customBetAnswers[id]));
      delete p.customBetAnswers[id];
    }
    if (Object.keys(mine).length) betAnswers[p.id] = mine;
  }
  // El «goleador» de antes de las preguntas, si nunca se mudó: se archiva tal
  // cual con sus respuestas y ya no se muda al torneo nuevo.
  let legacyScorer = null;
  const gsb = obj(m.golScorerBet);
  if (!m.customBetsMigrated && gsb.enabled) {
    const answers = {};
    for (const p of list(m.participants)) {
      if (isBet(p) && p.golScorerGuess) answers[p.id] = { guess: p.golScorerGuess, correct: p.golScorerCorrect === true };
      // La respuesta pasa al archivo; ya no vive en el participante.
      if (isBet(p)) delete p.golScorerGuess;
    }
    legacyScorer = { definition: JSON.parse(JSON.stringify(gsb)), answers, closedAt: nowIso };
  }
  m.customBetsMigrated = true;
  m.customBets = [];
  return { customBets: archived, betAnswers, legacyScorer };
}

module.exports = {
  SERVER_BET_FIELDS,
  MAX_RETIRED_BET_IDS,
  instantMs,
  sameInstant,
  sameStoredDeadline,
  betCloseState,
  retiredBetIds,
  withStoredBetFields,
  resolveBetCloses,
  resolveLegacyScorer,
  archiveBetsForClose,
};
