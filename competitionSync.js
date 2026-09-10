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

// ---- la identidad lógica de un partido (QA Correction 02) -----------------
//
// El contrato aprobado siempre dijo `provider + providerFixtureId`, y el código
// sólo usaba el id. Dos proveedores pueden repartir el mismo número: en cuanto
// TheSportsDB y Sportmonks conviven —o uno hace de respaldo del otro— un
// fixture `123` de Sportmonks podía ACTUALIZAR un `123` de TheSportsDB,
// conservando el id interno del partido y, con él, los picks del partido
// equivocado. Corrupción silenciosa, y del peor tipo: todo sigue pareciendo
// correcto.
//
// El separador es "|" porque ningún nombre de proveedor lo contiene, y aun así
// se comprueba: si un proveedor lo llevara, la clave dejaría de ser inyectiva y
// dos partidos distintos podrían colisionar. Ante eso no hay clave que valga.
function identityKey(provider, providerFixtureId) {
  const p = str(provider);
  const id = str(providerFixtureId);
  if (!p || !id || p.includes("|")) return null;
  return `${p}|${id}`;
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
    provider: str(ev.provider),
    providerFixtureId: str(ev.externalEventId),
    providerRoundId: str(ev.round),
    stageId: str(ev.stageId),
    stageName: ev.stageName || null,
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
    provider: str(ev.provider),
    providerFixtureId: str(ev.providerEventId),
    providerRoundId: str(ev.providerRoundId),
    stageId: str(ev.stageId),
    // SÓLO para mostrar. Nunca entra en una clave de agrupación ni en una
    // identidad: un nombre de fase se renombra, se traduce y se localiza.
    stageName: ev.stageName || null,
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
// ---- agrupación de fixtures en jornadas (DATA-004 Paso C) ------------------
//
// QRACKS enseña JORNADAS, no partidos sueltos, y la fase final llega sin
// `round_id` en 27 de 337 fixtures reales. Así que hace falta agrupar sin que
// el proveedor nos dé el grupo — y sin inventarlo a partir de nombres humanos,
// que se renombran, se traducen y no son identidad de nada.
//
// Las señales, en orden:
//
//   1. La ronda del proveedor, cuando existe. Es la respuesta y no se discute.
//   2. stage + número de leg. Estructural y suficiente para la realidad
//      observada: la ida de Cuartos y la vuelta de Cuartos son el mismo stage
//      y legs distintos, que es exactamente como se juegan — en semanas
//      distintas, con votaciones que cierran por separado.
//   3. Dentro de eso, agrupación temporal: un hueco grande entre partidos del
//      mismo stage y leg significa jornadas distintas.
//
// Nunca se agrupa por nombre de fase, por equipos ni por parecido.
//
// El único número ajustable de todo el módulo. Una jornada de futbol es una
// ventana de días consecutivos (Liga MX regular juega viernes a domingo; la
// ida de Cuartos, miércoles y jueves). Un hueco mayor que esto ya no es la
// misma jornada. Se aplica SÓLO como señal de agrupación, jamás como identidad:
// equivocarse aquí parte o junta una jornada, cosa que el Admin ve y puede
// corregir — nunca corrompe un pick ni un resultado.
const CLUSTER_GAP_MS = 4 * 24 * 60 * 60 * 1000;

// La clave estructural de un fixture. `null` significa "no se puede agrupar con
// seguridad", que es una respuesta legítima y acaba en staging con diagnóstico.
function groupKeyOf(fx) {
  if (fx.providerRoundId != null) return `round:${fx.providerRoundId}`;
  if (fx.stageId == null) return null;
  const legNumber = fx.leg && Number.isSafeInteger(fx.leg.number) ? fx.leg.number : "none";
  return `stage:${fx.stageId}:leg:${legNumber}`;
}

// Parte un grupo en ventanas temporales. Los fixtures ya llegan ordenados por
// kickoff, así que basta con mirar el hueco contra el anterior.
function splitIntoClusters(fixtures) {
  const clusters = [];
  let current = null;
  let lastMs = null;
  for (const fx of fixtures) {
    const ms = kickoffMs(fx.kickoffAt);
    if (current === null || ms == null || lastMs == null || ms - lastMs > CLUSTER_GAP_MS) {
      current = [];
      clusters.push(current);
    }
    current.push(fx);
    if (ms != null) lastMs = ms;
  }
  return clusters;
}

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
  // No hay ni ronda ni stage: no existe señal estructural con la que agrupar
  // este partido sin inventarse algo.
  UNGROUPABLE: "ungroupable_fixture",
  // Un partido nuevo pertenece a una jornada que ya tiene resultados
  // publicados: meterlo dentro reescribiría una jornada ya puntuada.
  ROUND_ALREADY_SCORED: "round_already_scored",
  // Un partido nuevo pertenece a una jornada cuya votación ya cerró. Añadirlo
  // sería pedir un pronóstico que nadie pudo hacer.
  ROUND_ALREADY_CLOSED: "round_already_closed",
  // Un partido histórico con id externo del que no se puede demostrar de qué
  // proveedor vino. No se actualiza por coincidencia de id: se reporta.
  UNATTRIBUTABLE_FIXTURE: "unattributable_fixture",
  // El mismo id externo existe ya bajo OTRO proveedor. No son el mismo partido
  // y no se fusionan; se dice, porque visto desde fuera se parecen.
  CROSS_PROVIDER_ID: "cross_provider_id",
  LOCKED_BY_RESULTS: "locked_by_results",
  KICKOFF_PAST_DEADLINE: "kickoff_past_deadline",
});

// Los campos de un partido que pertenecen al PROVEEDOR. Todo lo demás
// (`id`, `results`, `resultsPublished`, `published`, `deadline`) es de QRACKS y
// una actualización no lo toca jamás: reemplazar el objeto entero es como se
// borra el trabajo del Admin sin querer.
const PROVIDER_OWNED_MATCH_FIELDS = Object.freeze([
  "teamA", "teamB", "externalHomeId", "externalAwayId", "kickoffAt",
  // La otra mitad de la identidad. Está aquí para que un partido heredado —que
  // sólo guardaba el id— la GANE la primera vez que su proveedor se demuestra
  // por la jornada que lo importó. Es aditivo y no destruye nada: sólo se
  // escribe cuando falta, y sólo con el proveedor con el que ya se encontró el
  // partido, así que no puede cambiarlo por otro.
  "externalProvider",
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
    // Persistido JUNTO al id externo, no deducido después: es la mitad de la
    // identidad, y sin él una recarga de la base no puede reconstruirla.
    externalProvider: fx.provider || null,
    externalHomeId: (fx.home && fx.home.id) || null,
    externalAwayId: (fx.away && fx.away.id) || null,
    kickoffAt: fx.kickoffAt || null,
  };
}

const TEAM_IDENTITY_FIELDS = Object.freeze(["teamA", "teamB", "externalHomeId", "externalAwayId"]);

// ¿Este cambio de equipos REESCRIBE lo que significaban los pronósticos ya
// echados, o sólo RELLENA lo que no se sabía? (QA Correction 03)
//
// Un pick guardado es "A" o "B": un LADO, no un equipo. Mientras el lado no
// cambie de dueño, el pick sigue significando lo mismo.
//
//   asignar     — el partido no tenía equipos conocidos (una semifinal "Por
//                 definir") y ahora sí. Quien apostó por "A" apostó por quien
//                 acabara en A: enterarse de quién es no le cambia la apuesta.
//   reasignar   — el lado A ya tenía dueño y ahora tiene otro. Es el caso real
//                 de una vuelta de Liguilla o un cambio de sede: `teamA` y
//                 `teamB` se intercambian, y cada "A" guardado pasa a apuntar
//                 al equipo contrario sin que nadie vea nada raro.
//
// Se decide por los ids del proveedor, que es identidad de verdad. Cuando no
// hay ids en lo guardado —partidos heredados— queda una última comprobación:
// si el par propuesto es el par guardado TRANSPUESTO, es una inversión. Es
// igualdad exacta de cadenas, no emparejamiento por nombre: no deduce identidad,
// sólo se niega a aplicar algo que se ve exactamente como una inversión.
function rewritesPickMeaning(before, proposed) {
  const s = (v) => (v == null || v === "" ? null : String(v));
  const wasHome = s(before.externalHomeId);
  const wasAway = s(before.externalAwayId);
  const nowHome = s(proposed.externalHomeId);
  const nowAway = s(proposed.externalAwayId);

  if (wasHome && nowHome && wasHome !== nowHome) return true;
  if (wasAway && nowAway && wasAway !== nowAway) return true;
  if (wasHome || wasAway) return false;   // el lado que ya tenía dueño lo conserva

  const wasA = s(before.teamA);
  const wasB = s(before.teamB);
  const nowA = s(proposed.teamA);
  const nowB = s(proposed.teamB);
  if (wasA && wasB && nowA && nowB && wasA === nowB && wasB === nowA) return true;
  return false;
}

// ---- el planificador -------------------------------------------------------

function planCompetitionSync({ existingRounds, existingStaged, fixtures, events, provider, now } = {}) {
  const nowMs = Number.isFinite(now) ? now : Date.now();
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
  //
  // Indexado por `provider|id`, nunca por el id solo. Y como también hay que
  // poder RESPONDER a "¿existe ya este id bajo otro proveedor?", se lleva un
  // índice secundario por id: no para actualizar por él —eso es justo lo que
  // este arreglo prohíbe— sino para poder decirlo.
  const knownInRounds = new Map();   // provider|id -> { round, match }
  const idsInRounds = new Map();     // id -> Set(provider)
  // Partidos históricos con id externo y sin proveedor demostrable. No se
  // actualizan por coincidencia de id; se listan para poder reportarlos.
  const unattributableIds = new Set();
  for (const r of rounds) {
    for (const m of (Array.isArray(r && r.matches) ? r.matches : [])) {
      const id = str(m && m.externalEventId);
      if (!id) continue;
      // LEGACY. Los partidos importados antes de este arreglo no llevan
      // `externalProvider`. La jornada SÍ registra qué proveedor la importó, y
      // ése es un vínculo persistido e inequívoco: el sync que la creó puso su
      // propio nombre ahí. Cuando ni el partido ni su jornada lo dicen, el
      // proveedor no se puede demostrar y no se adivina.
      const prov = str(m.externalProvider) || str(r && r.provider);
      if (!prov) { unattributableIds.add(id); continue; }
      if (!idsInRounds.has(id)) idsInRounds.set(id, new Set());
      idsInRounds.get(id).add(prov);
      const key = identityKey(prov, id);
      if (key && !knownInRounds.has(key)) knownInRounds.set(key, { round: r, match: m });
    }
  }
  const knownStaged = new Map();     // provider|id -> fixture guardado
  const idsStaged = new Map();       // id -> Set(provider)
  for (const f of staged) {
    const id = str(f && f.providerFixtureId);
    const prov = str(f && f.provider);
    if (!id || !prov) continue;
    if (!idsStaged.has(id)) idsStaged.set(id, new Set());
    idsStaged.get(id).add(prov);
    const key = identityKey(prov, id);
    if (key && !knownStaged.has(key)) knownStaged.set(key, f);
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
    // El proveedor del propio fixture manda; el del sync es el respaldo, porque
    // un lote siempre viene de una importación concreta.
    const prov = str(fx.provider) || str(provider);
    const key = identityKey(prov, id);
    if (!key) {
      // Sin identidad COMPLETA no se puede ni crear ni actualizar sin arriesgar
      // un duplicado —o algo peor— en el siguiente sync. Se descarta, pero
      // NUNCA en silencio.
      note(DIAGNOSTIC.MISSING_FIXTURE_ID, id, fx.kickoffAt || null);
      continue;
    }
    // La deduplicación del lote también es por identidad completa: dos
    // proveedores con el mismo número son dos partidos, no uno repetido.
    if (seenInBatch.has(key)) {
      note(DIAGNOSTIC.DUPLICATE_FIXTURE_ID, id);
      continue;
    }
    seenInBatch.add(key);
    if (fx.kickoffAt && kickoffMs(fx.kickoffAt) == null) {
      note(DIAGNOSTIC.MALFORMED_KICKOFF, id, fx.kickoffAt);
    }
    usable.push({ ...fx, providerFixtureId: id, provider: prov, identityKey: key });
  }
  usable.sort(compareFixtures);

  // --- pasada 2: conocidos -> actualización; nuevos -> creación o staging ----
  const matchUpdates = [];
  const candidates = [];

  for (const fx of usable) {
    const id = fx.providerFixtureId;
    const key = fx.identityKey;

    // El mismo número ya existe bajo OTRO proveedor. No son el mismo partido y
    // no se fusionan —eso era el P1—, pero visto desde fuera se parecen, así
    // que se dice.
    const otrosEnJornadas = idsInRounds.get(id);
    const otrosEnEspera = idsStaged.get(id);
    const hayOtroProveedor =
      (otrosEnJornadas && [...otrosEnJornadas].some((p) => p !== fx.provider)) ||
      (otrosEnEspera && [...otrosEnEspera].some((p) => p !== fx.provider));
    if (hayOtroProveedor) note(DIAGNOSTIC.CROSS_PROVIDER_ID, id, fx.provider);
    // Un partido histórico con este mismo id y sin proveedor demostrable. No se
    // actualiza por coincidencia de id: eso es exactamente lo que corrompe.
    if (unattributableIds.has(id)) note(DIAGNOSTIC.UNATTRIBUTABLE_FIXTURE, id, null);

    const inRound = knownInRounds.get(key);
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

      // Los equipos de un partido se congelan en cuanto los pronósticos dejan de
      // poder cambiar. Son dos momentos, y los dos importan:
      //
      //   resultsPublished — la jornada ya es historia de puntuación. Cambiar
      //                      los equipos debajo de un resultado publicado
      //                      reescribe el sentido de picks YA puntuados.
      //   cierre pasado    — QA Correction 03. Los picks están echados y ya no
      //                      se pueden corregir, pero todavía no se puntúan. Si
      //                      el proveedor invierte la localía —cosa que pasa de
      //                      verdad en una vuelta de Liguilla o con un cambio de
      //                      sede—, `teamA` y `teamB` se intercambian y cada "A"
      //                      guardado pasa a significar el OTRO equipo. Nadie ve
      //                      nada raro: se paga al equivocado.
      //
      // Con la votación abierta sí se aplica, y debe aplicarse: ahí corregir el
      // partido es información que el participante todavía puede usar.
      const roundDl = kickoffMs(inRound.round && inRound.round.deadline);
      const scored = !!(inRound.round && inRound.round.resultsPublished);
      const picksFrozen = scored ||
        !!(inRound.round && inRound.round.published && roundDl != null && roundDl <= nowMs);
      const teamChange = TEAM_IDENTITY_FIELDS.some((f) => f in changes);
      // Con resultados publicados la jornada es historia y no se toca nada de los
      // equipos, ni siquiera para rellenar. Con los picks congelados pero sin
      // puntuar, se permite ENTERARSE de quién juega y se prohíbe CAMBIARLO.
      if (teamChange && picksFrozen && (scored || rewritesPickMeaning(inRound.match, proposed))) {
        note(DIAGNOSTIC.LOCKED_BY_RESULTS, id, inRound.round.number);
        for (const f of TEAM_IDENTITY_FIELDS) delete changes[f];
        if (Object.keys(changes).length === 0) continue;
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

    // Ya estaba en staging. La información nueva se funde sobre la guardada y
    // el resultado vuelve a intentar colocarse en una jornada: es así como un
    // cruce que llegó sin rival acaba, semanas después, dentro de una jornada
    // real. "Todavía no se sabe" nunca pisa "ya se sabe".
    const inStaged = knownStaged.get(key);
    if (inStaged) {
      const changes = {};
      for (const key of ["providerRoundId", "stageId", "stageName", "kickoffAt", "leg", "status"]) {
        const next = fx[key] == null ? null : fx[key];
        if (next == null) continue;
        if (JSON.stringify(inStaged[key] == null ? null : inStaged[key]) === JSON.stringify(next)) continue;
        changes[key] = next;
      }
      for (const key of ["home", "away"]) {
        const next = fx[key] || null;
        if (!next) continue;
        if (JSON.stringify(inStaged[key] || null) === JSON.stringify(next)) continue;
        changes[key] = next;
      }
      const merged = { ...inStaged, ...changes, providerFixtureId: id };
      if ("providerRoundId" in changes && inStaged.providerRoundId == null) {
        note(DIAGNOSTIC.STAGED_GAINED_ROUND, id, changes.providerRoundId);
      }
      candidates.push({ fixture: merged, fromStagedId: key, stagedChanges: changes });
      continue;
    }

    candidates.push({ fixture: fx, fromStagedId: null, stagedChanges: null });
  }

  // --- pasada 3: agrupación ------------------------------------------------
  //
  // Aquí es donde un fixture sin `round_id` deja de ser un problema. La clave
  // es estructural —ronda del proveedor, o stage + leg, partido en ventanas
  // temporales— y nunca sale de un nombre humano.
  const stagedUpdates = [];
  const newStaged = [];
  const groupable = [];

  for (const c of candidates) {
    const fx = c.fixture;
    const key = groupKeyOf(fx);
    const hasKickoff = kickoffMs(fx.kickoffAt) != null;
    if (key === null) {
      // Ni ronda ni stage: no hay con qué agrupar sin inventarse algo.
      note(DIAGNOSTIC.UNGROUPABLE, fx.providerFixtureId, null);
    } else if (!hasKickoff) {
      // Una jornada necesita un cierre, y el cierre se siembra del kickoff.
      note(DIAGNOSTIC.MISSING_KICKOFF, fx.providerFixtureId, key);
    } else {
      groupable.push({ ...c, key });
      continue;
    }
    // No se pudo colocar: se conserva. Si venía de staging, sólo se actualiza.
    if (c.fromStagedId && c.stagedChanges && Object.keys(c.stagedChanges).length) {
      stagedUpdates.push({
        providerFixtureId: fx.providerFixtureId, provider: fx.provider,
        identityKey: c.fromStagedId, changes: c.stagedChanges,
      });
    } else if (!c.fromStagedId) {
      newStaged.push(fx);
    }
  }

  // Qué jornada existente es dueña de cada clave. Las jornadas importadas antes
  // de DATA-004 no llevan `syncGroupKey`, pero su `externalRoundId` produce
  // exactamente la misma clave — así que la compatibilidad sale sola, sin
  // migrar nada.
  // Una MISMA clave puede tener varias jornadas: el mismo stage y leg jugados en
  // dos semanas distintas son dos días de partidos. Por eso es una lista y no un
  // único dueño, y por eso el dueño se decide además por cercanía en el tiempo.
  const roundsByGroupKey = new Map();
  for (const r of rounds) {
    if (!r) continue;
    const key = r.syncGroupKey || (r.externalRoundId != null ? `round:${r.externalRoundId}` : null);
    if (!key) continue;
    if (!roundsByGroupKey.has(key)) roundsByGroupKey.set(key, []);
    roundsByGroupKey.get(key).push(r);
  }
  // ¿A qué jornada existente pertenece este partido? A la de su clave que se
  // juega en su misma ventana. Una clave de ronda del proveedor no necesita
  // ventana: la ronda YA es el grupo.
  function ownerFor(key, fx) {
    const candidates = roundsByGroupKey.get(key);
    if (!candidates || !candidates.length) return null;
    if (key.startsWith("round:")) return candidates[0];
    const ms = kickoffMs(fx.kickoffAt);
    if (ms == null) return null;
    for (const r of candidates) {
      const times = (r.matches || []).map((m) => kickoffMs(m && m.kickoffAt)).filter((t) => t != null);
      const ref = times.length ? times : [kickoffMs(r.deadline)].filter((t) => t != null);
      if (!ref.length) continue;
      if (ref.some((t) => Math.abs(t - ms) <= CLUSTER_GAP_MS)) return r;
    }
    return null;
  }

  const byKey = new Map();
  for (const c of groupable) {
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key).push(c);
  }

  // --- pasada 4: jornadas nuevas y partidos añadidos ------------------------
  //
  // Los grupos se recorren en orden de KICKOFF, nunca en el orden en que el
  // proveedor los mandó: entregado al revés, ese orden dejaba la Final como
  // jornada 1.
  const matchAdditions = [];
  const promotedStagedIds = [];
  const newRounds = [];
  // El siguiente número LIBRE, no simplemente el siguiente. Cuenta también las
  // jornadas creadas en ESTE mismo lote: sin saltar los ya tomados, un
  // calendario con jornadas 1 y 2 numéricas y una fase final sin ronda producía
  // dos "Jornada 1" — dos jornadas distintas con el mismo nombre para el
  // participante, y un choque de numeración imposible de deshacer después.
  let nextFallbackNumber = Math.max(0, ...rounds.map((r) => Number(r && r.number) || 0)) + 1;
  const takeNextNumber = () => {
    while (existingRoundNumbers.has(nextFallbackNumber)) nextFallbackNumber += 1;
    return nextFallbackNumber++;
  };

  const orderedKeys = [...byKey.entries()].sort((a, b) => compareFixtures(a[1][0].fixture, b[1][0].fixture));

  for (const [key, members] of orderedKeys) {
    members.sort((a, b) => compareFixtures(a.fixture, b.fixture));

    // Los que pertenecen a una jornada que YA existe se añaden a ella; crear otra
    // sería partir el mismo día de partidos en dos jornadas distintas.
    const sinDueño = [];
    for (const c of members) {
      const owner = ownerFor(key, c.fixture);
      if (!owner) { sinDueño.push(c); continue; }
      if (owner.resultsPublished) {
        note(DIAGNOSTIC.ROUND_ALREADY_SCORED, c.fixture.providerFixtureId, owner.number);
        if (!c.fromStagedId) newStaged.push(c.fixture);
        continue;
      }
      // Añadir un partido a una jornada cuya votación ya cerró es pedir un
      // pronóstico que nadie pudo hacer. Se reporta y se conserva aparte.
      const dl = kickoffMs(owner.deadline);
      if (owner.published && dl != null && dl <= nowMs) {
        note(DIAGNOSTIC.ROUND_ALREADY_CLOSED, c.fixture.providerFixtureId, owner.number);
        if (!c.fromStagedId) newStaged.push(c.fixture);
        continue;
      }
      matchAdditions.push({ roundId: owner.id, match: matchFromFixture(c.fixture) });
      if (c.fromStagedId) promotedStagedIds.push(c.fromStagedId);
    }
    if (!sinDueño.length) continue;

    // Jornada nueva. Se parte en ventanas temporales: el mismo stage y leg
    // jugados con una semana de diferencia son dos jornadas, no una.
    //
    // El índice va por REFERENCIA al objeto fixture, no por `providerFixtureId`:
    // dos proveedores pueden traer el mismo número en la misma clave de grupo, y
    // buscar por número promovería el fixture equivocado desde staging.
    const candByFixture = new Map(sinDueño.map((c) => [c.fixture, c]));
    for (const cluster of splitIntoClusters(sinDueño.map((c) => c.fixture))) {
      const providerRoundId = cluster[0].providerRoundId;
      const isNumeric = providerRoundId != null && /^[0-9]+$/.test(providerRoundId);
      if (isNumeric && existingRoundNumbers.has(Number(providerRoundId))) {
        // Estos partidos NO se conservan aparte, y es deliberado: una jornada
        // existente con ese número ya los cubre (el Admin la creó a mano, o es
        // heredada). Guardarlos como "pendientes" le diría para siempre que
        // cinco partidos necesitan su atención cuando ya los tiene. El
        // diagnóstico lo dice una vez; eso es observabilidad, no ruido.
        note(DIAGNOSTIC.ROUND_NUMBER_TAKEN, null, providerRoundId);
        continue;
      }
      const number = isNumeric ? Number(providerRoundId) : takeNextNumber();
      existingRoundNumbers.add(number);
      const earliest = Math.min(...cluster.map((e) => kickoffMs(e.kickoffAt)).filter((t) => t != null));
      newRounds.push({
        number,
        matches: cluster.map(matchFromFixture),
        deadline: new Date(earliest).toISOString(),
        results: {},
        resultsPublished: false,
        published: false,   // preparada, todavía no visible para participantes
        provider,
        externalRoundId: providerRoundId == null ? null : providerRoundId,
        // La clave BASE, sin índice de ventana. Dos jornadas pueden compartirla
        // —el mismo stage y leg en dos semanas— y ownerFor() las distingue por
        // cercanía en el tiempo. Con un índice, un partido que llegara después
        // no habría encontrado a su jornada y habría fundado una duplicada.
        syncGroupKey: key,
        // Etiqueta del proveedor, SÓLO para mostrar. Nunca identidad.
        phaseLabel: cluster[0].stageName || null,
      });
      for (const fx of cluster) {
        const c = candByFixture.get(fx);
        if (c && c.fromStagedId) promotedStagedIds.push(c.fromStagedId);
      }
    }
  }

  newStaged.sort(compareFixtures);

  return {
    newRounds,
    matchAdditions,
    // Fixtures válidos que no se pudieron colocar en ninguna jornada. Se
    // conservan enteros: ninguno desaparece por no encajar.
    stagedFixtures: newStaged.map((fx) => ({
      providerFixtureId: fx.providerFixtureId,
      providerRoundId: fx.providerRoundId || null,
      stageId: fx.stageId || null,
      stageName: fx.stageName || null,
      kickoffAt: fx.kickoffAt || null,
      home: fx.home || null,
      away: fx.away || null,
      leg: fx.leg || null,
      status: fx.status || null,
      // El proveedor del fixture, no el del sync: la identidad tiene que
      // sobrevivir intacta a una recarga de la base.
      provider: fx.provider || provider || null,
    })),
    promotedStagedIds,
    matchUpdates,
    stagedUpdates,
    diagnostics,
    // Compat: cuántos fixtures no se pudieron usar en absoluto. NO cuenta los
    // que vienen sin ronda — ésos ya son jornada.
    skippedEvents: diagnostics.filter(
      (d) => d.code === DIAGNOSTIC.MISSING_FIXTURE_ID || d.code === DIAGNOSTIC.DUPLICATE_FIXTURE_ID
    ).length,
  };
}

module.exports = {
  planCompetitionSync,
  identityKey,
  fromProviderEvent,
  fromDomainEvent,
  compareFixtures,
  DIAGNOSTIC,
  PROVIDER_OWNED_MATCH_FIELDS,
};
