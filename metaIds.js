// La forma de los ids que el navegador escribe en la meta de una quiniela.
//
// Las jornadas, sus partidos, los participantes que agrega un admin y las
// apuestas adicionales llevan ids que crea el navegador, y esos ids vuelven a
// pintarse dentro de atributos HTML en las pantallas de TODOS los que entran a
// la quiniela. Un id con comillas o etiquetas era, por tanto, una forma de que
// quien administra una quiniela metiera código en el navegador de sus
// participantes. Ningún flujo legítimo crea ids así: el navegador usa
// `prefijo_base36` y el servidor `prefijo_hex`.
//
// Un id de texto NUEVO (que no estaba ya en la meta guardada) tiene que tener
// la forma de siempre. Uno que ya existía se respeta tal cual, para no dejar
// sin poder guardar a una quiniela con datos antiguos; el navegador, además,
// escapa todos al pintarlos.

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

const KINDS = {
  round: (meta) => (Array.isArray(meta.rounds) ? meta.rounds : []).map((r) => r && r.id),
  match: (meta) => (Array.isArray(meta.rounds) ? meta.rounds : [])
    .flatMap((r) => (r && Array.isArray(r.matches) ? r.matches : []).map((m) => m && m.id)),
  participant: (meta) => (Array.isArray(meta.participants) ? meta.participants : []).map((p) => p && p.id),
  bet: (meta) => (Array.isArray(meta.customBets) ? meta.customBets : []).map((b) => b && b.id),
};

// Un nombre de Object.prototype (`__proto__`, `constructor`, `toString`...)
// tampoco: como clave de un objeto no se comporta como las demás.
const isReserved = (id) => typeof id === "string" && id in Object.prototype;

// Pure. `{ ok: true }`, o `{ ok: false, reason: "invalid_id", kind }` con el
// primer id que no tiene la forma. Uno ausente (o vacío) no se juzga aquí: de
// eso se ocupan las otras validaciones, y no puede llevar marcado.
// - Un id nuevo es texto con la forma de siempre. Uno numérico no: las claves
//   de los picks y de los resultados son texto, y un número no las encuentra.
// - Uno que ya estaba guardado (texto o número finito) se respeta.
// - Una lista, un objeto, un booleano o un nombre reservado nunca los crea un
//   flujo legítimo y no se respetan aunque ya estuvieran guardados.
function validateMetaIds(newValue, oldValue) {
  const next = newValue && typeof newValue === "object" ? newValue : {};
  const prev = oldValue && typeof oldValue === "object" ? oldValue : {};
  for (const [kind, ids] of Object.entries(KINDS)) {
    const known = new Set(ids(prev).filter((id) => (typeof id === "string" && !isReserved(id)) || (typeof id === "number" && Number.isFinite(id))));
    for (const id of ids(next)) {
      if (id === undefined || id === null || id === "") continue;
      if (isReserved(id)) return { ok: false, reason: "invalid_id", kind };
      if (known.has(id)) continue;
      if (typeof id === "string" && ID_SHAPE.test(id)) continue;
      return { ok: false, reason: "invalid_id", kind };
    }
  }
  return { ok: true };
}

module.exports = { ID_SHAPE, validateMetaIds };
