// AUTO-001 — Model compatibility tests: round.published visibility.
//
// public/index.html is one monolithic <script>, not a module (documented
// limitation, see Sprint 15.1 QA reports). visibleRounds() is simple enough
// (only reads meta.rounds / currentUser.isAdmin, no other closures) to
// extract its REAL source and execute it in an isolated Function scope with
// controlled meta/currentUser — this is genuine behavioral coverage of the
// actual production code, not a reimplementation standing in for it.

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

function runVisibleRounds(meta, currentUser) {
  const fnSrc = extractFunctionBody(indexSrc, "function visibleRounds()");
  const wrapped = new Function("meta", "currentUser", `${fnSrc}\nreturn visibleRounds();`);
  return wrapped(meta, currentUser);
}

test("HOTFIX BUG 1: visibleRounds excludes published:false for admin too — Admin's normal Jornada tab must not treat unpublished imported rounds as active", () => {
  const meta = { rounds: [{ id: "r1", published: false }, { id: "r2", published: true }, { id: "r3" }] };
  const result = runVisibleRounds(meta, { isAdmin: true });
  assert.deepEqual(result.map((r) => r.id), ["r2", "r3"], "admin's visibleRounds() must exclude published:false — only Admin -> Jornadas (which reads meta.rounds directly, not this function) shows everything");
});

test("visibleRounds: participant does NOT see published:false rounds", () => {
  const meta = { rounds: [{ id: "r1", published: false }, { id: "r2", published: true }] };
  const result = runVisibleRounds(meta, { isAdmin: false });
  assert.deepEqual(result.map((r) => r.id), ["r2"]);
});

test("visibleRounds: published === undefined (every round created before AUTO-001) behaves as published, for participants too", () => {
  const meta = { rounds: [{ id: "old-manual-round" }] }; // no `published` key at all
  const result = runVisibleRounds(meta, { isAdmin: false });
  assert.deepEqual(result.map((r) => r.id), ["old-manual-round"]);
});

test("visibleRounds: publishing a round (false -> true) makes it visible to participants", () => {
  const round = { id: "r1", published: false };
  const meta = { rounds: [round] };
  assert.equal(runVisibleRounds(meta, { isAdmin: false }).length, 0);
  round.published = true;
  assert.equal(runVisibleRounds(meta, { isAdmin: false }).length, 1);
});

test("HOTFIX BUG 1: publishing a round (false -> true) makes it appear in admin's visibleRounds() too", () => {
  const round = { id: "r1", published: false };
  const meta = { rounds: [round] };
  assert.equal(runVisibleRounds(meta, { isAdmin: true }).length, 0);
  round.published = true;
  assert.equal(runVisibleRounds(meta, { isAdmin: true }).length, 1);
});

test("visibleRounds: currentUser null/missing (defensive) does not throw, treated as non-admin", () => {
  const meta = { rounds: [{ id: "r1", published: false }, { id: "r2" }] };
  const result = runVisibleRounds(meta, null);
  assert.deepEqual(result.map((r) => r.id), ["r2"]);
});

// ---- Structural checks: manual round creation explicitly sets published:true ----

test("manual round creation sets published: true explicitly (not left undefined)", () => {
  const idx = indexSrc.indexOf("resultsPublished: false,\n        published: true");
  assert.ok(idx !== -1, "the manually-created round object must set published: true explicitly");
});

test("Admin \u2192 Jornadas can publish a round (published: false -> true) via a dedicated action", () => {
  assert.ok(indexSrc.includes("data-publish-round"), "an explicit publish action must exist in Admin \u2192 Jornadas");
  assert.ok(indexSrc.includes("round.published = true;"), "the publish action must flip published to true");
});
