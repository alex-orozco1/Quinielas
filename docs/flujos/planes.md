# Planes, límites y cobertura del torneo

Contrastado con `main` en `4e5cbec`.

**Fuentes de verdad:**
- `planLimits.js`: modelo comercial, comprobaciones y oferta.
- `tournamentScope.js`: identidad y ciclo del torneo.
- `competitionCoverage.js`: qué cubre Plus por competencia.
- `platformState.js`: concesiones.
- La fila `commercial_config` de la base: los **números vigentes**.

## 1. Planes

Valores por defecto (`DEFAULT_COMMERCIAL_CONFIG`). **Los vigentes son los de `commercial_config`**, que la plataforma edita sin desplegar:

| Plan | Personas | Jornadas | Precio | Cómo se obtiene |
|---|---|---|---|---|
| **Free** (`FREE`) | 10 | 7 publicadas por ciclo de torneo | — | Al crear la quiniela y al empezar cada torneo nuevo |
| **Plus** (`PLUS`) | 50 | Todo el torneo (sin presupuesto de jornadas) | $199 MXN por torneo | Compra con tarjeta ([pagos.md](pagos.md)) o concesión de la plataforma |
| **Especial** (`MANUAL_GRANT`) | Los que elija el operador (1 a 100 000) | Igual | — | Concesión manual con motivo ([pagos.md](pagos.md) §6) |
| **Heredado** (`GRANDFATHERED`) | 100 000 | 100 000 | — | Quinielas anteriores a los planes; conservan su experiencia |

- **Plus es por ciclo.** Cubre el torneo en que se compró. Empezar un torneo nuevo vuelve a Free; el Plus anterior no se transfiere.
- `MANUAL_GRANT` y `GRANDFATHERED` pasan al ciclo siguiente.
- **Jornadas en Free:** sólo cuenta **publicar**. Preparar o importar no consume.

## 2. Dónde se aplican los límites

| Momento | Qué se comprueba | Respuesta si no cabe |
|---|---|---|
| Alguien se une con el link (`/api/self-register`) | Personas | `402 {error: <motivo>}` |
| Un admin agrega participantes o publica una jornada (`POST /api/kv` de la meta) | Personas y jornadas del ciclo | `402` con `limitType` (`participants` o `rounds`), plan y límite, y la oferta de Plus con el modo de checkout (`card`, `manual`, `blocked` o `unavailable`) |
| Importar jornadas (`sync-competition`) | Que la competencia sea la del plan, si el plan está ligado a una | `402` (`competition_mismatch` o `competition_identity_unavailable`) |
| Cambiar la liga o la temporada cuando ya había liga y el plan está ligado a una competencia o ya se consumieron jornadas (la plataforma queda exenta) | — | `403 league_change_blocked` |

- **Fallo cerrado:** si el estado del plan no se puede leer, la escritura se rechaza (`402 entitlement_unavailable`) en vez de dejarla pasar.
- **Consumo de jornadas:** se apunta por ciclo en `platform_index` (`consumedRoundIdsByScope`). Una jornada ya contada no vuelve a contar.

## 3. El torneo como unidad comercial

- **Identidad:** cada quiniela tiene un ciclo de torneo (`tournamentScope`), con un id interno y un estado (`ACTIVE`, `ENDED` o `UNKNOWN`).
- **Qué compra Plus:** «este torneo de esta quiniela». La compra guarda una foto de la oferta (`snapshot`) y el ciclo para el que se hizo.
- **Quién decide que un torneo terminó:** el organizador, al empezar el siguiente ([jornadas.md](jornadas.md) §6). Ningún proveedor distingue una edición de la siguiente, así que no se adivina por fechas.
- **Cobertura:** la frase de qué cubre Plus para cada competencia sale de `competitionCoverage.js`.

## 4. Ver el plan

- `GET /api/quinielas/:slug/plan`, sólo para un admin o el dueño, devuelve:
  - el plan y el uso;
  - la oferta;
  - la cobertura y el ciclo;
  - la compra confirmada, si la hay.
- La pantalla lo muestra en la franja del plan y en Ajustes.

## 5. Cambiar precios y límites

- **Desde el panel de plataforma.** El cambio se escribe en `commercial_config` con versión: si dos ediciones chocan, la segunda recibe `409 stale_version`.
- **Validación:** antes de guardar, el servidor valida los números (`isCommercialConfigValid`); si no, `400 invalid_commercial_config`. No acepta límites en cero o negativos, ni un Plus con menos personas que Free. El precio sí puede ser 0.
- **Compras ya hechas:** no cambian. Cada una conserva su foto de la oferta.

## 6. Cómo se prueba

- **Planes y límites:** `test/planLimits`, `planUxAndPaywall` y `competitionCoverage`.
- **Ciclos y consumo:** `tournamentLifecycle`.
- **Escrituras concurrentes de plataforma:** `platformConcurrency`.
