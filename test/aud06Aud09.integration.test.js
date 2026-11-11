// aud06Aud09.integration.test.js — AUD-06 contra el servidor real y una base
// PostgreSQL local desechable (test/helpers/realServer.js; sin ella, cada
// prueba sale como SKIPPED).
//
// AUD-06  Escribir pronósticos de una quiniela que no existe se rechaza con
//         404 y no crea ni modifica ninguna fila, tampoco una fila huérfana
//         que ya estuviera. En las quinielas que existen siguen igual la
//         identidad, los permisos y el cierre, y los caminos legítimos
//         (registro, primer acceso con PIN nuevo, sesión, guardado).

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  itest, setup, teardown, dbQuery, freshIp, call, Browser, kvPath, quiniela,
} = require("./helpers/realServer");

const enc = (k) => "/api/kv/" + encodeURIComponent(k);
const picksKey = (slug, pid) => `quiniela:${slug}:picks:${pid}`;
const pinHeaders = (who) => ({ "X-Qracks-Auth": who.pin, "X-Qracks-Participant": who.id });
const row = async (key) => {
  const r = await dbQuery("SELECT value::text AS v FROM kv WHERE key = $1", [key]);
  return r.rows.length ? r.rows[0].v : null;
};
const inDays = (d) => new Date(Date.now() + d * 24 * 3600 * 1000).toISOString();
const matches = (rid) => [
  { id: rid + "-m1", teamA: "Halcones", teamB: "Toros" },
  { id: rid + "-m2", teamA: "Lobos", teamB: "Águilas" },
];
async function withRounds(tag, rounds) {
  const q = await quiniela(tag);
  const m = (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
  m.rounds = rounds;
  await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(m)]);
  return q;
}
const openRound = () => ({ id: "r1", number: 1, deadline: inDays(3), published: true, results: {}, resultsPublished: false, matches: matches("r1") });

test.describe("AUD-06: pronósticos sólo en quinielas que existen (real server)", () => {
  test.before(setup);
  test.after(teardown);

  itest("AUD-06 a · quiniela inexistente: 404 sin crear fila (anónimo y con cabeceras de PIN inventadas)", async () => {
    const slug = "no-existe-" + crypto.randomBytes(3).toString("hex");
    const key = picksKey(slug, "p_fantasma");
    const anon = await call("POST", enc(key), { ip: freshIp(), body: { value: { r1: { m1: "A" } } } });
    assert.equal(anon.status, 404);
    assert.equal(anon.body.error, "not_found");
    const withPin = await call("POST", enc(key), { ip: freshIp(), headers: { "X-Qracks-Auth": "1234", "X-Qracks-Participant": "p_fantasma" }, body: { value: { r1: { m1: "B" } }, base: {} } });
    assert.equal(withPin.status, 404);
    assert.equal(await row(key), null, "no se creó la fila");
    // Lo mismo en la familia antigua (quiniela_picks_<pid>_v1, sin quiniela_meta_v1).
    const legacy = `quiniela_picks_pfantasma${crypto.randomBytes(2).toString("hex")}_v1`;
    const hadLegacyMeta = await row("quiniela_meta_v1");
    if (hadLegacyMeta === null) {
      const r = await call("POST", enc(legacy), { ip: freshIp(), body: { value: { r1: { m1: "A" } } } });
      assert.equal(r.status, 404);
      assert.equal(await row(legacy), null);
    }
  });

  itest("AUD-06 b · fila huérfana ya existente: el rechazo no la pisa ni la borra", async () => {
    const slug = "huerfana-" + crypto.randomBytes(3).toString("hex");
    const key = picksKey(slug, "p_viejo");
    const before = JSON.stringify({ r1: { m1: "D" } });
    await dbQuery("INSERT INTO kv (key, value) VALUES ($1, $2)", [key, before]);
    const stored = await row(key);
    const r = await call("POST", enc(key), { ip: freshIp(), body: { value: { r1: { m1: "A" }, extra: "x".repeat(2000) } } });
    assert.equal(r.status, 404);
    assert.equal(await row(key), stored, "la fila huérfana sigue idéntica");
    const r2 = await call("POST", enc(key), { ip: freshIp(), body: { value: { r1: { m1: "B" } }, base: { r1: { m1: "D" } } } });
    assert.equal(r2.status, 404);
    assert.equal(await row(key), stored);
  });

  itest("AUD-06 c · quiniela existente: sin PIN, con PIN ajeno o como alguien que no está en la lista → 403 sin escribir", async () => {
    const q = await withRounds("a06c", [openRound()]);
    const key = picksKey(q.slug, q.beto.id);
    const anon = await call("POST", enc(key), { ip: freshIp(), body: { value: { r1: { "r1-m1": "A" } }, base: {} } });
    assert.equal(anon.status, 403);
    const foreign = await call("POST", enc(key), { ip: freshIp(), headers: pinHeaders(q.ana), body: { value: { r1: { "r1-m1": "A" } }, base: {} } });
    assert.equal(foreign.status, 403);
    const ghostKey = picksKey(q.slug, "p_noesta");
    const ghost = await call("POST", enc(ghostKey), { ip: freshIp(), headers: { "X-Qracks-Auth": "1111", "X-Qracks-Participant": "p_noesta" }, body: { value: { r1: { "r1-m1": "A" } }, base: {} } });
    assert.equal(ghost.status, 403);
    assert.equal(await row(key), null);
    assert.equal(await row(ghostKey), null);
  });

  itest("AUD-06 d · caminos legítimos: registro + guardado con PIN, sesión del navegador, y primer acceso de alguien sin PIN", async () => {
    const q = await withRounds("a06d", [openRound()]);
    // Registro (en quiniela()) y guardado con PIN.
    const saved = await call("POST", enc(picksKey(q.slug, q.beto.id)), { ip: q.betoPhone.ip, headers: pinHeaders(q.beto), body: { value: { r1: { "r1-m1": "A" } }, base: {} } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(JSON.parse(await row(picksKey(q.slug, q.beto.id))), { r1: { "r1-m1": "A" } });
    // Con la sesión del navegador (cookie de self-register), sin cabecera de PIN.
    const bySession = q.betoPhone.take(await call("POST", enc(picksKey(q.slug, q.beto.id)), {
      ip: q.betoPhone.ip, cookie: q.betoPhone.cookie, headers: { "X-Qracks-Participant": q.beto.id },
      body: { value: { r1: { "r1-m1": "A", "r1-m2": "D" } }, base: { r1: { "r1-m1": "A" } } },
    }));
    assert.equal(bySession.status, 200, JSON.stringify(bySession.body));
    // Primer acceso: el admin añade a Carla sin PIN; ella elige su PIN y guarda.
    const meta = (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
    const carlaId = "p_" + crypto.randomBytes(6).toString("hex");
    meta.participants.push({ id: carlaId, name: "Carla", isAdmin: false, paid: false });
    await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(meta)]);
    const noPin = await call("POST", enc(picksKey(q.slug, carlaId)), { ip: freshIp(), headers: { "X-Qracks-Participant": carlaId }, body: { value: { r1: { "r1-m1": "B" } }, base: {} } });
    assert.equal(noPin.status, 403);
    assert.equal(noPin.body.error, "pin_required");
    const carlaPhone = Browser(freshIp());
    const setPin = carlaPhone.take(await call("POST", "/api/set-pin", { ip: carlaPhone.ip, body: { metaKey: q.metaKey, participantId: carlaId, newPin: "1357" } }));
    assert.equal(setPin.status, 200, JSON.stringify(setPin.body));
    const carlaSave = await call("POST", enc(picksKey(q.slug, carlaId)), { ip: carlaPhone.ip, headers: { "X-Qracks-Auth": "1357", "X-Qracks-Participant": carlaId }, body: { value: { r1: { "r1-m1": "B" } }, base: {} } });
    assert.equal(carlaSave.status, 200, JSON.stringify(carlaSave.body));
  });

  itest("AUD-06 e · el cierre de jornada se sigue respetando (403 round_locked sin escribir)", async () => {
    const q = await withRounds("a06e", [{ ...openRound(), deadline: inDays(-1) }]);
    const key = picksKey(q.slug, q.beto.id);
    const r = await call("POST", enc(key), { ip: q.betoPhone.ip, headers: pinHeaders(q.beto), body: { value: { r1: { "r1-m1": "A" } }, base: {} } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "round_locked");
    assert.equal(await row(key), null);
  });
});
