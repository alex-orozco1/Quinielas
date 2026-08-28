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

// MON-001E: see the grouping comment below. Conservative on purpose.
const ROUND_SPLIT_GAP_DAYS = 5;

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
  const rawGroups = new Map();
  let skippedEvents = 0;
  for (const ev of events) {
    if (ev.round == null) { skippedEvents++; continue; }
    if (existingExternalRoundIds.has(ev.round)) continue; // already imported — untouched, not a "skip"
    if (!rawGroups.has(ev.round)) rawGroups.set(ev.round, []);
    rawGroups.get(ev.round).push(ev);
  }

  // MON-001E: a single provider round id does NOT always mean a single
  // matchday. Two real, confirmed cases from Liga MX broke the old
  // "group by intRound alone" rule:
  //   1. A whole knockout phase can share one code — Apertura 2025 returned
  //      intRound=0 for four separate matchdays (Nov 21, Nov 27, Dec 4,
  //      Dec 12). They were collapsing into ONE round.
  //   2. Within one strSeason, Apertura and Clausura BOTH restart at
  //      intRound=1 — so Apertura J1 and Clausura J1 (five months apart)
  //      were merging into a single "Jornada 1".
  // Splitting on a date gap fixes both WITHOUT inventing any semantics about
  // what 0/125/200 mean: it only asserts that matches played weeks apart are
  // not the same matchday. The threshold is deliberately conservative — a
  // normal matchday spans Fri→Mon (<=3 days), while the real observed gaps
  // between distinct phases were 6-8 days — so ordinary rounds, including
  // ones with a postponed match a few days later, are never split.
  const groups = [];
  for (const [externalRoundId, evs] of rawGroups) {
    const dated = evs.filter((e) => e.dateTime && Number.isFinite(new Date(e.dateTime).getTime()));
    const undated = evs.filter((e) => !(e.dateTime && Number.isFinite(new Date(e.dateTime).getTime())));
    if (!dated.length) { groups.push({ externalRoundId, evs }); continue; }
    dated.sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
    let bucket = [dated[0]];
    for (let i = 1; i < dated.length; i++) {
      const gapMs = new Date(dated[i].dateTime) - new Date(dated[i - 1].dateTime);
      if (gapMs > ROUND_SPLIT_GAP_DAYS * 24 * 60 * 60 * 1000) {
        groups.push({ externalRoundId, evs: bucket });
        bucket = [];
      }
      bucket.push(dated[i]);
    }
    // Undated events (if any) ride along with the first bucket rather than
    // being dropped — same defensive posture as before.
    groups.push({ externalRoundId, evs: bucket.concat(groups.length ? [] : undated) });
    if (undated.length && groups.length > 1) groups[groups.length - 1].evs = groups[groups.length - 1].evs.concat(undated);
  }

  let nextFallbackNumber = Math.max(0, ...(existingRounds || []).map((r) => Number(r.number) || 0)) + 1;
  const newRounds = [];

  for (const { externalRoundId, evs } of groups) {
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

    // MON-001E: round.number keeps its EXACT existing meaning and behaviour —
    // it is the commercial/ordering key that Payment Penalty
    // (r.number >= startsAtRound), Adicionales (bet.closesAtRound), scoring
    // cutoffs (r.number > cutoffRoundNumber) and "next manual round"
    // (max(number)+1) all depend on. It is NOT a display field and NOT a
    // provider passthrough to be reinterpreted.
    //
    // The ONE correction here: a provider round id of 0 was previously taken
    // literally, producing round.number = 0. That is not a valid QRACKS round
    // number (rounds are 1-based) and it silently broke Payment Penalty —
    // `0 >= startsAtRound` is false, so a knockout round coded 0 was excluded
    // from penalties entirely. Codes below 1 now take the same sequential
    // fallback that non-numeric labels ("Final") have always used. Every
    // other value keeps byte-for-byte identical behaviour.
    const numericValue = isNumeric ? Number(externalRoundId) : null;
    const usableAsNumber = numericValue != null && numericValue >= 1;
    const number = usableAsNumber ? numericValue : nextFallbackNumber++;

    newRounds.push({
      number,
      // MON-001E: monotonic chronological ordering key, derived from the
      // round's own earliest kickoff — never from a provider code. Additive
      // and currently unread by any consumer: it exists so ordering can
      // later stop depending on `number` without another migration. Assigned
      // after the loop, once every new round's kickoff is known.
      sortKey: null,
      // MON-001E: the semantic label the UI shows. null means "no semantic
      // label known — fall back to Jornada {number}", which is exactly the
      // current behaviour for every existing round. Deliberately NOT derived
      // from provider codes: MON-001D.2 proved 0/125/200 have no stable
      // meaning (125 appeared in Clausura but not Apertura, and 0 covered
      // four different matchdays), so inventing "Cuartos de Final" here would
      // be a guess. An Admin can set it manually; a future ticket can
      // populate it from a provider that actually models stages.
      displayLabel: null,
      stage: "UNKNOWN",
      matches,
      deadline: new Date(earliestKickoffMs).toISOString(),
      results: {},
      resultsPublished: false,
      published: false, // prepared, not yet visible to participants — see AUTO-001 §14/§15
      provider,
      externalRoundId,
      // MON-001E: raw provider metadata carried through from
      // sportsDataProvider.normalizeEvent(). Persisted for auditability and
      // future work; never an enforcement authority (it lives in
      // owner-writable meta).
      providerReferences: {
        [provider]: {
          rawRound: (evs[0] && evs[0].providerMeta && evs[0].providerMeta.rawRound) || externalRoundId,
          season: (evs[0] && evs[0].providerMeta && evs[0].providerMeta.season) || null,
          eventIds: matches.map((m) => m.externalEventId).filter(Boolean),
        },
      },
    });
  }

  // MON-001E: assign sortKey chronologically across the rounds this sync is
  // proposing, continuing after whatever the quiniela already has. Existing
  // rounds are never touched (they simply have no sortKey until a future
  // ticket backfills one), consistent with this ticket being purely additive.
  const existingMaxSortKey = Math.max(
    0,
    ...(existingRounds || []).map((r) => Number(r.sortKey) || 0)
  );
  newRounds
    .slice()
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline))
    .forEach((r, i) => { r.sortKey = existingMaxSortKey + i + 1; });

  return { newRounds, skippedEvents };
}

module.exports = { planCompetitionSync };
