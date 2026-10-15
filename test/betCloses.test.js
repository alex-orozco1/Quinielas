// MS2 · D4 — betCloses.js, las funciones puras: el cierre propio de cada
// pregunta del torneo, lo que una escritura puede y no puede cambiar, y el
// archivo al cerrar el torneo. La integración con el servidor real está en
// betCloses.integration.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const { betCloseState, withStoredBetFields, resolveBetCloses, archiveBetsForClose, retiredBetIds, SERVER_BET_FIELDS } = require("../betCloses");

const NOW = Date.parse("2026-10-15T18:00:00Z");
const at = (h) => new Date(NOW + h * 3600e3).toISOString();
const round = (id, number, h) => ({ id, number, deadline: at(h), matches: [] });
const R1 = round("r_1", 1, 24), R2 = round("r_2", 2, 72), R1past = round("r_1", 1, -1);
const resolve = (stored, merged) => resolveBetCloses({ stored, merged, nowMs: NOW });
const own = (over) => ({ id: "cb_x", label: "Campeón", scope: "temporada", points: 5, closesAtRound: 1, closesAt: at(24), closesRoundId: "r_1", closeSource: "round", epoch: 0, ...over });

test("betCloseState: con cierre propio manda su closesAt, no su jornada; antigua sin migrar, por número", () => {
  assert.deepEqual(betCloseState(own({ closesAt: at(-1) }), [R1], NOW).closed, true, "su jornada abierta no la reabre");
  assert.equal(betCloseState(own(), [R1past], NOW).closed, false, "su jornada cerrada no la cierra");
  assert.equal(betCloseState(own({ closesAt: at(0) }), [], NOW).closed, true, "cierra justo a su hora");
  assert.deepEqual([betCloseState({ scope: "temporada", closesAtRound: 1 }, [R1past], NOW).kind, betCloseState({ scope: "temporada", closesAtRound: 1 }, [R1past], NOW).closed], ["legacy", true]);
  assert.deepEqual(betCloseState({ scope: "temporada", closesAtRound: 1 }, [], NOW), { kind: "legacy", closed: false, roundFound: false });
  assert.deepEqual(betCloseState({ scope: "temporada", closesAtRound: null }, [R1], NOW), { kind: "none", closed: false });
  assert.deepEqual(betCloseState({ scope: "temporada", closeSource: "none", closesAtRound: 1 }, [R1past], NOW), { kind: "none", closed: false });
  assert.deepEqual(betCloseState({ scope: "jornada" }, [R1], NOW), { kind: "jornada", closed: false });
});

test("nueva: nace con el cierre y el id de su jornada (por número o por id) y su torneo; lo que mande el cliente en esos campos no cuenta", () => {
  const r = resolve({ rounds: [R1, R2], customBets: [], tournamentEpoch: 3 },
    { rounds: [R1, R2], customBets: [{ id: "cb_n", label: "x", scope: "temporada", points: 1, closesAtRound: 2, closesAt: at(999), closeSource: "none", epoch: 0 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.customBets[0], { id: "cb_n", label: "x", scope: "temporada", points: 1, closesAtRound: 2, closesAt: at(72), closesRoundId: "r_2", closeSource: "round", epoch: 3 });
  const byId = resolve({ rounds: [R1, R2], customBets: [] }, { rounds: [R1, R2], customBets: [{ id: "cb_n", scope: "temporada", closesAtRound: 1, closesRoundId: "r_2" }] });
  assert.deepEqual([byId.customBets[0].closesRoundId, byId.customBets[0].closesAtRound], ["r_2", 2], "el id manda; el número se corrige");
  for (const [bet, error] of [[{ closesAtRound: null }, "bet_close_required"], [{ closesAtRound: 9 }, "bet_close_required"], [{ closesRoundId: "r_zz" }, "bet_close_required"]]) {
    assert.deepEqual(resolve({ rounds: [R1] }, { rounds: [R1], customBets: [{ id: "cb_n", scope: "temporada", ...bet }] }), { ok: false, status: 400, error, betId: "cb_n" });
  }
  assert.deepEqual(resolve({ rounds: [R1past] }, { rounds: [R1past], customBets: [{ id: "cb_n", scope: "temporada", closesAtRound: 1 }] }).error, "bet_close_past");
  const j = resolve({}, { rounds: [], customBets: [{ id: "cb_j", scope: "jornada", closesAt: at(5) }] });
  assert.deepEqual(j.customBets[0], { id: "cb_j", scope: "jornada", epoch: 0 }, "las de jornada no llevan reloj propio");
});

test("cerrada: ni jornada, ni tipo, ni vínculo, ni cierre cambian (409); editar texto y puntos sí", () => {
  const closed = own({ closesAt: at(-1) });
  const stored = { rounds: [R1past, R2], customBets: [closed] };
  for (const change of [{ closesAtRound: 2 }, { scope: "jornada" }, { closesRoundId: "r_2" }, { closesAt: at(72) }, { closesAt: null }, { closesRoundId: null }]) {
    assert.deepEqual(resolve(stored, { rounds: [R1past, R2], customBets: [{ ...closed, ...change }] }), { ok: false, status: 409, error: "bet_close_locked", betId: "cb_x" }, JSON.stringify(change));
  }
  const ok = resolve(stored, { rounds: [R1past, R2], customBets: [{ ...closed, label: "Nuevo", points: 9 }] });
  assert.deepEqual([ok.ok, ok.customBets[0].label, ok.customBets[0].points, ok.customBets[0].closesAt], [true, "Nuevo", 9, at(-1)]);
});

test("los seis caminos: A borrar, B renumerar, C mover su jornada no la reabren; D 409; E se archiva cerrada; F su id no vuelve", () => {
  const closed = own({ closesAt: at(-1) });
  const stored = { rounds: [R1past, R2], customBets: [closed] };
  const after = (rounds) => resolve(stored, { rounds, customBets: [closed] });
  for (const rounds of [[R2], [{ ...R1past, number: 20 }, R2], [{ ...R1past, deadline: at(48) }, R2]]) {
    const r = after(rounds);
    assert.equal(r.ok, true);
    assert.equal(betCloseState(r.customBets[0], rounds, NOW).closed, true);
  }
  assert.equal(resolve(stored, { rounds: [R1past, R2], customBets: [{ ...closed, closesAtRound: 2 }] }).error, "bet_close_locked");
  const meta = { rounds: [R1past, R2], customBets: [closed], participants: [{ id: "p_b", customBetAnswers: { cb_x: { guess: "A", correct: true } } }] };
  const arch = archiveBetsForClose(meta, at(0), NOW);
  assert.deepEqual(arch.customBets[0].closesAt, at(-1), "conserva su cierre");
  const stored2 = { rounds: [], customBets: [], pastTournaments: [{ customBets: arch.customBets }], tournamentEpoch: 1, participants: meta.participants };
  assert.deepEqual(resolve(stored2, { rounds: [round("r_new1", 1, 48)], customBets: [own()] }).error, "bet_retired");
});

test("antigua sin migrar y ya cerrada (por número): ningún cambio del tablero puede dejarla abierta", () => {
  const legacy = { id: "cb_l", scope: "temporada", closesAtRound: 1, points: 2, label: "L" };
  const stored = { rounds: [R1past, R2], customBets: [legacy] };
  for (const rounds of [[R2], [{ ...R1past, number: 20 }, R2], [{ ...R1past, deadline: at(48) }, R2]]) {
    assert.deepEqual(resolve(stored, { rounds, customBets: [legacy] }).error, "bet_close_locked");
    // Guardando, de forma explícita, el cierre que ya tiene: el tablero cambia y ella sigue cerrada.
    const kept = resolve(stored, { rounds, customBets: [{ ...legacy, closesAt: R1past.deadline }] });
    assert.equal(kept.ok, true);
    assert.deepEqual([kept.customBets[0].closesAt, kept.customBets[0].closesRoundId], [R1past.deadline, "r_1"]);
    assert.equal(betCloseState(kept.customBets[0], rounds, NOW).closed, true);
  }
  assert.equal(resolve(stored, { rounds: [R1past, R2], customBets: [{ ...legacy, closesAt: at(48) }] }).error, "bet_close_locked", "nunca otra hora");
  assert.equal(resolve(stored, { rounds: [R1past, R2], customBets: [{ ...legacy, label: "L2" }] }).ok, true);
});

test("abierta: editar su jornada no la mueve; moverla es explícito y sólo a la hora de SU jornada; ligarla a otra abierta", () => {
  const open = own();
  const moved = { ...R1, deadline: at(30) };
  const stored = { rounds: [R1, R2], customBets: [open] };
  assert.equal(resolve(stored, { rounds: [moved, R2], customBets: [open] }).customBets[0].closesAt, at(24), "no se mueve sola");
  assert.equal(resolve(stored, { rounds: [moved, R2], customBets: [{ ...open, closesAt: at(30) }] }).customBets[0].closesAt, at(30));
  assert.deepEqual(resolve(stored, { rounds: [moved, R2], customBets: [{ ...open, closesAt: at(40) }] }).error, "bet_close_invalid");
  assert.deepEqual(resolve(stored, { rounds: [moved, R2], customBets: [{ ...open, closesAt: at(72) }] }).error, "bet_close_invalid", "ni a la hora de otra jornada");
  const relinked = resolve(stored, { rounds: [R1, R2], customBets: [{ ...open, closesRoundId: "r_2" }] }).customBets[0];
  assert.deepEqual([relinked.closesRoundId, relinked.closesAtRound, relinked.closesAt], ["r_2", 2, at(72)]);
  // Su jornada se borra: conserva su cierre.
  assert.equal(resolve(stored, { rounds: [R2], customBets: [open] }).customBets[0].closesAt, at(24));
  // Moverla a una hora ya pasada (cerrarla antes) también es explícito y válido.
  const early = { ...R1, deadline: at(-0.5) };
  assert.equal(resolve(stored, { rounds: [early, R2], customBets: [{ ...open, closesAt: at(-0.5) }] }).customBets[0].closesAt, at(-0.5));
});

test("un cliente que omite los campos del servidor no los borra; los que manda distintos en epoch/closeSource/closeFlag no cuentan", () => {
  const open = own();
  const stored = { rounds: [R1], customBets: [open] };
  const filled = withStoredBetFields(stored, { customBets: [{ id: "cb_x", label: "Campeón", scope: "temporada", points: 5, closesAtRound: 1 }] });
  assert.deepEqual(filled.customBets[0], open, "rellena sólo lo ausente");
  const r = resolve(stored, { rounds: [R1], customBets: [{ ...open, epoch: 7, closeSource: "none", closeFlag: "ambiguous" }] });
  assert.deepEqual(r.customBets[0], open);
  assert.deepEqual(SERVER_BET_FIELDS, ["closesAt", "closesRoundId", "closeSource", "closeFlag", "epoch"]);
});

test("ids retirados: quitada, archivada o con respuestas guardadas no vuelve con el mismo id", () => {
  const stored = { rounds: [R1], customBets: [own()] };
  const removed = resolve(stored, { rounds: [R1], customBets: [] });
  assert.deepEqual(removed.retiredBetIds, ["cb_x"]);
  assert.equal(resolve({ ...stored, customBets: [], retiredBetIds: ["cb_x"] }, { rounds: [R1], customBets: [own()] }).error, "bet_retired");
  assert.equal(resolve({ rounds: [R1], participants: [{ id: "p", customBetAnswers: { cb_x: { guess: "x" } } }] }, { rounds: [R1], customBets: [own()] }).error, "bet_retired");
  assert.deepEqual([...retiredBetIds({ retiredBetIds: ["a"], pastTournaments: [{ customBets: [{ id: "b" }] }], participants: [{ customBetAnswers: { c: {} } }] })].sort(), ["a", "b", "c"]);
});

test("cerrar el torneo: las abiertas se cierran a esa hora; todas se archivan con respuestas y aciertos; el torneo nuevo empieza sin ellas", () => {
  const meta = {
    rounds: [R1past, R2],
    customBets: [own({ id: "cb_o", closesAtRound: 2, closesAt: at(72), closesRoundId: "r_2" }), own({ id: "cb_c", closesAt: at(-1) }),
      { id: "cb_n", scope: "temporada", closeSource: "none", label: "n", points: 1 }, { id: "cb_l", scope: "temporada", closesAtRound: 1, label: "l", points: 1 },
      { id: "cb_j", scope: "jornada", label: "j", points: 2 }],
    participants: [{ id: "p1", customBetAnswers: { cb_o: { guess: "A", correct: true }, cb_c: { guess: "B", correct: null }, cb_otra: { guess: "z" } } }, { id: "p2" }],
  };
  const a = archiveBetsForClose(meta, at(0), NOW);
  const by = Object.fromEntries(a.customBets.map((b) => [b.id, b]));
  assert.deepEqual([by.cb_o.closesAt, by.cb_o.closeSource], [at(0), "tournament_end"], "archivar no sustituye cerrar");
  assert.deepEqual([by.cb_c.closesAt, by.cb_c.closeSource], [at(-1), "round"]);
  assert.deepEqual([by.cb_n.closesAt, by.cb_n.closeSource], [at(0), "tournament_end"], "«Sin cierre» se cierra al terminar");
  assert.deepEqual([by.cb_l.closeSource, by.cb_l.closeFlag], ["tournament_end", "closed_by_round"], "antigua ya cerrada por su jornada: se dice");
  assert.equal(by.cb_j.closesAt, undefined, "las de jornada se archivan tal cual");
  assert.deepEqual(a.betAnswers, { p1: { cb_o: { guess: "A", correct: true }, cb_c: { guess: "B", correct: null } } });
  assert.deepEqual(meta.participants[0].customBetAnswers, { cb_otra: { guess: "z" } }, "sólo salen las del torneo cerrado");
  assert.deepEqual([meta.customBets, meta.customBetsMigrated], [[], true]);
  // El goleador de antes, sin mudar, se archiva y ya no se muda al torneo nuevo.
  const old = { rounds: [], customBets: [], golScorerBet: { enabled: true, bonusPoints: 3 }, participants: [{ id: "p1", golScorerGuess: "X", golScorerCorrect: true }] };
  assert.deepEqual(archiveBetsForClose(old, at(0), NOW).legacyScorer, { definition: { enabled: true, bonusPoints: 3 }, answers: { p1: { guess: "X", correct: true } }, closedAt: at(0) });
  assert.equal(old.customBetsMigrated, true);
});

test("el «goleador» antiguo que se muda tarde a una quiniela ya migrada recibe la regla de la migración", () => {
  const legacy = { id: "cb_g", label: "Goleador de la liga", scope: "temporada", points: 3, closesAtRound: 9 };
  const prev = { rounds: [R1], customBets: [], golScorerBet: { enabled: true }, betCloseMigration: { version: 1 } };
  const r = resolveBetCloses({ stored: prev, merged: { rounds: [R1], customBets: [legacy], customBetsMigrated: true }, nowMs: NOW, legacyId: "cb_g" });
  assert.deepEqual([r.customBets[0].closeSource, r.customBets[0].closeFlag, r.customBets[0].closesAt], ["migration_cutoff", "lost_link", new Date(NOW).toISOString()]);
  const noMig = resolveBetCloses({ stored: { ...prev, betCloseMigration: undefined }, merged: { rounds: [R1], customBets: [legacy] }, nowMs: NOW, legacyId: "cb_g" });
  assert.equal(noMig.customBets[0].closesAt, undefined, "sin migración, como antes");
});

test("antigua sin migrar y abierta (Technical QA): su cierre no cambia en silencio al borrar, renumerar o mover su jornada; sí de forma explícita", () => {
  const legacy = { id: "cb_l", scope: "temporada", closesAtRound: 1, points: 2, label: "L" };
  const stored = { rounds: [R1, R2], customBets: [legacy] };
  for (const rounds of [[R2], [{ ...R1, number: 20 }, R2], [{ ...R1, deadline: at(48) }, R2], [round("r_otra", 1, 30), R2]]) {
    assert.deepEqual(resolve(stored, { rounds, customBets: [legacy] }), { ok: false, status: 409, error: "bet_close_legacy", betId: "cb_l" }, JSON.stringify(rounds.map((r) => [r.id, r.number])));
  }
  // Fijar el cierre que tiene hoy (aunque la jornada se borre en el mismo guardado): pasa a ser suyo.
  const frozen = resolve(stored, { rounds: [R2], customBets: [{ ...legacy, closesAt: at(24) }] }).customBets[0];
  assert.deepEqual([frozen.closesAt, frozen.closesRoundId, frozen.closeSource], [at(24), "r_1", "round"]);
  assert.equal(resolve(stored, { rounds: [R2], customBets: [{ ...legacy, closesAt: at(30) }] }).error, "bet_close_invalid", "sólo la hora que tiene hoy");
  // Ligarla por id a su jornada movida: toma la hora nueva.
  const moved = { ...R1, deadline: at(48) };
  const relinked = resolve(stored, { rounds: [moved, R2], customBets: [{ ...legacy, closesRoundId: "r_1" }] }).customBets[0];
  assert.deepEqual([relinked.closesAt, relinked.closesRoundId], [at(48), "r_1"]);
  // Sin cambios en su jornada, se guarda como siempre (otros cambios de la pregunta incluidos).
  assert.equal(resolve(stored, { rounds: [R1, round("r_3", 3, 90)], customBets: [{ ...legacy, label: "L2" }] }).ok, true);
  // La que ya perdió su jornada sigue como antes de D4 hasta la migración.
  assert.equal(resolve({ rounds: [R2], customBets: [{ ...legacy, closesAtRound: 9 }] }, { rounds: [R2, round("r_9", 9, 30)], customBets: [{ ...legacy, closesAtRound: 9 }] }).ok, true);
});
