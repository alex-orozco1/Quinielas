// aud06DeleteRace.integration.test.js — borrar una quiniela mientras alguien
// guarda, y leer pronósticos de una quiniela que ya no existe. Servidor real y
// PostgreSQL local desechable (test/helpers/realServer.js; sin ella, SKIPPED).
//
// El fallo: /api/delete-quiniela borraba los pronósticos ANTES de bloquear la
// meta. Un guardado que esperaba ese bloqueo escribía su fila después del
// borrado de pronósticos y antes del de la meta: la fila quedaba huérfana, y
// GET /api/kv la devolvía completa a cualquiera porque, sin meta, no se
// filtraba nada. Ahora el borrado bloquea platform_index → meta (el orden de
// todo el archivo) antes de tocar nada, y sin meta no se devuelve ningún
// pronóstico.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  itest, setup, teardown, dbQuery, withRowLocked, freshIp, call, quiniela, PLATFORM_PASSWORD,
} = require("./helpers/realServer");

const enc = (k) => "/api/kv/" + encodeURIComponent(k);
const picksKey = (slug, pid) => `quiniela:${slug}:picks:${pid}`;
const pinHeaders = (who) => ({ "X-Qracks-Auth": who.pin, "X-Qracks-Participant": who.id });
const platform = { "X-Qracks-Platform-Auth": PLATFORM_PASSWORD };
const row = async (key) => {
  const r = await dbQuery("SELECT value FROM kv WHERE key = $1", [key]);
  return r.rows.length ? r.rows[0].value : null;
};
const inDays = (d) => new Date(Date.now() + d * 24 * 3600 * 1000).toISOString();
const round = (id, deadline) => ({ id, number: Number(id.slice(1)), deadline, published: true, results: {}, resultsPublished: false,
  matches: [{ id: id + "-m1", teamA: "Halcones", teamB: "Toros" }, { id: id + "-m2", teamA: "Lobos", teamB: "Águilas" }] });
async function withRounds(tag, rounds) {
  const q = await quiniela(tag);
  const m = (await dbQuery("SELECT value FROM kv WHERE key = $1", [q.metaKey])).rows[0].value;
  m.rounds = rounds;
  await dbQuery("UPDATE kv SET value = $2 WHERE key = $1", [q.metaKey, JSON.stringify(m)]);
  return q;
}
// Espera hasta que haya `n` peticiones esperando un bloqueo en esta base: así
// el orden de llegada es el que dice la prueba, sin depender de tiempos.
async function waitForLockWaiters(n) {
  for (let i = 0; i < 200; i++) {
    const r = await dbQuery("SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r.rows[0].c >= n) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no llegaron ${n} esperas de bloqueo`);
}
const save = (q, value) => call("POST", enc(picksKey(q.slug, q.beto.id)), { ip: q.betoPhone.ip, headers: pinHeaders(q.beto), body: { value, base: {} } });
const del = (q) => call("POST", "/api/delete-quiniela", { ip: freshIp(), headers: platform, body: { slug: q.slug } });

test.describe("AUD-06b: borrar una quiniela no deja pronósticos legibles (real server)", () => {
  test.before(setup);
  test.after(teardown);

  itest("carrera · el guardado espera la meta, el borrado llega después: no queda fila huérfana ni se lee nada", async () => {
    const q = await withRounds("race1", [round("r1", inDays(3))]);
    let saved, deleted;
    await withRowLocked(q.metaKey, async () => {
      saved = save(q, { r1: { "r1-m1": "A" } });
      await waitForLockWaiters(1);
      deleted = del(q);
      await waitForLockWaiters(2);
    });
    const [s, d] = await Promise.all([saved, deleted]);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(await row(q.metaKey), null, "la meta se borró");
    assert.equal(await row(picksKey(q.slug, q.beto.id)), null, "el pronóstico guardado antes del borrado también se borró");
    const anon = await call("GET", enc(picksKey(q.slug, q.beto.id)), { ip: freshIp() });
    assert.equal(anon.status, 404);
  });

  itest("guardado primero y borrado después (sin carrera): se borra todo", async () => {
    const q = await withRounds("seq1", [round("r1", inDays(3))]);
    assert.equal((await save(q, { r1: { "r1-m1": "B" } })).status, 200);
    assert.equal((await del(q)).status, 200);
    assert.equal(await row(picksKey(q.slug, q.beto.id)), null);
    assert.equal(await row(q.metaKey), null);
  });

  itest("borrado primero y guardado después (el guardado espera al borrado): 404 y nada se escribe", async () => {
    const q = await withRounds("race2", [round("r1", inDays(3))]);
    let deleted, saved;
    await withRowLocked(q.metaKey, async () => {
      deleted = del(q);
      await waitForLockWaiters(1);
      saved = save(q, { r1: { "r1-m2": "D" } });
      await waitForLockWaiters(2);
    });
    const [d, s] = await Promise.all([deleted, saved]);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(s.status, 404, JSON.stringify(s.body));
    assert.equal(await row(picksKey(q.slug, q.beto.id)), null);
    // Y después del borrado, también.
    const later = await save(q, { r1: { "r1-m1": "A" } });
    assert.equal(later.status, 404);
    assert.equal(await row(picksKey(q.slug, q.beto.id)), null);
  });

  itest("fila huérfana que ya existía: la lectura anónima no la devuelve (ni la familia antigua); la fila no se borra", async () => {
    const slug = "huerfana-" + crypto.randomBytes(3).toString("hex");
    const key = picksKey(slug, "p_viejo");
    await dbQuery("INSERT INTO kv (key, value) VALUES ($1, $2)", [key, JSON.stringify({ r1: { m1: "A" }, r9: { m1: "D" } })]);
    const anon = await call("GET", enc(key), { ip: freshIp() });
    assert.equal(anon.status, 404, JSON.stringify(anon.body));
    assert.ok(!JSON.stringify(anon.body).includes('"m1"'), "no se filtra ningún pronóstico");
    const withPin = await call("GET", enc(key), { ip: freshIp(), headers: { "X-Qracks-Auth": "1234", "X-Qracks-Participant": "p_viejo" } });
    assert.equal(withPin.status, 404);
    assert.ok(await row(key), "la fila sigue en la base: no se limpia nada");
    if ((await row("quiniela_meta_v1")) === null) {
      const legacy = `quiniela_picks_pviejo${crypto.randomBytes(2).toString("hex")}_v1`;
      await dbQuery("INSERT INTO kv (key, value) VALUES ($1, $2)", [legacy, JSON.stringify({ r1: { m1: "B" } })]);
      const l = await call("GET", enc(legacy), { ip: freshIp() });
      assert.equal(l.status, 404);
      assert.ok(await row(legacy));
    }
  });

  itest("rollback del borrado: si algo falla a mitad, no se pierde nada (ni pronósticos, ni meta, ni índice)", async () => {
    const q = await withRounds("rollback", [round("r1", inDays(3))]);
    assert.equal((await save(q, { r1: { "r1-m1": "A" } })).status, 200);
    const idxBefore = await row("platform_index");
    const before = { picks: await row(picksKey(q.slug, q.beto.id)), meta: await row(q.metaKey) };
    // Un fallo real de la base justo al borrar la meta de ESTA quiniela.
    const fn = "aud06_fail_" + crypto.randomBytes(3).toString("hex");
    await dbQuery(`CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN IF OLD.key = '${q.metaKey}' THEN RAISE EXCEPTION 'falla de prueba'; END IF; RETURN OLD; END $$ LANGUAGE plpgsql`);
    await dbQuery(`CREATE TRIGGER ${fn} BEFORE DELETE ON kv FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const d = await del(q);
      assert.equal(d.status, 500);
    } finally {
      await dbQuery(`DROP TRIGGER ${fn} ON kv`);
      await dbQuery(`DROP FUNCTION ${fn}()`);
    }
    assert.deepEqual(await row(picksKey(q.slug, q.beto.id)), before.picks, "los pronósticos siguen");
    assert.deepEqual(await row(q.metaKey), before.meta, "la meta sigue");
    assert.deepEqual(await row("platform_index"), idxBefore, "el índice sigue");
    // El participante sigue pudiendo guardar.
    assert.equal((await save(q, { r1: { "r1-m1": "A", "r1-m2": "B" } })).status, 200);
  });

  itest("privacidad habitual: jornada abierta sólo para su dueño (admin ve que existe), cerrada para todos", async () => {
    const q = await withRounds("priv", [round("r1", inDays(3)), round("r2", inDays(-1))]);
    // r2 ya cerró: su pronóstico se escribe directo en la base.
    await dbQuery("INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [picksKey(q.slug, q.beto.id), JSON.stringify({ r2: { "r2-m1": "B" } })]);
    assert.equal((await save(q, { r1: { "r1-m1": "A" } })).status, 200);
    const key = enc(picksKey(q.slug, q.beto.id));
    const anon = await call("GET", key, { ip: freshIp() });
    assert.equal(anon.status, 200);
    assert.deepEqual(anon.body.value, { r2: { "r2-m1": "B" } }, "anónimo: sólo la jornada cerrada");
    const self = await call("GET", key, { ip: q.betoPhone.ip, headers: pinHeaders(q.beto) });
    assert.deepEqual(self.body.value, { r1: { "r1-m1": "A" }, r2: { "r2-m1": "B" } }, "su dueño lo ve todo");
    const admin = await call("GET", key, { ip: freshIp(), headers: pinHeaders(q.ana) });
    assert.deepEqual(admin.body.value, { r1: { "r1-m1": true }, r2: { "r2-m1": "B" } }, "el admin sólo ve que respondió en la abierta");
    const batch = await call("POST", "/api/picks-batch", { ip: freshIp(), body: { metaKey: q.metaKey, slug: q.slug, participantIds: [q.beto.id] } });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.deepEqual(batch.body.picks[q.beto.id], { r2: { "r2-m1": "B" } }, "por lote, igual que anónimo");
  });

  itest("quiniela antigua migrada: sus pronósticos (quiniela_picks_<pid>_v1) dejan de leerse; los de la nueva siguen filtrados", async () => {
    // Una quiniela de antes de los slugs, con una jornada abierta.
    const pid = "pleg" + crypto.randomBytes(3).toString("hex");
    const ownerPw = "legacy-" + crypto.randomBytes(4).toString("hex");
    const legacyMeta = { groupName: "Antigua", settings: { ownerPassword: ownerPw }, participants: [{ id: pid, name: "Leo", isAdmin: true, paid: false }],
      rounds: [round("r1", inDays(3))] };
    await dbQuery("INSERT INTO kv (key, value) VALUES ('quiniela_meta_v1', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(legacyMeta)]);
    const legacyKey = `quiniela_picks_${pid}_v1`;
    const picks = { r1: { "r1-m1": "A", "r1-m2": "B" } };
    await dbQuery("INSERT INTO kv (key, value) VALUES ($1, $2)", [legacyKey, JSON.stringify(picks)]);
    const before = await call("GET", enc(legacyKey), { ip: freshIp() });
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.value, {}, "antes de migrar: la jornada abierta no se ve");
    const toSlug = "migrada-" + crypto.randomBytes(3).toString("hex");
    const mig = await call("POST", "/api/migrate-quiniela", { ip: freshIp(), headers: { "X-Qracks-Auth": ownerPw }, body: { toSlug } });
    assert.equal(mig.status, 200, JSON.stringify(mig.body));
    assert.ok((await row("quiniela_meta_v1")).migratedTo, "la meta antigua queda como { migratedTo }");
    const after = await call("GET", enc(legacyKey), { ip: freshIp() });
    assert.equal(after.status, 404, JSON.stringify(after.body));
    assert.ok(!JSON.stringify(after.body).includes("r1-m1"), "no se filtra ningún pronóstico");
    assert.deepEqual(await row(legacyKey), picks, "la fila antigua no se borra");
    // En la quiniela nueva, la jornada abierta sigue oculta para un anónimo.
    const fresh = await call("GET", enc(picksKey(toSlug, pid)), { ip: freshIp() });
    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.body.value, {});
  });
});
