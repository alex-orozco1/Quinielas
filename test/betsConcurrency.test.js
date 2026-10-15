// betsConcurrency.test.js — MS2 · quién puede reemplazar meta.customBets
// (hallazgo P1 de Technical QA, ronda 4). Lo puro, ejecutado.
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveBetsWrite, stampBetsRevision, storedBetsRevision, claimedBetsRevision } = require("../betsConcurrency");

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
  assert.equal(stampBetsRevision({ customBets: [], betsRevision: 99 }, { customBets: [q("a")] }).betsRevision, 1, "lo que traiga la petición no cuenta");
  assert.equal(storedBetsRevision({ betsRevision: -1 }), 0);
  assert.equal(claimedBetsRevision({}), null);
});
