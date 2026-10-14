// El cierre de las preguntas de torneo («una vez por torneo»).
//
// Una pregunta de torneo se contesta una sola vez y la respuesta se puede
// cambiar hasta el cierre de la jornada a la que está ligada (`closesAtRound`,
// el número de esa jornada): /api/submit-bet-answer la rechaza con
// `bet_locked` después. Una pregunta sin esa jornada, o ligada a un número que
// no existe, no cierra nunca: los participantes podrían cambiar su respuesta
// cuando ya se sabe quién acertó.
//
// Por eso una pregunta de torneo NUEVA, o una a la que se le cambia el cierre
// (o que pasa a ser de torneo), tiene que quedar ligada a una jornada que
// exista en este mismo guardado y que todavía no haya cerrado. Las que ya
// estaban guardadas y no cambian de cierre se respetan tal cual: hay quinielas
// con preguntas antiguas sin cierre o ligadas a una jornada que aún no se crea,
// y no se tocan ni dejan de poder guardarse.

const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// Lo que había guardado bajo cada id (el primero, si alguno se repite).
function byId(items) {
  const map = new Map();
  for (const item of items) {
    if (item && (typeof item.id === "string" || typeof item.id === "number") && !map.has(item.id)) map.set(item.id, item);
  }
  return map;
}

// Pure. `{ ok: true }`, o `{ ok: false, reason, betId }` con la primera pregunta
// de torneo cuyo cierre no se puede aceptar:
//   - `bet_close_required`: sin jornada de cierre, o con un número de jornada
//     que no existe;
//   - `bet_close_past`: la jornada de cierre ya cerró (o no tiene una fecha
//     válida), así que la pregunta nacería cerrada.
function validateBetClosures(newValue, oldValue, nowMs) {
  const next = obj(newValue);
  const prev = obj(oldValue);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const oldBets = byId(list(prev.customBets));
  const rounds = list(next.rounds);
  for (const bet of list(next.customBets)) {
    if (!bet || typeof bet !== "object" || bet.scope !== "temporada") continue;
    const before = oldBets.get(bet.id);
    if (before && before.scope === "temporada" && before.closesAtRound === bet.closesAtRound) continue;
    const n = bet.closesAtRound;
    const round = Number.isInteger(n) && n >= 1 ? rounds.find((r) => r && r.number === n) : null;
    if (!round) return { ok: false, reason: "bet_close_required", betId: bet.id };
    const closesMs = new Date(round.deadline).getTime();
    if (!Number.isFinite(closesMs) || closesMs <= now) return { ok: false, reason: "bet_close_past", betId: bet.id };
  }
  return { ok: true };
}

module.exports = { validateBetClosures };
