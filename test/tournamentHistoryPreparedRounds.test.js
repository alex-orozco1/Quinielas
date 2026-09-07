// UX-ADM-005: Cierre/histórico del torneo -- una jornada published:false
// (preparada) nunca debe quedar guardada en meta.pastTournaments[].rounds,
// para que "X jornadas jugadas" no cuente calendario preparado como
// jugado. Esto ejecuta el FRAGMENTO REAL del filtro (extraído verbatim del
// código, no reimplementado) contra un meta.rounds mixto real.
//
// MON-002C QA-2: el filtro se MOVIÓ del navegador al servidor, porque cerrar
// el torneo pasó a ser una sola transacción server-side. La regla no cambió;
// cambió quién la aplica, y ahora la aplica el lado que no puede ser
// manipulado por quien manda la petición. Estas pruebas siguen al filtro.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function assertRealFragment(source, fragment){
  assert.ok(source.includes(fragment), `could not locate real source fragment: "${fragment}"`);
  return fragment;
}

// Executes the REAL filter expression used when building the historical
// snapshot -- extracted verbatim, not reimplemented.
function runCloseTournamentRoundsFilter(rounds){
  const filterExpr = assertRealFragment(serverSrc, "(Array.isArray(meta.rounds) ? meta.rounds : []).filter((r) => r && r.published !== false)");
  const runner = new Function("meta", `return ${filterExpr};`);
  return runner({ rounds });
}

// El handler completo, delimitado por llaves en vez de por una ventana de N
// caracteres: una ventana fija convierte cualquier crecimiento del handler en
// un falso negativo silencioso (la aserción "no contiene X" pasa porque X
// quedó fuera del recorte, no porque no exista).
function closeTournamentHandler(){
  const marker = 'app.post("/api/quinielas/:slug/tournament/close"';
  const at = serverSrc.indexOf(marker);
  assert.ok(at !== -1, "no se encontró el endpoint de cerrar torneo");
  const braceStart = serverSrc.indexOf("{", serverSrc.indexOf("=>", at));
  let depth = 0;
  for(let i = braceStart; i < serverSrc.length; i++){
    if(serverSrc[i] === "{") depth++;
    else if(serverSrc[i] === "}"){ depth--; if(depth === 0) return serverSrc.slice(at, i + 1); }
  }
  throw new Error("handler sin cerrar");
}

function round(number, published, resultsPublished){
  return { id: "r" + number, number, published, resultsPublished: !!resultsPublished, matches: [{ id: "m" + number, teamA: "A", teamB: "B" }] };
}

test("root cause confirmed: the close endpoint never stores the raw unfiltered meta.rounds", () => {
  const handlerBody = closeTournamentHandler();
  assert.ok(!/rounds:\s*meta\.rounds\s*[,\n]/.test(handlerBody), "must not store the raw array");
  assert.ok(handlerBody.includes("(Array.isArray(meta.rounds) ? meta.rounds : []).filter((r) => r && r.published !== false)"),
    "must filter out published:false before storing the historical snapshot");
  // Y lo que se archiva sale de la fila LEÍDA BAJO LOCK, no de la petición:
  // qué jornadas se jugaron es un hecho de lo guardado, no una afirmación
  // que el cliente pueda hacer.
  assert.ok(handlerBody.includes("const meta = JSON.parse(JSON.stringify(metaBefore));"),
    "el archivo se construye desde la fila leída bajo lock");
  assert.ok(!/body\.rounds|body\.pastTournaments/.test(handlerBody),
    "el cuerpo de la petición nunca aporta jornadas ni historial");
});

// ---- CASE A: prepared excluded ----

test("CASE A: J1-J3 published:true, J4-J17 published:false -> only J1-J3 end up in the historical snapshot", () => {
  const rounds = [
    round(1, true), round(2, true), round(3, true),
    ...Array.from({ length: 14 }, (_, i) => round(i + 4, false)),
  ];
  const stored = runCloseTournamentRoundsFilter(rounds);
  assert.deepEqual(stored.map(r => r.number), [1, 2, 3]);
  assert.equal(stored.length, 3, "the exact real-world case from the ticket: 17 prepared, only 3 must count as history");
});

// ---- CASE B: legacy ----

test("CASE B: a legacy round (published undefined) is still treated as official and kept in the snapshot", () => {
  const legacyRound = { id: "r1", number: 1, matches: [] }; // no `published` field at all
  const stored = runCloseTournamentRoundsFilter([legacyRound]);
  assert.deepEqual(stored, [legacyRound]);
});

// ---- CASE C: mixed ----

test("CASE C: legacy + published:true are kept, published:false is excluded", () => {
  const legacyRound = { id: "r1", number: 1, matches: [] };
  const rounds = [legacyRound, round(2, true), round(3, false)];
  const stored = runCloseTournamentRoundsFilter(rounds);
  assert.deepEqual(stored.map(r => r.number), [1, 2]);
});

// ---- CASE E: no prepared rounds -- identical to current behavior ----

test("CASE E: an all-legacy/published quiniela stores every round, exactly like before this fix", () => {
  const rounds = [round(1, true), { id: "r2", number: 2, matches: [] }, round(3, true)];
  const stored = runCloseTournamentRoundsFilter(rounds);
  assert.equal(stored.length, 3, "nothing gets excluded when there are no prepared rounds -- behavior is unchanged for quinielas that never used Competition Sync");
});

// ---- CASE G: a published round without results is NOT treated as prepared -- kept as real history ----

test("CASE G: published:true + resultsPublished:false is real official history, NOT excluded -- only published:false (prepared) is excluded", () => {
  const openPublishedRound = round(4, true, false); // published, still open/no results yet
  const stored = runCloseTournamentRoundsFilter([openPublishedRound]);
  assert.deepEqual(stored, [openPublishedRound], "a published round pending results must never be treated as merely 'prepared' -- this fix targets published:false specifically, not resultsPublished");
});

// ---- CASE H: many future prepared rounds -- history grows only as rounds become official ----

test("CASE H: a fully-prepared 17-round calendar with 0 published rounds -> 0 rounds in history", () => {
  const rounds = Array.from({ length: 17 }, (_, i) => round(i + 1, false));
  const stored = runCloseTournamentRoundsFilter(rounds);
  assert.equal(stored.length, 0);
});

test("H (continued): publishing 5 of those 17 rounds -> exactly 5 in the historical snapshot", () => {
  const rounds = [
    ...Array.from({ length: 5 }, (_, i) => round(i + 1, true)),
    ...Array.from({ length: 12 }, (_, i) => round(i + 6, false)),
  ];
  const stored = runCloseTournamentRoundsFilter(rounds);
  assert.equal(stored.length, 5);
  assert.deepEqual(stored.map(r => r.number), [1, 2, 3, 4, 5]);
});

// ---- CASE D: Admin -> Jornadas must still show ALL rounds, including prepared ones -- this fix must not touch that surface ----

test("CASE D: renderAdminRondas (Admin -> Jornadas) still reads meta.rounds directly, completely unaffected by the close-tournament fix", () => {
  const body = indexSrc.slice(indexSrc.indexOf("async function renderAdminRondas(body)"), indexSrc.indexOf("async function renderAdminRondas(body)") + 8000);
  assert.ok(body.includes("meta.rounds.length ? meta.rounds.slice().reverse()"), "Admin -> Jornadas must still list every round -- prepared, published, closed -- unfiltered");
});

// ---- CASE F: scoring integrity is unaffected -- champion/standings are computed via standingsList() before this fix runs, untouched by it ----

test("CASE F: scoring is untouched -- standings are computed by the browser and only STORED by the server", () => {
  // El cálculo de puntos sigue exactamente donde estaba: standingsList() en el
  // navegador, antes de mandar nada. El servidor no puntúa; sólo acota, guarda
  // y saca al campeón de la tabla que recibe, así que este arreglo no puede
  // alterar cómo se calculan puntos ni campeón.
  const clickHandler = (() => {
    const marker = 'async function runCloseTournament()';
    const at = indexSrc.indexOf(marker);
    assert.ok(at !== -1);
    const braceStart = indexSrc.indexOf("{", indexSrc.indexOf(")", at));
    let depth = 0;
    for(let i = braceStart; i < indexSrc.length; i++){
      if(indexSrc[i] === "{") depth++;
      else if(indexSrc[i] === "}"){ depth--; if(depth === 0) return indexSrc.slice(at, i + 1); }
    }
    throw new Error("handler sin cerrar");
  })();
  const standingsIdx = clickHandler.indexOf("const finalStandings = standingsList()");
  const sendIdx = clickHandler.indexOf("apiCloseTournament(intent)");
  assert.ok(standingsIdx !== -1 && sendIdx !== -1 && standingsIdx < sendIdx,
    "los puntos se calculan igual que siempre, antes de mandar el cierre");
  const handlerBody = closeTournamentHandler();
  assert.ok(!/standingsList|puntos|computeStandings/.test(handlerBody),
    "el servidor no calcula puntos");
  // Y el campeón no se toma del cliente: se deriva de la tabla ya saneada, así
  // que nunca puede contradecir lo que se guarda junto a él.
  assert.ok(serverSrc.includes("const champion = standings.length ? { ...standings[0] } : null;"),
    "el campeón sale de la tabla saneada, no de un campo aparte del cliente");
});

// ---- Payment Penalty untouched ----

test("this fix does not reference penalizedRounds/reconcilePenaltyLedger/penaltyPointsFor anywhere in the close endpoint -- Payment Penalty logic is completely untouched", () => {
  const handlerBody = closeTournamentHandler();
  assert.ok(!handlerBody.includes("reconcilePenaltyLedger"));
  assert.ok(!handlerBody.includes("penaltyPointsFor"));
  assert.ok(!handlerBody.includes(".penalizedRounds"));
});
