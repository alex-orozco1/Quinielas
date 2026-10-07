# Documentación de QRACKS

Punto de entrada para entender el sistema, arrancarlo, probarlo, operarlo y ubicar las reglas importantes sin reconstruir el historial de nadie.

- **Contrastada con:** `main` en `4e5cbec`, el 2026-10-06/07.
- **Si `main` avanzó**, el código manda: compara el SHA con `git rev-parse origin/main` y revisa [ESTADO.md](ESTADO.md).

La portada del proyecto, en inglés, es el [README](../README.md) de la raíz. Esta documentación está en español.

QRACKS es para quinielas entre amigos. No es una plataforma de apuestas ni de alta seguridad financiera, y **no administra premios**: cobra por el software (Plus) y los participantes pagan su cuota directamente al organizador.

## Empieza aquí

| Si eres… | Lee primero |
|---|---|
| Desarrollador nuevo | [ARQUITECTURA.md](ARQUITECTURA.md) → [DESARROLLO.md](DESARROLLO.md) → el flujo que vayas a tocar |
| QA | [DESARROLLO.md](DESARROLLO.md) (pruebas, zonas horarias, evidencia) → el flujo a validar |
| Operación | [OPERATIONS.md](OPERATIONS.md) → [flujos/pagos.md](flujos/pagos.md) |
| Producto | [ESTADO.md](ESTADO.md) → los flujos → [PRODUCT.md](PRODUCT.md) (visión v1.0, histórica) |

## Documentos

| Documento | Qué contiene |
|---|---|
| [INVENTARIO.md](INVENTARIO.md) | Mapa por área: código, endpoints, documentación, huecos y estado. Afirmaciones viejas que se corrigieron. |
| [ARQUITECTURA.md](ARQUITECTURA.md) | Navegador, servidor, PostgreSQL, integraciones y módulos. Rutas, middleware, tablas y claves. |
| [flujos/acceso.md](flujos/acceso.md) | Crear, roles, PIN, sesiones y cookies, contraseña de administrador y recuperación. |
| [flujos/jornadas.md](flujos/jornadas.md) | Preparar (a mano o importada), publicar, cierre, resultados, y cerrar o empezar torneo. |
| [flujos/pronosticos.md](flujos/pronosticos.md) | Pronósticos, quién ve qué, adicionales, puntuación, tabla e historial. |
| [flujos/planes.md](flujos/planes.md) | Free, Plus, especiales y heredados; límites, ciclos y cobertura del torneo. |
| [flujos/pagos.md](flujos/pagos.md) | Stripe: checkout, webhook, confirmación, idempotencia y recuperación de fallos. |
| [SECURITY_CREDENTIAL_LIMITS.md](SECURITY_CREDENTIAL_LIMITS.md) | Límites de intentos fallidos, IP real detrás de Render, espera progresiva y «¿Olvidaste tu PIN?». |
| [DESARROLLO.md](DESARROLLO.md) | Arranque local, pruebas con y sin PostgreSQL, zonas horarias, evidencia, secretos y trampas. |
| [OPERATIONS.md](OPERATIONS.md) | Entornos y ramas que despliegan, salud, logs, rollback, variables, base de datos y pagos. |
| [EVIDENCIA.md](EVIDENCIA.md) | Dónde quedó la evidencia durable de cada entrega importante. |
| [ESTADO.md](ESTADO.md) | Qué está fusionado, qué está en PR, issues abiertos y pendientes. |
| [PRODUCT.md](PRODUCT.md) | Visión de producto v1.0 (julio 2026), histórica, con correcciones marcadas. |
| [security/sec-002-hardening.sql](security/sec-002-hardening.sql) | Políticas de acceso a la base que se aplican a mano. Ver [OPERATIONS.md](OPERATIONS.md) §6. |

## Fuente de verdad por tema

| Tema | Fuente de verdad |
|---|---|
| Límites de intentos | [SECURITY_CREDENTIAL_LIMITS.md](SECURITY_CREDENTIAL_LIMITS.md) y `credentialAttempts.js` |
| Precios y límites vigentes | La fila `commercial_config` de la base, editable desde el panel de plataforma. `planLimits.js` sólo trae los valores por defecto. |
| Eventos de Stripe y firma | `payments/stripeAdapter.js` |
| Qué servicio despliega qué rama | El dashboard de Render, resumido en [OPERATIONS.md](OPERATIONS.md) §0. `render.yaml` no está al día. |
| Reglas de acceso y publicación | `server.js` (`resolveMetaAuthTier`, `mergeProtectedMetaFields`, `validateRoundsIntegrity`) |
| Puntuación | `public/index.html` (`pointsFor`, `standingsList`): se calcula en el navegador |
| Severidad y evidencia (P0–P3, CONFIRMED/PLAUSIBLE) | `CLAUDE.md` del equipo, resumido en [DESARROLLO.md](DESARROLLO.md) §5 |

## Mantener esto al día

- Un cambio que mueva una regla actualiza el documento del flujo **en el mismo PR**.
- Si un documento y el código no coinciden, manda el código. Corrige el documento o abre un issue.
- No copies valores de secretos, contraseñas, PINs ni datos personales: **el repositorio es público**.
