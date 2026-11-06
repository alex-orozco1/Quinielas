// onboardingDemo.integration.test.js — los conteos de la demo contra el
// servidor real y una base PostgreSQL local desechable: se guardan sin
// identificadores aunque el cliente los mande, y los demás eventos no cambian.

const test = require("node:test");
const assert = require("node:assert/strict");
const { itest, setup, teardown, freshIp, call, dbQuery } = require("./helpers/realServer");

test.describe("demo «Ver cómo se juega»: medición anónima (real server)", () => {
  test.before(setup);
  test.after(teardown);

  itest("demo_started y demo_completed se guardan sin dispositivo, quiniela ni participante, aunque lleguen", async () => {
    for (const event of ["demo_started", "demo_completed"]) {
      const r = await call("POST", "/api/track-event", { ip: freshIp(), body: { event, source: "otra-cosa", deviceId: "dev-123", competitionSlug: "mi-quiniela", participantId: "p_1", isNewUser: true } });
      assert.equal(r.status, 200, event);
    }
    const rows = (await dbQuery("SELECT event_name, competition_slug, participant_id, is_new_user, device_id, source FROM analytics_events WHERE event_name LIKE 'demo_%' ORDER BY id")).rows;
    assert.deepEqual(rows, [
      { event_name: "demo_started", competition_slug: null, participant_id: null, is_new_user: null, device_id: null, source: "demo" },
      { event_name: "demo_completed", competition_slug: null, participant_id: null, is_new_user: null, device_id: null, source: "demo" },
    ]);
  });

  itest("los demás eventos siguen guardando lo que guardaban; uno desconocido sigue rechazado", async () => {
    const r = await call("POST", "/api/track-event", { ip: freshIp(), body: { event: "landing_viewed", source: "landing", deviceId: "dev-9", competitionSlug: "q-9" } });
    assert.equal(r.status, 200);
    const row = (await dbQuery("SELECT device_id, competition_slug, source FROM analytics_events WHERE event_name = 'landing_viewed' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.deepEqual(row, { device_id: "dev-9", competition_slug: "q-9", source: "landing" });
    assert.equal((await call("POST", "/api/track-event", { ip: freshIp(), body: { event: "demo_otro" } })).status, 400);
  });

  itest("/demo se sirve (la app, en su página de demo) sin tocar ninguna quiniela", async () => {
    const before = (await dbQuery("SELECT count(*)::int AS n FROM kv")).rows[0].n;
    const r = await call("GET", "/demo", { ip: freshIp() });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('<div id="quiniela-root"></div>'));
    const after = (await dbQuery("SELECT count(*)::int AS n FROM kv")).rows[0].n;
    assert.equal(after, before);
  });
});
