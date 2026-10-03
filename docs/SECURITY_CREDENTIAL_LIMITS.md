# Límites de intentos fallidos de credenciales

Estado: implementado en la rama `security/credential-bruteforce-limits`. Por credencial se aplica una
**espera progresiva** (§5), elegida por el dueño del producto el 2026-10-03 en lugar del bloqueo duro.

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

Sólo cuentan los **fallos**, y el mismo valor equivocado cuenta una sola vez (una pestaña con un PIN
viejo no bloquea a nadie).

Ventanas fijas (cupo por ventana):

| Alcance | Qué agrupa | 15 min | 24 h |
|---|---|---|---|
| `ip` | una red contra una quiniela | 20 | 100 |
| `net` | una red contra todas las quinielas | 60 | 300 |
| `device` | un navegador que ya probó esa credencial (cookie `qracks_trust_<slug>`) | 10 | 50 |

Espera progresiva por credencial (`target`, una credencial desde cualquier red; ver §5):

| Fallos registrados | Espera desde el último fallo |
|---|---|
| 0–9 | ninguna |
| 10 | 15 s |
| 11 | 30 s |
| 12 / 13 / 14 / 15 | 1 / 2 / 4 / 8 min |
| 16 o más | 15 min (tope) |

- Un dispositivo de confianza usa sólo su presupuesto `device`; no le afectan `ip`, `net` ni la espera
  de la credencial (y un acierto desde él la pone a cero).
- La reserva del intento ocurre antes de scrypt; con N peticiones en paralelo sólo se comparan las
  que caben.
- Respuesta cuando hay que esperar: `429 {"error":"too_many_attempts","retryAfterSeconds":N}` y
  `Retry-After: N`, con el tiempo que realmente falta. La pantalla dice "Intenta de nuevo en N s/min".
  Las lecturas (`GET`) no responden 429: tratan la credencial como no enviada (vista pública).

Ritmo máximo para un atacante contra **un** PIN de 4 dígitos, con IPs ilimitadas: ~96 valores por día
(uno cada 15 min, más los 10 libres tras cada olvido de 24 h) → la mitad del espacio en ~52 días.

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

## 5. Espera progresiva por credencial (implementada)

Elegida por el dueño del producto (2026-10-03) en lugar del bloqueo duro de 24 h, tras la evaluación de
§5.1.

- **Regla:** 10 fallos libres; después, cada intento tiene que esperar 15 s × 2^(fallos − 10) desde el
  último fallo, con tope de 15 min. Aplica a dispositivos **no** de confianza.
- **Los rechazos no prolongan:** una petición que llega mientras hay que esperar recibe el tiempo que
  falta y no cuenta como fallo ni mueve la espera.
- **Vuelve a cero:** con un acierto (desde cualquier dispositivo), con una versión nueva de la credencial
  (reset del PIN, cambio de contraseña) o tras 24 h sin fallos.
- **No cambia:** los límites por red (`ip`, `net`), los dispositivos de confianza y la ligadura de
  identidad. En ráfagas rápidas desde una sola red manda el límite por red (20/15 min).
- **Persistencia:** el estado (fallos, último fallo, versión) se guarda en `credential_attempt_buckets`
  con la regla `target-progressive` y se recarga al arrancar: un reinicio no acorta la espera. Las
  filas del bloqueo duro anterior (`target-15m`, `target-24h`) se ignoran: al desplegar, cada
  credencial empieza con contador nuevo una sola vez.
- **Quién puede provocar esperas:** cualquiera con el link. No da acceso a nada; un atacante sostenido
  puede mantener la credencial en la espera de 15 min y adelantarse al titular en un dispositivo nuevo.
  Como un acierto pone el contador a cero, cada login del titular le devuelve al atacante sus 10 intentos
  libres; con sesiones de 1 año esos logins son raros, y el ritmo sostenido sigue siendo ~96 por día.
- **Recuperación:**
  - entrar desde un dispositivo de confianza o con la sesión abierta (dura 1 año);
  - esperar lo que indica la pantalla (máximo 15 min por intento);
  - PIN de participante: un admin lo resetea y la persona pone uno nuevo (contador nuevo);
  - contraseña de administrador: el owner la cambia desde un dispositivo de confianza;
  - contraseña de plataforma: cambiarla desde un dispositivo de confianza del panel, o rotar
    `PLATFORM_PASSWORD` y reiniciar si no se fijó una desde el panel. Recomendación operativa: entrar
    al panel justo después del deploy desde el dispositivo habitual;
  - último recurso del operador (requiere autorización, toca datos de producción): vaciar las filas
    `scope = 'target'` de `credential_attempt_buckets` y reiniciar el servicio.
- **En la pantalla:** el mensaje dice el tiempo real ("Intenta de nuevo en 2 min, o entra desde un
  dispositivo donde ya hayas entrado"); tras 5 PINs incorrectos en el login sugiere "¿Olvidaste tu PIN?
  Pide a quien organiza (o a otro admin) que lo resetee".

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
| Admin en dispositivo nuevo durante un ataque: `Retry-After` al llegar | mediana ~10–12 h (varía por muestreo), peor ~23 h | **mediana ~7–8 min, peor 15 min** |
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
los límites por red y la exención de dispositivos de confianza. Product QA está de acuerdo con cambios;
estos son los cambios y lo que el dueño del producto tiene que decidir:

1. **Mensaje con el tiempo real.** Hoy el cliente no lee `Retry-After` y dice "Espera un rato…", que con la
   progresiva puede ser 15 s o 15 min. Debe decir "Intenta de nuevo en N min" (login, Ajustes,
   reautenticación y primer PIN de admin).
2. **"¿Olvidaste tu PIN?" tras 5 fallos**, ofreciendo sólo salidas que existen hoy: "Pide a otro admin
   que lo resetee". **No** "usa la contraseña de administrador": hoy esa contraseña sólo se pide dentro
   de Ajustes, con sesión abierta (ver pendiente abajo).
3. Reglas a fijar antes de implementar:
   - un intento hecho durante la espera se rechaza **sin** contar como fallo y **sin** alargar la espera
     (como hoy los bloqueados);
   - un acierto pone a cero el contador de **esa** credencial (no los de red);
   - el olvido a las 24 h es por credencial y lo reinicia cualquier fallo nuevo;
   - el estado (`n`, último fallo) se persiste como hoy; al migrar, todas las credenciales empiezan con
     contador nuevo una sola vez.
4. Contexto para decidir: la sesión dura 1 año, así que el bloqueo sólo afecta a quien entra desde un
   teléfono nuevo o borró cookies; en ráfagas rápidas desde una red manda el límite por red
   (20/15 min) en ambas opciones.

**Decisión:** implementada en este PR (2026-10-03) con las reglas del punto 3 y los cambios de pantalla de
los puntos 1 y 2.

**Siguiente tarea (registrada, fuera de este PR; P2 verificado por Product QA):** un admin único
que olvidó su PIN y no tiene sesión ni dispositivo de confianza **no tiene recuperación de autoservicio**:
el login sólo acepta 4 dígitos, la contraseña de administrador sólo se pide en Ajustes (con sesión) y el
Panel de plataforma no ofrece resetear PINs. Hoy sólo lo rescata otro admin (Participantes → Resetear) o
una intervención manual. Opciones: reset del propio PIN con la contraseña de administrador desde el login,
o un botón "resetear PIN" en el Panel de plataforma. Un admin secundario sí se recupera (verificado).

## 6. Fuera de alcance de esta entrega

Onboarding y Admin Setup (auditoría aparte). Cambios de infraestructura (varias instancias, store
compartido). Validación en vivo de la cadena de proxy en Render (requiere desplegar; ver §3).
