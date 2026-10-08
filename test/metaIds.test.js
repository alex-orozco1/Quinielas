// Los ids de jornadas, partidos, participantes y apuestas que escribe el
// navegador vuelven a pintarse en atributos HTML para todos los que entran a
// la quiniela. El servidor exige la forma de siempre a los ids NUEVOS
// (metaIds.js) y el navegador los escapa al pintarlos (htmlEscaping.test.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ID_SHAPE, validateMetaIds } = require("../metaIds");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const MARCADO = 'm_1"><img src=x onerror=alert(1)>';
const base = () => ({
  rounds: [{ id: "r_abc1234", matches: [{ id: "m_abc1234", teamA: "León", teamB: "Santos" }] }],
  participants: [{ id: "p_0123456789abcdef01", name: "Ana" }],
  customBets: [{ id: "cb_abc1234", label: "Campeón" }],
});

test("ids · los que crean el navegador y el servidor tienen la forma", () => {
  for (const id of ["r_k3j2h1g", "m_abc1234", "p_0123456789abcdef01", "cb_x9y8z7w", "m_1a2b3c4d5e", "r_prep", "p1"]) {
    assert.ok(ID_SHAPE.test(id), id);
  }
  for (const id of [MARCADO, 'm "x"', "m<1>", "m:1", "", "x".repeat(65)]) {
    assert.ok(!ID_SHAPE.test(id), id);
  }
});

test("ids · un id NUEVO con marcado se rechaza, en jornadas, partidos, participantes y apuestas", () => {
  const casos = {
    round: (v) => v.rounds.push({ id: MARCADO, matches: [] }),
    match: (v) => v.rounds[0].matches.push({ id: MARCADO, teamA: "A", teamB: "B" }),
    participant: (v) => v.participants.push({ id: MARCADO, name: "Beto" }),
    bet: (v) => v.customBets.push({ id: MARCADO, label: "X" }),
  };
  for (const [kind, add] of Object.entries(casos)) {
    const next = base(); add(next);
    assert.deepEqual(validateMetaIds(next, base()), { ok: false, reason: "invalid_id", kind }, kind);
  }
});

test("ids · lo de siempre pasa: ids nuevos bien formados, y nada nuevo", () => {
  const next = base();
  next.rounds.push({ id: "r_new1234", matches: [{ id: "m_new1234", teamA: "A", teamB: "B" }] });
  next.participants.push({ id: "p_new1234", name: "Beto" });
  next.customBets.push({ id: "cb_new1234", label: "Goleador" });
  assert.deepEqual(validateMetaIds(next, base()), { ok: true });
  assert.deepEqual(validateMetaIds(base(), base()), { ok: true });
  assert.deepEqual(validateMetaIds(base(), null), { ok: true }, "una quiniela nueva");
});

test("ids · un id que YA estaba en la meta guardada se respeta (datos antiguos siguen pudiendo guardarse)", () => {
  const vieja = base(); vieja.rounds[0].matches.push({ id: "m:legacy 1", teamA: "A", teamB: "B" });
  const next = JSON.parse(JSON.stringify(vieja));
  next.rounds[0].matches[0].teamB = "Santos Laguna";       // un cambio cualquiera
  assert.deepEqual(validateMetaIds(next, vieja), { ok: true });
  // ...pero no se puede mover a otra parte como si fuera de otra clase.
  const otro = JSON.parse(JSON.stringify(vieja));
  otro.participants.push({ id: "m:legacy 1", name: "X" });
  assert.equal(validateMetaIds(otro, vieja).ok, false);
});

test("ids · un id ausente o numérico no puede llevar marcado: no se juzga aquí", () => {
  const next = base();
  next.rounds[0].matches.push({ teamA: "A", teamB: "B" });
  next.participants.push({ id: 7, name: "Num" });
  next.customBets.push({ id: "", label: "Vacío" });
  assert.deepEqual(validateMetaIds(next, base()), { ok: true });
  assert.deepEqual(validateMetaIds({ rounds: "x", participants: null }, {}), { ok: true });
});

test("ids · un id que no es texto ni número (lista, objeto, booleano) se rechaza, aunque ya estuviera guardado", () => {
  // Antes se saltaba la validación: `[marcado]` entraba y dejaba al esc() del
  // navegador como única defensa (y una jornada así rompía las vistas).
  const raros = [[MARCADO], { x: MARCADO }, true];
  const en = {
    round: (v, id) => v.rounds.push({ id, matches: [] }),
    match: (v, id) => v.rounds[0].matches.push({ id, teamA: "A", teamB: "B" }),
    participant: (v, id) => v.participants.push({ id, name: "Beto" }),
    bet: (v, id) => v.customBets.push({ id, label: "X" }),
  };
  for (const [kind, add] of Object.entries(en)) {
    for (const id of raros) {
      const next = base(); add(next, id);
      assert.deepEqual(validateMetaIds(next, base()), { ok: false, reason: "invalid_id", kind }, `${kind} ${JSON.stringify(id)}`);
      // Ni siquiera si la fila guardada ya lo tenía: ningún flujo los crea.
      const vieja = base(); add(vieja, id);
      assert.deepEqual(validateMetaIds(JSON.parse(JSON.stringify(vieja)), vieja), { ok: false, reason: "invalid_id", kind }, `${kind} guardado`);
    }
  }
});

test("ids · el servidor lo comprueba en la escritura de la meta, después de validateRoundsIntegrity, y responde 400", () => {
  assert.ok(serverSrc.includes('const { validateMetaIds } = require("./metaIds");'));
  const at = serverSrc.indexOf("const idsCheck = validateMetaIds(mergedValue, oldValue);");
  assert.ok(at !== -1);
  assert.ok(serverSrc.indexOf("const roundsCheck = validateRoundsIntegrity(mergedValue, oldValue);") < at);
  const block = serverSrc.slice(at, at + 300);
  assert.ok(block.includes('await client.query("ROLLBACK");'));
  assert.ok(block.includes("return res.status(400).json({ error: idsCheck.reason, kind: idsCheck.kind });"));
});
