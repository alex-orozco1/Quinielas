// competitionCoverage.js — MON-003: qué cubre Plus, por competencia.
//
// Plus cubre EL TORNEO COMPLETO de la quiniela —el ciclo de torneo que se está
// jugando (tournamentScope.js)—, fases finales incluidas. Lo que cambia de una
// competencia a otra no es lo que se vende sino CÓMO SE DICE: la Liga MX tiene
// liguilla, la Champions tiene eliminatorias, una liga europea es sólo la liga.
//
// Este archivo es la ÚNICA fuente de esa frase. La leen el endpoint del plan
// (Ajustes, franja del Admin), la oferta y el paywall del servidor, y el
// checkout (la descripción del producto en la página de pago). Ninguna pantalla
// la escribe por su cuenta.
//
// Reglas:
//   - La cobertura sale de ESTA configuración, por competencia y formato. Nunca
//     se deduce contando los eventos que devuelva la API deportiva: un
//     calendario incompleto (la liguilla aún sin fechas, una eliminatoria sin
//     sortear) diría un número falso.
//   - Un número de jornadas sólo se muestra si está configurado aquí y el formato
//     es una liga sin fases finales (donde el número ES la competencia entera).
//     Hoy no hay ninguno configurado: "el torneo completo" es siempre cierto.
//   - Competencia manual (sin liga) o desconocida (fuera de este catálogo): la
//     frase genérica, sin inventar fases ni cantidades.
//   - Nada de esto limita jornadas: el límite lo decide planLimits.js, y Plus no
//     tiene tope de jornadas dentro de su ciclo. Esta frase sólo lo DESCRIBE.
//
// Puro: sin I/O, sin reloj, sin mutar entradas.
//
// ---- Cómo se añade una competencia (ej. MLS) ------------------------------
//
// 1. Tomar el id de la competencia DEL PROVEEDOR (hoy TheSportsDB), comprobado
//    en su API — no se escribe de memoria.
// 2. Añadir la entrada aquí con la clave "<proveedor>:<id>" y su formato. La MLS
//    es temporada regular + playoffs (MLS Cup Playoffs), así que sería:
//        "thesportsdb:<id MLS>": entry("MLS", FORMAT.LEAGUE_WITH_PLAYOFFS,
//                                      "incluidos los playoffs")
//    Sin `roundCount`: con playoffs no hay un número que sea la competencia
//    entera.
// 3. Añadirla al selector de ligas del cliente (SPORTSDB_LEAGUES y los mapas
//    que lo acompañan en public/index.html).
// 4. Correr test/competitionCoverage.test.js: exige que cada liga del selector
//    tenga entrada aquí.

const FORMAT = Object.freeze({
  // Sólo liga: todos contra todos, sin fases finales.
  LEAGUE: "league",
  // Liga + fase final por eliminación (liguilla, playoffs).
  LEAGUE_WITH_PLAYOFFS: "league_with_playoffs",
  // Fase de liga/grupos + eliminatorias hasta la final (copas continentales).
  LEAGUE_PHASE_AND_KNOCKOUT: "league_phase_and_knockout",
});

const GENERIC_SCOPE = "el torneo completo";

function entry(name, format, finalPhases, roundCount) {
  return Object.freeze({
    name, format,
    // La frase de las fases finales, con su concordancia ("incluida la
    // liguilla", "incluidas las eliminatorias"). null en una liga sin ellas.
    finalPhases: finalPhases || null,
    roundCount: Number.isSafeInteger(roundCount) && roundCount > 0 ? roundCount : null,
  });
}

// Clave: "<proveedor>:<id de la competencia en ese proveedor>". Los ids son los
// que ya usa el selector de ligas (public/index.html, SPORTSDB_LEAGUES).
const COVERAGE_CATALOG = Object.freeze({
  "thesportsdb:4350": entry("Liga MX", FORMAT.LEAGUE_WITH_PLAYOFFS, "incluida la liguilla"),
  "thesportsdb:4328": entry("Premier League", FORMAT.LEAGUE),
  "thesportsdb:4335": entry("La Liga", FORMAT.LEAGUE),
  "thesportsdb:4331": entry("Bundesliga", FORMAT.LEAGUE),
  "thesportsdb:4332": entry("Serie A", FORMAT.LEAGUE),
  "thesportsdb:4334": entry("Ligue 1", FORMAT.LEAGUE),
  "thesportsdb:4480": entry("UEFA Champions League", FORMAT.LEAGUE_PHASE_AND_KNOCKOUT, "incluidas las eliminatorias"),
});

function catalogKey(provider, competitionId) {
  if (typeof provider !== "string" || provider.trim() === "") return null;
  if (competitionId == null) return null;
  const id = String(competitionId).trim();
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(id)) return null;
  return `${provider.trim()}:${id}`;
}

// La frase del alcance para una entrada del catálogo (o null -> genérica).
function scopePhrase(e) {
  if (!e) return GENERIC_SCOPE;
  if (e.finalPhases) return `${GENERIC_SCOPE}, ${e.finalPhases}`;
  // Un número sólo donde ES la competencia entera: una liga sin fases finales.
  if (e.format === FORMAT.LEAGUE && e.roundCount) return `${GENERIC_SCOPE} (${e.roundCount} jornadas)`;
  return GENERIC_SCOPE;
}

// La cobertura de Plus para una competencia. Nunca devuelve null: una
// competencia manual o desconocida recibe la frase genérica, que es cierta
// para cualquier quiniela.
//
//   known   true si la competencia está en el catálogo
//   key     la clave del catálogo, o null
//   name    nombre legible de la competencia, o null
//   format  FORMAT.*, o null
//   scope   "el torneo completo[, incluida la liguilla]"
function coverageFor(provider, competitionId) {
  const key = catalogKey(provider, competitionId);
  const e = key && Object.prototype.hasOwnProperty.call(COVERAGE_CATALOG, key) ? COVERAGE_CATALOG[key] : null;
  return Object.freeze({
    known: !!e,
    key: e ? key : null,
    name: e ? e.name : null,
    format: e ? e.format : null,
    scope: scopePhrase(e),
  });
}

// "hasta 50 personas y el torneo completo, incluida la liguilla" — la frase
// completa, igual en Ajustes, en la oferta y en el checkout.
function plusCoverageText(participantLimit, coverage) {
  const scope = coverage && typeof coverage.scope === "string" ? coverage.scope : GENERIC_SCOPE;
  if (!Number.isSafeInteger(participantLimit) || participantLimit < 1) return scope;
  return `hasta ${participantLimit} personas y ${scope}`;
}

module.exports = {
  FORMAT, COVERAGE_CATALOG, GENERIC_SCOPE,
  catalogKey, coverageFor, plusCoverageText, scopePhrase,
};
