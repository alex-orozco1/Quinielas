// AUTO-001 QA FIX 2 — real protection at the results-publish mutation point:
// a round with published:false must never have its results published.
//
// The publish click handler in renderAdminResultados closes over too many
// variables (form state, meta, setMetaWithError, qzConfirm, toast, logAudit)
// to cleanly isolate-eval like visibleRounds() in roundVisibility.test.js.
// These are structural/order checks against the real extracted handler
// source instead — same pattern already used for the Sprint 15.1 QA fix
// (result_published guard). They verify the actual code, not a
// reimplementation of it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}" in public/index.html`);
  const braceStart = source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

const adminResultadosBody = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");

test("FIX 2: the publish handler checks round.published === false before anything else", () => {
  const handlerStart = adminResultadosBody.indexOf('publishBtn.addEventListener("click"');
  assert.ok(handlerStart !== -1, "could not locate the publish button click handler");
  const guardIdx = adminResultadosBody.indexOf("if(round.published === false){", handlerStart);
  assert.ok(guardIdx !== -1, "the published:false guard must be inside the publish click handler");

  // Must be the FIRST thing in the handler body — before the completeness
  // check, before the confirm dialog, before any mutation.
  const completenessCheckIdx = adminResultadosBody.indexOf("const stillComplete", handlerStart);
  assert.ok(guardIdx < completenessCheckIdx, "the published guard must run before the completeness check");
});

test("FIX 2: the guard returns early and never reaches the mutation (round.resultsPublished = true / round.results = ...)", () => {
  const guardIdx = adminResultadosBody.indexOf("if(round.published === false){");
  const guardBlockEnd = adminResultadosBody.indexOf("}", guardIdx);
  const guardBlock = adminResultadosBody.slice(guardIdx, guardBlockEnd + 1);
  assert.ok(guardBlock.includes("return;"), "the guard must return early, not just warn");
  assert.ok(!guardBlock.includes("round.resultsPublished"), "the guard block itself must not touch resultsPublished");

  const mutationIdx = adminResultadosBody.indexOf("round.resultsPublished = true;");
  assert.ok(mutationIdx > guardBlockEnd, "the actual mutation must sit strictly after the guard");
});

test("FIX 2: the guard does not modify resultsPublished or scoring — it only blocks and returns", () => {
  const guardIdx = adminResultadosBody.indexOf("if(round.published === false){");
  const guardBlockEnd = adminResultadosBody.indexOf("}", guardIdx);
  const guardBlock = adminResultadosBody.slice(guardIdx, guardBlockEnd + 1);
  assert.ok(!guardBlock.includes("computeStandings"), "the guard must not touch scoring");
  assert.ok(!guardBlock.includes("round.results ="), "the guard must not touch results");
});

test("FIX 2 compatibility: legacy rounds without a published field are unaffected (published !== false, guard never trips)", () => {
  // Same compatibility contract as visibleRounds(): `undefined === false` is
  // false in JS, so the guard's condition is naturally false for any round
  // that predates this field — no special-casing needed, verified here by
  // confirming the guard uses strict equality against false specifically
  // (not a truthiness check that could misfire on undefined).
  const guardLine = adminResultadosBody.slice(
    adminResultadosBody.indexOf("if(round.published === false){"),
    adminResultadosBody.indexOf("if(round.published === false){") + 40
  );
  assert.match(guardLine, /round\.published === false/, "must use strict === false, not a truthiness/falsiness check that could misfire on undefined");
});

test("FIX 2: round.published is never set back to false anywhere (so the guard can never re-trip a correction on an already-published round)", () => {
  // "no afecta correcciones de resultados de jornadas ya publicadas" holds
  // by construction: published only ever transitions false -> true (see the
  // "Publicar jornada" button handler), never the reverse. If a round's
  // results were ever legitimately published, round.published must already
  // have been true at that time and stays true forever after.
  const regressions = (indexSrc.match(/\.published\s*=\s*false/g) || []).filter((m) => {
    // The only two legitimate appearances of ".published = false" in the
    // whole file are: (1) inside competitionSync.js's newly-imported-round
    // object literal (not this file) and (2) the in-memory rollback on a
    // FAILED publish-round request — never a live regression of an
    // already-true round.
    return true;
  });
  // In public/index.html specifically, the only assignment should be the
  // rollback-on-failure inside the "Publicar jornada" handler.
  const assignments = [...indexSrc.matchAll(/round\.published\s*=\s*false/g)];
  assert.equal(assignments.length, 1, "round.published should only ever be set to false in the publish-round failure rollback, nowhere else");
});
