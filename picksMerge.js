// picksMerge.js — AUD-01 · un pronóstico confirmado no se pierde.
//
// EL FALLO
// --------
// Los pronósticos de las jornadas normales se guardaban como un documento
// entero que el servidor escribía tal cual. Tres maneras de perder lo que ya
// decía «Guardado»:
//   1. Un envío viejo que llega después de uno nuevo (la red no ordena) lo pisa.
//   2. Dos pestañas: cada una manda su documento y la última borra las
//      elecciones de la otra.
//   3. Una lectura inicial fallida se trataba como «no hay nada»: el siguiente
//      guardado mandaba un documento sin lo anterior y lo borraba.
//
// LA REGLA
// --------
// El navegador manda, junto con su documento (`incoming`), lo último que el
// servidor le confirmó (`base`). El servidor compara cada campo (cada partido,
// y cada respuesta de pregunta de jornada en __extra) con lo guardado, leído
// bajo lock (`stored`):
//   - el navegador no lo cambió respecto de su base  -> se conserva lo guardado;
//   - lo cambió y lo guardado sigue como en su base  -> se aplica el cambio;
//   - lo cambió y lo guardado ya es eso mismo         -> nada que hacer;
//   - lo cambió y alguien más también, distinto       -> CONFLICTO.
// Con un conflicto no se escribe nada: 409 con lo guardado, para que la
// pantalla lo muestre y la persona decida. Nunca una pérdida en silencio.
//
// Sin `base` (una pestaña abierta antes de esta regla) lo que trae se aplica
// campo por campo y lo que no trae se conserva: nunca borra, y esa pestaña
// sigue pudiendo guardar. Un documento vacío nunca es una instrucción de borrar.
//
// Las jornadas de liguilla se guardan partido a partido en su propio endpoint
// (liguillaRules.applyMatchPick); aquí sus campos de partido siguen la misma
// regla y luego validateLiguillaPicksWrite rechaza cualquier cambio a ellos,
// como antes.

const { canonical } = require("./roundsConcurrency");

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => canonical(a === undefined ? null : a) === canonical(b === undefined ? null : b);
const own = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
// Un campo ausente y uno vacío son lo mismo: ninguno dice nada.
const val = (o, k) => (own(o, k) ? o[k] : undefined);
const SAFE_KEY = (k) => typeof k === "string" && k !== "__proto__" && k !== "constructor" && k !== "prototype";

// Los campos de UNA jornada: cada partido, y cada pregunta bajo __extra.
function fieldsOf(roundDoc) {
  const out = new Map();
  if (!isObj(roundDoc)) return out;
  Object.keys(roundDoc).forEach((k) => {
    if (!SAFE_KEY(k)) return;
    if (k === "__extra") {
      // Sólo un objeto dice algo de las preguntas; cualquier otra cosa se
      // ignora (no puede reemplazar todas las respuestas de golpe).
      if (isObj(roundDoc.__extra)) Object.keys(roundDoc.__extra).forEach((b) => { if (SAFE_KEY(b)) out.set("__extra." + b, roundDoc.__extra[b]); });
    } else if (!k.startsWith("__extra.")) {
      out.set(k, roundDoc[k]);
    }
  });
  return out;
}
function setField(roundDoc, field, value) {
  if (field.startsWith("__extra.")) {
    const b = field.slice(8);
    if (value === undefined) { if (isObj(roundDoc.__extra)) { delete roundDoc.__extra[b]; if (!Object.keys(roundDoc.__extra).length) delete roundDoc.__extra; } return; }
    if (!isObj(roundDoc.__extra)) roundDoc.__extra = {};
    roundDoc.__extra[b] = value;
    return;
  }
  if (value === undefined) delete roundDoc[field]; else roundDoc[field] = value;
}

/**
 * `base` undefined = un cliente anterior a esta regla (una pestaña abierta
 * antes del despliegue): cada campo que trae distinto de lo guardado se
 * aplica, y lo que no trae se conserva — nunca borra. Así esa pestaña sigue
 * pudiendo guardar (antes de la regla, su documento entero pisaba todo).
 * @returns {{ ok: true, value: object, changed: boolean } |
 *           { ok: false, conflicts: Array<{roundId, field}> }}
 */
function mergePicksWrite({ stored, incoming, base }) {
  const legacy = base === undefined;
  const s = isObj(stored) ? stored : {};
  const b = isObj(base) ? base : {};
  // Un __extra que no es un objeto no dice nada de las preguntas: se toma
  // como si trajera exactamente lo que el navegador dice haber visto.
  const i = isObj(incoming) ? { ...incoming } : {};
  Object.keys(i).forEach((rid) => {
    if (!isObj(i[rid]) || !own(i[rid], "__extra") || isObj(i[rid].__extra)) return;
    const copy = { ...i[rid] };
    const seen = isObj(val(b, rid)) && isObj(b[rid].__extra) ? b[rid].__extra : (legacy && isObj(val(s, rid)) && isObj(s[rid].__extra) ? s[rid].__extra : undefined);
    if (seen) copy.__extra = { ...seen }; else delete copy.__extra;
    i[rid] = copy;
  });
  const result = JSON.parse(JSON.stringify(s));
  const conflicts = [];
  let changed = false;
  const roundIds = new Set([...Object.keys(s), ...Object.keys(i), ...Object.keys(b)].filter(SAFE_KEY));
  for (const rid of roundIds) {
    const sf = fieldsOf(val(s, rid)), inf = fieldsOf(val(i, rid)), bf = fieldsOf(val(b, rid));
    const fields = new Set([...sf.keys(), ...inf.keys(), ...bf.keys()]);
    for (const f of fields) {
      const sv = sf.get(f), iv = inf.get(f), bv = bf.get(f);
      if (legacy) {
        if (iv === undefined || iv === null || same(sv, iv)) continue;
        if (!isObj(result[rid])) result[rid] = {};
        setField(result[rid], f, iv);
        changed = true;
        continue;
      }
      if (same(iv, bv)) continue;              // el navegador no lo tocó: queda lo guardado
      if (same(sv, iv)) continue;              // ya está así
      if (!same(sv, bv)) { conflicts.push({ roundId: rid, field: f }); continue; }
      // Cambio del navegador sobre lo que él vio: se aplica.
      if (!isObj(result[rid])) result[rid] = {};
      setField(result[rid], f, iv === null ? undefined : iv);
      changed = true;
    }
    if (isObj(result[rid]) && !Object.keys(result[rid]).length) { delete result[rid]; changed = changed || own(s, rid); }
  }
  if (conflicts.length) return { ok: false, conflicts };
  return { ok: true, value: changed ? result : s, changed };
}

module.exports = { mergePicksWrite, fieldsOf };
