// Las rutas públicas que reciben `metaKey` en el cuerpo sólo pueden apuntar a
// la meta de una quiniela, nunca a otra fila de kv (platform_index,
// commercial_config, las de pagos...).
//
// La prueba estructural corre siempre. Las del servidor real usan una
// PostgreSQL local desechable (test/helpers/realServer.js):
//
//   pg_ctlcluster 16 main start
//   export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/metaKeyScope.test.js
//
// Sin QRACKS_TEST_DATABASE_URL, esas salen como SKIPPED, con el motivo.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { itest, setup, teardown, dbQuery, call, quiniela } = require("./helpers/realServer");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const ROUTES = ["/api/verify-owner", "/api/verify-pin", "/api/set-pin", "/api/recover-admin-pin", "/api/verify-session", "/api/self-register"];
const CHECK = 'if (!isQuinielaMetaKey(metaKey)) return res.status(400).json({ error: "invalid_metaKey" });';

test("metaKey · cada ruta pública que lo recibe comprueba que nombre la meta de una quiniela, antes de leer nada", () => {
  for (const route of ROUTES) {
    const start = serverSrc.indexOf(`app.post("${route}"`);
    assert.ok(start !== -1, route);
    const next = serverSrc.indexOf("\napp.", start + 1);
    const handler = serverSrc.slice(start, next === -1 ? undefined : next);
    const at = handler.indexOf(CHECK);
    assert.ok(at !== -1, `${route} comprueba la clave`);
    for (const read of ["getRow(metaKey", "getRowLocked(metaKey", "readSessionFromCookie("]) {
      const r = handler.indexOf(read);
      if (r !== -1) assert.ok(at < r, `${route}: la comprobación va antes de ${read}`);
    }
  }
  assert.match(serverSrc, /function isQuinielaMetaKey\(key\) \{\n  return key === "quiniela_meta_v1" \|\| \(typeof key === "string" && \/\^quiniela:\[a-z0-9-\]\{1,60\}:meta\$\/\.test\(key\)\);\n\}/);
});

const AJENAS = ["platform_index", "commercial_config", "platform_payment_log", "platform_payment_intents", "__session_secret__"];
const kvRow = async (key) => { const r = await dbQuery("SELECT value FROM kv WHERE key = $1", [key]); return r.rows[0] ? r.rows[0].value : null; };

test.describe("metaKey (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("registrarse con una clave que no es la meta de una quiniela: 400 invalid_metaKey y la fila no cambia", async () => {
    const q = await quiniela("mk");
    for (const key of [...AJENAS, `quiniela:${q.slug}:picks:${q.ana.id}`, `${q.metaKey} `, [q.metaKey]]) {
      const antes = typeof key === "string" ? await kvRow(key) : null;
      const r = await call("POST", "/api/self-register", { body: { metaKey: key, name: "Eve", pin: "1357", slug: q.slug } });
      assert.deepEqual([r.status, r.body], [400, { error: "invalid_metaKey" }], JSON.stringify(key));
      if (typeof key === "string") assert.deepEqual(await kvRow(key), antes, `${key} intacta`);
    }
    // Sin clave sigue siendo un error de parámetros, como antes.
    const sin = await call("POST", "/api/self-register", { body: { name: "Eve", pin: "1357", slug: q.slug } });
    assert.deepEqual([sin.status, sin.body], [400, { error: "invalid_params" }]);
    // Y registrarse en la quiniela de verdad sigue funcionando.
    const ok = await call("POST", "/api/self-register", { body: { metaKey: q.metaKey, name: "Eve", pin: "1357", slug: q.slug } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  itest("las rutas de PIN, contraseña y sesión tampoco aceptan otra fila", async () => {
    const q = await quiniela("mk-pin");
    const bodies = {
      "/api/verify-owner": (k) => ({ metaKey: k, password: q.owner }),
      "/api/verify-pin": (k) => ({ metaKey: k, participantId: q.ana.id, pin: q.ana.pin }),
      "/api/set-pin": (k) => ({ metaKey: k, participantId: q.ana.id, newPin: "9753" }),
      "/api/recover-admin-pin": (k) => ({ metaKey: k, participantId: q.ana.id, newPin: "9753" }),
      "/api/verify-session": (k) => ({ metaKey: k, slug: q.slug }),
    };
    for (const [route, body] of Object.entries(bodies)) {
      for (const key of ["platform_index", "commercial_config"]) {
        const antes = await kvRow(key);
        const r = await call("POST", route, { headers: { "X-Qracks-Auth": q.owner }, body: body(key) });
        assert.deepEqual([r.status, r.body], [400, { error: "invalid_metaKey" }], `${route} ${key}`);
        assert.deepEqual(await kvRow(key), antes, `${route}: ${key} intacta`);
      }
    }
    // Con la clave de la quiniela, la contraseña del dueño sigue valiendo.
    const ok = await call("POST", "/api/verify-owner", { body: { metaKey: q.metaKey, password: q.owner } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ok, true);
  });
});
