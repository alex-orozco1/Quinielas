// betsConcurrency.test.js — MS2 · quién puede reemplazar meta.customBets
// (hallazgo P1 de Technical QA, ronda 4). Lo puro, ejecutado.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveBetsWrite, stampBetsRevision, storedBetsRevision, claimedBetsRevision } = require("../betsConcurrency");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const q = (id, label = "¿" + id + "?") => ({ id, label, scope: "jornada", points: 2 });

test("sin `customBets` en la escritura no se reemplaza nada", () => {
  assert.equal(resolveBetsWrite({ stored: { customBets: [q("a")], betsRevision: 3 }, incoming: {} }).outcome, "no_statement");
});

test("las mismas preguntas (aunque con otra revisión o en otro orden de claves) no son un cambio: un reintento es seguro", () => {
  const r = resolveBetsWrite({ stored: { customBets: [{ id: "a", points: 2, label: "x" }], betsRevision: 5 }, incoming: { customBets: [{ label: "x", id: "a", points: 2 }], betsRevision: 1 } });
  assert.deepEqual([r.outcome, r.ok], ["unchanged", true]);
});

test("cambiarlas pide haber visto las guardadas: con la revisión al día, sí; atrasada o sin decirla, 409", () => {
  const stored = { customBets: [q("a"), q("b")], betsRevision: 4 };
  assert.equal(resolveBetsWrite({ stored, incoming: { customBets: [q("a"), q("b"), q("c")], betsRevision: 4 } }).outcome, "replaced");
  assert.deepEqual(resolveBetsWrite({ stored, incoming: { customBets: [q("a"), q("c")], betsRevision: 3 } }), { storedRevision: 4, claimedRevision: 3, outcome: "conflict", ok: false });
  assert.equal(resolveBetsWrite({ stored, incoming: { customBets: [q("a")] } }).outcome, "conflict", "no decir la revisión no es haberla visto");
  assert.equal(resolveBetsWrite({ stored, incoming: { customBets: [q("a")], betsRevision: "4" } }).outcome, "conflict");
});

test("una fila anterior a este cambio (sin revisión) adopta la primera escritura", () => {
  assert.equal(resolveBetsWrite({ stored: { customBets: [q("a")] }, incoming: { customBets: [] } }).outcome, "adopted");
});

test("la revisión la pone el servidor y sólo sube cuando cambia el contenido", () => {
  assert.equal(stampBetsRevision({ customBets: [q("a")] }, { customBets: [q("a")], betsRevision: 2 }).betsRevision, 2);
  assert.equal(stampBetsRevision({ customBets: [q("a"), q("b")] }, { customBets: [q("a")], betsRevision: 2 }).betsRevision, 3);
  // Lo que traiga la petición no cuenta: el guardado de meta lo quita antes de sellar.
  const merge = serverSrc.slice(serverSrc.indexOf("function mergeProtectedMetaFields("), serverSrc.indexOf("value: stampMetaWrite(merged, oldValue),"));
  assert.ok(merge.includes("delete merged.betsRevision;"));
  assert.equal(storedBetsRevision({ betsRevision: -1 }), 0);
  assert.equal(claimedBetsRevision({}), null);
});

test("la revisión nunca baja: una foto previa sin las preguntas puede adelantarla, nunca regresarla (Technical QA: el registro la reiniciaba)", () => {
  const stored = { customBets: [q("a"), q("b")], betsRevision: 2 };
  // Lo que hacía el registro: la foto previa no traía las preguntas.
  const doc = { ...stored, participants: [1, 2] };
  assert.ok(stampBetsRevision(doc, { participants: [1] }).betsRevision >= 2);
  // Con la foto completa, no se mueve.
  assert.equal(stampBetsRevision(doc, { customBets: stored.customBets, betsRevision: 2 }).betsRevision, 2);
});

test("el registro de un participante lleva las preguntas y su revisión en la foto previa (como el tablero)", () => {
  const reg = serverSrc.slice(serverSrc.indexOf('app.post("/api/self-register"'));
  const snap = reg.slice(reg.indexOf("const beforeRegistration = {"), reg.indexOf("};", reg.indexOf("const beforeRegistration = {")));
  assert.ok(snap.includes("customBets: value.customBets,") && snap.includes("betsRevision: storedBetsRevision(value),"));
  // Toda foto previa que se le pase a stampMetaWrite: o es la meta completa, o lleva las preguntas.
  const calls = [...serverSrc.matchAll(/stampMetaWrite\(\w+, (\w+)\)/g)].map((m) => m[1]);
  for (const before of new Set(calls)) {
    if (before === "oldValue" || before === "beforeRegistration") continue;
    const decl = serverSrc.match(new RegExp("const " + before + " = ([^;\\n]+)"));
    assert.ok(decl && /JSON\.parse\(JSON\.stringify\(|getRowLocked\(/.test(decl[1]), before + " es la meta completa (copia o fila leída)");
  }
});
