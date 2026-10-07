// #35 · El borrador de una jornada sobrevive a que se recargue la pestaña.
//
// Antes, los partidos y el cierre que la creadora escribía en «Prepara tu
// primera jornada» (y en Admin → Jornadas) vivían sólo en la memoria de la
// pestaña: una recarga, o el teléfono descartando la pestaña mientras guardaba
// su contraseña en otra app, los borraba sin aviso (P1).
//
// public/index.html es un archivo único sin jsdom. Los helpers del borrador se
// ejecutan aquí tal como están escritos, con un sessionStorage en memoria; el
// cableado de los cuatro formularios se comprueba sobre el código real. El
// recorrido en el navegador (recargar de verdad) es evidencia E2E aparte.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  const braceStart = source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

// ---- los helpers, ejecutados tal cual ----
const helpersSrc = indexSrc.slice(
  indexSrc.indexOf('  const ROUND_DRAFT_PREFIX = "qracks_round_draft:";'),
  indexSrc.indexOf("  // Persists the exit signal above."));
const toLocalInputValueSrc = extractFunctionBody(indexSrc, "function toLocalInputValue(iso)");

function memStorage({ failing = false } = {}) {
  const m = new Map();
  const boom = () => { throw new Error("SecurityError"); };
  return {
    map: m,
    getItem: failing ? boom : (k) => (m.has(k) ? m.get(k) : null),
    setItem: failing ? boom : (k, v) => { m.set(k, String(v)); },
    removeItem: failing ? boom : (k) => { m.delete(k); },
  };
}
let n = 0;
function draftsFor(slug, storage) {
  const window = { sessionStorage: storage };
  const blankMatch = () => ({ id: "m_blank" + (++n), teamA: "", teamB: "" });
  return new Function("window", "SLUG", "blankMatch", `${toLocalInputValueSrc}
    ${helpersSrc}
    return { roundDraftKey, roundDraftBase, parseRoundDraft, isRoundDraftEmpty, mergeRoundDraftMatches,
      loadRoundDraft, saveRoundDraft, clearRoundDraft, roundsFormDraft, toLocalInputValue };`)(window, slug, blankMatch);
}

const imported = () => ({
  id: "r_1", number: 1, published: false, resultsPublished: false, deadline: "2026-12-05T02:00:00.000Z",
  matches: [
    { id: "m_a1", teamA: "América", teamB: "Chivas", externalEventId: "123", externalHomeId: "10", externalAwayId: "20", kickoffAt: "2026-12-05T03:00:00Z" },
    { id: "m_a2", teamA: "Pumas", teamB: "Cruz Azul", externalEventId: "124", kickoffAt: "2026-12-05T05:00:00Z" },
  ],
});

// ======================= los helpers =======================

test("#35 · un borrador nuevo se guarda y vuelve igual", () => {
  const d = draftsFor("ofi", memStorage());
  const draft = { matches: [{ id: "m_1", teamA: "León", teamB: "Santos" }, { id: "m_2", teamA: "Toluca", teamB: "" }], deadline: "2026-12-01T20:00" };
  d.saveRoundDraft("new", draft);
  assert.deepEqual(d.loadRoundDraft("new"), draft);
});

test("#35 · el borrador es de ESTA quiniela: otra no lo ve, aunque comparta la pestaña", () => {
  const storage = memStorage();
  draftsFor("ofi", storage).saveRoundDraft("new", { matches: [{ id: "m_1", teamA: "León", teamB: "Santos" }], deadline: "" });
  assert.equal(draftsFor("amigos", storage).loadRoundDraft("new"), null);
  assert.ok(draftsFor("ofi", storage).loadRoundDraft("new"));
  assert.deepEqual([...storage.map.keys()], ["qracks_round_draft:ofi:new"]);
});

test("#35 · filas en blanco y sin cierre no son un borrador: no se guarda nada", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  d.saveRoundDraft("new", { matches: [{ id: "m_1", teamA: "León", teamB: "" }], deadline: "" });
  assert.equal(storage.map.size, 1);
  // Lo borra todo a mano: el borrador desaparece en vez de volver vacío.
  d.saveRoundDraft("new", { matches: [{ id: "m_1", teamA: "  ", teamB: "" }, { id: "m_2", teamA: "", teamB: "" }], deadline: "" });
  assert.equal(storage.map.size, 0);
  assert.equal(d.loadRoundDraft("new"), null);
  // Sólo el cierre ya cuenta.
  d.saveRoundDraft("new", { matches: [], deadline: "2026-12-01T20:00" });
  assert.deepEqual(d.loadRoundDraft("new"), { matches: [], deadline: "2026-12-01T20:00" });
});

test("#35 · sólo se guardan nombres de equipo y la fecha, nunca lo demás que traiga el partido", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  const round = imported();
  d.saveRoundDraft("edit:r_1", { matches: round.matches, deadline: "2026-12-04T20:00", pin: "1234" }, d.roundDraftBase(round));
  const stored = JSON.parse(storage.map.get("qracks_round_draft:ofi:edit:r_1"));
  assert.deepEqual(Object.keys(stored).sort(), ["base", "deadline", "matches"]);
  stored.matches.forEach((m) => assert.deepEqual(Object.keys(m).sort(), ["id", "teamA", "teamB"]));
});

test("#35 · lo que no tiene forma de borrador no vuelve, y se borra", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  const KEY = "qracks_round_draft:ofi:new";
  const malos = [
    "{no es json",
    JSON.stringify(null),
    JSON.stringify({ deadline: "2026-12-01T20:00" }),                                   // sin partidos
    JSON.stringify({ matches: "León" }),
    JSON.stringify({ matches: [{ id: 'm_1"><img src=x onerror=alert(1)>', teamA: "A", teamB: "B" }] }), // id que rompería el atributo
    JSON.stringify({ matches: [{ id: "m 1", teamA: "A", teamB: "B" }] }),
    JSON.stringify({ matches: [{ teamA: "A", teamB: "B" }] }),
    JSON.stringify({ matches: [{ id: "m_1", teamA: "A", teamB: "B" }, { id: "m_1", teamA: "C", teamB: "D" }] }), // id repetido
    JSON.stringify({ matches: Array.from({ length: 101 }, (_, i) => ({ id: "m_" + i, teamA: "A", teamB: "B" })) }),
    JSON.stringify({ base: "{}", matches: [] }),                                       // un borrador de edición no es uno nuevo
  ];
  for (const raw of malos) {
    storage.map.set(KEY, raw);
    assert.equal(d.loadRoundDraft("new"), null, raw.slice(0, 60));
    assert.equal(storage.map.has(KEY), false, "un borrador inservible no se queda guardado");
  }
});

test("#35 · un cierre o un nombre que no tienen la forma esperada se limpian al leer", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  storage.map.set("qracks_round_draft:ofi:new", JSON.stringify({
    deadline: '2026-12-01T20:00"><script>x</script>',
    matches: [{ id: "m_1", teamA: 42, teamB: "x".repeat(500) }],
  }));
  assert.deepEqual(d.loadRoundDraft("new"), { deadline: "", matches: [{ id: "m_1", teamA: "", teamB: "x".repeat(120) }] });
});

test("#35 · un borrador de edición sólo aplica a la jornada tal como estaba al empezar", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  const round = imported();
  const base = d.roundDraftBase(round);
  d.saveRoundDraft("edit:r_1", { matches: [{ id: "m_a1", teamA: "América", teamB: "Guadalajara" }], deadline: "2026-12-04T20:00" }, base);
  assert.ok(d.loadRoundDraft("edit:r_1", base), "misma jornada: vuelve");
  // Otro admin (o una importación) cambió la jornada después: ya no aplica.
  const cambiada = imported(); cambiada.matches[1].teamB = "Monterrey";
  assert.equal(d.loadRoundDraft("edit:r_1", d.roundDraftBase(cambiada)), null);
  assert.equal(storage.map.size, 0, "y se descarta en vez de quedarse esperando");
});

test("#35 · la huella de la jornada cambia con lo que el borrador pisaría, y sólo con eso", () => {
  const d = draftsFor("ofi", memStorage());
  const base = d.roundDraftBase(imported());
  assert.equal(d.roundDraftBase(imported()), base, "una copia idéntica tiene la misma huella");
  const mod = (f) => { const r = imported(); f(r); return d.roundDraftBase(r); };
  assert.notEqual(mod((r) => { r.matches[0].teamA = "Atlas"; }), base);
  assert.notEqual(mod((r) => { r.deadline = "2026-12-06T02:00:00.000Z"; }), base);
  assert.notEqual(mod((r) => { r.published = true; }), base);
  assert.notEqual(mod((r) => { r.resultsPublished = true; }), base);
  assert.notEqual(mod((r) => { r.matches.pop(); }), base);
  assert.notEqual(mod((r) => { r.matches.push({ id: "m_x", teamA: "A", teamB: "B" }); }), base);
  // El horario del proveedor no lo edita el formulario: moverlo no invalida lo escrito.
  assert.equal(mod((r) => { r.matches[0].kickoffAt = "2026-12-05T04:00:00Z"; }), base);
});

test("#35 · restaurar una edición conserva lo que el proveedor sabe de cada partido", () => {
  const d = draftsFor("ofi", memStorage());
  const round = imported();
  const merged = d.mergeRoundDraftMatches(round.matches, [
    { id: "m_a2", teamA: "Pumas UNAM", teamB: "Cruz Azul" },  // reordenado y editado
    { id: "m_new", teamA: "León", teamB: "Santos" },          // añadido a mano
  ]);                                                         // m_a1, quitado
  assert.deepEqual(merged, [
    { id: "m_a2", teamA: "Pumas UNAM", teamB: "Cruz Azul", externalEventId: "124", kickoffAt: "2026-12-05T05:00:00Z" },
    { id: "m_new", teamA: "León", teamB: "Santos" },
  ]);
  assert.equal(round.matches[1].teamA, "Pumas", "la jornada original no se toca");
});

test("#35 · el formulario de Admin → Jornadas arranca del borrador cuando lo hay", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  // Jornada nueva, sin borrador: dos filas en blanco.
  const vacio = d.roundsFormDraft(null);
  assert.equal(vacio.matches.length, 2);
  assert.ok(vacio.matches.every((m) => m.teamA === "" && m.teamB === ""));
  assert.equal(vacio.deadline, "");
  // Jornada nueva, con borrador.
  d.saveRoundDraft("new", { matches: [{ id: "m_1", teamA: "León", teamB: "Santos" }], deadline: "2026-12-01T20:00" });
  assert.deepEqual(d.roundsFormDraft(null), { matches: [{ id: "m_1", teamA: "León", teamB: "Santos" }], deadline: "2026-12-01T20:00" });
  // Edición, sin borrador: la jornada tal cual, con su huella.
  const round = imported();
  const limpio = d.roundsFormDraft(round);
  assert.deepEqual(limpio.matches, round.matches);
  assert.notEqual(limpio.matches[0], round.matches[0], "una copia, no la jornada misma");
  assert.equal(limpio.deadline, d.toLocalInputValue(round.deadline));
  assert.equal(limpio.base, d.roundDraftBase(round));
  // Edición, con borrador: lo escrito, sobre los datos del proveedor.
  d.saveRoundDraft("edit:r_1", { matches: [{ id: "m_a1", teamA: "América", teamB: "Guadalajara" }], deadline: "2026-12-04T20:00" }, limpio.base);
  const restaurado = d.roundsFormDraft(round);
  assert.deepEqual(restaurado.matches, [{ ...round.matches[0], teamB: "Guadalajara" }]);
  assert.equal(restaurado.deadline, "2026-12-04T20:00");
  assert.equal(restaurado.base, limpio.base, "la huella sigue siendo la de cuando empezó la edición");
  // Si la jornada cambió, vuelve a la jornada tal cual.
  const cambiada = imported(); cambiada.deadline = "2026-12-07T02:00:00.000Z";
  assert.deepEqual(d.roundsFormDraft(cambiada).matches, cambiada.matches);
});

test("#35 · sin sessionStorage (modo privado, bloqueado) el formulario sigue funcionando como antes", () => {
  const d = draftsFor("ofi", memStorage({ failing: true }));
  assert.doesNotThrow(() => d.saveRoundDraft("new", { matches: [{ id: "m_1", teamA: "León", teamB: "Santos" }], deadline: "" }));
  assert.equal(d.loadRoundDraft("new"), null);
  assert.doesNotThrow(() => d.clearRoundDraft("new"));
  assert.equal(d.roundsFormDraft(null).matches.length, 2);
});

// ======================= el cableado =======================

test("#35 · «Prepara tu primera jornada» restaura, guarda al escribir y borra al publicar", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupManual(opts)");
  assert.ok(body.includes('const saved = loadRoundDraft("new");'));
  assert.ok(body.includes("const matches = saved ? saved.matches : [blankMatch(), blankMatch()];"));
  assert.ok(body.includes('deadlineValue: saved ? saved.deadline : "",'));
  assert.ok(/wireSetupMatchRows\(matches, \(\) => saveRoundDraft\("new",\s*\{ matches, deadline: document\.getElementById\("qz-setup-deadline"\)\.value \}\)\);/.test(body));
  const ok = body.slice(body.indexOf("if(result.ok){"), body.indexOf("} else {", body.indexOf("if(result.ok){")));
  assert.ok(ok.includes('clearRoundDraft("new");'), "publicada: el borrador ya no hace falta");
  assert.ok(ok.indexOf('clearRoundDraft("new");') < ok.indexOf("renderAdminSetupInvite();"));
  const fail = body.slice(body.indexOf("} else {", body.indexOf("if(result.ok){")));
  assert.ok(!fail.includes("clearRoundDraft"), "si no se publicó, lo escrito se queda");
  // El paso de la contraseña (opción B) no lo borra: sale ANTES de tocar nada.
  const gate = body.indexOf('if(!(await gateFirstPublish(cta, "before"))) return;');
  assert.ok(gate !== -1 && gate < body.indexOf('clearRoundDraft("new");'));
});

test("#35 · «Revisa tu primera jornada» restaura sobre la copia completa, con su huella, y borra al publicar", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round)");
  assert.ok(body.includes('const draftKind = "edit:" + roundId;'));
  assert.ok(body.includes("const draftBase = roundDraftBase(round);"));
  assert.ok(body.includes("const saved = loadRoundDraft(draftKind, draftBase);"));
  // Sobre la copia completa ({...m}), para no perder los datos del proveedor.
  assert.ok(body.indexOf("const matches = round.matches.map(m => ({...m}));") < body.indexOf("mergeRoundDraftMatches(matches, saved.matches)"));
  assert.ok(body.includes('if(saved) document.getElementById("qz-setup-deadline").value = saved.deadline;'));
  assert.ok(body.includes("}, draftBase));"), "lo que se guarda lleva la huella de la jornada");
  const ok = body.slice(body.indexOf("if(result.ok){"), body.indexOf("} else {", body.indexOf("if(result.ok){")));
  assert.ok(ok.includes("clearRoundDraft(draftKind);"));
  assert.ok(!body.slice(body.indexOf("} else {", body.indexOf("if(result.ok){"))).includes("clearRoundDraft"));
});

test("#35 · las filas del setup avisan de cada cambio: escribir, añadir, quitar y el cierre", () => {
  const wire = extractFunctionBody(indexSrc, "function wireSetupMatchRows(matches, onChange)");
  const row = extractFunctionBody(indexSrc, "function wireOneSetupRow(matches, mid, changed)");
  assert.ok(wire.includes('deadlineEl.addEventListener("input", changed);'));
  assert.ok(wire.includes('deadlineEl.addEventListener("change", changed);'), "hay selectores móviles que sólo avisan con change");
  assert.ok(/insertAdjacentHTML[\s\S]*changed\(\);/.test(wire), "añadir un partido");
  assert.ok(/m\[inp\.dataset\.role\] = inp\.value;\s*changed\(\);/.test(row), "escribir un equipo");
  assert.ok(/row\.remove\(\);\s*changed\(\);/.test(row), "quitar un partido");
});

test("#35 · Admin → Jornadas: arranca del borrador, lo guarda en cada cambio y lo borra al terminar", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminRondas(body)");
  assert.ok(body.includes("draft = roundsFormDraft(editingRound);"));
  assert.ok(body.includes('const draftKind = editingRound ? "edit:" + editingRound.id : "new";'));
  assert.ok(body.includes("const persistDraft = () => saveRoundDraft(draftKind, draft, editingRound ? draft.base : null);"));
  assert.ok(/m\[inp\.dataset\.role\] = inp\.value;\s*persistDraft\(\);/.test(body), "escribir (y elegir del combo, que dispara input)");
  assert.ok(/draft\.matches = draft\.matches\.filter\(x=>x\.id!==mid\);\s*persistDraft\(\);/.test(body), "quitar");
  assert.ok(/draft\.matches\.push\(blankMatch\(\)\);\s*persistDraft\(\);/.test(body), "añadir");
  assert.ok(body.includes("const onDeadline = (e) => { draft.deadline = e.target.value; persistDraft(); };"));
  assert.ok(body.includes('deadlineInput.addEventListener("input", onDeadline);') && body.includes('deadlineInput.addEventListener("change", onDeadline);'));
  // Cancelar una edición la descarta.
  const cancel = body.slice(body.indexOf('cancelBtn.addEventListener("click"'), body.indexOf('cancelBtn.addEventListener("click"') + 300);
  assert.ok(cancel.includes("clearRoundDraft(draftKind);"));
  // Editar: guardado -> se borra; fallo -> se borra ANTES de reconstruir desde la jornada restaurada.
  const edit = body.slice(body.indexOf("if(editingRound){\n        const saveBtn"));
  const editOk = edit.slice(edit.indexOf("if(result.ok){"), edit.indexOf("} else {"));
  assert.ok(editOk.includes("clearRoundDraft(draftKind);"));
  const editFail = edit.slice(edit.indexOf("} else {"), edit.indexOf("return;"));
  assert.ok(editFail.indexOf("clearRoundDraft(draftKind);") !== -1
    && editFail.indexOf("clearRoundDraft(draftKind);") < editFail.indexOf("renderAdminRondas(body);"));
  // Nueva: publicada -> se borra; fallo -> se queda (lo escrito sigue en el formulario).
  const nueva = body.slice(body.indexOf("// Onboarding B: only a NEW round publishes"));
  const nuevaOk = nueva.slice(nueva.indexOf("if(result.ok){"), nueva.indexOf("} else {", nueva.indexOf("if(result.ok){")));
  assert.ok(nuevaOk.includes('clearRoundDraft("new");'));
  assert.ok(!nueva.slice(nueva.indexOf("} else {", nueva.indexOf("if(result.ok){"))).includes("clearRoundDraft"));
});

test("#35 · borrar una jornada borra también una edición suya sin guardar", () => {
  const body = extractFunctionBody(indexSrc, "async function deleteRoundWithRollback(btn, roundId)");
  const ok = body.slice(body.indexOf("if(result.ok){"), body.indexOf("}else{"));
  assert.ok(ok.includes('clearRoundDraft("edit:" + roundId);'));
});

test("#35 · el borrador vive en sessionStorage (la pestaña), nunca en localStorage", () => {
  assert.ok(helpersSrc.includes("window.sessionStorage.getItem(roundDraftKey(kind))"));
  assert.ok(!helpersSrc.includes("localStorage"));
});
