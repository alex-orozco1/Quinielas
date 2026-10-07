# Desarrollo y QA

Cómo arrancar QRACKS en local, cómo probarlo y cómo dejar evidencia que otro pueda reproducir. Contrastado con `main` en `4e5cbec`.

## 1. Requisitos

- **Node ≥ 18**, según `package.json`. Las corridas de abajo usaron Node 22.
- **PostgreSQL** local. En el entorno de desarrollo es la versión 16, con `pg_ctlcluster`.
- **Dependencias:** `npm install` instala sólo `express` y `pg`.

## 2. Arrancar la app en local

**Nunca apuntes a producción ni al sandbox:** usa una base desechable. El bloque de abajo es un **ejemplo**: no se ejecutó tal cual en esta revisión. Las credenciales de la base van en `PGUSER`/`PGPASSWORD` (o `~/.pgpass`), **nunca dentro de la URL** ni en un archivo del repo.

```bash
pg_ctlcluster 16 main start
export PGUSER=postgres PGPASSWORD='<contraseña local>'
psql -h localhost -c 'CREATE DATABASE qracks_local_<tu-nombre>'
DATABASE_URL=postgres://localhost:5432/qracks_local_<tu-nombre> PLATFORM_PASSWORD='<una contraseña local>' PORT=4000 node server.js
```

- **`PLATFORM_PASSWORD`** es la contraseña con la que entrarás a `/panel-plataforma` en local.
- **`PORT`** es opcional: por defecto 3000. Usa uno libre si hay otros servidores corriendo.
- **`npm start`** hace lo mismo que `node server.js`.
- **Comprobar que arrancó:**
  - el log muestra `Quiniela server listening on port 4000` y `payments_readiness … "state":"disabled"`;
  - `curl localhost:4000/api/health` responde `{"ok":true,…}`;
  - en el navegador: `http://localhost:4000/` (landing), `/crear` (crear una quiniela) y `/panel-plataforma`.
- **Al terminar:** detén tu proceso y borra tu base con `psql -h localhost -c 'DROP DATABASE qracks_local_<tu-nombre>'`. El sufijo evita chocar con la base de otra persona.

- **Variables obligatorias:** sin `DATABASE_URL` o `PLATFORM_PASSWORD` el proceso termina y dice cuál falta.
- **Modo local:** si `DATABASE_URL` contiene `localhost`, el servidor desactiva SSL y las cookies `Secure`, para que funcionen sobre `http`.
- **Sin variables de Stripe** los pagos quedan `DISABLED`, y es lo esperado en local.
- **Sin `THESPORTSDB_API_KEY`** la importación de jornadas falla; las jornadas manuales funcionan.
- **Para terminar:** detén **sólo tu proceso** (por su PID o su puerto), no todos los `node server.js`.

## 3. Pruebas

No hay `npm test`. Se usa el runner nativo de Node. Estos dos comandos **sí se ejecutaron** en esta revisión, con la contraseña local real en `PGPASSWORD`; sus resultados están en la tabla de abajo.

```bash
# Sin PostgreSQL: las suites de integración se reportan como omitidas, con su motivo.
node --test test/*.test.js

# Con PostgreSQL local: cada suite de integración crea su base qracks_it_<hex>, arranca server.js y la borra.
PGUSER=postgres PGPASSWORD='<contraseña local>' \
QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres node --test test/*.test.js
```

- `QRACKS_TEST_DATABASE_URL` **sólo acepta `localhost`**: cualquier otro host se rechaza (`test/helpers/realServer.js`).
- **Sin PostgreSQL**, las suites de integración salen como `# skipped`. **Una omitida no es una aprobada.**
- **Si no cambió nada,** no hace falta repetir toda la suite: basta con los tests afectados.

**Resultados reales en `main` (`4e5cbec`), 2026-10-06, salida literal:**

| Corrida | `# tests` | `# pass` | `# fail` | `# cancelled` | `# skipped` | `# todo` | exit |
|---|---|---|---|---|---|---|---|
| `TZ=America/Mexico_City`, sin PostgreSQL | 1450 | 1432 | 0 | 0 | 18 | 0 | 0 |
| `TZ=UTC`, con PostgreSQL | 1450 | 1450 | 0 | 0 | 0 | 0 | 0 |
| `TZ=America/Mexico_City`, con PostgreSQL | 1450 | 1450 | 0 | 0 | 0 | 0 | 0 |

- **Omitidas:** las 18 de la corrida sin PostgreSQL son las dos suites de integración, `adminPinRecovery.integration` y `trustedDeviceVersion.integration`.
- **Duración** (`# duration_ms`): unos 3 s sin PostgreSQL y unos 22 s con PostgreSQL.

**Tipos de prueba:**
- **Integración** (`*.integration.test.js`): levantan el servidor real contra PostgreSQL.
- **Estructura:** la mayoría. Leen `server.js` o `public/index.html` **como texto**, extraen funciones y las evalúan, o comprueban que cierta regla siga escrita en el código.
- **Dominio puro:** pagos, planes, sincronización y proveedores, sin red.

**Ninguna prueba llama a Stripe, a TheSportsDB ni a Sportmonks.**

**CI:** el único workflow es `.github/workflows/secret-check.yml`, la verificación de secretos. **El CI no corre las pruebas**, así que hay que correrlas en local y citar su salida.

## 4. Zonas horarias

- **Ninguna prueba fija `TZ`.** Las suites que dependen de la hora local la construyen a propósito para no depender de la zona.
- **Para darlas por buenas,** se corren con `TZ=UTC` y con `TZ=America/Mexico_City`.
- **Fechas de cierre:** el navegador muestra y edita la fecha en hora local (`datetime-local`) y la guarda en UTC. El servidor compara instantes UTC; para los pronósticos usa `NOW()` de PostgreSQL.

## 5. Evidencia reproducible

- **Resultados de pruebas:** se citan con la **salida literal** (`# tests N`, `# pass N`, `# fail N`, `# skipped N`) y el **SHA** probado, nunca de memoria.
- **Hallazgos:** cada uno es **CONFIRMED** (reproducido) o **PLAUSIBLE** (leído en el código con `archivo:línea`). Lo que no se pudo comprobar se marca **UNKNOWN / NOT PROVEN**.
- **Severidad**, fijada por el **peor caso alcanzable**, no por el más probable:

| Nivel | Cuándo |
|---|---|
| **P0** | Pérdida o corrupción de datos, cobro incorrecto, fuga de secretos o de pronósticos ocultos, o caída del servicio |
| **P1** | Alguien obtiene un rol o acceso que no le corresponde, un flujo principal no se puede completar, o se pierde trabajo del usuario sin aviso |
| **P2** | El flujo se completa, pero con un error confuso, un estado incoherente, validación sólo en el cliente o una fricción que probablemente cause abandono |
| **P3** | Pulido o copy |

  **PASS** significa 0 P0, 0 P1 y 0 P2 conocidos. El resumen sale de `CLAUDE.md` del equipo, que hoy no está en `main` (§8).
- **Navegador:** las validaciones de los PR usaron scripts de Playwright con Chromium a 375 y 1280 px. Esos scripts **no están en el repositorio**; se adjuntan a la evidencia de cada entrega ([EVIDENCIA.md](EVIDENCIA.md)).
- **Contra el sandbox** se probó con un **workflow temporal de GitHub Actions**, porque el entorno de desarrollo no llega a `*.onrender.com`. El patrón:
  1. **Rama temporal** `ci/<nombre>` con el workflow y los scripts.
  2. **Los scripts sólo aceptan la URL del sandbox**, usan PIN y contraseña aleatorios que no se imprimen, y no tocan pagos.
  3. **Resultados:** el workflow corre con `shell: bash` (`pipefail`), para que un fallo no quede en verde, y sube los resultados a la misma rama.
  4. **Limpieza:** se borra la rama al terminar.
- **Capturas:** no se suben si muestran datos personales o credenciales.

## 6. Verificación de secretos

`scripts/security/pre-commit-secret-check.sh` corre como hook local y en CI, sobre los archivos añadidos o modificados. Bloquea:
- archivos `.sql` fuera de `docs/security/` o `migrations/`;
- dumps, `.env`, `.pem` y `.key`;
- URLs de PostgreSQL con usuario y contraseña;
- `ownerPassword` en texto plano;
- llaves privadas.

**Nunca se desactiva.** Si bloquea algo legítimo, se corrige el archivo, no el hook.

## 7. Trampas conocidas

- **Tests que leen el código como texto.** Algunos buscan una cadena exacta en todo `server.js`, comentarios incluidos. Cambiar un comentario o renombrar una función puede romperlos sin cambiar el comportamiento. Ajusta el test conservando lo que verifica.
- **`test/stripePayments.test.js` lee `README.md`** y exige que la línea de la Premier League use la bandera 🇬🇧. Si editas la lista de competencias, cuida esa línea.
- **`.gitignore` ignora `*.sql`.** Un `.sql` nuevo en `docs/security/` necesita `git add -f`.
- **Archivos temporales, probes y capturas** van en un directorio temporal, nunca en el repositorio.
- **Matar procesos:** nunca `pkill -f "node server.js"`. Detén sólo tus PIDs; puede haber otros servidores locales corriendo.

## 8. Equipo de agentes

La configuración del equipo de agentes vive en la rama `mon001a-plan-limits-enforcement` y **no está en `main`**:
- `CLAUDE.md`;
- `.claude/agents/`: `head-of-product`, `product-design`, `product-qa` y `technical-qa`;
- `.claude/skills/objetivo/`.

Ver [ESTADO.md](ESTADO.md).
