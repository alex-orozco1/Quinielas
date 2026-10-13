# Evidencia de las entregas importantes

Índice de dónde quedó la evidencia **durable** de cada entrega importante: PR, commit de merge y corridas de GitHub Actions. Prioriza seguridad, pagos y calendario. Actualizado el 2026-10-06.

**Qué es durable y qué no:**
- **Durable:** la descripción de cada PR, sus commits, los tests del repositorio y las corridas de Actions.
- **No durable:** capturas, salidas completas de pruebas y scripts de navegador de cada validación. Se entregaron en la sesión de trabajo y viven en carpetas temporales del entorno de desarrollo. **No se pueden recuperar** cuando esa sesión termina.

**El repositorio es público.**
- No se copian aquí capturas con datos personales ni credenciales.
- Las pruebas contra entornos reales usan PINs y contraseñas aleatorios que no se imprimen.
- En una validación de #28 un workflow sí imprimió PINs de prueba. Los logs de esa corrida (37099416896) se borraron, y desde entonces los scripts ya no los imprimen.

## Seguridad

| Entrega | PR | Merge | Evidencia durable |
|---|---|---|---|
| Límite de intentos fallidos de PIN y contraseñas, con espera progresiva y persistencia | alex-orozco1/Quinielas#28 | `747576c` (2026-10-03) | Descripción del PR. Prueba contra el sandbox con varias IPs reales: [run 37151766636](https://github.com/alex-orozco1/Quinielas/actions/runs/37151766636), 7/7 en verde, sobre el árbol de `4f1563f`. Tests: `test/credentialAttempts.test.js`, `test/clientIp.test.js` y `test/trustedDeviceVersion.integration.test.js`. Documento: [SECURITY_CREDENTIAL_LIMITS.md](SECURITY_CREDENTIAL_LIMITS.md). |
| «¿Olvidaste tu PIN?» del admin con la contraseña de administrador | alex-orozco1/Quinielas#29 | `4e5cbec` (2026-10-05) | Descripción del PR. Prueba en el navegador contra el sandbox: [run 37252214283](https://github.com/alex-orozco1/Quinielas/actions/runs/37252214283), 32/32 en Chromium a 375 y 1280 px, sobre el árbol de `e02a62a`. Tests: `test/adminPinRecovery*.test.js`. Documento: [SECURITY_CREDENTIAL_LIMITS.md](SECURITY_CREDENTIAL_LIMITS.md) §5.2. |
| Verificación de secretos en cada PR | (anterior) | — | `.github/workflows/secret-check.yml` y `scripts/security/pre-commit-secret-check.sh`. |

## Pagos y planes

| Entrega | PR | Merge | Evidencia durable |
|---|---|---|---|
| MON-003: Plus por torneo con Stripe y confirmación en Admin | alex-orozco1/Quinielas#26 | `9199107` (2026-10-02) | Descripción del PR. Tests: `test/stripePayments.test.js`, `paymentsReadiness` y `paymentConfirmation`. Operación: [OPERATIONS.md](OPERATIONS.md) §7. Flujo: [flujos/pagos.md](flujos/pagos.md). |
| MON-002C: ciclo de vida del torneo y renovación | alex-orozco1/Quinielas#22 | `f28bcc4` | Descripción del PR. Test: `test/tournamentLifecycle.test.js`. |
| HOTFIX-001: concurrencia de jornadas e integridad de cobro | alex-orozco1/Quinielas#23 | `63e6314` | Descripción del PR. Test: `test/roundConcurrency.test.js`. |
| MON-002B: UX del plan y paywall | alex-orozco1/Quinielas#21 | `1f71030` | Descripción del PR. Test: `test/planUxAndPaywall.test.js`. |
| MON-001F: concurrencia del estado de plataforma | alex-orozco1/Quinielas#20 | `d97f0c3` | Descripción del PR. Test: `test/platformConcurrency.test.js`. |
| MON-001: límites de plan y arquitectura comercial | alex-orozco1/Quinielas#19 | `a8e67c7` | Descripción del PR. Test: `test/planLimits.test.js`. |

## Calendario y datos deportivos

| Entrega | PR | Merge | Evidencia durable |
|---|---|---|---|
| SYNC: una ronda numérica del proveedor nunca pierde partidos | alex-orozco1/Quinielas#27 | `bbe00ee` (2026-10-02) | Descripción del PR. Tests: `test/roundNumberSync.test.js` y `test/fixtureSyncContract.test.js`. |
| DATA-004: Liguilla de Liga MX completa; el 1X2 sólo del marcador reglamentario | alex-orozco1/Quinielas#24 | `c533a69` | Descripción del PR. Tests: `test/liguillaImplementation.test.js` y `test/sportmonksContract.test.js`. |
| AUTO-001, AUTO-001.1 y AUTO-002: sincronización de la competencia y resultados automáticos | alex-orozco1/Quinielas#4, #5, #6 | (agosto) | Descripciones de los PR. Tests: `test/competitionSync.test.js`, `autoResults` y `bulkAutoResults`. |

## En curso (no fusionado)

| Entrega | PR | Estado | Evidencia durable |
|---|---|---|---|
| Onboarding: crear con claridad | alex-orozco1/Quinielas#30 | Abierto | Descripción del PR. |
| Onboarding B: la contraseña de administrador se configura al publicar | alex-orozco1/Quinielas#31 | Abierto, validado en el sandbox | Descripción del PR. Engineering en el sandbox: [run 37538739784](https://github.com/alex-orozco1/Quinielas/actions/runs/37538739784). Product QA y Technical QA: [run 37540445451](https://github.com/alex-orozco1/Quinielas/actions/runs/37540445451). |

## Lo que no se puede recuperar

- Las capturas y salidas completas de las validaciones anteriores a esta fecha, que vivieron sólo en carpetas temporales. Lo que queda es lo resumido en cada PR.
- Los logs de la corrida 37099416896, borrados a propósito porque contenían PINs de prueba.
- Las corridas de Actions caducan según la retención de GitHub; después sólo queda la descripción del PR.
