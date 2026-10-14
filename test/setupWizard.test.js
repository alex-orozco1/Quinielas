// setupWizard.test.js — MS2: el primer recorrido del admin en tres bloques
// (Tu liga y forma de jugar → Cuota y pagos → Tu primera jornada → Revisa y
// publica), la invitación y lo que hereda de las pantallas de setup que
// reemplaza (renderAdminSetupReview / renderAdminSetupManual / Invite).
//
// Las funciones puras se ejecutan; lo demás se comprueba en el código, como
// las pruebas de esas pantallas. El recorrido completo, en el navegador, está
// en la evidencia E2E de la entrega.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  // The signature carries its whole parameter list: the body is the next brace.
  let depth = 0, i = source.indexOf("{", start + signature.length);
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}
const fn = (sig) => extractFunctionBody(indexSrc, sig);
const constLine = (name) => {
  const m = indexSrc.match(new RegExp(`const ${name} = [^\\n]*\\n(?:[^\\n]*\\n)*?[^\\n]*;\\n`));
  assert.ok(m, name);
  return m[0];
};

// ---- lo puro, ejecutado ------------------------------------------------------

const NOW = Date.parse("2026-10-14T18:00:00Z");
const pure = new Function("serverNowMs", `
  const serverNow = () => serverNowMs;
  const SPORTSDB_LEAGUES = [{ id: "4350", label: "Liga MX" }];
  const ROUND_DRAFT_MAX_CHARS = 100000;
  ${constLine("EXTRA_TEMPLATES")}
  const EXTRA_CUSTOM_KEY = "custom";
  const EXTRA_TEXT_MAX = 200;
  const SETUP_STEPS = ["liga", "pagos", "jornada", "resumen"];
  ${fn("function extraTemplate(key)")}
  ${fn("function pointsWord(n)")}
  ${fn("function isPositiveInt(v)")}
  ${fn("function parsePositiveInt(raw)")}
  ${fn("function parseFee(raw)")}
  ${fn("function fmtWhenTz(iso)")}
  ${fn("function pointsExample(n)")}
  ${fn("function penaltyExample(n, from)")}
  ${fn("function emptyExtraBuilder()")}
  ${fn("function defaultSetupDraft(m)")}
  ${fn("function parseSetupDraft(raw, base)")}
  ${fn("function isRoundUsableForSetup(round, nowMs)")}
  ${fn("function startedMatchesOf(round, nowMs)")}
  ${fn("function pickPlayableRound(rounds, nowMs)")}
  ${fn("function firstKickoffMs(matches)")}
  ${fn("function setupDeadlineProblem(deadlineInputValue, matches, nowMs)")}
  ${fn("function extraQuestionProblem(state, questions, ignoreKey)")}
  ${fn("function penaltyStartProblem(from, publishNumber)")}
  return { parsePositiveInt, parseFee, pointsExample, penaltyExample, defaultSetupDraft, parseSetupDraft,
    pickPlayableRound, setupDeadlineProblem, extraQuestionProblem, penaltyStartProblem, emptyExtraBuilder };
`)(NOW);

const iso = (offsetHours) => new Date(NOW + offsetHours * 3600e3).toISOString();
const round = (number, deadlineH, kickoffsH, published = false) => ({
  id: "r_" + number, number, published, deadline: iso(deadlineH),
  matches: kickoffsH.map((k, i) => ({ id: `m_${number}_${i}`, teamA: "A", teamB: "B", kickoffAt: k == null ? null : iso(k) })),
});

test("bloque 1 · el ejemplo de puntos es el de la especificación", () => {
  assert.equal(pure.pointsExample(2), "Ejemplo: 3 aciertos × 2 puntos = 6 puntos");
  assert.equal(pure.pointsExample(1), "Ejemplo: 3 aciertos × 1 punto = 3 puntos");
});

test("bloque 1 · los puntos son enteros de 1 en adelante, sin un máximo inventado", () => {
  for (const ok of ["1", " 3 ", "250", "1000"]) assert.ok(pure.parsePositiveInt(ok) >= 1, ok);
  for (const bad of ["", "0", "-1", "1.5", "2e3", "abc", null, undefined]) assert.equal(pure.parsePositiveInt(bad), null, String(bad));
});

test("bloque 1 · una pregunta incompleta, repetida o sin puntos no se añade en silencio", () => {
  const P = pure.extraQuestionProblem;
  assert.equal(P({ template: "", text: "", points: "" }, [], null), "Selecciona una pregunta.");
  assert.equal(P({ template: "custom", text: "  ", points: "3" }, [], null), "Escribe tu pregunta.");
  assert.match(P({ template: "campeon", text: "", points: "0" }, [], null), /^Escribe cuántos puntos vale/);
  const ya = [{ key: "qa1", text: "¿Qué equipo será campeón del torneo?" }];
  assert.equal(P({ template: "campeon", text: "", points: "5" }, ya, null), "Ya añadiste esta pregunta. Edítala en su tarjeta.");
  assert.equal(P({ template: "custom", text: "¿QUÉ EQUIPO SERÁ CAMPEÓN DEL TORNEO?", points: "5" }, ya, null), "Ya añadiste esta pregunta. Edítala en su tarjeta.");
  assert.equal(P({ template: "campeon", text: "", points: "5" }, ya, "qa1"), "", "editarla a ella misma no es duplicarla");
  assert.equal(P({ template: "anota", text: "", points: "3" }, ya, null), "");
});

test("bloque 1 · las tres preguntas predeterminadas, su tipo y sus puntos (D7)", () => {
  const src = constLine("EXTRA_TEMPLATES");
  assert.ok(src.includes('{ key: "campeon", text: "¿Qué equipo será campeón del torneo?", scope: "temporada", points: 5 }'));
  assert.ok(src.includes('{ key: "anota", text: "¿Qué jugador anotará al menos un gol en esta jornada?", scope: "jornada", points: 3 }'));
  assert.ok(src.includes('{ key: "sin_goles", text: "¿Qué equipo terminará esta jornada sin recibir goles?", scope: "jornada", points: 3 }'));
  const form = fn("function extraFormHtml(mode, state)");
  assert.ok(form.includes("Selecciona una pregunta") && form.includes("Otra pregunta (personalizada)") && form.includes("Escribe tu pregunta"));
  assert.ok(form.includes("Texto fijo: no necesitas escribir nada."), "las predeterminadas muestran su texto sin campo editable");
});

test("bloque 2 · la cuota es en pesos y mayor que 0; el ejemplo de la penalización usa los números elegidos", () => {
  assert.equal(pure.parseFee("100"), 100);
  assert.equal(pure.parseFee("150,50"), 150.5);
  for (const bad of ["", "0", "-5", "1.234", "cien"]) assert.equal(pure.parseFee(bad), null, bad);
  assert.equal(pure.penaltyExample(2, 12), "Ejemplo: con 2 puntos por jornada desde la Jornada 12, quien no haya pagado cuando cierren las jornadas 12, 13 y 14 tendrá −6 puntos.");
});

test("bloque 2 · la penalización no puede empezar antes de la jornada que se publica", () => {
  assert.match(pure.penaltyStartProblem(5, 12), /debe empezar en la Jornada 12 o después/);
  assert.equal(pure.penaltyStartProblem(12, 12), "");
  assert.equal(pure.penaltyStartProblem(null, 12), "", "sin número: la que se publica");
  assert.equal(pure.penaltyStartProblem(3, null), "", "si todavía no se sabe cuál, se revisa en el resumen");
});

test("bloque 3 · sugiere la próxima jornada jugable completa, aunque sea la 12, y dice por qué no la anterior", () => {
  const rounds = [round(10, -100, [-101]), round(11, -1, [-1, 20]), round(12, 72, [72, 74]), round(13, 240, [240])];
  // La 11 ya empezó (un partido hace 1 h, otro dentro de 20 h): se salta y se dice.
  const { round: r, skipped } = pure.pickPlayableRound(rounds, NOW);
  assert.equal(r.number, 12);
  assert.deepEqual(skipped, { number: 11, started: 1 });
});

test("bloque 3 · una jornada con el cierre en el futuro pero un partido ya iniciado no se sugiere", () => {
  const rounds = [round(12, 48, [-2, 50]), round(13, 200, [200])];
  assert.equal(pure.pickPlayableRound(rounds, NOW).round.number, 13);
});

test("bloque 3 · sin jornadas futuras no sugiere ninguna (y nunca reutiliza una vencida)", () => {
  const rounds = [round(1, -300, [-300]), round(2, -100, [-100])];
  assert.deepEqual(pure.pickPlayableRound(rounds, NOW), { round: null, skipped: null });
  assert.deepEqual(pure.pickPlayableRound([], NOW), { round: null, skipped: null });
  // Las ya publicadas (o las antiguas sin `published`) no son «preparadas».
  assert.equal(pure.pickPlayableRound([round(12, 72, [72], true), { ...round(13, 100, [100]), published: undefined }], NOW).round, null);
});

test("bloque 3 · el cierre es futuro y a más tardar a la hora del primer partido", () => {
  const P = pure.setupDeadlineProblem;
  const local = (h) => { const d = new Date(NOW + h * 3600e3); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const matches = [{ kickoffAt: iso(72) }, { kickoffAt: iso(74) }, { kickoffAt: null }];
  assert.equal(P("", matches, NOW), "Elige la fecha y hora de cierre.");
  assert.equal(P(local(-1), matches, NOW), "Elige una fecha y hora a partir de ahora.");
  assert.match(P(local(73), matches, NOW), /^El cierre tiene que ser a más tardar a la hora del primer partido/);
  assert.equal(P(local(72), matches, NOW), "", "el calendario propone justo la hora del primer partido");
  assert.equal(P(local(10), matches, NOW), "");
  assert.equal(P(local(500), [{ teamA: "A", teamB: "B" }], NOW), "", "a mano no hay horarios contra qué revisar");
});

test("borrador · se restaura exactamente, y uno ajeno, viejo o manipulado no se usa", () => {
  const d = pure.defaultSetupDraft({ settings: {}, paymentPenalty: undefined });
  d.questions = [{ key: "qab12", template: "campeon", text: "¿Qué equipo será campeón del torneo?", scope: "temporada", points: 5 }];
  d.extrasOn = true;
  d.builder = { open: true, template: "custom", text: "¿Quién será el goleador?", scope: "temporada", points: "3" };
  const raw = JSON.stringify({ v: 1, base: "epoch:0", ...d });
  assert.deepEqual(pure.parseSetupDraft(raw, "epoch:0"), d);
  assert.equal(pure.parseSetupDraft(raw, "epoch:1"), null, "de otro torneo");
  assert.equal(pure.parseSetupDraft(JSON.stringify({ ...JSON.parse(raw), v: 2 }), "epoch:0"), null);
  const bad = JSON.parse(raw); bad.questions[0].key = 'q"><img src=x>';
  assert.equal(pure.parseSetupDraft(JSON.stringify(bad), "epoch:0"), null, "las llaves van a atributos: sólo su forma exacta");
  const twice = JSON.parse(raw); twice.questions.push({ ...twice.questions[0] });
  assert.equal(pure.parseSetupDraft(JSON.stringify(twice), "epoch:0"), null);
  assert.equal(pure.parseSetupDraft("{no es json", "epoch:0"), null);
  // Sin máximo de preguntas: 300 caben mientras quepa el borrador.
  const many = JSON.parse(raw);
  many.questions = Array.from({ length: 300 }, (_, i) => ({ key: "q" + i.toString(36) + "x", template: "custom", text: "P" + i, scope: "jornada", points: 1 }));
  assert.equal(pure.parseSetupDraft(JSON.stringify(many), "epoch:0").questions.length, 300);
});

test("borrador · arranca con lo que la quiniela ya tiene (puntos, cuota, penalización)", () => {
  const d = pure.defaultSetupDraft({ settings: { pointsPerCorrectPick: 2, entryFee: 100 }, paymentPenalty: { enabled: true, pointsPerRound: 1, startsAtRound: 12 } });
  assert.equal(d.points, 2);
  assert.equal(d.payOn, true);
  assert.equal(d.fee, 100);
  assert.equal(d.penOn, true);
  assert.equal(d.penFrom, 12);
  const blank = pure.defaultSetupDraft({ settings: { entryFee: 0 } });
  assert.equal(blank.payOn, false, "cuota 0 y sin penalización: sin registro de pagos");
  assert.equal(blank.extrasOn, false);
});

// ---- el recorrido, en el código ---------------------------------------------

test("destino · el setup se abre por el estado REAL de la quiniela; el borrador sólo guarda lo escrito", () => {
  const resolve = fn("async function renderAdminSetupResolve()");
  assert.ok(resolve.indexOf("const freshWithAuth = await getMeta({ owner: adminOrOwnerCred() });") < resolve.indexOf("const dest = resolveSetupDestination(meta, currentUser);"),
    "con la credencial de admin, antes de decidir (las jornadas preparadas sólo las ve el admin)");
  assert.ok(/if\(dest === "review" \|\| dest === "manual"\)\{\s*startSetupFlow\(\);/.test(resolve));
  const render = fn("async function render()");
  assert.ok(render.includes('if(dest === "review" || dest === "manual"){ startSetupFlow(); return; }'));
  assert.ok(render.includes('if(dest === "invite"){ activeTab = "jornada"; renderApp(); openInviteSheet({ first: true }); return; }'),
    "la invitación vuelve tras recargar hasta que se cierra");
  const save = fn("function saveSetupDraft(d)");
  assert.ok(save.includes("window.sessionStorage.setItem(roundDraftKey(SETUP_DRAFT_KIND), raw);"), "por pestaña, quiniela y persona, como los de #35");
  assert.ok(!/localStorage/.test(save + fn("function loadSetupDraft(m)")));
});

test("PIN · el titular de la pantalla del PIN no se repite en el recorrido", () => {
  for (const sig of ["function renderSetupFlow()", "function renderSetupLiga(main)", "function renderSetupPagos(main)", "function renderSetupJornada(main)", "function renderSetupResumen(main)", "function openInviteSheet(opts)"]) {
    assert.ok(!fn(sig).includes("Tu quiniela ya está creada"), sig);
  }
});

test("calendario · se espera la sincronización antes de elegir la jornada, con el esqueleto antes de pedirla", () => {
  const body = fn("async function resolveSetupCalendar(force, isCurrent)");
  const loading = body.indexOf('flow.cal = { state: "loading", since: Date.now() };');
  const fetchAt = body.indexOf("await fetch(`/api/quinielas/");
  const pick = body.indexOf("pickPlayableRound(meta.rounds, serverNow())");
  assert.ok(loading !== -1 && loading < fetchAt && fetchAt < pick);
  assert.ok(body.indexOf("adoptSetupMeta(fresh, current);") < pick, "elige sobre lo que el servidor tiene después de importar");
  // Falla, vacío o sin jornadas futuras: un estado que la pantalla explica.
  assert.ok(body.includes('state: "fail"') && body.includes('"none" : "empty"'));
  const ui = fn("function renderSetupJornada(main)");
  for (const s of ["No pudimos traer el calendario", "Todavía no hay calendario para", "Ya no hay jornadas por jugar en", "Lo que elegiste en los pasos 1 y 2 se conserva.", "Reintentar", "Preparar partidos manualmente"]) assert.ok(ui.includes(s), s);
  assert.ok(ui.includes("${retryBtn}${cal.commercial ? `` : manualBtn(true)}"), "un 402 comercial no sugiere armarla a mano (como Admin → Jornadas)");
});

test("bloque 3 · las filas avisan de cada cambio (escribir, añadir, quitar y el cierre) y se guardan en el borrador de #35", () => {
  const form = fn("function renderSetupRoundForm(main)");
  assert.ok(/m\[inp\.dataset\.role\] = inp\.value; changed\(\);/.test(form), "escribir un equipo");
  assert.ok(/rowsEl\.insertAdjacentHTML\("beforeend", wzMatchRowHtml\(m, false\)\);\s*wireRow\(m\);\s*changed\(\);/.test(form), "añadir un partido");
  assert.ok(/row\.remove\(\);\s*changed\(\);/.test(form), "quitar un partido");
  assert.ok(form.includes('deadlineEl.addEventListener("input", onDeadline);') && form.includes('deadlineEl.addEventListener("change", onDeadline);'), "hay selectores móviles que sólo avisan con change");
  assert.ok(form.includes("const changed = () => { saveSetupRows(); refresh(); renderSetupAside(); };"));
  assert.ok(fn("function saveSetupRows()").includes("saveRoundDraft(rows.kind, { matches: rows.matches, deadline: rows.deadline }, rows.base);"));
  assert.ok(form.includes('min="${esc(minDeadline)}"') && form.includes("const minDeadline = toLocalInputValue(new Date(serverNow()).toISOString());"),
    "`min` es sólo una pista: la regla real se revisa al continuar y al publicar");
});

test("#35 · revisar la jornada importada restaura sobre la copia completa, con su huella; la manual restaura el borrador «new»", () => {
  const rows = fn("function setupRows()");
  assert.ok(rows.includes('const kind = "edit:" + round.id;'));
  assert.ok(rows.includes("const base = roundDraftBase(round);"));
  assert.ok(rows.includes("const saved = loadRoundDraft(kind, base);"));
  assert.ok(rows.indexOf("const matches = round.matches.map(m => ({ ...m }));") < rows.indexOf("mergeRoundDraftMatches(matches, saved.matches)"),
    "sobre la copia completa ({...m}), para no perder los datos del proveedor (horarios, ids)");
  assert.ok(rows.includes("const saved = loadNewRoundDraft(meta);"), "del torneo en curso, salvo que ya esté publicado");
  assert.ok(rows.includes("matches: saved ? saved.matches : [blankMatch(), blankMatch()],"));
  assert.ok(rows.includes('kind: "new", base: newRoundDraftBase(meta), round: null,'));
});

test("#35 · lo restaurado se pinta escapado en las filas del setup", () => {
  const escSrc = fn("function esc(s)");
  const rowSrc = fn("function wzMatchRowHtml(m, imported)");
  const row = new Function(`${escSrc}\nconst fmtKickoff = () => "";\n${rowSrc}\nreturn wzMatchRowHtml;`)();
  const html = row({ id: 'm_1"><img src=x onerror=alert(1)>', teamA: '"><img src=x onerror=alert(2)>', teamB: "</script><svg onload=alert(3)>" }, true);
  assert.ok(!/<img|<svg|<\/script/i.test(html), html);
  assert.ok(html.includes("&quot;&gt;&lt;img") && html.includes("&lt;/script&gt;"));
});

test("publicar · la regla del cierre se revisa al momento del clic, con el reloj del servidor, sin borrar lo escrito", () => {
  const problem = fn("function setupRoundProblem()");
  assert.ok(problem.includes("const problem = setupDeadlineProblem(rows.deadline, clean, serverNow());"));
  assert.ok(!/rows\.matches\s*=|rows\.deadline\s*=\s*""|\.published/.test(problem.replace("if(dl) rows.deadline = dl.value;", "")), "nada se limpia junto al error");
  const click = fn("async function setupPublishClickNow(btn)");
  assert.ok(click.indexOf("const problem = setupRoundProblem();") < click.indexOf("await setupPublish(btn, problem, number, rules);"));
});

test("publicar · una sola escritura: lo cambiado se repone si falla, y el reintento usa la jornada que vive en meta.rounds", () => {
  const pub = fn("async function setupPublish(btn, problem, number, rules)");
  const snap = pub.indexOf("const snapshot = JSON.parse(JSON.stringify(meta));");
  const reconcile = pub.indexOf("reconcilePenaltyLedger(meta);");
  const relocate = pub.indexOf("round = meta.rounds.find(r => r.id === rows.round.id);");
  const deadline = pub.indexOf("round.deadline = new Date(problem.deadline).toISOString();");
  const write = pub.indexOf("const result = await setMetaWithError(meta, { betsEdited: true });");
  assert.ok(snap !== -1 && snap < reconcile && reconcile < deadline && deadline < write, "copia antes de tocar nada; la penalización se asienta antes de mover el cierre");
  assert.ok(relocate !== -1 && relocate < deadline, "busca la jornada por id en cada intento, nunca una referencia vieja");
  assert.equal((pub.match(/setMetaWithError\(/g) || []).length, 1, "jornada y reglas en la misma escritura");
  assert.ok(pub.includes("round.matches = problem.clean;"), "las filas son copias completas de los partidos ({...m}), no se rearman");
  // El manual sólo agrega una jornada nueva con el número siguiente; nunca toca las existentes.
  assert.ok(pub.includes("round = { id: uid(\"r\"), number, matches: problem.clean, deadline: new Date(problem.deadline).toISOString(), results: {}, resultsPublished: false, published: true };"));
  assert.ok(pub.includes("meta.rounds.push(round);"));
  assert.ok(fn("function nextRoundNumber()").includes("Math.max(...meta.rounds.map(r => r.number)) + 1"), "nunca un 1 fijo");
  // Fallo: se repone todo y se queda en el resumen, con Reintentar.
  const fail = pub.slice(pub.indexOf("if(!result.reconciled) adoptFreshMeta(meta, snapshot);"));
  assert.ok(fail.length > 0);
  assert.ok(fail.includes("showPlanBlock(result);"), "Plus sólo ante un límite real del servidor");
  assert.ok(fail.includes("No se publicó nada; tu configuración sigue aquí."));
  assert.ok(fail.includes("No pudimos confirmar si se publicó."));
  assert.ok(!/renderApp\(|startSetupFlow\(|openInviteSheet\(/.test(fail), "un fallo no cambia de pantalla ni invita");
  // #35: nunca una segunda copia de una jornada manual ya publicada.
  assert.ok(pub.indexOf("isRoundDraftPublished({ matches: problem.clean }, meta.rounds)") < pub.indexOf("meta.rounds.push(round);"));
});

test("publicar · el éxito y la invitación sólo después de que el servidor confirme; el borrador se borra entonces", () => {
  const pub = fn("async function setupPublish(btn, problem, number, rules)");
  const ok = pub.slice(pub.indexOf("if(result.ok){"), pub.indexOf("if(!result.reconciled)"));
  assert.ok(ok.includes("clearRoundDraft(rows.kind);") && ok.includes("finishSetupPublish(round, result);"));
  const finish = fn("function finishSetupPublish(round, result, note)");
  assert.ok(finish.includes("clearRoundDraft(SETUP_DRAFT_KIND);"));
  assert.ok(finish.indexOf("setupContinuityResolved = true;") < finish.indexOf("renderApp();"), "sin esto, la continuidad volvería a abrir la invitación a pantalla completa");
  assert.ok(finish.indexOf("renderApp();") < finish.indexOf("openInviteSheet({ first: true, round, note: note || kept });"));
  assert.ok(finish.includes("result.ruleFieldsKept"), "si el servidor conservó puntos o cuota, se dice");
  // Founder (ronda 3): lo que se dice de lo publicado queda en la hoja, no en un toast sobre sus botones.
  assert.ok(!finish.includes("toast("));
  assert.ok(fn("function openInviteSheet(opts)").includes('${opts && opts.note ? `<p class="qz-sheet-note" role="status">${esc(opts.note)}</p>` : ``}'));
});

test("publicar · las reglas que escribe: preguntas de torneo ligadas a la jornada publicada, pagos apagados sin cuota ni penalización oculta", () => {
  const rules = fn("function setupTargetRules(number)");
  assert.ok(rules.includes("const fee = d.payOn ? d.fee : 0;"));
  assert.ok(rules.includes("penalty: d.payOn && d.penOn"));
  assert.ok(rules.includes('closesAtRound: q.scope === "temporada" ? number : null,'), "reutiliza closesAtRound: la de torneo cierra con la jornada que se publica");
  assert.ok(rules.includes('id: "cb_" + q.key'), "id estable: un reintento no la agrega dos veces");
  const pub = fn("async function setupPublish(btn, problem, number, rules)");
  assert.ok(pub.includes("else if(meta.paymentPenalty && meta.paymentPenalty.enabled) meta.paymentPenalty = { ...meta.paymentPenalty, enabled: false };"));
  assert.ok(pub.includes("rules.bets.forEach(b => { if(!meta.customBets.some(x => x.id === b.id)) meta.customBets.push(b); });"));
});

test("contraseña · sin ella no se publica; guardarla vuelve al resumen sin publicar; con ella pero la pestaña bloqueada, se pide antes", () => {
  const click = fn("async function setupPublishClickNow(btn)");
  assert.ok(click.includes('const passed = await gateFirstPublish(null, "before");'));
  assert.ok(click.includes("✅ Contraseña guardada. Tu jornada todavía no está publicada"));
  assert.ok(click.includes("Sin contraseña no se puede publicar. Tu configuración sigue aquí."));
  const gateBlock = click.slice(click.indexOf("if(needsAdminPasswordToPublish()){"), click.indexOf("const number = setupPublishNumber();"));
  assert.ok(!gateBlock.includes("setupPublish("), "guardar la contraseña nunca publica");
  assert.ok(click.indexOf("if(meta.creatorId && !ownerPasswordCache && setupChangesProtectedRules(rules)){") < click.indexOf("await setupPublish("),
    "los puntos y la cuota sólo se guardan con la contraseña: se pide antes, nunca se publica a medias");
  assert.ok(click.includes("verifyOwnerPasswordResult(pw)"));
  const resumen = fn("function renderSetupResumen(main)");
  assert.ok(resumen.includes('const label = needsPassword ? "Crear contraseña de administrador" : `Publicar jornada ${number}`;'));
});

test("invitación · popup con WhatsApp, copiar, añadir, ver y cerrar; copiar o añadir no se presentan como que alguien entró", () => {
  const sheet = fn("function openInviteSheet(opts)");
  for (const s of ["🎉 ¡Tu quiniela y la Jornada ${esc(round.number)} ya están listas!", "🔗 Invitar por WhatsApp", "Copiar link", "Añadir participantes", "Ver mi jornada", "Cerrar",
    "Copiar o compartir el link no significa que alguien ya entró.", "Se abrió WhatsApp con el mensaje listo. Tú decides si lo envías.", 'aria-label="Cerrar"']) {
    assert.ok(sheet.includes(s), s);
  }
  assert.ok(sheet.includes('window.open("https://wa.me/?text=" + encodeURIComponent(inviteWhatsAppText(round)), "_blank", "noopener")'));
  assert.ok(sheet.includes("No se pudo copiar. Mantén presionado el link para copiarlo:"), "un fallo al copiar no se presenta como copiado");
  const close = sheet.slice(sheet.indexOf("const close = async (thenView) => {"), sheet.indexOf("const onKey"));
  assert.ok(close.includes("if(first) await markLeftInviteScreen();"), "cerrarlo por cualquier vía lo registra; antes de eso, recargar lo vuelve a mostrar");
  assert.ok(close.indexOf("await markLeftInviteScreen();") < close.indexOf("renderApp();"));
  assert.ok(fn("async function addParticipantsByName()").includes("Todavía no han entrado: les toca abrir el link y crear su PIN."));
  assert.ok(!sheet.includes("Jornada 1 publicada"), "el número es el real");
});

test("después · «Siguiente paso» por estado real, «Invitar» siempre a mano y una confirmación breve en publicaciones posteriores", () => {
  const next = fn("async function nextStepInfo()");
  for (const s of ["Publica tu primera jornada", "Invita a tus amigos", "ya cerró`", "Faltan pronósticos", "Resultados publicados"]) assert.ok(next.includes(s), s);
  assert.ok(next.indexOf("Invita a tus amigos") < next.indexOf("ya cerró`") && next.indexOf("ya cerró`") < next.indexOf("Faltan pronósticos"), "prioridad 1 → 5");
  assert.ok(indexSrc.includes('toast(`✅ La Jornada ${round.number} está abierta. Cierra el ${fmtWhenTz(round.deadline)}.`, 5000);'));
  assert.ok(indexSrc.includes('if(openInvite) openInvite.addEventListener("click", () => openInviteSheet({ first: false }));'));
});

test("textos · la especificación usa «pronósticos»; el cierre de las preguntas dice fecha, hora y zona, no «antes de que inicie»", () => {
  assert.ok(!indexSrc.includes("antes de que inicie la Jornada"), "el cierre es el de la jornada, no su inicio");
  assert.ok(!indexSrc.includes("Se cierra antes de que inicie la jornada"));
  assert.ok(fn("function fmtWhenTz(iso)").includes('timeZoneName: "short"'));
  assert.ok(fn("function renderSetupRoundForm(main)").includes("Hasta esta hora tus amigos pueden elegir y cambiar sus pronósticos."));
  assert.ok(indexSrc.includes("Tus pronósticos de partidos se guardan solos apenas los eliges."), "y no promete guardar solas las respuestas escritas");
  assert.ok(indexSrc.includes("Lo que escribes aquí no se guarda solo: toca «Guardar respuestas»."));
});

test("publicar · una respuesta perdida: antes de decir algo se pregunta al servidor, y lo ya publicado no se publica dos veces", () => {
  const pub = fn("async function setupPublish(btn, problem, number, rules)");
  const fail = pub.slice(pub.indexOf("if(!result.reconciled) adoptFreshMeta(meta, snapshot);"));
  const recheck = fail.indexOf('if(result.error === "network_error" && !result.reconciled){');
  const already = fail.indexOf("const done = setupAlreadyPublished(rows, problem.clean);");
  const conflictMsg = fail.indexOf("No se publicó nada.");
  assert.ok(recheck !== -1 && recheck < already && already < conflictMsg, "primero el servidor, después el aviso");
  assert.ok(fail.slice(recheck, already).includes("adoptFreshMeta(meta, fresh);"));
  assert.ok(fail.slice(already, conflictMsg).includes("finishSetupPublish(done, null, setupRulesStored(rules) ? null"));
  const found = fn("function setupAlreadyPublished(rows, clean)");
  assert.ok(found.includes("const r = meta.rounds.find(x => x.id === rows.round.id);"), "calendario: la misma jornada");
  assert.ok(found.includes("return meta.rounds.find(published) || null;"), "a mano: los mismos ids de partido");
  assert.ok(fn("function setupRulesStored(rules)").includes("rules.bets.every(b => bets.some(x => x.id === b.id))"));
});

test("pestaña atrasada · una pregunta del torneo que esta pestaña no editó no bloquea cada guardado: se trae el estado bueno", () => {
  const save = fn("async function setMetaWithError(meta, opts)");
  assert.ok(save.includes("if(isStaleBetRefusal(result, opts)) return await adoptAfterStaleBet(meta, result);"));
  assert.ok(fn("function isStaleBetRefusal(result, opts)").includes('(result.error === "bet_close_required" || result.error === "bet_close_past") && !(opts && opts.betsEdited)'));
  const adopt = fn("async function adoptAfterStaleBet(meta, result)");
  assert.ok(adopt.indexOf("adoptFreshMeta(meta, fresh);") < adopt.indexOf("return { ...result, reconciled: adopted };"));
  // Quien sí crea o edita preguntas recibe el error para corregirlo.
  assert.ok(fn("async function setupPublish(btn, problem, number, rules)").includes("await setMetaWithError(meta, { betsEdited: true });"));
  assert.ok(indexSrc.includes("const result = await setMetaWithError(meta, { betsEdited: true });\n      saveForm.disabled = false;"));
});

// ---- Product QA (ronda 1): P1-1, P2-1, P2-2, P2-3 ---------------------------

// «Tus reglas» → Editar, ejecutado con una meta de prueba.
const reglasForm = (metaObj) => new Function("serverNowMs", "meta", `
  const serverNow = () => serverNowMs;
  const allPicksCache = {};
  ${constLine("EXTRA_TEMPLATES")}
  const EXTRA_CUSTOM_KEY = "custom";
  const EXTRA_TEXT_MAX = 200;
  ${fn("function esc(s)")}
  ${fn("function extraTemplate(key)")}
  ${fn("function scopeLabel(scope)")}
  ${fn("function scopeHelp(scope)")}
  ${fn("function fmtWhenTz(iso)")}
  ${fn("function isRoundLocked(round)")}
  ${fn("function customBetsLocked(bet)")}
  ${fn("function betAnswerCount(bet)")}
  ${fn("function closableRounds()")}
  ${fn("function betCloseLine(bet)")}
  ${fn("function betCloseFixed(bet)")}
  ${fn("function reglasBetFormHtml(f)")}
  return reglasBetFormHtml;
`)(NOW, metaObj);
const editForm = (bet) => ({ id: bet.id, template: "custom", text: bet.label, scope: bet.scope, points: String(bet.points), closes: bet.closesAtRound ? String(bet.closesAtRound) : "" });

test("P1-1 · editar una pregunta del torneo que ya cerró no ofrece otro cierre: no se reabre por accidente", () => {
  const bet = { id: "cb_x", label: "¿Quién gana?", scope: "temporada", points: 5, closesAtRound: 12 };
  const meta = { rounds: [round(12, -2, [-1], true), round(13, 48, [50]), round(14, 120, [122])], customBets: [bet], participants: [] };
  const html = reglasForm(meta)(editForm(bet));
  assert.ok(!html.includes('id="qz-rb-closes"'), "sin selector: el navegador no puede preseleccionar la Jornada 13");
  assert.ok(html.includes("Cierra con la Jornada 12") && html.includes("Ya cerró."));
  // Al guardar, el cierre que se escribe es el que ya tenía.
  const save = indexSrc.slice(indexSrc.indexOf('const saveForm = document.getElementById("qz-rb-save");'));
  assert.ok(save.includes(": betCloseFixed(editingBet) ? editingBet.closesAtRound"));
  // Y si cerró con el formulario abierto, no se guarda otro cierre.
  assert.ok(save.includes('toast("Esta pregunta acaba de cerrar: su cierre ya no se cambia. No se guardó nada.");'));
});

test("P1-1 · una pregunta abierta conserva su jornada elegida; una ligada a una jornada que ya no existe la conserva marcada", () => {
  const open = { id: "cb_o", label: "Campeón", scope: "temporada", points: 5, closesAtRound: 14 };
  const gone = { id: "cb_g", label: "Goleador", scope: "temporada", points: 3, closesAtRound: 9 };
  const meta = { rounds: [round(13, 48, [50]), round(14, 120, [122])], customBets: [open, gone], participants: [] };
  const form = reglasForm(meta);
  const a = form(editForm(open));
  assert.match(a, /<option value="14" selected>Jornada 14/);
  assert.doesNotMatch(a, /<option value="13" selected>/);
  const b = form(editForm(gone));
  assert.match(b, /<option value="9" selected>Jornada 9 · ya no existe<\/option>/, "guardar sin tocarla no cambia nada");
  assert.doesNotMatch(b, /<option value="13" selected>/);
  // Sin cierre (pregunta antigua): se pide elegir, no se elige solo.
  const legacy = { id: "cb_l", label: "Antigua", scope: "temporada", points: 1, closesAtRound: null };
  const c = reglasForm({ ...meta, customBets: [legacy] })(editForm(legacy));
  assert.match(c, /<option value="" selected disabled>Elige una jornada<\/option>/);
});

test("P2-1 · «Siguiente paso» sin jornada publicada no promete un borrador que no existe en esta pestaña", () => {
  const info = fn("async function nextStepInfo()");
  assert.ok(!indexSrc.includes("sigue guardado en este dispositivo"));
  assert.ok(info.includes("text: loadSetupDraft(meta)"));
  assert.ok(info.includes("Lo que ya configuraste en esta pestaña sigue aquí."));
  assert.ok(info.includes("Elige tus reglas, tus pagos y tu primera jornada. Nada se publica hasta que lo confirmes."));
});

test("P2-2 · sin la contraseña de administrador (co-admin) hay salida: se dice de quién es y se pueden dejar puntos y cuota como están", () => {
  const click = fn("async function setupPublishClickNow(btn)");
  assert.ok(click.includes('altLabel: keepLabel'));
  assert.ok(click.includes('const keepLabel = "Dejar puntos y cuota como están";'));
  assert.ok(click.includes('"Para guardar los puntos y la cuota hace falta la contraseña de administrador" + (creator ? ", que creó " + creator.name : "")'));
  assert.ok(click.includes("if(attempt && attempt.alt){ await setupKeepStoredRules(); return; }"));
  assert.ok(click.includes("Pídesela, o toca otra vez «Publicar jornada"));
  // Dejar como están no publica: cambia el borrador y vuelve al resumen.
  const keep = fn("async function setupKeepStoredRules()");
  assert.ok(!keep.includes("setupPublish("), "no publica por su cuenta");
  assert.ok(keep.includes("d.points = stored.points;"));
  assert.ok(keep.includes("d.payOn = false;") && keep.includes("d.fee = stored.fee;"));
  assert.ok(keep.includes("Todavía no se publicó nada"));
  // Technical QA (ronda 2): «como están» es lo que tiene el SERVIDOR, también
  // la penalización; no la copia de esta pestaña.
  assert.ok(keep.indexOf("await refreshSetupMeta();") < keep.indexOf("const stored = storedRuleValues();"));
  assert.ok(keep.includes("d.penOn = true;") && keep.includes("d.penPoints = penPoints;"));
  // Y la contraseña se decide con lo guardado en el servidor; si en esa
  // consulta cambiaron las jornadas, no se publica (Technical QA, ronda 2).
  assert.ok(click.indexOf("await refreshSetupMeta();") < click.indexOf("setupChangesProtectedRules(rules)"));
  const changedAt = click.indexOf("if(meta.roundsRevision !== revBefore){ setupRoundsChangedElsewhere(flow); return; }");
  assert.ok(changedAt > click.indexOf("await refreshSetupMeta();") && changedAt < click.indexOf("const number = setupPublishNumber();"), "antes de calcular el número que se publica");
  assert.ok(fn("async function setupPublishClick(btn)").includes("setupClickPending = true;"), "un doble toque no abre dos preguntas");
  assert.ok(fn("function setupChangesProtectedRules(rules)").includes("const stored = storedRuleValues();"));
});

test("P2-3 · los textos dicen cuándo se ven los puntos marcados: la Tabla aparece al publicar los primeros resultados", () => {
  const when = fn("function markedPointsWhen()");
  assert.ok(when.includes("return tableShowsScores()"));
  assert.ok(when.includes("la tabla de posiciones aparece cuando publicas los resultados de la primera jornada"));
  assert.ok(fn("async function renderTabla(main)").includes("const hasScoredResults = tableShowsScores();"), "la misma condición que la Tabla");
  assert.ok(!indexSrc.includes("Marca «¿Atinó?» a quien acertó; los puntos se suman a la tabla al momento."));
  assert.ok(indexSrc.includes("Al marcar «¿Atinó?», ${esc(markedPointsWhen())}."));
  assert.ok(fn("function renderReglasGrade(box, bet)").includes("${esc(markedPointsWhen())}"));
  assert.ok(indexSrc.includes("${tableShowsScores() ? `` : `<p class=\"muted qz-tight\">La Tabla de posiciones aparece cuando publicas los resultados de la primera jornada."));
});

// ---- Revisión del Founder: la carga del calendario (P2) ----------------------
// Las funciones reales de la carga, con la red simulada: cada fetch/getMeta
// queda pendiente hasta que la prueba lo resuelve, en el orden que elige.
function calendarHarness(metaObj) {
  const pending = [];
  const later = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
  const env = new Function("meta", "pending", "later", "serverNowMs", `
    let setupFlow = null;
    const SLUG = "q";
    const serverNow = () => serverNowMs;
    const renders = { flow: 0, aside: 0 };
    const renderSetupFlow = () => { renders.flow++; };
    const renderSetupAside = () => { renders.aside++; };
    const refreshExtraCloseTexts = () => {};
    const setAuthHeaders = (h) => h;
    const adminOrOwnerCred = () => "x";
    const humanizeError = (e) => String(e);
    const sportsDataFailureMessage = () => "falla";
    const console = { error(){} };
    const toasts = [];
    const toast = (msg) => toasts.push(msg);
    ${fn("function nextRoundNumber()")}
    ${fn("function setupReviewRound()")}
    ${fn("function setupPublishNumber()")}
    // Cada carga pide dos cosas a la red: la sincronización y la meta.
    const fetch = () => { const d = later(); pending.push({ kind: "sync", d }); return d.p; };
    const getMeta = () => { const d = later(); pending.push({ kind: "meta", d }); return d.p; };
    ${fn("function setupLeagueId()")}
    ${fn("function isRoundUsableForSetup(round, nowMs)")}
    ${fn("function startedMatchesOf(round, nowMs)")}
    ${fn("function pickPlayableRound(rounds, nowMs)")}
    ${fn("function adoptFreshMeta(target, fresh)")}
    ${fn("async function resolveSetupCalendar(force, isCurrent)")}
    ${fn("function adoptSetupMeta(fresh, current)")}
    ${fn("async function loadSetupCalendar(force)")}
    ${fn("function setSetupCal(cal)")}
    return {
      start(d){ setupFlow = { d, cal: null, rows: null, publishing: false, notice: null }; return setupFlow; },
      flow: () => setupFlow, renders, toasts, loadSetupCalendar, setSetupCal,
    };
  `)(metaObj, pending, later, NOW);
  // Resuelve la n-ésima petición pendiente de ese tipo y deja correr las promesas.
  const settle = async (kind, nth, value) => {
    const req = pending.filter((x) => x.kind === kind)[nth];
    assert.ok(req, `${kind} #${nth} existe`);
    req.d.resolve(value);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const okSync = { ok: true, json: async () => ({ ok: true }) };
  return { env, settle, okSync, pending };
}
const imported = (rev, list) => ({ settings: { sportsdbLeagueId: "4350" }, participants: [], roundsRevision: rev, rounds: list });

test("calendario · elegir «a mano» mientras carga: la respuesta tardía no vuelve a la Jornada 12 y el borrador manual se queda", async () => {
  for (const how of ["botón", "nueva carga"]) {
    const meta = imported(0, []);
    const h = calendarHarness(meta);
    const flow = h.env.start({ manual: false, step: "jornada" });
    const slow = h.env.loadSetupCalendar(false);
    assert.equal(flow.cal.state, "loading");
    // El admin elige preparar los partidos a mano (el botón del paso 3), o una
    // carga posterior resuelve «manual» porque d.manual ya es true.
    flow.d.manual = true;
    if (how === "botón") h.env.setSetupCal({ state: "manual" });
    else await h.env.loadSetupCalendar(false);
    assert.equal(flow.cal.state, "manual", how);
    const rows = { kind: "new", matches: [{ id: "m1", teamA: "León", teamB: "Puebla" }], deadline: "2026-10-20T19:00" };
    flow.rows = rows;
    // Termina la carga anterior: trae la Jornada 12 importada.
    await h.settle("sync", 0, h.okSync);
    await h.settle("meta", 0, imported(1, [round(11, -1, [-2]), round(12, 48, [50]), round(13, 120, [122])]));
    await slow;
    assert.equal(flow.cal.state, "manual", `${how}: la decisión más reciente se respeta`);
    assert.equal(flow.d.manual, true);
    assert.equal(flow.rows, rows, `${how}: los partidos y el cierre del borrador manual siguen`);
    assert.deepEqual(flow.rows.matches, [{ id: "m1", teamA: "León", teamB: "Puebla" }]);
    assert.equal(flow.rows.deadline, "2026-10-20T19:00");
    // Las jornadas que el servidor sí importó llegan a la meta (son más nuevas),
    // sin cambiar la decisión; el número de la jornada a mano se mueve después
    // de las del calendario, y el paso se vuelve a pintar con su tarjeta
    // (Founder, ronda 3: una tarjeta en el flujo, no un toast).
    assert.equal(meta.roundsRevision, 1);
    assert.equal(h.env.toasts.length, 0, how);
    assert.ok(h.env.renders.flow >= 1, `${how}: se repinta el paso con la tarjeta del número`);
  }
});

test("calendario · dos cargas que terminan en orden inverso: gana la más reciente y la meta no retrocede", async () => {
  const meta = imported(0, []);
  const h = calendarHarness(meta);
  const flow = h.env.start({ manual: false, step: "resumen" });
  const first = h.env.loadSetupCalendar(true);
  const second = h.env.loadSetupCalendar(true);
  // La segunda termina primero, con la meta más nueva (la Jornada 11 ya empezó).
  await h.settle("sync", 1, h.okSync);
  await h.settle("meta", 0, imported(2, [round(11, -1, [-2]), round(12, 48, [50])]));
  await second;
  assert.deepEqual({ state: flow.cal.state, roundId: flow.cal.roundId }, { state: "review", roundId: "r_12" });
  // La primera termina después, con una copia más vieja (la 11 todavía jugable).
  await h.settle("sync", 0, h.okSync);
  await h.settle("meta", 1, imported(1, [round(11, 24, [26]), round(12, 48, [50])]));
  await first;
  assert.deepEqual({ state: flow.cal.state, roundId: flow.cal.roundId }, { state: "review", roundId: "r_12" }, "la respuesta vieja no decide");
  assert.equal(meta.roundsRevision, 2, "ni pone la meta vieja encima de la nueva");
  assert.equal(meta.rounds.find((r) => r.number === 11).deadline, iso(-1));
  // Y una falla tardía tampoco convierte la jornada elegida en «No pudimos traer el calendario».
  const third = h.env.loadSetupCalendar(true);
  const fourth = h.env.loadSetupCalendar(true);
  await h.settle("sync", 3, h.okSync);
  await h.settle("meta", 2, imported(3, [round(12, 48, [50])]));
  await fourth;
  await h.settle("sync", 2, { ok: false, status: 500, json: async () => ({ ok: false }) });
  await h.settle("meta", 3, null);
  await third;
  assert.deepEqual({ state: flow.cal.state, roundId: flow.cal.roundId }, { state: "review", roundId: "r_12" });
});

test("calendario · toda decisión directa sobre el calendario invalida la carga en curso", () => {
  // Ninguna asignación de flow.cal fuera de la carga misma (que sólo escribe
  // «cargando» si sigue vigente) y de setSetupCal.
  const writes = [...indexSrc.matchAll(/\b(?:setupFlow|flow)\.cal = /g)].map((m) => m.index);
  const allowed = [
    indexSrc.indexOf('flow.cal = { state: "loading", since: Date.now() };'),
    indexSrc.indexOf("flow.cal = cal;\n    if(flow.d.step"),
    indexSrc.indexOf("setupFlow.cal = cal;\n  }"),
  ];
  assert.ok(allowed.every((i) => i !== -1));
  assert.deepEqual(writes.filter((i) => !allowed.includes(i)).map((i) => indexSrc.slice(i, i + 60)), []);
  const resolver = fn("async function resolveSetupCalendar(force, isCurrent)");
  assert.ok(resolver.indexOf("if(!current) return null;") < resolver.indexOf("const failed ="), "la respuesta vieja no decide nada");
  assert.ok(fn("function setSetupCal(cal)").includes("setupFlow.calToken = null;"));
});

test("horarios · cada hora dice qué es: «Inicio del partido», «Cierre de pronósticos para todos los partidos» y la zona", () => {
  const sum = fn("function renderSetupResumen(main)");
  assert.ok(sum.includes("<span>Partido</span><span>Inicio del partido</span>"));
  assert.ok(sum.includes('<span class="qz-sr">Inicio del partido: </span>${esc(fmtKickoff(m.kickoffAt))}'), "también para lectores de pantalla");
  assert.ok(sum.includes("Horarios en la zona de este dispositivo (${esc(kickZone)})."));
  assert.ok(sum.includes("<p>Cierre de pronósticos para todos los partidos: <strong>"));
  assert.ok(!sum.includes("<p>Cierre: <strong>"));
  assert.ok(fn("function wzMatchRowHtml(m, imported)").includes("Inicio del partido: ${esc(fmtKickoff(m.kickoffAt))}"));
  assert.ok(fn("function renderSetupRoundForm(main)").includes(">Cierre de pronósticos para todos los partidos (${esc(tzShortName("));
  // La zona que se nombra para los partidos es la misma con la que se escribe el cierre.
  const t = new Function("serverNowMs", `const serverNow = () => serverNowMs; ${fn("function fmtWhenTz(iso)")} ${fn("function tzShortName(iso)")} return { fmtWhenTz, tzShortName };`)(NOW);
  for (const at of [iso(72), iso(24 * 200)]) {
    const zone = t.tzShortName(at);
    assert.ok(zone, at);
    assert.ok(t.fmtWhenTz(at).endsWith(zone), `${t.fmtWhenTz(at)} termina con ${zone}`);
  }
});

test("co-admin · «Dejar puntos y cuota como están» usa lo que tiene el servidor, no la copia vieja de la pestaña (penalización incluida)", async () => {
  // La pestaña cargó puntos 1, sin cuota y sin penalización; la creadora cambió
  // en otro dispositivo a 3 puntos, $200 y −2 por jornada (mismas jornadas).
  const tab = { settings: { pointsPerCorrectPick: 1, entryFee: 0 }, participants: [], roundsRevision: 4, rounds: [] };
  const server = { settings: { pointsPerCorrectPick: 3, entryFee: 200 }, participants: [], roundsRevision: 4, rounds: [],
    paymentPenalty: { enabled: true, startsAtRound: 12, pointsPerRound: 2 } };
  const said = [];
  const env = new Function("meta", "server", "said", `
    let setupFlow = null;
    const setupPersist = () => {}, renderSetupFlow = () => {}, renderSetupAside = () => {};
    const setupPublishNumber = () => 12;
    const setupPublishMessage = (kind, html) => said.push(html);
    const getMeta = async () => JSON.parse(JSON.stringify(server));
    let loads = 0;
    const loadSetupCalendar = () => { loads++; };
    ${fn("function setSetupCal(cal)")}
    ${fn("function setupRoundsChangedElsewhere(flow, lead)")}
    const adminOrOwnerCred = () => "x";
    const console = { error(){} };
    ${fn("function esc(s)")}
    ${fn("function isPositiveInt(v)")}
    ${fn("function adoptFreshMeta(target, fresh)")}
    ${fn("function adoptSetupMeta(fresh, current)")}
    ${fn("function storedRuleValues()")}
    ${fn("async function refreshSetupMeta()")}
    ${fn("async function setupKeepStoredRules()")}
    return { start(d){ setupFlow = { d }; return setupFlow; }, setupKeepStoredRules, loads: () => loads };
  `)(tab, server, said);
  const flow = env.start({ points: 4, payOn: false, fee: null, penOn: false, penPoints: 1, penFrom: null });
  await env.setupKeepStoredRules();
  assert.deepEqual(
    { points: flow.d.points, payOn: flow.d.payOn, fee: flow.d.fee, penOn: flow.d.penOn, penPoints: flow.d.penPoints, penFrom: flow.d.penFrom },
    { points: 3, payOn: true, fee: 200, penOn: true, penPoints: 2, penFrom: null });
  assert.match(said[0], /los puntos en 3 por acierto, la cuota en \$200 MXN, la penalización como está guardada \(−2 por jornada sin pagar, desde la Jornada 12, la que publicas\), como ya estaban guardados/);
  // Guardada desde la Jornada 1 (antes de la que se publica): empieza con la que se publica, sin dejar el resumen bloqueado.
  server.paymentPenalty.startsAtRound = 1;
  const flow2 = env.start({ points: 3, payOn: true, fee: 200, penOn: false, penPoints: 1, penFrom: null });
  await env.setupKeepStoredRules();
  assert.deepEqual({ penOn: flow2.d.penOn, penFrom: flow2.d.penFrom }, { penOn: true, penFrom: null });
  // Y desde una jornada posterior, se respeta.
  server.paymentPenalty.startsAtRound = 14;
  const flow3 = env.start({ points: 3, payOn: true, fee: 200, penOn: false, penPoints: 1, penFrom: null });
  await env.setupKeepStoredRules();
  assert.equal(flow3.d.penFrom, 14);
  // Technical QA (ronda 2, P2 nuevo): si mientras tanto cambiaron las jornadas
  // en el servidor, no se deja «toca Publicar jornada N» con un número que ya
  // no es: se vuelve al resumen con el aviso de cambios, sin publicar.
  server.roundsRevision = 5;
  said.length = 0;
  const flow4 = env.start({ points: 1, payOn: false, fee: null, penOn: false, penPoints: 1, penFrom: null });
  await env.setupKeepStoredRules();
  assert.deepEqual(said, [], "sin el mensaje de «toca Publicar jornada N»");
  assert.match(flow4.notice.html, /^Listo: dejamos .* Hubo cambios en las jornadas de esta quiniela desde otra pestaña o dispositivo\. Revisa el resumen y vuelve a tocar «Publicar»\. No se publicó nada\.$/);
  assert.equal(flow4.cal, null);
  assert.equal(env.loads(), 1, "el calendario se vuelve a buscar");
  assert.equal(tab.settings.entryFee, 200, "la pestaña se queda con la copia del servidor");
});

test("numeración · una tarjeta en el flujo, encima de la jornada, dice el número real y qué se conserva (Founder, ronda 3)", () => {
  const make = (metaObj) => new Function("meta", `
    ${fn("function esc(s)")}
    ${fn("function setupLeagueId()")}
    ${fn("function setupManualNumberInfo(number)")}
    ${fn("function setupManualNumberCardHtml(number)")}
    return { setupManualNumberInfo, setupManualNumberCardHtml };
  `)(metaObj);
  const withCal = make({ settings: { sportsdbLeagueId: "4350" }, rounds: [round(11, -1, [-2]), round(12, 48, [50]), round(17, 800, [802])] });
  assert.deepEqual(withCal.setupManualNumberInfo(18), {
    title: "Tu jornada manual será la Jornada 18.",
    body: "El calendario de esta liga ya ocupa los números 11–17. Tus partidos y el cierre que elegiste se conservan.",
  });
  const card = withCal.setupManualNumberCardHtml(18);
  assert.match(card, /<section class="qz-wz-callout" id="qz-wz-number-card" role="status">/);
  assert.ok(card.includes("Tu jornada manual será la Jornada 18.") && card.includes("ya ocupa los números 11–17."));
  assert.equal(make({ settings: { sportsdbLeagueId: "4350" }, rounds: [round(12, 48, [50])] }).setupManualNumberInfo(13).body.slice(0, 50), "El calendario de esta liga ya ocupa el número 12. ");
  // Sin liga o sin jornadas del calendario, no hay nada que explicar.
  assert.equal(make({ settings: {}, rounds: [] }).setupManualNumberCardHtml(1), "");
  assert.equal(make({ settings: { sportsdbLeagueId: "4350" }, rounds: [] }).setupManualNumberCardHtml(1), "");
  // Encima de la sección de la jornada, en el paso 3 y en el resumen; el
  // encabezado, el resumen y el botón usan el mismo número.
  const form = fn("function renderSetupRoundForm(main)");
  assert.ok(form.includes("${numberCardHtml}\n      <section class=\"card qz-wz-card\" aria-labelledby=\"qz-wz-round-t\">"));
  assert.ok(form.includes("const numberCardHtml = imported ? \"\" : setupManualNumberCardHtml(number);"));
  const sum = fn("function renderSetupResumen(main)");
  assert.ok(sum.includes("${noticeHtml}\n          ${numberCardHtml}\n          <section class=\"card qz-wz-card qz-sum-section\" aria-labelledby=\"qz-sum-3\">"));
  assert.ok(sum.includes("const numberCardHtml = imported ? \"\" : setupManualNumberCardHtml(number);"));
  assert.ok(sum.includes("`Publicar jornada ${number}`") && sum.includes('id="qz-sum-3">Jornada ${esc(number)}</h2>'));
  // Ningún aviso flotante para esto.
  assert.ok(!fn("function adoptSetupMeta(fresh, current)").includes("toast("));
});

test("barra fija · nada del recorrido queda debajo: se reserva su altura real y lo que se lleva a la vista se detiene encima", () => {
  const bar = fn("function setupBar(backStep, nextLabel, onNext, opts)");
  assert.ok(bar.includes("trackSetupBarHeight(bar);"));
  const track = fn("function trackSetupBarHeight(bar)");
  assert.ok(track.includes('document.documentElement.style.setProperty("--qz-bar-h", (fixed ? Math.ceil(bar.getBoundingClientRect().height) : 0) + "px");'));
  assert.ok(track.includes("new ResizeObserver(apply)"), "crece si su texto baja de línea");
  assert.ok(indexSrc.includes("#quiniela-root .qz-setup-main{ min-width:0; padding-bottom:calc(var(--qz-bar-h, 96px) + 24px); }"));
  assert.ok(indexSrc.includes("html:has(#qz-setup-bar){ scroll-padding-bottom:calc(var(--qz-bar-h, 0px) + 16px); }"));
  assert.ok(indexSrc.includes("#quiniela-root .qz-setup-wrap *{ scroll-margin-bottom:calc(var(--qz-bar-h, 0px) + 16px);"));
  // El toast: un rectángulo que se lee completo, encima de la barra.
  assert.ok(indexSrc.includes("width:max-content; max-width:min(560px, calc(100vw - 32px));"));
  assert.ok(!/#quiniela-root \.toast\{[^}]*border-radius:999px/.test(indexSrc));
  assert.ok(indexSrc.includes("html:has(#qz-setup-bar) #quiniela-root .toast{ bottom:calc(var(--qz-bar-h, 0px) + 12px); }"));
  // El aviso de jornadas cambiadas va encima de la jornada, no al final del resumen.
  const sum = fn("function renderSetupResumen(main)");
  assert.ok(!sum.includes("setupPublishMessage(setupFlow.notice.kind"));
  assert.ok(sum.includes('id="qz-wz-notice"'));
});

