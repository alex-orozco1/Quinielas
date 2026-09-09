// competitionSync.js — planificación de la sincronización deportiva.
//
// QUÉ CAMBIÓ EN DATA-004C, Y POR QUÉ
// ----------------------------------
// La versión anterior tenía tres supuestos que la evidencia real de Liga MX
// rompió, y los tres producían pérdida silenciosa:
//
//   1. IDENTIDAD POR RONDA. La idempotencia se apoyaba en `externalRoundId`.
//      27 de 337 fixtures reales de Liga MX 2025/26 llegan con round_id null
//      (Play-In, Cuartos, Semifinal, Final según la instancia), así que para
//      ellos NO HABÍA CLAVE. Quitar el descarte sin cambiar la clave habría
//      creado jornadas duplicadas en cada sync — el orden de estos dos
//      cambios no es cosmético.
//
//   2. DESCARTE POR round == null. `if (ev.round == null) { skipped++; continue; }`
//      tiraba la fase final entera, sin error y sin aviso.
//
//   3. SÓLO AÑADIR. Un fixture ya importado nunca se actualizaba, así que un
//      cruce TBD se quedaba "TBD" para siempre — y en una eliminatoria los
//      equipos se conocen DESPUÉS de que el partido ya está en el calendario.
//
// LO QUE SUSTITUYE A LOS TRES
// ---------------------------
// La identidad es `provider + providerFixtureId`, y nada más. No se agrupa por
// equipos, ni por fecha, ni por nombre de fase, ni por parecido: DATA-004B dejó
// SIN PROBAR que Sportmonks conserve el mismo fixture.id al resolver un TBD, y
// ante eso un emparejamiento difuso no es una ayuda, es una forma de fusionar
// dos partidos distintos en silencio. Un id nuevo es un fixture nuevo, y si eso
// produce una discrepancia se REPORTA.
//
// Un fixture sin ronda es válido y se conserva en `stagedFixtures`: preservado
// en dominio/sync, todavía no convertido en jornada. Inventarle un número de
// jornada para que quepa en el schema actual sería falsear la semántica; la
// integración de esos fixtures con la UI es DATA-004D.
//
// planCompetitionSync() no muta sus entradas y no decide nada sobre ids ni
// persistencia: eso es del llamador.


// ---- el contrato de entrada ------------------------------------------------
//
// Una SyncFixture es lo que este planificador entiende. Los dos conversores de
// abajo traducen las dos formas internas de QRACKS a ella. Ninguno de los dos
// conoce campos de Sportmonks o de TheSportsDB: eso vive en los adapters.
//
//   { providerFixtureId, providerRoundId, stageId, kickoffAt,
//     home: {id, name} | null, away: {id, name} | null, leg, status }

function str(v) {
  return v == null || v === "" ? null : String(v);
}

// Desde la forma de sportsDataProvider.normalizeEvent (el camino de
// TheSportsDB, el que hoy está en producción).
function fromProviderEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const parts = Array.isArray(ev.participants) ? ev.participants : [];
  const side = (role) => {
    const p = parts.find((x) => x && x.role === role);
    if (!p) return null;
    const id = str(p.externalId);
    const name = p.name || null;
    // Sin id NI nombre no hay participante que representar: null es "todavía no
    // se sabe", que es una respuesta legítima y distinta de inventar uno.
    return id || name ? { id, name } : null;
  };
  return {
    providerFixtureId: str(ev.externalEventId),
    providerRoundId: str(ev.round),
    stageId: str(ev.stageId),
    kickoffAt: ev.dateTime || null,
    home: side("home"),
    away: side("away"),
    leg: ev.leg || null,
    status: ev.status || null,
  };
}

// Desde la forma de sportsDomain.makeEvent (la capa de dominio, que es por
// donde entra Sportmonks).
function fromDomainEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const comps = Array.isArray(ev.competitors) ? ev.competitors : [];
  const side = (role) => {
    const c = comps.find((x) => x && x.role === role);
    if (!c) return null;
    const id = str(c.providerCompetitorId);
    const name = c.name || null;
    return id || name ? { id, name } : null;
  };
  return {
    providerFixtureId: str(ev.providerEventId),
    providerRoundId: str(ev.providerRoundId),
    stageId: str(ev.stageId),
    kickoffAt: ev.startsAt || null,
    home: side("home"),
    away: side("away"),
    leg: ev.leg || null,
    status: ev.status || null,
  };
}

// ---- diagnósticos ----------------------------------------------------------
//
// DATA-004C §G: no se acepta pérdida silenciosa. Todo fixture que no acabe
// donde debería deja un motivo estructurado. `round_id = null` NO está en esta
// lista a propósito: no es un error ni un motivo de descarte.
const DIAGNOSTIC = Object.freeze({
  MISSING_FIXTURE_ID: "missing_fixture_id",
  DUPLICATE_FIXTURE_ID: "duplicate_fixture_id",
  MISSING_KICKOFF: "missing_kickoff",
  MALFORMED_KICKOFF: "malformed_kickoff",
  ROUND_NUMBER_TAKEN: "round_number_taken",
  // Un fixture que se guardó sin ronda y que el proveedor ahora SÍ ubica en
  // una. Su metadata se actualiza, pero convertirlo en jornada es una decisión
  // de producto (DATA-004D), no algo que el sync deba hacer por su cuenta. Se
  // reporta para que no quede atascado en silencio.
  STAGED_GAINED_ROUND: "staged_gained_round",
  LOCKED_BY_RESULTS: "locked_by_results",
  KICKOFF_PAST_DEADLINE: "kickoff_past_deadline",
});

// Los campos de un partido que pertenecen al PROVEEDOR. Todo lo demás
// (`id`, `results`, `resultsPublished`, `published`, `deadline`) es de QRACKS y
// una actualización no lo toca jamás: reemplazar el objeto entero es como se
// borra el trabajo del Admin sin querer.
const PROVIDER_OWNED_MATCH_FIELDS = Object.freeze([
  "teamA", "teamB", "externalHomeId", "externalAwayId", "kickoffAt",
]);

function kickoffMs(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

// Orden determinístico y estable: kickoff primero, y el id del fixture como
// desempate. Sin el desempate, dos partidos a la misma hora quedarían en el
// orden en que el proveedor los mandó — que es exactamente la dependencia que
// este ticket prohíbe. Un fixture sin kickoff va al final, nunca al principio:
// no puede colarse delante de partidos con fecha conocida.
function compareFixtures(a, b) {
  const ta = kickoffMs(a.kickoffAt);
  const tb = kickoffMs(b.kickoffAt);
  if (ta !== tb) {
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta - tb;
  }
  return String(a.providerFixtureId).localeCompare(String(b.providerFixtureId));
}

// La proyección de un fixture a la forma de partido que guarda el tablero.
function matchFromFixture(fx) {
  return {
    teamA: (fx.home && fx.home.name) || "",
    teamB: (fx.away && fx.away.name) || "",
    externalEventId: fx.providerFixtureId,
    externalHomeId: (fx.home && fx.home.id) || null,
    externalAwayId: (fx.away && fx.away.id) || null,
    kickoffAt: fx.kickoffAt || null,
  };
}

// ---- el planificador -------------------------------------------------------

function planCompetitionSync({ existingRounds, existingStaged, fixtures, events, provider } = {}) {
  const rounds = Array.isArray(existingRounds) ? existingRounds : [];
  const staged = Array.isArray(existingStaged) ? existingStaged : [];
  // `events` se sigue aceptando por compatibilidad con el camino vivo: son la
  // forma de sportsDataProvider y se convierten aquí. `fixtures` es la forma ya
  // normalizada. Nunca ambas.
  const incoming = Array.isArray(fixtures)
    ? fixtures.filter(Boolean)
    : (Array.isArray(events) ? events.map(fromProviderEvent).filter(Boolean) : []);

  const diagnostics = [];
  const note = (code, providerFixtureId, detail) => {
    diagnostics.push({ code, providerFixtureId: providerFixtureId || null, detail: detail || null });
  };

  // --- índice de identidad: todo fixture que YA conocemos, esté donde esté ---
  const knownInRounds = new Map();   // providerFixtureId -> { round, match }
  for (const r of rounds) {
    for (const m of (Array.isArray(r && r.matches) ? r.matches : [])) {
      const id = str(m && m.externalEventId);
      if (id && !knownInRounds.has(id)) knownInRounds.set(id, { round: r, match: m });
    }
  }
  const knownStaged = new Map();     // providerFixtureId -> fixture guardado
  for (const f of staged) {
    const id = str(f && f.providerFixtureId);
    if (id && !knownStaged.has(id)) knownStaged.set(id, f);
  }

  // Los números de jornada ya ocupados: una jornada existente SIEMPRE gana, sea
  // manual, heredada o de otro proveedor. Nunca se crea una segunda "Jornada N".
  const existingRoundNumbers = new Set(
    rounds.map((r) => Number(r && r.number)).filter((n) => Number.isFinite(n))
  );

  // --- pasada 1: identidad, deduplicación y orden ---------------------------
  const seenInBatch = new Set();
  const usable = [];
  for (const fx of incoming) {
    const id = str(fx.providerFixtureId);
    if (!id) {
      // Sin identidad no se puede ni crear ni actualizar sin arriesgar un
      // duplicado en el siguiente sync. Se descarta, pero NUNCA en silencio.
      note(DIAGNOSTIC.MISSING_FIXTURE_ID, null, fx.kickoffAt || null);
      continue;
    }
    if (seenInBatch.has(id)) {
      note(DIAGNOSTIC.DUPLICATE_FIXTURE_ID, id);
      continue;
    }
    seenInBatch.add(id);
    if (fx.kickoffAt && kickoffMs(fx.kickoffAt) == null) {
      note(DIAGNOSTIC.MALFORMED_KICKOFF, id, fx.kickoffAt);
    }
    usable.push({ ...fx, providerFixtureId: id });
  }
  usable.sort(compareFixtures);

  // --- pasada 2: conocidos -> actualización; nuevos -> creación o staging ----
  const matchUpdates = [];
  const stagedUpdates = [];
  const newStaged = [];
  const groups = new Map();   // providerRoundId -> [fixture]

  for (const fx of usable) {
    const id = fx.providerFixtureId;

    const inRound = knownInRounds.get(id);
    if (inRound) {
      const changes = {};
      const proposed = matchFromFixture(fx);
      for (const field of PROVIDER_OWNED_MATCH_FIELDS) {
        const next = proposed[field];
        // Un valor que el proveedor ya no manda NO borra lo que hay: sólo se
        // escribe lo que llega con contenido. Así un payload parcial no vacía
        // un partido que estaba completo.
        if (next == null || next === "") continue;
        if ((inRound.match[field] == null ? null : inRound.match[field]) === next) continue;
        changes[field] = next;
      }
      if (Object.keys(changes).length === 0) continue;   // idempotente: nada que hacer

      // Una jornada con resultados publicados es historia de puntuación. El
      // proveedor puede seguir corrigiendo nombres o fechas, pero cambiar los
      // equipos debajo de un resultado ya publicado reescribiría el sentido de
      // los picks que ya se puntuaron. Se reporta y no se aplica.
      if (inRound.round && inRound.round.resultsPublished) {
        const teamChange = ["teamA", "teamB", "externalHomeId", "externalAwayId"].some((f) => f in changes);
        if (teamChange) {
          note(DIAGNOSTIC.LOCKED_BY_RESULTS, id, inRound.round.number);
          for (const f of ["teamA", "teamB", "externalHomeId", "externalAwayId"]) delete changes[f];
          if (Object.keys(changes).length === 0) continue;
        }
      }
      // El deadline de la jornada es de QRACKS: el Admin pudo fijarlo, y moverlo
      // solo abriría o cerraría votaciones sin que nadie lo pidiera. Si el
      // partido se corre más allá del cierre, se avisa; no se toca.
      if ("kickoffAt" in changes && inRound.round && inRound.round.deadline) {
        const dl = kickoffMs(inRound.round.deadline);
        const ko = kickoffMs(changes.kickoffAt);
        if (dl != null && ko != null && ko > dl) {
          note(DIAGNOSTIC.KICKOFF_PAST_DEADLINE, id, inRound.round.number);
        }
      }
      matchUpdates.push({ roundId: inRound.round && inRound.round.id, matchId: inRound.match.id, changes });
      continue;
    }

    const inStaged = knownStaged.get(id);
    if (inStaged) {
      const changes = {};
      for (const key of ["providerRoundId", "stageId", "kickoffAt", "leg", "status"]) {
        const next = fx[key] == null ? null : fx[key];
        if (next == null) continue;
        if (JSON.stringify(inStaged[key] == null ? null : inStaged[key]) === JSON.stringify(next)) continue;
        changes[key] = next;
      }
      for (const key of ["home", "away"]) {
        const next = fx[key] || null;
        if (!next) continue;   // "todavía no se sabe" nunca borra lo que ya se sabía
        if (JSON.stringify(inStaged[key] || null) === JSON.stringify(next)) continue;
        changes[key] = next;
      }
      if ("providerRoundId" in changes && inStaged.providerRoundId == null) {
        note(DIAGNOSTIC.STAGED_GAINED_ROUND, id, changes.providerRoundId);
      }
      if (Object.keys(changes).length) stagedUpdates.push({ providerFixtureId: id, changes });
      continue;
    }

    // Nuevo. Con ronda va a jornada; sin ronda, a staging — y sin ronda NO es
    // un error, es la fase final.
    if (fx.providerRoundId == null) { newStaged.push(fx); continue; }
    // Una jornada necesita un cierre, y un cierre se siembra del kickoff. Sin
    // kickoff no se inventa uno: el fixture se conserva en staging, con motivo.
    if (kickoffMs(fx.kickoffAt) == null) {
      note(DIAGNOSTIC.MISSING_KICKOFF, id, fx.providerRoundId);
      newStaged.push(fx);
      continue;
    }
    if (!groups.has(fx.providerRoundId)) groups.set(fx.providerRoundId, []);
    groups.get(fx.providerRoundId).push(fx);
  }

  // --- pasada 3: jornadas nuevas -------------------------------------------
  //
  // Los grupos se recorren en orden de KICKOFF, no en el orden en que el
  // proveedor los mandó. Ése era el otro fallo de orden: con las etiquetas no
  // numéricas el número de jornada salía del orden de llegada, así que un
  // calendario entregado al revés dejaba la Final como jornada 1.
  const orderedGroups = [...groups.entries()].sort((a, b) => compareFixtures(a[1][0], b[1][0]));
  let nextFallbackNumber = Math.max(0, ...rounds.map((r) => Number(r && r.number) || 0)) + 1;
  const newRounds = [];

  for (const [externalRoundId, evs] of orderedGroups) {
    const isNumeric = /^[0-9]+$/.test(externalRoundId);
    if (isNumeric && existingRoundNumbers.has(Number(externalRoundId))) {
      note(DIAGNOSTIC.ROUND_NUMBER_TAKEN, null, externalRoundId);
      continue;
    }
    evs.sort(compareFixtures);
    const matches = evs.map(matchFromFixture);
    const earliest = Math.min(...evs.map((e) => kickoffMs(e.kickoffAt)).filter((t) => t != null));
    const number = isNumeric ? Number(externalRoundId) : nextFallbackNumber++;
    if (!isNumeric) existingRoundNumbers.add(number);
    newRounds.push({
      number,
      matches,
      deadline: new Date(earliest).toISOString(),
      results: {},
      resultsPublished: false,
      published: false,   // preparada, todavía no visible para participantes
      provider,
      externalRoundId,
    });
  }

  newStaged.sort(compareFixtures);

  return {
    newRounds,
    // Fixtures válidos que todavía no son jornada. Se conservan enteros para
    // que DATA-004D decida cómo mostrarlos, sin haber perdido nada por el camino.
    stagedFixtures: newStaged.map((fx) => ({
      providerFixtureId: fx.providerFixtureId,
      providerRoundId: fx.providerRoundId || null,
      stageId: fx.stageId || null,
      kickoffAt: fx.kickoffAt || null,
      home: fx.home || null,
      away: fx.away || null,
      leg: fx.leg || null,
      status: fx.status || null,
      provider: provider || null,
    })),
    matchUpdates,
    stagedUpdates,
    diagnostics,
    // Compat: cuántos fixtures no se pudieron usar en absoluto. Ya NO cuenta los
    // que vienen sin ronda — ésos se conservan.
    skippedEvents: diagnostics.filter(
      (d) => d.code === DIAGNOSTIC.MISSING_FIXTURE_ID || d.code === DIAGNOSTIC.DUPLICATE_FIXTURE_ID
    ).length,
  };
}

module.exports = {
  planCompetitionSync,
  fromProviderEvent,
  fromDomainEvent,
  compareFixtures,
  DIAGNOSTIC,
  PROVIDER_OWNED_MATCH_FIELDS,
};
