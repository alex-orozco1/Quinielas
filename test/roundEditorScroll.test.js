// UX fix: "Editar" en Admin -> Jornadas debe llevar el viewport hasta el
// editor (determinístico, después del re-render real, no por timing) y el
// editor debe seguir mostrando "Editando jornada N" para la jornada
// correcta. public/index.html es un SPA monolítico sin DOM real disponible
// en node:test (sin jsdom) — estas son verificaciones estructurales sobre
// el código real: confirman la forma exacta del fix (await antes de
// scrollIntoView, mismo target element, un solo punto de entrada
// reutilizado por ambos flujos de "Editar") en vez de reimplementar el
// comportamiento.

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

test("openRoundEditor awaits the re-render BEFORE scrolling (deterministic, not timing-based)", () => {
  const body = extractFunctionBody(indexSrc, "async function openRoundEditor(body, roundId)");
  const awaitIdx = body.indexOf("await renderAdminRondas(body);");
  const scrollIdx = body.indexOf("scrollIntoView(");
  assert.ok(awaitIdx !== -1, "the re-render must be awaited");
  assert.ok(scrollIdx !== -1, "must scroll into view");
  assert.ok(awaitIdx < scrollIdx, "scrolling must happen strictly after the awaited re-render completes");
  assert.ok(!body.includes("setTimeout"), "must not rely on an arbitrary timeout instead of awaiting the real render");
});

test("openRoundEditor scrolls to the actual editor card (#qz-round-form), with smooth + start", () => {
  const body = extractFunctionBody(indexSrc, "async function openRoundEditor(body, roundId)");
  assert.ok(body.includes('getElementById("qz-round-form")'), "must target the real editor card element");
  assert.match(body, /scrollIntoView\(\s*\{\s*behavior:\s*"smooth",\s*block:\s*"start"\s*\}\s*\)/, "must use smooth scroll to the start of the editor");
});

test("the editor card element (#qz-round-form) is exactly where \"Editando jornada N\" is rendered", () => {
  const idIdx = indexSrc.indexOf('<div class="card" id="qz-round-form">');
  assert.ok(idIdx !== -1, "the editor card must carry the id the scroll targets");
  const nearby = indexSrc.slice(idIdx, idIdx + 250);
  assert.ok(nearby.includes("Editando jornada ${editingRound.number}"), "the heading shown right after scrolling must reflect the round actually being edited");
});

test("both entry points for clicking \"Editar\" (blocked-payment branch and normal branch) reuse the same openRoundEditor helper", () => {
  const occurrences = indexSrc.split('addEventListener("click", () => openRoundEditor(body, btn.dataset.editRound))').length - 1;
  assert.equal(occurrences, 2, "both the blockingStatus early-return branch and the normal branch must wire Editar through the same helper, so the fix applies regardless of payment-block state");
});

test("\"Editar\" remains unconditionally visible for every round -- imported/unpublished, published, and legacy alike", () => {
  const idx = indexSrc.indexOf('<div class="eyebrow">Jornadas existentes</div>');
  const roundItemSrc = indexSrc.slice(idx, idx + 1200);
  assert.ok(roundItemSrc.includes('<button class="btn btn-ghost btn-sm" data-edit-round="${r.id}">Editar</button>'), "Editar button markup must exist");
  // Confirm it's NOT wrapped in the same conditional that gates "Publicar jornada"
  // (isImportedUnpublished ? ... : ``) -- i.e. it must be unconditional.
  const publishBtnIdx = roundItemSrc.indexOf("isImportedUnpublished ? `<button");
  const editBtnIdx = roundItemSrc.indexOf('data-edit-round="${r.id}"');
  assert.ok(publishBtnIdx !== -1 && editBtnIdx > publishBtnIdx, "Editar must be a separate, unconditional line after the conditional Publicar button, not nested inside that same condition");
});
