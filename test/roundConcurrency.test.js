// HOTFIX-001 — Round Concurrency & Billing Integrity.
//
// EL BUG, REPRODUCIDO CONTRA PostgreSQL 16 REAL ANTES DE ESTE TICKET:
//
//   1. Tab A carga la quiniela.
//   2. Tab B publica una jornada.
//   3. Tab A guarda cualquier cosa (un ajuste, el nombre del grupo).
//   4. El servidor responde 200 OK.
//   5. La jornada de B desaparece, y nada en la respuesta lo dice.
//
// No es un problema de Liguilla ni de sync: es la clase completa de lost
// updates sobre un campo que se reemplaza entero desde un snapshot que puede
// estar arbitrariamente atrasado. La misma forma destruye una jornada manual,
// revierte un deadline o un resultado ya publicado, y —como publicar es lo que
// consume presupuesto— deja plan.rounds.used cobrando una jornada que ya no
// existe.
//
// La protección de MON-002C (tournamentEpoch) es la defensa correcta anclada al
// evento equivocado: cuenta CIERRES, así que sólo protege el límite entre dos
// torneos. Todas las ediciones que importan ocurren DENTRO de un torneo, donde
// la época es constante y el guard nunca dispara.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const R = require("../roundsConcurrency");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === "/" && line[i + 1] === "/" && line[i - 1] !== ":") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

function blockFrom(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at !== -1, `no se encontró: ${marker}`);
  const braceStart = source.indexOf("{", at);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(at, i + 1); }
  }
  throw new Error(`bloque sin cerrar: ${marker}`);
}

const match = (id, over = {}) => ({ id, teamA: "A", teamB: "B", ...over });
const round = (id, over = {}) => ({
  id, number: 1, published: true, resultsPublished: false, results: {},
  deadline: "2026-12-01T00:00:00.000Z", matches: [match("m-" + id)], ...over,
});
const doc = (rounds, revision) => {
  const d = { groupName: "g", participants: [], rounds };
  if (revision !== undefined) d.roundsRevision = revision;
  return d;
};

// ==== 1. la firma: qué cuenta como "el mismo tablero" =======================

test("SIGNATURE: el orden de las claves NO es un cambio", () => {
  const a = [{ id: "r1", number: 1, published: true }];
  const b = [{ published: true, number: 1, id: "r1" }];
  assert.equal(R.sameRounds(a, b), true);
});

test("SIGNATURE: el orden de las JORNADAS sí es un cambio", () => {
  // Reordenar es algo que el Admin ve; una firma que lo ignorara dejaría que
  // una pestaña deshiciera en silencio el reordenamiento de otra.
  assert.equal(R.sameRounds([round("r1"), round("r2")], [round("r2"), round("r1")]), false);
});

test("SIGNATURE: cambiar un deadline, un resultado o un equipo es un cambio", () => {
  const base = [round("r1")];
  assert.equal(R.sameRounds(base, [round("r1", { deadline: "2027-01-01T00:00:00.000Z" })]), false);
  assert.equal(R.sameRounds(base, [round("r1", { results: { "m-r1": "A" } })]), false);
  assert.equal(R.sameRounds(base, [{ ...round("r1"), matches: [match("m-r1", { teamA: "Toluca" })] }]), false);
  assert.equal(R.sameRounds(base, [round("r1", { published: false })]), false);
});

test("SIGNATURE: ausente y vacío son el mismo tablero (una quiniela nueva no 'cambió')", () => {
  assert.equal(R.sameRounds(undefined, []), true);
  assert.equal(R.sameRounds(null, []), true);
});

// ==== 2. qué es una AFIRMACIÓN sobre el tablero =============================

test("STATEMENT: sólo un ARRAY afirma algo sobre el tablero", () => {
  assert.equal(R.statesRounds({ rounds: [] }), true);
  assert.equal(R.statesRounds({ rounds: [round("r1")] }), true);
  assert.equal(R.statesRounds({}), false);
  assert.equal(R.statesRounds({ rounds: null }), false);
  assert.equal(R.statesRounds({ rounds: "todas" }), false);
  assert.equal(R.statesRounds({ rounds: { 0: round("r1") } }), false);
  assert.equal(R.statesRounds({ rounds: 7 }), false);
});

test("STATEMENT: un payload que OMITE rounds conserva el tablero guardado", () => {
  // Antes de este ticket esto borraba el tablero entero y ponía roundCount en 0.
  const stored = doc([round("r1"), round("r2")], 3);
  const r = R.resolveRoundsWrite({ stored, incoming: { groupName: "otro" } });
  assert.equal(r.outcome, "no_statement");
  assert.equal(r.ok, true);
  assert.equal(r.rounds.length, 2);
});

test("STATEMENT: rounds:null tampoco es 'tablero vacío'", () => {
  const stored = doc([round("r1")], 1);
  const r = R.resolveRoundsWrite({ stored, incoming: { rounds: null, roundsRevision: 1 } });
  assert.equal(r.outcome, "no_statement");
  assert.equal(r.rounds.length, 1);
});

test("STATEMENT: rounds:[] desde un snapshot fresco SÍ vacía el tablero", () => {
  // Borrar es una acción legítima del producto y tiene que seguir siendo posible.
  const stored = doc([round("r1")], 4);
  const r = R.resolveRoundsWrite({ stored, incoming: doc([], 4) });
  assert.equal(r.outcome, "applied");
  assert.deepEqual(r.rounds, []);
});

// ==== 3. la regla central: quién puede reemplazar el tablero ================

test("CONFLICT: un snapshot atrasado NO puede borrar la jornada de otra pestaña", () => {
  const stored = doc([round("r1"), round("r2-de-B")], 5);   // B ya publicó
  const tabA = doc([round("r1")], 4);                        // A cargó antes
  const r = R.resolveRoundsWrite({ stored, incoming: tabA });
  assert.equal(r.outcome, "conflict");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "rounds_conflict");
  assert.equal(r.rounds.length, 2, "el tablero guardado es el que sobrevive");
});

test("CONFLICT: un snapshot atrasado tampoco puede REVERTIR un cambio", () => {
  // El caso que una regla basada en el conjunto de ids dejaría pasar entero:
  // los mismos ids, con el contenido viejo.
  const stored = doc([round("r1", { deadline: "2027-05-05T00:00:00.000Z" })], 2);
  const tabA = doc([round("r1")], 1);
  assert.equal(R.resolveRoundsWrite({ stored, incoming: tabA }).outcome, "conflict");
});

test("FRESH: un snapshot al día sí reemplaza el tablero", () => {
  const stored = doc([round("r1")], 7);
  const incoming = doc([round("r1"), round("r2")], 7);
  const r = R.resolveRoundsWrite({ stored, incoming });
  assert.equal(r.outcome, "applied");
  assert.equal(r.rounds.length, 2);
});

test("RETRY: el mismo tablero es un no-op, aunque la revisión ya esté vieja", () => {
  // Una petición reenviada tras perder la respuesta trae una revisión que ya
  // quedó atrás pero propone exactamente lo que ya está guardado. Tratarla como
  // conflicto sería un falso positivo; aplicarla dos veces sería doble consumo.
  const stored = doc([round("r1")], 9);
  const retry = doc([round("r1")], 8);
  const r = R.resolveRoundsWrite({ stored, incoming: retry });
  assert.equal(r.outcome, "unchanged");
  assert.equal(r.ok, true);
  assert.equal(r.rounds, stored.rounds, "gana la copia del servidor, no la del cliente");
});

test("CLAIM: no decir nada NO es estar al día", () => {
  const stored = doc([round("r1")], 3);
  const incoming = { rounds: [round("r1"), round("r2")] };   // sin roundsRevision
  assert.equal(R.resolveRoundsWrite({ stored, incoming }).outcome, "conflict");
});

test("CLAIM: una revisión basura nunca cuenta como haber visto el tablero", () => {
  const stored = doc([round("r1")], 3);
  for (const bad of [-1, "3", null, 1.5, NaN, Infinity, Number.MAX_VALUE, { v: 3 }, [], true]) {
    const incoming = { rounds: [round("r1"), round("r2")], roundsRevision: bad };
    assert.equal(
      R.resolveRoundsWrite({ stored, incoming }).outcome, "conflict",
      `roundsRevision=${JSON.stringify(bad)} no debe aceptarse`
    );
  }
});

test("CLAIM: una revisión del FUTURO falla cerrado", () => {
  // El servidor nunca emitió ese número, así que nadie pudo haberlo visto.
  const stored = doc([round("r1")], 3);
  const incoming = { rounds: [round("r1"), round("r2")], roundsRevision: 99 };
  assert.equal(R.resolveRoundsWrite({ stored, incoming }).outcome, "conflict");
});

test("CLAIM: 0 es una revisión legítima, no 'sin revisión'", () => {
  const stored = doc([round("r1")], 0);
  assert.equal(R.resolveRoundsWrite({ stored, incoming: doc([round("r1"), round("r2")], 0) }).outcome, "applied");
});

// ==== 4. filas legacy: proteger sin dejar a nadie encerrado ================

test("LEGACY: una fila nunca estampada adopta el primer tablero que recibe", () => {
  // Si no, su Admin queda encerrado: no hay revisión que haber visto, y
  // recargar no le da ninguna, así que ninguna edición entraría jamás.
  const stored = { groupName: "g", rounds: [round("r1")] };   // sin roundsRevision
  assert.equal(R.hasStoredRoundsRevision(stored), false);
  const r = R.resolveRoundsWrite({ stored, incoming: { rounds: [round("r1"), round("r2")] } });
  assert.equal(r.outcome, "adopted");
  assert.equal(r.ok, true);
  assert.equal(r.rounds.length, 2);
});

test("LEGACY: en cuanto está estampada, ya no adopta nada", () => {
  const stored = doc([round("r1")], 0);
  assert.equal(R.hasStoredRoundsRevision(stored), true);
  assert.equal(R.resolveRoundsWrite({ stored, incoming: { rounds: [] } }).outcome, "conflict");
});

test("LEGACY: la adopción NO es una puerta trasera reabrible por el cliente", () => {
  // El cliente no puede quitar el campo de la fila guardada: la fusión lo borra
  // del payload y el sello lo vuelve a poner en cada escritura.
  const merge = stripComments(serverSrc.slice(serverSrc.indexOf("function mergeProtectedMetaFields(")));
  assert.ok(merge.includes("delete merged.roundsRevision;"),
    "la revisión entrante debe descartarse antes de fusionar");
  assert.ok(/function stampRoundsRevision\(/.test(fs.readFileSync(path.join(__dirname, "..", "roundsConcurrency.js"), "utf8")));
});

// ==== 5. estados imposibles: fail closed ===================================

test("IDENTITY: dos jornadas con el mismo id se rechazan, no se de-duplican", () => {
  const r = R.validateRoundIdentity([round("dup"), round("dup", { number: 2 })]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "duplicate_round_id");
});

test("IDENTITY: dos partidos con el mismo id DENTRO de una jornada se rechazan", () => {
  const r = R.validateRoundIdentity([{ ...round("r1"), matches: [match("mm"), match("mm")] }]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "duplicate_match_id");
});

test("IDENTITY: el MISMO id de partido en jornadas distintas es legal", () => {
  // Los picks se guardan como { [roundId]: { [matchId]: ... } }, así que no hay
  // ambigüedad posible entre jornadas.
  const r = R.validateRoundIdentity([
    { ...round("r1"), matches: [match("m1")] },
    { ...round("r2"), matches: [match("m1")] },
  ]);
  assert.equal(r.ok, true);
});

test("IDENTITY: jornadas y partidos sin id, o malformados, se rechazan", () => {
  assert.equal(R.validateRoundIdentity([{ number: 1 }]).reason, "missing_round_id");
  assert.equal(R.validateRoundIdentity([{ ...round("r1"), matches: [{ teamA: "A" }] }]).reason, "missing_match_id");
  assert.equal(R.validateRoundIdentity([null]).reason, "malformed_round");
  assert.equal(R.validateRoundIdentity(["r1"]).reason, "malformed_round");
  assert.equal(R.validateRoundIdentity([{ ...round("r1"), matches: [null] }]).reason, "malformed_match");
});

test("IDENTITY: una jornada sin partidos todavía es legal (se está preparando)", () => {
  assert.equal(R.validateRoundIdentity([{ ...round("r1"), matches: [] }]).ok, true);
  assert.equal(R.validateRoundIdentity([]).ok, true);
});

test("IDENTITY: un tablero imposible se rechaza aunque la revisión esté al día", () => {
  // La frescura no vuelve seguro un id duplicado.
  const stored = doc([round("r1")], 2);
  const r = R.resolveRoundsWrite({ stored, incoming: doc([round("dup"), round("dup")], 2) });
  assert.equal(r.outcome, "invalid");
  assert.equal(r.ok, false);
  assert.equal(r.rounds.length, 1, "el tablero guardado no se toca");
});

// ==== 6. el sello: la revisión es del servidor ==============================

test("STAMP: la revisión sólo avanza cuando el tablero cambió de verdad", () => {
  const stored = doc([round("r1")], 4);
  assert.equal(R.stampRoundsRevision({ ...stored }, stored).roundsRevision, 4);
  assert.equal(R.stampRoundsRevision(doc([round("r1"), round("r2")]), stored).roundsRevision, 5);
});

test("STAMP: un guardado que no toca el tablero no invalida las demás pestañas", () => {
  // Es la razón de comparar contenido en vez de sellar en cada escritura: un
  // cambio de ajustes no puede echar a perder la pestaña de nadie más.
  const stored = doc([round("r1")], 12);
  const soloAjustes = { ...stored, groupName: "otro nombre" };
  assert.equal(R.stampRoundsRevision(soloAjustes, stored).roundsRevision, 12);
});

test("STAMP: la revisión entrante NUNCA es la que se guarda", () => {
  const stored = doc([round("r1")], 2);
  const mentiroso = doc([round("r1"), round("r2")], 999);
  assert.equal(R.stampRoundsRevision(mentiroso, stored).roundsRevision, 3);
});

test("STAMP: una quiniela nueva empieza en 0, no en 1", () => {
  assert.equal(R.stampRoundsRevision({ rounds: [] }, null).roundsRevision, 0);
});

test("STAMP: es monotónica bajo escrituras sucesivas", () => {
  let stored = doc([], 0);
  for (let i = 1; i <= 5; i++) {
    const next = R.stampRoundsRevision(doc(Array.from({ length: i }, (_, k) => round("r" + k))), stored);
    assert.equal(next.roundsRevision, i);
    stored = next;
  }
});

// ==== 7. el servidor: ningún camino de escritura puede saltarse el protocolo =

test("SERVER: TODA escritura de un meta pasa por el embudo stampMetaWrite", () => {
  // El modo de fallo de olvidar uno es pérdida silenciosa de datos, que es
  // exactamente de lo que trata este ticket. Así que se enumeran aquí.
  const src = stripComments(serverSrc);
  const writes = [...src.matchAll(/await putRow\(([^,]+),\s*([\s\S]*?),\s*client\)/g)]
    .map((m) => ({ key: m[1].trim(), value: m[2].trim() }))
    .filter((w) => /metaKey|targetKey/.test(w.key));
  assert.ok(writes.length >= 7, `se esperaban al menos 7 escrituras de meta, hay ${writes.length}`);
  for (const w of writes) {
    // Sellado en la propia llamada...
    const selladoAqui = /^stampMetaWrite\(|^stampRoundsRevision\(/.test(w.value);
    // ...o el valor es el resultado de un sellado inmediatamente anterior. Las
    // dos formas se enumeran a mano a propósito: una variable nueva que no
    // aparezca aquí rompe esta prueba, que es justo lo que se quiere.
    const selladoAntes = {
      // producido por mergeProtectedMetaFields(), que termina en stampMetaWrite()
      mergedValue: "metaMerge.value",
      storedAfterAnswer: "stampMetaWrite(value, beforeAnswer)",
      storedAfterPin: "stampMetaWrite(value, beforePinChange)",
      storedAfterRegistration: "stampMetaWrite(value, beforeRegistration)",
    }[w.value];
    if (selladoAntes) {
      assert.ok(src.includes(`const ${w.value} = ${selladoAntes}`) || w.value === "mergedValue",
        `${w.value} debe venir de un sellado`);
      continue;
    }
    assert.ok(selladoAqui, `putRow(${w.key}, ${w.value.slice(0, 60)}...) escribe un meta sin sellar la revisión`);
  }
  // Y el único valor con indirección real queda anclado explícitamente.
  assert.ok(src.includes("const mergedValue = metaMerge.value;"));
  assert.ok(stripComments(serverSrc).includes("value: stampMetaWrite(merged, oldValue),"),
    "metaMerge.value tiene que ser el documento ya sellado");
});

test("SERVER: stampMetaWrite es participantes Y tablero, nunca uno solo", () => {
  const body = blockFrom(stripComments(serverSrc), "function stampMetaWrite(");
  assert.ok(body.includes("stampRoundsRevision("), "debe sellar la revisión del tablero");
  assert.ok(body.includes("stampMetaRevisions("), "debe seguir sellando las revisiones de participantes");
});

test("SERVER: el veredicto se toma bajo lock, después de autorizar y ANTES de cobrar", () => {
  const src = stripComments(serverSrc);
  const handler = blockFrom(src, 'else if (info.kind === "quiniela-meta")');
  const authAt = handler.indexOf('return res.status(403).json({ error: "unauthorized" })');
  const resolveAt = handler.indexOf("resolveRoundsWrite({ stored: oldValue, incoming: value })");
  const conflictAt = handler.indexOf('error: "rounds_conflict"');
  const consumeAt = handler.indexOf("tournamentScope.recordConsumption(");
  const commitAt = handler.indexOf('await client.query("COMMIT")');
  assert.ok(authAt !== -1 && resolveAt !== -1 && conflictAt !== -1 && consumeAt !== -1 && commitAt !== -1);
  assert.ok(authAt < resolveAt, "no se decide nada sobre el tablero antes de autorizar");
  assert.ok(resolveAt < conflictAt, "el conflicto se responde a partir del veredicto");
  // La regla de facturación del ticket: una escritura stale rechazada NO
  // consume jornada. Se cumple porque nunca llega al bloque que la registra.
  assert.ok(conflictAt < consumeAt, "un conflicto debe cortar ANTES de registrar consumo");
  assert.ok(consumeAt < commitAt);
});

test("SERVER: el veredicto se toma contra la fila leída bajo lock, no contra el request", () => {
  const handler = stripComments(blockFrom(stripComments(serverSrc), 'else if (info.kind === "quiniela-meta")'));
  assert.ok(handler.includes("const oldValue = await getRowLocked(info.metaKey, client)"));
  assert.ok(handler.includes("resolveRoundsWrite({ stored: oldValue, incoming: value })"),
    "stored debe ser la fila bloqueada; pasar el documento entrante sería darle la decisión a quien la regla limita");
});

test("SERVER: un conflicto responde 409 y NO escribe nada", () => {
  const handler = stripComments(blockFrom(stripComments(serverSrc), 'else if (info.kind === "quiniela-meta")'));
  const at = handler.indexOf('roundsWrite.outcome === "conflict"');
  assert.ok(at !== -1, "debe existir la rama de conflicto");
  const branch = handler.slice(at, at + 900);
  assert.ok(branch.includes('await client.query("ROLLBACK")'), "debe deshacer la transacción");
  assert.ok(branch.includes("res.status(409)"), "409, nunca un 200 que aparente éxito");
  assert.ok(branch.includes("roundsRevision: roundsWrite.storedRevision"),
    "debe devolver la revisión vigente para que el cliente reconcilie");
});

test("SERVER: un tablero imposible responde 400 y tampoco escribe", () => {
  const handler = stripComments(blockFrom(stripComments(serverSrc), 'else if (info.kind === "quiniela-meta")'));
  const at = handler.indexOf('roundsWrite.outcome === "invalid"');
  assert.ok(at !== -1);
  const branch = handler.slice(at, at + 600);
  assert.ok(branch.includes('await client.query("ROLLBACK")'));
  assert.ok(branch.includes("res.status(400)"));
});

test("SERVER: la fusión toma el tablero del veredicto, jamás del request", () => {
  const merge = stripComments(blockFrom(stripComments(serverSrc), "function mergeProtectedMetaFields("));
  assert.ok(/merged\.rounds = roundsWrite/.test(merge),
    "merged.rounds debe venir de roundsWrite — tomar newValue.rounds ES el lost update");
  assert.ok(merge.includes("delete merged.roundsRevision;"),
    "la revisión que trajo el request es una afirmación ya consumida, no un valor a guardar");
});

test("SERVER: la respuesta exitosa devuelve la revisión nueva", () => {
  const handler = stripComments(blockFrom(stripComments(serverSrc), 'else if (info.kind === "quiniela-meta")'));
  assert.ok(handler.includes("roundsRevision: storedRoundsRevision(mergedValue)"),
    "sin esto, la propia pestaña que acaba de guardar chocaría consigo misma en su siguiente guardado");
  assert.ok(handler.includes('roundsPreserved: roundsWrite.outcome === "no_statement"'),
    "un write que no habló del tablero debe enterarse de que se conservó el guardado");
});

test("SERVER: la vista filtrada de un participante no puede servir de prueba", () => {
  const src = stripComments(serverSrc);
  const at = src.indexOf("clone.rounds = clone.rounds.filter((r) => r.published !== false);");
  assert.ok(at !== -1);
  assert.ok(src.slice(at, at + 300).includes("delete clone.roundsRevision;"),
    "una copia deliberadamente incompleta del tablero no puede llevar la revisión del completo");
});

test("SERVER: MON-002C sigue intacto — la época convive con la revisión", () => {
  const merge = stripComments(blockFrom(stripComments(serverSrc), "function mergeProtectedMetaFields("));
  assert.ok(merge.includes("readTournamentEpoch(merged) < storedEpoch"), "la protección de época no se sustituye");
  assert.ok(merge.includes("merged.pastTournaments = Array.isArray(oldValue && oldValue.pastTournaments)"),
    "el archivo sigue siendo del servidor");
  assert.ok(merge.includes("merged.tournamentEpoch = storedEpoch;"));
  const close = stripComments(blockFrom(stripComments(serverSrc), 'app.post("/api/quinielas/:slug/tournament/close"'));
  assert.ok(close.includes("stampMetaWrite(meta, metaBefore)"), "el cierre también sella el tablero");
  assert.ok(close.includes("closeIntentId"), "el replay por intención sigue existiendo");
  assert.ok(close.includes('error: "stale_tournament_cycle"'), "expectedCycle sigue existiendo");
});

test("SERVER: el import sella el tablero contra el estado previo al import", () => {
  const sync = stripComments(blockFrom(stripComments(serverSrc), 'app.post("/api/quinielas/:slug/sync-competition"'));
  assert.ok(sync.includes("const boardBeforeImport = { rounds: meta.rounds, roundsRevision: storedRoundsRevision(meta) };"));
  assert.ok(sync.includes("stampRoundsRevision(meta, boardBeforeImport)"),
    "sin esto una pestaña anterior al import seguiría pareciendo fresca");
  const beforeAt = sync.indexOf("boardBeforeImport =");
  const mutateAt = sync.indexOf("meta.rounds = [...(meta.rounds || []), ...newRounds]");
  assert.ok(beforeAt < mutateAt, "la foto previa se toma ANTES de mutar el tablero");
});

test("SERVER: self-register lleva el tablero en su foto previa", () => {
  // Una foto que omitiera el tablero haría que registrarse pareciera cambiarlo,
  // y reiniciaría la revisión contra la que se juzga a todas las pestañas.
  const reg = stripComments(blockFrom(stripComments(serverSrc), 'app.post("/api/self-register"'));
  assert.ok(/const beforeRegistration = \{[\s\S]*?rounds: value\.rounds,[\s\S]*?roundsRevision: storedRoundsRevision\(value\),/.test(reg));
});

test("SERVER: existe el backfill de arranque para filas anteriores al ticket", () => {
  const boot = stripComments(blockFrom(stripComments(serverSrc), "async function ensureTable("));
  assert.ok(boot.includes("jsonb_set(value, '{roundsRevision}', '0'::jsonb, true)"));
  assert.ok(boot.includes("NOT (value ? 'roundsRevision')"), "debe ser idempotente entre reinicios");
  assert.ok(boot.includes("key LIKE 'quiniela:%:meta'"));
});

// ==== 8. el navegador ======================================================

test("UI: cada guardado adopta la revisión que devolvió el servidor", () => {
  const ui = stripComments(indexSrc);
  assert.ok(ui.includes("if(Number.isFinite(result.roundsRevision)) meta.roundsRevision = result.roundsRevision;"),
    "sin esto la pestaña entra en conflicto consigo misma tras su propio guardado");
});

test("UI: un conflicto refresca, repinta y avisa — y no dice 'se guardó'", () => {
  const ui = stripComments(indexSrc);
  const at = ui.indexOf('result.error === "rounds_conflict"');
  assert.ok(at !== -1, "setMetaWithError debe manejar el conflicto en un solo lugar");
  const branch = ui.slice(at, at + 1200);
  assert.ok(branch.includes("getMeta({ owner: adminOrOwnerCred() })"), "debe traer el estado bueno del servidor");
  assert.ok(branch.includes("Object.assign(meta, fresh)"), "mutado en sitio: toda pantalla con este objeto se corrige");
  assert.ok(branch.includes("invalidatePlan()"));
  const renderAt = branch.indexOf("await render()");
  const noticeAt = branch.indexOf("notice(");
  assert.ok(renderAt !== -1 && noticeAt !== -1 && renderAt < noticeAt,
    "repintar ANTES de avisar: render() reemplaza root.innerHTML y borraría un aviso previo");
  assert.ok(!/return \{ \.\.\.result, ok: true/.test(branch), "nunca puede reportarse como guardado");
});

test("UI: el aviso de conflicto no es técnico", () => {
  const ui = stripComments(indexSrc);
  const at = ui.indexOf('result.error === "rounds_conflict"');
  const branch = ui.slice(at, at + 1200);
  const msg = (branch.match(/notice\("([^"]+)"\)/) || [])[1] || "";
  assert.ok(msg.length > 20, "debe haber un mensaje");
  for (const jerga of ["revisión", "revision", "epoch", "época", "409", "conflict", "stale", "roundsRevision"]) {
    assert.ok(!msg.toLowerCase().includes(jerga.toLowerCase()), `el copy no puede decir "${jerga}": ${msg}`);
  }
});

test("UI: el aviso sobrevive al repintado que él mismo provoca", () => {
  const ui = stripComments(indexSrc);
  const body = blockFrom(ui, "function notice(");
  assert.ok(body.includes("document.body.appendChild(n)"),
    "colgado de root se borraría: render() reemplaza root.innerHTML entero");
  assert.ok(body.includes('n.setAttribute("role", "status")'));
  // Y su CSS no puede estar escopado bajo #quiniela-root, o quedaría sin estilo.
  assert.ok(/\n\s*\.qz-notice\{/.test(indexSrc), ".qz-notice debe declararse sin escopar");
  assert.ok(!indexSrc.includes("#quiniela-root .qz-notice"));
});

test("UI: cerrar el torneo trae el estado nuevo antes de repintar", () => {
  const ui = stripComments(indexSrc);
  const body = blockFrom(ui, "async function finishClose(");
  assert.ok(body.includes("getMeta({ owner: adminOrOwnerCred() })"),
    "el cierre es una escritura del servidor sobre el tablero; la pestaña tiene que enterarse");
  const fetchAt = body.indexOf("getMeta({");
  const renderAt = body.indexOf("renderAdmin(");
  assert.ok(fetchAt < renderAt, "primero traer, después pintar");
});
