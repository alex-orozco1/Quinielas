// AUTO-001 — Competition Sync planning logic.
//
// Deliberately separate from server.js, which can't be require()'d in tests
// without a live Postgres connection (documented already in the DATA-001/
// Sprint 15.1 QA reports). The single most safety-critical part of this
// ticket — idempotency, never overwriting manual work, never guessing a
// round for an event that doesn't have one — lives here as a pure function
// so it's actually unit-testable, not just structurally checked against
// server.js's source text.
//
// planCompetitionSync() never mutates its inputs and never decides anything
// about rounds that already exist — it only ever proposes NEW rounds to add.
// The caller (server.js) is responsible for assigning ids (a
// storage/DB-adjacent concern) and persisting the result.

function planCompetitionSync({ existingRounds, events, provider }) {
  const existingExternalRoundIds = new Set(
    (existingRounds || [])
      .filter((r) => r.provider === provider && r.externalRoundId != null)
      .map((r) => r.externalRoundId)
  );
  // FIX 1 (QA): protects manual/legacy rounds too, not just previously
  // imported ones. A round's `number` is the thing participants actually
  // see ("Jornada 3") — if ANY existing round already occupies that number,
  // regardless of whether it has a provider/externalRoundId at all, a
  // numeric-matching provider round must never create a second "Jornada 3".
  // The existing round always wins: never modified, never annotated with
  // externalRoundId retroactively, never merged.
  const existingRoundNumbers = new Set(
    (existingRounds || [])
      .map((r) => Number(r.number))
      .filter((n) => Number.isFinite(n))
  );

  // Group by provider round (string). Events with no round at all are never
  // guessed into an existing or invented round — they're counted and
  // otherwise ignored.
  const groups = new Map();
  let skippedEvents = 0;
  for (const ev of events) {
    if (ev.round == null) { skippedEvents++; continue; }
    if (existingExternalRoundIds.has(ev.round)) continue; // already imported — untouched, not a "skip"
    if (!groups.has(ev.round)) groups.set(ev.round, []);
    groups.get(ev.round).push(ev);
  }

  let nextFallbackNumber = Math.max(0, ...(existingRounds || []).map((r) => Number(r.number) || 0)) + 1;
  const newRounds = [];

  for (const [externalRoundId, evs] of groups) {
    // Numeric provider round ids get QRACKS's natural round number (so
    // "Jornada 17" matches the provider's own round 17); non-numeric labels
    // (e.g. "Final") fall back to the next sequential number, same as manual
    // round creation already does. Determined up front (before building
    // matches) so the FIX 1 collision check below can skip the whole group
    // without doing unnecessary work.
    const isNumeric = /^[0-9]+$/.test(externalRoundId);

    // FIX 1: an existing round — manual, legacy, or from a different
    // provider — already occupies this exact round number. Never create a
    // duplicate "Jornada N"; the existing one is left completely untouched.
    if (isNumeric && existingRoundNumbers.has(Number(externalRoundId))) continue;

    const seenEventIds = new Set();
    const matches = [];
    let earliestKickoffMs = null;
    for (const ev of evs) {
      if (ev.externalEventId != null) {
        if (seenEventIds.has(ev.externalEventId)) continue; // duplicate event within the same round batch
        seenEventIds.add(ev.externalEventId);
      }
      const [home, away] = ev.participants || [];
      matches.push({
        teamA: (home && home.name) || "",
        teamB: (away && away.name) || "",
        externalEventId: ev.externalEventId || null,
        externalHomeId: (home && home.externalId) || null,
        externalAwayId: (away && away.externalId) || null,
        kickoffAt: ev.dateTime || null,
      });
      if (ev.dateTime) {
        const t = new Date(ev.dateTime).getTime();
        if (Number.isFinite(t) && (earliestKickoffMs == null || t < earliestKickoffMs)) earliestKickoffMs = t;
      }
    }
    // Defensive: a round with no matches (shouldn't happen — groups only
    // ever get created with >=1 event) or with no usable kickoff date to
    // seed a deadline from is skipped rather than guessed at.
    if (!matches.length || earliestKickoffMs == null) continue;

    const number = isNumeric ? Number(externalRoundId) : nextFallbackNumber++;

    newRounds.push({
      number,
      matches,
      deadline: new Date(earliestKickoffMs).toISOString(),
      results: {},
      resultsPublished: false,
      published: false, // prepared, not yet visible to participants — see AUTO-001 §14/§15
      provider,
      externalRoundId,
    });
  }

  return { newRounds, skippedEvents };
}

module.exports = { planCompetitionSync };
