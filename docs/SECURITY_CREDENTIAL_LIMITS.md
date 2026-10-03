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
  de la credencial, y entrar desde él tampoco la cambia.
- **La confianza es por versión de la credencial.** La cookie (`trusted_device_v3`, firmada) nombra cada
  credencial junto con su versión (`credentialVersion()` del hash guardado). El servidor la compara con
  la credencial tal como está guardada en ese momento. Al cambiar o resetear un PIN o una contraseña
  (de admin o de plataforma), la confianza ganada con el valor anterior deja de valer en el servidor, sin
  revocar nada. Las cookies obtenidas mientras se conocía el valor viejo vuelven a ser navegadores
  normales (10 libres y luego espera).
  - El dispositivo que completa el cambio recibe confianza para la versión nueva: set-pin, Ajustes al
    cambiar la contraseña de admin y el panel al cambiar la de plataforma.
  - Guardar el mismo valor conserva el hash, la versión, los contadores y la confianza.
  - Antes (P1 de la revisión independiente sobre `8753f8c`): tres cookies de antes del cambio daban 30
    adivinanzas contra el PIN nuevo desde una IP. `test/trustedDeviceVersion.integration.test.js` lo
    reproduce contra el servidor real.
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
- **Vuelve a cero sólo** con una versión nueva de la credencial (reset del PIN, cambio de contraseña **a
  un valor distinto**) o tras 24 h sin fallos. Guardar el mismo PIN o la misma contraseña conserva el hash
  y, con él, el estado. Esto aplica en set-pin, en la contraseña de administrador desde Ajustes, en la del
  panel y en la de una quiniela desde el panel. No se aplica al PIN de otra persona escrito por un admin
  vía meta: ahí "igual o distinto" se notaría en el `rev` y sería un intento gratis.
- **Ningún acierto lo pone a cero.** Da igual si viene de un login (PIN, Ajustes, Panel de plataforma,
  cambio de PIN), del PIN que el navegador reenvía en cada petición o de un dispositivo de confianza: un
  acierto sólo devuelve la reserva que hizo él mismo. Así el presupuesto del atacante depende sólo de sus
  propios fallos, y los logins frecuentes del titular no le dan nada.
  Historial: sobre `d1a05a9`, Technical QA reprodujo que cualquier acierto reiniciaba la espera.
  `c3c586d` lo limitó a los logins explícitos, y aun así cada login devolvía 10 intentos libres
  (~433/día con un login por hora). El dueño del producto pidió cerrarlo: desde este cambio ningún
  acierto reinicia.
- **Consecuencias de conservar el hash al guardar el mismo valor:**
  - Guardar el mismo PIN no cierra las sesiones de otros dispositivos, porque las sesiones van atadas al
    hash. "Cambiar mi PIN" con el mismo valor lo dice en pantalla y no llama al servidor. Un reset del
    admin o un PIN distinto sí las cierran.
  - Una credencial heredada en texto plano se migra a hash en su primera escritura. Eso cambia su
    versión una vez, y en ese momento el atacante recupera sus 10 intentos libres una sola vez. No se
    comprobó si quedan valores así en producción (NOT PROVEN).
- **Valores repetidos:** el mismo valor equivocado no se cuenta dos veces, pero espera como cualquier
  otro; preguntar durante la espera por un valor ya probado recibe el mismo 429 (sin oráculo de "¿esto
  ya se probó?").
- **No cambia:** los límites por red (`ip`, `net`), los dispositivos de confianza y la ligadura de
  identidad. En ráfagas rápidas desde una sola red manda el límite por red (20/15 min).
- **Persistencia:** el estado (fallos, último fallo, versión) se guarda en `credential_attempt_buckets`
  con la regla `target-progressive` y se recarga al arrancar: un reinicio no acorta la espera. Las
  filas del bloqueo duro anterior (`target-15m`, `target-24h`) se ignoran: al desplegar, cada
  credencial empieza con contador nuevo una sola vez.
- **Quién puede provocar esperas:** cualquiera con el link. No da acceso a nada; un atacante sostenido
  puede mantener la credencial en la espera de 15 min y adelantarse al titular en un dispositivo nuevo.
  El ritmo sostenido es ~96 por día por credencial, **con o sin actividad del titular**. Un test lo
  comprueba: 7 días de ataque contra el PIN y la contraseña de administrador, con un titular que
  recarga Ajustes cada 10 min y entra desde un dispositivo nuevo cada hora (más de 2000 logins), dan
  exactamente los mismos intentos que sin titular.
- **Costo para el titular:** tras entrar, sus fallos previos siguen contando hasta 24 h. Si en ese
  tiempo se equivoca desde **otro** dispositivo nuevo, la espera sigue escalando desde donde estaba.
  El dispositivo con el que entró queda de confianza y no espera.
- **Recuperación:**
  - entrar desde un dispositivo de confianza o con la sesión abierta (dura 1 año);
  - esperar lo que indica la pantalla (máximo 15 min por intento);
  - PIN de participante: un admin lo resetea y la persona pone uno nuevo (contador nuevo);
  - PIN de un admin: «¿Olvidaste tu PIN?» en el login, con la contraseña de administrador (§5.2);
  - contraseña de administrador: el owner la cambia desde un dispositivo de confianza;
  - contraseña de plataforma: cambiarla desde un dispositivo de confianza del panel, o rotar
    `PLATFORM_PASSWORD` y reiniciar si no se fijó una desde el panel. Recomendación operativa: entrar
    al panel justo después del deploy desde el dispositivo habitual;
  - último recurso del operador (requiere autorización, toca datos de producción): vaciar las filas
    `scope = 'target'` de `credential_attempt_buckets` y reiniciar el servicio.
- **En la pantalla:** el aviso de espera queda **fijo junto al formulario** (login por PIN, PIN actual al
  cambiarlo, Ajustes, Panel de plataforma) con una cuenta atrás en vivo. Por ejemplo: "Demasiados
  intentos. Intenta de nuevo en 1:45, o entra desde un dispositivo donde ya hayas entrado".
  - Mientras dura, el botón de enviar queda desactivado.
  - Al llegar a cero, el aviso cambia a "Ya puedes intentarlo de nuevo".
  - El toast de 2,2 s ya no es el único aviso.
  - El modal del PIN tiene el enlace «¿Olvidaste tu PIN?», también durante una espera (§5.2).
  - Tras 5 PINs incorrectos en el login lo recuerda: a un admin, "Toca «¿Olvidaste tu PIN?» y elige uno
    nuevo con la contraseña de administrador"; a un participante, "Pide a quien organiza (o a otro
    admin) que lo resetee".

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
   - ~~un acierto pone a cero el contador de **esa** credencial~~. Sustituida: ningún acierto lo pone a
     cero; ver §5, "Vuelve a cero sólo";
   - el olvido a las 24 h es por credencial y lo reinicia cualquier fallo nuevo;
   - el estado (`n`, último fallo) se persiste como hoy; al migrar, todas las credenciales empiezan con
     contador nuevo una sola vez.
4. Contexto para decidir: la sesión dura 1 año, así que el bloqueo sólo afecta a quien entra desde un
   teléfono nuevo o borró cookies; en ráfagas rápidas desde una red manda el límite por red
   (20/15 min) en ambas opciones.

**Decisión:** implementada en este PR (2026-10-03) con las reglas del punto 3 y los cambios de pantalla de
los puntos 1 y 2.

**Siguiente tarea (registrada en el PR #28; P2 verificado por Product QA):** un admin único que olvidó su
PIN y no tenía sesión ni dispositivo de confianza no tenía recuperación de autoservicio. **Resuelta** con
«¿Olvidaste tu PIN?» (§5.2).

### 5.2 «¿Olvidaste tu PIN?» (admin)

Un admin que olvidó su PIN, sin sesión, sin dispositivo de confianza y sin otro admin, elige uno nuevo
demostrando la contraseña de administrador de la quiniela.

- **En la pantalla:** el modal del PIN del login tiene el enlace «¿Olvidaste tu PIN?» (también durante
  una espera). Para un admin pide la contraseña de administrador, luego el PIN nuevo dos veces, y entra.
  Para un participante explica que un admin se lo resetea desde Participantes; no pide nada.
- **Servidor:** `POST /api/recover-admin-pin` con `{ metaKey, participantId, newPin }` y la contraseña en
  `X-Qracks-Auth` (nunca en el cuerpo; si va ligada a un participante con `X-Qracks-Participant` es un
  PIN y no cuenta). Bajo el bloqueo de la fila: el participante tiene que ser admin (`403 not_admin`
  antes de mirar la contraseña, así que probar contra un no admin no cuesta ni dice nada), la quiniela
  tiene que tener contraseña (`409 no_admin_password`) y la contraseña pasa por el limitador.
- **Limitador:** el mismo de la contraseña de administrador (objetivo `owner`), compartido con
  `verify-owner`, Ajustes y las escrituras con esa contraseña. 10 fallos libres y después la espera
  progresiva (`429 too_many_attempts` con `retryAfterSeconds`). La recuperación (un acierto) **no** lo
  pone a cero. Además, `rateLimit` de 40 peticiones / 5 min por IP.
- **Versión nueva siempre:** el PIN nuevo se guarda con sal nueva, aunque sea el mismo valor. Con eso:
  - terminan las sesiones de ese admin en otros dispositivos;
  - su confianza anterior deja de valer (las cookies viejas vuelven a ser navegadores normales);
  - la respuesta no dice si el PIN era el mismo;
  - el estado del limitador **del PIN** empieza de cero (regla de §5: versión nueva). El atacante no
    conoce el PIN nuevo, y provocarlo requiere la contraseña de administrador.
- **El dispositivo que recupera** recibe sesión y confianza para el PIN nuevo y para la contraseña.
- **Nunca se muestra el PIN viejo:** la respuesta sólo trae `ok` y `participantRevs`; no hay PIN ni hash
  en la respuesta, en las cookies ni en el log (`admin_pin_recovered { slug, hadPin }`).
- **Quién puede usarlo:** quien conoce la contraseña de administrador. Esa contraseña ya permite
  administrar la quiniela entera, incluido resetear PINs, así que no da acceso nuevo.
- **Sin contraseña de administrador** (quinielas heredadas) no hay recuperación por esta vía: la
  pantalla pide ayuda al equipo de QRACKS.
- Pruebas: `test/adminPinRecovery.test.js` (estructura) y `test/adminPinRecovery.integration.test.js`
  (servidor real con PostgreSQL local: sesiones y cookies viejas, mismo PIN, limitador compartido,
  concurrencia, reinicio).

## 6. Fuera de alcance de esta entrega

Onboarding y Admin Setup (auditoría aparte). Cambios de infraestructura (varias instancias, store
compartido). Validación en vivo de la cadena de proxy en Render (requiere desplegar; ver §3).
