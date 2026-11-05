// UX-INFRA-001 · H-WAKE · Registro de los recursos que CREA esta ejecución del piloto.
//
// El apagado actúa sólo sobre lo que está aquí. Un recurso que ya existía nunca se
// registra, así que nunca se modifica ni se borra. Archivo: pilot/measure/out/recursos.json
// (fuera de git; sin secretos).
//
// Estados: «creando» (se registró justo antes de la llamada que lo crea), «creado»,
// «no-creado» (la creación falló de forma concluyente), «incierto» (la llamada falló
// sin respuesta concluyente: hay que comprobar antes de actuar), «borrado».
//
//   node pilot/measure/recursos.mjs listar
//   node pilot/measure/recursos.mjs anotar <tipo> <id> [nota]   p. ej. render-service srv-… / git-branch ux-infra/piloto-hwake

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const KINDS = Object.freeze(["cloudflare-worker", "render-service", "git-branch"]);

export function createRegistry({ outDir = path.join(here, "out"), now = () => new Date().toISOString() } = {}) {
  const file = path.join(outDir, "recursos.json");
  const read = () => {
    if (!fs.existsSync(file)) return { run: null, resources: [] };
    const j = JSON.parse(fs.readFileSync(file, "utf8"));   // si está corrupto, falla: no se adivina
    if (!j || !Array.isArray(j.resources)) throw new Error("recursos.json no es válido");
    return j;
  };
  const write = (j) => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(j, null, 2)); };
  return {
    file,
    list: () => read().resources,
    find: (kind, id, scope) => read().resources.find((r) => r.kind === kind && r.id === id && (scope === undefined || r.scope === scope)) || null,
    add(kind, id, { scope = null, state = "creado", note = null } = {}) {
      if (!KINDS.includes(kind)) throw new Error(`tipo desconocido: ${kind}`);
      const j = read(); if (!j.run) j.run = crypto.randomBytes(4).toString("hex");
      if (j.resources.some((r) => r.kind === kind && r.id === id && r.scope === scope && r.state !== "borrado" && r.state !== "no-creado")) throw new Error(`ya registrado: ${kind} ${id}`);
      const r = { kind, id, scope, state, note, run: j.run, registeredAt: now(), history: [{ state, at: now() }] };
      j.resources.push(r); write(j); return r;
    },
    setState(kind, id, scope, state, extra = {}) {
      const j = read(); const r = [...j.resources].reverse().find((x) => x.kind === kind && x.id === id && x.scope === scope);
      if (!r) throw new Error(`no registrado: ${kind} ${id}`);
      r.state = state; Object.assign(r, extra); r.history.push({ state, at: now() }); write(j); return r;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, kind, id, ...note] = process.argv.slice(2);
  const reg = createRegistry();
  try {
    if (cmd === "listar") console.log(JSON.stringify(reg.list(), null, 2));
    else if (cmd === "anotar" && kind && id) console.log(JSON.stringify(reg.add(kind, id, { note: note.join(" ") || null }), null, 2));
    else { console.error("Uso: node pilot/measure/recursos.mjs listar | anotar <tipo> <id> [nota]"); process.exit(2); }
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}
