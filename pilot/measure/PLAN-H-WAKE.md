# UX-INFRA-001 · H-WAKE · Plan de medición (sin recursos creados)

**Estado:** preparado. **No se ha creado nada**, y no se ha cambiado la red ni Cloudflare. Cada paso marcado «requiere autorización» espera tu aprobación explícita.
**Alcance:** medir qué responde Render mientras despierta, con el servicio mínimo (sin base de datos) y el Worker en `workers.dev`. Ejecuta **Claude**, desde esta sesión en la nube.
**Fuera de alcance:** producción, `qracks.net`, DNS, pagos, datos reales, H-IP completo y H-TLS.

Fuentes: **[Claude]** ejecutado o leído en el código · **[GPT]** revisado por GPT · **[Render API]** leído con el conector, sólo lectura · **[Doc]** documentación consultada, no es una prueba.

## 1. Quién hace cada cosa

| Paso | Quién | Qué | Requiere autorización |
|---|---|---|---|
| 1 | Tú | Cuenta de Cloudflare (crearla si no existe) y **token de API acotado como secreto de red** (§2.1) | La cuenta es tuya |
| 2 | Tú | Autorizar R-A, R-B y R-C (§3) y el apagado (§5) | **Sí** |
| 3 | Claude | `cloudflare.mjs comprobar`: token válido, cuenta y subdominio de `workers.dev` | — |
| 4 | Claude | Crear R-A (rama), R-B (Render, con el conector) y R-C (Worker, con la API), cada uno sólo si su nombre no existe ya. Cada recurso creado se anota en `pilot/measure/out/recursos.json`. Te doy los **dos hosts reales**: el que devuelve Render y el de `workers.dev`. | **Sí** |
| 5 | Tú | **Red:** añadir exactamente esos dos hosts (§2.2). Se aplica a esta sesión en ~1 min [Doc]. | Es tuyo |
| 6 | Claude | Medición (§4), unas 3,5 h. Entre ciclos me programo un aviso para continuar. | Incluida en el paso 2 |
| 7 | Claude + **tú (borrado manual en Render)** | Apagado (§5), sólo sobre los recursos registrados | Incluido en el paso 2 |

## 2. Accesos mínimos

### 2.1 Cloudflare: token de API como secreto de red
- **Por qué:**
  - No hay conector de Cloudflare instalado.
  - En el directorio existe «Cloudflare Developer Platform», pero **no he podido comprobar** que pueda subir código de un Worker. No lo uso como base.
  - La API oficial sí lo permite: subir el script (`PUT …/workers/scripts/{nombre}`), activar `workers.dev` (`POST …/scripts/{nombre}/subdomain`) y borrar (`DELETE …/scripts/{nombre}`) [Doc].
- **Token, en el dashboard → My Profile → API Tokens → Create Custom Token:**
  - Permiso: **Account · Workers Scripts · Edit**. Nada de zonas, DNS ni rutas.
  - Recursos: **sólo tu cuenta**.
  - TTL: fecha de fin a **48–72 h**.
- **Dónde va:** en este entorno, **Edit cloud environment → Network secrets → Add secret**.
  - Allowed websites: `api.cloudflare.com`.
  - Cabecera: `Authorization`, con prefijo `Bearer`.
  - El proxy de la sesión añade el token a las peticiones a ese host. **Yo nunca lo veo**, no pasa por el chat ni queda en archivos [Doc].
  - Ese host no necesita estar en Allowed domains [Doc].
- **Si `comprobar` no puede listar la cuenta:** me das el *Account ID* en el chat. No es secreto: aparece en la URL del dashboard.
- **Si la cuenta aún no tiene subdominio de `workers.dev`:** abres una vez Workers & Pages en el dashboard. `comprobar` lo detecta.

### 2.2 Red: sólo los dos hosts del piloto
- **Edit cloud environment → Network access → Custom**, marcando **«Also include default list of common package managers»** para conservar lo de ahora.
- **Allowed domains:** exactamente estos dos:
  - `<host real de Render>`: el que devuelva la creación de R-B. No se adivina.
  - `qracks-hwake-pilot.<tu-subdominio>.workers.dev`
- **No** uses `*.onrender.com`: incluiría el host de producción `quinielas-a0b3.onrender.com`.
- [Claude] Comprobado en esta sesión:
  - el túnel `CONNECT` de `probe.mjs` sale por el proxy con verificación TLS normal;
  - Chromium también sale por el proxy con verificación TLS normal;
  - un host no permitido recibe 403 del proxy.

## 3. Recursos (requieren autorización)

| # | Recurso | Configuración |
|---|---|---|
| R-A | Rama `ux-infra/piloto-hwake` | Copia de `ux-infra/piloto-pantalla-carga` en el SHA aprobado. Nunca `main` ni `mon001a-plan-limits-enforcement`. |
| R-B | Servicio web de Render `qracks-hwake-pilot` | Ver la tabla siguiente. |
| R-C | Worker `qracks-hwake-pilot` en `workers.dev` | Ver la tabla siguiente. |

**Regla común a los tres:** sólo se crea un recurso si se confirma que su nombre **no existe**. Si ya existe, o la consulta falla o es inconclusa, me detengo sin tocar nada y te lo reporto. Cada recurso creado se anota en `pilot/measure/out/recursos.json` con su id, la cuenta o el servicio y su estado; nunca se anota uno que ya existía.
- **R-A:** `git ls-remote` debe confirmar que la rama no existe; luego `recursos.mjs anotar git-branch …`.
- **R-B:** `list_services` [Render API] debe confirmar que no hay ningún servicio con ese nombre; luego `recursos.mjs anotar render-service <srv-…>` con la URL real.
- **R-C:** lo hace `cloudflare.mjs desplegar`, que se detiene sin PUT si la lista de Workers no es concluyente (HTTP 200, `success:true`, lista completa) o si el nombre ya existe. Registra el Worker **antes** de crearlo («creando») y lo pasa a «creado» o «incierto» según la respuesta.

**R-B · Servicio web de Render:**

| Campo | Valor |
|---|---|
| Plan y región | `free`, `virginia` |
| Rama | R-A |
| `autoDeploy` | `no` |
| Build | `echo sin-build` |
| Arranque | `node pilot/wake-service/server.mjs` |
| Variables, base de datos y health check | Ninguno |

**R-C · Worker:**

| Campo | Valor |
|---|---|
| Código | `pilot/measure/dist/worker.mjs` (el sha256 lo imprime `node pilot/dev/bundle.mjs`) |
| `ORIGIN` | El host real de R-B; el script rechaza cualquier origen que no sea `*.onrender.com` |
| `PILOT_TOKEN` | Aleatorio, generado por `cloudflare.mjs`. Sólo vive en el Worker y en `pilot/measure/out/pilot-token` (0600, fuera de git) |
| Rutas | Ninguna en `qracks.net` |

## 4. Medición
### 4.1 Horas gratuitas: cota conservadora (estimación)
- **Supuestos** [Doc]:
  - las 750 h se reinician al **inicio de cada mes de calendario**;
  - un servicio dormido **no** consume horas;
  - si se agotan, Render **suspende todos los servicios free del workspace, incluida producción**.
- **Cota** [Claude, estimación]:
  - Tomo el reinicio más temprano posible: el 1 de noviembre en UTC+14, que es el 31 de octubre a las 10:00 UTC.
  - Hasta el 4 de noviembre a las 23:40 UTC van ≈ 110 h.
  - [Render API] el workspace tiene dos servicios web free.
  - Aunque los dos hubieran estado despiertos todo el tiempo, se habrían consumido ≤ 220 h, y quedarían **≥ 530 h**.
- **El piloto** usa ≤ 3,5 h despierto. **No es una medición:** el consumo real no se puede leer con el conector (`instance_count` llega vacío).

### 4.2 Ciclos (≈ 11, unas 3,5 h de reloj y ≤ 3,5 h despiertas)
1. **`probe.mjs despierto`:** matriz de base. Es **HTTP**: estado, cabeceras, tiempos, URL conservada y paso único de API y `POST` (conteo en el origen por `probe=<id>`).
2. **`probe.mjs dormido <caso>`**, un caso por ciclo, también **HTTP**:
   - `directo-nav`;
   - `worker-sub-nav` y `worker-sub-api`: lo que **el Worker** recibe de Render; es la base de `isRenderWakePage`;
   - `worker-nav`, `worker-post`, `worker-webhook` y `worker-head`;
   - repeticiones de `directo-nav` y `worker-sub-nav`.
3. **`browser-probe.mjs`**, en frío y en **navegador real** (Chromium por el proxy): es **la única prueba de la reapertura por JavaScript**.
   - Registra la pantalla, cada consulta a `/api/health` y los documentos pedidos.
   - Comprueba que la app aparece en la **misma URL** con su fragmento, que el origen recibe la misma ruta y parámetros, y que no hay peticiones tras abrir.
   - El tipo de navegación final (`reload`) confirma que la abrió la recarga por JavaScript.

`probe.mjs` **no** demuestra la reapertura automática. Sus casos `worker-nav` sólo prueban que se sirve la pantalla y que la misma URL abre la app cuando se vuelve a pedir.

### 4.3 Cómo se confirma cada despertar
Un caso en frío sólo cuenta como **confirmado** si coinciden tres señales:
1. **Inactividad** [Claude]: el registro local muestra ≥ 16 min sin peticiones del piloto antes del caso.
2. **Proceso nuevo** [Claude]: cambia el `startedAt` de `/api/pilot-log` respecto al ciclo anterior.
3. **Render** [Render API]:
   - `list_logs` muestra la línea `wake-pilot listening on … startedAt=<ese valor>` justo después de la primera petición del caso, y ninguna otra entre ciclos.
   - Además se revisa `list_events` del servicio. Si Render no emite eventos al dormir o despertar un servicio free, lo reporto como ausencia observada.

Si alguna señal no cuadra, el caso se reporta como **no confirmado** y no se usa para `isRenderWakePage`.

### 4.4 `isRenderWakePage`
- Sólo a partir de las respuestas confirmadas de `worker-sub-nav` y `worker-sub-api`, guardadas como datos de prueba sin secretos.
- Sólo vale un rasgo que esté en todas las respuestas en frío y en ninguna despierta.
- Si Render retiene la subpetición en vez de devolver una página propia, se queda en `false`.
- **Riesgo por observar** [Doc]: `waitUntil` dura como mucho 30 s tras la respuesta. Si Render tarda más en despertar, la petición mantenida puede cancelarse. `worker-nav` mide si llega al origen.

## 5. Apagado (requiere autorización junto con la creación)
**Sólo se actúa sobre lo registrado en `recursos.json`.** Un recurso con el mismo nombre que no esté registrado queda fuera.

| # | Quién | Acción | Verificación |
|---|---|---|---|
| A1 | Claude | `cloudflare.mjs borrar`: sólo los Workers registrados en esa cuenta. Antes y después del DELETE comprueba la lista; si la consulta es inconclusa, se detiene. Si el Worker ya no existe, no envía DELETE. | `cloudflare.mjs estado` dice «no existe» y el registro dice «borrado» |
| A2 | **Tú, a mano (obligatorio)** | Render → el servicio registrado (su `srv-…`, que te daré) → Settings → **Delete Web Service**. El conector no puede suspender ni borrar servicios. | Claude, con `list_services` [Render API]: ese `srv-…` ya no aparece. Hasta entonces el piloto **no** está apagado. |
| A3 | Claude | Borrar la rama registrada (`git push --delete`), después de A2 | `git ls-remote` |
| A4 | Tú | Retirar los **accesos**: borrar el secreto de red, revocar el token y volver la red a su nivel anterior | — |

- **A4 no apaga recursos.** Que el token venza o se revoque sólo me quita el acceso a la API de Cloudflare. El Worker seguiría existiendo, y el servicio de Render no depende del token. Por eso A1 se hace **antes** de A4.
- **Si A2 se retrasa:** un servicio dormido no consume horas [Doc]. Sólo gastaría si alguien pide su URL. Aun así, el piloto no se da por apagado hasta verificar A2.
- **Alternativa descartada:** que Claude borre R-B con la API de Render exigiría una API key **de cuenta completa**, con acceso a producción y a sus variables. No la recomiendo.
- Si la medición se alarga o falla, se apaga igual al terminar la sesión, y los casos pendientes se reportan como **no medidos**.

## 6. Lo que este corte NO demuestra
- H-IP completo: ni el limitador real ni la IP desde dos redes conocidas.
- H-TLS y H-DNS.
- El arranque de la app completa con base de datos.
- Navegadores distintos de Chromium.
