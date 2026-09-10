// SportsDataProvider — the ONLY module the rest of QRACKS (server.js routes,
// eventually the frontend via the backend endpoint) talks to for sports
// data. Nothing outside this file and providers/theSportsDbAdapter.js should
// ever know TheSportsDB's URL shape, field names, or auth mechanism.
//
// Normalized QRACKS event shape (deliberately provider-agnostic and not
// limited to two-participant sports — see DATA-001 §14/§5):
//
//   {
//     provider: "thesportsdb",
//     externalLeagueId: "4350",
//     externalEventId: "2487452",       // stable id from the provider
//     round: "17" | null,               // provider's own round label, ALWAYS a string
//                                        // (never coerced to Number — some
//                                        // competitions/stages use non-numeric
//                                        // labels) — see AUTO-001
//     status: "finished" | "scheduled" | "postponed" | "unknown",
//     dateTime: "2026-07-17T01:00:00Z" | null,
//     participants: [
//       { role: "home", externalId: "135662", name: "Necaxa" },
//       { role: "away", externalId: "134203", name: "Atlante" }
//     ],
//     score: { home: 2, away: 1 } | null,
//     providerStatus: "FT"              // raw status string, kept for debugging only
//   }
//
// `participants` is a list, not fixed home/away fields, specifically so a
// future non-two-sided sport (F1: N participants with finishing positions,
// no "home") can be represented without changing this shape — see DATA-001
// §5/§14. Today's adapters only ever produce 2-participant entries with
// role "home"/"away"; nothing downstream should assume the list length is 2.

const thesportsdb = require("./providers/theSportsDbAdapter");
const { SCORE_PHASE, buildScoreContract } = require("./scoreContract");
const sportmonksClient = require("./providers/sportmonksClient");
const sportmonksAdapter = require("./providers/sportmonksAdapter");

const CACHE_TTL_MS = 8 * 60 * 1000; // 5-10 min window, per DATA-001.1 §Caché
const cache = new Map(); // key -> { expiresAt, events }

function cacheKey(provider, externalLeagueId, season) {
  return `${provider}:${externalLeagueId}:${season}`;
}

// Errors are NEVER written to the cache — a failed lookup must be retryable
// on the very next call, not "stuck" showing the same failure for the TTL
// window. Only successful, fully-fetched season schedules are cached.
function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.events;
}

function setCached(key, events) {
  cache.set(key, { events, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Exposed for tests / ops — never exposed over HTTP.
function _clearCache() {
  cache.clear();
}

function normalizeStatus(providerStatus, hasScore) {
  if (providerStatus === "FT" || providerStatus === "AET" || providerStatus === "PEN") return "finished";
  if (providerStatus === "PPD" || providerStatus === "CANC") return "postponed";
  if (providerStatus === "NS" || !providerStatus) return hasScore ? "finished" : "scheduled";
  return "unknown";
}

// TheSportsDB's strTimestamp is UTC but is NOT guaranteed to carry an
// explicit timezone marker — observed real payloads (DATA-001 V2 spike)
// look like "2026-11-22T03:00:00" (no zone). Blindly appending "Z" was a
// bug: if a payload DOES include a zone ("...Z" or "...+00:00"/"...-05:00"),
// appending another "Z" produces an invalid or silently wrong Date. This
// only adds "Z" when no zone is already present, and always validates the
// result — an unparseable timestamp becomes null (caller falls back to
// raw.dateEvent) rather than a bogus/NaN date silently breaking matching.
function normalizeTimestamp(raw) {
  if (!raw) return null;
  const hasZone = /Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(raw);
  const iso = hasZone ? raw : raw + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// DATA-004C. Los estados de TheSportsDB en los que el partido terminó DENTRO
// del tiempo reglamentario. "FT" y nada más: "AET" y "PEN" son terminados
// también, pero su marcador incluye prórroga o desempate y por tanto no prueba
// nada sobre los 90 minutos.
//
// Éste es el arreglo del riesgo R8 de DATA-004A: buildRoundSuggestions derivaba
// el 1X2 de intHomeScore/intAwayScore sin mirar nunca el estado, así que un
// partido decidido en penales podía sugerirse como victoria. Ahora la pregunta
// se hace UNA vez, aquí, y su respuesta viaja con el evento.
const TSDB_REGULATION_COMPLETE = new Set(["FT"]);
const TSDB_NON_REGULATION_FINISHED = new Set(["AET", "PEN"]);
function tsdbRegulationComplete(providerStatus) {
  if (typeof providerStatus !== "string") return null;
  const s = providerStatus.trim().toUpperCase();
  if (TSDB_REGULATION_COMPLETE.has(s)) return true;
  if (TSDB_NON_REGULATION_FINISHED.has(s)) return false;
  return null;
}

// Acepta las dos formas que llegan de proveedores distintos —"2026-11-22T03:00:00"
// y "2025-12-15 02:00:00"— y devuelve siempre un instante ISO, o null. Nunca
// una fecha desplazada ni un NaN disfrazado.
function normalizeProviderTimestamp(raw) {
  if (!raw) return null;
  return normalizeTimestamp(String(raw).trim().replace(" ", "T"));
}

function normalizeEvent(raw, provider) {
  const hasScore = raw.intHomeScore != null && raw.intHomeScore !== "" &&
                    raw.intAwayScore != null && raw.intAwayScore !== "";
  // TheSportsDB no publica marcadores por fase: su único marcador es el final.
  // Se declara como tal, y es el estado quien decide si además vale como
  // reglamentario. Sin esa declaración explícita, el contrato devuelve null.
  const scoreLines = hasScore ? [
    { phase: SCORE_PHASE.FINAL, side: "home", goals: Number(raw.intHomeScore) },
    { phase: SCORE_PHASE.FINAL, side: "away", goals: Number(raw.intAwayScore) },
  ] : [];
  const scores = buildScoreContract({
    lines: scoreLines,
    regulationComplete: tsdbRegulationComplete(raw.strStatus),
  });
  return {
    provider,
    externalLeagueId: raw.idLeague != null ? String(raw.idLeague) : null,
    externalEventId: raw.idEvent != null ? String(raw.idEvent) : null,
    // AUTO-001: the provider's own round label, kept as a string (never
    // Number()) — some competitions/stages use non-numeric round labels
    // (e.g. "Final"), and forcing an integer here would silently break
    // grouping for those. null when the provider gives no round at all;
    // callers (Competition Sync) must treat that as "cannot group this
    // event automatically," never invent a round number for it.
    round: raw.intRound != null && raw.intRound !== "" ? String(raw.intRound) : null,
    status: raw.strPostponed === "yes" ? "postponed" : normalizeStatus(raw.strStatus, hasScore),
    dateTime: normalizeTimestamp(raw.strTimestamp) || raw.dateEvent || null,
    participants: [
      { role: "home", externalId: raw.idHomeTeam != null ? String(raw.idHomeTeam) : null, name: raw.strHomeTeam || null },
      { role: "away", externalId: raw.idAwayTeam != null ? String(raw.idAwayTeam) : null, name: raw.strAwayTeam || null },
    ],
    // El marcador final. Dato de PANTALLA: puede incluir prórroga.
    score: scores.final,
    // El único que puede alimentar un 1X2. null cuando el estado no prueba que
    // el partido terminara en los 90 — es decir, exactamente en AET y PEN.
    regulationScore: scores.regulation,
    scoreReasons: scores.reasons,
    providerStatus: raw.strStatus || null,
  };
}

// Fetches (or serves from cache) the full normalized season schedule for a
// league. This is the call that replaces the old truncated V1 frontend
// call — see DATA-001 root cause. Throws thesportsdb.ProviderError on
// failure; callers decide how to surface that (see server.js route).
// ---- El puente Sportmonks -> forma de evento del producto ------------------
//
// DATA-004 §3. Existían dos formas incompatibles de evento: la de este archivo
// (la que consume Competition Sync y el autocompletado de resultados) y la del
// dominio (sportsDomain.makeEvent, por donde entra Sportmonks). Esto es el
// boundary explícito y pequeño entre las dos — deliberadamente NO un refactor
// de una de ellas hacia la otra.
//
// Aquí no hay conocimiento de Sportmonks: se traduce de la forma del DOMINIO,
// que ya es provider-agnostic. Todo lo específico del proveedor vive en su
// adapter, que es donde el ticket lo quiere.
function fromDomainEvent(e, stageNameById) {
  const comp = (role) => (Array.isArray(e.competitors) ? e.competitors : []).find((c) => c && c.role === role) || null;
  const side = (role) => {
    const c = comp(role);
    return { role, externalId: c && c.providerCompetitorId ? c.providerCompetitorId : null, name: (c && c.name) || null };
  };
  return {
    provider: e.provider,
    externalLeagueId: null,
    externalEventId: e.providerEventId,
    // Puede ser null, y eso está bien: la agrupación tiene otras señales.
    round: e.providerRoundId,
    stageId: e.stageId || null,
    stageName: (stageNameById && stageNameById.get(e.stageId)) || null,
    leg: e.leg || null,
    status: e.status,
    // NORMALIZADO AQUÍ, y no antes. Sportmonks entrega "2025-12-15 02:00:00":
    // sin la T y sin zona. Pasarlo tal cual tenía dos consecuencias, las dos
    // malas: `new Date()` lo interpreta como hora LOCAL, así que el horario del
    // partido se desplazaba; y como lo guardado sí es ISO, cada sync veía un
    // cambio de horario que no existía y proponía la misma actualización para
    // siempre. El dominio conserva la cadena del proveedor; lo que cruza a
    // producto es un instante.
    dateTime: normalizeProviderTimestamp(e.startsAt),
    participants: [side("home"), side("away")],
    score: e.score || null,
    regulationScore: e.regulationScore || null,
    scoreReasons: e.scoreReasons || [],
    providerStatus: e.providerStatusRaw == null ? null : String(e.providerStatusRaw),
  };
}

// Trae una temporada completa de Sportmonks y la devuelve YA en la forma que el
// producto consume. `seasonId` es el id de temporada de Sportmonks: es un
// contrato de configuración explícito, no algo que se adivine de un nombre.
//
// El cliente se inyecta para poder ejercitar esto de punta a punta contra los
// payloads reales registrados, sin red y sin credencial.
async function getSportmonksSeasonEvents({ seasonId, competitionId, client }) {
  const api = client || sportmonksClient.createSportmonksClient();
  const seasonPayload = await api.getSeasonWithStages(seasonId);
  const { stages } = sportmonksAdapter.fromSeasonPayload(seasonPayload, {
    competitionId: competitionId || null,
    providerCompetitionId: competitionId || null,
  });
  const stageNameById = new Map(stages.map((st) => [st.id, st.name]));
  const out = [];
  for (const stage of stages) {
    // Un stage que falle NO tumba la importación entera: la fase final de una
    // liga puede tener stages que el plan no cubre, y perder el resto por eso
    // sería exactamente la pérdida silenciosa que este ticket combate.
    let payload;
    try {
      payload = await api.getStageFixtures(stage.providerStageId);
    } catch (err) {
      continue;
    }
    const { events } = sportmonksAdapter.fromStagePayload(payload, { stages });
    for (const e of events) out.push(fromDomainEvent(e, stageNameById));
  }
  return out;
}

async function getSeasonEvents({ provider, externalLeagueId, season, client }) {
  if (provider === "sportmonks") {
    const key = cacheKey(provider, externalLeagueId, season);
    const cached = getCached(key);
    if (cached) return cached;
    const events = await getSportmonksSeasonEvents({ seasonId: season, competitionId: externalLeagueId, client });
    setCached(key, events);
    return events;
  }
  if (provider !== "thesportsdb") {
    // Only one provider exists today; this guard exists so that adding a
    // second provider later is a matter of branching here, not rewriting
    // every caller — see DATA-001 §4/§14.
    throw new thesportsdb.ProviderError("competition_not_supported", `Unknown provider: ${provider}`);
  }
  const key = cacheKey(provider, externalLeagueId, season);
  const cached = getCached(key);
  if (cached) return cached;

  const rawEvents = await thesportsdb.getSeasonSchedule(externalLeagueId, season);
  const events = rawEvents.map((e) => normalizeEvent(e, provider));
  setCached(key, events);
  return events;
}

async function getLiveEvents({ provider, externalLeagueId }) {
  if (provider !== "thesportsdb") {
    throw new thesportsdb.ProviderError("competition_not_supported", `Unknown provider: ${provider}`);
  }
  const rawEvents = await thesportsdb.getLivescore(externalLeagueId);
  return rawEvents.map((e) => normalizeEvent(e, provider));
}

// ---- Matching: normalized provider events <-> QRACKS's own round.matches --
//
// OJO al historial, porque la regla cambió y el comentario que decía lo
// contrario es justo lo que hace que un fallo así vuelva:
//
//   DATA-001         — emparejamiento difuso por nombres dentro de una ventana
//                      de fechas alrededor del cierre de la jornada.
//   DATA-001 §8/§12  — se PREFIERE el `externalEventId` cuando el partido ya lo
//                      tiene guardado, con el difuso de respaldo.
//   QA Correction 03 — ya no se "prefiere": con identidad demostrable NO HAY
//                      respaldo. El difuso sobrevive únicamente para los
//                      partidos que nunca tuvieron id externo, que son los
//                      creados a mano. Ver los tres estados más abajo.

const TEAM_ALIASES = {
  "América": "CF America",
  "Chivas": "CD Guadalajara",
  "Juárez": "FC Juarez",
  "Querétaro": "Queretaro FC",
  "Santos": "Santos Laguna",
  "Xolos": "Tijuana",
};

function normalizeTeamName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(fc|cf|cd|afc|sc|ac|club|de)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function teamsMatch(ourName, providerName) {
  const resolved = TEAM_ALIASES[ourName] || ourName;
  const a = normalizeTeamName(resolved);
  const b = normalizeTeamName(providerName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// ---- Orientación: cuál de los dos equipos del tablero jugó de local --------
//
// QA Correction 03. De esto depende, literalmente, quién cobra: el 1X2 de un
// partido con ganador es "A" o "B" según qué lado del marcador de regulación
// corresponde a `teamA`. Equivocarse aquí no produce un error visible — produce
// una sugerencia perfectamente plausible con el ganador invertido.
//
// Hasta ahora la orientación salía de UNA comparación difusa de nombres
// (`teamsMatch(match.teamA, home.name)`), y esa función es deliberadamente
// laxa: normaliza acentos, borra "FC"/"CD"/"Club"/"de" y acepta que un nombre
// sea SUBCADENA del otro. Eso falla en las dos direcciones, y las dos invierten
// el resultado:
//
//   falso negativo  — el Admin escribió "La Máquina" y el proveedor dice
//                     "Cruz Azul": no casan, `straight` queda en false y el
//                     local ganador se sugiere como visitante ganador.
//   falso positivo  — "Atlético San Luis" contiene "San Luis": casa con un
//                     equipo que NO es, y orienta al revés.
//
// La corrección tiene dos partes. Primero, cuando existe identidad dura —los
// ids de equipo del proveedor, que Competition Sync ya persiste en el partido
// como `externalHomeId`/`externalAwayId`— los nombres no se miran en absoluto.
// Segundo, cuando NO existe (jornada manual o heredada), se exige señal
// coherente en los DOS equipos y en los DOS lados; cualquier ambigüedad o
// contradicción devuelve null, y null significa "no se sugiere nada". Falla
// cerrado: el Admin captura ese partido a mano, que es infinitamente mejor que
// pagarle al equipo equivocado.
//
// Devuelve true (teamA jugó de local), false (teamA jugó de visitante) o null
// (no se pudo demostrar). NUNCA adivina.
function resolveOrientation(match, home, away) {
  const s = (v) => (v == null || v === "" ? null : String(v));

  const ourHome = s(match && match.externalHomeId);
  const ourAway = s(match && match.externalAwayId);
  const evHome = s(home && home.externalId);
  const evAway = s(away && away.externalId);

  // Camino 1: identidad dura. Se exigen los cuatro ids y que el par de equipos
  // sea EL MISMO par, en el orden que sea.
  if (ourHome && ourAway && evHome && evAway && ourHome !== ourAway && evHome !== evAway) {
    if (ourHome === evHome && ourAway === evAway) return true;
    // El proveedor invirtió la localía respecto de lo que guardamos. Es un caso
    // real —una vuelta de Liguilla, una sede que cambia— y aquí se trata como
    // lo que es: el mismo partido con los lados al revés. `teamA` es el equipo
    // que guardamos como local, así que ahora es el visitante.
    if (ourHome === evAway && ourAway === evHome) return false;
    // Mismo id de fixture, otro par de equipos. Eso no se orienta: o el
    // proveedor reasignó el id, o el partido dejó de ser el que era.
    return null;
  }

  // Camino 2: sólo nombres (partido manual, o heredado sin ids de equipo). La
  // laxitud de teamsMatch se compensa exigiendo que las cuatro comparaciones
  // cuenten la MISMA historia. Una sola contradicción y no hay orientación.
  const aHome = teamsMatch(match && match.teamA, home && home.name);
  const aAway = teamsMatch(match && match.teamA, away && away.name);
  const bHome = teamsMatch(match && match.teamB, home && home.name);
  const bAway = teamsMatch(match && match.teamB, away && away.name);

  if (aHome && bAway && !aAway && !bHome) return true;
  if (aAway && bHome && !aHome && !bAway) return false;
  return null;
}

const MATCH_WINDOW_MS = 1000 * 60 * 60 * 24 * 20; // ~20 days, unchanged from pre-DATA-001 behavior

// Returns a normalized event (see shape above) or null. `match` is a
// QRACKS round.matches[] entry: { teamA, teamB, externalEventId? }.
// ---- Los tres estados de identidad de un partido (QA Correction 03) --------
//
// Un partido del tablero está en uno de tres estados, y sólo uno de ellos
// autoriza a buscar "algo parecido":
//
//   COMPLETA  — tiene id externo Y proveedor demostrable. Se busca por
//               identidad exacta y NADA MÁS. Si ese fixture no está en el lote,
//               la respuesta es "no encontré ese partido", que NO es lo mismo
//               que "busca algo que se le parezca".
//   AMBIGUA   — tiene id externo pero no se puede demostrar de qué proveedor.
//               Tener un id externo ya demuestra que NO es un partido manual;
//               si no sabemos de dónde vino, precisamente no tenemos autoridad
//               para adivinar por nombre y fecha. Falla cerrado.
//   MANUAL    — no tiene id externo. Es una jornada creada a mano, nunca tuvo
//               identidad de proveedor, y el emparejamiento por equipos y fecha
//               es el único que puede tener. Se conserva tal cual.
//
// El fallo que esto cierra: antes, un miss del camino exacto CAÍA al
// emparejamiento por nombre, y ese bucle no miraba el proveedor. Un partido
// importado de TheSportsDB podía recibir el resultado de un evento de
// Sportmonks con los mismos equipos y fecha. La identidad `provider + id` se
// rompía justo en el momento de repartir puntos.
const MATCH_IDENTITY = Object.freeze({ COMPLETE: "complete", AMBIGUOUS: "ambiguous", MANUAL: "manual" });

function classifyMatchIdentity(match, matchProvider) {
  const externalId = match && match.externalEventId != null && match.externalEventId !== ""
    ? String(match.externalEventId) : null;
  if (!externalId) return { state: MATCH_IDENTITY.MANUAL, externalId: null, provider: null };
  // El proveedor PERSISTIDO en el partido manda; el que pasa quien llama es el
  // respaldo. Es la misma regla que Competition Sync ("el proveedor del propio
  // fixture manda"), y el orden importa: `matchProvider` suele venir del
  // proveedor de la JORNADA, que es una señal más débil —una jornada heredada
  // pudo importarse con otro— y dejarla ganar reabriría por detrás justo el
  // cruce de proveedores que QA Correction 02 cerró.
  const provider = (match && match.externalProvider) || matchProvider || null;
  if (!provider) return { state: MATCH_IDENTITY.AMBIGUOUS, externalId, provider: null };
  return { state: MATCH_IDENTITY.COMPLETE, externalId, provider: String(provider) };
}

function findMatchingEvent(events, match, roundDeadlineIso, matchProvider) {
  const list = Array.isArray(events) ? events : [];
  const identity = classifyMatchIdentity(match, matchProvider);

  // IDENTIDAD COMPLETA -> exacto y sólo exacto.
  if (identity.state === MATCH_IDENTITY.COMPLETE) {
    return list.find((e) =>
      e && e.externalEventId === identity.externalId && e.provider === identity.provider) || null;
  }

  // IDENTIDAD AMBIGUA -> nada. No es manual, y no sabemos de quién es.
  if (identity.state === MATCH_IDENTITY.AMBIGUOUS) return null;

  // MANUAL -> el emparejamiento de siempre, por equipos y ventana de fechas.

  const targetTime = new Date(roundDeadlineIso).getTime();
  let best = null;
  let bestDiff = Infinity;
  // Se itera `list`, no `events`: `events` puede no ser iterable, y un evento
  // nulo o sin participantes tampoco puede tumbar la búsqueda de una jornada
  // entera. Un evento malformado se salta; no emparejar es siempre preferible a
  // reventar el autocompletado de los demás partidos.
  for (const ev of list) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.status !== "finished" || !ev.score) continue; // only suggest finished results, same as before
    if (!Array.isArray(ev.participants) || ev.participants.length < 2) continue;
    const [home, away] = ev.participants;
    if (!home || !away) continue;
    const straight = teamsMatch(match.teamA, home.name) && teamsMatch(match.teamB, away.name);
    const swapped = teamsMatch(match.teamB, home.name) && teamsMatch(match.teamA, away.name);
    if (!straight && !swapped) continue;
    const evTime = ev.dateTime ? new Date(ev.dateTime).getTime() : NaN;
    const diff = Math.abs(evTime - targetTime);
    if (Number.isFinite(diff) && diff < bestDiff && diff < MATCH_WINDOW_MS) {
      bestDiff = diff;
      best = ev;
    }
  }
  return best;
}

module.exports = {
  tsdbRegulationComplete,
  MATCH_IDENTITY,
  classifyMatchIdentity,
  normalizeProviderTimestamp,
  fromDomainEvent,
  getSportmonksSeasonEvents,
  getSeasonEvents,
  getLiveEvents,
  findMatchingEvent,
  resolveOrientation,
  normalizeEvent,
  // exported for tests only
  _teamsMatch: teamsMatch,
  _normalizeTeamName: normalizeTeamName,
  _normalizeTimestamp: normalizeTimestamp,
  _clearCache,
};
