// Un 409 (rounds_conflict) nunca debe acabar pisando lo que otro admin cambió.
//
// HOTFIX-001 hizo que, ante un 409, la pestaña trajera el estado del servidor
// (adoptFreshMeta) y lo repintara. Pero cada pantalla, en su rama de fallo,
// volvía a poner la copia que tenía ANTES de guardar: la jornada editada, el
// arreglo entero de jornadas al eliminar, la lista de participantes... Esa
// copia es más vieja que la del servidor, y como la pestaña ya tenía la
// revisión nueva, el siguiente guardado se aceptaba y la escribía encima del
// cambio del otro admin. Reproducido en main (4e5cbec) en el navegador.
//
// Ahora setMetaWithError dice `reconciled: true` sólo cuando de verdad adoptó
// el estado del servidor, y ninguna rama de fallo repone su copia en ese caso.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}"`);
  const braceStart = source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

// ---- setMetaWithError, ejecutado tal cual con un servidor de mentira ----
function saver({ save, fresh }) {
  const calls = { render: 0, notice: [] };
  const fn = new Function("kvSetWithError", "getMeta", "render", "notice", "invalidatePlan", "adoptParticipantRevs", "toast",
    "adminOrOwnerCred", "currentMetaKey", "platformPasswordCache", `
    ${extractFunctionBody(indexSrc, "function adoptFreshMeta(target, fresh)")}
    ${extractFunctionBody(indexSrc, "async function setMetaWithError(meta, opts)")}
    return setMetaWithError;`)(
    async () => save,
    async () => { if (fresh instanceof Error) throw fresh; return fresh; },
    async () => { calls.render++; },
    (t) => calls.notice.push(t),
    () => {}, () => {}, () => {},
    () => "pw", () => "quiniela:x:meta", null);
  return { setMetaWithError: fn, calls };
}

test("409 · reconciled sólo cuando la pestaña ADOPTÓ el estado del servidor", async () => {
  const meta = { rounds: [{ id: "r_1", matches: [{ id: "m_1", teamA: "León", teamB: "Santos" }] }], participants: [] };
  const fresh = { rounds: [{ id: "r_1", matches: [{ id: "m_1", teamA: "León", teamB: "OTRO-ADMIN" }] }], participants: [], roundsRevision: 7 };
  const { setMetaWithError, calls } = saver({ save: { ok: false, error: "rounds_conflict" }, fresh });
  const r = await setMetaWithError(meta);
  assert.equal(r.reconciled, true);
  assert.equal(meta.rounds[0].matches[0].teamB, "OTRO-ADMIN", "la pestaña tiene ahora lo del servidor");
  assert.equal(meta.roundsRevision, 7);
  assert.equal(calls.render, 1);
  assert.equal(calls.notice.length, 1);
});

test("409 · si el estado del servidor no se pudo traer, NO es reconciled: la pestaña sigue con lo suyo", async () => {
  for (const fresh of [null, new Error("offline")]) {
    const meta = { rounds: [{ id: "r_1", matches: [] }], participants: [] };
    const { setMetaWithError } = saver({ save: { ok: false, error: "rounds_conflict" }, fresh });
    const r = await setMetaWithError(meta);
    assert.equal(r.reconciled, false, String(fresh));
    assert.equal(r.error, "rounds_conflict");
  }
});

test("409 · cualquier otro fallo no es reconciled", async () => {
  const { setMetaWithError } = saver({ save: { ok: false, error: "plan_lifecycle_limit_reached" }, fresh: {} });
  const r = await setMetaWithError({ rounds: [], participants: [] });
  assert.ok(!r.reconciled);
});

// ---- ninguna rama de fallo repone su copia después de un 409 ----
// Toda línea que devuelve a la meta (o a un objeto vivo) lo que había antes de
// guardar tiene que estar bajo `if(!result.reconciled)`, en la misma línea o
// dentro de ese bloque.
const ROLLBACKS = [
  /meta\.rounds = snapshot;/,
  /meta\.rounds = meta\.rounds\.map\(r => r\.id === [\w.]+ \? \w*[sS]napshot : r\);/,
  /meta\.participants = (snapshot|participantsSnapshot);/,
  /meta\.participants = meta\.participants\.filter\(p => !added/,
  /\bp\.(name|isAdmin|pin|hasPin) = previous\w+;/,
  /\bpenalty\.\w+ = previous\w+;/,
  /\bround\.(published = false|resultsPublished = (previousResultsPublished|wasAlreadyPublished)|results = previousResults|deadline = previousDeadline)/,
];
function rollbackLines() {
  const lines = indexSrc.split("\n");
  const found = [];
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    if (ROLLBACKS.some((re) => re.test(line))) found.push(i);
  });
  return { lines, found };
}
const GUARD = "if(!result.reconciled)";
const isRollback = (text) => ROLLBACKS.some((re) => re.test(text));
// Protegida quiere decir que la reposición ES lo que la guarda condiciona:
//   - en la misma línea, como la sentencia de `if(!result.reconciled) …;` o
//     dentro de su `{ … }`;
//   - o dentro de un bloque abierto por una línea que es exactamente
//     `if(!result.reconciled){`, todavía abierto y sin un `else` en medio.
// Un comentario que mencione la guarda no cuenta.
function guarded(lines, i) {
  const line = lines[i];
  const at = line.indexOf(GUARD);
  if (at !== -1 && !/^\s*\/\//.test(line)) {
    const rest = line.slice(at + GUARD.length).trimStart();
    const scope = rest.startsWith("{") ? rest.slice(0, rest.indexOf("}") === -1 ? rest.length : rest.indexOf("}")) : rest.slice(0, rest.indexOf(";") + 1);
    return isRollback(scope);
  }
  for (let g = i - 1; g >= Math.max(0, i - 8); g--) {
    if (/^\s*\/\//.test(lines[g])) continue;
    if (lines[g].trim() === GUARD + "{") {
      let depth = 0;
      for (let k = g; k < i; k++) {
        if (k > g && /\belse\b/.test(lines[k])) return false;
        for (const ch of lines[k]) { if (ch === "{") depth++; else if (ch === "}") depth--; }
      }
      return depth > 0;
    }
  }
  return false;
}

test("409 · toda reposición de lo anterior está condicionada a que NO se haya adoptado el servidor", () => {
  const { lines, found } = rollbackLines();
  assert.ok(found.length >= 20, `el escáner tiene que encontrar las reposiciones (encontró ${found.length})`);
  const sinGuarda = found.filter((i) => !guarded(lines, i)).map((i) => `${i + 1}: ${lines[i].trim()}`);
  assert.deepEqual(sinGuarda, []);
});

test("409 · el escáner sí detecta una reposición sin condición", () => {
  // Vigila al vigilante: una línea sin guarda tiene que salir.
  const lines = ["    }else{", "      meta.rounds = snapshot;", "    }"];
  assert.equal(guarded(lines, 1), false);
  const ok = ["    }else{", "      if(!result.reconciled){", "        meta.rounds = snapshot;", "      }"];
  assert.equal(guarded(ok, 2), true);
  const cerrado = ["      if(!result.reconciled){ meta.participants = snapshot; }", "      meta.rounds = snapshot;"];
  assert.equal(guarded(cerrado, 1), false, "un bloque ya cerrado no protege la línea siguiente");
  // Los tres engaños que encontró Technical QA:
  const enElse = ["      if(!result.reconciled){", "        toast('x');", "      } else {", "        meta.rounds = snapshot;", "      }"];
  assert.equal(guarded(enElse, 3), false, "la rama else se ejecuta justo cuando no debe");
  assert.equal(guarded(["      if(!result.reconciled) toast('x'); meta.rounds = snapshot;"], 0), false, "otra sentencia en la misma línea");
  assert.equal(guarded(["      // if(!result.reconciled){", "      meta.rounds = snapshot;"], 1), false, "un comentario no protege");
  assert.equal(guarded(["      if(!result.reconciled) meta.rounds = snapshot;"], 0), true);
  assert.equal(guarded(["      if(!result.reconciled){ meta.rounds = snapshot; meta.participants = snapshot; }"], 0), true);
});

test("409 · adoptar el estado del servidor deja en la pestaña exactamente lo que el servidor tiene", () => {
  const adopt = new Function(`${extractFunctionBody(indexSrc, "function adoptFreshMeta(target, fresh)")}; return adoptFreshMeta;`)();
  const ana = { id: "p_ana", name: "Ana", tmp: 1 };
  const meta = {
    rounds: [{ id: "r_1" }], participants: [ana],
    paymentPenalty: { enabled: true, startsAtRound: 1, pointsPerRound: 3 },   // activada aquí, el guardado dio 409
    auditLog: ["Publicó resultados Jornada 1"],                                // de un intento que falló
  };
  const fresh = { rounds: [{ id: "r_1" }, { id: "r_2" }], participants: [{ id: "p_ana", name: "Ana María" }], roundsRevision: 4 };
  adopt(meta, fresh);
  assert.equal("paymentPenalty" in meta, false, "una penalización que no se guardó no se queda para el siguiente guardado");
  assert.equal("auditLog" in meta, false, "ni una entrada de bitácora de un intento fallido");
  assert.deepEqual(meta.rounds.map((r) => r.id), ["r_1", "r_2"]);
  assert.equal(meta.roundsRevision, 4);
  assert.equal(meta.participants[0], ana, "los participantes siguen siendo los mismos objetos");
  assert.deepEqual(ana, { id: "p_ana", name: "Ana María" });
});

test("409 · Editar: tras el conflicto se repinta el editor donde está ahora, con la jornada del servidor", () => {
  const edit = indexSrc.slice(indexSrc.indexOf("if(editingRound){\n        const saveBtn"));
  const fail = edit.slice(edit.indexOf("} else {"), edit.indexOf("return;"));
  assert.ok(fail.includes("renderAdminRondas._draft = null;"), "la copia del formulario se descarta");
  assert.ok(fail.includes("if(!result.reconciled) renderAdminRondas(body);"));
  assert.ok(fail.includes('else renderAdmin(document.getElementById("qz-main"));'), "tras un 409 `body` ya no está en la página");
  assert.ok(fail.indexOf("renderAdminRondas._draft = null;") < fail.indexOf('renderAdmin(document.getElementById("qz-main"))'));
});
