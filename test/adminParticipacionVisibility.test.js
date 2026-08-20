// FIX 2: Admin -> Participación no debe mostrar jornadas round.published===false
// (importadas por Competition Sync, todavía sin publicar) — ni generar
// "Sin contestar"/"Completo" para ellas, ni entrar en Copiar/WhatsApp.
//
// renderAdminParticipacion() closes over demasiadas variables de módulo
// (meta, allPicksCache, ensureAllPicksLoaded, wireAccessLinkCard, etc.)
// para aislarla completamente sin jsdom. Estas son verificaciones
// estructurales sobre el código real (misma fuente, sin reimplementar), más
// una verificación de comportamiento genuina de la regla de filtrado
// reutilizando visibleRounds() real (ya probada exhaustivamente en
// test/roundVisibility.test.js) con exactamente los escenarios de este ticket.

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

function runVisibleRounds(meta, currentUser) {
  const fnSrc = extractFunctionBody(indexSrc, "function visibleRounds()");
  const wrapped = new Function("meta", "currentUser", `${fnSrc}\nreturn visibleRounds();`);
  return wrapped(meta, currentUser);
}

test("FIX 2: renderAdminParticipacion filters through visibleRounds(), not raw meta.rounds", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminParticipacion(body)");
  assert.ok(body.includes("visibleRounds().filter(r => classifyRound(r) === \"porjugar\")"), "must derive openRounds from visibleRounds(), the same published!==false rule used everywhere else");
  assert.ok(!body.includes('meta.rounds.filter(r => classifyRound(r) === "porjugar")'), "must not read meta.rounds directly anymore for this list");
});

test("Caso A: J1 published:true, J2 published:false -> only J1 is a candidate for Participación", () => {
  const meta = { rounds: [{ id: "j1", number: 1, published: true }, { id: "j2", number: 2, published: false }] };
  const result = runVisibleRounds(meta, { isAdmin: true });
  assert.deepEqual(result.map((r) => r.id), ["j1"]);
});

test("Caso B: J1 true, J2 false, J3 false -> only J1 remains, J2/J3 excluded entirely (no 'Sin contestar' possible for them)", () => {
  const meta = { rounds: [{ id: "j1", number: 1, published: true }, { id: "j2", number: 2, published: false }, { id: "j3", number: 3, published: false }] };
  const result = runVisibleRounds(meta, { isAdmin: true });
  assert.deepEqual(result.map((r) => r.id), ["j1"]);
});

test("Caso C: publishing J2 (false -> true) makes it appear automatically, no separate wiring needed", () => {
  const j2 = { id: "j2", number: 2, published: false };
  const meta = { rounds: [{ id: "j1", number: 1, published: true }, j2] };
  assert.equal(runVisibleRounds(meta, { isAdmin: true }).length, 1);
  j2.published = true;
  assert.equal(runVisibleRounds(meta, { isAdmin: true }).length, 2);
});

test("Caso D legacy: published === undefined behaves exactly like published:true", () => {
  const meta = { rounds: [{ id: "legacy", number: 1 }] }; // no published field at all
  const result = runVisibleRounds(meta, { isAdmin: true });
  assert.deepEqual(result.map((r) => r.id), ["legacy"]);
});

test("Caso E: 17 imported rounds all published:false -> zero candidates for Participación (empty state)", () => {
  const rounds = [];
  for (let n = 1; n <= 17; n++) rounds.push({ id: "j" + n, number: n, published: false });
  const meta = { rounds };
  const result = runVisibleRounds(meta, { isAdmin: true });
  assert.equal(result.length, 0);
});

test("Caso F: Copiar/WhatsApp reminders are built only from openRounds (already filtered) -- no separate unfiltered path", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminParticipacion(body)");
  assert.ok(body.includes("openRounds.find(r => r.id === btn.dataset.copy)"), "the Copiar handler must resolve its round from the already-filtered openRounds list");
  assert.ok(body.includes("openRounds.find(r => r.id === btn.dataset.whatsapp)"), "the WhatsApp handler must resolve its round from the already-filtered openRounds list");
});

test("Caso G: Admin -> Jornadas (renderAdminRondas) still lists meta.rounds directly, unaffected by this fix", () => {
  const body = extractFunctionBody(indexSrc, "async function renderAdminRondas(body)");
  assert.ok(body.includes("meta.rounds.length ? meta.rounds.slice().reverse()"), "Admin -> Jornadas must keep showing every round, including unpublished ones, untouched by the Participación fix");
});
