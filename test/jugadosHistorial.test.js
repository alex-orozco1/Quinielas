// JUG-01 (Jugados: elegir una jornada) y HIS-01 (Historial: encabezados y
// «Resultado real» fijos). public/index.html no tiene DOM bajo node:test: se
// extraen las funciones reales y se ejecutan con dobles mínimos; lo visual
// (fijación, alineación, desplazamiento) lo cubre el recorrido en navegador.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function fnSource(signature) {
  const start = html.indexOf(signature);
  assert.ok(start !== -1, `no se encontró «${signature}»`);
  const braceStart = start + signature.length - 1; // la firma termina en «{»
  let depth = 0, i = braceStart;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function playedEnv(myPicks, settings) {
  const src = [fnSource("function pickText(m, v){"), fnSource("function compareHtml(mine, real, verdict, verdictCls){"), fnSource("function renderRoundPlayed(box, round){")].join("\n");
  return new Function("esc", "myPicks", "meta", `
    const pointsWord = (n) => Number(n) === 1 ? "punto" : "puntos";
    const matchTeamsHtml = (m) => "<div>" + esc(m.teamA) + " vs " + esc(m.teamB) + "</div>";
    const roundBetAnswersHtml = () => "";
    ${src}
    return (round) => { const box = { innerHTML: "" }; renderRoundPlayed(box, round); return box.innerHTML; };
  `)(esc, myPicks, { settings: settings || {} });
}

const round = {
  id: "r9", number: 9, resultsPublished: true,
  matches: [
    { id: "m1", teamA: "Halcones", teamB: "Toros" },
    { id: "m2", teamA: "Lobos", teamB: "Águilas" },
    { id: "m3", teamA: "Coyotes", teamB: "Jaguares" },
    { id: "m4", teamA: "Pumas", teamB: "Tiburones" },
  ],
  results: { m1: "A", m2: "D", m3: "B" }, // m4 sin resultado: pendiente
};

test("JUG-01 · Jugados compara «Tu pronóstico» con «Resultado real» y suma aciertos y puntos de esa jornada", () => {
  const out = playedEnv({ r9: { m1: "A", m2: "B", m4: "A" } }, { pointsPerCorrectPick: 3 })(round);
  assert.match(out, /1\/3 aciertos · 3 puntos/);
  assert.equal((out.match(/Tu pronóstico/g) || []).length, 4);
  assert.equal((out.match(/Resultado real/g) || []).length, 4);
  assert.match(out, /Acertaste ✅ · \+3 puntos/);
  assert.match(out, /Fallaste ❌ · 0 puntos/);
  assert.match(out, /No pronosticaste · 0 puntos/);
});

test("JUG-01 · un partido sin resultado queda «Pendiente»: no se inventa «Empate» ni cuenta como fallo", () => {
  const out = playedEnv({ r9: { m4: "A" } })(round);
  const m4 = out.slice(out.indexOf("Pumas vs Tiburones"));
  assert.match(m4, /Resultado real<\/span><strong>Pendiente<\/strong>/);
  assert.match(m4, /Pendiente · todavía no se califica/);
  assert.doesNotMatch(m4, /Fallaste|Empate<\/strong>|pick-btn wrong/);
  assert.match(out, /Faltan por calificar 1 partido\./);
});

test("JUG-01 · jornada sin pronósticos: compara «Sin pronóstico» con el resultado real", () => {
  const out = playedEnv({})(round);
  assert.equal((out.match(/Sin pronóstico/g) || []).length, 4);
  assert.match(out, /0\/3 aciertos · 0 puntos/);
  assert.match(out, /Pendiente · no enviaste pronóstico/);
});

test("JUG-01 · Jugados pinta sólo la jornada elegida; la más reciente primero y elegida al entrar", () => {
  const rj = fnSource("async function renderJornada(main){");
  assert.ok(rj.includes('if(jornadaFilter === "jugados"){ renderJugadosPicker(list, rounds); return; }'));
  const picker = fnSource("function renderJugadosPicker(list, rounds, focusSel){");
  assert.ok(picker.includes("const desc = rounds.slice().reverse();"));
  assert.ok(picker.includes("desc.find(r => r.id === jugadosRoundId) || desc[0]"));
  assert.ok(picker.includes('for="qz-jugados-select">Elige la jornada</label>'));
  assert.ok(picker.includes("(isLg(sel) ? renderLiguillaPlayed : renderRoundPlayed)(box, sel)"));
  assert.ok(picker.includes("Por ahora sólo hay una"), "con una sola jornada no hay selector");
  // Sólo presentación: no guarda nada.
  assert.doesNotMatch(picker, /setMeta|kvSet|savePicks|fetch\(/);
});

test("JUG-01 · las opciones respetan los nombres de liguilla (fase, ida/vuelta) y marcan resultados parciales", () => {
  const src = [fnSource("function roundHasWaiting(round){"), fnSource("function jugadosOptionLabel(round){")].join("\n");
  const LG = require(path.join(__dirname, "..", "liguillaScoring.js"));
  const label = new Function("LG", `
    const isLg = (r) => r.stage === "liguilla";
    const roundTitle = (r) => isLg(r) ? (LG.phaseLabel(r.phase) || "Liguilla · Jornada " + r.number) : "Jornada " + r.number;
    const roundSubtitle = (r) => isLg(r) && LG.phaseLabel(r.phase) ? "Jornada " + r.number : "";
    ${src}
    return jugadosOptionLabel;
  `)(LG);
  const lg = { id: "q2", number: 16, stage: "liguilla", phase: { round: "quarter", leg: "vuelta", source: "admin" }, scoring: { resultPoints: 1, exactBonus: 1 },
    resultsPublished: true, results: { a: "B" }, scores: { a: { a: 0, b: 1 } }, matchStatus: { b: "postponed" }, matches: [{ id: "a" }, { id: "b" }] };
  assert.equal(label(lg), "Cuartos de final · Vuelta · Jornada 16 · resultados parciales");
  assert.equal(label({ ...lg, matchStatus: { b: "void" } }), "Cuartos de final · Vuelta · Jornada 16");
  assert.equal(label(round), "Jornada 9 · resultados parciales");
  assert.equal(label({ ...round, results: { m1: "A", m2: "D", m3: "B", m4: "A" } }), "Jornada 9");
});

test("JUG-01 · liguilla en Jugados: compara y conserva aplazado, anulado y pendiente", () => {
  const fn = fnSource("function renderLiguillaPlayed(box, round){");
  assert.ok(fn.includes('<span class="qz-compare-k">Tu pronóstico</span>'));
  assert.ok(fn.includes('<span class="qz-compare-k">Resultado real</span>'));
  const br = fnSource("function lgMatchBreakdownHtml(round, m, out, pickValue){");
  assert.ok(br.includes("Anulado · no suma para nadie"));
  assert.ok(br.includes("Aplazado · "));
  assert.ok(br.includes("Pendiente · todavía no se califica"));
});

function compareEnv() {
  return new Function("esc", `${fnSource("function stickyCompareHtml({ tableCls, cols, headRows, bodyRows, caption }){")}; return stickyCompareHtml;`)(esc);
}

test("HIS-01 · la tabla fija repite las mismas columnas arriba y abajo; la de arriba no se lee dos veces", () => {
  const out = compareEnv()({ tableCls: "qz-cmp-reg", cols: ["c-name", "c-cell", "c-pts"], headRows: "<tr><th>P</th></tr><tr class=\"qz-cmp-real\"><th>Resultado real</th></tr>", bodyRows: "<tr><th>Ana</th></tr>", caption: "Jornada 3 <x>" });
  const colgroups = out.match(/<colgroup>.*?<\/colgroup>/g);
  assert.equal(colgroups.length, 2);
  assert.equal(colgroups[0], colgroups[1]);
  assert.match(out, /<div class="qz-cmp-head" aria-hidden="true">/);
  assert.match(out, /<thead class="qz-cmp-sr"><tr><th>P<\/th><\/tr><tr class="qz-cmp-real"><th>Resultado real<\/th><\/tr><\/thead><tbody><tr><th>Ana<\/th><\/tr><\/tbody>/);
  assert.match(out, /<caption class="sr-only">Jornada 3 &lt;x&gt;<\/caption>/);
  assert.equal((out.match(/data-cmp-head/g) || []).length, 1);
  assert.equal((out.match(/data-cmp-body/g) || []).length, 1);
});

test("HIS-01 · regular y liguilla usan la tabla fija, con «Resultado real» entre las filas fijas", () => {
  const reg = fnSource("function renderHistDetail(round){");
  assert.ok(reg.includes("const tableHtml = stickyCompareHtml({") && reg.includes("${tableHtml}") && reg.includes("wireStickyCompare(detail);"));
  assert.ok(reg.includes('<tr class="qz-cmp-real"><th scope="row" class="qz-sticky-col qz-cmp-name"><strong>Resultado real</strong></th>'));
  assert.ok(reg.includes("pick && result?'color:#7d251d;'"), "un pronóstico de partido pendiente no se pinta como fallo");
  const lg = fnSource("function renderLiguillaHistDetail(detail, round){");
  assert.ok(lg.includes("const tableHtml = stickyCompareHtml({") && lg.includes("${tableHtml}") && lg.includes("wireStickyCompare(detail);"));
  assert.ok(lg.includes('<tr class="lg-h-real"><th scope="row" class="qz-sticky-col lg-h-name"><strong>Resultado real</strong></th>'));
});

test("HIS-01 · la cabecera se fija bajo el menú verde medido en vivo y sincroniza el desplazamiento lateral", () => {
  assert.match(html, /\.qz-cmp-head\{ position:sticky; top:var\(--qz-header-h, 0px\);/);
  const track = fnSource("function trackHeaderHeight(){");
  assert.ok(track.includes('root.querySelector(".qz-header")'));
  assert.ok(track.includes("getBoundingClientRect().height"));
  assert.ok(track.includes("ResizeObserver"));
  const wire = fnSource("function wireStickyCompare(container){");
  assert.ok(wire.includes("head.scrollLeft = body.scrollLeft"));
  assert.ok(wire.includes("body.scrollLeft = head.scrollLeft"));
  // La fila de lectores de pantalla no ocupa alto.
  assert.match(html, /\.qz-cmp-sr th, #quiniela-root \.qz-cmp-sr td\{ height:0; padding:0 !important;/);
});

test("JUG-01 · sin la lectura de lo guardado, Jugados no afirma «Sin pronóstico» ni «0 puntos»: ofrece cargarlos", () => {
  const picker = fnSource("function renderJugadosPicker(list, rounds, focusSel){");
  const i = picker.indexOf("if(myPicksLoadFailed){");
  assert.ok(i !== -1);
  const branch = picker.slice(i, picker.indexOf("return;", i));
  assert.ok(branch.includes("data-picks-reload") && branch.includes("wirePicksReload(box)"));
  assert.ok(i < picker.indexOf("renderRoundPlayed)(box, sel)"), "el aviso va antes del desglose");
  // El selector se conecta antes de pintar la tarjeta: si una falla, se elige otra.
  assert.ok(picker.indexOf('select.addEventListener("change"') < picker.indexOf("renderRoundPlayed)(box, sel)"));
  // El aviso para lectores no se recrea en cada cambio.
  assert.ok(picker.includes('let status = document.getElementById("qz-jpick-status");') && picker.includes("list.after(status)"));
});

test("JUG-01 · «Cambiar usuario» olvida la jornada elegida por la persona anterior", () => {
  const i = html.indexOf('document.getElementById("qz-switch-user").addEventListener("click"');
  const block = html.slice(i, i + 1500);
  assert.ok(block.includes("lgResetSession();\n      jugadosRoundId = null;"));
});

test("HIS-01 · en teléfono horizontal (≤480 px de alto) la cabecera no se fija, para dejar ver a los participantes", () => {
  assert.match(html, /@media \(max-height:480px\)\{\s*#quiniela-root \.qz-cmp-head\{ position:static; box-shadow:none; \}/);
});
