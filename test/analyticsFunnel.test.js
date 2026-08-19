// Sprint 15.1 — Static text checks for the new analytics events.
// server.js can't be require()'d directly in tests: it connects to a real
// Postgres instance at import time (pre-existing constraint, documented
// already in the DATA-001 QA reports) — no test DB is available in this
// environment. These checks read the file as text instead, which is enough
// to catch the actual regression this ticket cares about: an event getting
// silently dropped from KNOWN_EVENTS (rejected server-side) or from
// FUNNEL_EVENT_NAMES (invisible in /panel-plataforma) by a future edit.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function arrayBody(varName) {
  const re = new RegExp(varName + "\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]");
  const m = serverSrc.match(re);
  assert.ok(m, `could not locate ${varName} array in server.js`);
  return m[1];
}

test("KNOWN_EVENTS includes the three Sprint 15.1 events", () => {
  const body = arrayBody("KNOWN_EVENTS");
  for (const name of ["first_round_published", "result_published", "standings_viewed"]) {
    assert.ok(body.includes(`"${name}"`), `KNOWN_EVENTS missing "${name}"`);
  }
});

test("FUNNEL_EVENT_NAMES includes the three Sprint 15.1 events (dashboard-visible)", () => {
  const body = arrayBody("FUNNEL_EVENT_NAMES");
  for (const name of ["first_round_published", "result_published", "standings_viewed"]) {
    assert.ok(body.includes(`"${name}"`), `FUNNEL_EVENT_NAMES missing "${name}" — captured but invisible in /panel-plataforma`);
  }
});

test("pre-existing events were not accidentally removed from either array", () => {
  const known = arrayBody("KNOWN_EVENTS");
  const funnel = arrayBody("FUNNEL_EVENT_NAMES");
  const preExisting = [
    "access_link_opened", "join_started", "join_completed", "session_restored",
    "landing_viewed", "create_started", "quiniela_created", "first_pick_saved",
    "picks_completed", "invite_shared", "standings_shared",
  ];
  for (const name of preExisting) {
    assert.ok(known.includes(`"${name}"`), `KNOWN_EVENTS lost "${name}"`);
  }
  // standings_shared and the rest of the pre-existing funnel-visible ones
  assert.ok(funnel.includes(`"standings_shared"`), "FUNNEL_EVENT_NAMES lost standings_shared");
  assert.ok(funnel.includes(`"quiniela_created"`), "FUNNEL_EVENT_NAMES lost quiniela_created");
});

// ---- S15-3 / S15-4: structural checks against the actual SPA source -------
//
// public/index.html is one monolithic <script>, not a module — these
// functions can't be require()'d and exercised directly without either
// jsdom or a real architecture refactor, both explicitly out of scope for
// this ticket. What follows instead are STRUCTURAL checks against the real
// extracted function bodies (not full-file grepping, not a reimplementation
// standing in for the real thing): they verify that the specific control
// flow shape the QA fix demanded is actually present, in the actual file,
// in the actual order. This does not execute the click handler or the
// render function — see the delivery report for exactly what this does and
// does not prove, and the manual smoke tests that cover the rest.

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}" in public/index.html`);
  // Balanced-brace slice from the first "{" after the signature — good
  // enough here since this file has no template-literal braces that would
  // throw off a naive brace counter inside these two specific functions.
  const braceStart = source.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

test("result_published: guard is the persisted wasAlreadyPublished flag, not localStorage/sessionStorage", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminResultados(body)");
  // The guard variable must be captured from the round's own persisted
  // state, BEFORE the write that flips it — this is what makes correcting
  // an already-published round (from any device) a no-op for tracking.
  const guardIdx = body.indexOf("const wasAlreadyPublished = round.resultsPublished;");
  assert.ok(guardIdx !== -1, "wasAlreadyPublished must be captured from round.resultsPublished before the write");

  const writeIdx = body.indexOf("round.resultsPublished = true;");
  assert.ok(writeIdx > guardIdx, "the guard must be captured BEFORE resultsPublished is set to true");

  const trackIdx = body.indexOf('trackEvent("result_published"');
  assert.ok(trackIdx !== -1, "result_published must be tracked somewhere in the publish handler");
  assert.ok(trackIdx > writeIdx, "tracking must happen after the write, inside the async success path — not optimistically before it resolves");

  // Must be gated by !wasAlreadyPublished, and that gate must sit inside the
  // result.ok success branch (not e.g. unconditionally, or in the failure branch).
  const gateSlice = body.slice(writeIdx, trackIdx + 40);
  assert.ok(gateSlice.includes("if(result.ok)"), "tracking must be inside the result.ok success branch");
  assert.ok(gateSlice.includes("if(!wasAlreadyPublished)"), "tracking must be gated by !wasAlreadyPublished");

  // Must NOT rely on localStorage/sessionStorage for this specific guard —
  // that was the explicit thing the QA fix ruled out. Checks for actual
  // usage (a property/method access), not just the word appearing anywhere
  // (which would also match this file's own explanatory comments).
  const guardRegion = body.slice(guardIdx, trackIdx + 40);
  assert.ok(!guardRegion.includes("localStorage."), "result_published guard must not use localStorage");
  assert.ok(!guardRegion.includes("sessionStorage."), "result_published guard must not use sessionStorage");
});

test("standings_viewed: guarded by a module-scope Set, fired without awaiting, doesn't block the standings render", () => {
  // Declaration lives near the other analytics guards, not inside renderTabla
  // — confirms it's module-scope (persists across re-renders within the
  // same page load) rather than re-created (and thus reset) on every render.
  assert.ok(indexSrc.includes("const standingsViewedTrackedSlugs = new Set();"), "standingsViewedTrackedSlugs must be a single module-scope Set");

  const body = extractFunctionBody(indexSrc, "async function renderTabla(main)");
  const hasCheckIdx = body.indexOf("standingsViewedTrackedSlugs.has(standingsSlugKey)");
  assert.ok(hasCheckIdx !== -1, "renderTabla must check the guard before tracking");

  const addIdx = body.indexOf("standingsViewedTrackedSlugs.add(standingsSlugKey);");
  assert.ok(addIdx > hasCheckIdx, "the slug must be added to the guard Set after (inside) the has() check");

  const trackIdx = body.indexOf('trackEvent("standings_viewed"');
  assert.ok(trackIdx > addIdx, "tracking must happen after marking the guard, and only within the has()-gated block");

  // Fire-and-forget: the call must not be preceded by "await" — an awaited
  // call would make an analytics hiccup part of the render's own critical path.
  const beforeCall = body.slice(Math.max(0, trackIdx - 10), trackIdx);
  assert.ok(!beforeCall.includes("await"), "trackEvent(\"standings_viewed\"...) must be fire-and-forget, not awaited");

  // The guard/track block must appear before the picks are loaded and the
  // real table markup is built — i.e. it doesn't gate or delay the render itself.
  const ensurePicksIdx = body.indexOf("await ensureAllPicksLoaded();");
  assert.ok(trackIdx < ensurePicksIdx, "tracking must not sit after (and thus block) the actual standings computation");
});
