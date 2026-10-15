// ms2D4.test.js — MS2 · D4 en la pantalla: el cierre propio de cada pregunta
// del torneo, cómo se dice, la elección explícita al mover o reabrir su
// jornada, «Tus reglas», el cierre del torneo y el historial.
//
// Lo puro se ejecuta con las funciones reales de public/index.html; el
// cableado se comprueba en el código. El servidor es quien decide
// (betCloses.js; betCloses.test.js y betCloses.integration.test.js).

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

const NOW = Date.parse("2026-10-15T18:00:00Z");
const at = (h) => new Date(NOW + h * 3600e3).toISOString();
const round = (id, number, h, extra) => ({ id, number, deadline: at(h), matches: [], ...extra });
const own = (over) => ({ id: "cb_x", label: "Campeón", scope: "temporada", points: 5, closesAtRound: 1, closesAt: at(24), closesRoundId: "r_1", closeSource: "round", epoch: 0, ...over });

// Las funciones reales, con una meta de prueba y un reloj fijo.
const env = (meta, extra = "") => new Function("meta", "serverNowMs", "currentUser", "dialogs", `
  const serverNow = () => serverNowMs;
  const qzConfirm = async (msg, opts) => { dialogs.push({ kind: "confirm", msg, opts }); return dialogs.answer !== undefined ? dialogs.answer : true; };
  const qzChoose = async (msg, opts) => { dialogs.push({ kind: "choose", msg, opts }); return dialogs.choice !== undefined ? dialogs.choice : null; };
  const qzAlert = async (msg, opts) => { dialogs.push({ kind: "alert", msg, opts }); return true; };
  ${fn("function esc(s)")}
  ${fn("function pointsWord(n)")}
  ${fn("function fmtWhenTz(iso)")}
  ${fn("function isRoundLocked(round)")}
  ${fn("function betCloseInfo(bet)")}
  ${fn("function sameInstantMs(a, b)")}
  ${fn("function customBetsLocked(bet)")}
  ${fn("function betCloseLine(bet)")}
  ${fn("function betFormCloses(bet)")}
  ${fn("function tournamentBetClose(bet)")}
  ${fn("function savedBetGuess(betId)")}
  ${fn("function tournamentBetStatus(bet)")}
  ${fn("function betsClosingWith(round)")}
  const quotedLabels = (bets) => bets.map(b => "«" + b.label + "»").join(", ");
  ${fn("async function blockedByClosedLegacyBets(round, what)")}
  ${fn("function linkedBetsNote(round, what)")}
  ${fn("async function chooseLinkedBetsClose(round, nextIso, intro)")}
  ${fn("function archivedBetsHtml(t)")}
  ${extra}
  return { betCloseInfo, customBetsLocked, betCloseLine, betFormCloses, tournamentBetClose, tournamentBetStatus, betsClosingWith, linkedBetsNote, chooseLinkedBetsClose, archivedBetsHtml, fmtWhenTz };
`);
const make = (meta, user = { id: "p_b", customBetAnswers: {} }) => { const dialogs = []; const e = env(meta)(meta, NOW, user, dialogs); e.dialogs = dialogs; return e; };

test("D4 · la pantalla lee el cierre propio (closesAt), no la jornada; las antiguas sin migrar, como antes", () => {
  const r1 = round("r_1", 1, 24);
  const e = make({ rounds: [{ ...r1, deadline: at(-1) }], customBets: [] });
  assert.equal(e.customBetsLocked(own()), false, "su jornada ya cerró, ella no");
  assert.equal(e.customBetsLocked(own({ closesAt: at(-1) })), true);
  assert.deepEqual([e.betCloseInfo(own()).kind, e.betCloseInfo({ scope: "temporada", closesAtRound: 1 }).kind, e.betCloseInfo({ scope: "temporada", closeSource: "none", closesAtRound: 1 }).kind, e.betCloseInfo({ scope: "jornada" }).kind],
    ["own", "legacy", "none", "jornada"]);
  assert.equal(e.customBetsLocked({ scope: "temporada", closesAtRound: 1 }), true, "antigua: por número");
});

test("D4 · Tus reglas dice cada estado: con su jornada, con hora propia, jornada borrada, cerrada (y por qué), Sin cierre", () => {
  const e = make({ rounds: [round("r_1", 1, 24), round("r_2", 2, 72)], customBets: [] });
  const w = (h) => e.fmtWhenTz(at(h));
  assert.equal(e.betCloseLine(own()), `Cierra con la Jornada 1: ${w(24)}`);
  assert.equal(e.betCloseLine(own({ closesAt: at(20) })), `Cierra el ${w(20)}; la Jornada 1 cierra el ${w(24)}`);
  assert.equal(e.betCloseLine(own({ closesRoundId: "r_borrada" })), `Cierra el ${w(24)} (su jornada ya no existe)`);
  assert.equal(e.betCloseLine(own({ closesAt: at(-3) })), `Cerró el ${w(-3)}`);
  assert.equal(e.betCloseLine(own({ closesAt: at(-3), closeSource: "migration_cutoff", closeFlag: "lost_link" })), `Cerró el ${w(-3)}, por protección: su jornada de cierre ya no existía`);
  assert.equal(e.betCloseLine(own({ closesAt: at(-3), closeSource: "migration_cutoff", closeFlag: "ambiguous" })), `Cerró el ${w(-3)}, por protección: no se pudo comprobar a qué jornada de qué torneo pertenecía su cierre`);
  assert.equal(e.betCloseLine({ scope: "temporada", closeSource: "none" }), "", "«Sin cierre» va en su aviso");
  assert.ok(indexSrc.includes("sigue abierta hasta que termines el torneo, y entonces se cierra y se archiva"));
  // El selector empieza en lo que hay: su jornada si cierra exactamente con ella, si no «su cierre actual».
  assert.deepEqual([e.betFormCloses(own()), e.betFormCloses(own({ closesAt: at(20) })), e.betFormCloses(own({ closesRoundId: "r_x" })), e.betFormCloses({ scope: "temporada", closesAtRound: 2 })], ["1", "keep", "keep", "2"]);
});

test("D4 · el participante ve su cierre propio y, si ya cerró, cuándo", () => {
  const e = make({ rounds: [round("r_1", 1, 24)], customBets: [] }, { id: "p_b", customBetAnswers: { cb_x: { guess: "León" } } });
  const w = (h) => e.fmtWhenTz(at(h));
  assert.equal(e.tournamentBetClose(own()).text, `Cierra con la Jornada 1: ${w(24)}.`);
  assert.equal(e.tournamentBetClose(own({ closesAt: at(20) })).text, `Cierra el ${w(20)}.`);
  assert.equal(e.tournamentBetClose({ scope: "temporada", closeSource: "none" }).text, "No tiene fecha de cierre: se cierra cuando termine el torneo.");
  assert.equal(e.tournamentBetStatus(own({ closesAt: at(-2) })), `Cerró el ${w(-2)}. Tu respuesta: «León».`);
  assert.equal(e.tournamentBetStatus(own()), `✅ Guardada: «León». Puedes cambiarla hasta el ${w(24)}.`);
});

test("D4 · mover el cierre de una jornada: las cerradas siguen cerradas y las abiertas se mueven sólo si el admin lo elige", async () => {
  const r1 = round("r_1", 1, 24);
  const open = own(), shut = own({ id: "cb_c", label: "Goleador", closesAt: at(-1) }), other = own({ id: "cb_o", label: "Otra", closesRoundId: "r_2", closesAtRound: 2 });
  const meta = { rounds: [r1, round("r_2", 2, 72)], customBets: [open, shut, other] };
  let e = make(meta);
  assert.deepEqual(e.betsClosingWith(r1).map((b) => b.id), ["cb_x", "cb_c"], "por id: la de la J2 no");
  // Sin elegir (Volver) no se guarda nada.
  assert.equal(await e.chooseLinkedBetsClose(r1, at(30)), null);
  const ask = e.dialogs.at(-1);
  assert.equal(ask.kind, "choose");
  assert.ok(ask.msg.includes("Esta pregunta del torneo ya cerró y sigue cerrada: «Goleador». No se vuelven a abrir."));
  assert.ok(ask.msg.includes("Esta pregunta del torneo cierra con esta jornada: «Campeón»"));
  assert.deepEqual(ask.opts.options.map((o) => o.value), ["move", "keep"], "las dos, sin una preseleccionada");
  e = make(meta); e.dialogs.choice = "keep";
  assert.deepEqual(await e.chooseLinkedBetsClose(r1, at(30)), { move: [] });
  e = make(meta); e.dialogs.choice = "move";
  assert.deepEqual((await e.chooseLinkedBetsClose(r1, at(30))).move.map((b) => b.id), ["cb_x"], "nunca la cerrada");
  // Misma hora, o sin preguntas ligadas: nada que decidir.
  assert.deepEqual(await make(meta).chooseLinkedBetsClose(r1, r1.deadline), { move: [] });
  // Sólo cerradas: se confirma, sin elección.
  e = make({ rounds: [r1], customBets: [shut] });
  assert.deepEqual(await e.chooseLinkedBetsClose(r1, at(30)), { move: [] });
  assert.equal(e.dialogs.at(-1).kind, "confirm");
});

test("D4 · una antigua sin migrar ya cerrada por su jornada: mover, reabrir o borrar esa jornada se explica antes y no se intenta", async () => {
  const r1 = round("r_1", 1, -1);
  const legacy = { id: "cb_l", label: "Antigua", scope: "temporada", points: 2, closesAtRound: 1 };
  const e = make({ rounds: [r1], customBets: [legacy] });
  assert.equal(await e.chooseLinkedBetsClose(r1, at(30)), null);
  assert.equal(e.dialogs.at(-1).kind, "alert");
  assert.ok(e.dialogs.at(-1).msg.includes("así que cambiar su cierre la reabriría"));
  const del = fn("async function deleteRoundWithRollback(btn, roundId)");
  assert.ok(del.indexOf('await blockedByClosedLegacyBets(roundToDelete, "eliminarla")') < del.indexOf("await qzConfirm("));
});

test("D4 · borrar una jornada: las abiertas conservan su cierre y se dice cuál", () => {
  const r1 = round("r_1", 1, 24);
  const e = make({ rounds: [r1], customBets: [own()] });
  assert.equal(e.linkedBetsNote(r1, "delete"), `\n\nEsta pregunta del torneo conserva su cierre: «Campeón» (${e.fmtWhenTz(at(24))}). Si quieres otro, elígelo en Admin → Tus reglas.`);
  assert.ok(!indexSrc.includes("se vuelven a abrir: tus amigos podrán responder"), "ya no se ofrece reabrir");
  assert.ok(!indexSrc.includes("quedan abiertas sin fecha de cierre"), "ni quedarse sin cierre");
});

test("D4 · editar y reabrir una jornada aplican la elección en el mismo guardado y la deshacen si falla", () => {
  const rondas = indexSrc.slice(indexSrc.indexOf("const linkedChoice = editingRound ? await chooseLinkedBetsClose("), indexSrc.indexOf("// Onboarding B: only a NEW round publishes; editing never does."));
  assert.ok(rondas.includes("if(!linkedChoice) return;"));
  assert.ok(rondas.indexOf("linkedChoice.move.forEach(b => { b.closesAt = editingRound.deadline; });") < rondas.indexOf("const result = await setMetaWithError(meta);"));
  assert.ok(rondas.includes("meta.customBets = betsSnapshot; }"));
  const reopen = fn("async function renderAdminResultados(body)");
  const r = reopen.slice(reopen.indexOf('const reopenBtn = document.getElementById("qz-reopen-round");'));
  assert.ok(r.indexOf("if(newDeadlineIso === null) return;") < r.indexOf("const linkedChoice = await chooseLinkedBetsClose(round, newDeadlineIso"));
  assert.ok(r.indexOf("linkedChoice.move.forEach(b => { b.closesAt = newDeadlineIso; });") < r.indexOf("const result = await setMetaWithError(meta);"));
  assert.ok(r.includes("meta.customBets = betsSnapshot;"));
});

test("D4 · Tus reglas: otra jornada se liga por id; la misma jornada no cambia nada salvo para seguir su hora nueva", () => {
  const save = indexSrc.slice(indexSrc.indexOf('const saveForm = document.getElementById("qz-rb-save");'), indexSrc.indexOf('body.querySelectorAll("[data-rb-del]")'));
  assert.ok(save.includes('if(betCloseFixed(editingBet) || (f.closes === "keep" && info)) closes = editingBet.closesAtRound;'));
  assert.ok(save.includes("if(info && info.kind === \"own\" && target && info.round && target.id === info.round.id){"));
  assert.ok(save.includes("if(!sameInstantMs(target.deadline, info.at)) moveTo = new Date(target.deadline).toISOString();"));
  assert.ok(save.includes("if(relinkTo != null) editingBet.closesRoundId = relinkTo;") && save.includes("if(moveTo != null) editingBet.closesAt = moveTo;"));
  assert.ok(save.includes('result.error === "bet_close_locked" || result.error === "bet_close_invalid"'));
});

test("D4 · un rechazo por reabrir o por reusar un id: la pestaña trae lo del servidor y lo dice", () => {
  const save = fn("async function setMetaWithError(meta, opts)");
  assert.ok(save.includes('if(!result.ok && (result.error === "bet_close_locked" || result.error === "bet_retired")) return await adoptAfterStaleBet(meta, result, ERROR_MESSAGES[result.error]);'));
  for (const k of ["bet_close_locked", "bet_close_invalid", "bet_retired"]) assert.ok(new RegExp(`\\n    ${k}: "`).test(indexSrc), k);
});

test("D4 · el diálogo de elección no trae nada marcado y no se confirma sin elegir", () => {
  const choose = fn("function qzChoose(message, opts)");
  assert.ok(choose.includes('id="qz-modal-confirm-btn" disabled>'));
  assert.ok(!/checked/.test(choose.slice(choose.indexOf("options.map"), choose.indexOf("</fieldset>"))));
  assert.ok(choose.includes("confirmBtn.disabled = !chosen();"));
  assert.ok(choose.includes("const onKey = (e) => { if(e.key === \"Escape\") cleanup(null); };"));
});

test("D4 · cerrar el torneo dice qué pasa con las preguntas y avisa de las que no tienen aciertos marcados", () => {
  const note = fn("function closeTournamentBetsNote()");
  const run = new Function("meta", "betAnswerCount", "betHitCount", `const quotedLabels = (bets) => bets.map(b => "«" + b.label + "»").join(", ");\n${note}\nreturn closeTournamentBetsNote();`);
  const meta = { customBets: [own(), { id: "cb_j", label: "Penal", scope: "jornada", points: 1 }] };
  const msg = run(meta, () => 3, () => 0);
  assert.ok(msg.includes("Tus 2 preguntas extra se cierran y se guardan en el historial con sus respuestas y aciertos. En el torneo nuevo ya no cuentan"));
  assert.ok(msg.includes("Ojo: esta pregunta tiene respuestas y ningún acierto marcado: «Campeón». Si alguien acertó, márcalo antes de cerrar"));
  assert.equal(run({ customBets: [] }, () => 0, () => 0), "");
  assert.ok(fn("async function runCloseTournament()").includes("await qzConfirm(confirmMsg + closeTournamentBetsNote(),"));
});

test("D4 · el historial muestra las preguntas archivadas: cierre, respuestas, aciertos y la respuesta propia", () => {
  const e = make({ rounds: [], customBets: [] }, { id: "p_b" });
  const html = e.archivedBetsHtml({
    customBets: [own({ closesAt: at(-5), closeSource: "tournament_end" }), { id: "cb_j", label: "Penal", scope: "jornada", points: 1 }, own({ id: "cb_l", label: "<b>Vieja</b>", closeFlag: "closed_by_round", closeSource: "tournament_end" })],
    betAnswers: { p_b: { cb_x: { guess: "León", correct: true } }, p_c: { cb_x: { correct: false } } },
    rounds: [{ customBetResults: { cb_j: { p_b: true, p_c: true } } }],
  });
  assert.ok(html.includes("Preguntas extra (3)"));
  assert.ok(html.includes(`una vez por torneo · cerró el ${e.fmtWhenTz(at(-5))} · 2 respuestas · 1 acierto · tu respuesta: «León» ✅`));
  assert.ok(html.includes("cada jornada · 2 aciertos"));
  assert.ok(html.includes("cerró con su jornada, antes del fin del torneo"));
  assert.ok(html.includes("&lt;b&gt;Vieja&lt;/b&gt;") && !html.includes("<b>Vieja</b>"), "escapado");
  assert.equal(e.archivedBetsHtml({ customBets: [] }), "");
});
