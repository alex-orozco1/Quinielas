// Todo dato de la quiniela que el navegador pinta en HTML pasa por esc().
//
// Quien administra una quiniela escribe su meta, y esa meta se pinta en el
// navegador de todos los que entran: participantes, espectadores con `?ver` y
// el panel de plataforma. Esta prueba recorre TODAS las interpolaciones `${…}`
// de public/index.html (con llaves, cadenas y plantillas anidadas balanceadas)
// y exige que cada una que nombra un campo de datos —ids, números, nombres,
// etiquetas— pinte sólo cosas seguras:
//   - esc(…) entero;
//   - una condición cuyas salidas son constantes o esc(…)
//     (`r.id===x ? 'selected' : ''`, `a && esc(b)`);
//   - un contenedor `.map(x => `…`)`, cuyas plantillas internas se revisan
//     una por una;
//   - o una de PERMITIDAS, cada una con su motivo: texto plano (toast y los
//     diálogos, que ya escapan), constantes del propio código, selectores y URLs.
// No ve alias (`const x = m.id; …${x}`): para eso el servidor exige la forma
// de los ids y que los números sean números (metaIds.js, metaNumbers.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// ---- lectura de plantillas ----
function skipString(s, i, q) { i++; while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; } return i + 1; }
function skipTemplate(s, i, out) {
  i++;
  while (i < s.length && s[i] !== "`") {
    if (s[i] === "\\") { i += 2; continue; }
    if (s[i] === "$" && s[i + 1] === "{") { i = readExpr(s, i + 2, out).end + 1; continue; }
    i++;
  }
  return i + 1;
}
function readExpr(s, i, out) {
  let depth = 1; const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') { i = skipString(s, i, c); continue; }
    if (c === "`") { i = skipTemplate(s, i, out); continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { const r = { start, end: i, expr: s.slice(start, i) }; out.push(r); return r; }
    i++;
  }
  throw new Error("interpolación sin cerrar en la posición " + start);
}
function interpolations(src) {
  const out = [];
  for (let i = 0; i < src.length;) i = src[i] === "`" ? skipTemplate(src, i, out) : i + 1;
  return out;
}
// Lo que la interpolación misma pinta: sus plantillas anidadas (que se revisan
// aparte) quedan como ``.
function own(expr) {
  let o = "";
  for (let k = 0; k < expr.length;) {
    if (expr[k] === "`") { k = skipTemplate(expr, k, []); o += "``"; continue; }
    if (expr[k] === "'" || expr[k] === '"') { const j = skipString(expr, k, expr[k]); o += expr.slice(k, j); k = j; continue; }
    o += expr[k++];
  }
  return o.trim();
}
const withoutStrings = (e) => e.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');

// ---- ¿qué puede pintar? ----
// Parte `e` por un operador de nivel superior (fuera de paréntesis, corchetes,
// llaves y cadenas). Para "?" ignora `?.` y `??`.
function splitTop(e, ops) {
  const parts = []; let depth = 0, last = 0;
  for (let k = 0; k < e.length; k++) {
    const c = e[k];
    if (c === "'" || c === '"') { k = skipString(e, k, c) - 1; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0) {
      for (const op of ops) {
        if (!e.startsWith(op, k)) continue;
        if (op === "?" && (e[k + 1] === "." || e[k + 1] === "?" || e[k - 1] === "?")) continue;
        parts.push(e.slice(last, k), op); last = k + op.length; k += op.length - 1; break;
      }
    }
  }
  parts.push(e.slice(last));
  return parts;
}
function unwrapParens(e) {
  while (e.startsWith("(") && e.endsWith(")")) {
    let d = 0, closesAtEnd = true;
    for (let k = 0; k < e.length; k++) { if (e[k] === "(") d++; else if (e[k] === ")" && --d === 0 && k < e.length - 1) { closesAtEnd = false; break; } }
    if (!closesAtEnd) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}
const isEsc = (e) => {
  if (!e.startsWith("esc(") || !e.endsWith(")")) return false;
  let d = 0;
  for (let k = 3; k < e.length; k++) { if (e[k] === "(") d++; else if (e[k] === ")" && --d === 0) return k === e.length - 1; }
  return false;
};
function safeOutput(e) {
  e = unwrapParens(e.trim());
  if (e === "``" || /^-?\d+(\.\d+)?$/.test(e) || isEsc(e)) return true;
  if ((e[0] === "'" || e[0] === '"') && skipString(e, 0, e[0]) === e.length) return true;
  const t = splitTop(e, ["?", ":"]);
  if (t.length > 1) {
    // c1 ? r1 : c2 ? r2 : r3 — las salidas son r1, r2, r3.
    const outs = t.filter((_, k) => k % 2 === 0).filter((_, k, all) => k % 2 === 1 || k === all.length - 1);
    return outs.every(safeOutput);
  }
  // `a || b && c` es `a || (b && c)`: primero ||, cuyos operandos se pintan todos.
  const or = splitTop(e, ["||"]);
  if (or.length > 1) return or.filter((_, k) => k % 2 === 0).every(safeOutput);
  // De `a && b` sale un falsy ("", 0, null, undefined, false, NaN), que no
  // puede llevar marcado, o `b`.
  const and = splitTop(e, ["&&"]);
  if (and.length > 1) return safeOutput(and[and.length - 1]);
  return false;
}

// ---- campos de datos ----
const DATA = /(?:^|[^\w$])(?:[\w$]+(?:\[[^\]]*\])?\.)*(id|mid|pid|rid|matchId|roundId|betId|number|length|matches|pts|points|closesAtRound|entryFee|pointsPerCorrectPick|startsAtRound|pointsPerRound|bonusPoints|penalty|rn|name|label|teamA|teamB|groupName|phaseLabel|guess|answer|contact|detail|admin|action|provider|externalRoundId|syncGroupKey|leagueId|sportsdbLeagueId|sportsdbSeason|deadline|kickoffAt|slug)\b/;

function unsafe(src) {
  const lines = src.split("\n");
  const lineAt = (pos) => src.slice(0, pos).split("\n").length;
  const found = [];
  for (const r of interpolations(src)) {
    const e = own(r.expr);
    if (!DATA.test(withoutStrings(e))) continue;
    if (/=>/.test(e) && e.includes("``")) continue;      // contenedor
    if (safeOutput(e)) continue;
    const n = lineAt(r.start);
    found.push({ line: n, expr: e.replace(/\s+/g, " "), text: lines[n - 1] });
  }
  return found;
}

// Lo que se interpola sin esc() a sabiendas. `expr` es la interpolación;
// `en` un trozo de la línea que la ubica.
const PERMITIDAS = [
  // Constantes del propio código.
  { expr: "id", en: 'class="qz-wait-notice" id="${id}"', por: "credentialWaitNoticeHtml sólo recibe ids fijos" },
  { expr: "id", en: '<input class="qz-modal-input" id="${id}" type="password" maxlength="200"', por: "passwordFieldHtml sólo recibe ids fijos" },
  { expr: "id", en: 'data-pass-toggle="${id}" aria-controls="${id}"', por: "passwordFieldHtml sólo recibe ids fijos" },
  { expr: "label", en: "<span>${label}Demasiados intentos.", por: "ya es esc(opts.label)" },
  { expr: "label", en: "<span>${label}Ya puedes intentarlo de nuevo.", por: "ya es esc(opts.label)" },
  { expr: "t.id", en: "data-tab=\"${t.id}\"", por: "pestañas fijas" },
  { expr: "t.id", en: "data-sub=\"${t.id}\"", por: "subpestañas fijas del admin" },
  { expr: "t.label", en: "${t.label}", por: "pestañas fijas" },
  { expr: "f.id", en: "data-jf=\"${f.id}\"", por: "filtros fijos" },
  { expr: "f.label", en: "${f.label}", por: "filtros fijos" },
  { expr: "counts[f.id]", en: "counts[f.id]", por: "un conteo" },
  { expr: "colorOf(id)", en: "colorOf(id)", por: "un color de la paleta" },
  { expr: "l.id", en: "value=\"${l.id}\"", por: "ligas fijas (SPORTSDB_LEAGUES)" },
  { expr: "clockDigitsHtml(round.deadline)", en: "clockDigitsHtml(round.deadline)", por: "pinta dígitos calculados con Math.floor" },
  // Texto plano: toast usa textContent; qzConfirm, qzPrompt y qzPromptDeadline
  // escapan título y mensaje; la bitácora se escapa al pintarse.
  { expr: "p.name", en: "toast(checkbox.checked ? `${p.name} ✅` : `Se quitó el punto de ${p.name}`)", por: "toast" },
  { expr: "round.number", en: "toast(`✅ La Jornada ${round.number} está abierta. Cierra el ${fmtWhenTz(round.deadline)}.`", por: "toast" },
  { expr: "fmtWhenTz(round.deadline)", en: "toast(`✅ La Jornada ${round.number} está abierta. Cierra el ${fmtWhenTz(round.deadline)}.`", por: "toast" },
  { expr: "r.champion.name", en: "const who = r.champion ? ` 🏆 Campeón: ${r.champion.name}.`", por: "va a un toast" },
  { expr: "round.number", en: "const confirmTitle = correcting ?", por: "título de qzConfirm" },
  { expr: "round.number", en: "{ title: `¿Reabrir la Jornada ${round.number}?`", por: "título de qzConfirm" },
  { expr: "round.number", en: "qzPromptDeadline(`Elige la nueva fecha y hora límite para votar la Jornada ${round.number}:`", por: "mensaje de qzPromptDeadline" },
  { expr: "round.number", en: "`Jornada ${round.number}`", por: "detalle de logAudit (texto; se escapa al pintar la bitácora)" },
  { expr: "round.number", en: "logAudit(\"Reabrió jornada\", `Jornada ${round.number}`)", por: "detalle de logAudit" },
  { expr: "champion.name", en: "`🏆 El campeón es ${champion.name} con ${champion.pts} puntos.", por: "mensaje de qzConfirm" },
  { expr: "champion.pts", en: "`🏆 El campeón es ${champion.name} con ${champion.pts} puntos.", por: "mensaje de qzConfirm" },
  { expr: "creator.name", en: "? `Antes de publicar la primera jornada, ${creator.name} (quien creó la quiniela)", por: "mensaje de qzAlert" },
  { expr: "p.name", en: "title: `¿Resetear el PIN de ${p.name}?`", por: "título de qzConfirm" },
  { expr: "p.name", en: "title: `¿Borrar a ${p.name}?`", por: "título de qzConfirm" },
  { expr: "slug", en: "title: `¿Mover esta quiniela a ${window.location.origin}/q/${slug}?`", por: "título de qzConfirm" },
  { expr: "q ? q.name : slug", en: "title: `¿Eliminar \"${q ? q.name : slug}\" para siempre?`", por: "título de qzConfirm" },
  { expr: "slug", en: "title: `¿Activar Plus en /q/${slug}?`", por: "título de qzConfirm" },
  { expr: "slug", en: "title: `¿Regresar /q/${slug} a Gratis?`", por: "título de qzConfirm" },
  { expr: "slug", en: "title: `Ajuste manual · /q/${slug}`", por: "título de qzPrompt" },
  { expr: "offer.contact", en: "`Escríbenos a ${offer.contact} y activamos Plus", por: "texto que se pinta con esc(howTo)" },
  { expr: "r.number", en: "return `Jornada ${r.number} (${r.matches.length} partidos) — ${status}`;", por: "resumen del panel, que se pinta con esc(s)" },
  { expr: "r.matches.length", en: "return `Jornada ${r.number} (${r.matches.length} partidos) — ${status}`;", por: "resumen del panel, que se pinta con esc(s)" },
  { expr: "meta.groupName", en: "return `Únete a mi quiniela \"${meta.groupName}\" en QRACKS", por: "mensaje para copiar" },
  { expr: "round.number", en: "⏰ Faltan por contestar la Jornada ${round.number}:", por: "mensaje para copiar o WhatsApp" },
  // MS2 · el asistente y las preguntas: textos planos que se pintan con esc()
  // o textContent, y el mensaje de WhatsApp.
  { expr: "closeRound.number", en: "return `Cierra con la Jornada ${closeRound.number}: ${fmtWhenTz(closeRound.deadline)}`", por: "texto de extraCloseShort, que se pinta con esc() o textContent" },
  { expr: "fmtWhenTz(closeRound.deadline)", en: "return `Cierra con la Jornada ${closeRound.number}: ${fmtWhenTz(closeRound.deadline)}`", por: "texto de extraCloseShort, que se pinta con esc() o textContent" },
  { expr: "closeRound.number", en: "return `Cierra con la Jornada ${closeRound.number} (eliges la hora en el paso 3)`", por: "texto de extraCloseShort, que se pinta con esc() o textContent" },
  { expr: "closeRound.number", en: "return `Cierra con la Jornada ${closeRound.number}: ${fmtWhenTz(closeRound.deadline)}. Hasta entonces", por: "texto de extraCloseLong, que se pinta con esc() o textContent" },
  { expr: "fmtWhenTz(closeRound.deadline)", en: "return `Cierra con la Jornada ${closeRound.number}: ${fmtWhenTz(closeRound.deadline)}. Hasta entonces", por: "texto de extraCloseLong, que se pinta con esc() o textContent" },
  { expr: "d.questions.length", en: "await qzConfirm(`Tus ${d.questions.length}", por: "mensaje de qzConfirm" },
  { expr: "label", en: "await qzConfirm(`Con ${label} preparamos tu calendario", por: "mensaje de qzConfirm" },
  { expr: "label", en: "{ title: `¿Usar ${label}?`", por: "título de qzConfirm" },
  { expr: "number", en: "setupHeadHtml(\"resumen\", `Nada se publica hasta que toques «Publicar jornada ${number}».`)", por: "subtítulo que setupHeadHtml pinta con esc()" },
  { expr: "number", en: ": `Publicar jornada ${number}`;", por: "etiqueta que setupBar pinta con esc()" },
  { expr: "meta.groupName", en: "const lines = [`Únete a mi quiniela \"${meta.groupName}\" en QRACKS", por: "mensaje para WhatsApp" },
  { expr: "round.number", en: "lines.push(`Haz tus pronósticos de la Jornada ${round.number} antes del ${fmtWhenTz(round.deadline)}.`)", por: "mensaje para WhatsApp" },
  { expr: "fmtWhenTz(round.deadline)", en: "lines.push(`Haz tus pronósticos de la Jornada ${round.number} antes del ${fmtWhenTz(round.deadline)}.`)", por: "mensaje para WhatsApp" },
  { expr: "added.length", en: "return `✓ ${added.length}", por: "aviso que se pinta con textContent" },
  { expr: "done.number", en: "toast(`La Jornada ${done.number} ya estaba publicada", por: "toast" },
  { expr: "bet.closesAtRound", en: "text: `Cierra con la Jornada ${bet.closesAtRound} (fecha por confirmar).`", por: "texto de tournamentBetClose, que se pinta con esc()" },
  { expr: "r.number", en: "text: `Cierra con la Jornada ${r.number}: ${fmtWhenTz(r.deadline)}.`", por: "texto de tournamentBetClose, que se pinta con esc()" },
  { expr: "fmtWhenTz(r.deadline)", en: "text: `Cierra con la Jornada ${r.number}: ${fmtWhenTz(r.deadline)}.`", por: "texto de tournamentBetClose, que se pinta con esc()" },
  { expr: "guess", en: "? `Cerró el ${when}. Tu respuesta: «${guess}».`", por: "texto de tournamentBetStatus, que se pinta con esc()" },
  { expr: "guess", en: "if(guess) return when ? `✅ Guardada: «${guess}».", por: "texto de tournamentBetStatus, que se pinta con esc()" },
  { expr: "savedBetGuess(betId)", en: "` Tu respuesta anterior («${savedBetGuess(betId)}») se conserva.`", por: "aviso que se pinta con textContent" },
  // MS2 · «Siguiente paso», «Tus reglas» y los avisos D3/D4: textos planos que
  // se pintan con esc() o que muestran qzConfirm.
  { expr: "others.length", en: "? `Ya añadiste ${others.length}", por: "texto de nextStepInfo, que se pinta con esc()" },
  { expr: "r.number", en: "pero nadie ha entrado todavía. La Jornada ${r.number} cierra el ${when}.`", por: "texto de nextStepInfo, que se pinta con esc()" },
  { expr: "r.number", en: ": `Todavía nadie ha entrado. La Jornada ${r.number} cierra el ${when}.`", por: "texto de nextStepInfo, que se pinta con esc()" },
  { expr: "r.number", en: "return { title: `La Jornada ${r.number} ya cerró`", por: "texto de nextStepInfo, que se pinta con esc()" },
  { expr: "missing.length", en: "text: `${missing.length} de ${meta.participants.length} personas", por: "texto de nextStepInfo, que se pinta con esc()" },
  { expr: "meta.participants.length", en: "text: `${missing.length} de ${meta.participants.length} personas", por: "texto de nextStepInfo, que se pinta con esc()" },
  { expr: "r.number", en: "personas no han completado la Jornada ${r.number}. Cierra el", por: "texto de nextStepInfo, que se pinta con esc()" },
  { expr: "fmtWhenTz(r.deadline)", en: "personas no han completado la Jornada ${r.number}. Cierra el ${fmtWhenTz(r.deadline)}.`", por: "texto de nextStepInfo, que se pinta con esc()" },
  { expr: "prepared.number", en: "label: prepared ? `Publicar jornada ${prepared.number}`", por: "etiqueta que nextStepCardHtml pinta con esc()" },
  { expr: "bet.closesAtRound", en: "return `Cierra con la Jornada ${bet.closesAtRound} (esa jornada ya no existe)`", por: "texto de betCloseLine, que se pinta con esc()" },
  { expr: "r.number", en: "return `Cierra con la Jornada ${r.number}: ${fmtWhenTz(r.deadline)}${r.published === false", por: "texto de betCloseLine, que se pinta con esc()" },
  { expr: "fmtWhenTz(r.deadline)", en: "return `Cierra con la Jornada ${r.number}: ${fmtWhenTz(r.deadline)}${r.published === false", por: "texto de betCloseLine, que se pinta con esc()" },
  { expr: "editingBet.points", en: "la tabla se recalcula (${editingBet.points} → ${newPoints} puntos cada uno)", por: "mensaje de qzConfirm" },
  { expr: 'bets.length === 1 ? "1 pregunta del torneo" : bets.length + " preguntas del torneo"', en: "Esta jornada es el cierre de ${bets.length === 1", por: "texto de linkedBetsNote, que va a un qzConfirm" },
  { expr: "round.number", en: "return qzConfirm(`El nuevo cierre de la Jornada ${round.number} será", por: "mensaje de qzConfirm" },
  // HTML que arma otra función, cuyas plantillas se revisan aparte.
  { expr: 'draft.matches.map(matchRowHtml).join("")', en: "draft.matches.map(matchRowHtml)", por: "filas de matchRowHtml" },
  { expr: 'rows.length ? rows.map(rowHtml).join("") : ``', en: "rows.map(rowHtml)", por: "filas de rowHtml (panel de plataforma)" },
  // Selectores y URLs.
  { expr: "m.id", en: "rowsEl.querySelector(`.qz-wz-match[data-mid=\"${m.id}\"]", por: "selector del asistente (ids que hace uid() o validados por metaIds.js; CSS.escape pendiente en el backlog)" },
  { expr: "matchId", en: "[data-result-match=\"${matchId}\"]", por: "selector (CSS.escape pendiente en el backlog)" },
  { expr: "encodeURIComponent(roundId)", en: "encodeURIComponent(roundId)", por: "URL de fetch" },
  { expr: "encodeURIComponent(guess)", en: "encodeURIComponent(guess)", por: "URL" },
  { expr: "encodeURIComponent(q.slug)", en: "encodeURIComponent(q.slug)", por: "URL" },
  { expr: "encodeURIComponent(slug)", en: "encodeURIComponent(slug)", por: "URL" },
];
const permitted = (f) => PERMITIDAS.find((p) => p.expr === f.expr && f.text.includes(p.en));

test("escape · todo dato que se pinta en HTML pasa por esc(), salvo las excepciones con motivo", () => {
  const all = interpolations(indexSrc);
  assert.ok(all.length > 600, `el lector tiene que ver las plantillas del archivo (vio ${all.length})`);
  const sinEscapar = unsafe(indexSrc).filter((f) => !permitted(f)).map((f) => `${f.line}: ${f.expr}`);
  assert.deepEqual(sinEscapar, []);
});

test("escape · cada excepción sigue existiendo (la lista no acumula entradas muertas)", () => {
  const found = unsafe(indexSrc);
  const muertas = PERMITIDAS.filter((p) => !found.some((f) => f.expr === p.expr && f.text.includes(p.en))).map((p) => `${p.expr} @ ${p.en}`);
  assert.deepEqual(muertas, []);
});

test("escape · el escáner detecta las formas de no escapar (las que engañaban al anterior)", () => {
  const casos = [
    "x.innerHTML = `<div data-match='${m.id}'></div>`;",            // comillas simples
    'x.innerHTML = `<div data-round="${r.id || ""}"></div>`;',       // un || delante
    "x.innerHTML = `<div data-pid=\"${String(p.id)}\"></div>`;",     // envuelto en otra función
    'x.innerHTML = `<div id="qz-${"rescard"}-${m.id}"></div>`;',     // otra interpolación antes
    "x.innerHTML = `<b>Jornada ${round.number}</b>`;",               // un número de la meta
    "x.innerHTML = `<td>${s.pts}</td>`;",                            // puntos calculados con datos
    "x.innerHTML = `<i>${r.matches.length} partidos</i>`;",          // el length de algo que no es lista
    "x.innerHTML = `<i>${ok ? m.teamA : ''}</i>`;",                  // una salida sin escapar
    "x.innerHTML = `<i>${ok && bet.label}</i>`;",
    "x.innerHTML = `<i>${p.name || ok && esc(x)}</i>`;",              // a || (b && c): `a` también se pinta
    "x.innerHTML = rows.map(r => `<td>${r.name}</td>`).join('');",   // dentro de un contenedor
    "const q = document.querySelector('x'); x.innerHTML = `<p>${p.name}</p>`;", // en una línea con un selector
  ];
  for (const src of casos) assert.equal(unsafe(src).length, 1, src);
  const bien = [
    "x.innerHTML = `<div data-match='${esc(m.id)}'></div>`;",
    "x.innerHTML = `<option ${r.id===target?'selected':''}>`;",
    "x.innerHTML = `<i>${ok ? esc(m.teamA) : '<span>—</span>'}</i>`;",
    "x.innerHTML = `<i>${ok && esc(bet.label)}</i>`;",
    "x.innerHTML = `${list.map(r => `<td>${esc(r.name)}</td>`).join('')}`;",
    "x.innerHTML = `<b>${esc(round.number)}</b>`;",
    "x.innerHTML = `<i>${esc(r.matches.length)} partidos</i>`;",
  ];
  for (const src of bien) assert.deepEqual(unsafe(src), [], src);
});
