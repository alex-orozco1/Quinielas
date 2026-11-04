// Historial de liguilla: cada casilla separa pronóstico, puntos y tipo de
// acierto (revisión de e8fde8d). Ejecuta las funciones REALES de
// public/index.html con el módulo de puntos real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const L = require("../liguillaScoring");

const head = html.slice(html.indexOf("  // ---------- LIGUILLA (sprint de liguilla, D1–D7) ----------"), html.indexOf("  // ---- guardado por partido"));
const hist = html.slice(html.indexOf("  // Historial de liguilla: cada celda separa"), html.indexOf("  function renderLiguillaHistDetail(detail, round){"));
const api = new Function("L", `
  const window = { QracksLiguilla: L }; let meta = { rounds: [], settings: {} }, myPicks = {};
  const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;");
  ${head}
  ${hist}
  return { lgHistCellHtml, lgHitSummary, lgRulesSentence };
`)(L);
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const s = (a, b) => ({ a, b });
const round = (results, scores, matchStatus) => ({ id: "r", stage: "liguilla", resultsPublished: true, scoring: { capture: "score", resultPoints: 1, exactBonus: 1 },
  matches: [{ id: "m1", teamA: "América", teamB: "Atlético de San Luis" }, { id: "m2", teamA: "Tigres", teamB: "Cruz Azul" }], results, scores, matchStatus: matchStatus || {} });
const R = round({ m1: "A", m2: "D" }, { m1: s(2, 1), m2: s(1, 1) });
const cell = (rd, mid, pick) => {
  const rp = pick ? { [mid]: L.outcomeOfScore(pick), __score: { [mid]: pick } } : {};
  const out = L.scoreRound(rd, rp).matches.find((x) => x.matchId === mid);
  return text(api.lgHistCellHtml(rd, rd.matches.find((m) => m.id === mid), out, pick));
};

test("HISTORIAL · cada casilla dice pronóstico, puntos y tipo de acierto; el exacto explica su desglose", () => {
  assert.equal(cell(R, "m1", s(2, 1)), "Pronóstico: 2–1 2 pts · Marcador exacto 1 por resultado + 1 extra por exacto = 2 pts");
  assert.equal(cell(R, "m2", s(2, 2)), "Pronóstico: 2–2 1 pt · Empate acertado");
  assert.equal(cell(R, "m1", s(3, 1)), "Pronóstico: 3–1 1 pt · Resultado acertado");
  assert.equal(cell(R, "m1", s(0, 1)), "Pronóstico: 0–1 0 pts · No acertó");
  assert.ok(!/1\+1/.test(cell(R, "m1", s(2, 1))), "nada de «1+1» sin etiquetas");
});

test("HISTORIAL · sin pronóstico, pendiente, aplazado y anulado se distinguen; ninguno parece fallo ni 0–0", () => {
  assert.equal(cell(R, "m1", null), "Sin pronóstico 0 pts");
  const P = round({ m2: "D" }, { m2: s(1, 1) }, { m1: "pending" });
  assert.equal(cell(P, "m1", s(2, 1)), "Pronóstico: 2–1 Pendiente · aún no se califica");
  const A = round({ m2: "D" }, { m2: s(1, 1) }, { m1: "postponed" });
  assert.equal(cell(A, "m1", s(2, 1)), "Pronóstico: 2–1 Aplazado · se califica cuando se juegue");
  const V = round({ m2: "D" }, { m2: s(1, 1) }, { m1: "void" });
  assert.equal(cell(V, "m1", null), "Sin pronóstico Anulado · no cuenta para nadie");
  for (const c of [cell(P, "m1", s(2, 1)), cell(A, "m1", s(2, 1)), cell(V, "m1", null)]) {
    assert.ok(!/No acertó|0–0/.test(c), c);
  }
});

test("HISTORIAL · resumen: el exacto va dentro de los partidos acertados (ejemplo de la revisión: Ana 3, Beto 1, Carla 1)", () => {
  const sum = (picks) => { const res = L.scoreRound(R, picks); return [res.total, api.lgHitSummary(res)]; };
  const p = (m1, m2) => ({ m1: L.outcomeOfScore(m1), m2: L.outcomeOfScore(m2), __score: { m1, m2 } });
  assert.deepEqual(sum(p(s(2, 1), s(2, 2))), [3, "2 partidos acertados (1 exacto)"]);
  assert.deepEqual(sum(p(s(1, 1), s(3, 3))), [1, "1 partido acertado"]);
  assert.deepEqual(sum(p(s(0, 1), s(2, 2))), [1, "1 partido acertado"]);
  const P = round({}, {}, { m1: "pending", m2: "postponed" });
  assert.equal(api.lgHitSummary(L.scoreRound(P, {})), "Aún sin partidos calificados · 2 sin calificar");
});

test("HISTORIAL · las reglas de la jornada se dicen con palabras, con y sin extra", () => {
  assert.equal(api.lgRulesSentence({ capture: "score", resultPoints: 1, exactBonus: 1 }), "Atinarle al ganador o al empate: 1 pt. Marcador exacto: +1 extra (en total 2 pts).");
  assert.equal(api.lgRulesSentence({ capture: "result", resultPoints: 2, exactBonus: 0 }), "Atinarle al ganador o al empate: 2 pts. Sin puntos extra por marcador exacto.");
});

test("HISTORIAL · la tabla conserva «Resultado real», muestra las reglas y deja nombre y puntos fijos", () => {
  const fn = html.slice(html.indexOf("  function renderLiguillaHistDetail(detail, round){"), html.indexOf("  // ---- admin: reglas de liguilla"));
  assert.ok(fn.includes("<strong>Resultado real</strong>"));
  assert.ok(fn.includes("Reglas de esta jornada"));
  assert.ok(fn.includes('class="qz-sticky-col lg-h-name"'));
  assert.ok(fn.includes("lgHitSummary(res)"));
});
