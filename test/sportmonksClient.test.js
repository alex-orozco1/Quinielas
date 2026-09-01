// DATA-003 (QA correction) — SportmonksClient error surface.
// Fake transport only. No live API is contacted by any test in this file.
// No real token is used, embedded, or required.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSportmonksClient, BASE_URL } = require("../providers/sportmonksClient");
const { RELIABILITY_STATES } = require("../providers/theSportsDbAdapter");

// A deliberately non-secret placeholder. Never a real credential.
const FAKE_TOKEN = "test-token-not-a-real-credential";

async function withToken(token, fn) {
  const prev = process.env.SPORTMONKS_API_TOKEN;
  if (token == null) delete process.env.SPORTMONKS_API_TOKEN;
  else process.env.SPORTMONKS_API_TOKEN = token;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.SPORTMONKS_API_TOKEN;
    else process.env.SPORTMONKS_API_TOKEN = prev;
  }
}

function res(status, body, { badJson } = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    json: async () => { if (badJson) throw new SyntaxError("Unexpected token"); return body; },
  };
}

async function expectState(t, state, transport, token = FAKE_TOKEN) {
  return withToken(token, async () => {
    const client = createSportmonksClient({ transport });
    await assert.rejects(
      () => client.request("/seasons/25539"),
      (err) => {
        assert.equal(err.name, "ProviderError", "must use the existing ProviderError type");
        assert.equal(err.reliabilityState, state, `expected ${state}, got ${err.reliabilityState}`);
        return true;
      }
    );
  });
}

// ==== 1. token missing =====================================================

test("CLIENT 1: a missing SPORTMONKS_API_TOKEN fails securely, before any request is attempted", async () => {
  let called = false;
  await withToken(null, async () => {
    const client = createSportmonksClient({ transport: async () => { called = true; return res(200, { data: {} }); } });
    await assert.rejects(() => client.request("/seasons/25539"), (err) => {
      assert.equal(err.reliabilityState, "provider_auth_error");
      return true;
    });
  });
  assert.equal(called, false, "must not hit the network at all when the token is absent");
});

// ==== 2. 401 / 403 =========================================================

test("CLIENT 2: HTTP 401 maps to provider_auth_error", async () => {
  await expectState(null, "provider_auth_error", async () => res(401, {}));
});

test("CLIENT 2: HTTP 403 is a COVERAGE condition, never reported as a broken token", async () => {
  // Sportmonks v3 documents 401 (unauthenticated) and 403 (resource not in
  // plan) as different conditions. Telling an admin their token is broken
  // when a league simply is not in the subscription would be actively
  // misleading, and will happen routinely as QRACKS adds competitions.
  await expectState(null, "competition_not_supported", async () => res(403, {}));
});

test("CLIENT 2b: 200 with empty data degrades conservatively WITHOUT claiming a commercial cause", async () => {
  // Empty data can mean a nonexistent resource, a wrong id, a genuinely empty
  // result, coverage, or something else. We reuse competition_not_supported
  // as the conservative degradation but must NOT assert why.
  for (const emptyBody of [{ data: [] }, { data: null }, { data: {} }]) {
    await withToken(FAKE_TOKEN, async () => {
      const client = createSportmonksClient({ transport: async () => res(200, emptyBody) });
      await assert.rejects(() => client.getSeasonWithStages(25539), (err) => {
        assert.equal(err.reliabilityState, "competition_not_supported");
        assert.match(err.message, /no usable data/i, "message must describe the observation, not a cause");
        assert.ok(!/subscription|plan|cover/i.test(err.message), "must not claim a coverage cause without provider evidence");
        return true;
      });
    });
  }
});

test("CLIENT 2c: the source no longer claims empty data proves coverage", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "providers", "sportmonksClient.js"), "utf8");
  assert.ok(!/subscribed-but-empty/.test(src));
  assert.ok(/deliberately NOT/i.test(src), "must document that the cause is not asserted");
});

// ==== 3. 429 ===============================================================

test("CLIENT 3: HTTP 429 maps to provider_rate_limited", async () => {
  await expectState(null, "provider_rate_limited", async () => res(429, {}));
});

// ==== 4. network failure ===================================================

test("CLIENT 4: a network failure maps to provider_unavailable", async () => {
  await expectState(null, "provider_unavailable", async () => { throw new TypeError("fetch failed"); });
});

// ==== 5. timeout ===========================================================

test("CLIENT 5: an aborted (timed-out) request maps to provider_timeout, matching the existing contract", async () => {
  await expectState(null, "provider_timeout", async () => {
    const e = new Error("aborted"); e.name = "AbortError"; throw e;
  });
});

test("CLIENT 5b: the timeout is actually wired to an AbortController signal", async () => {
  await withToken(FAKE_TOKEN, async () => {
    let sawSignal = false;
    const client = createSportmonksClient({
      timeoutMs: 5,
      transport: async (_url, opts) => { sawSignal = !!(opts && opts.signal); return res(200, { data: {} }); },
    });
    await client.request("/seasons/25539");
    assert.equal(sawSignal, true);
  });
});

// ==== 6. 5xx ===============================================================

test("CLIENT 6: HTTP 500 maps to provider_unavailable (upstream)", async () => {
  await expectState(null, "provider_unavailable", async () => res(500, {}));
});

test("CLIENT 6b: an unexpected non-ok status maps to provider_invalid_response", async () => {
  await expectState(null, "provider_invalid_response", async () => res(418, {}));
});

// ==== 7. malformed =========================================================

test("CLIENT 7: HTTP 200 with unparseable JSON maps to provider_invalid_response", async () => {
  await expectState(null, "provider_invalid_response", async () => res(200, null, { badJson: true }));
});

test("CLIENT 7b: HTTP 200 with no data envelope maps to provider_invalid_response", async () => {
  await expectState(null, "provider_invalid_response", async () => res(200, { meta: {} }));
});

// ==== taxonomy reuse =======================================================

test("every state the client can emit belongs to the EXISTING AUTO-004 taxonomy -- no second taxonomy was created", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "providers", "sportmonksClient.js"), "utf8");
  const emitted = [...src.matchAll(/new ProviderError\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 6, "expected several mapped states");
  emitted.forEach((st) => assert.ok(RELIABILITY_STATES.includes(st), `${st} must exist in RELIABILITY_STATES`));
  assert.ok(src.includes('require("./theSportsDbAdapter")'), "must reuse the existing ProviderError, not redefine one");
});

// ==== 8. secret safety =====================================================

test("CLIENT 8: the token is sent as a header, never in the URL/query string", async () => {
  await withToken(FAKE_TOKEN, async () => {
    let seenUrl = null, seenHeaders = null;
    const client = createSportmonksClient({
      transport: async (url, opts) => { seenUrl = url; seenHeaders = opts.headers; return res(200, { data: {} }); },
    });
    await client.request("/seasons/25539");
    assert.ok(!seenUrl.includes(FAKE_TOKEN), "token must never appear in the URL");
    assert.ok(!seenUrl.includes("api_token"), "must not use the query-string auth form");
    assert.equal(seenHeaders.Authorization, FAKE_TOKEN, "token travels in the Authorization header");
  });
});

test("CLIENT 8: the token never leaks into ProviderError message or meta on ANY failure branch", async () => {
  const branches = [
    async () => res(401, {}), async () => res(403, {}), async () => res(429, {}),
    async () => res(500, {}), async () => res(418, {}),
    async () => res(200, null, { badJson: true }), async () => res(200, { meta: {} }),
    async () => { throw new TypeError("fetch failed"); },
    async () => { const e = new Error("x"); e.name = "AbortError"; throw e; },
  ];
  for (const transport of branches) {
    await withToken(FAKE_TOKEN, async () => {
      const client = createSportmonksClient({ transport });
      await client.request("/seasons/25539").then(
        () => { throw new Error("should have rejected"); },
        (err) => {
          const blob = JSON.stringify({ m: err.message, meta: err.meta });
          assert.ok(!blob.includes(FAKE_TOKEN), "token must never appear in a ProviderError");
          assert.ok(!blob.includes("Authorization"), "headers must never be attached to error meta");
        }
      );
    });
  }
});

test("CLIENT 8: no token literal is hardcoded in the client, and it is read only from the environment", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "providers", "sportmonksClient.js"), "utf8");
  const envName = ["SPORTMONKS", "API", "TOKEN"].join("_");
  assert.ok(src.includes(`process.env.${envName}`), "must read the token from the environment");
  assert.ok(!new RegExp(envName + '\\s*=\\s*["\'][A-Za-z0-9]{6,}').test(src), "must never assign a literal token");
  assert.ok(!/api_token=/.test(src), "must not build query-string auth");
});

test("CLIENT 8: the client is server-side only -- it is never referenced from the frontend bundle", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  ["sportmonksClient", "SPORTMONKS_API_TOKEN", BASE_URL].forEach((needle) => {
    assert.ok(!html.includes(needle), `public/index.html must not reference ${needle}`);
  });
});
