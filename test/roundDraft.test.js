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

function memStorage({ failing = false, full = false } = {}) {
  const m = new Map();
  const boom = () => { throw new Error("SecurityError"); };
  return {
    map: m,
    getItem: failing ? boom : (k) => (m.has(k) ? m.get(k) : null),
    setItem: failing || full ? boom : (k, v) => { m.set(k, String(v)); },
    removeItem: failing ? boom : (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}
let n = 0;
// Una pestaña: su sessionStorage, la quiniela abierta, quién entró y la meta.
function draftsFor(slug, storage, { user = { id: "p_ana" }, meta = { rounds: [] } } = {}) {
  const window = { sessionStorage: storage };
  const blankMatch = () => ({ id: "m_blank" + (++n), teamA: "", teamB: "" });
  const toasts = [];
  const api = new Function("window", "SLUG", "blankMatch", "currentUser", "meta", "toast", `${toLocalInputValueSrc}
    ${helpersSrc}
    return { roundDraftKey, roundDraftBase, newRoundDraftBase, parseRoundDraft, isRoundDraftEmpty, isRoundDraftPublished,
      mergeRoundDraftMatches, loadRoundDraft, saveRoundDraft, clearRoundDraft, clearAllRoundDrafts, loadNewRoundDraft,
      dropIfAlreadyPublished, roundsFormDraft, toLocalInputValue };`)(window, slug, blankMatch, user, meta, (t) => toasts.push(t));
  return Object.assign(api, { toasts, meta });
}

const imported = () => ({
  id: "r_1", number: 1, published: false, resultsPublished: false, deadline: "2026-12-05T02:00:00.000Z",
  matches: [
    { id: "m_a1", teamA: "América", teamB: "Chivas", externalEventId: "123", externalHomeId: "10", externalAwayId: "20", kickoffAt: "2026-12-05T03:00:00Z" },
    { id: "m_a2", teamA: "Pumas", teamB: "Cruz Azul", externalEventId: "124", kickoffAt: "2026-12-05T05:00:00Z" },
  ],
});
const nuevo = () => ({ matches: [{ id: "m_1", teamA: "León", teamB: "Santos" }, { id: "m_2", teamA: "Toluca", teamB: "" }], deadline: "2026-12-01T20:00" });

// ======================= guardar y leer =======================

test("#35 · un borrador se guarda y vuelve igual", () => {
  const d = draftsFor("ofi", memStorage());
  d.saveRoundDraft("new", nuevo(), d.newRoundDraftBase(d.meta));
  assert.deepEqual(d.loadNewRoundDraft(d.meta), nuevo());
});

test("#35 · el borrador es de esta quiniela y de esta persona: nadie más lo ve, aunque comparta la pestaña", () => {
  const storage = memStorage();
  const ana = draftsFor("ofi", storage);
  ana.saveRoundDraft("new", nuevo(), ana.newRoundDraftBase(ana.meta));
  assert.equal(draftsFor("amigos", storage).loadNewRoundDraft({ rounds: [] }), null, "otra quiniela");
  assert.equal(draftsFor("ofi", storage, { user: { id: "p_carla" } }).loadNewRoundDraft({ rounds: [] }), null, "otra persona (co-admin)");
  assert.ok(draftsFor("ofi", storage).loadNewRoundDraft({ rounds: [] }), "y Ana lo sigue teniendo");
  assert.deepEqual([...storage.map.keys()], ["qracks_round_draft:ofi:p_ana:new"]);
  // Quien entra con la contraseña de administrador, sin persona, tiene el suyo.
  assert.equal(draftsFor("ofi", storage, { user: null }).roundDraftKey("new"), "qracks_round_draft:ofi:owner:new");
});

test("#35 · el borrador de jornada nueva es del torneo en curso: al cerrar el torneo deja de aplicar", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage, { meta: { rounds: [], tournamentEpoch: 3 } });
  d.saveRoundDraft("new", nuevo(), d.newRoundDraftBase(d.meta));
  assert.ok(d.loadNewRoundDraft({ rounds: [], tournamentEpoch: 3 }));
  assert.equal(d.loadNewRoundDraft({ rounds: [], tournamentEpoch: 4 }), null, "cerrado (aquí o en otra pestaña): torneo nuevo");
  assert.equal(storage.map.size, 0, "y se descarta");
  assert.equal(d.newRoundDraftBase({}), "epoch:0", "una quiniela sin ciclo todavía es la 0");
});

test("#35 · filas en blanco y sin cierre no son un borrador: no se guarda nada", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  d.saveRoundDraft("new", { matches: [{ id: "m_1", teamA: "León", teamB: "" }], deadline: "" });
  assert.equal(storage.map.size, 1);
  d.saveRoundDraft("new", { matches: [{ id: "m_1", teamA: "  ", teamB: "" }, { id: "m_2", teamA: "", teamB: "" }], deadline: "" });
  assert.equal(storage.map.size, 0, "lo borró todo a mano: el borrador desaparece en vez de volver vacío");
  d.saveRoundDraft("new", { matches: [], deadline: "2026-12-01T20:00" });
  assert.deepEqual(d.loadRoundDraft("new"), { matches: [], deadline: "2026-12-01T20:00" }, "sólo el cierre ya cuenta");
});

test("#35 · sólo se guardan nombres de equipo y la fecha, nunca lo demás que traiga el partido", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  const round = imported();
  d.saveRoundDraft("edit:r_1", { matches: round.matches, deadline: "2026-12-04T20:00", pin: "1234" }, d.roundDraftBase(round));
  const stored = JSON.parse(storage.map.get("qracks_round_draft:ofi:p_ana:edit:r_1"));
  assert.deepEqual(Object.keys(stored).sort(), ["base", "deadline", "matches"]);
  stored.matches.forEach((m) => assert.deepEqual(Object.keys(m).sort(), ["id", "teamA", "teamB"]));
});

test("#35 · lo que no tiene forma de borrador no vuelve, y se borra", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  const KEY = "qracks_round_draft:ofi:p_ana:new";
  const malos = [
    "{no es json",
    JSON.stringify(null),
    JSON.stringify({ deadline: "2026-12-01T20:00" }),                                   // sin partidos
    JSON.stringify({ matches: "León" }),
    JSON.stringify({ matches: [{ id: 'm_1"><img src=x onerror=alert(1)>', teamA: "A", teamB: "B" }] }), // id que rompería el atributo
    JSON.stringify({ matches: [{ id: "m 1", teamA: "A", teamB: "B" }] }),
    JSON.stringify({ matches: [{ teamA: "A", teamB: "B" }] }),
    JSON.stringify({ matches: [{ id: "m_1", teamA: "A", teamB: "B" }, { id: "m_1", teamA: "C", teamB: "D" }] }), // id repetido
    JSON.stringify({ matches: [{ id: "m_1", teamA: "x".repeat(100001), teamB: "B" }] }),   // más grande que el límite
    JSON.stringify({ base: "{}", matches: [] }),                                       // la base no es la pedida
  ];
  for (const raw of malos) {
    storage.map.set(KEY, raw);
    assert.equal(d.loadRoundDraft("new"), null, raw.slice(0, 60));
    assert.equal(storage.map.has(KEY), false, "un borrador inservible no se queda guardado");
  }
});

test("#35 · lo restaurado es exactamente lo escrito: un cierre con otra forma vuelve vacío, un nombre nunca se recorta", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  storage.map.set("qracks_round_draft:ofi:p_ana:new", JSON.stringify({
    deadline: '2026-12-01T20:00"><script>x</script>',
    matches: [{ id: "m_1", teamA: 42, teamB: "x".repeat(500) }],
  }));
  assert.deepEqual(d.loadRoundDraft("new"), { deadline: "", matches: [{ id: "m_1", teamA: "", teamB: "x".repeat(500) }] });
  const grande = { matches: Array.from({ length: 150 }, (_, i) => ({ id: "m_" + i, teamA: "Local " + i, teamB: "Visita " + i })), deadline: "2026-12-01T20:00" };
  d.saveRoundDraft("new", grande);
  assert.deepEqual(d.loadRoundDraft("new"), grande, "una jornada grande vuelve entera");
});

test("#35 · un borrador que no cabe no se guarda, y no deja una versión vieja que vuelva después", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  d.saveRoundDraft("new", nuevo());
  assert.equal(storage.map.size, 1);
  d.saveRoundDraft("new", { matches: [{ id: "m_1", teamA: "x".repeat(100001), teamB: "Santos" }], deadline: "" });
  assert.equal(storage.map.size, 0, "la versión anterior no se queda como si fuera la actual");
  const llena = memStorage({ full: true });
  llena.map.set("qracks_round_draft:ofi:p_ana:new", JSON.stringify({ deadline: "", matches: [{ id: "m_1", teamA: "Vieja", teamB: "Versión" }] }));
  const dl = draftsFor("ofi", llena);
  assert.doesNotThrow(() => dl.saveRoundDraft("new", nuevo()));
  assert.equal(llena.map.size, 0, "con el almacenamiento lleno, mejor nada que algo viejo");
});

test("#35 · sin sessionStorage (modo privado, bloqueado) el formulario sigue funcionando como antes", () => {
  const d = draftsFor("ofi", memStorage({ failing: true }));
  assert.doesNotThrow(() => d.saveRoundDraft("new", nuevo(), "epoch:0"));
  assert.equal(d.loadRoundDraft("new"), null);
  assert.equal(d.loadNewRoundDraft(d.meta), null);
  assert.doesNotThrow(() => d.clearRoundDraft("new"));
  assert.doesNotThrow(() => d.clearAllRoundDrafts());
  assert.equal(d.roundsFormDraft(null, d.meta).matches.length, 2);
});

// ======================= ediciones =======================

test("#35 · un borrador de edición sólo aplica a la jornada tal como estaba al empezar", () => {
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  const round = imported();
  const base = d.roundDraftBase(round);
  d.saveRoundDraft("edit:r_1", { matches: [{ id: "m_a1", teamA: "América", teamB: "Guadalajara" }], deadline: "2026-12-04T20:00" }, base);
  assert.ok(d.loadRoundDraft("edit:r_1", base), "misma jornada: vuelve");
  const cambiada = imported(); cambiada.matches[1].teamB = "Monterrey";
  assert.equal(d.loadRoundDraft("edit:r_1", d.roundDraftBase(cambiada)), null, "otro admin la cambió: ya no aplica");
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
  assert.equal(mod((r) => { r.matches[0].kickoffAt = "2026-12-05T04:00:00Z"; }), base,
    "el horario del proveedor no lo edita el formulario: moverlo no invalida lo escrito");
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
  const vacio = d.roundsFormDraft(null, d.meta);
  assert.equal(vacio.matches.length, 2);
  assert.ok(vacio.matches.every((m) => m.teamA === "" && m.teamB === ""));
  assert.equal(vacio.deadline, "");
  d.saveRoundDraft("new", nuevo(), d.newRoundDraftBase(d.meta));
  assert.deepEqual(d.roundsFormDraft(null, d.meta), nuevo());
  const round = imported();
  const limpio = d.roundsFormDraft(round, { rounds: [round] });
  assert.deepEqual(limpio.matches, round.matches);
  assert.notEqual(limpio.matches[0], round.matches[0], "una copia, no la jornada misma");
  assert.equal(limpio.deadline, d.toLocalInputValue(round.deadline));
  assert.equal(limpio.base, d.roundDraftBase(round));
  d.saveRoundDraft("edit:r_1", { matches: [{ id: "m_a1", teamA: "América", teamB: "Guadalajara" }], deadline: "2026-12-04T20:00" }, limpio.base);
  const restaurado = d.roundsFormDraft(round, { rounds: [round] });
  assert.deepEqual(restaurado.matches, [{ ...round.matches[0], teamB: "Guadalajara" }]);
  assert.equal(restaurado.deadline, "2026-12-04T20:00");
  assert.equal(restaurado.base, limpio.base, "la huella sigue siendo la de cuando empezó la edición");
  const cambiada = imported(); cambiada.deadline = "2026-12-07T02:00:00.000Z";
  assert.deepEqual(d.roundsFormDraft(cambiada, { rounds: [cambiada] }).matches, cambiada.matches);
});

// ======================= nunca dos veces la misma jornada =======================

test("#35 · un borrador nuevo que ya se publicó no vuelve: ni al cargarlo, ni en «Crear jornada»", () => {
  // La respuesta de la primera publicación se perdió: el servidor sí la
  // guardó, con los mismos ids de partido que el borrador.
  const storage = memStorage();
  const d = draftsFor("ofi", storage);
  const draft = { matches: [{ id: "m_ab1", teamA: "León", teamB: "Santos" }, { id: "m_ab2", teamA: "Toluca", teamB: "Pachuca" }], deadline: "2026-12-01T20:00" };
  const publicada = { id: "r_1", number: 1, published: true, deadline: "2026-12-02T02:00:00.000Z", matches: draft.matches.map((m) => ({ ...m })) };
  assert.equal(d.isRoundDraftPublished(draft, [publicada]), true);
  assert.equal(d.isRoundDraftPublished(draft, []), false);
  assert.equal(d.isRoundDraftPublished(draft, [imported()]), false, "otra jornada, otros ids");
  assert.equal(d.isRoundDraftPublished(null, [publicada]), false);
  const conJornada = { rounds: [publicada] };
  d.saveRoundDraft("new", draft, d.newRoundDraftBase(conJornada));
  const form = d.roundsFormDraft(null, conJornada);
  assert.ok(form.matches.every((m) => m.teamA === "" && m.teamB === ""), JSON.stringify(form.matches));
  assert.equal(form.deadline, "");
  assert.equal(storage.map.size, 0, "«Crear jornada 2» en blanco, y el borrador se va");
  d.saveRoundDraft("new", draft, d.newRoundDraftBase(conJornada));
  assert.equal(d.loadNewRoundDraft(conJornada), null, "el setup tampoco lo recibe");
  d.saveRoundDraft("new", draft, d.newRoundDraftBase(d.meta));
  assert.deepEqual(d.loadNewRoundDraft({ rounds: [imported()] }), draft, "sin esos partidos publicados, vuelve como siempre");
});

test("#35 · al publicar, si eso ya estaba publicado, no se publica otra vez: se avisa y se descarta", () => {
  const storage = memStorage();
  const draft = { matches: [{ id: "m_ab1", teamA: "León", teamB: "Santos" }], deadline: "2026-12-01T20:00" };
  const meta = { rounds: [{ id: "r_1", number: 1, published: true, matches: [{ id: "m_ab1", teamA: "León", teamB: "Santos" }] }] };
  const d = draftsFor("ofi", storage, { meta });
  d.saveRoundDraft("new", draft, d.newRoundDraftBase(meta));
  assert.equal(d.dropIfAlreadyPublished(draft.matches), true);
  assert.equal(storage.map.size, 0);
  assert.deepEqual(d.toasts, ["Esa jornada ya estaba publicada."]);
  const libre = draftsFor("ofi", memStorage(), { meta: { rounds: [] } });
  assert.equal(libre.dropIfAlreadyPublished(draft.matches), false, "lo que no está publicado se publica");
  assert.deepEqual(libre.toasts, []);
});

test("#35 · cerrar el torneo borra los borradores de esta persona en esta quiniela, y sólo esos", () => {
  const storage = memStorage();
  const ana = draftsFor("ofi", storage);
  ana.saveRoundDraft("new", nuevo(), "epoch:0");
  ana.saveRoundDraft("edit:r_1", nuevo(), "{}");
  draftsFor("ofi", storage, { user: { id: "p_carla" } }).saveRoundDraft("new", nuevo(), "epoch:0");
  draftsFor("amigos", storage).saveRoundDraft("new", nuevo(), "epoch:0");
  storage.map.set("qracks_crear_draft", "{}");
  ana.clearAllRoundDrafts();
  assert.deepEqual([...storage.map.keys()].sort(), ["qracks_crear_draft", "qracks_round_draft:amigos:p_ana:new", "qracks_round_draft:ofi:p_carla:new"]);
});

// ======================= el cableado =======================

test("#35 · «Prepara tu primera jornada» restaura, guarda al escribir y borra al publicar", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupManual(opts)");
  assert.ok(body.includes("const saved = loadNewRoundDraft(meta);"), "del torneo en curso, salvo que ya esté publicado");
  assert.ok(body.includes("const matches = saved ? saved.matches : [blankMatch(), blankMatch()];"));
  assert.ok(body.includes('deadlineValue: saved ? saved.deadline : "",'));
  assert.ok(/wireSetupMatchRows\(matches, \(\) => saveRoundDraft\("new",\s*\{ matches, deadline: document\.getElementById\("qz-setup-deadline"\)\.value \}, newRoundDraftBase\(meta\)\)\);/.test(body));
  const okIdx = body.indexOf("if(result.ok){");
  const ok = body.slice(okIdx, body.indexOf("} else {", okIdx));
  assert.ok(ok.includes('clearRoundDraft("new");') && ok.indexOf('clearRoundDraft("new");') < ok.indexOf("renderAdminSetupInvite();"),
    "publicada: el borrador ya no hace falta");
  assert.ok(!body.slice(body.indexOf("} else {", okIdx)).includes("clearRoundDraft"), "si no se publicó, lo escrito se queda");
  // Nunca una segunda copia, y el paso de la contraseña (opción B) va antes.
  const guard = body.indexOf("if(dropIfAlreadyPublished(clean)){ await renderAdminSetupResolve(); return; }");
  assert.ok(guard !== -1);
  assert.ok(body.indexOf('if(!(await gateFirstPublish(cta, "before"))) return;') < guard);
  assert.ok(guard < body.indexOf("meta.rounds.push(round);"));
});

test("#35 · «Revisa tu primera jornada» restaura sobre la copia completa, con su huella, y borra al publicar", () => {
  const body = extractFunctionBody(indexSrc, "function renderAdminSetupReview(round)");
  assert.ok(body.includes('const draftKind = "edit:" + roundId;'));
  assert.ok(body.includes("const draftBase = roundDraftBase(round);"));
  assert.ok(body.includes("const saved = loadRoundDraft(draftKind, draftBase);"));
  assert.ok(body.indexOf("const matches = round.matches.map(m => ({...m}));") < body.indexOf("mergeRoundDraftMatches(matches, saved.matches)"),
    "sobre la copia completa ({...m}), para no perder los datos del proveedor");
  assert.ok(body.includes('if(saved) document.getElementById("qz-setup-deadline").value = saved.deadline;'));
  assert.ok(body.includes("}, draftBase));"), "lo que se guarda lleva la huella de la jornada");
  const okIdx = body.indexOf("if(result.ok){");
  assert.ok(body.slice(okIdx, body.indexOf("} else {", okIdx)).includes("clearRoundDraft(draftKind);"));
  assert.ok(!body.slice(body.indexOf("} else {", okIdx)).includes("clearRoundDraft"));
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
  assert.ok(body.includes("draft = roundsFormDraft(editingRound, meta);"));
  assert.ok(/if\(draft && !editingRound && isRoundDraftPublished\(draft, meta\.rounds\)\)\{\s*clearRoundDraft\("new"\);\s*draft = null;/.test(body),
    "lo que ya se publicó no se ofrece otra vez, ni desde la memoria");
  assert.ok(body.indexOf("isRoundDraftPublished(draft, meta.rounds)") < body.indexOf("draft = roundsFormDraft(editingRound, meta);"));
  assert.ok(body.includes('const draftKind = editingRound ? "edit:" + editingRound.id : "new";'));
  assert.ok(body.includes("const persistDraft = () => saveRoundDraft(draftKind, draft, editingRound ? draft.base : newRoundDraftBase(meta));"));
  assert.ok(/m\[inp\.dataset\.role\] = inp\.value;\s*persistDraft\(\);/.test(body), "escribir (y elegir del combo, que dispara input)");
  assert.ok(/draft\.matches = draft\.matches\.filter\(x=>x\.id!==mid\);\s*persistDraft\(\);/.test(body), "quitar");
  assert.ok(/draft\.matches\.push\(blankMatch\(\)\);\s*persistDraft\(\);/.test(body), "añadir");
  assert.ok(body.includes("const onDeadline = (e) => { draft.deadline = e.target.value; persistDraft(); };"));
  assert.ok(body.includes('deadlineInput.addEventListener("input", onDeadline);') && body.includes('deadlineInput.addEventListener("change", onDeadline);'));
  const cancel = body.slice(body.indexOf('cancelBtn.addEventListener("click"'), body.indexOf('cancelBtn.addEventListener("click"') + 300);
  assert.ok(cancel.includes("clearRoundDraft(draftKind);"), "Cancelar descarta la edición");
  // Editar: guardado -> se borra; fallo -> se borra ANTES de reconstruir desde la jornada restaurada.
  const edit = body.slice(body.indexOf("if(editingRound){\n        const saveBtn"));
  const editOk = edit.slice(edit.indexOf("if(result.ok){"), edit.indexOf("} else {"));
  assert.ok(editOk.includes("clearRoundDraft(draftKind);"));
  const editFail = edit.slice(edit.indexOf("} else {"), edit.indexOf("return;"));
  assert.ok(editFail.indexOf("clearRoundDraft(draftKind);") !== -1
    && editFail.indexOf("clearRoundDraft(draftKind);") < editFail.indexOf("renderAdminRondas(body);"));
  // Nueva: nunca dos veces; publicada -> se borra; fallo -> se queda.
  const nueva = body.slice(body.indexOf("// Onboarding B: only a NEW round publishes"));
  const guard = nueva.indexOf("if(dropIfAlreadyPublished(clean)){ renderAdminRondas._draft = null; renderAdmin(document.getElementById(\"qz-main\")); return; }");
  assert.ok(guard !== -1 && guard < nueva.indexOf("meta.rounds.push(round);"));
  const okIdx = nueva.indexOf("if(result.ok){");
  assert.ok(nueva.slice(okIdx, nueva.indexOf("} else {", okIdx)).includes('clearRoundDraft("new");'));
  assert.ok(!nueva.slice(nueva.indexOf("} else {", okIdx)).includes("clearRoundDraft"));
});

test("#35 · pasar a «Editar» otra jornada abandona la edición anterior, como antes, y su copia guardada", () => {
  const body = extractFunctionBody(indexSrc, "async function openRoundEditor(body, roundId)");
  assert.ok(body.includes("const previousId = renderAdminRondas._editingId;"));
  assert.ok(body.includes('if(previousId && previousId !== roundId) clearRoundDraft("edit:" + previousId);'));
  assert.ok(body.indexOf("clearRoundDraft(") < body.indexOf("renderAdminRondas._editingId = roundId;"));
});

test("#35 · al cerrar el torneo, lo que se estaba escribiendo era del torneo que terminó", () => {
  const body = extractFunctionBody(indexSrc, "async function finishClose(r)");
  const clear = body.indexOf("clearAllRoundDrafts();");
  assert.ok(clear !== -1 && clear > body.indexOf("adoptFreshMeta(meta, fresh)") && clear < body.indexOf('renderAdmin(document.getElementById("qz-main"));'));
  assert.ok(body.includes("renderAdminRondas._editingId = null;") && body.includes("renderAdminRondas._draft = null;"));
});

test("#35 · borrar una jornada borra también una edición suya sin guardar", () => {
  const body = extractFunctionBody(indexSrc, "async function deleteRoundWithRollback(btn, roundId)");
  const ok = body.slice(body.indexOf("if(result.ok){"), body.indexOf("}else{"));
  assert.ok(ok.includes('clearRoundDraft("edit:" + roundId);'));
});

test("#35 · lo restaurado se pinta escapado: nombres e ids, en el setup y en Admin → Jornadas", () => {
  const escSrc = extractFunctionBody(indexSrc, "function esc(s)");
  const rowSrc = extractFunctionBody(indexSrc, "function setupMatchRowHtml(m)");
  const row = new Function(`${escSrc}\n${rowSrc}\nreturn setupMatchRowHtml;`)();
  const html = row({ id: 'm_1"><img src=x onerror=alert(1)>', teamA: '"><img src=x onerror=alert(2)>', teamB: "</script><svg onload=alert(3)>" });
  assert.ok(!/<img|<svg|<\/script/i.test(html), html);
  assert.ok(html.includes("&quot;&gt;&lt;img") && html.includes("&lt;/script&gt;"));
  const rondas = extractFunctionBody(indexSrc, "async function renderAdminRondas(body)");
  const adminRow = rondas.slice(rondas.indexOf("function matchRowHtml(m, idx)"), rondas.indexOf("const createCardHtml"));
  for (const frag of ['data-mid="${esc(m.id)}"', 'value="${esc(m.teamA)}"', 'value="${esc(m.teamB)}"', 'data-remove="${esc(m.id)}"']) {
    assert.ok(adminRow.includes(frag), "Admin → Jornadas: " + frag);
    assert.ok(rowSrc.includes(frag), "setup: " + frag);
  }
});

test("#35 · el borrador vive en sessionStorage (la pestaña), nunca en localStorage", () => {
  assert.ok(helpersSrc.includes("window.sessionStorage.getItem(roundDraftKey(kind))"));
  assert.ok(!helpersSrc.includes("localStorage"));
});
