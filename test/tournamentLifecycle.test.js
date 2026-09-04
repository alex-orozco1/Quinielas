// MON-002C — tournament identity, lifecycle, and what a new edition costs.
//
// THE PROBLEM, REPRODUCED AGAINST THE SHIPPED CODE BEFORE THIS TICKET:
//
//   computeCompetitionIdentity(Liga MX, Apertura 2026)  ->  "4350:2026-2027"
//   computeCompetitionIdentity(Liga MX, Clausura 2027)  ->  "4350:2026-2027"
//
// One Plus purchase therefore covered two commercially distinct tournaments,
// and nothing downstream could have caught it: the two editions were the same
// string. The provider actually wired into the import path (TheSportsDB)
// declares neither MULTI_INSTANCE_SEASONS nor FINISHED_SIGNAL, so it can
// neither tell the editions apart nor say when one is over.
//
// These tests pin the replacement: an internal, server-computed cycle
// identity that a new edition always moves, a lifecycle that only evidence
// can end, and per-cycle consumption.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const T = require("../tournamentScope");
const {
  DEFAULT_COMMERCIAL_CONFIG, computeCompetitionIdentity,
  buildFreeEntitlement, buildPlusEntitlement, buildGrandfatheredEntitlement, buildManualGrantEntitlement,
  checkParticipantCapacity, checkLifecycleRoundConsumption,
  entitlementCoversScope,
} = require("../planLimits");
const {
  applyEntitlementGrant, findPurchaseForScope, purchaseMatchesScope,
  mergePlatformIndex, SERVER_OWNED_INDEX_FIELDS, ADMIN_EDITABLE_INDEX_FIELDS,
} = require("../platformState");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const scopeSrc = fs.readFileSync(path.join(__dirname, "..", "tournamentScope.js"), "utf8");

const cfg = DEFAULT_COMMERCIAL_CONFIG;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === "/" && line[i + 1] === "/" && line[i - 1] !== ":") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

function blockFrom(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at !== -1, `no se encontró: ${marker}`);
  const braceStart = source.indexOf("{", at);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(at, i + 1); }
  }
  throw new Error(`bloque sin cerrar: ${marker}`);
}

const ligaMx = { sportKey: "football", provider: "thesportsdb", competitionId: "4350" };
const scopeFor = (seq, over = {}) => ({ ...T.buildScope({ ...ligaMx, editionSeq: seq, ...over }) });

// ==== 1. identity ==========================================================

test("IDENTITY: the collision this ticket exists for is real, and the new identity does not have it", () => {
  // The provider string cannot tell the two editions apart...
  const apertura = computeCompetitionIdentity("4350", "2026-2027");
  const clausura = computeCompetitionIdentity("4350", "2026-2027");
  assert.equal(apertura, clausura, "una misma cadena para dos torneos distintos");

  // ...the cycle identity always can, because a new edition is a new cycle.
  const e1 = scopeFor(1);
  const e2 = T.buildNextScope(e1, ligaMx);
  assert.notEqual(e1.id, e2.id);
  assert.equal(e1.id, "ts:1:football:thesportsdb:4350:e1");
  assert.equal(e2.id, "ts:1:football:thesportsdb:4350:e2");
});

test("IDENTITY: a season-based competition still gets one cycle per edition", () => {
  // Premier 26/27 and 27/28 were already distinguishable by the old string;
  // they must not become WORSE under the new model.
  const a = T.buildScope({ sportKey: "football", provider: "thesportsdb", competitionId: "4328", editionSeq: 1 });
  const b = T.buildNextScope(a, { sportKey: "football", provider: "thesportsdb", competitionId: "4328" });
  assert.notEqual(a.id, b.id);
});

test("IDENTITY: displayName is never part of the id — renaming keeps the scope, and two competitions sharing a name do not collide", () => {
  const named = T.buildScope({ ...ligaMx, editionSeq: 1, displayName: "Liga MX — Apertura 2026" });
  const renamed = T.buildScope({ ...ligaMx, editionSeq: 1, displayName: "LIGA BBVA MX 2026" });
  assert.equal(named.id, renamed.id, "el id no se mueve porque cambie el nombre");
  assert.ok(!named.id.includes("apertura") && !named.id.includes("liga"), "y el nombre no está dentro del id");

  const other = T.buildScope({ sportKey: "football", provider: "thesportsdb", competitionId: "9999", editionSeq: 1, displayName: "Liga MX — Apertura 2026" });
  assert.notEqual(named.id, other.id, "mismo nombre, competencias distintas, scopes distintos");
});

test("IDENTITY: a quiniela with no league still has a cycle", () => {
  const a = T.buildInitialScope({});
  assert.equal(a.id, "ts:1:manual:e1");
  assert.equal(T.buildNextScope(a, {}).id, "ts:1:manual:e2");
});

test("IDENTITY: the sequence comes from the STORED scope — a caller cannot skip, reuse or forge one", () => {
  for (const bad of [null, undefined, 0, -1, 1.5, "1", "e2", {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(T.makeScopeId({ ...ligaMx, editionSeq: bad }), null, `must refuse editionSeq ${JSON.stringify(bad)}`);
  }
  // buildNextScope always reads the stored sequence, whatever it is handed —
  // and refuses to invent one, because restarting at 1 would land on a scope
  // an earlier purchase is already stamped for (see the dedicated test below).
  assert.equal(T.buildNextScope(scopeFor(7), ligaMx).editionSeq, 8);
  assert.equal(T.buildNextScope(null, ligaMx), null, "sin scope previo no hay siguiente");
  assert.equal(T.buildNextScope({ editionSeq: "9" }, ligaMx), null, "una secuencia corrupta no se hereda ni se reinventa");
});

test("IDENTITY: an arbitrary crafted scope id is not a scope id", () => {
  for (const bad of [
    "scope-inventado", "ts:1", "ts:1:football:thesportsdb:4350", "ts:1:football:thesportsdb:4350:e0",
    "ts:1:manual:e-1", "ts:1:manual:eX", "", null, undefined, 42, {}, "TS:1:manual:e1",
  ]) {
    assert.equal(T.isUsableScopeId(bad), false, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(T.isUsableScopeId("ts:1:manual:e1"), true);
  assert.equal(T.isUsableScopeId("ts:1:football:thesportsdb:4350:e12"), true);
});

// ==== 2. lifecycle =========================================================

test("LIFECYCLE: only evidence ends a tournament", () => {
  const s = scopeFor(1);
  // A provider that cannot answer never ends anything, whatever it returns.
  assert.equal(T.resolveLifecycle(s, { providerCanSignalFinish: false, providerFinished: true }), T.LIFECYCLE.ACTIVE);
  assert.equal(T.resolveLifecycle(s, { providerCanSignalFinish: false, providerFinished: null }), T.LIFECYCLE.ACTIVE);
  // A provider that CAN answer is believed, in both directions.
  assert.equal(T.resolveLifecycle(s, { providerCanSignalFinish: true, providerFinished: true }), T.LIFECYCLE.ENDED);
  assert.equal(T.resolveLifecycle(s, { providerCanSignalFinish: true, providerFinished: false }), T.LIFECYCLE.ACTIVE);
  // null is not false.
  assert.equal(T.resolveLifecycle(s, { providerCanSignalFinish: true, providerFinished: null }), T.LIFECYCLE.ACTIVE);
});

test("LIFECYCLE: UNKNOWN stays UNKNOWN, and an ENDED tournament never un-ends", () => {
  const unknown = { ...scopeFor(1), lifecycle: T.LIFECYCLE.UNKNOWN };
  assert.equal(T.resolveLifecycle(unknown, {}), T.LIFECYCLE.UNKNOWN);
  const ended = T.endScope(scopeFor(1), T.ENDED_REASONS.ADMIN_STARTED_NEW_CYCLE, "2026-12-01T00:00:00.000Z");
  assert.equal(T.resolveLifecycle(ended, { providerCanSignalFinish: true, providerFinished: false }), T.LIFECYCLE.ENDED);
});

test("LIFECYCLE: a cycle is never ended for a reason nobody recognises", () => {
  const s = scopeFor(1);
  for (const bad of ["se acabaron las jornadas", "pocas respuestas", "pasó la fecha", null, undefined, "", 42]) {
    assert.equal(T.endScope(s, bad, "t").lifecycle, T.LIFECYCLE.ACTIVE, `must not end for ${JSON.stringify(bad)}`);
  }
  assert.equal(T.endScope(s, T.ENDED_REASONS.ADMIN_STARTED_NEW_CYCLE, "t").lifecycle, T.LIFECYCLE.ENDED);
  assert.equal(T.endScope(s, T.ENDED_REASONS.PROVIDER_FINISHED_SIGNAL, "t").lifecycle, T.LIFECYCLE.ENDED);
});

test("LIFECYCLE: nothing in the code ends a tournament from event counts, round counts or dates", () => {
  const code = stripComments(scopeSrc) + stripComments(serverSrc);
  // The only two writes of ENDED are the two evidence paths.
  const endedWrites = code.match(/LIFECYCLE\.ENDED/g) || [];
  assert.ok(endedWrites.length > 0);
  // No path derives an ending from a length, a count or a clock.
  assert.ok(!/lifecycle\s*=\s*[^;]*length/.test(code), "ninguna longitud termina un torneo");
  assert.ok(!/ENDED[^\n]*Date\.now/.test(code), "ningún reloj termina un torneo");
  assert.ok(!/endScope\([^)]*(length|Date|count)/.test(code), "ni conteos ni fechas llegan a endScope");
  // And the import path asks the provider capability question honestly.
  assert.ok(serverSrc.includes("const canSignalFinish = false;"),
    "el proveedor conectado no declara finished_signal, y el código lo dice");
});

test("LIFECYCLE: a partial calendar or a provider failure changes nothing about the cycle", () => {
  const code = stripComments(blockFrom(serverSrc, 'app.post("/api/quinielas/:slug/sync-competition"'));
  // The provider call's own catch is the failure path: it rolls the whole
  // transaction back and returns, so it cannot leave the cycle half-moved.
  const failIdx = code.indexOf("catch (err) {");
  assert.ok(failIdx !== -1, "el import debe tener un camino de falla explícito");
  const failBranch = code.slice(failIdx, code.indexOf("recordSportsDataHealth({ operation: \"competition_sync\", outcome: \"success\" })"));
  assert.ok(failBranch.includes('await client.query("ROLLBACK")'), "una falla revierte todo");
  assert.ok(!failBranch.includes("lifecycle"), "una falla del proveedor no toca el ciclo");
  assert.ok(!failBranch.includes("endScope"));
  assert.ok(!failBranch.includes("tournamentScope"));
  // The lifecycle decision is taken BEFORE the provider is called at all, so
  // how much calendar came back — or whether any did — cannot reach it.
  assert.ok(code.indexOf("resolveLifecycle") < code.indexOf("getSeasonEvents"),
    "el ciclo se resuelve antes de pedir el calendario, no a partir de él");
  // And nothing anywhere reads how many events came back to decide it.
  assert.ok(!/lifecycle[^\n]*(createdRounds|eventsFetched|distinctProviderRounds|skippedEvents)/.test(code));
});

// ==== 3. per-cycle consumption ============================================

// A P1 reproduced against a live server during the adversarial pass on this
// ticket: meta.rounds is owner-written, so its round IDS are the owner's to
// choose. With "an id consumed once is free forever", an owner could start a
// new tournament, clear the board, and re-publish a whole new calendar under
// the previous cycle's ids — seven free rounds, and the no-rollover promise
// this ticket exists for is gone.
test("CONSUMPTION: an old cycle's round IDS do not buy free rounds in the new cycle", () => {
  const e1 = scopeFor(1).id;
  const e2 = scopeFor(2).id;
  const ids = ["r1", "r2", "r3"];
  const entry = { consumedRoundIdsByScope: { [e1]: ids.slice() } };

  // The board was cleared when the tournament closed: the stored row holds
  // none of those rounds any more.
  const attack = T.newlyConsumedIds(entry, ids, { currentScopeId: e2, existingRoundIds: [] });
  assert.deepEqual(attack, ids, "un calendario nuevo bajo ids viejos cuesta, no es gratis");

  // The same ids, when the rounds ARE still stored, are the same rounds — free.
  const carried = T.newlyConsumedIds(entry, ids, { currentScopeId: e2, existingRoundIds: ids });
  assert.deepEqual(carried, [], "las jornadas viejas que siguen ahí no gastan el ciclo nuevo");
});

test("CONSUMPTION: deleting and re-adding a round in the SAME cycle never charges twice", () => {
  const e1 = scopeFor(1).id;
  const entry = { consumedRoundIdsByScope: { [e1]: ["r1", "r2"] } };
  // r1 was deleted from the stored row, and is being put back.
  const again = T.newlyConsumedIds(entry, ["r1", "r2"], { currentScopeId: e1, existingRoundIds: ["r2"] });
  assert.deepEqual(again, [], "el presupuesto no se devuelve, pero tampoco se cobra dos veces");
});

test("CONSUMPTION: a round the stored row holds but never published still costs when published", () => {
  const e1 = scopeFor(1).id;
  const entry = { consumedRoundIdsByScope: { [e1]: [] } };
  // Prepared (published:false) yesterday, published today: present in the
  // stored row, but never consumed — so it costs now.
  const out = T.newlyConsumedIds(entry, ["r1"], { currentScopeId: e1, existingRoundIds: ["r1"] });
  assert.deepEqual(out, ["r1"]);
});

test("CONSUMPTION: one write claiming the same id several times counts it once", () => {
  const e1 = scopeFor(1).id;
  const entry = { consumedRoundIdsByScope: {} };
  const out = T.newlyConsumedIds(entry, ["r1", "r1", "r1"], { currentScopeId: e1, existingRoundIds: [] });
  assert.deepEqual(out, ["r1"]);
});

test("CONSUMPTION: the exemption is decided from the STORED row, never the request", () => {
  const write = blockFrom(serverSrc, 'const publishedIds = (mergedValue.rounds || [])');
  const code = stripComments(serverSrc.slice(serverSrc.indexOf("const publishedIds = (mergedValue.rounds || [])"), serverSrc.indexOf("const newlyConsumedIds =") + 400));
  assert.ok(code.includes("const storedRoundIds = (oldValue.rounds || [])"),
    "los ids que eximen vienen de la fila guardada bajo lock");
  assert.ok(!/existingRoundIds:\s*(mergedValue|value|req)/.test(code),
    "nunca del documento entrante, que es justo lo que un atacante escribe");
});

test("SCOPE: a corrupted cycle number produces NO next cycle, never a silent restart at 1", () => {
  for (const broken of [{ editionSeq: 0 }, { editionSeq: -3 }, { editionSeq: 1.5 }, { editionSeq: "2" }, {}, null]) {
    const next = T.buildNextScope(broken, { ...ligaMx });
    assert.equal(next, null, `una secuencia rota (${JSON.stringify(broken)}) no puede volver a e1`);
  }
  // And the endpoint fails the request rather than proceeding without one.
  const handler = stripComments(blockFrom(serverSrc, 'app.post("/api/quinielas/:slug/tournament/new-cycle"'));
  assert.ok(/if\s*\(!next\)\s*\{[\s\S]{0,120}ROLLBACK/.test(handler), "sin ciclo nuevo, no se escribe nada");
});


test("CONSUMPTION: an old tournament's rounds never spend the new tournament's budget", () => {
  const e1 = scopeFor(1).id;
  const e2 = scopeFor(2).id;
  let entry = { consumedRoundIdsByScope: {} };
  entry.consumedRoundIdsByScope = T.recordConsumption(entry, e1, ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
  assert.equal(T.consumedInScope(entry, e1), 7, "el primer torneo gastó sus 7");
  assert.equal(T.consumedInScope(entry, e2), 0, "el segundo empieza en cero");
});

test("CONSUMPTION: editing or re-publishing an OLD round costs nothing; a NEW round costs the current cycle", () => {
  const e1 = scopeFor(1).id;
  const e2 = scopeFor(2).id;
  let entry = { consumedRoundIdsByScope: T.recordConsumption({}, e1, ["r1", "r2", "r3"]) };
  // The board was NOT cleared: the old rounds are still in the stored row, so
  // they are the same rounds, and they cost the new cycle nothing.
  const stored = ["r1", "r2", "r3"];
  const opts = { currentScopeId: e2, existingRoundIds: stored };

  assert.deepEqual(T.newlyConsumedIds(entry, ["r1", "r2", "r3"], opts), [], "republicar lo viejo no consume");
  assert.deepEqual(T.newlyConsumedIds(entry, ["r1", "nueva"], opts), ["nueva"], "solo lo genuinamente nuevo");

  entry.consumedRoundIdsByScope = T.recordConsumption(entry, e2, T.newlyConsumedIds(entry, ["r1", "nueva"], opts));
  assert.equal(T.consumedInScope(entry, e1), 3, "el ciclo viejo no se movió");
  assert.equal(T.consumedInScope(entry, e2), 1, "y el nuevo cobró solo la nueva");
  assert.equal(T.allConsumedRoundIds(entry).size, 4);
});

test("CONSUMPTION: a payload repeating one id inside a single write counts it once", () => {
  const entry = { consumedRoundIdsByScope: {} };
  assert.deepEqual(
    T.newlyConsumedIds(entry, ["x", "x", "x", null, undefined], { currentScopeId: "ts:1:manual:e1", existingRoundIds: [] }),
    ["x"]
  );
});

test("CONSUMPTION: the map only ever grows, and a malformed one degrades instead of crashing", () => {
  for (const bad of [null, undefined, "nope", 42, [], { a: "no-array" }]) {
    const entry = { consumedRoundIdsByScope: bad };
    assert.deepEqual(T.readConsumedByScope(entry), bad && typeof bad === "object" && !Array.isArray(bad) ? {} : {});
    assert.equal(T.consumedInScope(entry, "ts:1:manual:e1"), 0);
    assert.deepEqual(T.newlyConsumedIds(entry, ["r1"]), ["r1"]);
  }
  const grown = T.recordConsumption({ consumedRoundIdsByScope: { s: ["a"] } }, "s", ["a", "b"]);
  assert.deepEqual(grown.s, ["a", "b"], "sin duplicar, sin perder");
});

// ==== 4. no rollover =======================================================

test("NO ROLLOVER: a Plus bought for one cycle does not cover the next", () => {
  const e1 = scopeFor(1).id;
  const e2 = scopeFor(2).id;
  const plus = buildPlusEntitlement(cfg, undefined, { competitionIdentity: "4350:2026-2027" });
  plus.scopeId = e1;

  assert.equal(entitlementCoversScope(plus, e1), true);
  assert.equal(entitlementCoversScope(plus, e2), false);
  // ...and enforcement refuses rather than quietly granting the old coverage.
  assert.equal(checkLifecycleRoundConsumption(plus, cfg, 999, 1, { currentScopeId: e1 }).allowed, true);
  const blocked = checkLifecycleRoundConsumption(plus, cfg, 0, 1, { currentScopeId: e2 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "entitlement_scope_mismatch");
  assert.equal(checkParticipantCapacity(plus, cfg, 0, 1, { currentScopeId: e2 }).reason, "entitlement_scope_mismatch");
});

test("NO ROLLOVER: UNKNOWN never lets a purchase leak into another cycle", () => {
  // UNKNOWN is about whether the tournament is over. It has no say in which
  // cycle a purchase belongs to, which is what makes "UNKNOWN never implies
  // rollover" structurally true rather than a rule to remember.
  const e1 = scopeFor(1, { }).id;
  const e2 = scopeFor(2).id;
  const plus = buildPlusEntitlement(cfg);
  plus.scopeId = e1;
  for (const state of Object.values(T.LIFECYCLE)) {
    const scope = { ...scopeFor(2), lifecycle: state };
    assert.equal(entitlementCoversScope(plus, scope.id), false, `estado ${state} no debe transferir nada`);
  }
  assert.equal(entitlementCoversScope(plus, e2), false);
});

test("NO ROLLOVER: a new cycle starts on the live FREE plan with its own budget", () => {
  const e2 = scopeFor(2).id;
  const fresh = buildFreeEntitlement(cfg);
  fresh.scopeId = e2;
  assert.equal(checkLifecycleRoundConsumption(fresh, cfg, 6, 1, { currentScopeId: e2 }).allowed, true);
  assert.equal(checkLifecycleRoundConsumption(fresh, cfg, 7, 1, { currentScopeId: e2 }).allowed, false);
  assert.equal(checkParticipantCapacity(fresh, cfg, 9, 1, { currentScopeId: e2 }).allowed, true);
  assert.equal(checkParticipantCapacity(fresh, cfg, 10, 1, { currentScopeId: e2 }).allowed, false);
});

test("NO ROLLOVER: going BACK to a previous cycle fabricates neither budget nor payment", () => {
  const e1 = scopeFor(1).id;
  const plus = buildPlusEntitlement(cfg);
  plus.scopeId = e1;
  // The Plus for cycle 1 still covers cycle 1, and the consumption recorded
  // under cycle 1 is still spent — nothing was reset by moving away and back.
  let entry = { consumedRoundIdsByScope: T.recordConsumption({}, e1, ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]) };
  assert.equal(T.consumedInScope(entry, e1), 7);
  assert.equal(entitlementCoversScope(plus, e1), true);
  const free = buildFreeEntitlement(cfg);
  free.scopeId = e1;
  assert.equal(checkLifecycleRoundConsumption(free, cfg, T.consumedInScope(entry, e1), 1, { currentScopeId: e1 }).allowed, false,
    "el presupuesto gastado del ciclo 1 sigue gastado");
});

// ==== 5. purchases per cycle ==============================================

const store = () => {
  const rows = new Map();
  const locks = new Map();
  return {
    raw(k) { const v = rows.get(k); return v === undefined ? null : JSON.parse(JSON.stringify(v)); },
    seed(k, v) { rows.set(k, JSON.parse(JSON.stringify(v))); },
    async tx(key, fn) {
      while (locks.get(key)) await locks.get(key);
      let release;
      locks.set(key, new Promise((r) => { release = r; }));
      try {
        const current = rows.has(key) ? JSON.parse(JSON.stringify(rows.get(key))) : null;
        return await fn({ current, write: (v) => rows.set(key, JSON.parse(JSON.stringify(v))) });
      } finally { locks.delete(key); release(); }
    },
  };
};

async function grantPlus(st, slug, grantId, { plan = "PLUS", cfgUsed = cfg } = {}) {
  return st.tx("platform_index", async ({ current: index, write: writeIndex }) =>
    st.tx("platform_payment_log", async ({ current: log, write: writeLog }) => {
      const ent = plan === "PLUS" ? buildPlusEntitlement(cfgUsed, "t", { source: "platform_grant" })
        : plan === "MANUAL_GRANT" ? buildManualGrantEntitlement("t", { grantedBy: "platform", reason: "soporte", participantLimit: 30, manualRoundLimit: 9 })
          : Object.assign(buildFreeEntitlement(cfgUsed, "t"), { source: "platform_revoke" });
      const r = applyEntitlementGrant({
        index, paymentLog: plan === "PLUS" ? log : null, entitlement: ent,
        slug, grantId, grantedBy: "platform", reason: "r", now: "t",
      });
      if (!r.ok) return { status: 400, error: r.error };
      if (r.paymentLog) writeLog(r.paymentLog);
      if (r.index) writeIndex(r.index);
      return { status: 200, applied: r.applied, recorded: r.recorded, reason: r.reason || null };
    }));
}

function seedQuiniela(st, scope) {
  st.seed("platform_index", { version: 1, quinielas: [{
    slug: "alpha", name: "Alpha", tournamentScope: scope,
    entitlement: { ...buildFreeEntitlement(cfg), scopeId: scope.id },
    entitlementHistory: [], scopeHistory: [], consumedRoundIdsByScope: { [scope.id]: [] },
  }] });
  st.seed("platform_payment_log", { version: 1, payments: [] });
}
const entryOf = (st) => st.raw("platform_index").quinielas[0];
const payments = (st) => st.raw("platform_payment_log").payments;

// Mirrors the server's new-cycle handler.
async function startNewCycle(st) {
  return st.tx("platform_index", async ({ current, write }) => {
    const entry = current.quinielas[0];
    const prev = entry.tournamentScope;
    const ended = T.endScope(prev, T.ENDED_REASONS.ADMIN_STARTED_NEW_CYCLE, "t2");
    const next = T.buildNextScope(prev, {
      sportKey: prev.sportKey,
      provider: prev.providerRefs && prev.providerRefs.provider,
      competitionId: prev.providerRefs && prev.providerRefs.competitionId,
      startedAt: "t2",
    });
    entry.scopeHistory.push({ scope: ended, roundsConsumed: T.consumedInScope(entry, prev.id), entitlementAtEnd: entry.entitlement, closedAt: "t2" });
    entry.tournamentScope = next;
    entry.consumedRoundIdsByScope = T.recordConsumption(entry, next.id, []);
    entry.entitlement = { ...buildFreeEntitlement(cfg, "t2"), scopeId: next.id, source: "new_tournament_cycle" };
    entry.entitlementHistory.push({ action: "new_cycle", at: "t2", purchase: false, entitlement: entry.entitlement });
    write(current);
    return next;
  });
}

test("PURCHASE: Apertura -> Clausura is a second purchase, and the first one is still recognised for its own cycle", async () => {
  const st = store();
  const e1 = T.buildInitialScope(ligaMx);
  seedQuiniela(st, e1);

  const first = await grantPlus(st, "alpha", "grant-apertura-001");
  assert.equal(first.recorded, true);
  assert.equal(payments(st).length, 1);

  const e2 = await startNewCycle(st);
  assert.equal(entryOf(st).entitlement.plan, "FREE", "el torneo nuevo empieza en Gratis");
  assert.equal(findPurchaseForScope(entryOf(st).entitlementHistory, e2.id), null, "la compra vieja no cubre el nuevo");
  assert.ok(findPurchaseForScope(entryOf(st).entitlementHistory, e1.id), "pero sigue reconocida para el suyo");

  const second = await grantPlus(st, "alpha", "grant-clausura-001");
  assert.equal(second.recorded, true, "el torneo nuevo es una compra nueva");
  assert.equal(payments(st).length, 2);
});

test("PURCHASE: revoke and reactivate INSIDE one cycle is still one payment (MON-002B intact)", async () => {
  const st = store();
  seedQuiniela(st, T.buildInitialScope(ligaMx));
  await grantPlus(st, "alpha", "grant-cycle-000001");
  await grantPlus(st, "alpha", "grant-cycle-000002", { plan: "FREE" });
  const back = await grantPlus(st, "alpha", "grant-cycle-000003");
  assert.equal(back.recorded, false);
  assert.equal(back.reason, "reactivated_existing_purchase");
  assert.equal(payments(st).length, 1);
});

test("PURCHASE: two tabs granting Plus for a NEW cycle with different ids produce one payment", async () => {
  const st = store();
  seedQuiniela(st, T.buildInitialScope(ligaMx));
  await grantPlus(st, "alpha", "grant-first-000001");
  await startNewCycle(st);
  const [a, b] = await Promise.all([
    grantPlus(st, "alpha", "grant-tabA-0000001"),
    grantPlus(st, "alpha", "grant-tabB-0000001"),
  ]);
  assert.equal([a, b].filter((r) => r.recorded).length, 1, "exactamente un cobro para el torneo nuevo");
  assert.equal(payments(st).length, 2, "uno por torneo, no tres");
});

test("PURCHASE: a MANUAL_GRANT in a new cycle records no money and does not create a purchase", async () => {
  const st = store();
  const e1 = T.buildInitialScope(ligaMx);
  seedQuiniela(st, e1);
  const e2 = await startNewCycle(st);
  const r = await grantPlus(st, "alpha", "grant-manual-00001", { plan: "MANUAL_GRANT" });
  assert.equal(r.applied, true);
  assert.equal(payments(st).length, 0);
  assert.equal(findPurchaseForScope(entryOf(st).entitlementHistory, e2.id), null,
    "un ajuste manual nunca cuenta como compra");
});

test("PURCHASE: a GRANDFATHERED quiniela is not a purchase, in any cycle", () => {
  const gf = buildGrandfatheredEntitlement("t");
  const history = [{ action: "grant", at: "t", entitlement: gf }];
  assert.equal(findPurchaseForScope(history, "ts:1:manual:e1"), null);
  assert.equal(findPurchaseForScope(history, "ts:1:manual:e2"), null);
});

test("PURCHASE: a legacy purchase with no cycle stamp covers the FIRST cycle and nothing else", () => {
  // Preserves a right that exists; invents none. The boot migration stamps
  // these, so this is the belt to that braces.
  const legacy = buildPlusEntitlement(cfg, "t", {});
  delete legacy.scopeId;
  assert.equal(purchaseMatchesScope(legacy, "ts:1:football:thesportsdb:4350:e1"), true);
  assert.equal(purchaseMatchesScope(legacy, "ts:1:football:thesportsdb:4350:e2"), false);
  assert.equal(purchaseMatchesScope(legacy, "ts:1:manual:e1"), true);
});

// ==== 6. over-capacity policy =============================================

test("OVER CAPACITY: a new FREE cycle keeps everybody it already has, and blocks the next one", () => {
  const e2 = scopeFor(2).id;
  const fresh = buildFreeEntitlement(cfg);
  fresh.scopeId = e2;
  // 15 people carried into a cycle whose plan allows 10.
  assert.equal(checkParticipantCapacity(fresh, cfg, 15, 0, { currentScopeId: e2 }).allowed, true,
    "nadie se borra: una operación que no suma nunca se bloquea");
  assert.equal(checkParticipantCapacity(fresh, cfg, 15, 1, { currentScopeId: e2 }).allowed, false, "y el #16 no entra");
  // Coming down to 10 does not open the door either: 10 is the limit.
  assert.equal(checkParticipantCapacity(fresh, cfg, 10, 1, { currentScopeId: e2 }).allowed, false);
  assert.equal(checkParticipantCapacity(fresh, cfg, 9, 1, { currentScopeId: e2 }).allowed, true,
    "solo por debajo del límite vuelve a haber lugar");
});

test("OVER CAPACITY: the rule is the same one that already protected a lowered config", () => {
  // No new code path: additionalCount <= 0 short-circuits before any limit is
  // consulted, which is what keeps results, standings and edits working.
  const src = stripComments(fs.readFileSync(path.join(__dirname, "..", "planLimits.js"), "utf8"));
  assert.ok(src.includes("if (add <= 0) return { allowed: true };"));
});

// ==== 7. security =========================================================

test("SECURITY: the cycle, its history and its counters are server-owned — a browser cannot write any of them", () => {
  for (const field of ["tournamentScope", "scopeHistory", "consumedRoundIdsByScope"]) {
    assert.ok(SERVER_OWNED_INDEX_FIELDS.includes(field), `${field} debe ser server-owned`);
    assert.ok(!ADMIN_EDITABLE_INDEX_FIELDS.includes(field));
  }
  const current = { version: 1, quinielas: [{
    slug: "a", name: "A",
    tournamentScope: { id: "ts:1:manual:e1", editionSeq: 1, lifecycle: "ACTIVE" },
    consumedRoundIdsByScope: { "ts:1:manual:e1": ["r1", "r2", "r3", "r4", "r5", "r6", "r7"] },
    scopeHistory: [],
  }] };
  const forged = { version: 1, quinielas: [{
    slug: "a", name: "A",
    tournamentScope: { id: "ts:1:football:thesportsdb:4350:e99", editionSeq: 99, lifecycle: "ENDED" },
    consumedRoundIdsByScope: {},                 // "reset my counters"
    scopeHistory: [{ inventado: true }],
  }] };
  const merged = mergePlatformIndex(current, forged).quinielas[0];
  assert.equal(merged.tournamentScope.id, "ts:1:manual:e1", "no puede inventar un scope");
  assert.equal(merged.tournamentScope.lifecycle, "ACTIVE", "no puede declarar ENDED");
  assert.deepEqual(merged.consumedRoundIdsByScope["ts:1:manual:e1"].length, 7, "no puede resetear contadores");
  assert.deepEqual(merged.scopeHistory, [], "no puede reescribir el historial de ciclos");
});

test("SECURITY: the new-cycle endpoint is Admin/owner only and runs in one locked transaction", () => {
  const handler = blockFrom(serverSrc, 'app.post("/api/quinielas/:slug/tournament/new-cycle"');
  assert.ok(handler.includes("computeRequesterIdentity(req, slug, meta)"));
  assert.ok(handler.includes('return res.status(403).json({ error: "forbidden" });'));
  assert.ok(handler.includes('await client.query("BEGIN")'));
  assert.ok(handler.includes('getRowLocked("platform_index", client)'));
  assert.ok(handler.includes("await getRowLocked(metaKey, client)"));
  assert.ok(handler.includes('await client.query("COMMIT")'));
  assert.ok(handler.includes('await client.query("ROLLBACK").catch(() => {})'));
  assert.ok(handler.includes("client.release()"));
  // Lock order unchanged: platform_index before the meta row.
  assert.ok(handler.indexOf('getRowLocked("platform_index"') < handler.indexOf("getRowLocked(metaKey"));
});

test("SECURITY: the client never supplies a scope, a sequence or a lifecycle", () => {
  const handler = stripComments(blockFrom(serverSrc, 'app.post("/api/quinielas/:slug/tournament/new-cycle"'));
  // The ONLY thing read from the body is a display name.
  const bodyReads = handler.match(/body\.\w+/g) || [];
  assert.deepEqual([...new Set(bodyReads)], ["body.name"], `el cuerpo solo puede aportar un nombre: ${bodyReads}`);
  assert.ok(handler.includes("tournamentScope.buildNextScope(previous"), "la secuencia sale del scope guardado");
  assert.ok(!handler.includes("body.scopeId") && !handler.includes("body.editionSeq") && !handler.includes("body.lifecycle"));
});

test("SECURITY: a grant takes its cycle from the locked row, never from the caller", () => {
  const state = stripComments(fs.readFileSync(path.join(__dirname, "..", "platformState.js"), "utf8"));
  assert.ok(state.includes("const currentScopeId = entry.tournamentScope && entry.tournamentScope.id;"));
  assert.ok(state.includes("if (currentScopeId) granted.scopeId = currentScopeId;"));
  // The grant endpoint reads no scope from the body either.
  const handler = stripComments(blockFrom(serverSrc, 'app.post("/api/platform/quinielas/:slug/entitlement"'));
  assert.ok(!handler.includes("body.scopeId") && !handler.includes("body.competitionIdentity"));
});

test("SECURITY: monetisation never reads a provider id directly", () => {
  // The layering the ticket asks for: provider fields reach the scope's
  // METADATA, and the commercial decision reads the internal id only.
  const state = stripComments(fs.readFileSync(path.join(__dirname, "..", "platformState.js"), "utf8"));
  const limits = stripComments(fs.readFileSync(path.join(__dirname, "..", "planLimits.js"), "utf8"));
  for (const provider of ["sportsdbLeagueId", "thesportsdb", "sportmonks", "idLeague", "strSeason"]) {
    assert.ok(!state.includes(provider), `platformState no debe nombrar ${provider}`);
    assert.ok(!limits.includes(provider), `planLimits no debe nombrar ${provider}`);
  }
  // And the decision functions key on the scope id.
  assert.ok(state.includes("purchaseMatchesScope(ent, scope)"));
  assert.ok(limits.includes("function entitlementCoversScope(entitlement, currentScopeId)"));
});

// ==== 8. what the browser is allowed to know =============================

// A P0 caught in the browser run, not by any source test: apiStartNewTournament
// had been inserted INTO the body of setMetaWithError, so it was block-scoped
// and every tournament action died on a ReferenceError. The file still parsed;
// only running it revealed anything. This is the cheap structural guard for
// that whole class — a helper meant to be a sibling of the other helpers must
// sit BETWEEN them, not inside one.
test("FRONTEND: the tournament helpers are declared as siblings, not buried inside another function", () => {
  const lines = indexSrc.split("\n");
  const helpers = [
    "async function apiStartNewTournament(name){",
    "function tournamentStatusHtml(plan){",
    "function tournamentEndedCardHtml(plan){",
    "async function startNewTournamentFlow(plan){",
    "function wireTournamentActions(scope){",
  ];
  for (const decl of helpers) {
    const at = lines.findIndex((l) => l.includes(decl));
    assert.ok(at !== -1, `no se encontró: ${decl}`);
    assert.ok(/^ {2}\S/.test(lines[at]), `${decl} debe estar al mismo nivel que los demás helpers: ${JSON.stringify(lines[at].slice(0, 40))}`);
    // Walk back past comments and blank lines: the first real line above a
    // sibling helper is the close of the previous one, never a statement.
    let i = at - 1;
    while (i >= 0 && (lines[i].trim() === "" || lines[i].trim().startsWith("//"))) i--;
    assert.ok(i >= 0, `${decl} no tiene nada antes`);
    assert.ok(/^ {2}\}$/.test(lines[i]) || /^ {2}\S/.test(lines[i]),
      `${decl} quedó dentro de otra función — la línea anterior es ${JSON.stringify(lines[i].slice(0, 60))}`);
    assert.ok(!/^\s{4,}\S/.test(lines[i]),
      `${decl} quedó dentro de otra función — la línea anterior está indentada: ${JSON.stringify(lines[i].slice(0, 60))}`);
  }
});

test("FRONTEND: no commercial identity is hardcoded in the browser", () => {
  const code = stripComments(indexSrc);
  // No scope ids, no provider-derived commercial identity.
  assert.ok(!code.includes("ts:1:"), "ningún id de ciclo vive en el frontend");
  assert.ok(!/scopeId/.test(code), "el navegador nunca ve ni manda un scopeId");
  // competitionIdentity is a MON-001D provider-derived string. The QRACKS
  // operator console reads the raw platform_index row it already fetched, so
  // one PRESENCE test survives — but the value itself is never rendered,
  // never sent back, and never used to build an id.
  const identityUses = code.match(/competitionIdentity/g) || [];
  assert.equal(identityUses.length, 1, "una sola lectura, y solo en la consola de operador");
  assert.ok(code.includes("const bound = !!q.entitlement.competitionIdentity;"),
    "y esa lectura es un booleano, nunca el valor");
  assert.ok(!/consumedRoundIdsByScope/.test(code));
  assert.ok(!/editionSeq/.test(code));
});

test("FRONTEND: the tournament is described in words, never in identifiers", () => {
  const fn = blockFrom(indexSrc, "function tournamentStatusHtml(plan)");
  assert.ok(fn.includes("t.name"), "usa el nombre que manda el servidor");
  assert.ok(fn.includes("t.state"));
  assert.ok(!fn.includes("scope") && !fn.includes("entitlement"), "nunca jerga interna");
  assert.ok(fn.includes("Torneo actual"));
  assert.ok(fn.includes("este torneo terminó"));
});

test("FRONTEND: the new-tournament flow states the consequence before doing anything", () => {
  const fn = blockFrom(indexSrc, "async function startNewTournamentFlow(plan)");
  assert.ok(fn.includes("no se transfiere"), "dice que el Plus anterior no se transfiere");
  assert.ok(fn.includes("Se conservan tus participantes"), "y que no se pierde nada");
  assert.ok(fn.includes("qzConfirm"), "confirma antes de actuar");
  assert.ok(fn.indexOf("qzConfirm") < fn.indexOf("apiStartNewTournament"), "la confirmación va primero");
  // One primary action per state: the ended card offers exactly one button.
  const card = blockFrom(indexSrc, "function tournamentEndedCardHtml(plan)");
  assert.equal((card.match(/<button/g) || []).length, 1, "una sola acción primaria");
});

// A P1 found in QA on this ticket: "Cerrar torneo y empezar uno nuevo" wiped
// every round but left the quiniela on the SAME commercial cycle with its
// budget already spent — an empty quiniela that could not publish anything,
// after a button that said it had started a new tournament.
test("FRONTEND: closing the tournament actually starts the next one", () => {
  const handler = blockFrom(indexSrc, 'document.getElementById("qz-close-tournament").addEventListener');
  const code = stripComments(handler);
  assert.ok(code.includes("apiStartNewTournament"), "cerrar el torneo mueve el ciclo comercial");
  // Order matters: nothing is destroyed until the new cycle actually exists,
  // so a failure leaves the Admin able to retry instead of stranded.
  assert.ok(code.indexOf("apiStartNewTournament") < code.indexOf("meta.rounds = []"),
    "el ciclo se mueve ANTES de borrar las jornadas");
  assert.ok(code.indexOf("qzConfirm") < code.indexOf("apiStartNewTournament"),
    "y después de confirmar, nunca antes");
  // And a failed cycle move aborts without touching anything.
  const guard = code.slice(code.indexOf("apiStartNewTournament"), code.indexOf("meta.rounds = []"));
  assert.ok(/if\s*\(!cycle\.ok\)\s*\{[^}]*return;/.test(guard), "si falla, no se destruye nada");
  // The Admin is told what it costs them before it happens.
  assert.ok(handler.includes("tu Plus no se transfiere"), "avisa que el Plus no se transfiere");
  // The two actions no longer both claim to start a new tournament.
  assert.ok(indexSrc.includes("Empezar un torneo nuevo sin cerrar este"),
    "la acción sin archivar se distingue de la de cerrar");
});

test("FRONTEND: the tournament surface is Admin-only", () => {
  const strip = blockFrom(indexSrc, "async function renderPlanStrip()");
  assert.ok(strip.includes("currentUser && currentUser.isAdmin"));
  assert.ok(strip.includes("tournamentStatusHtml(plan)"));
  assert.ok(strip.includes("tournamentEndedCardHtml(plan)"));
  // The participant-facing rejection still carries nothing commercial.
  const reg = stripComments(blockFrom(serverSrc, 'app.post("/api/self-register"'));
  const at = reg.indexOf("if (!check.allowed)");
  assert.ok(at !== -1);
  const slice = reg.slice(at, at + 400);
  assert.ok(slice.includes('return res.status(402).json({ error: check.reason });'));
  assert.ok(!slice.includes("tournament") && !slice.includes("upgrade"));
});

// The rule this ticket states is about a PURCHASE. Applying it to statuses
// that were never bought was reproduced doing real damage: an operator's
// 40-seat courtesy grant vanished on the next tournament and left a 15-person
// group stuck under the 10-person FREE cap.
test("RENEWAL: a Plus PURCHASE resets, a granted status carries — and both are stamped for the new cycle", () => {
  const handler = stripComments(blockFrom(serverSrc, 'app.post("/api/quinielas/:slug/tournament/new-cycle"'));
  assert.ok(handler.includes('const carriesOver = previousPlan === "GRANDFATHERED" || previousPlan === "MANUAL_GRANT";'),
    "sólo lo que no fue una compra se conserva");
  // The carried plan is re-stamped for the cycle it now covers — otherwise it
  // would be refused by the scope check the moment it was used.
  const carried = handler.slice(handler.indexOf("if (carriesOver) {"), handler.indexOf("} else {"));
  assert.ok(carried.includes("scopeId: next.id"), "y queda sellado con el ciclo nuevo");
  assert.ok(!carried.includes("pricePaidMXN ="), "conservar nunca inventa un pago");
  // A revoked plan is not carried: revoking must not survive a new tournament
  // as if it were still granted.
  assert.ok(handler.includes("entry.entitlement && !entry.entitlement.revoked ? entry.entitlement.plan : null"),
    "un plan revocado no se conserva");
  // The FREE branch is what PLUS falls to, and it says why.
  const reset = handler.slice(handler.indexOf("} else {"), handler.indexOf("freshEntitlement.competitionIdentity = null;"));
  assert.ok(reset.includes("buildFreeEntitlement(commercialConfig, now)"));
  assert.ok(reset.includes('source = "new_tournament_cycle"'));
  // Carrying is auditable rather than indistinguishable from a fresh grant.
  assert.ok(handler.includes('carriesOver ? "new_cycle_carried" : "new_cycle"'));
  // And nothing about a new cycle ever touches the payment log.
  assert.ok(!handler.includes("platform_payment_log"), "empezar un torneo nunca cobra");
});

test("RENEWAL: the new cycle never inherits the old competition binding", () => {
  const handler = stripComments(blockFrom(serverSrc, 'app.post("/api/quinielas/:slug/tournament/new-cycle"'));
  assert.ok(handler.includes("freshEntitlement.competitionIdentity = null;"),
    "el torneo nuevo adopta la competencia que realmente importe, no la anterior");
  // It applies on BOTH branches — a carried grant that kept the old binding
  // would silently pin the new tournament to the previous one's competition.
  assert.ok(handler.indexOf("freshEntitlement.competitionIdentity = null;") > handler.indexOf("} else {"),
    "fuera del if/else, así que aplica igual a lo conservado y a lo reiniciado");
});

test("PLAN READ: the tournament block carries no identifiers a browser could echo back", () => {
  const handler = blockFrom(serverSrc, 'app.get("/api/quinielas/:slug/plan"');
  const at = handler.indexOf("tournament: currentScope ? {");
  assert.ok(at !== -1, "el endpoint debe reportar el torneo");
  const block = handler.slice(at, handler.indexOf("} : null,", at));
  assert.ok(!block.includes("id:"), "sin id de ciclo");
  assert.ok(!block.includes("providerRefs"), "sin referencias del proveedor");
  assert.ok(block.includes("cycle:") && block.includes("name:") && block.includes("state:"));
});

// ==== 9. migration ========================================================

test("MIGRATION: it is idempotent, and a second boot changes nothing", () => {
  const migration = blockFrom(serverSrc, "(idx.quinielas || []).forEach((entry) => {");
  // Every branch is guarded by "is it missing?", which is what makes running
  // it on every boot converge after the first one.
  assert.ok(serverSrc.includes("if (!entry.tournamentScope || !tournamentScope.isUsableScopeId(entry.tournamentScope.id)) {"));
  assert.ok(serverSrc.includes("if (!entry.consumedRoundIdsByScope || typeof entry.consumedRoundIdsByScope !== \"object\""));
  assert.ok(serverSrc.includes("if (entry.entitlement && !entitlementScopeId(entry.entitlement)) {"));
  assert.ok(migration.includes("entry.tournamentScope.lifecycle = tournamentScope.LIFECYCLE.UNKNOWN;"),
    "un ciclo que no empezamos nosotros es UNKNOWN, nunca ENDED por suposición");
});

test("MIGRATION: an existing quiniela keeps what it had and gains nothing", () => {
  // Simulated on the exact shapes the migration handles, driving the real
  // helpers rather than restating them.
  const legacyPlus = buildPlusEntitlement(cfg, "t", { competitionIdentity: "4350:2026-2027" });
  delete legacyPlus.scopeId;
  const entry = {
    slug: "old", entitlement: legacyPlus,
    entitlementHistory: [{ action: "grant", at: "t", purchase: true, entitlement: legacyPlus }],
    lifecycleConsumedRoundIds: ["r1", "r2", "r3"],
    lifecycleRoundsConsumed: 3,
  };
  // What the migration does, in the same order:
  const scope = T.buildInitialScope({ sportKey: "football", provider: "thesportsdb", competitionId: "4350", providerSeasonId: "2026-2027" });
  scope.lifecycle = T.LIFECYCLE.UNKNOWN;
  entry.tournamentScope = scope;
  entry.consumedRoundIdsByScope = { [scope.id]: entry.lifecycleConsumedRoundIds.map(String) };
  entry.entitlement.scopeId = scope.id;
  entry.entitlementHistory[0].entitlement.scopeId = scope.id;

  // Right preserved: the purchase still covers what it was covering.
  assert.ok(findPurchaseForScope(entry.entitlementHistory, scope.id), "la compra sigue cubriendo su torneo");
  assert.equal(T.consumedInScope(entry, scope.id), 3, "y lo gastado sigue gastado");
  // No right invented: the next edition is not covered.
  const next = T.buildNextScope(scope, { sportKey: "football", provider: "thesportsdb", competitionId: "4350" });
  assert.equal(findPurchaseForScope(entry.entitlementHistory, next.id), null, "y no cubre la siguiente edición");
  // No double charge: the migration writes no payment at all.
  const migrationSrc = stripComments(serverSrc.slice(serverSrc.indexOf("MON-002C: give every existing quiniela"), serverSrc.indexOf("if (migrated) {")));
  assert.ok(!migrationSrc.includes("platform_payment_log"), "la migración nunca toca el log de pagos");
  assert.ok(!migrationSrc.includes("buildPlusEntitlement"), "ni otorga planes");
});

test("MIGRATION: a quiniela with no league gets a manual cycle, not a fake competition", () => {
  const scope = T.buildInitialScope({ sportKey: "football", provider: null, competitionId: null });
  assert.equal(scope.id, "ts:1:manual:e1");
  assert.equal(scope.providerRefs.provider, null);
  assert.equal(scope.providerRefs.competitionId, null);
});

// ==== 10. the documented gap ==============================================

test("THE MISSING DATUM is documented in code, not worked around", () => {
  // The audit's conclusion has to live next to the design it justifies, so
  // the next person does not re-derive it — or worse, "fix" it with a name
  // parser.
  assert.ok(scopeSrc.includes("MULTI_INSTANCE_SEASONS"));
  assert.ok(scopeSrc.includes("FINISHED_SIGNAL"));
  assert.ok(scopeSrc.includes("Apertura"), "el caso concreto está nombrado");
  assert.ok(/does not detect that Apertura ended and Clausura began/i.test(scopeSrc),
    "y se dice explícitamente qué NO hace");
  // And nothing parses a competition name to decide anything commercial.
  const code = stripComments(scopeSrc) + stripComments(fs.readFileSync(path.join(__dirname, "..", "platformState.js"), "utf8"));
  assert.ok(!/displayName[^\n]*(match|test|indexOf|includes|split)/.test(code),
    "el displayName nunca se parsea para decidir nada");
});
