// AUTO-001.1 production bug follow-up — structural checks confirming the
// sync-competition endpoint now reports enough diagnostics to distinguish
// "genuinely fully imported" from "provider returned nothing usable", and
// that the frontend message reflects that distinction instead of assuming
// createdRounds:0 always means success.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function extractRouteHandler(source, routeSignature) {
  const start = source.indexOf(routeSignature);
  assert.ok(start !== -1, `could not locate route "${routeSignature}"`);
  const braceStart = source.indexOf("{", source.indexOf("async (req, res) => {", start));
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

test("sync-competition response includes eventsFetched and distinctProviderRounds diagnostics", () => {
  const body = extractRouteHandler(serverSrc, 'app.post("/api/quinielas/:slug/sync-competition"');
  assert.ok(body.includes("eventsFetched: events.length"), "success response must report how many events the provider actually returned");
  assert.ok(body.includes("distinctProviderRounds"), "success response must report how many distinct rounds those events represent");
});

test("sync-competition always logs diagnostics on the success path, not just on failure", () => {
  const body = extractRouteHandler(serverSrc, 'app.post("/api/quinielas/:slug/sync-competition"');
  assert.ok(body.includes('console.log("sync-competition diagnostics"'), "must log diagnostics unconditionally, so a future 'createdRounds:0' incident is debuggable from logs alone");
});

test("frontend: \"ya está todo importado\" is gated on distinctProviderRounds > 0, not just createdRounds === 0", () => {
  const idx = indexSrc.indexOf("Ya está todo importado");
  assert.ok(idx !== -1, "the message must still exist for the genuinely-complete case");
  const surrounding = indexSrc.slice(Math.max(0, idx - 400), idx + 50);
  assert.ok(surrounding.includes("data.distinctProviderRounds > 0"), "the message must only fire when we actually got real calendar data back, not merely because createdRounds was 0");
});

test("frontend: a distinct fallback message exists for when the provider returned no usable calendar at all", () => {
  assert.ok(indexSrc.includes("No encontramos un calendario disponible para esta competencia/temporada"), "must not claim full import when there was no real calendar data to begin with");
});
