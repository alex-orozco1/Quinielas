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
    con X-Forwarded-For: 1.2.3.4, True-Client-IP: 9.9.9.9, X-Real-IP: 8.8.8.8
                                                        → misma ip que arriba
```

No incluir `CF-Connecting-IP` en esa prueba: Cloudflare rechaza en el borde una petición que lo trae
escrito por el cliente (`403 "DNS points to prohibited IP"`), así que nunca llega a la app.

**Verificado en el sandbox real** (2026-10-03, 3 IPs reales de GitHub Actions, commit `3ee2187` = PR #28):
falsificar `X-Forwarded-For`, `True-Client-IP`, `X-Real-IP` y `Forwarded` en cada intento no cambió el
cubo (20 `ok:false` y luego 429, también para el PIN correcto de otra persona desde esa red); otras dos
IPs entraron normalmente con su PIN y con el del admin atacado; `CF-Connecting-IP` falso fue rechazado
por Cloudflare. No verificado: el dominio `qracks.net`, IPv6 real y el valor de `via` del diagnóstico.

**Redes compartidas** (wifi común, CGNAT): quien comparte red con otros puede, con 20 PINs equivocados,
dejar en 429 durante 15 min el login por PIN de todos los de esa red en esa quiniela (24 h con 100). No
afecta otras quinielas, sesiones abiertas ni dispositivos de confianza.

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
### 5.1 Evaluación: bloqueo de 24 h frente a espera progresiva

Simulación por credencial, dispositivos no confiables (script `lockout-sim.js` en la evidencia del PR). Las filas
del admin incluyen los límites por red (20/15 min y 100/24 h) que también le aplican desde un solo teléfono. El
modelo usa ventanas rodantes; las ventanas fijas reales permiten ráfagas en el borde de la ventana (hasta ~299
intentos en 4 h alrededor del corte de 24 h) sin cambiar el promedio diario.
"Progresiva" = 10 fallos libres, luego espera de 15 s × 2^n entre intentos, con tope de 15 min; el
contador se olvida tras 24 h sin fallos. Ambas conservan los límites por red y la exención de
dispositivos de confianza.

| | Bloqueo duro (implementado) | Espera progresiva (propuesta) |
|---|---|---|
| Atacante sostenido, IPs ilimitadas | 150 adivinanzas/día | **96/día** |
| 50 % de probabilidad de dar con un PIN de 4 dígitos | ~33 días | **~52 días** |
| Admin sin atacante, desde una red, 8 intentos fallidos y luego el correcto | 0 de espera | 0 |
| Admin sin atacante, desde una red, 20 fallidos | ~12 min (límite por red 20/15 min) | ~1 h 30 min acumulada (ninguna espera > 15 min) |
| Admin sin atacante, desde una red, 35 fallidos | ~12 min | ~5 h acumuladas |
| Admin sin atacante, desde una red, 160 fallidos | ~24 h (límite por red 100/24 h) | ~38 h acumuladas |
| Admin en dispositivo nuevo durante un ataque: `Retry-After` al llegar | mediana ~10 h, peor ~23 h | **mediana ~8 min, peor 15 min** |
| ¿Un atacante óptimo puede seguir negándole la entrada en dispositivo nuevo? | Sí | Sí |
| Salidas que no dependen del limitador | dispositivo de confianza, sesión abierta, reset del PIN / cambio de contraseña (versión nueva) | igual |

Lectura:

- **Seguridad:** la espera progresiva es más estricta en régimen (96 contra 150 adivinanzas por día):
  el tope de 15 min por intento limita más que el cupo diario.
- **Acceso del admin:** la progresiva nunca anuncia horas de bloqueo; con un atacante activo, el
  admin ve "intenta en X min" en lugar de "mañana". Pierde frente al bloqueo duro cuando alguien
  legítimo encadena más de 10 errores (con 20, ~1 h 30 min acumulada frente a ~12 min), caso en que la
  salida correcta es resetear, no seguir probando.
- **Lo que ninguna de las dos resuelve:** un atacante sostenido y óptimo puede tomar cada apertura
  antes que el admin en un dispositivo nuevo. La protección real del acceso del admin es la misma en
  ambos: sus dispositivos de confianza, la sesión abierta, y resetear la credencial.

**Recomendación: espera progresiva** (10 libres, 15 s × 2^n, tope 15 min, olvido a las 24 h), manteniendo
los límites por red y la exención de dispositivos de confianza, más dos cambios de UX:

1. Tras 5 fallos, la pantalla de PIN ofrece la salida en lugar de otro intento: "¿Olvidaste tu PIN?
   Pide a otro admin que lo resetee" / "usa la contraseña de administrador".
2. El mensaje de bloqueo muestra el tiempo real que dice `Retry-After` ("Intenta de nuevo en 8 min").

No implementado en este PR: pendiente de decisión del dueño del producto.

Pendiente detectado al evaluar el acceso del admin (independiente de esta decisión): un admin único
que olvidó su PIN y no tiene dispositivo de confianza no tiene un camino de autoservicio para
resetearlo con la contraseña de administrador; hoy depende de otro admin (reset en Participantes) o de
una intervención con la contraseña de plataforma (no verifiqué si el panel lo ofrece en la UI).

## 6. Fuera de alcance de esta entrega

Onboarding y Admin Setup (auditoría aparte). Cambios de infraestructura (varias instancias, store
compartido). Validación en vivo de la cadena de proxy en Render (requiere desplegar; ver §3).
