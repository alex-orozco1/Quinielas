// scoreContract.js — DATA-004C: qué marcador puede alimentar el 1X2 de QRACKS.
//
// LA REGLA DE PRODUCTO
// --------------------
// QRACKS puntúa 1X2 al final del TIEMPO REGLAMENTARIO: 90 minutos más
// compensación. Ni la prórroga ni los penales cambian el pick. Una Final que
// termina 1-1 y se decide 5-4 en penales es, para QRACKS, un EMPATE.
//
// EL INVARIANTE, Y POR QUÉ VIVE EN SU PROPIO ARCHIVO
// --------------------------------------------------
// Derivar el 1X2 de un marcador que incluye prórroga o penales no falla
// ruidosamente: produce un resultado plausible y equivocado, se publica, y
// paga a la persona equivocada. Es el peor modo de fallo que tiene este
// producto. Así que la decisión vive en un módulo puro, con una sola regla:
//
//   El marcador de regulación exige EVIDENCIA POSITIVA de que lo es.
//   Nunca se infiere de un marcador genérico que PODRÍA incluir prórroga.
//
// Cuando esa evidencia no existe, la respuesta es `null` — nunca una
// reconstrucción aritmética, nunca una suposición. `null` significa "no lo sé",
// y aguas abajo significa "no sugieras resultado, que lo capture el Admin".
//
// PROVIDER-AGNOSTIC A PROPÓSITO
// -----------------------------
// Este módulo no sabe qué es Sportmonks ni TheSportsDB. Cada adapter traduce su
// payload a `lines` (fases ya clasificadas) y declara `regulationComplete`.
// El vocabulario de cada proveedor se declara en SU adapter, que es donde una
// corrección futura tiene que aterrizar — no aquí.

// Las fases que este contrato reconoce. Todo lo que un adapter no sepa
// clasificar entra como UNKNOWN, y UNKNOWN vuelve el fixture ambiguo: es
// exactamente la señal de "hay algo aquí que no entiendo", y ante eso la
// respuesta segura es no puntuar.
const SCORE_PHASE = Object.freeze({
  // El marcador al terminar el segundo tiempo. ESTE es el 1X2 de QRACKS.
  REGULATION: "regulation",
  EXTRA_TIME: "extra_time",
  PENALTY: "penalty",
  // "El marcador" según el proveedor. Puede o no incluir prórroga: por sí solo
  // NUNCA es evidencia de regulación.
  FINAL: "final",
  // Reconocidas y deliberadamente ignoradas: existen, no son el marcador del
  // partido, y no deben volver ambiguo nada.
  PARTIAL: "partial",       // primer tiempo, parciales
  AGGREGATE: "aggregate",   // global de una eliminatoria, nunca un partido
  // No reconocida. Vuelve el fixture ambiguo.
  UNKNOWN: "unknown",
});

const SIDES = Object.freeze(["home", "away"]);

// Un marcador es dos enteros no negativos y nada más. Un no-entero, un
// negativo o un NaN no es "cero": es un dato que no se puede usar.
function isGoals(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

// Motivos por los que la regulación no se pudo determinar. Se devuelven para
// que la capa de diagnóstico (§G) pueda decir POR QUÉ, en vez de dejar un null
// mudo que nadie sabe interpretar.
const REASONS = Object.freeze({
  NO_RECORDS: "no_score_records",
  INCOMPLETE_PHASE: "incomplete_phase",
  DUPLICATE_CONFLICT: "duplicate_conflict",
  UNKNOWN_PHASE: "unknown_score_phase",
  EXTRA_TIME_PRESENT: "extra_time_present",
  PENALTIES_PRESENT: "penalties_present",
  REGULATION_NOT_PROVEN: "regulation_not_proven",
  // El marcador de regulación y el final se contradicen en un partido que,
  // según el proveedor, terminó en los 90. Ver el candado de coherencia abajo.
  PHASE_CONTRADICTION: "phase_contradiction",
});

// Reduce las líneas de UNA fase a un marcador, o a null con su motivo.
//
// Exige exactamente un valor por lado. Dos registros para el mismo lado con
// goles distintos son una contradicción del proveedor sobre el mismo hecho: se
// descarta la fase entera en vez de elegir uno. Elegir sería un
// primer-gana/último-gana silencioso, que es la clase de decisión que este
// módulo existe para no tomar. Dos registros IDÉNTICOS no son contradicción.
function reducePhase(lines) {
  const bySide = new Map();
  for (const line of lines) {
    if (!SIDES.includes(line.side)) continue;
    if (!isGoals(line.goals)) return { score: null, reason: REASONS.INCOMPLETE_PHASE };
    if (bySide.has(line.side) && bySide.get(line.side) !== line.goals) {
      return { score: null, reason: REASONS.DUPLICATE_CONFLICT };
    }
    bySide.set(line.side, line.goals);
  }
  if (!bySide.has("home") || !bySide.has("away")) {
    return { score: null, reason: bySide.size ? REASONS.INCOMPLETE_PHASE : REASONS.NO_RECORDS };
  }
  return { score: Object.freeze({ home: bySide.get("home"), away: bySide.get("away") }), reason: null };
}

/**
 * @param lines  [{ phase, side: "home"|"away", goals }] — ya clasificadas por el adapter.
 * @param regulationComplete  true  = el proveedor afirma que el partido terminó
 *                                    en tiempo reglamentario (sin prórroga ni penales);
 *                            false = afirma que NO;
 *                            null  = no lo dice / no lo sabemos.
 *
 * Devuelve { regulation, final, penalty, extraTime, ambiguous, reasons }.
 * `regulation` es el ÚNICO campo del que puede salir un 1X2.
 */
function buildScoreContract({ lines, regulationComplete } = {}) {
  const list = (Array.isArray(lines) ? lines : []).filter((l) => l && typeof l === "object");
  const reasons = new Set();

  const byPhase = new Map();
  for (const line of list) {
    const phase = line.phase || SCORE_PHASE.UNKNOWN;
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(line);
  }

  // Una fase que el adapter no supo clasificar es información que existe y no
  // entendemos. No se ignora: contamina el fixture entero como ambiguo.
  const ambiguous = byPhase.has(SCORE_PHASE.UNKNOWN);
  if (ambiguous) reasons.add(REASONS.UNKNOWN_PHASE);

  const take = (phase) => {
    if (!byPhase.has(phase)) return { score: null, reason: null };
    const out = reducePhase(byPhase.get(phase));
    if (out.reason && out.reason !== REASONS.NO_RECORDS) reasons.add(out.reason);
    return out;
  };

  const explicitRegulation = take(SCORE_PHASE.REGULATION);
  const finalOut = take(SCORE_PHASE.FINAL);
  const penaltyOut = take(SCORE_PHASE.PENALTY);
  const extraTimeOut = take(SCORE_PHASE.EXTRA_TIME);

  const hasExtraTimeRecords = byPhase.has(SCORE_PHASE.EXTRA_TIME);
  const hasPenaltyRecords = byPhase.has(SCORE_PHASE.PENALTY);

  // CANDADO DE COHERENCIA — el que protege contra una lectura equivocada del
  // vocabulario del proveedor.
  //
  // En un partido que terminó dentro de los 90 minutos, el marcador de
  // regulación y el final son el MISMO marcador. Si el proveedor afirma que
  // terminó así y los dos registros no coinciden, entonces lo que creemos que
  // significa cada fase está mal: quizá esa "fase de regulación" son los goles
  // DE un tiempo y no el acumulado. En ese caso no hay que elegir uno — hay que
  // dejar de puntuar, porque la premisa que sostiene todo el contrato falló.
  //
  // Es barato y se autovalida: si la tabla de descripciones de un adapter
  // estuviera mal, esto se dispararía en casi todos los partidos con gol en el
  // primer tiempo, y el sistema dejaría de sugerir en vez de sugerir mal.
  const contradiction = !!(
    regulationComplete === true &&
    explicitRegulation.score && finalOut.score &&
    (explicitRegulation.score.home !== finalOut.score.home ||
     explicitRegulation.score.away !== finalOut.score.away)
  );
  if (contradiction) reasons.add(REASONS.PHASE_CONTRADICTION);

  // Hubo registros que DICEN ser de regulación, aunque no se hayan podido leer
  // (incompletos, contradictorios). Distinto de "no vino ninguno", y la
  // diferencia importa: donde hay evidencia de regulación rota, deducirla del
  // marcador final sería tapar el problema en vez de reportarlo.
  const regulationPhasePresent = byPhase.has(SCORE_PHASE.REGULATION);

  let regulation = null;
  if (ambiguous) {
    // P1-A (QA independiente). Antes, un registro sin clasificar marcaba el
    // fixture como ambiguo y aun así se devolvía el marcador de regulación si
    // existía. El contrato decía una cosa y el código hacía otra: bastaba con
    // que un payload trajera un 2ND_HALF aparentemente bueno MÁS una línea
    // desconocida o malformada para seguir produciendo 1X2.
    //
    // Si hay algo en el marcador que no sabemos leer, no sabemos qué partido
    // estamos puntuando. Fail closed, sin excepciones.
    regulation = null;
  } else if (contradiction) {
    regulation = null;
  } else if (explicitRegulation.score) {
    // CAMINO 1 — evidencia directa. El proveedor dice cuál fue el marcador al
    // terminar el segundo tiempo. Es la respuesta, sin más condiciones: sigue
    // siendo válida aunque después hubiera prórroga y penales, que es
    // precisamente el caso que importa.
    regulation = explicitRegulation.score;
  } else if (regulationPhasePresent) {
    // Vino evidencia de regulación y NO se pudo leer (incompleta, o dos
    // registros que se contradicen). No se cae al camino 2: el marcador final
    // puede hacer de reglamentario sólo cuando no hay ninguna afirmación
    // directa sobre los 90 minutos, jamás cuando la hay y está rota. Deducirlo
    // entonces sería tapar el problema en vez de reportarlo.
    //
    // Encontrado revisando este mismo arreglo: un 2ND_HALF duplicado y
    // contradictorio, con estado FT y un CURRENT presente, acababa usando el
    // CURRENT — y el orden de estas ramas era lo único que lo decidía.
    regulation = null;
  } else if (
    finalOut.score &&
    regulationComplete === true &&
    !hasExtraTimeRecords &&
    !hasPenaltyRecords &&
    !ambiguous
  ) {
    // CAMINO 2 — evidencia indirecta, con cuatro candados. Un partido que
    // terminó en los 90 tiene, por definición, el mismo marcador final que
    // reglamentario. Sólo se toma cuando el proveedor AFIRMA que terminó así
    // (`regulationComplete === true`, nunca `null`) y además no hay ningún
    // rastro de prórroga o penales que lo contradiga, ni nada sin clasificar.
    // Cualquiera de los cuatro candados que falle devuelve null.
    regulation = finalOut.score;
  }
  if (regulation === null) {
    if (hasPenaltyRecords) reasons.add(REASONS.PENALTIES_PRESENT);
    if (hasExtraTimeRecords) reasons.add(REASONS.EXTRA_TIME_PRESENT);
    if (!list.length) reasons.add(REASONS.NO_RECORDS);
    else reasons.add(REASONS.REGULATION_NOT_PROVEN);
  }

  return Object.freeze({
    regulation,
    final: finalOut.score,
    penalty: penaltyOut.score,
    extraTime: extraTimeOut.score,
    ambiguous,
    reasons: Object.freeze([...reasons].sort()),
  });
}

// El 1X2 de QRACKS, y el único sitio donde se calcula.
//
// `homeIsTeamA` existe porque el tablero de QRACKS guarda teamA/teamB en el
// orden en que se importaron, que no tiene por qué ser local/visitante. Invertir
// aquí, en un punto, evita que cada consumidor lo resuelva por su cuenta y se
// equivoque uno de ellos.
//
// Sin marcador de regulación no hay resultado: null, nunca un valor por
// defecto. Fail closed.
//
// QA Correction 03: `homeIsTeamA` tiene TRES estados, no dos. Antes cualquier
// cosa que no fuera exactamente `false` se trataba como "teamA jugó de local",
// así que un null —"no se pudo demostrar quién jugó de local"— se convertía en
// una afirmación, y encima en la afirmación optimista. Ahora sólo `true` y
// `false` deciden; todo lo demás no puntúa. Un empate tampoco se salva por ser
// simétrico: si no se pudo demostrar la orientación, tampoco está demostrado
// que este marcador sea el de estos dos equipos.
function outcomeFromRegulation(regulation, homeIsTeamA) {
  if (homeIsTeamA !== true && homeIsTeamA !== false) return null;
  if (!regulation || !isGoals(regulation.home) || !isGoals(regulation.away)) return null;
  if (regulation.home === regulation.away) return "D";
  const homeWon = regulation.home > regulation.away;
  return homeIsTeamA === false ? (homeWon ? "B" : "A") : (homeWon ? "A" : "B");
}

module.exports = { SCORE_PHASE, REASONS, buildScoreContract, outcomeFromRegulation };
