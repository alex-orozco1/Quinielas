# Límites de intentos fallidos de credenciales

Estado: implementado en la rama `security/credential-bruteforce-limits`. El bloqueo por credencial
(§5) es una **propuesta provisional pendiente de decisión del dueño del producto**; no es un riesgo
aceptado.

## 1. Qué se protege

Toda comparación de una credencial que manda quien hace la petición pasa por `checkCredential()`
(`server.js`), que cuenta los intentos fallidos con `credentialAttempts.js`:

| Credencial | Por dónde llega | Target |
|---|---|---|
| PIN de un participante (admin o no) | `X-Qracks-Auth` + `X-Qracks-Participant`; body de `verify-pin`, `set-pin` | `pin:<id>` |
| Contraseña de administrador (owner) | `X-Qracks-Auth` sin `X-Qracks-Participant`; body de `verify-owner` | `owner` |
| Contraseña de plataforma | `X-Qracks-Platform-Auth`; body de `verify-platform` | `platform` (scope `__platform__`) |

Rutas cubiertas: `GET/POST /api/kv/*` (meta, picks, filas de plataforma), `picks-batch`,
`submit-bet-answer`, `verify-pin`, `set-pin` (PIN actual y claim del primer PIN de admin),
`verify-owner`, `verify-platform`, `migrate-quiniela`, plan, checkout, torneo (nuevo ciclo,
cierre), sync, resultados deportivos y todas las rutas `/api/platform*`. Un test
(`credentialAttempts.test.js`) falla si aparece un `verifyPassword()` fuera del limitador.

Ligadura de identidad: un PIN por header sólo se compara contra el participante que nombra
`X-Qracks-Participant`; sin ese header, el valor sólo se compara contra la contraseña de
administrador. Así un acierto siempre es un acierto real (y se reembolsa) y un fallo siempre es una
adivinanza real.

## 2. Presupuestos

Sólo cuentan los **fallos**, y el mismo valor equivocado cuenta una sola vez por ventana (una pestaña
con un PIN viejo no bloquea a nadie).

| Alcance | Qué agrupa | 15 min | 24 h |
|---|---|---|---|
| `ip` | una red contra una quiniela | 20 | 100 |
| `net` | una red contra todas las quinielas | 60 | 300 |
| `target` | una credencial (una versión), desde cualquier red | 30 | 150 |
| `device` | un navegador que ya probó esa credencial (cookie `qracks_trust_<slug>`) | 10 | 50 |

- Un dispositivo de confianza usa sólo su presupuesto `device`; no le afectan `ip`, `net` ni `target`.
- Cada versión de una credencial (cada PIN o contraseña tal como está guardado) tiene su propio
  presupuesto `target`: resetear un PIN o cambiar una contraseña la recupera.
- La reserva del intento ocurre antes de scrypt; con N peticiones en paralelo sólo se comparan las
  que caben.
- Respuesta al agotarse: `429 {"error":"too_many_attempts"}` con `Retry-After`. Las lecturas (`GET`)
  no responden 429: tratan la credencial como no enviada (vista pública).

Ritmo máximo para un atacante contra **un** PIN de 4 dígitos: 150 valores por día y por versión →
recorrer los 10 000 valores toma más de 66 días (la mitad, en promedio, ~33 días), sin importar
cuántas IPs use.

## 3. De qué IP viene una petición (Render)

`clientIp.js` decide la red; nunca se usa el extremo izquierdo de `X-Forwarded-For`.

Lo que llega a la app en Render (fuentes: volcado de headers de una app Express en Render en
[arcjet-js#3899](https://github.com/arcjet/arcjet-js/issues/3899); análisis con verificación en vivo
en [Coursemind PR #1](https://github.com/shrivastav-akash/Coursemind/pull/1), 27-sep-2026):

```
X-Forwarded-For: <lo que escribió el cliente>, <cliente>, <borde de Cloudflare>, <interno de Render>
CF-Connecting-IP: <cliente>     (lo fija Cloudflare desde la conexión TCP)
```

- **Hallazgo en producción (anterior a esta rama):** con `trust proxy 1`, `req.ip` es la entrada de
  la derecha, una IP interna de Render compartida. El `rateLimit()` existente (`verify-pin`,
  `set-pin`, `verify-owner`, `verify-platform`, …) era en la práctica **un solo cubo global**: con
  ~40 peticiones cada 5 min alguien podía bloquear esos endpoints para todos. Reproducido en local
  con `main` detrás de una réplica de esa cadena (evidencia en el PR).
- Ahora, en Render (`RENDER=true`, variable que Render define en todos sus servicios): se usa
  `CF-Connecting-IP`; si faltara, la entrada tercera desde la derecha. Fuera de Render: el socket.
  Override explícito: `QRACKS_CLIENT_IP_SOURCE=render|socket|xff:N` (no hace falta configurarlo).
- IPv6 se agrupa por /64.
- Supuestos residuales: (a) Cloudflare sobrescribe `CF-Connecting-IP` y no se puede llegar al
  origen de Render sin pasar por Cloudflare; (b) Render mantiene esa forma de cadena. Ninguno se
  pudo comprobar en vivo desde el entorno de desarrollo (sin salida a `*.onrender.com`).

**Verificación después de desplegar** (sandbox primero), con la contraseña de plataforma:

```
GET /api/platform/client-ip-check                       → ip = tu IP pública, via = "cf-connecting-ip"
GET /api/platform/client-ip-check
    con X-Forwarded-For: 1.2.3.4, CF-Connecting-IP: 5.6.7.8, True-Client-IP: 9.9.9.9
                                                        → misma ip que arriba
```

La respuesta incluye también `expressReqIp` (lo que `req.ip` habría usado) y la cadena de
`X-Forwarded-For` vista desde la derecha, para confirmar la forma documentada.

## 4. Persistencia, reinicios e instancias (límites reales)

- **Reinicios:** los contadores se guardan en la tabla `credential_attempt_buckets` (lotes cada
  ~250 ms, una escritura a la vez; flush también en SIGTERM) y se cargan **antes** de aceptar
  peticiones. Sobreviven a reinicios, caídas y al apagado por inactividad del plan free de Render.
  Comprobado en local con SIGTERM y con `kill -9`. Pérdida máxima ante una caída abrupta: los cambios
  de los últimos ~250 ms.
- **Deploys con solape:** si durante un deploy conviven el proceso viejo y el nuevo, el nuevo sólo
  conoce lo escrito hasta su arranque, y lo que cada uno escriba después pisa la fila del otro (se
  guarda el valor absoluto, no un incremento). Durante ese solape el presupuesto efectivo puede ser
  hasta el doble. Si el plan free de Render hace ese solape: no verificado.
- **Credenciales en texto plano** (PINs heredados, `PLATFORM_PASSWORD` antes de fijar una contraseña
  desde el panel): su versión es un HMAC sobre un scrypt del valor, así que rotar `PLATFORM_PASSWORD`
  y reiniciar da un presupuesto nuevo.
- **Qué no sobrevive:** qué valores exactos se probaron (no se guardan); tras un reinicio un valor
  ya contado puede contarse otra vez → más estricto, nunca más laxo.
- **Qué guarda la tabla:** ids HMAC (con el secreto del servidor), regla, conteo, inicio de ventana y
  una versión HMAC de la credencial. Ninguna IP, quiniela, participante ni credencial. RLS activado
  (como `kv`): los roles de la API de Supabase no la ven.
- **Varias instancias:** cada proceso aplica su propia copia en memoria y sólo lee la tabla al
  arrancar. Con N instancias el presupuesto efectivo es hasta N× los números de §2. Hoy hay **una**
  instancia por servicio (`render.yaml`, plan free; confirmado en Render: `numInstances: 1` en
  `quinielas` y `qracks-mon003-sandbox`). Escalar horizontalmente requiere mover el conteo a la base
  de datos (UPDATE atómico por intento) o a un store compartido.
- **Base de datos caída:** el límite en memoria sigue aplicando; sólo se degrada la supervivencia a
  reinicios (se registra `credential_attempts_persist_failed` y se reintenta).

## 5. Bloqueo por credencial — PROPUESTA PROVISIONAL (pendiente de decisión)

Comportamiento implementado hoy, a confirmar o cambiar por el dueño del producto:

- **Qué se bloquea:** sólo el login con esa credencial desde dispositivos **no** de confianza.
  Sesiones abiertas y dispositivos donde ya se entró siguen funcionando. Las demás credenciales de la
  quiniela no se ven afectadas.
- **Duración:** hasta que termina la ventana: como máximo 15 min (30 fallos) o, si se alcanzan 150
  fallos en el día, hasta 24 h desde el primer fallo de esa ventana. `Retry-After` lo indica.
- **Quién puede provocarlo:** cualquiera con el link y unas pocas IPs (≈2 para la ventana de 15 min).
  No da acceso a nada. Un atacante sostenido puede repetirlo.
- **Recuperación:**
  - entrar desde un dispositivo de confianza o con la sesión abierta;
  - PIN de participante: un admin lo resetea y la persona pone uno nuevo (presupuesto nuevo);
  - contraseña de administrador: el owner la cambia desde un dispositivo de confianza;
  - contraseña de plataforma: cambiarla desde un dispositivo de confianza del panel; si sigue siendo
    la de `PLATFORM_PASSWORD` (no se fijó una desde el panel), rotar esa variable y reiniciar.
    Recomendación operativa: entrar al panel justo después del deploy desde el dispositivo habitual
    para que quede como dispositivo de confianza;
  - último recurso del operador (requiere autorización, toca datos de producción): vaciar las filas
    `scope = 'target'` de `credential_attempt_buckets` y reiniciar el servicio;
  - en todos los casos, esperar el fin de la ventana.
- **Alternativa: retraso progresivo** (no implementada). En vez de un corte duro, tras K fallos cada
  intento exige esperar un tiempo creciente (p. ej. 2^n s, tope 15 min) indicado en `Retry-After`.
  - A favor: un usuario legítimo nunca queda fuera más que el retraso vigente; no hay un estado
    "bloqueado 24 h".
  - En contra: un atacante sostenido obtiene un flujo continuo de intentos (≈96 por día con tope de
    15 min, frente a 150 hoy por versión); hay que guardar el estado por credencial igual que hoy.
  - Combinación posible: retraso progresivo para dispositivos nuevos + exención de dispositivos de
    confianza (como hoy).

## 6. Fuera de alcance de esta entrega

Onboarding y Admin Setup (auditoría aparte). Cambios de infraestructura (varias instancias, store
compartido). Validación en vivo de la cadena de proxy en Render (requiere desplegar; ver §3).
