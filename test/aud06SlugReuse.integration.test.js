// aud06SlugReuse.integration.test.js — AUD-06c: un slug que conserva
// pronósticos huérfanos (de una quiniela borrada antes de AUD-06b) no se
// vuelve a usar, ni al crear ni al migrar. Servidor real y PostgreSQL local
// desechable (test/helpers/realServer.js; sin ella, cada prueba sale SKIPPED).
//
// El fallo: la huérfana respondía 404, pero al crear otra quiniela con ese slug
// la fila volvía a leerse (sus jornadas no existen en la meta nueva y se
// tomaban por cerradas). Ahora ese alta o movimiento recibe el mismo
// «slug_taken» que un slug ocupado, sin crear nada ni tocar las filas viejas.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  itest, setup, teardown, dbQuery, withRowLocked, freshIp, call, PLATFORM_PASSWORD,
} = require("./helpers/realServer");

const enc = (k) => "/api/kv/" + encodeURIComponent(k);
const row = async (key) => {
  const r = await dbQuery("SELECT value FROM kv WHERE key = $1", [key]);
  return r.rows.length ? r.rows[0].value : null;
};
const indexHas = async (slug) => {
  const idx = await row("platform_index");
  return !!(idx && Array.isArray(idx.quinielas) && idx.quinielas.some((q) => q.slug === slug));
};
const create = (slug) => call("POST", "/api/create-quiniela", { ip: freshIp(), body: { slug, groupName: "Nueva " + slug, creatorName: "Zoe", contact: "it", password: "pw-" + crypto.randomBytes(4).toString("hex") } });
const newSlug = (p) => `${p}-${crypto.randomBytes(3).toString("hex")}`;
async function plantOrphan(slug) {
  const key = `quiniela:${slug}:picks:p_old${crypto.randomBytes(3).toString("hex")}`;
  const value = { rOld: { m1: "A" } };
  await dbQuery("INSERT INTO kv (key, value) VALUES ($1, $2)", [key, JSON.stringify(value)]);
  return { key, value };
}
async function waitForLockWaiters(n) {
  for (let i = 0; i < 200; i++) {
    const r = await dbQuery("SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r.rows[0].c >= n) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no llegaron ${n} esperas de bloqueo`);
}

test.describe("AUD-06c: un slug con pronósticos huérfanos no se reutiliza (real server)", () => {
  test.before(setup);
  test.after(teardown);

  itest("crear con un slug que tiene una huérfana: 409 slug_taken, sin meta ni índice; la fila no cambia y sigue protegida", async () => {
    const slug = newSlug("reuso");
    const orphan = await plantOrphan(slug);
    assert.equal((await call("GET", enc(orphan.key), { ip: freshIp() })).status, 404);
    const r = await create(slug);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "slug_taken");
    assert.ok(!JSON.stringify(r.body).includes("rOld") && !JSON.stringify(r.body).includes("p_old"), "el rechazo no revela nada");
    assert.equal(await row(`quiniela:${slug}:meta`), null, "no se creó la meta");
    assert.equal(await indexHas(slug), false, "no se añadió al índice");
    assert.deepEqual(await row(orphan.key), orphan.value, "la fila vieja no cambia");
    const after = await call("GET", enc(orphan.key), { ip: freshIp() });
    assert.equal(after.status, 404, "la lectura antigua sigue protegida tras el intento");
  });

  itest("migrar hacia un slug con una huérfana: 409 slug_taken; la quiniela antigua, el índice y la fila quedan igual", async () => {
    const slug = newSlug("migra");
    const orphan = await plantOrphan(slug);
    const ownerPw = "legacy-" + crypto.randomBytes(4).toString("hex");
    const legacy = { groupName: "Antigua", settings: { ownerPassword: ownerPw }, participants: [{ id: "pl1", name: "Leo", isAdmin: true, paid: false }], rounds: [] };
    await dbQuery("INSERT INTO kv (key, value) VALUES ('quiniela_meta_v1', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(legacy)]);
    const idxBefore = await row("platform_index");
    const r = await call("POST", "/api/migrate-quiniela", { ip: freshIp(), headers: { "X-Qracks-Auth": ownerPw }, body: { toSlug: slug } });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "slug_taken");
    assert.deepEqual(await row("quiniela_meta_v1"), legacy, "la quiniela antigua no se movió");
    assert.equal(await row(`quiniela:${slug}:meta`), null);
    assert.deepEqual(await row("platform_index"), idxBefore);
    assert.deepEqual(await row(orphan.key), orphan.value);
    assert.equal((await call("GET", enc(orphan.key), { ip: freshIp() })).status, 404);
    // Con un destino libre, la misma migración sí funciona.
    const free = newSlug("migra-libre");
    const ok = await call("POST", "/api/migrate-quiniela", { ip: freshIp(), headers: { "X-Qracks-Auth": ownerPw }, body: { toSlug: free } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(await row(`quiniela:${free}:meta`));
    assert.equal(await indexHas(free), true);
  });

  itest("destino libre: crear funciona; y un slug borrado limpiamente se puede volver a usar", async () => {
    const slug = newSlug("libre");
    const r = await create(slug);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(await row(`quiniela:${slug}:meta`));
    // Borrado normal (se lleva sus pronósticos): el slug queda limpio y se reutiliza.
    const del = await call("POST", "/api/delete-quiniela", { ip: freshIp(), headers: { "X-Qracks-Platform-Auth": PLATFORM_PASSWORD }, body: { slug } });
    assert.equal(del.status, 200);
    const again = await create(slug);
    assert.equal(again.status, 200, JSON.stringify(again.body));
  });

  itest("concurrencia: altas simultáneas no se saltan la comprobación (huérfano: todas 409; libre: una sola 200)", async () => {
    const dirty = newSlug("conc-sucio");
    const orphan = await plantOrphan(dirty);
    const clean = newSlug("conc-limpio");
    let dirtyReqs, cleanReqs;
    await withRowLocked("platform_index", async () => {
      dirtyReqs = Array.from({ length: 4 }, () => create(dirty));
      cleanReqs = Array.from({ length: 4 }, () => create(clean));
      await waitForLockWaiters(8);
    });
    const d = await Promise.all(dirtyReqs);
    const c = await Promise.all(cleanReqs);
    assert.deepEqual(d.map((x) => x.status), [409, 409, 409, 409], JSON.stringify(d.map((x) => x.body)));
    assert.equal(c.filter((x) => x.status === 200).length, 1, JSON.stringify(c.map((x) => x.status)));
    assert.equal(c.filter((x) => x.status === 409).length, 3);
    assert.equal(await row(`quiniela:${dirty}:meta`), null);
    assert.equal(await indexHas(dirty), false);
    assert.deepEqual(await row(orphan.key), orphan.value);
    assert.equal((await call("GET", enc(orphan.key), { ip: freshIp() })).status, 404);
  });
});
