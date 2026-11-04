# UX-INFRA-001 · H-WAKE · Plan de medición (sin recursos creados)

**Estado:** preparado. **No se ha creado nada.** Crear el servicio y el Worker requiere tu autorización explícita.
**Alcance:** medir qué responde Render mientras despierta, con el servicio mínimo (sin base de datos) y el Worker en `workers.dev`.
**Fuera de alcance:** producción, `qracks.net`, DNS, pagos, datos reales, H-IP completo y H-TLS.

Fuentes: **[Claude]** ejecutado o leído en el código · **[GPT]** revisado por GPT · **[Render API]** leído con el conector, sólo lectura · **[Doc]** documentación, no es una prueba.

## 1. Recursos exactos que se crearían

| # | Recurso | Configuración | Quién lo crea |
|---|---|---|---|
| R-A | Rama `ux-infra/piloto-hwake` | Copia de `ux-infra/piloto-pantalla-carga` en el SHA aprobado. Nunca `main` ni `mon001a-plan-limits-enforcement`. | Claude (git push) |
| R-B | Servicio web de Render `qracks-hwake-pilot` | Ver la tabla siguiente. | Claude con el conector de Render, o tú en el dashboard |
| R-C | Worker de Cloudflare `qracks-hwake-pilot` en `*.workers.dev` | Ver la tabla siguiente. | **Tú**: no hay conector de Cloudflare y la red de la sesión bloquea `api.cloudflare.com` |

**Servicio web de Render (R-B):**

| Campo | Valor |
|---|---|
| Plan | `free` |
| Región | `virginia`, la misma que producción |
| Repo | `alex-orozco1/Quinielas` |
| Rama | `ux-infra/piloto-hwake` |
| `autoDeploy` | `no` |
| Comando de build | `echo sin-build` (no instala dependencias ni ejecuta la app) |
| Comando de arranque | `node pilot/wake-service/server.mjs` |
| Variables de entorno | Ninguna |
| Health check | Sin configurar |

**Worker de Cloudflare (R-C):**

| Campo | Valor |
|---|---|
| Código | `pilot/measure/dist/worker.mjs`, archivo único |
| Variable `ORIGIN` | `https://qracks-hwake-pilot.onrender.com` |
| Secreto `PILOT_TOKEN` | Valor aleatorio, por ejemplo `openssl rand -hex 16`. Tú lo eliges y no se guarda en el repo ni en el chat. |
| Rutas | **Ninguna en `qracks.net`** |

El servicio mínimo no tiene base de datos, secretos ni dependencias. Su `/api/health` usa el mismo contrato que la app. El Worker sólo pide a `ORIGIN`. Su endpoint `/__pilot/probe` exige el token, sólo acepta rutas que empiezan por `/` y responde 404 sin token.

## 2. Duración prevista y horas gratuitas
- **Ciclos de medición:**
  - una matriz con el origen despierto;
  - 7 casos en frío;
  - 2 repeticiones de los casos clave (`directo-nav` y `worker-sub-nav`).
  - En total, unos 10 ciclos.
- **Cada caso en frío:**
  - al menos 16 min sin peticiones, para que Render lo duerma tras 15 min [Doc];
  - 1–2 min de medición;
  - unos 15 min despierto hasta volver a dormirse.
- **Estimación:** unas **3 h de reloj** y **≤ 3 h despiertas** del servicio piloto. Es una estimación, no una medición.
- Las horas cuentan contra las **750 h/mes del workspace, compartidas con producción** [Doc].
- **No sé cuántas horas quedan.** La métrica `instance_count` llega vacía para servicios free [Render API].

## 3. Apagado al terminar
1. **Render:** desde el dashboard, suspender o borrar `qracks-hwake-pilot`. El conector no tiene herramienta para suspender ni borrar. Después compruebo con el conector [Render API] que el servicio figura suspendido o que ya no aparece.
2. **Cloudflare:** borrar el Worker `qracks-hwake-pilot` (Workers & Pages → el Worker → Settings → Delete).
3. **Rama:** `ux-infra/piloto-hwake` se borra o se conserva sin auto-deploy. Con `autoDeploy: no`, un push no despliega nada.
4. **Si algo se alarga:** el piloto se apaga al terminar la sesión de medición aunque falten casos. Los casos pendientes se reportan como no medidos.

## 4. Medición preparada [Claude]
`pilot/measure/probe.mjs` se ejecuta con Node 18 o superior, desde una máquina con salida a `*.onrender.com` y `*.workers.dev`:
```
HWAKE_DIRECT=https://qracks-hwake-pilot.onrender.com \
HWAKE_WORKER=https://qracks-hwake-pilot.<cuenta>.workers.dev \
HWAKE_TOKEN=<PILOT_TOKEN> node pilot/measure/probe.mjs despierto
node pilot/measure/probe.mjs dormido <caso>      # exige ≥ 16 min sin peticiones
node pilot/measure/probe.mjs resumen
```

**Qué registra cada petición:**
- estado y todas las cabeceras, incluidos `Set-Cookie`;
- tiempo hasta las cabeceras y tiempo total;
- bytes, sha256, inicio del cuerpo, `<title>` y `<h1>`.

**Comprobaciones de cada corrida:**
- **Arranque en frío:** se confirma si cambia `startedAt` del servicio (`/api/pilot-log`), porque cada proceso tiene uno nuevo.
- **URL conservada:** el servicio devuelve la ruta y los parámetros que recibió (`#seen`), incluidos `qz_pago`, `qz_sess` y una «ñ».
- **Paso único:** cada petición lleva un `probe=<id>`. `/api/pilot-log` cuenta cuántas veces llegó al origen; para API y `POST` debe ser 1.

**Matriz con el origen despierto:** directo y por el Worker, con 3 repeticiones.
- `GET /api/health`
- `GET /a/…?qz_pago&qz_sess&ñ`
- `POST /api/eco` (20 KB) y el webhook con firma de prueba; se compara el sha256
- `HEAD /crear`
- `/files/app.js`
- `/redir`
- `/api/eco-ip` (sólo se registra: **no cierra H-IP**)
- además, la subpetición del Worker (`/__pilot/probe`) en sus variantes de navegación y de API.

**Casos en frío** (uno por ciclo, porque la primera petición es la que despierta al origen):

| Caso | Qué responde |
|---|---|
| `directo-nav` | Qué recibe un navegador sin Worker |
| `worker-sub-nav` | Qué recibe **el Worker** en una subpetición de página: es la base de `isRenderWakePage` |
| `worker-sub-api` | Lo mismo, para una subpetición de API |
| `worker-nav` | ¿La persona ve la pantalla a los ~3 s? ¿Llegó al origen la petición mantenida con `waitUntil`? ¿La misma URL abre la app al despertar? |
| `worker-post` | ¿El `POST` llega exactamente una vez con los mismos bytes, o Render lo responde o lo pierde mientras despierta? |
| `worker-webhook` | Lo mismo, con `stripe-signature` |
| `worker-head` | `HEAD` de página en frío |

**Pruebas locales de las herramientas:** `# tests 41 · # pass 41 · # fail 0 · # skipped 0`, en `pilot/test/measure.test.mjs` y el resto de la suite. **No son H-WAKE.**
- Comprueban que el bundle funciona como Worker, que el token es obligatorio, que el token no se guarda, que la URL se conserva, que los `POST` llegan una vez y que el bundle publicado coincide con el código fuente.
- La prueba local encontró que el `fetch` de Node reemplaza `sec-fetch-mode` por `cors`. El Worker no habría visto navegaciones, así que el script usa `node:http`/`node:https`.

## 5. Cómo se definirá `isRenderWakePage` (sin adivinar)
1. Se guardan las respuestas de `worker-sub-nav` y `worker-sub-api`, en frío y despiertas, como datos de prueba. No contienen secretos.
2. Se busca qué distingue las respuestas en frío de las de la app: estado, cabeceras y marcas del cuerpo. Sólo vale lo que aparezca en **todas** las repeticiones en frío y en **ninguna** despierta.
3. La regla se escribe con pruebas que clasifican esas respuestas guardadas.
4. **Si Render retiene la subpetición hasta despertar** y no devuelve una página propia, `isRenderWakePage` se queda en `false` y se documenta así.

**Riesgo por observar** [Doc, no comprobado en esta sesión]: `waitUntil` tiene un límite de tiempo tras enviar la respuesta. Si Render tarda más, la subpetición puede cancelarse. El caso `worker-nav` mide si llega al origen.

## 6. Lo que este corte NO demuestra
- H-IP completo: ni el limitador real ni la IP desde dos redes conocidas.
- H-TLS y H-DNS: no se usa `qracks.net` ni un dominio de prueba.
- El tiempo de arranque de la **app completa con base de datos**: el servicio mínimo arranca más rápido.
