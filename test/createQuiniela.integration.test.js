// createQuiniela.integration.test.js — POST /api/create-quiniela against the
// REAL server (test/helpers/realServer.js: a throwaway local PostgreSQL;
// skipped, with the reason, without one).
// MS1: /crear no longer asks for the organizer's contact. The server must
// accept a creation without it, keep storing it when an older client still
// sends it, leave existing values alone, and still require what matters.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { itest, setup, teardown, freshIp, call, dbQuery } = require("./helpers/realServer");

const slugOf = (tag) => `it-crear-${tag}-${crypto.randomBytes(3).toString("hex")}`;
const create = (body) => call("POST", "/api/create-quiniela", { ip: freshIp(), body });
const indexEntry = async (slug) => {
  const idx = (await dbQuery("SELECT value FROM kv WHERE key = 'platform_index'")).rows[0].value;
  return idx.quinielas.find((q) => q.slug === slug);
};

test.describe("create-quiniela without the organizer contact (real server)", () => {
  test.before(setup);
  test.after(teardown);

  itest("a creation without contact works, and its setup claim lets the creator set the first PIN", async () => {
    const slug = slugOf("nocontact");
    const r = await create({ slug, groupName: "Sin contacto", creatorName: "Ana", password: "clave-" + slug });
    assert.equal(r.status, 200);
    assert.equal(r.body.slug, slug);
    assert.equal((await indexEntry(slug)).contact, "", "stored empty: the platform panel shows «sin contacto»");
    const claim = r.setCookies.map((c) => c.split(";")[0]).join("; ");
    const meta = (await call("GET", "/api/kv/" + encodeURIComponent(`quiniela:${slug}:meta`))).body.value;
    const pin = await call("POST", "/api/set-pin", { cookie: claim, body: { metaKey: `quiniela:${slug}:meta`, participantId: meta.participants[0].id, newPin: "1357" } });
    assert.equal(pin.status, 200, "first PIN with the creation claim, as before");
  });

  itest("an older client that still sends a contact keeps it stored; existing values are not touched by new creations", async () => {
    const older = slugOf("withcontact");
    assert.equal((await create({ slug: older, groupName: "Con contacto", creatorName: "Beto", contact: "beto@example.test", password: "clave-" + older })).status, 200);
    assert.equal((await indexEntry(older)).contact, "beto@example.test");
    const newer = slugOf("after");
    assert.equal((await create({ slug: newer, groupName: "Después", creatorName: "Carla", password: "clave-" + newer })).status, 200);
    assert.equal((await indexEntry(older)).contact, "beto@example.test", "still there");
  });

  itest("group name, creator name and admin password are still required (400), and nothing is created", async () => {
    for (const [missing, body] of [
      ["groupName", { creatorName: "Ana", password: "x1" }],
      ["creatorName", { groupName: "G", password: "x1" }],
      ["password", { groupName: "G", creatorName: "Ana" }],
    ]) {
      const slug = slugOf("miss-" + missing.toLowerCase());
      const r = await create({ slug, ...body });
      assert.deepEqual([r.status, r.body.error], [400, "invalid_params"], missing);
      assert.equal(await indexEntry(slug), undefined, missing + ": nothing created");
    }
  });
});
