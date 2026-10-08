// Los números de la meta de una quiniela que el navegador vuelve a pintar.
//
// El número de cada jornada, los puntos y el cierre de las apuestas, la cuota,
// los puntos por acierto y la penalización por no pagar se pintan en las
// pantallas de TODOS los que entran a la quiniela (participantes, espectadores
// con el link `?ver` y el panel de plataforma). Si uno de ellos llegaba como
// texto con marcado, quien administra una quiniela metía código en el
// navegador de los demás. Ningún flujo legítimo guarda ahí otra cosa que un
// número, `null` o nada: el navegador los lee con Number() y el servidor los
// calcula.
//
// Un valor que cambia tiene que ser un número finito, `null` o no estar. Uno
// que ya estaba guardado y no cambia se respeta tal cual, para no dejar sin
// poder guardar a una quiniela con datos antiguos; el navegador, además, los
// escapa al pintarlos. El rango (jornada 0, puntos negativos...) no se juzga
// aquí: esto sólo garantiza que sean números.

const isNumberOrEmpty = (v) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));

const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const same = (a, b) => a === b || (a !== null && b !== null && typeof a === "object" && typeof b === "object"
  && JSON.stringify(a) === JSON.stringify(b));

// Lo que había guardado bajo cada id (el primero, si alguno se repite).
function byId(items) {
  const map = new Map();
  for (const item of items) {
    if (item && (typeof item.id === "string" || typeof item.id === "number") && !map.has(item.id)) map.set(item.id, item);
  }
  return map;
}

// Pure. `{ ok: true }`, o `{ ok: false, reason: "invalid_number", field }` con
// el primer campo que cambió a algo que no es un número.
function validateMetaNumbers(newValue, oldValue) {
  const next = obj(newValue);
  const prev = obj(oldValue);
  const bad = (field) => ({ ok: false, reason: "invalid_number", field });
  const check = (value, previous, field) => isNumberOrEmpty(value) || same(value, previous) ? null : bad(field);

  const oldRounds = byId(list(prev.rounds));
  for (const round of list(next.rounds)) {
    if (!round || typeof round !== "object") continue;
    const before = oldRounds.get(round.id);
    const r = check(round.number, before ? before.number : undefined, "rounds.number");
    if (r) return r;
  }

  const oldBets = byId(list(prev.customBets));
  for (const bet of list(next.customBets)) {
    if (!bet || typeof bet !== "object") continue;
    const before = oldBets.get(bet.id) || {};
    const r = check(bet.points, before.points, "customBets.points")
      || check(bet.closesAtRound, before.closesAtRound, "customBets.closesAtRound");
    if (r) return r;
  }

  const settings = obj(next.settings), oldSettings = obj(prev.settings);
  const penalty = obj(next.paymentPenalty), oldPenalty = obj(prev.paymentPenalty);
  // La apuesta de goleador de antes de las apuestas adicionales: el panel de
  // plataforma todavía suma sus puntos en las quinielas que no han migrado.
  const scorer = obj(next.golScorerBet), oldScorer = obj(prev.golScorerBet);
  return check(settings.entryFee, oldSettings.entryFee, "settings.entryFee")
    || check(settings.pointsPerCorrectPick, oldSettings.pointsPerCorrectPick, "settings.pointsPerCorrectPick")
    || check(penalty.startsAtRound, oldPenalty.startsAtRound, "paymentPenalty.startsAtRound")
    || check(penalty.pointsPerRound, oldPenalty.pointsPerRound, "paymentPenalty.pointsPerRound")
    || check(scorer.bonusPoints, oldScorer.bonusPoints, "golScorerBet.bonusPoints")
    || check(scorer.closesAtRound, oldScorer.closesAtRound, "golScorerBet.closesAtRound")
    || { ok: true };
}

module.exports = { validateMetaNumbers };
