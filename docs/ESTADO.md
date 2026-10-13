# Estado del trabajo en curso

**Foto tomada el 2026-10-07 (UTC)**, leyendo GitHub y Render en ese momento. No se basa en SHAs de conversaciones. Este documento envejece rápido: antes de usarlo, vuelve a comparar con `git ls-remote origin` y con los PR abiertos.

## Fusionado y en producción

- **`main` = `4e5cbec`.** Es el merge de alex-orozco1/Quinielas#29, «¿Olvidaste tu PIN?» del admin.
- **Producción** (`quinielas`) tenía desplegado ese mismo commit el 2026-10-06; lo comprobé con la API de Render.
- **Lo más reciente en `main`:**

| PR | Qué | Merge |
|---|---|---|
| #29 | «¿Olvidaste tu PIN?» del admin con la contraseña de administrador | `4e5cbec` |
| #28 | Límite de intentos fallidos de PIN y contraseñas | `747576c` |
| #27 | SYNC: una ronda numérica del proveedor nunca pierde partidos | `bbe00ee` |
| #26 | MON-003: pagos Stripe para Plus por torneo | `9199107` |

Historial completo: [EVIDENCIA.md](EVIDENCIA.md).

## Pendiente: PR abiertos, sin fusionar

| PR | Rama → base | Punta | Estado |
|---|---|---|---|
| alex-orozco1/Quinielas#30, onboarding «Crear con claridad» | `onboarding/ms1-crear-con-claridad` → `main` | `6d320cc` | Abierto. Product QA y Technical QA en PASS. |
| alex-orozco1/Quinielas#31, opción B: la contraseña al publicar la primera jornada | `onboarding/ms1b-contrasena-al-publicar` → la rama de #30 | `854e5e5` | Abierto. **Validado en el sandbox** el 2026-10-06: Product QA y Technical QA en PASS de su alcance. **Sin PASS global** mientras siga abierto el P1 previo de #35. |

- **Nada de lo que describen #30 y #31 está en producción.** La documentación de `docs/flujos/` describe `main` y marca aparte lo que trae la opción B ([flujos/acceso.md](flujos/acceso.md) §7).
- **Orden de merge:** #31 está montado sobre #30, así que se fusiona primero #30 y luego #31. Un merge requiere la autorización explícita del Founder.

## Sandbox

- **El sandbox** (`qracks-mon003-sandbox`) despliega desde `mon001a-plan-limits-enforcement`. La punta es `de8128b`: el árbol de `854e5e5` (#30 + #31) más la configuración del equipo de agentes.
- **Esa rama no sigue a `main`:** cada validación sube encima de ella un commit con el árbol a probar ([OPERATIONS.md](OPERATIONS.md) §0).

## Issues abiertos

| Issue | Qué | Tipo |
|---|---|---|
| alex-orozco1/Quinielas#32 | Este mini sprint de documentación | Documentación |
| alex-orozco1/Quinielas#33 | En las quinielas existentes, nombre, cuota y puntos sólo los protege la pantalla | Corrección pendiente |
| alex-orozco1/Quinielas#34 | H-1: la creadora sin PIN que vuelve desde otro navegador no puede entrar por su cuenta | Límite documentado de #31; cualquier mecanismo de recuperación requiere propuesta aparte |
| alex-orozco1/Quinielas#35 | Recargar el setup manual antes de publicar pierde lo escrito | **P1 previo, también en producción.** Decisión del Founder: corregirlo antes de fusionar #31 o aceptarlo como excepción |

## Decisiones y pendientes conocidos

- **Antes de nuevas funcionalidades:** termina este mini sprint de documentación (#32). Lo pidió el Founder.
- **Mini sprint 2 de onboarding:** la bienvenida y la guía de capacidades.
- **Configuración del equipo de agentes:** `CLAUDE.md`, `.claude/agents/` y `.claude/skills/` **existen sólo en la rama `mon001a-plan-limits-enforcement`**, no en `main`.
- **Ramas temporales o ya fusionadas por borrar a mano:**
  - `ci/sandbox-pr31`, con resultados de la validación de #31;
  - `security/credential-bruteforce-limits`, la rama de #28, ya fusionada.

  Desde el entorno de desarrollo, GitHub rechaza borrar ramas.
- **`docs/PRODUCT.md`** es la visión de producto v1.0 (julio 2026). Se conserva como histórico; lo vigente está en los documentos de `docs/flujos/`.
