# Inventario de QRACKS: código, documentación y huecos

**Fecha:** 2026-10-06.

**Leído de:** `main` en `4e5cbec`, el commit que producción tiene desplegado ese día; se comprobó en Render. Antes de fiarte de este documento, compara su SHA con el `main` actual: `git rev-parse origin/main`.

Es la entrega 1 del mini sprint de documentación (alex-orozco1/Quinielas#32). La columna «Documentación antes del sprint» es una foto de cómo estaba. Lo vigente es la columna «Dónde quedó documentado» y el índice, [README.md](README.md). Su objetivo es saber dónde vive cada cosa, qué está documentado y qué no. No describe el código línea a línea: para eso están los documentos enlazados.

**Columna «Estado»:**
- **main**: fusionado y en producción.
- **PR abierto**: existe en una rama, todavía no en `main`.
- **No verificado**: no se pudo comprobar desde el repositorio.

## 1. Mapa por área

| Área | Código (fuente de verdad) | Endpoints principales | Documentación antes del sprint | Dónde quedó documentado | Estado |
|---|---|---|---|---|---|
| Creación, roles, PIN, sesiones, contraseña, recuperación | `server.js` (`resolveMetaAuthTier`, `issueSessionCookie`, `trustDevice`, `checkCredential`), `adminPinClaim.js`, `metaParticipants.js` | `POST /api/create-quiniela`, `/api/self-register`, `/api/verify-pin`, `/api/set-pin`, `/api/verify-owner`, `/api/recover-admin-pin`, `/api/verify-session`, `/api/clear-session` | README «Privacy & integrity»; `SECURITY_CREDENTIAL_LIMITS.md` | Niveles de autorización, cookies y duraciones, quién hace admin a quién → [flujos/acceso.md](flujos/acceso.md) | main |
| Límites de intentos | `credentialAttempts.js`, `clientIp.js`, `rateLimit()` en `server.js` | Todas las rutas que comprueban un secreto | [SECURITY_CREDENTIAL_LIMITS.md](SECURITY_CREDENTIAL_LIMITS.md) (es su fuente de verdad) | Corregir afirmaciones viejas (ver §3) | main |
| Contraseña al publicar la primera jornada (opción B) | `server.js` (`creatorId`, `/api/set-admin-password`), `public/index.html` | `POST /api/set-admin-password` | §5.3 de `SECURITY_CREDENTIAL_LIMITS.md` en la rama del PR | Se documentará al fusionar #30/#31 | **PR abierto** (#30, #31) |
| Calendario, importación, staging, cierre, publicación, resultados | `server.js` (`POST /api/kv` de la meta, `resolveRoundsWrite`, `validateRoundsIntegrity`), `competitionSync.js`, `roundsConcurrency.js`, `autoResults.js`, `scoreContract.js`, `sportsDataProvider.js`, `providers/` | `POST /api/quinielas/:slug/sync-competition`, `GET …/sports-results`, `POST …/tournament/close`, `POST …/tournament/new-cycle` | README «Matchday lifecycle», «Sports data» | `stagedFixtures`, `roundsRevision`, códigos de error al publicar → [flujos/jornadas.md](flujos/jornadas.md) | main |
| Pronósticos, adicionales, puntuación, tabla, historial | `server.js` (`filterPicksForRequest`, picks en `/api/kv`), `public/index.html` (`pointsFor`, `standingsList`) | `GET/POST /api/kv/quiniela:<slug>:picks:<pid>`, `POST /api/picks-batch`, `POST /api/submit-bet-answer` | README «Features» | La puntuación se calcula **en el navegador**; reglas de visibilidad → [flujos/pronosticos.md](flujos/pronosticos.md) | main |
| Planes, límites, cobertura del torneo | `planLimits.js`, `tournamentScope.js`, `competitionCoverage.js`, `platformState.js` | `GET /api/quinielas/:slug/plan`; límites aplicados en el `POST` de la meta, `self-register` y `sync-competition` | README «Plans» | Códigos 402, ciclos y consumo → [flujos/planes.md](flujos/planes.md) | main |
| Pagos con Stripe (Plus) | `payments/stripeAdapter.js`, `payments/paymentsDomain.js`, `server.js` (`confirmPaymentAndGrant`) | `POST /api/payments/stripe/webhook`, `POST /api/quinielas/:slug/checkout`, `GET /api/quinielas/:slug/checkout/:purchaseId` | README «Deployment» (checklist de Stripe); `OPERATIONS.md` (MON-003) | Ciclo de vida de la compra, idempotencia, atención del operador → [flujos/pagos.md](flujos/pagos.md) | main. Que esté **en vivo** lo afirma el Founder y se ve en el arranque de producción (`payments_readiness … mode live`). |
| Panel de plataforma | `server.js` (rutas `/api/platform*`, `/api/delete-quiniela`), `public/index.html` (`renderPlatformDashboard`) | `POST /api/verify-platform`, `POST /api/platform/quinielas/:slug/entitlement`, `…/settings`, `GET /api/platform/*` | Sin documentar | Lista de endpoints y para qué sirven → [ARQUITECTURA.md](ARQUITECTURA.md) | main |
| Analítica | `server.js` (`/api/track-event`, `/api/platform-analytics`), tabla `analytics_events` | `POST /api/track-event` | Sin documentar | Eventos y tabla → [ARQUITECTURA.md](ARQUITECTURA.md) | main |
| Persistencia | `server.js` (`ensureTable`, `classifyKey`) | — | `docs/ARCHITECTURE` (desactualizado) | Tablas, claves de `kv`, migraciones al arrancar → [ARQUITECTURA.md](ARQUITECTURA.md) | main. RLS en Supabase: **no verificado** (ver §4). |
| Frontend | `public/index.html` (un solo archivo) | — | Sin documentar | Rutas, vistas y cómo habla con el servidor → [ARQUITECTURA.md](ARQUITECTURA.md) | main |
| Desarrollo y pruebas | `test/`, `test/helpers/realServer.js`, `scripts/security/pre-commit-secret-check.sh` | — | README «Run locally», «Testing» | Comandos, omisiones, zonas horarias y trampas → [DESARROLLO.md](DESARROLLO.md) | main |
| Operación | Render (servicios reales), `render.yaml` | `GET /api/health` | [OPERATIONS.md](OPERATIONS.md) | Entornos, ramas que despliegan, arranque en frío → [OPERATIONS.md](OPERATIONS.md) | main. Detalles de Render comprobados con su API el 2026-10-06. |

## 2. Documentos existentes antes del sprint

| Documento | Qué cubría | Qué hace el sprint |
|---|---|---|
| `README.md` | Presentación, planes, Stripe, arranque y pruebas, en inglés | Se conserva como portada y enlaza al índice [docs/README.md](README.md). Se corrigen las afirmaciones falsas que están verificadas. |
| `QRACKS_README.md` | Copia más vieja del README | Duplicaba el README y estaba desactualizada. Queda como puntero a la documentación actual. |
| `docs/PRODUCT.md` | Visión de producto v1.0 (julio 2026) | Se conserva como documento histórico de producto, con nota de estado y la corrección de §14 (pagos). |
| `docs/ARCHITECTURE` | Arquitectura de julio, sin extensión | Se reescribe como [ARQUITECTURA.md](ARQUITECTURA.md) con lo que hay en `main`. |
| `docs/OPERATIONS.md` | Salud, logs, rollback y pagos | Se actualiza. |
| `docs/SECURITY_CREDENTIAL_LIMITS.md` | Límites de intentos y recuperación | Se corrigen las afirmaciones viejas. Sigue siendo la fuente de verdad de los límites. |
| `docs/security/sec-002-hardening.sql` | Políticas de la base | Se conserva; su estado se explica en [OPERATIONS.md](OPERATIONS.md). |

## 3. Afirmaciones que estaban desactualizadas y se corrigieron

Cada una se contrastó con el código de `4e5cbec`:

1. **`docs/PRODUCT.md` §14** ponía el cobro fuera de alcance. Hay pagos con Stripe en `payments/` y en `server.js` (checkout y webhook).
2. **`docs/ARCHITECTURE`** decía que:
   - la base era «normalizada» y guardaba sesiones. En realidad es una tabla `kv` con documentos JSONB, y las sesiones son cookies firmadas.
   - la puntuación se calculaba en el servidor. Se calcula en el navegador (`pointsFor` y `standingsList` en `public/index.html`).
3. **`docs/OPERATIONS.md`** decía que:
   - `/api/health` confirmaba la conexión a la base. No consulta la base.
   - el servicio «podía levantar» sin variables. Sin `DATABASE_URL` o `PLATFORM_PASSWORD` el proceso termina.
   - el servicio de producción se llamaba `quiniela-liga-mx`. En Render se llama `quinielas`, comprobado con su API. `render.yaml` también declara `quiniela-liga-mx`: no refleja el servicio real (ver [OPERATIONS.md](OPERATIONS.md)).
4. **`docs/SECURITY_CREDENTIAL_LIMITS.md`** decía que «las lecturas (`GET`) no responden 429».
   - Es cierto para las lecturas de la quiniela por `/api/kv`: la meta y los pronósticos se ven como vista pública.
   - Las lecturas que exigen admin o plataforma sí responden 429 si la credencial está en espera. Por ejemplo: el plan, el estado de una compra, las sugerencias de resultados, el libro y los intentos de pago, y los diagnósticos de plataforma.
5. **`PRODUCT.md` y `ARCHITECTURE`** decían que los pronósticos se ocultan hasta publicar resultados. Se ven desde el cierre de la jornada.
6. **El README** decía:
   - «browser/E2E validation». El repositorio no tiene E2E propio y el CI sólo corre la verificación de secretos.
   - que ningún nombre de campo del proveedor aparece en el producto. El navegador consulta directamente la API pública de TheSportsDB para sugerir nombres de equipos.

## 4. Señales que encontró el inventario

No se corrigen en este sprint: se verifican y se registran aparte.

| Señal | Estado | Nota |
|---|---|---|
| `sec-002-hardening.sql` crea políticas pero no ejecuta `ENABLE ROW LEVEL SECURITY` en `kv` ni en `analytics_events`. | **No verificado** | Sin RLS activo, las políticas no tienen efecto. Que RLS esté activo en la base de producción no se puede comprobar desde el repositorio. |
| `platform_payment_log` se puede reescribir con la contraseña de plataforma vía `POST /api/kv`, mientras `platform_payment_intents` sólo la escribe el servidor. | PLAUSIBLE (leído en código) | Sólo con la credencial de plataforma. |
| Si un operador concede Plus manual y lo revoca en el mismo ciclo, un pago con tarjeta posterior podría reactivar el grant anterior sin registrar el cobro en el libro de pagos. | PLAUSIBLE (leído en código) | Está en el camino de confirmación de pagos. Lo verifica Technical QA. |
| Recargar el setup manual antes de publicar pierde lo escrito. | **CONFIRMED**, P1, ya en producción | alex-orozco1/Quinielas#35 |

## 5. Prioridades del sprint

Siguen el orden de #32, priorizando seguridad, pagos y calendario:

1. **Índice y arquitectura**, para que un desarrollador nuevo se ubique: [README.md](README.md), [ARQUITECTURA.md](ARQUITECTURA.md).
2. **Reglas de acceso y de pagos**, donde un error cuesta dinero o seguridad: [flujos/acceso.md](flujos/acceso.md), [flujos/pagos.md](flujos/pagos.md).
3. **Calendario y resultados**, el flujo principal del admin: [flujos/jornadas.md](flujos/jornadas.md).
4. **Desarrollo, QA y operación:** [DESARROLLO.md](DESARROLLO.md), [OPERATIONS.md](OPERATIONS.md).
5. **Pronósticos y planes:** [flujos/pronosticos.md](flujos/pronosticos.md), [flujos/planes.md](flujos/planes.md).
6. **Evidencia y estado del trabajo en curso:** [EVIDENCIA.md](EVIDENCIA.md), [ESTADO.md](ESTADO.md).
