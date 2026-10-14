// ms2Ronda4.test.js — MS2, revisión adicional: R4 (apagar la penalización
// avisa los descuentos reales), R5 (texto largo sin espacios), H1 (guardar una
// respuesta no borra las demás), H2 (una fila a medias no desaparece) y H3
// (Local y Visitante con nombre accesible y su partido).
//
// Lo puro se ejecuta con las funciones reales del archivo; el cableado se
// comprueba en el código. El recorrido en el navegador está en la evidencia
// E2E de la entrega.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  let depth = 0, i = source.indexOf("{", start + signature.length);
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}
const fn = (sig) => extractFunctionBody(indexSrc, sig);
const ESC = fn("function esc(s)");

// ---- R4 ---------------------------------------------------------------------

test("R4 · apagar calcula lo que la penalización resta hoy (registro + jornadas cerradas sin resolver) y pregunta antes de escribir; «Cancelar» no guarda nada", () => {
  const reglas = fn("async function renderAdminReglas(body, opts)");
  const save = reglas.slice(reglas.indexOf('document.getElementById("qz-r-pen-save").addEventListener("click"'));
  const off = save.slice(save.indexOf("} else {"), save.indexOf("next = { ...penalty, enabled: false };"));
  assert.ok(off.includes("const effective = meta.participants.map(p => penaltyPointsFor(p)).filter(x => x > 0);"),
    "el mismo cálculo que usa la tabla, sin escribir nada");
  assert.ok(/if\(effective\.length\)\{[\s\S]*await qzConfirm\("Hoy la penalización le resta "[\s\S]*if\(!ok\) return;/.test(off));
  assert.ok(off.includes('title: "¿Apagar la penalización?", confirmLabel: "Apagar", cancelLabel: "Cancelar"'));
  // Nada se toca antes de la confirmación: ni el registro, ni la regla, ni el botón.
  const confirmAt = save.indexOf("await qzConfirm(");
  for (const write of ["reconcilePenaltyLedger(meta);", "meta.paymentPenalty = next;", "setMetaWithError(meta)", "setupBusy(e.currentTarget"]) {
    assert.ok(save.indexOf(write) > confirmAt, write + " va después de la confirmación");
  }
  assert.ok(!off.includes("reconcilePenaltyLedger") && !off.includes("meta.paymentPenalty ="), "cancelar no deja nada a medias");
  // La política de apagar no cambia: sólo enabled:false, como antes.
  assert.ok(save.includes("next = { ...penalty, enabled: false };"));
});

test("R4 · el texto se arma con los números reales: total, personas y singular/plural", () => {
  const reglas = fn("async function renderAdminReglas(body, opts)");
  const at = reglas.indexOf("const effective = meta.participants.map(p => penaltyPointsFor(p))");
  const block = reglas.slice(at, reglas.indexOf("if(!ok) return;", at));
  const msgExpr = block.slice(block.indexOf("qzConfirm(") + "qzConfirm(".length, block.indexOf(",\n", block.indexOf("qzConfirm(")));
  const pointsWord = fn("function pointsWord(n)");
  const build = new Function("effective", `${pointsWord}\nconst total = effective.reduce((a, b) => a + b, 0);\nreturn ${msgExpr};`);
  assert.equal(build([3, 2]), "Hoy la penalización le resta 5 puntos en total a 2 personas. Si la apagas, dejas de restar puntos y esos descuentos dejan de contar en la tabla mientras esté apagada; quedan guardados y regresan si la vuelves a activar.");
  assert.ok(build([1]).startsWith("Hoy la penalización le resta 1 punto en total a 1 persona."));
});

test("R4 · con la penalización ya apagada, penaltyPointsFor da 0 y no hay aviso", () => {
  const f = new Function("meta", `${fn("function penaltyPointsFor(p, cutoffRoundNumber)")}\nreturn penaltyPointsFor;`);
  const meta = { paymentPenalty: { enabled: false, startsAtRound: 1, pointsPerRound: 2 }, rounds: [{ id: "r1", number: 1 }] };
  assert.equal(f(meta)({ penalizedRounds: { r1: 2 } }), 0);
});

// ---- R5 ---------------------------------------------------------------------

test("R5 · los textos que escribe la gente se parten donde haga falta, sin ocultarse; la cabecera y la tabla también", () => {
  const css = indexSrc.slice(0, indexSrc.indexOf("</style>"));
  assert.ok(css.includes("#quiniela-root .qz-header-top > div:first-child{ min-width:0; }"));
  assert.ok(css.includes("#quiniela-root .qz-brand-context{ overflow-wrap:anywhere; }"));
  const rule = css.slice(css.indexOf("#quiniela-root :is(.card p"), css.indexOf("{ overflow-wrap:anywhere; }", css.indexOf("#quiniela-root :is(.card p")));
  for (const sel of [".card p", ".card li", ".card label", ".qz-qcard-text", ".qz-bet-q", ".qz-wz-callout", ".qz-sum-qs li", ".qz-sheet-note", ".qz-modal-message", ".toast"]) {
    assert.ok(rule.includes(sel), sel);
  }
  assert.ok(css.includes("#quiniela-root th.qz-bet-th{ min-width:140px; max-width:240px; overflow-wrap:anywhere; white-space:normal; }"));
  assert.ok(indexSrc.includes('<th colspan="2" class="qz-bet-th" style="text-align:center;">${esc(bet.label)}</th>'));
  // Nada se recorta con puntos suspensivos ni se esconde.
  assert.ok(!/overflow-wrap:anywhere;[^}]*text-overflow:ellipsis/.test(css));
});

// ---- H1 ---------------------------------------------------------------------

function draftsEnv(store = new Map()) {
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const src = ["function answerDraftKey()", "function loadAnswerDrafts()", "function answerDraft(k)", "function setAnswerDraft(k, v)"].map(fn).join("\n");
  return new Function("SLUG", "currentUser", "window", `${src}\nreturn { answerDraftKey, answerDraft, setAnswerDraft };`);
}

test("H1 · borradores por pregunta y por jornada: cada uno se guarda y se borra solo, por quiniela y participante", () => {
  const store = new Map();
  const mk = draftsEnv(store);
  const ana = mk("amigos", { id: "p_ana" }, { sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) } });
  ana.setAnswerDraft("t:cb1", "América");
  ana.setAnswerDraft("t:cb2", "Henry Martín");
  ana.setAnswerDraft("j:r1:cb3", "3 goles");
  // Guardar una no toca las otras.
  ana.setAnswerDraft("t:cb1", null);
  assert.equal(ana.answerDraft("t:cb1"), null);
  assert.equal(ana.answerDraft("t:cb2"), "Henry Martín");
  assert.equal(ana.answerDraft("j:r1:cb3"), "3 goles");
  assert.equal(ana.answerDraftKey(), "qracks_answer_drafts:amigos:p_ana");
  // Otro participante (u otra quiniela) en la misma pestaña no ve los de Ana.
  const beto = mk("amigos", { id: "p_beto" }, { sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) } });
  assert.equal(beto.answerDraft("t:cb2"), null);
  // Tope de 200 caracteres (el mismo maxlength del campo) y JSON roto no rompe nada.
  ana.setAnswerDraft("t:cb9", "x".repeat(500));
  assert.equal(ana.answerDraft("t:cb9").length, 200);
  store.set("qracks_answer_drafts:amigos:p_ana", "{roto");
  assert.equal(ana.answerDraft("t:cb2"), null);
});

test("H1 · sin sessionStorage (modo privado estricto) no falla: sólo no hay borradores", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
  const env = draftsEnv()("amigos", { id: "p_ana" }, { sessionStorage: throwing });
  env.setAnswerDraft("t:cb1", "x");
  assert.equal(env.answerDraft("t:cb1"), null);
});

test("H1 · la fila de una pregunta del torneo pinta el borrador y dice que no está guardado", () => {
  const draft = new Map([["t:cb1", "Cruz Azul"]]);
  const env = new Function("answerDraft", "currentUser", `
    ${ESC}
    const customBetsLocked = () => false;
    const tournamentBetClose = () => ({ text: "Cierra con la Jornada 3.", round: { number: 3 } });
    const savedBetGuess = (id) => id === "cb1" ? "América" : "";
    const tournamentBetStatus = () => "Tu respuesta: «América».";
    const pointsWord = (n) => Number(n) === 1 ? "punto" : "puntos";
    ${fn("function tournamentBetRowHtml(bet)")}
    return tournamentBetRowHtml;`)((k) => (draft.has(k) ? draft.get(k) : null), { customBetAnswers: {} });
  const html = env({ id: "cb1", label: "¿Quién será campeón?", points: 5 });
  assert.ok(html.includes('value="Cruz Azul"'), "lo escrito y no guardado vuelve tras el repintado");
  assert.ok(html.includes("Cambios sin guardar. Toca «Guardar respuesta»."));
  draft.set("t:cb1", "América");
  assert.ok(!env({ id: "cb1", label: "x", points: 5 }).includes("Cambios sin guardar"), "un borrador igual a lo guardado no es un cambio");
});

test("H1 · guardar una respuesta del torneo borra sólo su borrador (si no cambió mientras se guardaba), repinta y devuelve el foco a su campo", () => {
  const w = fn("function wireTournamentBets(main)");
  const ok = w.slice(w.indexOf("if(result.ok){"), w.indexOf("return;", w.indexOf("if(result.ok){")));
  assert.ok(ok.includes('const d = answerDraft("t:" + betId);') && ok.includes('if(d == null || d.trim() === val) setAnswerDraft("t:" + betId, null);'));
  assert.ok(!/setAnswerDraft\("j:/.test(w) && (w.match(/setAnswerDraft\(/g) || []).length === 3, "sólo la propia: al escribir, al guardar y si cerró");
  assert.ok(ok.indexOf("await renderJornada(main);") < ok.indexOf('document.getElementById("qz-cb-input-" + betId)'));
  assert.ok(ok.includes("back.focus({ preventScroll: true });"));
  // Error: el borrador y lo escrito se quedan para reintentar.
  const fail = w.slice(w.indexOf("btn.disabled = false;"));
  assert.ok(fail.includes('"No se pudo guardar. Revisa tu conexión e intenta de nuevo."'));
  assert.ok(!fail.slice(0, fail.indexOf('if(result.error === "bet_locked")')).includes("setAnswerDraft"));
  // Lo que cerró en el camino ya no se puede guardar: su borrador se va.
  assert.ok(/if\(result\.error === "bet_locked"\)\{[\s\S]*setAnswerDraft\("t:" \+ betId, null\);/.test(w));
  // Escribir guarda el borrador; volver a lo guardado lo quita.
  assert.ok(w.includes('setAnswerDraft("t:" + betId, same ? null : input.value);'));
  // La tarjeta se queda como la dejó el participante, y abierta si hay algo sin guardar.
  assert.ok(w.includes('card.addEventListener("toggle", () => { tournamentBetsOpen = card.open; });'));
  assert.ok(fn("function tournamentBetsCardHtml(bets)").includes("const open = hasDraft || (tournamentBetsOpen != null ? tournamentBetsOpen : openUnanswered);"));
});

test("H1 · preguntas de la jornada: el borrador vuelve al repintar, «Guardar respuestas» manda sólo las de esa jornada y sus borradores se van sólo si se guardó (también con «Reintentar»)", () => {
  const v = fn("function renderRoundVoting(box, round, isHeroRound)");
  assert.ok(v.includes('const draft = answerDraft("j:" + round.id + ":" + bet.id);'));
  assert.ok(v.includes("value=\"${esc(draft != null ? draft : (extra[bet.id] || ''))}\""));
  assert.ok(v.indexOf("const roundDraftsPending = jornadaBets.some(") < v.indexOf("box.innerHTML = `"));
  assert.ok(v.includes('${roundDraftsPending ? "Cambios sin guardar." :'));
  // Escribir no guarda nada en el servidor: sólo el borrador.
  const typing = v.slice(v.indexOf('box.querySelectorAll("[data-cb-jornada]").forEach(inp => inp.addEventListener("input"'), v.indexOf("if(jornadaSaveBtn){"));
  assert.ok(typing.includes('setAnswerDraft("j:" + round.id + ":" + inp.dataset.cbJornada, inp.value.trim() === saved ? null : inp.value);'));
  assert.ok(!/attemptSavePicks|setPicks/.test(typing));
  const save = v.slice(v.indexOf("const runJornadaSave = async () => {"), v.indexOf('jornadaSaveBtn.addEventListener("click", runJornadaSave);'));
  assert.ok(/await attemptSavePicks\(stEl, round, \(\) => Object\.keys\(sent\)\.forEach\(id => \{[\s\S]*if\(d == null \|\| d\.trim\(\) === sent\[id\]\) setAnswerDraft\(k, null\);[\s\S]*\}\), false, runJornadaSave\);/.test(save),
    "se borran en onSuccess (que también corre con «Reintentar»), y el reintento vuelve a leer los campos");
  assert.ok(!/setAnswerDraft\([^)]*\)\s*;?\s*\n\s*\}\s*;?\s*$/.test(save.slice(save.lastIndexOf("})"))), "nada se borra fuera de onSuccess");
});

test("H1 · el estado de la jornada no marca «sin guardar» un borrador igual a lo guardado", () => {
  const v = fn("function renderRoundVoting(box, round, isHeroRound)");
  const expr = v.slice(v.indexOf("const roundDraftsPending = "), v.indexOf("box.innerHTML = `"));
  const pending = new Function("jornadaBets", "roundPicks", "round", "answerDraft", `${expr}\nreturn roundDraftsPending;`);
  const bets = [{ id: "cb1" }, { id: "cb2" }];
  const drafts = new Map([["j:r1:cb1", "2-1 "]]);
  assert.equal(pending(bets, { __extra: { cb1: "2-1" } }, { id: "r1" }, (k) => drafts.get(k) ?? null), false);
  drafts.set("j:r1:cb2", "Henry");
  assert.equal(pending(bets, { __extra: { cb1: "2-1" } }, { id: "r1" }, (k) => drafts.get(k) ?? null), true);
});

// ---- H2 ---------------------------------------------------------------------

const rows = () => new Function(`${fn("function matchRowState(m)")}\n${fn("function roundRowsCheck(matches)")}\nreturn { matchRowState, roundRowsCheck };`)();

test("H2 · una fila vacía se ignora; una con un solo equipo se señala con el lado que falta; un partido del calendario sin rival se conserva", () => {
  const { matchRowState, roundRowsCheck } = rows();
  assert.equal(matchRowState({ teamA: "León", teamB: "Puebla" }), "ok");
  assert.equal(matchRowState({ teamA: "  ", teamB: "" }), "empty");
  assert.equal(matchRowState({ teamA: "León", teamB: " " }), "partial");
  assert.equal(matchRowState({ teamA: "", teamB: "Puebla" }), "partial");
  assert.equal(matchRowState({ teamA: "", teamB: "Puebla", externalEventId: "fx9" }), "pending");
  const c = roundRowsCheck([
    { id: "m1", teamA: "León", teamB: "Puebla" },
    { id: "m2", teamA: "", teamB: "" },
    { id: "m3", teamA: "Toluca", teamB: "" },
    { id: "m4", teamA: "", teamB: "Santos", externalEventId: "fx4" },
  ]);
  assert.deepEqual(c.clean.map((m) => m.id), ["m1", "m4"]);
  assert.deepEqual([c.partial.id, c.missing, c.partialCount, c.complete], ["m3", "teamB", 1, 1]);
  assert.equal(roundRowsCheck([{ id: "m5", teamA: "", teamB: "Santos" }]).missing, "teamA");
  assert.equal(roundRowsCheck([]).partial, null);
});

test("H2 · asistente: con una fila a medias no se avanza ni se publica; el error queda junto al campo que falta y nada se borra", () => {
  const problem = new Function("setupFlow", "serverNow", "document", `
    const PARTIAL_ROW_MESSAGE = "falta";
    ${fn("function matchRowState(m)")}
    ${fn("function roundRowsCheck(matches)")}
    const setupDeadlineProblem = () => "";
    ${fn("function setupRoundProblem()")}
    return setupRoundProblem;`);
  const matches = [{ id: "m1", teamA: "León", teamB: "Puebla" }, { id: "m2", teamA: "", teamB: "" }, { id: "m3", teamA: "", teamB: "Santos" }];
  const flow = { rows: { matches, deadline: "2026-10-20T19:00" } };
  const doc = { getElementById: () => null };
  assert.deepEqual(problem(flow, () => 0, doc)(), { field: "rows", message: "falta", mid: "m3", missing: "teamA" });
  assert.equal(matches.length, 3, "las filas siguen ahí");
  matches[2].teamA = "Toluca";
  const ok = problem(flow, () => 0, doc)();
  assert.equal(ok.field, null);
  assert.deepEqual(ok.clean.map((m) => m.id), ["m1", "m3"], "la fila vacía no se publica");
  // El botón del paso 3 pone el error en la fila, en el campo vacío.
  const form = fn("function renderSetupRoundForm(main)");
  assert.ok(form.includes('if(showRowError(row, "qz-wz-row-err-" + problem.mid, problem.missing, problem.message)){ setupFieldError("qz-wz-rows-err", ""); return; }'));
  assert.ok(fn("function showRowError(rowEl, errId, missingRole, message)").includes("setupFieldError(errId, message, inp);"), "aria-invalid y foco en el campo que falta");
  // El resumen tampoco deja publicar.
  const sum = fn("function renderSetupResumen(main)");
  assert.ok(sum.includes('(rowsCheck.partial ? "A un partido le falta un equipo. Toca «Editar» para escribirlo o quitar el partido." : "")'));
  assert.ok(sum.includes("disabled: !!(roundProblem || payProblem)"));
  // El contador lo dice.
  assert.ok(form.includes('(check.partialCount ? ` · ${check.partialCount} sin completar` : "")'));
});

test("H2 · Admin → Jornadas: la fila a medias se señala antes de cualquier otro paso (y antes de tocar la jornada); un partido del calendario sin rival no se pierde al editar", () => {
  const body = fn("async function renderAdminRondas(body)");
  const click = body.slice(body.indexOf('document.getElementById("qz-publish-round").addEventListener("click"'));
  const check = click.indexOf("const rowsCheck = roundRowsCheck(draft.matches);");
  assert.ok(check !== -1 && check < click.indexOf("isSetupDeadlineValid(draft.deadline, serverNow())") && check < click.indexOf("if(editingRound){"));
  assert.ok(/if\(rowsCheck\.partial\)\{[\s\S]*showRowError\(row, "qz-rm-err-" \+ rowsCheck\.partial\.id, rowsCheck\.missing, PARTIAL_ROW_MESSAGE\);\s*return;\s*\}/.test(click));
  assert.ok(click.includes("const clean = rowsCheck.clean;"));
  // Antes: editar el cierre de una jornada de Liguilla quitaba el cruce sin rival.
  const { roundRowsCheck } = rows();
  const liguilla = [{ id: "m1", teamA: "América", teamB: "Pumas", externalEventId: "fx1" }, { id: "m2", teamA: "", teamB: "Toluca", externalEventId: "fx2" }];
  assert.deepEqual(roundRowsCheck(liguilla.map((m) => ({ ...m }))).clean, liguilla);
});

// ---- H3 ---------------------------------------------------------------------

test("H3 · asistente: Local y Visitante tienen etiqueta ligada (for/id) con el número de partido; ✕ dice cuál quita; el error se anuncia en el campo", () => {
  const row = new Function(`${ESC}\nconst fmtKickoff = () => "";\n${fn("function wzMatchRowHtml(m, imported, n)")}\nreturn wzMatchRowHtml;`)();
  const html = row({ id: "m_7", teamA: "León", teamB: "" }, false, 2);
  assert.ok(html.includes('<label for="qz-wz-a-m_7">Local<span class="qz-sr" data-mnum>, partido 2</span></label><input type="text" id="qz-wz-a-m_7"'));
  assert.ok(html.includes('<label for="qz-wz-b-m_7">Visitante<span class="qz-sr" data-mnum>, partido 2</span></label><input type="text" id="qz-wz-b-m_7"'));
  assert.ok(html.includes('aria-label="Quitar partido 2"'));
  assert.equal((html.match(/aria-describedby="qz-wz-row-err-m_7"/g) || []).length, 2);
  assert.ok(html.includes('<p class="qz-field-error" id="qz-wz-row-err-m_7" role="alert" hidden></p>'));
  // Al quitar una fila, los números se rehacen.
  const ren = fn("function renumberSetupRows(rowsEl)");
  assert.ok(ren.includes('el.textContent = ", partido " + (i + 1);') && ren.includes('x.setAttribute("aria-label", "Quitar partido " + (i + 1));'));
});

test("H3 · Admin → Jornadas: lo mismo, con el combo de equipos", () => {
  const body = fn("async function renderAdminRondas(body)");
  const row = new Function(`${ESC}\n${extractFunctionBody(body, "function matchRowHtml(m, idx)")}\nreturn matchRowHtml;`)();
  const html = row({ id: "m_3", teamA: "", teamB: "Santos" }, 0);
  assert.ok(html.includes('<label for="qz-rm-a-m_3">Local<span class="qz-sr">, partido 1</span></label><input type="text" id="qz-rm-a-m_3"'));
  assert.ok(html.includes('<label for="qz-rm-b-m_3">Visitante<span class="qz-sr">, partido 1</span></label><input type="text" id="qz-rm-b-m_3"'));
  assert.ok(html.includes('role="combobox"') && html.includes('aria-label="Quitar partido 1"'));
  assert.ok(html.includes('<p class="qz-field-error" id="qz-rm-err-m_3" role="alert" hidden></p>'));
});

test("H3 · respuestas: cada pregunta de la jornada tiene su etiqueta ligada; las del torneo, su nombre", () => {
  const v = fn("function renderRoundVoting(box, round, isHeroRound)");
  assert.ok(v.includes('<label for="qz-cbj-${esc(round.id)}-${esc(bet.id)}">${esc(bet.label)} (+${esc(bet.points)} ${esc(pointsWord(bet.points))})</label>'));
  assert.ok(v.includes('<input type="text" id="qz-cbj-${esc(round.id)}-${esc(bet.id)}" data-cb-jornada="${esc(bet.id)}" maxlength="200"'));
  assert.ok(fn("function tournamentBetRowHtml(bet)").includes('aria-label="Tu respuesta: ${esc(bet.label)}"'));
});

// ---- P3 arreglados en esta ronda --------------------------------------------

test("P3 · al elegir «Preparar partidos manualmente», el foco va al título del paso, no a la página", () => {
  const j = fn("function renderSetupJornada(main)");
  assert.ok(/d\.manual = true; setSetupCal\(\{ state: "manual" \}\); setupFlow\.rows = null; setupPersist\(\); renderSetupFlow\(\);\s*\/\/[^\n]*\n[^\n]*\n\s*const h = document\.getElementById\("qz-wz-title"\);\s*if\(h\) h\.focus\(\);/.test(j));
});

test("P3 · la invitación: «Copiar link» ya no dice que nadie ha entrado, y cada respuesta a un botón se desplaza a la vista", () => {
  const sheet = fn("function openInviteSheet(opts)");
  assert.ok(!sheet.includes("nadie ha entrado todavía"));
  assert.ok(sheet.includes('feedback.textContent = "✓ Link copiado. Pégalo donde quieras.";'));
  assert.ok(sheet.includes('const showFeedback = () => { try{ feedback.scrollIntoView({ block: "nearest" }); }catch(e){} };'));
  assert.equal((sheet.match(/showFeedback\(\);/g) || []).length, 3, "WhatsApp, Copiar y Añadir participantes");
});
