// liguillaScoring.js — reglas y puntos de la liguilla, en UN solo sitio.
//
// Lo usan el servidor (validación de reglas, pronósticos y resultados) y el
// navegador (Jornada, Jugados, Tabla, Historial). El servidor lo sirve tal cual
// en /liguillaScoring.js, así que no puede haber dos copias que se separen.
//
// Reglas aprobadas (sprint de liguilla, D1–D7):
//   - Captura «result» (1X2) o «score» (marcador exacto). Con marcador, el 1X2
//     sale de los goles; nunca se pide aparte.
//   - Puntos por resultado y bono por exacto, configurables y SUMADOS. Un empate
//     acertado es acierto de resultado. Con captura 1X2 no hay bono.
//   - Goles: enteros de 0 a 30, igual en interfaz y servidor.
//   - Estados de partido: con resultado, pendiente, aplazado, anulado. Sólo un
//     partido con resultado se califica. Pendiente y aplazado esperan; anulado
//     da 0 a todos y no cuenta como acierto ni como fallo.
//
// Puro: sin I/O, sin reloj, sin mutar entradas. Los puntos SIEMPRE se calculan
// desde pronósticos y resultados; nunca se acumulan en un contador, que es lo
// que impide el doble conteo al corregir un estado.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QracksLiguilla = api;
})(typeof self !== "undefined" ? self : this, function () {
  const GOALS_MIN = 0;
  const GOALS_MAX = 30;
  const POINTS_MAX = 99;
  const CAPTURES = Object.freeze(["result", "score"]);
  const OUTCOMES = Object.freeze(["A", "D", "B"]);
  // Estados explícitos de un partido sin resultado. «Con resultado» es la
  // ausencia de estado más un resultado válido.
  const MATCH_STATUS = Object.freeze({ PENDING: "pending", POSTPONED: "postponed", VOID: "void" });
  const STATUSES = Object.freeze([MATCH_STATUS.PENDING, MATCH_STATUS.POSTPONED, MATCH_STATUS.VOID]);
  const PHASE_ROUNDS = Object.freeze(["quarter", "semi", "final"]);
  const PHASE_LEGS = Object.freeze(["ida", "vuelta", "unico"]);
  const PHASE_SOURCES = Object.freeze(["provider", "admin"]);

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  // Un número de goles es un entero de 0 a 30 y nada más: "2", 2.5, -1, NaN o
  // true no son goles.
  function isGoals(v) {
    return typeof v === "number" && Number.isInteger(v) && v >= GOALS_MIN && v <= GOALS_MAX;
  }
  // Un marcador son los dos lados. Uno solo no es un marcador.
  function isScore(s) {
    return isObj(s) && isGoals(s.a) && isGoals(s.b) && Object.keys(s).every((k) => k === "a" || k === "b");
  }
  // a = goles de teamA, b = goles de teamB (el orden del tablero, no local/visitante).
  function outcomeOfScore(s) {
    if (!isScore(s)) return null;
    if (s.a === s.b) return "D";
    return s.a > s.b ? "A" : "B";
  }
  function isPoints(v) {
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= POINTS_MAX;
  }

  // Valida la configuración de liguilla. Devuelve { ok, rules } con la forma
  // normalizada, o { ok:false, reason }.
  function validateRules(r) {
    if (!isObj(r)) return { ok: false, reason: "liguilla_rules_invalid" };
    if (!CAPTURES.includes(r.capture)) return { ok: false, reason: "liguilla_rules_invalid" };
    if (!isPoints(r.resultPoints)) return { ok: false, reason: "liguilla_rules_invalid" };
    const bonus = r.exactBonus == null ? 0 : r.exactBonus;
    if (!isPoints(bonus)) return { ok: false, reason: "liguilla_rules_invalid" };
    // Sin marcador no hay exacto: un bono con captura 1X2 sería una combinación imposible.
    if (r.capture === "result" && bonus !== 0) return { ok: false, reason: "liguilla_rules_invalid" };
    if (r.resultPoints === 0 && bonus === 0) return { ok: false, reason: "liguilla_rules_no_prize" };
    return { ok: true, rules: Object.freeze({ capture: r.capture, resultPoints: r.resultPoints, exactBonus: bonus }) };
  }
  function sameRules(a, b) {
    const va = validateRules(a), vb = validateRules(b);
    if (!va.ok || !vb.ok) return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
    return va.rules.capture === vb.rules.capture && va.rules.resultPoints === vb.rules.resultPoints
      && va.rules.exactBonus === vb.rules.exactBonus;
  }

  function isLiguillaRound(round) {
    return !!(round && round.stage === "liguilla");
  }
  // Las reglas con las que se juega UNA jornada: la copia que el servidor le
  // puso al publicarla. Nunca la configuración actual de la quiniela.
  function roundRules(round) {
    if (!isLiguillaRound(round) || !round.scoring) return null;
    const v = validateRules(round.scoring);
    return v.ok ? v.rules : null;
  }

  // El estado de un partido en una jornada (publicada o borrador).
  function matchStatusOf(round, matchId, opts) {
    const draft = !!(opts && opts.draft);
    const map = draft ? round && round.draftMatchStatus : round && round.matchStatus;
    const st = isObj(map) ? map[matchId] : null;
    return STATUSES.includes(st) ? st : null;
  }

  // Califica UN partido. Entrada:
  //   rules        reglas de la jornada (roundRules)
  //   pick         "A"/"D"/"B" o null
  //   pickScore    {a,b} o null (sólo con captura «score»)
  //   result       "A"/"D"/"B" o null
  //   resultScore  {a,b} o null
  //   status       null | "pending" | "postponed" | "void"
  //   published    si los resultados de la jornada están publicados
  // Salida: { state, resultHit, exactHit, base, bonus, total }
  //   state: "scored" | "pending" | "postponed" | "void"
  function scoreMatch({ rules, pick, pickScore, result, resultScore, status, published }) {
    const zero = (state) => ({ state, resultHit: false, exactHit: false, base: 0, bonus: 0, total: 0 });
    if (!rules) return zero("pending");
    if (status === MATCH_STATUS.VOID) return zero("void");
    if (status === MATCH_STATUS.POSTPONED) return zero("postponed");
    if (!published || status === MATCH_STATUS.PENDING || !OUTCOMES.includes(result)) return zero("pending");
    if (rules.capture === "score" && !isScore(resultScore)) return zero("pending");
    // Con marcador, el 1X2 del pronóstico SALE del marcador. Un "A" guardado
    // junto a un 1–1 no vale como "A".
    const myOutcome = rules.capture === "score" ? outcomeOfScore(pickScore) : (OUTCOMES.includes(pick) ? pick : null);
    const resultHit = !!myOutcome && myOutcome === result;
    const exactHit = rules.capture === "score" && isScore(pickScore)
      && pickScore.a === resultScore.a && pickScore.b === resultScore.b;
    const base = resultHit ? rules.resultPoints : 0;
    const bonus = exactHit ? rules.exactBonus : 0;
    return { state: "scored", resultHit, exactHit, base, bonus, total: base + bonus };
  }

  // Califica una jornada de liguilla completa para un participante.
  // roundPicks = picks[round.id] (puede traer __score).
  function scoreRound(round, roundPicks) {
    const rules = roundRules(round);
    const picks = isObj(roundPicks) ? roundPicks : {};
    const scores = isObj(picks.__score) ? picks.__score : {};
    const published = !!round.resultsPublished;
    const results = isObj(round.results) ? round.results : {};
    const resultScores = isObj(round.scores) ? round.scores : {};
    const matches = (Array.isArray(round.matches) ? round.matches : []).map((m) => {
      const out = scoreMatch({
        rules,
        pick: picks[m.id] || null,
        pickScore: scores[m.id] || null,
        result: results[m.id] || null,
        resultScore: resultScores[m.id] || null,
        status: matchStatusOf(round, m.id),
        published,
      });
      return { matchId: m.id, ...out };
    });
    const sum = (k) => matches.reduce((n, x) => n + x[k], 0);
    return {
      rules,
      matches,
      total: sum("total"),
      base: sum("base"),
      bonus: sum("bonus"),
      resultHits: matches.filter((x) => x.resultHit).length,
      exactHits: matches.filter((x) => x.exactHit).length,
      scored: matches.filter((x) => x.state === "scored").length,
      pending: matches.filter((x) => x.state === "pending").length,
      postponed: matches.filter((x) => x.state === "postponed").length,
      voided: matches.filter((x) => x.state === "void").length,
    };
  }

  // Valida un pronóstico de un partido según la captura. Devuelve
  // { ok, pick, score } normalizado o { ok:false, reason }.
  function normalizePick(capture, value) {
    if (capture === "score") {
      if (!isScore(value)) return { ok: false, reason: "invalid_score" };
      return { ok: true, pick: outcomeOfScore(value), score: { a: value.a, b: value.b } };
    }
    if (capture === "result") {
      if (!OUTCOMES.includes(value)) return { ok: false, reason: "invalid_pick" };
      return { ok: true, pick: value, score: null };
    }
    return { ok: false, reason: "invalid_capture" };
  }

  // Etiqueta de fase para mostrar: «Cuartos de final · Ida». null si no hay dato.
  const ROUND_LABEL = { quarter: "Cuartos de final", semi: "Semifinal", final: "Final" };
  const LEG_LABEL = { ida: "Ida", vuelta: "Vuelta", unico: "Partido único" };
  function phaseLabel(phase) {
    if (!isObj(phase) || !ROUND_LABEL[phase.round]) return null;
    return LEG_LABEL[phase.leg] ? `${ROUND_LABEL[phase.round]} · ${LEG_LABEL[phase.leg]}` : ROUND_LABEL[phase.round];
  }
  function validPhase(p) {
    if (p == null) return true;
    if (!isObj(p)) return false;
    if (p.round != null && !PHASE_ROUNDS.includes(p.round)) return false;
    if (p.leg != null && !PHASE_LEGS.includes(p.leg)) return false;
    if (!PHASE_SOURCES.includes(p.source)) return false;
    return Object.keys(p).every((k) => k === "round" || k === "leg" || k === "source");
  }

  return Object.freeze({
    GOALS_MIN, GOALS_MAX, POINTS_MAX, CAPTURES, OUTCOMES, MATCH_STATUS, STATUSES,
    PHASE_ROUNDS, PHASE_LEGS, PHASE_SOURCES, ROUND_LABEL, LEG_LABEL,
    isGoals, isScore, outcomeOfScore, isPoints, validateRules, sameRules,
    isLiguillaRound, roundRules, matchStatusOf, scoreMatch, scoreRound,
    normalizePick, phaseLabel, validPhase,
  });
});
