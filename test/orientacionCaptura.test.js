// Orientación del admin: el aviso grande «Captura los resultados» se muestra
// durante las primeras 4 jornadas de CADA torneo. El conteo (jornadas distintas
// de este torneo con resultados publicados) lo lleva el servidor por ciclo, en
// platform_index, junto al consumo de jornadas.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("../tournamentScope.js");
const { SERVER_OWNED_INDEX_FIELDS } = require("../platformState.js");

const S1 = "ts:1:manual:e1";
const S2 = "ts:1:manual:e2";
const rounds = (spec) => spec.map(([id, results]) => ({ id, number: Number(String(id).replace(/\D/g, "")) || 1, published: true, resultsPublished: !!results }));
const entryWith = (consumed, results) => ({ consumedRoundIdsByScope: consumed, ...(results ? { resultsRoundIdsByScope: results } : {}) });

test("cuenta jornadas distintas de ESTE torneo con resultados publicados: 0, 3, 4 y 5", () => {
  const consumed = { [S1]: ["r1", "r2", "r3", "r4", "r5"] };
  for (const n of [0, 3, 4, 5]) {
    const rs = rounds(["r1", "r2", "r3", "r4", "r5"].map((id, i) => [id, i < n]));
    assert.equal(ts.resultsRoundsInScope(entryWith(consumed), S1, rs), n, `${n} jornadas`);
  }
});

test("la quiniela que empieza en la jornada oficial 15 cuenta esa como su primera", () => {
  const entry = entryWith({ [S1]: ["r15"] });
  const rs = [{ id: "r15", number: 15, published: true, resultsPublished: true }];
  assert.equal(ts.resultsRoundsInScope(entry, S1, rs), 1);
});

test("una jornada no cuenta dos veces: corregir o volver a publicar sus resultados no suma", () => {
  let entry = entryWith({ [S1]: ["r1"] });
  const rs = rounds([["r1", true]]);
  for (let i = 0; i < 3; i++) entry = { ...entry, resultsRoundIdsByScope: ts.recordResultsRounds(entry, S1, [rs, rs]) };
  assert.deepEqual(entry.resultsRoundIdsByScope[S1], ["r1"]);
  // Un documento que repite el id tampoco suma.
  assert.equal(ts.resultsRoundsInScope(entry, S1, [...rs, ...rs]), 1);
});

test("borrar una jornada con resultados no reinicia ni baja el conteo", () => {
  let entry = entryWith({ [S1]: ["r1", "r2"] });
  const before = rounds([["r1", true], ["r2", true]]);
  entry = { ...entry, resultsRoundIdsByScope: ts.recordResultsRounds(entry, S1, [[], before]) };
  // Se borra r2 (y en la misma escritura): el registro la conserva.
  const after = rounds([["r1", true]]);
  entry = { ...entry, resultsRoundIdsByScope: ts.recordResultsRounds(entry, S1, [before, after]) };
  assert.equal(ts.resultsRoundsInScope(entry, S1, after), 2);
  assert.equal(ts.resultsRoundsInScope(entry, S1, []), 2, "aunque la meta ya no la tenga");
});

test("borrada en la misma escritura en que se registra por primera vez: la fila guardada la aporta", () => {
  const entry = entryWith({ [S1]: ["r1", "r2"] });
  const stored = rounds([["r1", true], ["r2", true]]);
  const written = rounds([["r1", true]]);
  assert.deepEqual(ts.recordResultsRounds(entry, S1, [stored, written])[S1], ["r1", "r2"]);
});

test("un torneo nuevo empieza en cero, también si las jornadas del anterior siguen en el tablero", () => {
  // «Empezar un torneo nuevo sin cerrar este»: las jornadas viejas siguen ahí,
  // pero son del ciclo anterior (consumidas en S1), no del nuevo.
  const old = rounds([["r1", true], ["r2", true], ["r3", true], ["r4", true], ["r5", true]]);
  let entry = entryWith({ [S1]: ["r1", "r2", "r3", "r4", "r5"], [S2]: [] });
  entry = { ...entry, resultsRoundIdsByScope: ts.recordResultsRounds(entry, S1, [old, old]) };
  assert.equal(ts.resultsRoundsInScope(entry, S1, old), 5);
  assert.equal(ts.resultsRoundsInScope(entry, S2, old), 0, "el torneo nuevo no hereda el conteo");
  // El torneo nuevo publica su primera jornada con resultados.
  const now = [...old, { id: "r6", number: 1, published: true, resultsPublished: true }];
  entry = { ...entry, consumedRoundIdsByScope: { ...entry.consumedRoundIdsByScope, [S2]: ["r6"] } };
  entry = { ...entry, resultsRoundIdsByScope: ts.recordResultsRounds(entry, S2, [old, now]) };
  assert.equal(ts.resultsRoundsInScope(entry, S2, now), 1);
  assert.equal(ts.resultsRoundsInScope(entry, S1, now), 5, "el anterior conserva el suyo");
});

test("resultados publicados guardados como \"true\" o 1 también cuentan (como los trata la pantalla)", () => {
  const entry = entryWith({ [S1]: ["r1", "r2"] });
  const rs = [{ id: "r1", published: true, resultsPublished: "true" }, { id: "r2", published: true, resultsPublished: 1 }];
  assert.equal(ts.resultsRoundsInScope(entry, S1, rs), 2);
});

test("jornadas sin resultados publicados (borradores, cerradas sin capturar) no cuentan", () => {
  const entry = entryWith({ [S1]: ["r1", "r2"] });
  const rs = [{ id: "r1", published: true, resultsPublished: false }, { id: "r2", published: false }, { id: "r3", published: false, resultsPublished: true }];
  assert.equal(ts.resultsRoundsInScope(entry, S1, rs), 0, "r3 no es de este torneo (nunca se publicó en él)");
});

test("quiniela anterior a este registro: sin dato hasta su siguiente guardado, que arranca de lo que hay hoy, sin inventar jornadas borradas", () => {
  const entry = entryWith({ [S1]: ["r1", "r2", "r3"] }); // sin resultsRoundIdsByScope
  assert.equal(ts.recordedResultsRounds(entry, S1), null, "sin registro: desconocido (el aviso se sigue mostrando)");
  const rs = rounds([["r1", true], ["r3", true]]); // r2 se borró antes: no se puede saber
  const next = { ...entry, resultsRoundIdsByScope: ts.recordResultsRounds(entry, S1, [rs, rs]) };
  assert.equal(ts.recordedResultsRounds(next, S1), 2);
});

test("el registro es del servidor: no se toma de la meta ni de una edición del índice", () => {
  assert.ok(SERVER_OWNED_INDEX_FIELDS.includes("resultsRoundIdsByScope"));
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /"tournamentScope", "scopeHistory", "consumedRoundIdsByScope", "resultsRoundIdsByScope",/, "reservado en la meta");
  // Se registra en la misma transacción que la escritura de la meta, después del consumo.
  const iConsume = server.indexOf("entry.consumedRoundIdsByScope = tournamentScope.recordConsumption(entry, currentScopeId, newlyConsumedIds);");
  const iResults = server.indexOf("entry.resultsRoundIdsByScope = tournamentScope.recordResultsRounds(entry, currentScopeId, [oldValue.rounds, mergedValue.rounds]);");
  assert.ok(iConsume > 0 && iResults > iConsume);
  assert.ok(server.includes("resultsRounds: tournamentScope.recordedResultsRounds(entry, currentScope.id),"), "el plan da el conteo registrado, sin ids ni meta.rounds");
});

test("navegador: el aviso de captura se muestra con 0–3 jornadas, no con 4 o más, y sin dato se orienta", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const start = html.indexOf("  const CAPTURE_ORIENTATION_ROUNDS = 4;");
  const end = html.indexOf("  function nextStepCardHtml(info){");
  const src = html.slice(start, end);
  const make = (plan, fail) => new Function("loadPlan", `${src}\nreturn captureOrientationDue;`)(async () => { if (fail) throw new Error("x"); return plan; });
  for (const [n, due] of [[0, true], [3, true], [4, false], [5, false]]) {
    assert.equal(await make({ tournament: { resultsRounds: n } })(), due, `${n} jornadas`);
  }
  assert.equal(await make(null)(), true, "sin plan");
  assert.equal(await make({ available: false })(), true, "plan no disponible");
  assert.equal(await make({ tournament: { cycle: 1 } })(), true, "servidor sin el conteo");
  assert.equal(await make(null, true)(), true, "lectura fallida");
  assert.ok(html.includes("if(closedPending.length && await captureOrientationDue()){"), "sólo el aviso de captura depende del conteo");
});
