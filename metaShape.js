// La forma de la meta de una quiniela: qué es una lista y qué es un objeto.
//
// El navegador recorre las listas de la meta (jornadas, sus partidos,
// apuestas, bitácora) y lee sus objetos (ajustes, penalización, resultados)
// dando por hecha esa forma, y el servidor también, al proteger los campos del
// dueño dentro de `settings`. Ningún flujo legítimo escribe otra forma.
//
// Un contenedor que cambia tiene que tener su forma, o no estar (los
// partidos de una jornada siempre son lista). Uno que ya estaba guardado y no
// cambia se respeta tal cual, como en metaNumbers.js. `participants` no se
// juzga aquí: mergeParticipants() ya conserva la lista guardada si la que
// llega no es una lista.

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SHAPES = {
  list: (v) => v === undefined || v === null || Array.isArray(v),
  object: (v) => v === undefined || v === null || isObject(v),
  requiredList: (v) => Array.isArray(v),
};
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (isObject(v) ? v : {});

function byId(items) {
  const map = new Map();
  for (const item of items) {
    if (isObject(item) && (typeof item.id === "string" || typeof item.id === "number") && !map.has(item.id)) map.set(item.id, item);
  }
  return map;
}

const TOP = { rounds: "list", customBets: "list", auditLog: "list", settings: "object", paymentPenalty: "object", golScorerBet: "object" };
const ROUND = { matches: "requiredList", results: "object", customBetResults: "object", draftResults: "object" };
const PARTICIPANT = { customBetAnswers: "object", penalizedRounds: "object" };

// Pure. `{ ok: true }`, o `{ ok: false, reason: "invalid_value", field }` con el
// primer contenedor que cambió a otra forma.
function validateMetaShape(newValue, oldValue) {
  const next = obj(newValue);
  const prev = obj(oldValue);
  const bad = (field) => ({ ok: false, reason: "invalid_value", field });
  // Sólo lo que ya estaba guardado puede seguir con su forma de antes.
  const fits = (value, shape, existed, before) => SHAPES[shape](value) || (existed && same(value, before));

  for (const [key, shape] of Object.entries(TOP)) {
    if (!fits(next[key], shape, key in prev, prev[key])) return bad(key);
  }

  const oldRounds = byId(list(prev.rounds));
  for (const round of list(next.rounds)) {
    if (!isObject(round)) continue;   // validateRoundIdentity ya lo rechaza
    const before = oldRounds.get(round.id);
    for (const [key, shape] of Object.entries(ROUND)) {
      if (!fits(round[key], shape, !!before, before && before[key])) return bad(`rounds.${key}`);
    }
  }

  const oldParticipants = byId(list(prev.participants));
  for (const p of list(next.participants)) {
    if (!isObject(p)) continue;
    const before = oldParticipants.get(p.id);
    for (const [key, shape] of Object.entries(PARTICIPANT)) {
      if (!fits(p[key], shape, !!before, before && before[key])) return bad(`participants.${key}`);
    }
  }

  const oldBets = new Set(list(prev.customBets).map((b) => JSON.stringify(b)));
  for (const bet of list(next.customBets)) {
    if (!isObject(bet) && !oldBets.has(JSON.stringify(bet))) return bad("customBets");
  }
  return { ok: true };
}

module.exports = { validateMetaShape };
