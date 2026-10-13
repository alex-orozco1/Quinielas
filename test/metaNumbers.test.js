// Los números de la meta que se pintan para todos —número de jornada, puntos y
// cierre de las apuestas, cuota, puntos por acierto, penalización— sólo pueden
// cambiar a un número, a `null` o a nada (metaNumbers.js). Como texto, eran
// otra forma de que quien administra una quiniela metiera código en el
// navegador de sus participantes, de los espectadores y del panel de
// plataforma.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateMetaNumbers } = require("../metaNumbers");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

const MARCADO = '<img src=x onerror="alert(1)">';
const base = () => ({
  rounds: [{ id: "r_abc1234", number: 1, matches: [] }],
  customBets: [{ id: "cb_abc1234", label: "Campeón", scope: "temporada", points: 3, closesAtRound: 5 }],
  settings: { entryFee: 100, pointsPerCorrectPick: 1 },
  paymentPenalty: { enabled: true, startsAtRound: 2, pointsPerRound: 1 },
  golScorerBet: { enabled: true, bonusPoints: 3, closesAtRound: 4 },
});
const CAMPOS = {
  "rounds.number": (v, x) => { v.rounds[0].number = x; },
  "customBets.points": (v, x) => { v.customBets[0].points = x; },
  "customBets.closesAtRound": (v, x) => { v.customBets[0].closesAtRound = x; },
  "settings.entryFee": (v, x) => { v.settings.entryFee = x; },
  "settings.pointsPerCorrectPick": (v, x) => { v.settings.pointsPerCorrectPick = x; },
  "paymentPenalty.startsAtRound": (v, x) => { v.paymentPenalty.startsAtRound = x; },
  "paymentPenalty.pointsPerRound": (v, x) => { v.paymentPenalty.pointsPerRound = x; },
  "golScorerBet.bonusPoints": (v, x) => { v.golScorerBet.bonusPoints = x; },
  "golScorerBet.closesAtRound": (v, x) => { v.golScorerBet.closesAtRound = x; },
};

test("números · un campo que cambia a texto, lista, objeto o booleano se rechaza, y se dice cuál", () => {
  for (const [field, set] of Object.entries(CAMPOS)) {
    for (const raro of [MARCADO, "5", [MARCADO], { x: 1 }, true]) {
      const next = base(); set(next, raro);
      assert.deepEqual(validateMetaNumbers(next, base()), { ok: false, reason: "invalid_number", field }, `${field} ${JSON.stringify(raro)}`);
    }
  }
});

test("números · lo que guarda el navegador pasa: números (enteros, decimales, negativos, 0), null o nada", () => {
  for (const [field, set] of Object.entries(CAMPOS)) {
    for (const ok of [0, 7, 2.5, -1, null, undefined]) {
      const next = base(); set(next, ok);
      assert.deepEqual(validateMetaNumbers(next, base()), { ok: true }, `${field} ${ok}`);
    }
  }
  assert.deepEqual(validateMetaNumbers(base(), base()), { ok: true });
  assert.deepEqual(validateMetaNumbers(base(), null), { ok: true }, "una quiniela nueva");
  assert.deepEqual(validateMetaNumbers({ rounds: "x", settings: null, customBets: [null] }, {}), { ok: true }, "la forma no se juzga aquí");
});

test("números · una jornada o una apuesta NUEVA también: su id no estaba guardado", () => {
  const ronda = base(); ronda.rounds.push({ id: "r_new1234", number: MARCADO, matches: [] });
  assert.deepEqual(validateMetaNumbers(ronda, base()), { ok: false, reason: "invalid_number", field: "rounds.number" });
  const apuesta = base(); apuesta.customBets.push({ id: "cb_new1234", label: "X", points: MARCADO });
  assert.deepEqual(validateMetaNumbers(apuesta, base()), { ok: false, reason: "invalid_number", field: "customBets.points" });
  const sinId = base(); sinId.rounds.push({ number: MARCADO, matches: [] });
  assert.equal(validateMetaNumbers(sinId, base()).ok, false);
});

test("números · un valor raro que YA estaba guardado no impide guardar lo demás", () => {
  const vieja = base();
  for (const set of Object.values(CAMPOS)) set(vieja, "5 ");
  const next = JSON.parse(JSON.stringify(vieja));
  next.groupName = "Otro nombre";
  next.rounds[0].matches.push({ id: "m_abc1234", teamA: "A", teamB: "B" });
  next.customBets[0].label = "Campeón de liga";
  assert.deepEqual(validateMetaNumbers(next, vieja), { ok: true });
  // ...pero no se puede llevar a otra jornada ni cambiar por otro texto.
  const otra = JSON.parse(JSON.stringify(vieja));
  otra.rounds.push({ id: "r_new1234", number: "5 ", matches: [] });
  assert.equal(validateMetaNumbers(otra, vieja).ok, false);
  const cambia = JSON.parse(JSON.stringify(vieja));
  cambia.settings.entryFee = MARCADO;
  assert.deepEqual(validateMetaNumbers(cambia, vieja), { ok: false, reason: "invalid_number", field: "settings.entryFee" });
});

test("números · el servidor lo comprueba en la escritura de la meta, después de los ids, y responde 400", () => {
  assert.ok(serverSrc.includes('const { validateMetaNumbers } = require("./metaNumbers");'));
  const at = serverSrc.indexOf("const numbersCheck = validateMetaNumbers(mergedValue, oldValue);");
  assert.ok(at !== -1);
  assert.ok(serverSrc.indexOf("const idsCheck = validateMetaIds(mergedValue, oldValue);") < at);
  const block = serverSrc.slice(at, at + 300);
  assert.ok(block.includes('await client.query("ROLLBACK");'));
  assert.ok(block.includes("return res.status(400).json({ error: numbersCheck.reason, field: numbersCheck.field });"));
});

test("números · la migración de la apuesta de goleador guarda números, aunque el campo viejo no lo fuera", () => {
  const start = indexSrc.indexOf("function ensureCustomBets(){");
  assert.ok(start !== -1);
  let depth = 0, i = indexSrc.indexOf("{", start);
  for (; i < indexSrc.length; i++) { if (indexSrc[i] === "{") depth++; else if (indexSrc[i] === "}" && --depth === 0) break; }
  const ensureCustomBets = (meta) => new Function("meta", "uid", `${indexSrc.slice(start, i + 1)}; return ensureCustomBets();`)(meta, (p) => p + "_abc1234");
  const migrar = (golScorerBet) => {
    const meta = { golScorerBet, participants: [] };
    ensureCustomBets(meta);
    const { points, closesAtRound } = meta.customBets[0];
    return { points, closesAtRound };
  };
  assert.deepEqual(migrar({ enabled: true, bonusPoints: 5, closesAtRound: 3 }), { points: 5, closesAtRound: 3 });
  assert.deepEqual(migrar({ enabled: true, bonusPoints: 0 }), { points: 0, closesAtRound: null });
  assert.deepEqual(migrar({ enabled: true }), { points: 3, closesAtRound: null });
  assert.deepEqual(migrar({ enabled: true, bonusPoints: "4", closesAtRound: "2" }), { points: 4, closesAtRound: 2 });
  assert.deepEqual(migrar({ enabled: true, bonusPoints: MARCADO, closesAtRound: MARCADO }), { points: 3, closesAtRound: null });
  const nuevo = base(); nuevo.customBets.push({ id: "cb_new1234", label: "Goleador", ...migrar({ enabled: true, bonusPoints: "x" }) });
  assert.deepEqual(validateMetaNumbers(nuevo, base()), { ok: true }, "lo que migra lo acepta el servidor");
});
