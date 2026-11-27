// standings.js — la Tabla de QRACKS, en UN solo sitio.
//
// Lo usan el navegador (Tabla, Jugados, Historial, desglose, gráfica) y el
// servidor (que recalcula la tabla final o «al interrumpir» antes de archivarla
// y borrar los pronósticos: P1 · torneo nuevo, Technical QA P2). El servidor lo
// sirve tal cual en /standings.js, así que no pueden existir dos fórmulas.
//
// Es la MISMA cuenta que tenía public/index.html, movida sin cambiar reglas:
//   - partidos: sólo jornadas con resultados publicados; regular = aciertos ×
//     puntos por acierto; liguilla = base + bono con las reglas de ESA jornada
//     (liguillaScoring.scoreRound);
//   - preguntas extra: de torneo (temporada) cuando hay acierto marcado; de
//     jornada en jornadas publicadas con acierto marcado;
//   - descuentos por no pagar: registro permanente (penalizedRounds) + en vivo
//     para jornadas publicadas, cerradas, desde la de inicio, nunca resueltas.
//
// Puro: sin I/O ni reloj propio (la hora llega como nowMs), sin mutar entradas.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QracksStandings = api;
})(typeof self !== "undefined" ? self : this, function () {
  const arr = (v) => (Array.isArray(v) ? v : []);

  function isLiguilla(L, r) { return !!(L && r && r.stage === "liguilla"); }

  // Puntos por PARTIDOS de una jornada (sin preguntas ni descuentos).
  function roundMatchScore(meta, r, roundPicks, L) {
    const lg = isLiguilla(L, r);
    if (!r.resultsPublished) return { pts: 0, played: 0, hits: 0, exact: 0, base: 0, bonus: 0, lg, scored: false };
    if (lg) {
      const sr = L.scoreRound(r, roundPicks);
      return { pts: sr.total, played: sr.scored, hits: sr.resultHits, exact: sr.exactHits, base: sr.base, bonus: sr.bonus, lg, scored: true };
    }
    const perPick = (meta.settings && meta.settings.pointsPerCorrectPick != null) ? meta.settings.pointsPerCorrectPick : 1;
    let pts = 0, played = 0, hits = 0;
    arr(r.matches).forEach((m) => {
      const result = r.results ? r.results[m.id] : null;
      if (!result) return;
      played++;
      const pick = roundPicks ? roundPicks[m.id] : null;
      if (pick && pick === result) { pts += perPick; hits++; }
    });
    return { pts, played, hits, exact: 0, base: pts, bonus: 0, lg, scored: true };
  }

  function findParticipant(meta, participantId, participantMap) {
    return participantMap ? participantMap.get(participantId) : arr(meta.participants).find((x) => x.id === participantId);
  }

  function customBetParts(meta, participantId, participantMap, cutoffRoundNumber) {
    const parts = { byRound: Object.create(null), temporada: 0, total: 0 };
    if (!meta.customBets || !meta.customBets.length) return parts;
    const p = findParticipant(meta, participantId, participantMap);
    if (!p) return parts;
    // Las de torneo no tienen jornada: sólo cuentan «hoy» (sin corte) o en el
    // punto de la última jornada jugada, nunca hacia atrás.
    const latestPlayedRoundNumber = Math.max(0, ...arr(meta.rounds).filter((r) => r.resultsPublished).map((r) => r.number));
    const includeTemporadaBets = cutoffRoundNumber == null || cutoffRoundNumber >= latestPlayedRoundNumber;
    meta.customBets.forEach((bet) => {
      if (bet.scope === "temporada") {
        if (!includeTemporadaBets) return;
        const ans = p.customBetAnswers && p.customBetAnswers[bet.id];
        if (ans && ans.correct === true) { parts.temporada += bet.points; parts.total += bet.points; }
      } else if (bet.scope === "jornada") {
        arr(meta.rounds).forEach((r) => {
          // Una jornada sin publicar nunca suma (AUTO-001 HOTFIX).
          if (r.published === false) return;
          if (cutoffRoundNumber != null && r.number > cutoffRoundNumber) return;
          const res = r.customBetResults && r.customBetResults[bet.id];
          if (res && res[participantId] === true) {
            parts.byRound[r.id] = (parts.byRound[r.id] || 0) + bet.points;
            parts.total += bet.points;
          }
        });
      }
    });
    return parts;
  }

  // MS2: sólo una jornada PUBLICADA puede costar puntos.
  function isRoundEligibleForPenalty(round, penalty, nowMs) {
    const locked = !round || nowMs > new Date(round.deadline).getTime();
    return round.published !== false && round.number >= penalty.startsAtRound && locked;
  }

  function penaltyParts(meta, p, cutoffRoundNumber, nowMs) {
    const parts = { byRound: Object.create(null), deleted: 0, total: 0 };
    const penalty = meta.paymentPenalty;
    if (!penalty || !penalty.enabled || !penalty.startsAtRound || !p) return parts;
    const perRound = penalty.pointsPerRound != null ? penalty.pointsPerRound : 1;
    const ledger = p.penalizedRounds || {};
    const add = (roundId, n) => { parts.byRound[roundId] = (parts.byRound[roundId] || 0) + n; parts.total += n; };
    // Lo resuelto en el registro cuenta siempre tal como se resolvió.
    arr(meta.rounds).forEach((r) => {
      if (cutoffRoundNumber != null && r.number > cutoffRoundNumber) return;
      if (r.id in ledger) add(r.id, ledger[r.id]);
    });
    // Una jornada borrada después de resolverse sigue contando, salvo la de un
    // torneo ya archivado (AUD-03).
    if (cutoffRoundNumber == null) {
      const archived = new Set();
      arr(meta.pastTournaments).forEach((t) => arr(t && t.rounds).forEach((r) => { if (r && r.id != null) archived.add(String(r.id)); }));
      Object.keys(ledger).forEach((roundId) => {
        if (archived.has(String(roundId))) return;
        if (!arr(meta.rounds).some((r) => r.id === roundId)) { parts.deleted += ledger[roundId]; parts.total += ledger[roundId]; }
      });
    }
    // En vivo: sólo jornadas nunca resueltas, y sólo mientras no ha pagado.
    if (!p.paid) {
      arr(meta.rounds).forEach((r) => {
        if (cutoffRoundNumber != null && r.number > cutoffRoundNumber) return;
        if (isRoundEligibleForPenalty(r, penalty, nowMs) && !(r.id in ledger)) add(r.id, perRound);
      });
    }
    return parts;
  }

  // picks = los pronósticos de ESA persona ({ [roundId]: {...} }).
  function pointsFor(meta, picks, participantId, participantMap, cutoffRoundNumber, nowMs, L) {
    const own = picks || {};
    let pts = 0, played = 0;
    arr(meta.rounds).forEach((r) => {
      if (!r.resultsPublished) return;
      if (cutoffRoundNumber != null && r.number > cutoffRoundNumber) return;
      const sm = roundMatchScore(meta, r, own[r.id], L);
      pts += sm.pts; played += sm.played;
    });
    const p = findParticipant(meta, participantId, participantMap);
    pts += customBetParts(meta, participantId, participantMap, cutoffRoundNumber).total;
    pts -= penaltyParts(meta, p, cutoffRoundNumber, nowMs).total;
    return { pts, played };
  }

  // La tabla de hoy: cada participante con sus puntos y su descuento, ordenada
  // de más a menos (estable: los empates conservan el orden de participantes).
  // picksByParticipant = { [participantId]: picks }.
  function standingsList(meta, picksByParticipant, nowMs, L) {
    const participants = arr(meta.participants);
    const participantMap = new Map(participants.map((p) => [p.id, p]));
    const all = picksByParticipant || {};
    return participants.map((p) => {
      const { pts } = pointsFor(meta, all[p.id] || {}, p.id, participantMap, null, nowMs, L);
      return { ...p, pts, penalty: penaltyParts(meta, participantMap.get(p.id), null, nowMs).total };
    }).sort((a, b) => b.pts - a.pts);
  }

  return Object.freeze({ roundMatchScore, customBetParts, penaltyParts, isRoundEligibleForPenalty, pointsFor, standingsList });
});
