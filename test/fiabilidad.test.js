// fiabilidad.test.js — sprint de fiabilidad, partes puras y de pantalla.
// AUD-01 picksMerge (la regla de mezcla) y el guardado en el navegador;
// AUD-02/05 cierre y respaldo sólo con una lectura completa; AUD-03 los
// descuentos de un torneo archivado no restan en el nuevo.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { mergePicksWrite } = require("../picksMerge");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
function fn(sig, src = html) {
  const s = src.indexOf(sig);
  assert.ok(s !== -1, "no está " + sig);
  let d = 0, i = src.indexOf("{", s);
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) break; }
  return src.slice(s, i + 1);
}

// ---------------------------------------------------------------- AUD-01
test("AUD-01 · mezcla: lo no tocado se conserva, lo cambiado se aplica, lo que chocó es conflicto", () => {
  const stored = { r1: { m1: "A", m2: "D" } };
  assert.deepEqual(mergePicksWrite({ stored, incoming: { r1: { m3: "B" } }, base: {} }).value, { r1: { m1: "A", m2: "D", m3: "B" } });
  assert.deepEqual(mergePicksWrite({ stored, incoming: { r1: { m1: "B", m2: "D" } }, base: stored }).value, { r1: { m1: "B", m2: "D" } });
  const c = mergePicksWrite({ stored, incoming: { r1: { m1: "B" } }, base: {} });
  assert.deepEqual([c.ok, c.conflicts], [false, [{ roundId: "r1", field: "m1" }]]);
  // Mismo valor que ya está: no es conflicto ni cambio.
  const same = mergePicksWrite({ stored, incoming: { r1: { m1: "A" } }, base: {} });
  assert.deepEqual([same.ok, same.changed], [true, false]);
});

test("AUD-01 · mezcla: quitar un pronóstico visto lo quita; un documento vacío no borra nada; sin base es base vacía", () => {
  const stored = { r1: { m1: "A" }, r2: { m1: "D" } };
  assert.deepEqual(mergePicksWrite({ stored, incoming: { r2: { m1: "D" } }, base: stored }).value, { r2: { m1: "D" } });
  assert.deepEqual(mergePicksWrite({ stored, incoming: {}, base: {} }).value, stored);
  assert.deepEqual(mergePicksWrite({ stored, incoming: {}, base: undefined }).value, stored);
  assert.deepEqual(mergePicksWrite({ stored: null, incoming: { r1: { m1: "B" } }, base: undefined }).value, { r1: { m1: "B" } });
});

test("AUD-01 · mezcla: las respuestas de la jornada (__extra) se mezclan pregunta por pregunta", () => {
  const stored = { r1: { __extra: { q1: "Pumas" } } };
  const v = mergePicksWrite({ stored, incoming: { r1: { __extra: { q2: "3" } } }, base: {} }).value;
  assert.deepEqual(v, { r1: { __extra: { q1: "Pumas", q2: "3" } } });
  const c = mergePicksWrite({ stored, incoming: { r1: { __extra: { q1: "Tigres" } } }, base: {} });
  assert.deepEqual(c.conflicts, [{ roundId: "r1", field: "__extra.q1" }]);
});

test("AUD-01 · mezcla: claves peligrosas no entran", () => {
  const v = mergePicksWrite({ stored: {}, incoming: JSON.parse('{"__proto__":{"x":1},"r1":{"__proto__":"A","m1":"A"}}'), base: {} }).value;
  assert.deepEqual(v, { r1: { m1: "A" } });
  assert.equal({}.x, undefined);
});

test("AUD-01 · navegador: un guardado a la vez, con su base; una lectura fallida no es «no hay nada»", () => {
  const set = fn("function setPicksWithError(pid, data)");
  assert.ok(set.includes("picksSaveChain.then(() => savePicksNow(pid, data))"), "en cola, uno a la vez");
  const now = fn("async function savePicksNow(pid, data)");
  assert.ok(now.includes('if(myPicksBase === null || myPicksBaseOwner !== picksOwnerKey(pid)) return { ok: false, error: "picks_not_loaded" };'));
  assert.ok(now.includes("{ base: picksDocForSave(myPicksBase) }"));
  const get = fn("async function getPicks(pid, opts)");
  assert.ok(get.includes("return opts && opts.strict ? null : {};"));
  const read = fn("async function lgReadPicks(pid)");
  assert.ok(read.includes("if(read === null){ failPicksBase(pid); return {}; }"));
  // La jornada lo dice y no deja elegir hasta cargarlos.
  const vote = fn("function renderRoundVoting(box, round, isHeroRound)");
  assert.ok(vote.includes("No pudimos cargar tus pronósticos guardados."));
  assert.ok(vote.includes('data-val="A" ${myPicksLoadFailed ? "disabled" : ""}'));
});

test("AUD-01 · «Pronóstico guardado» sólo tras la respuesta del servidor; error y pendiente quedan escritos", () => {
  const save = fn("async function attemptSavePicks(statusEl, round, onSuccess, suppressLoadingAndSuccess, onManualRetry)");
  const okBranch = save.slice(save.indexOf("if(result.ok){"), save.indexOf('}else if(result.error === "round_locked"){'));
  assert.ok(okBranch.includes("✅ Pronóstico guardado"));
  assert.ok(okBranch.includes('toast("Pronóstico guardado", 1800);'));
  assert.equal((save.match(/Pronóstico guardado/g) || []).length, 3, "sólo en la rama de éxito (y su comentario)");
  // Con conflicto, lo elegido aquí no se guardó: no se dice «Pronóstico guardado».
  const conflictPart = okBranch.slice(okBranch.indexOf("if(conflictNote){"), okBranch.indexOf("} else if(!suppressLoadingAndSuccess){"));
  assert.ok(conflictPart.includes('toast("Revisa tus pronósticos: uno cambió en otra pestaña o dispositivo.", 4000);') && !conflictPart.includes("✅"));
  assert.ok(save.indexOf("const result = await setPicksWithError(") < save.indexOf("if(result.ok){"));
  assert.ok(save.includes("No guardamos este cambio: no pudimos cargar tus pronósticos guardados"));
  assert.ok(!/qzConfirm|qzAlert/.test(save), "nunca pide «Aceptar»");
});

// ---------------------------------------------------------------- AUD-03
function penaltyFor(meta, p) {
  const f = new Function("meta", "serverNow", `
    ${fn("function isRoundLocked(round)")}
    ${fn("function isRoundEligibleForPenalty(round, penalty)")}
    ${fn("function penaltyPointsFor(p, cutoffRoundNumber)")}
    return penaltyPointsFor;`)(meta, () => Date.parse("2026-11-06T12:00:00Z"));
  return f(p, null);
}
const PAST = "2026-10-01T00:00:00Z";
test("AUD-03 · el descuento de una jornada archivada no resta en el torneo nuevo; uno nuevo cuenta una vez", () => {
  const penalty = { enabled: true, startsAtRound: 1, pointsPerRound: 2 };
  // Torneo 2 sin jornadas, con el registro que dejó un cierre anterior.
  const meta = { paymentPenalty: penalty, rounds: [], pastTournaments: [{ rounds: [{ id: "r1", number: 1 }] }] };
  assert.equal(penaltyFor(meta, { id: "b", paid: false, penalizedRounds: { r1: 2 } }), 0);
  // Torneo 2 con su jornada r2 cerrada y registrada: 2, no 4 (registro + en vivo).
  meta.rounds = [{ id: "r2", number: 1, deadline: PAST, published: true }];
  assert.equal(penaltyFor(meta, { id: "b", paid: false, penalizedRounds: { r1: 2, r2: 2 } }), 2);
  // Sin registrar todavía: cuenta en vivo, una vez.
  assert.equal(penaltyFor(meta, { id: "b", paid: false, penalizedRounds: { r1: 2 } }), 2);
  // Una jornada del torneo EN CURSO que se borró después de resolverse sigue contando (sin cambios).
  assert.equal(penaltyFor({ ...meta, rounds: [] , pastTournaments: [] }, { id: "b", paid: true, penalizedRounds: { rx: 2 } }), 2);
});

// ---------------------------------------------------------------- AUD-02 / AUD-05
test("AUD-02 · el cierre arma la tabla sólo con la lectura completa; si falla, no pregunta ni cierra", () => {
  const run = fn("async function runCloseTournament()");
  assert.ok(!run.includes("ensureAllPicksLoaded"), "ya no usa la carga que convertía un error en «nadie pronosticó»");
  const snapAt = run.indexOf("const snap = await loadAdminSnapshot();");
  assert.ok(snapAt > 0);
  assert.ok(snapAt < run.indexOf("qzConfirm(confirmMsg"), "la lectura va antes de anunciar al campeón");
  assert.ok(run.includes("if(!snap){") && run.slice(run.indexOf("if(!snap){"), run.indexOf("adoptFreshMeta(meta, snap.meta);")).includes("return;"));
  assert.ok(run.includes("standingsList().map(p => ({ id: p.id, name: p.name, pts: p.pts }))"));
  assert.ok(run.includes("basis: snap.basis"));
  const load = fn("async function loadAdminSnapshot()");
  assert.ok(load.includes("if(!res.ok) return null;"));
  assert.ok(load.includes("data.meta.participants.some(p => !Object.prototype.hasOwnProperty.call(data.picks, p.id))"), "incompleta = fallida");
});

test("AUD-05 · el respaldo sale de la lectura completa; si falla no se descarga nada ni se anuncia éxito; dice qué contiene", () => {
  const start = html.indexOf('document.getElementById("qz-export-backup").addEventListener("click"');
  const handler = html.slice(start, html.indexOf("wirePasswordToggles(", start));
  assert.ok(!handler.includes("ensureAllPicksLoaded"));
  const fail = handler.slice(handler.indexOf("if(!snap){"), handler.indexOf("const backup = {"));
  assert.ok(fail.includes("No se generó el respaldo") && fail.includes("return;"));
  assert.ok(handler.indexOf("const backup = {") < handler.indexOf("a.click();"));
  assert.ok(handler.indexOf("a.click();") < handler.indexOf("✅ Listo, el respaldo se descargó."));
  assert.ok(handler.includes("de los demás sólo se registra que ya pronosticaron (true), no qué eligieron"));
  assert.ok(html.includes("De las jornadas que siguen abiertas, de los demás sólo se guarda si ya pronosticaron, no qué eligieron"));
});
