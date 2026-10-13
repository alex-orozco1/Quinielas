# Acceso: crear, roles, PIN, sesiones, contraseña y recuperación

Contrastado con `main` en `4e5cbec`. Lo que cambia en los PR abiertos #30 y #31 está en §7.

**Fuentes de verdad:**
- `server.js`:
  - `resolveMetaAuthTier`, `mergeProtectedMetaFields` y `checkCredential`;
  - las rutas `/api/create-quiniela`, `/api/self-register`, `/api/verify-pin`, `/api/set-pin`, `/api/verify-owner`, `/api/recover-admin-pin`, `/api/verify-session` y `/api/clear-session`.
- `adminPinClaim.js`, `metaParticipants.js` y `credentialAttempts.js`.

**Límites de intentos:** su fuente de verdad es [SECURITY_CREDENTIAL_LIMITS.md](../SECURITY_CREDENTIAL_LIMITS.md). Aquí sólo se enlazan.

## 1. Roles

| Rol | Cómo se demuestra | Qué puede hacer |
|---|---|---|
| **Participante** | Su nombre más su PIN de 4 números, o su cookie de sesión | Ver la quiniela, mandar sus pronósticos y ver lo que la regla de visibilidad deja ver ([pronosticos.md](pronosticos.md)) |
| **Admin** | Igual que un participante, pero con `isAdmin: true`. Su PIN o su sesión bastan. Puede haber varios admins. | Preparar, publicar y editar jornadas; publicar resultados; gestionar participantes y pagos de la cuota; resetear PINs |
| **Dueño** (contraseña de administrador) | La contraseña de administrador de esa quiniela, enviada **sin** ligarla a un participante | Además, los «Ajustes protegidos»: nombrar o quitar admins y cambiar la propia contraseña. En `main`, el nombre de la quiniela, la cuota y los puntos sólo se protegen en la pantalla (ver §6) |
| **Plataforma** | La contraseña del panel de plataforma | Todo lo anterior en cualquier quiniela, más el panel ([ARQUITECTURA.md](../ARQUITECTURA.md) §2.1) |

En el servidor, cada escritura de la meta se clasifica en tres niveles (`resolveMetaAuthTier`):
- `owner`: la contraseña de admin, sin `X-Qracks-Participant`;
- `platform`;
- `admin-pin`: el PIN o la sesión de un admin.

Con cualquier otra credencial la escritura se rechaza.

**Cabeceras:**
- `X-Qracks-Auth`: la contraseña de admin. Si va acompañada de `X-Qracks-Participant: <id>`, es el PIN de ese participante.
- `X-Qracks-Platform-Auth`: la contraseña de plataforma.

## 2. Crear una quiniela (`POST /api/create-quiniela`)

- **Pide:**
  - nombre de la quiniela;
  - nombre del creador;
  - contacto;
  - contraseña de administrador;
  - liga, opcional;
  - link (slug). Se normaliza; si ya existe, responde `409 slug_taken`.
- **En una transacción crea:**
  - la meta, con el creador como único participante, admin y **sin PIN**;
  - la contraseña con hash;
  - la entrada en `platform_index`, con el plan Free y el primer ciclo del torneo.
- **Deja dos cookies** en ese navegador:
  - la de **creación** (`qracks_setup_<slug>`, 7 días), que es la que autoriza a elegir el primer PIN;
  - la de **dispositivo confiable** para la contraseña.
- El navegador sigue a `/q/<slug>?setup=1`: elegir PIN, preparar la primera jornada e invitar.

## 3. PIN

- **Primer PIN de un admin** (`POST /api/set-pin` sin PIN previo): sólo se autoriza con la cookie de creación o con una credencial de admin o dueño (`adminPinClaim.decideFirstPin`). Así, quien tenga el link no puede ocupar el asiento del creador.
- **Primer PIN de un participante:** al unirse con el link (`POST /api/self-register`), con nombre y PIN. Si no cabe en el plan responde `402`, y si el nombre ya existe, `409`. Esta ruta no tiene límite por IP.
- **Cambiar el PIN:** `POST /api/set-pin` con el PIN actual. Guardar el mismo valor conserva el hash y su estado de intentos.
- **Participante sin PIN** (lo agregó un admin por su nombre o se lo resetearon): elige su PIN al entrar, sin otra prueba (`decideFirstPin` sólo exige credencial en el asiento de un admin). Quien llegue primero con el link a ese nombre lo ocupa. Es parte del modelo de confianza entre conocidos.
- **Resetear el PIN de otro:** un admin lo deja vacío desde Participantes (`pin: null` en la meta) y la persona elige uno nuevo al entrar.
- **Siempre:** los PINs se guardan con hash scrypt y nunca salen del servidor. `GET /api/kv` los quita (`stripQuinielaSecrets`).

## 4. Sesiones y dispositivos confiables

| Cookie | Para qué | Duración |
|---|---|---|
| `qracks_session_<slug>` | Recordar quién eres en esa quiniela. Firmada con HMAC; la emite el servidor al entrar con PIN o al registrarse. | 365 días |
| `qracks_trust_<slug>` | Marcar el dispositivo como confiable para una credencial. Está ligada a su versión: si cambia el PIN o la contraseña, deja de valer. Da al dispositivo su propio presupuesto de intentos. | 365 días |
| `qracks_setup_<slug>` | Autorizar el primer PIN del creador. | 7 días |

- Las tres son `HttpOnly`, `SameSite=Lax` y `Secure` (salvo en local).
- `POST /api/verify-session` dice quién es la sesión. La pantalla pregunta «¿Eres Ana?» antes de usarla.
- `POST /api/clear-session` la borra.

## 5. Contraseña de administrador y recuperación

- **Abrir Ajustes protegidos:** `POST /api/verify-owner` con la contraseña.
  - En `main`, si la quiniela **no tiene** contraseña (quinielas viejas), basta el PIN de un admin.
- **Cambiar la contraseña:** desde Ajustes, con nivel dueño o plataforma. Con PIN de admin sólo se puede si todavía no existe.
- **«¿Olvidaste tu PIN?» de un admin:** `POST /api/recover-admin-pin` con la contraseña de administrador en la cabecera. Permite elegir un PIN nuevo sin sesión ni otro admin.
- **Participante que olvidó su PIN:** un admin se lo resetea.
- **Contraseña de administrador olvidada:** la plataforma la cambia desde su panel. No hay otro procedimiento: no se promete recuperación por soporte.

## 6. Límites y reglas que protege el servidor

- **Límite de intentos fallidos** por credencial, dispositivo e IP, con espera progresiva y `429 too_many_attempts` con `retryAfterSeconds`. Detalle en [SECURITY_CREDENTIAL_LIMITS.md](../SECURITY_CREDENTIAL_LIMITS.md).
- **Ritmo por IP:** 40 peticiones cada 5 minutos por IP y por cubo (`rateLimit`). Cubre:
  - las rutas que comprueban un secreto: `verify-pin` y `set-pin`, que comparten cubo; `verify-owner`; `recover-admin-pin`; `verify-platform`;
  - algunas costosas: checkout, sincronización, sugerencias de resultados, cierre y nuevo ciclo del torneo, analítica y diagnóstico de IP.

  `create-quiniela`, `self-register`, `picks-batch`, `submit-bet-answer` y `/api/kv` no tienen este límite.
- **Hacer o quitar admin** exige nivel dueño o plataforma; si no, `403 owner_password_required`. En quinielas sin contraseña basta un admin.
- **El nombre de la quiniela, la cuota y los puntos** se cambian en Ajustes protegidos, pero **en `main` el servidor no lo exige**: un admin con PIN puede cambiarlos por API. Corrección registrada en alex-orozco1/Quinielas#33.

## 7. Pendiente de fusionar: opción B (PR #30 y #31)

Validado en el sandbox el 2026-10-06; no está en `main`. Afecta sólo a las quinielas **nuevas**, que guardan `creatorId`:
- `/crear` ya no pide contraseña ni contacto.
- La contraseña se configura al **publicar la primera jornada**, con `POST /api/set-admin-password`. Sólo la creadora puede, con su PIN.
- **Hasta que exista la contraseña:**
  - nada se publica: `409 admin_password_required`;
  - sólo la creadora nombra admins.
- **Siempre:**
  - nadie quita, degrada ni resetea a la creadora sin la contraseña;
  - el nombre, la cuota y los puntos sólo cambian con la contraseña o la plataforma.
- **Límite conocido:** si la creadora nunca eligió su PIN y vuelve desde otro navegador, no puede entrar por su cuenta (alex-orozco1/Quinielas#34).

El detalle y la evidencia están en el PR #31. Al fusionarlo, esta sección se mueve a las anteriores.
