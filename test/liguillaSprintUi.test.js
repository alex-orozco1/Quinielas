// Sprint de liguilla: la pantalla usa el MISMO módulo de puntos que el
// servidor y no toca la fase regular. Revisión estructural de public/index.html;
// el recorrido real se probó en Chromium contra el servidor y PostgreSQL local.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ui = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

test("UI · el módulo de puntos se carga antes del script de la app y lo sirve el servidor sin caché larga", () => {
  assert.ok(ui.indexOf('<script src="/liguillaScoring.js"></script>') < ui.indexOf("<script>\n"));
  assert.ok(/app\.get\("\/liguillaScoring\.js"[\s\S]{0,200}no-cache/.test(server));
});

test("UI · Tabla, flechas, Historial y Panel Plataforma suman la liguilla con LG.scoreRound; la regular sigue igual", () => {
  assert.ok(ui.includes("if(isLg(r)){ const sr = LG.scoreRound(r, picks[r.id]); pts += sr.total; played += sr.scored; return; }"));
  assert.ok(ui.includes("if(isLg(r)){ pts += LG.scoreRound(r, picks[r.id]).total; return; }"));
  assert.ok(ui.includes("if(isLg(rnd)){ pts += LG.scoreRound(rnd, picksCache[pid] && picksCache[pid][rnd.id]).total; return; }"));
  assert.ok(ui.includes("if(pick && pick === result) pts += perPick;"), "la fórmula regular no cambia");
  assert.ok(ui.includes("if(isLg(round)){\n      renderLiguillaHistDetail(detail, round);"));
});

test("UI · votar en liguilla: autoguardado por partido, sin botón global; vacío no es 0", () => {
  assert.ok(ui.includes('${lg ? `` : `<button class="btn btn-primary" data-save='));
  assert.ok(ui.includes('if(t === "") return null;'), "vacío no se lee como 0");
  assert.ok(ui.includes("if(a === null || b === null || Number.isNaN(a) || Number.isNaN(b)) return;"), "incompleto no se envía");
  assert.ok(/lgSetSt\(round\.id, matchId, \{ st: "saved", at: r\.acceptedAt \}\)/.test(ui), "«Guardado» sólo tras la respuesta del servidor");
  assert.ok(ui.includes('r.status === 409 && r.error === "pick_conflict"'), "otra sesión no se pisa");
  assert.ok(ui.includes('r.error === "round_locked"'), "cierre: aceptado frente a rechazado");
});

test("UI · publicar liguilla pasa por las reglas en un solo flujo, y las jornadas regulares no", () => {
  assert.ok(ui.includes("if(!(await lgPublishGate(round))) return;\n        if(!(await gateFirstPublish(rowEl, \"after\"))) return;"));
  assert.ok(ui.includes("if(!isLg(round)) return true;"));
});

test("UI · resultados de liguilla: cuatro estados, anular pide confirmación, publicación parcial", () => {
  for (const s of ['seg(m, "result", "Con resultado")', 'seg(m, "pending", "Pendiente")', 'seg(m, "postponed", "Aplazado")', 'seg(m, "void", "Anulado")']) assert.ok(ui.includes(s), s);
  assert.ok(ui.includes('title: "¿Anular este partido?"'));
  assert.ok(ui.includes("sin calificar"));
});
