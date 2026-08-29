// DATA-003 final QA — Client -> Adapter -> Domain contract, end to end.
// Fake transport only. The transport returns the provider's REAL nested
// envelope shape, so a mismatch between what the Client yields and what the
// Adapter consumes would fail here rather than in production.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSportmonksClient, INCLUDE_SEASON_STAGES, INCLUDE_STAGE_FIXTURES } = require("../providers/sportmonksClient");
const sportmonks = require("../providers/sportmonksAdapter");

const FAKE_TOKEN = "test-token-not-a-real-credential";
const LIGA_MX = 743;

// Must AWAIT fn before restoring: an async fn would otherwise have the token
// removed from under it mid-flight.
async function withToken(fn) {
  const prev = process.env.SPORTMONKS_API_TOKEN;
  process.env.SPORTMONKS_API_TOKEN = FAKE_TOKEN;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.SPORTMONKS_API_TOKEN;
    else process.env.SPORTMONKS_API_TOKEN = prev;
  }
}
const ok = (body) => ({ status: 200, ok: true, json: async () => body });

// REAL observed ids/dates. Unobserved fields (is_current, most `finished`,
// ending_at for single-date stages) are omitted, never invented.
const SEASON_ENVELOPE = {
  data: {
    id: 25539, name: "2025/2026", finished: true,
    stages: [
      { id: 77476863, type_id: 223, name: "Apertura",                   sort_order: 1, finished: true, starting_at: "2025-07-12", ending_at: "2025-11-09" },
      { id: 77478869, type_id: 224, name: "Apertura, Play In",          sort_order: 2, starting_at: "2025-11-24" },
      { id: 77478884, type_id: 224, name: "Apertura, Quarter-finals",   sort_order: 3, starting_at: "2025-11-27", ending_at: "2025-12-01" },
      { id: 77479071, type_id: 224, name: "Apertura, Semi-finals",      sort_order: 4, starting_at: "2025-12-04", ending_at: "2025-12-07" },
      { id: 77479151, type_id: 224, name: "Apertura, Final",            sort_order: 5, starting_at: "2025-12-12", ending_at: "2025-12-15" },
      { id: 77479512, type_id: 224, name: "Apertura - Reclasificación", sort_order: 6, starting_at: "2025-11-21" },
      { id: 77479601, type_id: 223, name: "Clausura",                   sort_order: 7, starting_at: "2026-01-10", ending_at: "2026-04-27" },
      { id: 77481527, type_id: 224, name: "Clausura - Quarter-finals",  sort_order: 8, starting_at: "2026-05-03", ending_at: "2026-05-11" },
      { id: 77481528, type_id: 224, name: "Clausura - Semi-finals",     sort_order: 9, starting_at: "2026-05-14", ending_at: "2026-05-18" },
      { id: 77482119, type_id: 224, name: "Clausura - Final",           sort_order: 10, starting_at: "2026-05-22", ending_at: "2026-05-25" },
    ],
  },
};

// REAL Apertura Final, stage 77479151, inside the provider's stage envelope.
const STAGE_ENVELOPE = {
  data: {
    id: 77479151, name: "Apertura, Final",
    fixtures: [
      { id: 19609341, stage_id: 77479151, round_id: null, aggregate_id: null, leg: "1/2", starting_at: "2025-12-12",
        participants: [{ id: 1, name: "Tigres UANL", meta: { location: "home" } }, { id: 2, name: "Toluca", meta: { location: "away" } }] },
      { id: 19609342, stage_id: 77479151, round_id: null, aggregate_id: null, leg: "2/2", starting_at: "2025-12-15",
        participants: [{ id: 2, name: "Toluca", meta: { location: "home" } }, { id: 1, name: "Tigres UANL", meta: { location: "away" } }] },
    ],
  },
};

function clientFor(bodyByPath, sink) {
  return createSportmonksClient({
    transport: async (url) => {
      if (sink) sink.push(url);
      const u = new URL(url);
      for (const [frag, body] of Object.entries(bodyByPath)) {
        if (u.pathname.includes(frag)) return ok(body);
      }
      return ok({ data: null });
    },
  });
}

// ==== runtime URL proof ====================================================

test("RUNTIME URL: getSeasonWithStages issues include=stages -- proven from the URL the transport actually receives", async () => {
  await withToken(async () => {
    const seen = [];
    await clientFor({ "/seasons/": SEASON_ENVELOPE }, seen).getSeasonWithStages(25539);
    const u = new URL(seen[0]);
    assert.equal(u.pathname, "/v3/football/seasons/25539");
    assert.equal(u.searchParams.get("include"), INCLUDE_SEASON_STAGES);
    assert.equal(u.searchParams.get("include"), "stages");
  });
});

test("RUNTIME URL: getStageFixtures issues include=fixtures.participants", async () => {
  await withToken(async () => {
    const seen = [];
    await clientFor({ "/stages/": STAGE_ENVELOPE }, seen).getStageFixtures(77479151);
    const u = new URL(seen[0]);
    assert.equal(u.pathname, "/v3/football/stages/77479151");
    assert.equal(u.searchParams.get("include"), INCLUDE_STAGE_FIXTURES);
    assert.equal(u.searchParams.get("include"), "fixtures.participants");
  });
});

test("RUNTIME URL: the token never appears in either URL", async () => {
  await withToken(async () => {
    const seen = [];
    const c = clientFor({ "/seasons/": SEASON_ENVELOPE, "/stages/": STAGE_ENVELOPE }, seen);
    await c.getSeasonWithStages(25539);
    await c.getStageFixtures(77479151);
    assert.equal(seen.length, 2);
    seen.forEach((u) => {
      assert.ok(!u.includes(FAKE_TOKEN), "token must never be in the URL");
      assert.ok(!/api_token|token=/.test(u), "no query-string auth");
    });
  });
});

test("CONTRACT: an unsupported top-level option is REJECTED, not silently ignored (the original include bug)", async () => {
  await withToken(async () => {
    const c = clientFor({ "/seasons/": SEASON_ENVELOPE });
    await assert.rejects(() => c.request("/seasons/25539", { include: "stages" }),
      (err) => { assert.match(err.message, /unsupported option/i); return true; });
  });
});

// ==== season path: Client -> Adapter ======================================

test("CONTRACT season path: the Client's real envelope feeds the Adapter with no product-side unwrapping", async () => {
  await withToken(async () => {
    const seasonData = await clientFor({ "/seasons/": SEASON_ENVELOPE }).getSeasonWithStages(25539);
    const competition = sportmonks.toCompetition({ id: LIGA_MX, name: "Liga MX" });
    const { instances, stages, skippedStages } = sportmonks.fromSeasonPayload(seasonData, {
      competitionId: competition.id, providerCompetitionId: LIGA_MX,
    });
    assert.equal(skippedStages, 0);
    assert.deepEqual(instances.map((i) => i.instanceKey).sort(), ["Apertura", "Clausura"]);
    assert.equal(stages.length, 10);
    assert.deepEqual(stages.map((s) => s.providerStageId),
      ["77476863","77478869","77478884","77479071","77479151","77479512","77479601","77481527","77481528","77482119"]);
  });
});

test("CONTRACT season path: the real Reclasificación edge case survives the full Client->Adapter round trip", async () => {
  await withToken(async () => {
    const seasonData = await clientFor({ "/seasons/": SEASON_ENVELOPE }).getSeasonWithStages(25539);
    const comp = sportmonks.toCompetition({ id: LIGA_MX });
    const { stages } = sportmonks.fromSeasonPayload(seasonData, { competitionId: comp.id, providerCompetitionId: LIGA_MX });
    const recla = stages.find((s) => s.providerStageId === "77479512");
    const playIn = stages.find((s) => s.providerStageId === "77478869");
    assert.equal(recla.sortOrder, 6);
    assert.equal(playIn.sortOrder, 2);
    assert.ok(new Date(recla.startsAt) < new Date(playIn.startsAt), "sort_order is NOT chronology");
    assert.equal(recla.endsAt, null, "unobserved ending_at stays null");
  });
});

test("CONTRACT season path: product code never has to know about the `.stages` envelope", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "providers", "sportmonksAdapter.js"), "utf8");
  assert.ok(src.includes("function fromSeasonPayload"), "the envelope is unwrapped at the adapter boundary");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  ["fromSeasonPayload", "fromStagePayload", "sportmonks"].forEach((n) =>
    assert.ok(!html.includes(n), `frontend must not reference ${n}`));
});

// ==== fixtures path: Client -> Adapter ====================================

test("CONTRACT fixtures path: the REAL Final (19609341 / 19609342) round-trips Client -> Adapter -> Domain intact", async () => {
  await withToken(async () => {
    const c = clientFor({ "/seasons/": SEASON_ENVELOPE, "/stages/": STAGE_ENVELOPE });
    const seasonData = await c.getSeasonWithStages(25539);
    const comp = sportmonks.toCompetition({ id: LIGA_MX });
    const { instances, stages } = sportmonks.fromSeasonPayload(seasonData, { competitionId: comp.id, providerCompetitionId: LIGA_MX });

    const stageData = await c.getStageFixtures(77479151);
    const { events, skippedFixtures } = sportmonks.fromStagePayload(stageData, { stages });

    assert.equal(skippedFixtures, 0);
    assert.deepEqual(events.map((e) => e.providerEventId).sort(), ["19609341", "19609342"]);
    events.forEach((e) => {
      assert.equal(e.providerRoundId, null, "round_id genuinely null");
      assert.equal(e.aggregateKey, null, "aggregate_id genuinely null");
    });
    assert.deepEqual(events.map((e) => e.leg).sort(), ["1/2", "2/2"]);
    assert.equal(events[0].stageId, events[1].stageId, "same stage");
    assert.equal(events[0].instanceId, events[1].instanceId, "same CompetitionInstance");
    const apertura = instances.find((i) => i.instanceKey === "Apertura");
    assert.equal(events[0].instanceId, apertura.id, "and it is Apertura, not Clausura");
  });
});

test("CONTRACT fixtures path: participants map to home/away without inventing roles", async () => {
  await withToken(async () => {
    const c = clientFor({ "/seasons/": SEASON_ENVELOPE, "/stages/": STAGE_ENVELOPE });
    const seasonData = await c.getSeasonWithStages(25539);
    const comp = sportmonks.toCompetition({ id: LIGA_MX });
    const { stages } = sportmonks.fromSeasonPayload(seasonData, { competitionId: comp.id, providerCompetitionId: LIGA_MX });
    const { events } = sportmonks.fromStagePayload(await c.getStageFixtures(77479151), { stages });
    const leg1 = events.find((e) => e.leg === "1/2");
    assert.deepEqual(leg1.competitors.map((x) => [x.role, x.name]), [["home", "Tigres UANL"], ["away", "Toluca"]]);
  });
});

// ==== EDGE CASES 1-16 ======================================================

const comp = () => sportmonks.toCompetition({ id: LIGA_MX });

test("EDGE 1: season payload with stages absent / null / [] degrades to ONE instance, no crash, no invented structure", () => {
  [undefined, null, []].forEach((stages) => {
    const r = sportmonks.fromSeasonPayload({ id: 25539, name: "2025/2026", stages }, { competitionId: comp().id, providerCompetitionId: LIGA_MX });
    assert.equal(r.instances.length, 1);
    assert.equal(r.stages.length, 0);
    assert.equal(r.skippedStages, 0);
  });
});

test("EDGE 1b: a completely absent/garbage season payload does not crash", () => {
  [null, undefined, "nonsense", 42].forEach((bad) => {
    assert.throws(() => sportmonks.fromSeasonPayload(bad, { competitionId: comp().id, providerCompetitionId: LIGA_MX }),
      /providerSeasonId or instanceKey/, "refuses to mint an anonymous colliding instance");
  });
});

test("EDGE 2: a fixture pointing at an UNKNOWN stage gets null stage AND null instance -- never bound to the wrong tournament", () => {
  const { stages } = sportmonks.fromSeasonPayload(SEASON_ENVELOPE.data, { competitionId: comp().id, providerCompetitionId: LIGA_MX });
  const { events } = sportmonks.fromStagePayload(
    { id: 1, fixtures: [{ id: 999, stage_id: 55555555, round_id: null, aggregate_id: null, leg: null, participants: [] }] },
    { stages });
  assert.equal(events.length, 1);
  assert.equal(events[0].stageId, null);
  assert.equal(events[0].instanceId, null, "must NOT silently inherit some other instance");
});

test("EDGE 3: fixtures with missing / non-array / malformed participants never crash and never invent home/away", () => {
  const cases = [undefined, null, "nope", 5, [{ id: 1, name: "X" }], [{ id: 2, name: "Y", meta: {} }]];
  cases.forEach((participants, i) => {
    const { events } = sportmonks.fromStagePayload(
      { id: 1, fixtures: [{ id: 800 + i, stage_id: 77479151, participants }] }, { stages: [] });
    assert.equal(events.length, 1);
    events[0].competitors.forEach((c2) => assert.ok(c2.role === null || c2.role === "home" || c2.role === "away"));
    if (i >= 4) assert.equal(events[0].competitors[0].role, null, "no location metadata => role null, never guessed");
  });
});

test("EDGE 4: the same providerEventId received twice yields the SAME stable domain id -- no positional identity", () => {
  const fx = { id: 19609341, stage_id: 77479151, round_id: null, aggregate_id: null, leg: "1/2", participants: [] };
  const { events } = sportmonks.fromStagePayload({ id: 1, fixtures: [fx, { ...fx }] }, { stages: [] });
  assert.equal(events.length, 2);
  assert.equal(events[0].id, events[1].id, "identity is derived from the provider id, not import order");
});

test("EDGE 5: provider round 1 in Apertura and in Clausura -> different instances, different events, no identity collision", () => {
  const { instances, stages } = sportmonks.fromSeasonPayload(SEASON_ENVELOPE.data, { competitionId: comp().id, providerCompetitionId: LIGA_MX });
  const { events } = sportmonks.fromStagePayload({ id: 1, fixtures: [
    { id: 111, stage_id: 77476863, round_id: 1, aggregate_id: null, leg: null, participants: [] },
    { id: 222, stage_id: 77479601, round_id: 1, aggregate_id: null, leg: null, participants: [] },
  ] }, { stages });
  assert.equal(events[0].providerRoundId, events[1].providerRoundId, "same provider round is allowed");
  assert.notEqual(events[0].instanceId, events[1].instanceId);
  assert.notEqual(events[0].id, events[1].id);
  const keys = instances.filter((i) => [events[0].instanceId, events[1].instanceId].includes(i.id)).map((i) => i.instanceKey).sort();
  assert.deepEqual(keys, ["Apertura", "Clausura"]);
});

test("EDGE 6 & 7: null round_id and null aggregate_id remain valid and are never fabricated", () => {
  const { stages } = sportmonks.fromSeasonPayload(SEASON_ENVELOPE.data, { competitionId: comp().id, providerCompetitionId: LIGA_MX });
  const { events } = sportmonks.fromStagePayload(STAGE_ENVELOPE.data, { stages });
  events.forEach((e) => { assert.equal(e.providerRoundId, null); assert.equal(e.aggregateKey, null); });
});

test("EDGE 8: absent `finished` stays null on stages AND on the instance -- never coerced to true or false", () => {
  const { instances, stages } = sportmonks.fromSeasonPayload(SEASON_ENVELOPE.data, { competitionId: comp().id, providerCompetitionId: LIGA_MX });
  assert.equal(stages.find((s) => s.providerStageId === "77478869").finished, null);
  assert.equal(instances.find((i) => i.instanceKey === "Apertura").finished, null,
    "only one Apertura stage reported finished, so the instance answer is unknown");
});

test("EDGE 9: numeric and string provider ids normalize to the SAME domain identity", () => {
  const a = sportmonks.fromStagePayload({ id: 1, fixtures: [{ id: 19609341, stage_id: 77479151, participants: [] }] }, { stages: [] });
  const b = sportmonks.fromStagePayload({ id: 1, fixtures: [{ id: "19609341", stage_id: "77479151", participants: [] }] }, { stages: [] });
  assert.equal(a.events[0].id, b.events[0].id);
  assert.equal(sportmonks.toCompetition({ id: 743 }).id, sportmonks.toCompetition({ id: "743" }).id);
});

test("EDGE 9b: the competition strategy resolves identically for numeric and string league ids", () => {
  const num = sportmonks.fromSeasonPayload(SEASON_ENVELOPE.data, { competitionId: "c", providerCompetitionId: 743 });
  const str = sportmonks.fromSeasonPayload(SEASON_ENVELOPE.data, { competitionId: "c", providerCompetitionId: "743" });
  assert.deepEqual(num.instances.map((i) => i.instanceKey).sort(), str.instances.map((i) => i.instanceKey).sort());
  assert.equal(num.instances.length, 2);
});

test("EDGE 10: empty / null / object ids never produce ids like 'sportmonks:event:' or ':stage:_' -- malformed records are skipped and counted", () => {
  const r = sportmonks.fromStagePayload({ id: 1, fixtures: [
    { id: "", stage_id: 77479151, participants: [] },
    { id: null, stage_id: 77479151, participants: [] },
    { id: {}, stage_id: 77479151, participants: [] },
    { id: 19609341, stage_id: 77479151, participants: [] },
  ] }, { stages: [] });
  assert.equal(r.events.length, 1, "only the usable fixture survives");
  assert.equal(r.skippedFixtures, 3, "and the rest are reported, not silently lost");
  assert.equal(r.events[0].id, "sportmonks:event:19609341");
});

test("EDGE 10b: stages with unusable ids are skipped and counted, never given colliding identities", () => {
  const r = sportmonks.fromSeasonPayload({ id: 25539, name: "2025/2026", stages: [
    { id: 77476863, name: "Apertura", sort_order: 1 },
    { id: "", name: "Broken A" },
    { id: null, name: "Broken B" },
  ] }, { competitionId: comp().id, providerCompetitionId: LIGA_MX });
  assert.equal(r.stages.length, 1);
  assert.equal(r.skippedStages, 2);
  assert.equal(new Set(r.stages.map((s) => s.id)).size, 1);
});

test("EDGE 11: path parameters are encoded -- an id containing ?/& cannot inject query params", async () => {
  await withToken(async () => {
    const seen = [];
    const c = clientFor({ "/seasons/": SEASON_ENVELOPE }, seen);
    await c.getSeasonWithStages("25539?include=evil&x=1").catch(() => {});
    const u = new URL(seen[0]);
    assert.equal(u.searchParams.get("include"), INCLUDE_SEASON_STAGES, "the injected include must not win");
    assert.equal(u.searchParams.get("x"), null, "no extra params may be injected via the path");
  });
});

test("EDGE 12: null/undefined query params are skipped, never stringified to 'null'/'undefined'", async () => {
  await withToken(async () => {
    const seen = [];
    const c = clientFor({ "/seasons/": SEASON_ENVELOPE }, seen);
    await c.request("/seasons/25539", { params: { include: "stages", a: null, b: undefined } });
    const u = new URL(seen[0]);
    assert.equal(u.searchParams.get("a"), null);
    assert.equal(u.searchParams.get("b"), null);
    assert.ok(!seen[0].includes("null") && !seen[0].includes("undefined"));
  });
});

test("EDGE 13: the timeout timer is cleared on success, HTTP error, network failure and abort alike", async () => {
  const realClear = global.clearTimeout;
  let cleared = 0;
  global.clearTimeout = (...a) => { cleared++; return realClear(...a); };
  try {
    const branches = [
      async () => ok({ data: { id: 1 } }),
      async () => ({ status: 500, ok: false, json: async () => ({}) }),
      async () => { throw new TypeError("fetch failed"); },
      async () => { const e = new Error("x"); e.name = "AbortError"; throw e; },
    ];
    for (const transport of branches) {
      await withToken(async () => {
        const c = createSportmonksClient({ transport });
        await c.request("/seasons/1", { params: {} }).catch(() => {});
      });
    }
    assert.ok(cleared >= 4, `expected a clearTimeout per branch, saw ${cleared}`);
  } finally { global.clearTimeout = realClear; }
});

test("EDGE 15: a transport error carrying sensitive text is NEVER propagated raw", async () => {
  await withToken(async () => {
    const secret = "Bearer super-secret-leak-me";
    const c = createSportmonksClient({ transport: async () => { throw new Error(`connect failed with header ${secret}`); } });
    await c.request("/seasons/1", { params: {} }).then(
      () => { throw new Error("should reject"); },
      (err) => {
        const blob = JSON.stringify({ m: err.message, meta: err.meta, s: err.stack || "" });
        assert.ok(!blob.includes("super-secret-leak-me"), "upstream error text must not be re-exposed");
        assert.equal(err.reliabilityState, "provider_unavailable");
      });
  });
});

test("EDGE 16: malformed stage/fixture objects never yield entities with garbage identity", () => {
  const r = sportmonks.fromSeasonPayload({ id: 25539, stages: [
    { name: "no id at all" }, null, "string-stage", 7,
    { id: 77476863, name: "Apertura", sort_order: 1 },
  ] }, { competitionId: comp().id, providerCompetitionId: LIGA_MX });
  assert.equal(r.stages.length, 1);
  assert.equal(r.skippedStages, 4);
  r.stages.forEach((s) => assert.ok(!/:_$|:$/.test(s.id), `garbage id: ${s.id}`));

  const f = sportmonks.fromStagePayload({ id: 1, fixtures: [null, "x", 9, { no: "id" }] }, { stages: [] });
  assert.equal(f.events.length, 0);
  assert.equal(f.skippedFixtures, 4);
});

test("EDGE 16b: a stage with a usable id but a missing name still normalizes, with name null", () => {
  const r = sportmonks.fromSeasonPayload({ id: 25539, stages: [{ id: 999, sort_order: 1 }] },
    { competitionId: comp().id, providerCompetitionId: LIGA_MX });
  assert.equal(r.stages.length, 1);
  assert.equal(r.stages[0].name, null);
  assert.equal(r.instances.length, 1, "a nameless stage cannot be split into its own tournament");
});
