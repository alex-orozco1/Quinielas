// UX fix (recovered per DATA-003 P1-4): "Historial de jornadas -> Ver
// detalle" must scroll the rendered detail into view without leaving its
// top edge hidden under the sticky .qz-header, deterministically (after the
// real, synchronous render -- no timers) and correctly on repeated clicks.
// public/index.html is a monolithic SPA with no DOM available under
// node:test (no jsdom) -- these are structural checks on the real source,
// mirroring the same pattern already proven for openRoundEditor in
// roundEditorScroll.test.js.

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

const body = () => extractFunctionBody(indexSrc, "function renderHistDetail(round){");

test("renderHistDetail identifies the scroll target as detail.firstElementChild, falling back to detail itself", () => {
  assert.ok(body().includes("detail.firstElementChild || detail"), "must prefer the first rendered child, with detail itself as fallback");
});

test("renderHistDetail measures the REAL sticky header, not a magic number", () => {
  const b = body();
  assert.ok(b.includes('querySelector("#quiniela-root .qz-header")'), "must measure the real sticky header element");
  assert.ok(b.includes("getBoundingClientRect().height"), "the header offset must come from a live layout measurement");
  assert.ok(!/scrollTo\(\s*\{\s*top:\s*\d/.test(b), "the scroll target must be computed from measured values, never a literal hardcoded number");
});

test("renderHistDetail computes an absolute document offset with a small breathing-room margin, clamped to 0", () => {
  const b = body();
  assert.ok(b.includes("getBoundingClientRect().top"), "must measure the target's real position");
  assert.ok(b.includes("window.scrollY"), "must account for current scroll position");
  assert.ok(b.includes("Math.max(0,"), "must clamp so a detail near the top never scrolls to a negative offset");
  assert.match(b, /BREATHING_ROOM_PX\s*=\s*12\b/, "breathing room must be a small (~12px) constant, not folded into a magic scrollTo number");
});

test("renderHistDetail respects prefers-reduced-motion (auto) and defaults to smooth otherwise", () => {
  const b = body();
  assert.ok(b.includes('matchMedia("(prefers-reduced-motion: reduce)")'), "must check the user's reduced-motion preference");
  assert.ok(b.includes('reducedMotion ? "auto" : "smooth"'), "must use auto under reduced motion and smooth otherwise");
});

test("renderHistDetail does not rely on setTimeout or an arbitrary delay to scroll", () => {
  const b = body();
  assert.ok(!b.includes("setTimeout"), "must not rely on an arbitrary timeout instead of the real (synchronous) render");
  assert.ok(!/^\s*requestAnimationFrame\(/m.test(b), "must not need an extra animation frame — getBoundingClientRect() already forces accurate layout synchronously");
});

test("the scroll call happens after detail.innerHTML is assigned, so it measures the just-rendered content", () => {
  const b = body();
  const innerHtmlIdx = b.lastIndexOf("detail.innerHTML = `");
  const scrollIdx = b.indexOf("window.scrollTo(");
  assert.ok(innerHtmlIdx !== -1 && scrollIdx !== -1);
  assert.ok(innerHtmlIdx < scrollIdx, "must measure/scroll only after the detail markup is actually in the DOM");
});

test("repeated clicks re-measure fresh: no cached/memoized scroll target across calls", () => {
  const b = body();
  assert.ok(!/renderHistDetail\._/.test(b), "must not stash cached measurement state on the function the way openRoundEditor stashes editing state on renderAdminRondas -- every call should measure live");
});
