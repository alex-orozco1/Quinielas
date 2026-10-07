# Jornadas: calendario, importación, cierre, publicación y resultados

Contrastado con `main` en `4e5cbec`.

**Fuentes de verdad:**
- `server.js`: el `POST /api/kv` de la meta, `resolveRoundsWrite`, `validateRoundsIntegrity`, `sync-competition`, `sports-results` y `tournament/*`.
- `competitionSync.js`, `roundsConcurrency.js`, `autoResults.js`, `scoreContract.js`, `sportsDataProvider.js` y `providers/`.
- `tournamentScope.js`, para el consumo por ciclo.

## 1. Qué es una jornada

Vive dentro de la meta (`meta.rounds[]`):
- `id`, `number`, `deadline` (ISO, en UTC);
- `matches[]`, cada uno con `id`, `teamA` y `teamB`, más los datos del proveedor si fue importada;
- `published`;
- `results` (`matchId → "A" | "D" | "B"`): gana el local, empate o gana el visitante;
- `resultsPublished`.

En el navegador la fecha de cierre se escribe en hora local (`datetime-local`) y se guarda convertida a UTC. El servidor compara siempre instantes UTC.

## 2. Preparar una jornada

| Cómo | Qué pasa |
|---|---|
| **A mano** | En el setup de la primera jornada o en Admin → Jornadas: partidos y fecha de cierre. Lo escrito vive **sólo en la memoria de la pestaña** hasta publicar; recargar lo pierde (P1 previo, alex-orozco1/Quinielas#35). |
| **Importada** | `POST /api/quinielas/:slug/sync-competition` trae del proveedor las jornadas de la liga y temporada de la quiniela, como `published:false`. Ver los detalles abajo. |

**Detalles de la importación:**
- **Sin duplicados:** la identidad de cada partido es `proveedor + id`, así que repetir la importación no duplica nada.
- **Actualiza lo que es del proveedor:** en los partidos ya importados, mientras la jornada no esté cerrada ni puntuada:
  - corrige equipos (por ejemplo, un cruce que estaba «por definir»), ids externos y hora de inicio;
  - añade los partidos nuevos.

  Nunca toca el `id` de la jornada, los resultados, `published` ni el cierre.
- **Fallo seguro:** si el proveedor falla, no escribe nada.
- **`stagedFixtures`:** guarda aparte los partidos que el proveedor todavía no asigna a una jornada.
- **Plan ligado a una competencia:** la importación respeta esa liga y responde 402 si se intenta otra.
- **Cambiar la liga o la temporada** responde `403 league_change_blocked` cuando se cumplen las tres condiciones:
  - la quiniela ya tenía liga;
  - el plan ya está ligado a una competencia o ya se consumieron jornadas;
  - quien lo pide no es la plataforma.
- **Proveedor:** TheSportsDB por defecto. Sportmonks sólo si `meta.settings.provider = "sportmonks"`.

## 3. Publicar

Se publica cambiando `published` a `true` en la meta (`POST /api/kv`). Exige nivel admin (PIN o sesión), dueño o plataforma.

**En el PR abierto #31** (opción B, no fusionado), las quinielas nuevas no publican nada hasta que la creadora configura la contraseña de administrador: responde `409 admin_password_required`. Ver [acceso.md](acceso.md) §7.

- **Presupuesto de jornadas.** En Free, cada jornada publicada por primera vez **en el ciclo actual del torneo** consume una de las 7.
  - El consumo se apunta en `platform_index` (`consumedRoundIdsByScope`).
  - Al pasarse responde `402` con `limitType: "rounds"` y la oferta de Plus.
  - Plus no tiene presupuesto de jornadas: cubre el torneo. Ver [planes.md](planes.md).
- **Concurrencia.**
  - Cada escritura de jornadas lleva `roundsRevision`.
  - Una pestaña atrasada que quiere reemplazar las jornadas recibe `409 rounds_conflict` y no pisa lo nuevo (`roundsConcurrency.js`).
  - Una pestaña abierta antes de empezar un torneo nuevo tampoco puede reescribir las jornadas del torneo actual: si trae un `tournamentEpoch` viejo, el servidor conserva las jornadas guardadas.
  - Los participantes tienen su propia revisión (`participantsRevision`). Una pestaña que no vio a alguien recién agregado no lo borra al guardar.
- **Fecha de cierre.** Al publicar o reabrir, que la fecha esté en el futuro **sólo lo valida el navegador**. El servidor no lo comprueba. Lo que sí hace cumplir es el cierre de los pronósticos (§4).

## 4. Cierre

- **Hasta el cierre**, cada participante puede guardar y cambiar sus pronósticos de esa jornada.
- **A partir de `deadline`**, el servidor rechaza cualquier escritura de pronósticos que toque esa jornada. La hora se compara con `NOW()` de PostgreSQL dentro de la transacción, así que no depende del reloj del teléfono.
- **Visibilidad**: qué pronósticos ve cada quien antes y después del cierre está en [pronosticos.md](pronosticos.md).

## 5. Resultados

- **Sugerencias automáticas.** `GET /api/quinielas/:slug/rounds/:roundId/sports-results` y `GET /api/quinielas/:slug/sports-results`, este último para todas las jornadas elegibles.
  - Proponen el 1X2 a partir del **marcador reglamentario**: no cuentan prórroga ni penales (`scoreContract.js`).
  - Una jornada es elegible según `autoResults.js`.
  - El admin revisa las sugerencias; no se publican solas.
- **Publicar resultados** es `resultsPublished: true` en la meta. `validateRoundsIntegrity` rechaza:
  - `unpublished_round_results`: resultados de una jornada no publicada;
  - `round_not_closed`: resultados antes del cierre, la primera vez;
  - `incomplete_results`: algún partido sin `A`, `D` o `B`.
- **Puntos y tabla.** Con los resultados publicados, se recalculan **en el navegador** ([pronosticos.md](pronosticos.md)).

## 6. Torneo: cerrar y empezar otro

- **`POST /api/quinielas/:slug/tournament/close`.** Cierra el torneo de forma atómica: archiva el campeón, la tabla final y las jornadas publicadas en `pastTournaments`.
  - **Es destructivo para lo no publicado:** deja `meta.rounds` vacío, **descarta las jornadas preparadas sin publicar** (`published:false`) y vacía `stagedFixtures`.
  - Es idempotente por `closeIntentId`: el navegador lo guarda en `localStorage` para reintentar sin duplicar. Repetir la misma intención responde `200 replayed`.
  - La tabla final llega del navegador: es un dato de presentación, acotado y saneado, que no decide nada comercial.
- **`POST /api/quinielas/:slug/tournament/new-cycle`.** Empieza un ciclo nuevo **en Free**, con su propio presupuesto.
  - **Conserva:** participantes, PINs, roles, historial y el registro de compras.
  - **Nunca:** cobra, transfiere el Plus anterior ni borra jornadas.
  - Exige `expectedCycle`: si otra pestaña ya cambió de ciclo, responde 409.
  - `MANUAL_GRANT` y el plan heredado (`GRANDFATHERED`) pasan al ciclo nuevo.

## 7. Cómo se prueba

- **Ciclo de vida, edición y visibilidad de jornadas:** `test/adminSetupContinuity`, `adminLifecycleFixes`, `adminRondasDeadlineAndPricing`, `adminRoundEditPersistence`, `roundVisibility`, `resultsPublishGuard`, `roundConcurrency`, `tournamentLifecycle` y `tournamentHistoryPreparedRounds`.
- **Importación y datos del proveedor:** `competitionSync`, `fixtureSyncContract`, `liguillaImplementation`, `roundNumberSync`, `dataImmutability`, `sportsDataProvider`, `sportmonks*`, `theSportsDbAdapter`, `autoResults` y `bulkAutoResults`.
- **Ninguno llama a los proveedores reales:** usan datos fijos.
