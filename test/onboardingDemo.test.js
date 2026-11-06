// onboardingDemo.test.js — sprint de onboarding: la demo «Ver cómo se juega»
// (/demo), sus dos conteos anónimos y los ajustes del recorrido del admin
// (calendario o a mano, preguntas extra, cuota y pagos, cierre, contraseña y
// «Qué pasa al publicar»).
//
// Lo puro se ejecuta (el cálculo completo de la demo, los mensajes y el texto
// del cronómetro); lo demás se comprueba en el código. El recorrido real en el
// navegador está en la evidencia de la entrega.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const sitemap = fs.readFileSync(path.join(__dirname, "..", "public", "sitemap.xml"), "utf8");

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
const between = (from, to) => {
  const a = indexSrc.indexOf(from), b = indexSrc.indexOf(to, a);
  assert.ok(a !== -1 && b !== -1, `${from} … ${to}`);
  return indexSrc.slice(a, b);
};

// ---- la demo, ejecutada -----------------------------------------------------
const demo = new Function(`
  ${fn("function computeDenseRanks(list)")}
  ${fn("function joinEs(items)")}
  ${fn("function pointsWord(n)")}
  ${between("const DEMO_MATCHES = Object.freeze([", "  // ---- medición anónima")}
  return { DEMO_MATCHES, DEMO_PEOPLE, DEMO_YOU, demoOutcome, demoHits, demoStandings, demoMoveText, demoMoveShort, demoOrdinal, demoPickLabel };
`)();

// Tus elecciones para 0, 1, 2 y 3 aciertos (resultados: P1 local, P2 empate, P3 visita).
const PICKS = {
  0: { p1: "V", p2: "L", p3: "L" },
  1: { p1: "L", p2: "L", p3: "L" },
  2: { p1: "L", p2: "E", p3: "L" },
  3: { p1: "L", p2: "E", p3: "V" },
};
const row = (t, id) => t.find((r) => r.id === id);

test("demo · datos: 5 participantes con «Tú (demo)», 3 partidos con un empate y 1 punto por acierto", () => {
  assert.equal(demo.DEMO_PEOPLE.length, 5);
  assert.ok(demo.DEMO_PEOPLE.some((p) => p.id === demo.DEMO_YOU && p.name === "Tú (demo)"));
  assert.equal(demo.DEMO_MATCHES.length, 3);
  assert.deepEqual(demo.DEMO_MATCHES.map(demo.demoOutcome), ["L", "E", "V"], "uno de los tres es empate");
  assert.ok(indexSrc.includes("const DEMO_POINTS_PER_HIT = 1;"));
  // Los pronósticos de las otras cuatro personas y sus puntos anteriores están definidos.
  for (const p of demo.DEMO_PEOPLE.filter((x) => x.id !== demo.DEMO_YOU)) {
    assert.deepEqual(Object.keys(p.picks).sort(), ["p1", "p2", "p3"]);
    assert.ok(Number.isInteger(p.before));
  }
});

test("demo · cálculo completo: los puntos de la jornada, totales y posiciones de TODOS, no sólo de «Tú»", () => {
  const t = demo.demoStandings(PICKS[2]);
  // Los demás: Ana 1 acierto, Beto 3, Caro 1, Dani 2.
  assert.deepEqual(["ana", "beto", "caro", "dani"].map((id) => [row(t, id).round, row(t, id).total]), [[1, 13], [3, 14], [1, 11], [2, 10]]);
  // Antes: Ana 12 (1.º), Beto 11 (2.º), Caro 10 (3.º), Tú 9 (4.º), Dani 8 (5.º).
  assert.deepEqual(["ana", "beto", "caro", "you", "dani"].map((id) => row(t, id).rankBefore), [1, 2, 3, 4, 5]);
  // Los cambios de los demás también se calculan.
  assert.equal(demo.demoMoveText(row(t, "beto"), t, false), "Beto sube del 2.º al 1.er lugar.");
  assert.equal(demo.demoMoveText(row(t, "ana"), t, false), "Ana baja del 1.er al 2.º lugar.");
  assert.equal(demo.demoMoveShort(row(t, "beto")), "▲ Sube 1");
  assert.equal(demo.demoMoveShort(row(t, "ana")), "▼ Baja 1");
});

test("demo · 0, 1, 2 y 3 aciertos: totales, posiciones densas (empate comparte puesto) y mensajes calculados", () => {
  const cases = {
    0: { total: 9, rank: 5, msg: "Bajaste del 4.º al 5.º lugar.", order: ["beto", "ana", "caro", "dani", "you"], ranks: [1, 2, 3, 4, 5] },
    1: { total: 10, rank: 4, msg: "Te mantienes en el 4.º lugar, en empate con Dani.", order: ["beto", "ana", "caro", "dani", "you"], ranks: [1, 2, 3, 4, 4] },
    2: { total: 11, rank: 3, msg: "Subiste del 4.º al 3.er lugar, en empate con Caro.", order: ["beto", "ana", "caro", "you", "dani"], ranks: [1, 2, 3, 3, 4] },
    3: { total: 12, rank: 3, msg: "Subiste del 4.º al 3.er lugar.", order: ["beto", "ana", "you", "caro", "dani"], ranks: [1, 2, 3, 4, 5] },
  };
  for (const [hits, c] of Object.entries(cases)) {
    assert.equal(demo.demoHits(PICKS[hits]), Number(hits));
    const t = demo.demoStandings(PICKS[hits]);
    const me = row(t, "you");
    assert.equal(me.round, Number(hits)); assert.equal(me.total, c.total); assert.equal(me.rankAfter, c.rank, `${hits} aciertos`);
    assert.deepEqual(t.map((r) => r.id), c.order, `orden con ${hits}`);
    assert.deepEqual(t.map((r) => r.rankAfter), c.ranks, `posiciones densas con ${hits}`);
    assert.equal(demo.demoMoveText(me, t, true), c.msg);
  }
  // Empate visto desde la otra persona: no dice «con Tú».
  const t1 = demo.demoStandings(PICKS[1]);
  assert.equal(demo.demoMoveText(row(t1, "dani"), t1, false), "Dani sube del 5.º al 4.º lugar, en empate contigo.");
});

test("demo · elegir «Empate» acierta sólo en el partido que terminó empatado", () => {
  assert.equal(demo.demoHits({ p1: "E", p2: "E", p3: "E" }), 1);
  assert.equal(demo.demoPickLabel(demo.DEMO_MATCHES[1], "E"), "Empate");
  assert.equal(demo.demoPickLabel(demo.DEMO_MATCHES[0], "L"), "Gana Halcones");
  assert.equal(demo.demoPickLabel(demo.DEMO_MATCHES[2], "V"), "Gana Jaguares");
  assert.deepEqual([1, 2, 3, 4, 5].map(demo.demoOrdinal), ["1.er", "2.º", "3.er", "4.º", "5.º"]);
});

// ---- la demo, en el código --------------------------------------------------
const demoCode = between("  // ONB-14 · «Ver cómo se juega» (/demo)\n", "  async function renderCrear(){");
// Sin comentarios: lo que se comprueba es el código que corre.
const demoCodeOnly = demoCode.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("demo · ruta propia /demo, sin indexar y fuera del sitemap", () => {
  assert.ok(indexSrc.includes('else if(pathParts[0] === "demo" && pathParts.length === 1){ ROUTE = "demo"; }'));
  const boot = fn("async function boot(attempt)");
  assert.ok(boot.indexOf('if(ROUTE === "demo"){ renderDemo(); return; }') < boot.indexOf("syncServerTime()"), "la demo no consulta el servidor al arrancar");
  assert.ok(boot.indexOf('if(ROUTE === "demo"){ renderDemo(); return; }') < boot.indexOf("getMeta()"), "ni lee ninguna quiniela");
  assert.ok(fn("function renderDemo()").includes('m.name = "robots"; m.content = "noindex, nofollow";'));
  assert.match(serverSrc, /app\.get\("\/demo", \(req, res\) => \{\n  res\.set\("Cache-Control", "no-cache"\);\n  res\.set\("X-Robots-Tag", "noindex, nofollow"\);\n  res\.sendFile\(INDEX_HTML_PATH\);\n\}\);/);
  assert.ok(!sitemap.includes("/demo"));
});

test("demo · separada del estado real: sin sesión, PIN, quiniela, pronósticos ni almacenamiento; sólo los dos conteos", () => {
  for (const banned of ["getMeta(", "kvSet", "setMeta", "apiCreateQuiniela", "sessionStorage", "localStorage", "trackEvent(", "getDeviceId", "setAuthHeaders", "/api/kv", "/api/picks", "saveCrearDraft"]) {
    assert.ok(!demoCodeOnly.includes(banned), `la demo no usa ${banned}`);
  }
  assert.equal((demoCodeOnly.match(/fetch\(/g) || []).length, 1, "un solo fetch: la medición");
  assert.ok(demoCode.includes('fetch("/api/track-event", {'));
});

test("demo · medición: sin credenciales ni identificadores, una vez por entrada, sin reintentos y sin bloquear", () => {
  const t = fn("function trackDemoEvent(name)");
  assert.ok(t.includes('credentials: "omit"'));
  assert.ok(t.includes('body: JSON.stringify({ event: name, source: "demo" })'), "sólo el evento y el origen");
  assert.ok(t.includes("if(demoEventsSent.has(name)) return;") && t.includes("demoEventsSent.add(name);"), "como máximo una vez por entrada");
  assert.ok(t.includes(".catch(() => {})") && !/retry|setInterval/.test(t), "un fallo no bloquea ni reintenta");
  const wire = fn("function wireDemo()");
  assert.ok(wire.includes('on("qz-demo-start", () => { trackDemoEvent("demo_started");'), "demo_started al pulsar Empezar");
  assert.ok(wire.includes('on("qz-demo-table", () => { trackDemoEvent("demo_completed"); demoGo(4); });'), "demo_completed al llegar a la Tabla");
  const again = wire.slice(wire.indexOf('on("qz-demo-again"'));
  assert.ok(!again.includes("trackDemoEvent"), "«Probar otra vez» no mide de nuevo");
});

test("demo · servidor: admite los dos eventos y descarta identificadores sólo para ellos", () => {
  const known = serverSrc.slice(serverSrc.indexOf("const KNOWN_EVENTS = new Set(["), serverSrc.indexOf("]);", serverSrc.indexOf("const KNOWN_EVENTS")));
  assert.ok(known.includes('"demo_started"') && known.includes('"demo_completed"'));
  assert.ok(serverSrc.includes('const DEMO_EVENTS = new Set(["demo_started", "demo_completed"]);'));
  const handler = serverSrc.slice(serverSrc.indexOf('app.post("/api/track-event"'), serverSrc.indexOf("// Sprint 14.4 — lectura agregada"));
  assert.ok(handler.includes("VALUES ($1, NULL, NULL, NULL, NULL, 'demo')"));
  assert.ok(handler.indexOf("if (DEMO_EVENTS.has(event))") < handler.indexOf("deviceId ? String(deviceId).slice(0, 80) : null"), "los demás eventos siguen igual");
});

test("demo · recorrido: 4 pantallas, barra con el aviso, elegir los 3 partidos, resultados con la frase de publicar y salida al origen", () => {
  const paint = fn("function paintDemo(focusTitle)");
  assert.ok(paint.includes("Paso ${esc(st.step)} de 4"));
  assert.ok(fn("function demoBarHtml(origin)").includes("<strong>Demo con datos ficticios.</strong> Tus pronósticos no se envían ni se guardan."));
  assert.ok(paint.includes("Cierre (ejemplo):"), "el cierre se identifica como ejemplo, sin fecha real");
  assert.ok(paint.includes("Los puntos de los partidos se suman cuando el organizador publica sus resultados."));
  assert.ok(paint.includes("<th scope=\"col\">Antes</th><th scope=\"col\">Esta jornada</th><th scope=\"col\">Total</th>"));
  const wire = fn("function wireDemo()");
  assert.ok(wire.includes("const missing = DEMO_MATCHES.filter(m => !st.picks[m.id]).map(m => m.id);") && wire.includes("demoGo(3);"));
  assert.ok(paint.includes('Te falta elegir: '), "explica cuál falta");
  assert.ok(wire.includes('on("qz-demo-again", () => { st.picks = {}; st.missing = []; demoGo(2); });'), "probar otra vez: escenario limpio");
  const origin = fn("function demoOrigin()");
  assert.ok(origin.includes('from === "crear" ? { href: "/crear", label: "Volver a Crear" } : { href: "/", label: "Volver al inicio" }'));
  // Volver a Crear conserva lo escrito: Crear guarda su borrador en esta pestaña.
  assert.ok(indexSrc.includes('<a href="/demo?desde=crear" id="qz-c-demo">Ver la demo</a>'));
  assert.ok(fn("async function renderCrear()").includes("const draft = renderCrear._draft || loadCrearDraft();"));
  // Portada: entrada secundaria, sin quitar el acceso de quien ya tiene invitación.
  const home = fn("function renderHome()");
  assert.ok(home.includes('<a href="/demo" class="qz-hero-btn-ghost-dark" id="qz-hero-demo">Ver cómo se juega</a>'));
  assert.ok(home.includes('<a href="#qz-hero-invite-note" class="qz-hero-btn-ghost-dark">Ya tengo una invitación</a>'));
  assert.ok(home.includes('<a href="#qz-hero-invite-note" class="qz-hero-nav-link">Ya tengo una invitación</a>'));
});

// ---- el recorrido del admin ---------------------------------------------------
test("ONB · calendario o a mano: etiquetas fijas, estado con texto y aria-pressed; no borra la liga elegida", () => {
  const html = fn("function setupModeChoiceHtml(manual)");
  assert.ok(html.includes('aria-pressed="${on ? "true" : "false"}"'));
  assert.ok(html.includes('${on ? "✓ Elegida" : "No elegida"}'));
  assert.ok(indexSrc.includes('const SETUP_MODE_LABELS = Object.freeze({ cal: "Usar el calendario de la liga", manual: "Armar los partidos a mano" });'));
  const wire = fn("function wireSetupModeChoice(d)");
  assert.ok(!wire.includes("leaguePick"), "cambiar de opción conserva la liga elegida");
  assert.ok(!/setMeta|clearRoundDraft|setupPublish/.test(wire), "no guarda, no publica, no borra el borrador de partidos");
  assert.ok(!fn("function renderSetupLiga(main)").includes('d.leaguePick = ""'));
});

test("ONB · textos: preguntas extra, el dinero (visible siempre y distinto de Plus) y la penalización", () => {
  const liga = fn("function renderSetupLiga(main)");
  assert.ok(liga.includes("Opcional. Puedes añadirlas ahora o después en Admin → Tus reglas. Tus amigos las responden además de los partidos y tú marcas quién acertó."));
  const pagos = fn("function renderSetupPagos(main)");
  const money = pagos.indexOf("QRACKS no recibe ni guarda el dinero de tu quiniela. Aquí sólo anotas la cuota y marcas quién ya te pagó.");
  assert.ok(money !== -1 && money < pagos.indexOf("${d.payOn ? `"), "antes del interruptor: visible con el registro apagado");
  assert.ok(pagos.includes("no tienen relación con el plan Plus de QRACKS"));
  assert.ok(pagos.includes(">Empiezan a restarse puntos en la jornada</label>"));
  assert.ok(!pagos.includes(">Empieza en la jornada<"));
});

test("ONB · cierre: tarjeta antes de los partidos; cronómetro del mismo campo y reloj, sin anuncios cada segundo ni negativos", () => {
  const form = fn("function renderSetupRoundForm(main)");
  assert.ok(form.indexOf('aria-labelledby="qz-wz-deadline-l"') < form.indexOf('aria-labelledby="qz-wz-round-t"'));
  assert.ok(form.includes('<p class="qz-wz-countdown" id="qz-wz-countdown"></p>'), "sin aria-live");
  assert.ok(form.includes("countdownEl.textContent = setupCountdownText(deadlineEl.value, serverNow());"));
  const t = new Function(`
    ${fn("function fmtWhenTz(iso)")}
    const serverNow = () => Date.parse("2026-11-06T18:00:00Z");
    ${fn("function setupCountdownText(inputValue, nowMs)")}
    return setupCountdownText;`)();
  const now = Date.parse("2026-11-06T18:00:00Z");
  const local = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  assert.match(t(local(now + (2 * 86400 + 3 * 3600 + 5 * 60) * 1000), now), /^Faltan 2 d 03 h 05 min 00 s para el cierre: .+\.$/);
  assert.match(t(local(now - 3600 * 1000), now), /^Ese cierre \(.+\) ya pasó\.$/);
  // Un número negativo, no cualquier guion: la zona puede ser «GMT-6».
  assert.ok(!/(^|[\s(])-\s?\d/.test(t(local(now - 3600 * 1000), now)), "nunca una cuenta negativa");
  assert.equal(t("", now), "Elige la fecha y hora de cierre para ver cuánto falta.");
  assert.ok(fn("function renderSetupFlow()").includes("stopSetupCountdown();"), "el temporizador no sobrevive a otro paso");
  // Un año de 6 cifras que el navegador deja teclear no rompe el paso 3.
  assert.equal(t("220000-01-02T20:30", now), "Elige la fecha y hora de cierre para ver cuánto falta.");
  const iso = new Function(`${fn("function setupDeadlineIsoOrNull(value)")} return setupDeadlineIsoOrNull;`)();
  assert.equal(iso("220000-01-02T20:30"), null);
  assert.equal(iso(""), null);
  assert.equal(iso("2026-11-07T20:30"), new Date("2026-11-07T20:30").toISOString());
  assert.ok(form.includes("tzShortName(setupDeadlineIsoOrNull(rows.deadline))"));
  assert.ok(form.includes('max="9999-12-31T23:59"'));
  assert.ok(form.includes('countdownEl.classList.toggle("qz-wz-countdown-empty"'), "sin fecha, la instrucción no parece un estado");
  assert.ok(form.includes("aunque puede coincidir con la del primero."), "no contradice el cierre sugerido a la hora del primer partido");
});

test("ONB · contraseña y publicación: dos pasos para quien crea; co-admin y contraseña existente sin invitación a crear otra", () => {
  const steps = fn("function setupPublishStepsHtml(number, needsPassword, changesProtected)");
  assert.ok(steps.includes("<strong>No es tu PIN</strong> y crearla no publica nada."));
  assert.ok(steps.includes("Después toca <strong>«Publicar jornada ${esc(number)}»</strong>."));
  assert.ok(steps.includes("Tú no necesitas crear otra."));
  assert.ok(steps.includes("Toca <strong>«Publicar jornada ${esc(number)}»</strong> para abrir la jornada a tus amigos."));
  assert.ok(steps.includes("const pwLine = meta && meta.ownerPasswordSet\n"), "sólo promete la contraseña cuando de verdad se pedirá");
  // Pestaña desactualizada: el resumen invitaba a crear la contraseña y otra
  // pestaña ya la creó; ese toque no publica, repinta con «Publicar jornada N».
  const click = fn("async function setupPublishClickNow(btn)");
  const guard = click.indexOf("if(setupSummaryOffersPassword && !needsAdminPasswordToPublish()){");
  assert.ok(guard > click.indexOf("await refreshSetupMeta();"), "decide con la meta recién leída del servidor");
  assert.ok(guard < click.indexOf("const number = setupPublishNumber();"), "antes de cualquier escritura");
  assert.ok(click.includes("No se publicó nada: toca «Publicar jornada ${esc(setupPublishNumber())}» para publicar."));
  assert.ok(fn("function renderSetupResumen(main)").includes("setupSummaryOffersPassword = !!(needsPassword && isCreator(currentUser));"));
  const saved = new Function(`const joinEs = (a) => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " y " + a[a.length - 1];
    ${fn("function setupRulesSavedList(d, questionCount)")} return setupRulesSavedList;`)();
  assert.equal(saved({ payOn: true, penOn: true }, 0), "puntos por acierto y cuota con penalización");
  const sum = fn("function renderSetupResumen(main)");
  assert.ok(sum.includes('<details class="qz-pubinfo" id="qz-wz-pubinfo">') && sum.includes("<summary>Qué pasa al publicar</summary>"));
  assert.ok(sum.indexOf("Vas a publicar la Jornada ${esc(number)}") < sum.indexOf("<details"), "jornada y cierre siempre visibles");
  assert.ok(sum.includes('<div id="qz-wz-publish-msg"></div>'), "se conservan los avisos si algo no se pudo guardar");
});

test("ONB · laptop: la barra va en la columna principal, justo después del contenido (sin hueco bajo un paso corto)", () => {
  const flow = fn("function renderSetupFlow()");
  assert.ok(flow.includes('<aside class="qz-setup-aside" id="qz-setup-aside" aria-label="Tu configuración"></aside>\n          <div class="qz-setup-bar" id="qz-setup-bar"></div>\n        </div>'));
  assert.ok(indexSrc.includes("#quiniela-root .qz-setup-grid{ grid-template-columns:minmax(0, 640px) 340px; grid-template-rows:auto 1fr;"));
  assert.ok(indexSrc.includes("#quiniela-root .qz-setup-bar{ grid-column:1; grid-row:2; align-self:start;"));
  assert.ok(!indexSrc.includes("padding-right:372px"));
});

test("ONB-01 · el catálogo de preguntas predeterminadas no cambia en este sprint (lista pendiente)", () => {
  assert.ok(indexSrc.includes('{ key: "campeon", text: "¿Qué equipo será campeón del torneo?", scope: "temporada", points: 5 },'));
  assert.ok(indexSrc.includes('{ key: "anota", text: "¿Qué jugador anotará al menos un gol en esta jornada?", scope: "jornada", points: 3 },'));
  assert.ok(indexSrc.includes('{ key: "sin_goles", text: "¿Qué equipo terminará esta jornada sin recibir goles?", scope: "jornada", points: 3 },'));
});
