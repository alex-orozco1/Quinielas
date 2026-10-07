// paymentLedger.integration.test.js — S2: el libro de pagos sólo lo escribe el
// servidor.
//
// Antes, con la contraseña de plataforma, POST y DELETE /api/kv/platform_payment_log
// reescribían o borraban el libro sin dejar rastro. Ahora el endpoint genérico lo
// rechaza (403 server_owned_key), igual que platform_payment_intents. La
// plataforma lo sigue leyendo, y "Activar Plus" lo sigue escribiendo, en la misma
// transacción que el plan.
//
// Usa el servidor real y una PostgreSQL local desechable (test/helpers/realServer.js):
//
//   pg_ctlcluster 16 main start
//   export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
//   QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres \
//     node --test test/paymentLedger.integration.test.js
//
// Sin QRACKS_TEST_DATABASE_URL, cada test sale como SKIPPED, con el motivo.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { itest, PLATFORM_PASSWORD, setup, teardown, dbQuery, call } = require("./helpers/realServer");

const LEDGER = "/api/kv/platform_payment_log";
const plat = { "X-Qracks-Platform-Auth": PLATFORM_PASSWORD };
const ledgerRow = async () => (await dbQuery("SELECT value FROM kv WHERE key = 'platform_payment_log'")).rows[0];

async function plusFromPanel(tag) {
  const slug = `it-${tag}-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const created = await call("POST", "/api/create-quiniela", { body: {
    slug, groupName: "IT " + tag, creatorName: "Ana", contact: "it", password: "owner-" + crypto.randomBytes(6).toString("hex"),
  } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const granted = await call("POST", `/api/platform/quinielas/${slug}/entitlement`, {
    headers: plat, body: { plan: "PLUS", grantId: "grant" + crypto.randomBytes(6).toString("hex") },
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.recorded, true, "Activar Plus sigue apuntando el cobro en el libro");
  return slug;
}

test.describe("S2: el libro de pagos sólo lo escribe el servidor (servidor real)", () => {
  test.before(setup);
  test.after(teardown);

  itest("con la contraseña de plataforma: se lee, pero no se reescribe ni se borra", async () => {
    const slug = await plusFromPanel("ledger");
    const read = await call("GET", LEDGER, { headers: plat });
    assert.equal(read.status, 200);
    const mine = read.body.value.payments.filter((p) => p.slug === slug);
    assert.equal(mine.length, 1, "el cobro de Activar Plus está en el libro");
    const before = await ledgerRow();

    // Reescribirlo, vaciarlo o borrarlo: nada de eso pasa.
    const rewrite = await call("POST", LEDGER, { headers: plat, body: { value: { ...read.body.value, payments: [] } } });
    assert.deepEqual([rewrite.status, rewrite.body], [403, { error: "server_owned_key" }]);
    const forged = await call("POST", LEDGER, { headers: plat, body: { value: { ...read.body.value,
      payments: [...read.body.value.payments, { id: "inventado01", slug, amount: 1, plan: "PLUS" }] } } });
    assert.deepEqual([forged.status, forged.body], [403, { error: "server_owned_key" }]);
    const del = await call("DELETE", LEDGER, { headers: plat });
    assert.deepEqual([del.status, del.body], [403, { error: "server_owned_key" }]);

    assert.deepEqual(await ledgerRow(), before, "la fila sigue intacta, byte por byte");
  });

  itest("sin credencial tampoco, y leerlo sigue exigiendo la de plataforma", async () => {
    await plusFromPanel("anon");
    const before = await ledgerRow();
    const read = await call("GET", LEDGER);
    assert.deepEqual([read.status, read.body], [403, { error: "unauthorized" }]);
    const write = await call("POST", LEDGER, { body: { value: { payments: [] } } });
    assert.deepEqual([write.status, write.body], [403, { error: "server_owned_key" }]);
    const del = await call("DELETE", LEDGER);
    assert.deepEqual([del.status, del.body], [403, { error: "server_owned_key" }]);
    assert.deepEqual(await ledgerRow(), before);
  });

  itest("las demás filas de plataforma siguen siendo de la plataforma", async () => {
    // Regresión: el cambio no le quita a la plataforma lo que sí es suyo.
    const cfg = await call("GET", "/api/kv/commercial_config", { headers: plat });
    assert.equal(cfg.status, 200);
    const saved = await call("POST", "/api/kv/commercial_config", { headers: plat, body: { value: cfg.body.value } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  });
});
