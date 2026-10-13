// Las listas de la meta son listas y sus objetos, objetos (metaShape.js). Un
// `matches` que no era lista llevaba su `length` al HTML de todos, y un
// `settings` que no era objeto se guardaba sin los campos que el servidor
// protege ahí.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateMetaShape } = require("../metaShape");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

const MARCADO = '<img src=x onerror="alert(1)">';
const base = () => ({
  settings: { entryFee: 100, pointsPerCorrectPick: 1 },
  paymentPenalty: { enabled: true, startsAtRound: 2, pointsPerRound: 1 },
  rounds: [{ id: "r_abc1234", number: 1, matches: [{ id: "m_abc1234", teamA: "A", teamB: "B" }], results: { m_abc1234: "A" }, customBetResults: {} }],
  participants: [{ id: "p_ana", name: "Ana", customBetAnswers: { cb_1: { guess: "x" } }, penalizedRounds: { r_abc1234: 1 } }],
  customBets: [{ id: "cb_1", label: "Campeón", points: 3 }],
  auditLog: [{ ts: "2026-01-01T00:00:00Z", action: "Publicó resultados", detail: "Jornada 1" }],
});
const RAROS = [[], [MARCADO], "x", 7, true];
const OBJ_RAROS = [{ length: MARCADO }, "x", 7, true];
const CAMPOS = {
  settings: { set: (v, x) => { v.settings = x; }, raros: RAROS },
  paymentPenalty: { set: (v, x) => { v.paymentPenalty = x; }, raros: RAROS },
  golScorerBet: { set: (v, x) => { v.golScorerBet = x; }, raros: RAROS },
  rounds: { set: (v, x) => { v.rounds = x; }, raros: OBJ_RAROS },
  customBets: { set: (v, x) => { v.customBets = x; }, raros: OBJ_RAROS },
  auditLog: { set: (v, x) => { v.auditLog = x; }, raros: OBJ_RAROS },
  "rounds.matches": { set: (v, x) => { v.rounds[0].matches = x; }, raros: [...OBJ_RAROS, null] },
  "rounds.results": { set: (v, x) => { v.rounds[0].results = x; }, raros: RAROS },
  "rounds.customBetResults": { set: (v, x) => { v.rounds[0].customBetResults = x; }, raros: RAROS },
  "rounds.draftResults": { set: (v, x) => { v.rounds[0].draftResults = x; }, raros: RAROS },
  "participants.customBetAnswers": { set: (v, x) => { v.participants[0].customBetAnswers = x; }, raros: RAROS },
  "participants.penalizedRounds": { set: (v, x) => { v.participants[0].penalizedRounds = x; }, raros: RAROS },
};

test("forma · una lista o un objeto de la meta que cambia a otra forma se rechaza, y se dice cuál", () => {
  for (const [field, { set, raros }] of Object.entries(CAMPOS)) {
    for (const raro of raros) {
      const next = base(); set(next, raro);
      assert.deepEqual(validateMetaShape(next, base()), { ok: false, reason: "invalid_value", field }, `${field} ${JSON.stringify(raro)}`);
    }
  }
  const bet = base(); bet.customBets.push(MARCADO);
  assert.deepEqual(validateMetaShape(bet, base()), { ok: false, reason: "invalid_value", field: "customBets" });
});

test("forma · lo que guarda el navegador pasa; los contenedores opcionales pueden faltar o ser null", () => {
  assert.deepEqual(validateMetaShape(base(), base()), { ok: true });
  assert.deepEqual(validateMetaShape(base(), null), { ok: true }, "una quiniela nueva");
  for (const field of ["settings", "paymentPenalty", "golScorerBet", "customBets", "auditLog", "rounds.results", "rounds.customBetResults", "rounds.draftResults", "participants.customBetAnswers", "participants.penalizedRounds"]) {
    for (const x of [null, undefined]) {
      const next = base(); CAMPOS[field].set(next, x);
      assert.deepEqual(validateMetaShape(next, base()), { ok: true }, `${field} ${x}`);
    }
  }
  const nueva = base();
  nueva.rounds.push({ id: "r_new1234", number: 2, matches: [], results: {} });
  nueva.participants.push({ id: "p_beto", name: "Beto" });
  assert.deepEqual(validateMetaShape(nueva, base()), { ok: true }, "una jornada nueva sin partidos todavía");
});

test("forma · los partidos de una jornada NUEVA siempre son lista", () => {
  for (const matches of [undefined, null, { length: MARCADO }]) {
    const next = base(); next.rounds.push({ id: "r_new1234", number: 2, matches });
    assert.deepEqual(validateMetaShape(next, base()), { ok: false, reason: "invalid_value", field: "rounds.matches" }, JSON.stringify(matches));
  }
});

test("forma · lo que YA estaba guardado con otra forma no impide guardar lo demás", () => {
  const vieja = base();
  delete vieja.rounds[0].matches;                     // una jornada antigua sin partidos
  vieja.auditLog = { legacy: true };
  vieja.participants[0].penalizedRounds = [];
  vieja.customBets.push("antigua");
  const next = JSON.parse(JSON.stringify(vieja));
  next.groupName = "Otro nombre";
  next.settings.entryFee = 150;
  assert.deepEqual(validateMetaShape(next, vieja), { ok: true });
  // ...pero un valor raro no se puede cambiar por otro raro, ni llevar a otra jornada.
  const cambia = JSON.parse(JSON.stringify(vieja));
  cambia.auditLog = { otro: MARCADO };
  assert.deepEqual(validateMetaShape(cambia, vieja), { ok: false, reason: "invalid_value", field: "auditLog" });
  const otra = JSON.parse(JSON.stringify(vieja));
  otra.rounds.push({ id: "r_new1234", number: 2 });
  assert.deepEqual(validateMetaShape(otra, vieja), { ok: false, reason: "invalid_value", field: "rounds.matches" });
});

test("forma · el servidor lo comprueba en la escritura de la meta, antes que ids y números, y responde 400", () => {
  assert.ok(serverSrc.includes('const { validateMetaShape } = require("./metaShape");'));
  const at = serverSrc.indexOf("const shapeCheck = validateMetaShape(mergedValue, oldValue);");
  assert.ok(at !== -1);
  assert.ok(serverSrc.indexOf("const roundsCheck = validateRoundsIntegrity(mergedValue, oldValue);") < at);
  assert.ok(at < serverSrc.indexOf("const idsCheck = validateMetaIds(mergedValue, oldValue);"));
  const block = serverSrc.slice(at, at + 300);
  assert.ok(block.includes('await client.query("ROLLBACK");'));
  assert.ok(block.includes("return res.status(400).json({ error: shapeCheck.reason, field: shapeCheck.field });"));
});

// ---- injectMeta: el nombre del grupo entra tal cual en <title> y og:title ----
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start !== -1, signature);
  let depth = 0, i = src.indexOf("{", start + signature.length);   // la del cuerpo, no la de los parámetros
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(start, i + 1);
}

test("injectMeta · un `$&`, `$'` o `$1` en el nombre no se interpreta como patrón de reemplazo", () => {
  const injectMeta = new Function(`${extractFunction(serverSrc, "function injectMeta(html, { title, description, url })")}; return injectMeta;`)();
  const html = '<head><title id="page-title">QRACKS</title><meta property="og:title" content="QRACKS" id="og-title"><meta property="og:description" content="d" id="og-description"><meta property="og:url" content="u" id="og-url"></head>';
  for (const title of ["Liga $& amigos", "Liga $' fin", "Liga $` inicio", "Liga $1$2", "Liga $$"]) {
    const out = injectMeta(html, { title, description: title, url: title });
    assert.ok(out.includes(`<title id="page-title">${title}</title>`), title);
    assert.ok(out.includes(`<meta property="og:title" content="${title}" id="og-title">`), title);
    assert.ok(out.includes(`<meta property="og:description" content="${title}" id="og-description">`), title);
    assert.ok(out.includes(`<meta property="og:url" content="${title}" id="og-url">`), title);
    assert.equal((out.match(/<title/g) || []).length, 1, `el <head> no se duplica: ${title}`);
  }
});
