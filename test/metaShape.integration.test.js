// metaShape.integration.test.js — la forma de la meta, con el servidor real:
// lo que no es lista u objeto donde debe no entra, los campos del dueño
// siguen protegidos, y lo que ya estaba guardado se sigue pudiendo guardar.
//
// Usa el servidor real y una PostgreSQL local desechable (test/helpers/realServer.js):
//
//   pg_ctlcluster 16 main start
//   export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/metaShape.integration.test.js
//
// Sin QRACKS_TEST_DATABASE_URL, cada test sale como SKIPPED, con el motivo.

const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, dbQuery, call, kvPath, quiniela } = require("./helpers/realServer");

const MARCADO = '<img src=x onerror="alert(1)">';
const asOwner = (q) => ({ headers: { "X-Qracks-Auth": q.owner } });
// Ana con su PIN: admin, pero sin la contraseña del dueño.
const asAdminPin = (q) => ({ ip: q.anaPhone.ip, cookie: q.anaPhone.cookie, headers: { "X-Qracks-Auth": q.ana.pin, "X-Qracks-Participant": q.ana.id } });
const read = async (q, as) => (await call("GET", kvPath(q.slug), as)).body.value;
const write = (q, as, value) => call("POST", kvPath(q.slug), { ...as, body: { value } });
const stored = async (q) => (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
const ownerOk = async (q, password) => (await call("POST", "/api/verify-owner", { body: { metaKey: q.metaKey, password } })).body;

test.describe("forma de la meta (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("un admin con PIN no puede guardar `settings` como lista: 400 y la contraseña del dueño sigue valiendo", async () => {
    const q = await quiniela("shape-owner");
    const antes = await stored(q);
    for (const raro of [[], ["x"], "x"]) {
      const v = await read(q, asAdminPin(q));
      v.settings = raro;
      const r = await write(q, asAdminPin(q), v);
      assert.deepEqual([r.status, r.body], [400, { error: "invalid_value", field: "settings" }], JSON.stringify(raro));
    }
    assert.deepEqual(await stored(q), antes, "la fila sigue intacta");
    assert.equal((await ownerOk(q, q.owner)).ok, true, "la contraseña del dueño no se perdió");
    // Y como sigue habiendo contraseña, el admin con PIN tampoco puede poner otra.
    const v = await read(q, asAdminPin(q));
    v.settings = { ...v.settings, ownerPassword: "otra-contrasena-1" };
    assert.equal((await write(q, asAdminPin(q), v)).status, 200);
    assert.equal((await ownerOk(q, "otra-contrasena-1")).ok, false);
    assert.equal((await ownerOk(q, q.owner)).ok, true);
  });

  itest("partidos que no son lista, o penalización y apuestas con otra forma: 400 invalid_value y nada cambia", async () => {
    const q = await quiniela("shape-matches");
    const antes = await stored(q);
    const ronda = (matches) => ({ id: "r_shape001", number: 1, deadline: new Date(Date.now() - 864e5).toISOString(), results: {}, resultsPublished: false, published: true, matches });
    const casos = {
      "rounds.matches": (v) => v.rounds.push(ronda({ length: MARCADO })),
      paymentPenalty: (v) => { v.paymentPenalty = [MARCADO]; },
      customBets: (v) => { v.customBets = { length: MARCADO }; },
      "participants.penalizedRounds": (v) => { v.participants[0].penalizedRounds = MARCADO; },
    };
    for (const [field, set] of Object.entries(casos)) {
      const v = await read(q, asOwner(q)); set(v);
      const r = await write(q, asOwner(q), v);
      assert.deepEqual([r.status, r.body], [400, { error: "invalid_value", field }], field);
    }
    assert.deepEqual(await stored(q), antes, "la fila sigue intacta");
  });

  itest("lo que ya estaba guardado con otra forma no impide seguir guardando la quiniela", async () => {
    const q = await quiniela("shape-legacy");
    const v0 = await stored(q);
    v0.rounds.push({ id: "r_legacy01", number: 1, deadline: new Date(Date.now() + 2 * 864e5).toISOString(), results: {}, resultsPublished: false, published: true });
    v0.auditLog = { legado: true };
    await dbQuery("UPDATE kv SET value = $2::jsonb WHERE key = $1", [q.metaKey, JSON.stringify(v0)]);
    const v = await read(q, asOwner(q));
    v.groupName = "Otro nombre";
    const r = await write(q, asOwner(q), v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await stored(q);
    assert.deepEqual([s.groupName, "matches" in s.rounds[0], s.auditLog], ["Otro nombre", false, { legado: true }]);
  });

  itest("el link de la quiniela lleva el nombre tal cual en <title> y og:title, aunque traiga `$'` o `$&`", async () => {
    const q = await quiniela("shape-title");
    const v = await read(q, asOwner(q));
    v.groupName = `Liga $' y $& "amigos"`;
    assert.equal((await write(q, asOwner(q), v)).status, 200);
    const page = await call("GET", "/q/" + q.slug);
    assert.equal(page.status, 200);
    const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const title = `${esc(v.groupName)} · QRACKS`;
    assert.ok(page.text.includes(`<title id="page-title">${title}</title>`), "el <title> lleva el nombre escapado, sin reemplazos");
    assert.ok(page.text.includes(`<meta property="og:title" content="${title}" id="og-title">`), "og:title igual");
    assert.equal((page.text.match(/<title/g) || []).length, 1, "el <head> no se duplica dentro de un atributo");
  });

  itest("registrarse en la quiniela heredada que ya se mudó: 404 y la fila no cambia", async () => {
    await dbQuery("INSERT INTO kv (key, value) VALUES ('quiniela_meta_v1', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ migratedTo: "a-donde-se-fue" })]);
    for (const name of ["Eve", "Frida"]) {
      const r = await call("POST", "/api/self-register", { body: { metaKey: "quiniela_meta_v1", name, pin: "1357" } });
      assert.deepEqual([r.status, r.body], [404, { error: "not_found" }], name);
    }
    const row = (await dbQuery("SELECT value FROM kv WHERE key = 'quiniela_meta_v1'")).rows[0].value;
    assert.deepEqual(row, { migratedTo: "a-donde-se-fue" });
  });
});
