// UX-ADM-005: Cierre/histórico del torneo -- una jornada published:false
// (preparada) nunca debe quedar guardada en meta.pastTournaments[].rounds,
// para que "X jornadas jugadas" no cuente calendario preparado como
// jugado. public/index.html no expone jsdom, así que esto ejecuta el
// FRAGMENTO REAL de la construcción del objeto pastTournaments (extraído
// verbatim del handler de "Cerrar torneo") contra un meta.rounds mixto
// real, no una reimplementación ni solo un chequeo estructural de texto.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function assertRealFragment(source, fragment){
  assert.ok(source.includes(fragment), `could not locate real source fragment: "${fragment}"`);
  return fragment;
}

// Executes the REAL filter expression used when building the historical
// snapshot -- extracted verbatim, not reimplemented.
function runCloseTournamentRoundsFilter(rounds){
  const filterExpr = assertRealFragment(indexSrc, "meta.rounds.filter(r => r.published !== false)");
  const runner = new Function("meta", `return ${filterExpr};`);
  return runner({ rounds });
}

// El handler completo, delimitado por llaves en vez de por una ventana de N
// caracteres: una ventana fija convierte cualquier crecimiento del handler en
// un falso negativo silencioso (la aserción "no contiene X" pasa porque X
// quedó fuera del recorte, no porque no exista).
function closeTournamentHandler(){
  const marker = 'document.getElementById("qz-close-tournament").addEventListener("click"';
  const at = indexSrc.indexOf(marker);
  assert.ok(at !== -1, "no se encontró el handler de cerrar torneo");
  const braceStart = indexSrc.indexOf("{", indexSrc.indexOf("=>", at));
  let depth = 0;
  for(let i = braceStart; i < indexSrc.length; i++){
    if(indexSrc[i] === "{") depth++;
    else if(indexSrc[i] === "}"){ depth--; if(depth === 0) return indexSrc.slice(at, i + 1); }
  }
  throw new Error("handler sin cerrar");
}

function round(number, published, resultsPublished){
  return { id: "r" + number, number, published, resultsPublished: !!resultsPublished, matches: [{ id: "m" + number, teamA: "A", teamB: "B" }] };
}

test("root cause confirmed: the close-tournament handler no longer stores the raw unfiltered meta.rounds", () => {
  const handlerBody = closeTournamentHandler();
  assert.ok(!handlerBody.includes("rounds: meta.rounds\n"), "must not still store the raw array");
  assert.ok(handlerBody.includes("rounds: meta.rounds.filter(r => r.published !== false)"), "must filter out published:false before storing the historical snapshot");
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

test("CASE F: the champion/finalStandings computation happens via standingsList() BEFORE the historical rounds are filtered/stored -- this fix cannot alter scoring", () => {
  const handlerBody = closeTournamentHandler();
  const standingsIdx = handlerBody.indexOf("const finalStandings = standingsList()");
  const filterIdx = handlerBody.indexOf("rounds: meta.rounds.filter(r => r.published !== false)");
  assert.ok(standingsIdx !== -1 && filterIdx !== -1 && standingsIdx < filterIdx, "standings/champion must be computed independently, before the historical rounds filter -- this fix only changes what gets STORED as history, never how points/champion are calculated");
});

// ---- Payment Penalty untouched ----

test("this fix does not reference penalizedRounds/reconcilePenaltyLedger/penaltyPointsFor anywhere in the close-tournament handler -- Payment Penalty logic is completely untouched", () => {
  const handlerBody = closeTournamentHandler();
  assert.ok(!handlerBody.includes("reconcilePenaltyLedger"));
  assert.ok(!handlerBody.includes("penaltyPointsFor"));
  assert.ok(!handlerBody.includes(".penalizedRounds"));
});
