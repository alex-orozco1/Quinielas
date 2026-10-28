# Pronósticos, adicionales, puntuación, tabla e historial

Contrastado con `main` en `4e5cbec`.

**Fuentes de verdad:**
- `server.js`: `filterPicksForRequest`, la rama de pronósticos de `POST /api/kv`, `/api/picks-batch` y `/api/submit-bet-answer`.
- `public/index.html`: `pointsFor`, `customBetPointsFor`, `penaltyPointsFor`, `standingsList` y `computeDenseRanks`.

## 1. Pronósticos

- **Dónde se guardan:** `quiniela:<slug>:picks:<participantId>`, con forma `{ <roundId>: { <matchId>: "A" | "D" | "B", __extra: { <betId>: respuesta } } }`. `__extra` lleva las respuestas a adicionales de esa jornada.
- **Quién escribe:** sólo el propio participante, con su PIN o su sesión.
- **Hasta cuándo:** hasta el **cierre** de la jornada.
  - El servidor rechaza cualquier escritura que toque una jornada ya cerrada.
  - Compara la hora con `NOW()` de PostgreSQL dentro de la transacción ([jornadas.md](jornadas.md) §4).
- **`POST /api/picks-batch`:** devuelve los pronósticos de varios participantes con la misma regla de visibilidad, en una sola llamada.

## 2. Quién ve qué

| Jornada | El propio participante | Un admin o el dueño | Cualquier otro |
|---|---|---|---|
| **Abierta** (antes del cierre) | Todo lo suyo | Sólo **que** cada uno ya contestó, no **qué** contestó | Nada |
| **Cerrada** (pasó el cierre) | Todo | Todo | Todo |

Los pronósticos de todos se ven **desde el cierre**, no desde que se publican los resultados. La documentación anterior decía lo contrario.

## 3. Adicionales (apuestas personalizadas)

El admin las crea en Admin → Adicionales (`meta.customBets`). Cada una tiene puntos y un alcance:

| Alcance | Cómo se contesta | Cuándo se cierra |
|---|---|---|
| `jornada` | Junto con los pronósticos de esa jornada (`__extra`) | Con el cierre de la jornada |
| `temporada` | `POST /api/submit-bet-answer`, guardado en `participant.customBetAnswers` | Si el admin indicó una jornada (`closesAtRound`), al pasar el cierre de esa jornada. Después responde `403 bet_locked`. |

- El admin marca qué respuesta es correcta.
- Las respuestas abiertas de otros se ocultan igual que los pronósticos (`stripQuinielaSecrets`).

## 4. Puntuación

**Se calcula en el navegador.** El servidor no calcula puntos: guarda pronósticos y resultados, y deja ver lo que la regla de §2 permite.

Para cada participante:
- **Aciertos:** por cada partido de una jornada **con resultados publicados** (`resultsPublished`), si el pronóstico coincide con el resultado, suma `settings.pointsPerCorrectPick` (por defecto 1).
- **Adicionales:** más los puntos de las adicionales acertadas (`customBetPointsFor`).
- **Penalización:** menos la penalización por cuota no pagada, si el admin la activó (`meta.paymentPenalty`):
  - desde la jornada indicada, resta `pointsPerRound` por jornada a quien no pagó;
  - lo ya resuelto queda congelado en `participant.penalizedRounds`, para que reabrir, editar o borrar una jornada no lo cambie.

En `main`, el nombre, la cuota y los puntos por acierto sólo se protegen en la pantalla; ver [acceso.md](acceso.md) §6 y alex-orozco1/Quinielas#33.

## 5. Tabla e historial

- **Tabla:** participantes ordenados por puntos, con **ranking denso** (`computeDenseRanks`): los empatados comparten posición y el siguiente toma el número inmediato. También muestra la posición anterior y una gráfica de progreso.
- **Historial:** las jornadas jugadas y su detalle; los torneos cerrados quedan en `meta.pastTournaments`, con campeón y tabla final ([jornadas.md](jornadas.md) §6).
- **Vista de espectador** (`/q/<slug>?ver`): tabla e historial de sólo lectura, sin entrar.

## 6. Cómo se prueba

- **Visibilidad y cierre:** `test/roundVisibility`, `adminParticipacionVisibility` y `quinielaMetaGuards`.
- **Puntuación con penalización:** `paymentPenalty`.
- **Historial:** `historyDetailScroll` y `tournamentHistoryPreparedRounds`.
- Varias de estas suites extraen funciones de `public/index.html` como texto y las evalúan sin navegador ([DESARROLLO.md](../DESARROLLO.md)).
