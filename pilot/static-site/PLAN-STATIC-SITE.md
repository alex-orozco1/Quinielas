# UX-INFRA-001 · Alternativa Render Static Site · Piloto aislado

**Estado:** preparado. **No se ha creado nada.** La creación espera tu autorización concreta.
**Restricciones:** ninguna cuenta nueva, ningún gasto, sin API key global.
**No se toca:** `qracks.net`, DNS, producción, pagos ni `public/index.html`. Se usan sólo direcciones `*.onrender.com` temporales, datos simulados y un webhook simulado (firma fija de prueba, sin Stripe).

Fuentes: **[Claude]** ejecutado o leído en el código · **[GPT]** revisado por GPT · **[Render API]** leído con el conector · **[Doc]** documentación, no es una prueba.

## 1. Qué puede hacer el conector de Render [Claude, leído en sus esquemas]

| Acción | ¿Con el conector? | Detalle |
|---|---|---|
| Crear el servicio mínimo | **Sí** (`create_web_service`) | Plan free, `autoDeploy: no` y comandos propios |
| Crear el sitio estático | **Sí** (`create_static_site`) | Rama, build, `publishPath` y `autoDeploy: no`. **No** admite reglas de reescritura ni cabeceras. |
| Reglas de reescritura del sitio | **No** | Hay dos caminos: el dashboard (acción manual M1) o un Blueprint, que está en *alpha* y crea además un objeto Blueprint que luego también hay que borrar a mano. Recomiendo el dashboard. |
| Suspender o borrar servicios | **No** | Para hacerlo yo haría falta una API key global, que se descarta. El borrado es manual (M4). |
| Ver servicios, deploys y logs | **Sí** | Para verificar la creación, el borrado y los arranques en frío |

## 2. Recursos (requieren autorización)

| # | Recurso | Configuración |
|---|---|---|
| R-A | Rama `ux-infra/piloto-static` | Copia de esta rama en el SHA aprobado. Nunca `main` ni `mon001a-plan-limits-enforcement`. |
| R-B | Servicio web `qracks-ss-pilot-api` | Ver la tabla siguiente |
| R-C | Sitio estático `qracks-ss-pilot-web` | Ver la tabla siguiente |

**R-B · Servicio web `qracks-ss-pilot-api`:**

| Campo | Valor |
|---|---|
| Plan y región | free, `virginia` |
| Rama | R-A |
| `autoDeploy` | `no` |
| Build | `echo sin-build` |
| Arranque | `node pilot/wake-service/server.mjs` |
| Variables y base de datos | Ninguna. Render pone `RENDER=true`, así que `clientIp.js` usa su fuente «render», igual que la app. |

**R-C · Sitio estático `qracks-ss-pilot-web`:**

| Campo | Valor |
|---|---|
| Rama | R-A |
| `autoDeploy` | `no` |
| Build | `echo sin-build` |
| `publishPath` | `pilot/static-site/dist` (archivos ya generados y versionados) |

- **Antes de crear cada uno:** `list_services` o `git ls-remote` deben confirmar que el nombre **no existe**. Si existe, o la consulta falla, me detengo sin tocar nada.
- **Después:** cada recurso creado se anota con `pilot/measure/recursos.mjs anotar <tipo> <id>`. El apagado sólo actúa sobre lo anotado.
- **Coste:** el sitio estático no consume horas de instancia [Doc]. El servicio, ≤ 2 h despierto, dentro de la cota estimada de ≥ 530 h libres (estimación, no medición).

## 3. Acciones manuales (identificadas antes de crear)

| # | Quién | Cuándo | Acción |
|---|---|---|---|
| M1 | **Tú** | Después de crear R-B y R-C, cuando te dé el host real de R-B | Dashboard → `qracks-ss-pilot-web` → **Redirects/Rewrites**, en este orden: (1) *Rewrite* `/api/*` → `https://<host real de R-B>/api/*`; (2) *Rewrite* `/*` → `/index.html` |
| M2 | **Tú** | Antes de medir | Edit cloud environment → Network access → Custom, con la lista por defecto, y **sólo** los dos hosts `*.onrender.com` reales. **No** `*.onrender.com`. |
| M3 | **Tú** | Durante la prueba 1 | Abrir `https://<R-C>/ip.html?directo=https://<R-B>` desde **dos redes distintas** (wifi y datos móviles) y decirme si dice «Coinciden» o «NO coinciden». No hace falta que me pases tus IP. |
| M4 | **Tú (obligatorio para apagar)** | Al terminar | Dashboard → R-C y R-B → Settings → **Delete**. Yo verifico con `list_services` que esos dos ids ya no existen, borro la rama R-A y tú retiras los dos hosts de la red. |

## 4. Pruebas: `pilot/measure/static-probe.mjs`
Cada prueba guarda su resultado en `pilot/measure/out/static/` como **PASA** o **FALLA**. **Si alguna falla, te informo del bloqueo antes de adaptar la app.**

**1. IP por visitante y cabeceras falsificadas (`ip`, más M3):**
- La IP que decidiría la app (`clientIp.js`) al llegar por el sitio estático debe ser **la misma** que al llegar directo, y no puede ser `unknown`.
- Con `CF-Connecting-IP`, `X-Forwarded-For`, `True-Client-IP`, `X-Real-IP` y `Forwarded` falsificados (203.0.113.x), la IP decidida no cambia.
- Se guardan las cabeceras crudas que llegan al servicio.

**2. Cookies (`cookies-http` y `cookies-navegador`):**
- Dos `Set-Cookie` pasan la reescritura con los atributos de la sesión de la app (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 1 año y sin `Domain`).
- En Chromium, la cookie de sesión no se ve desde JS, se envía, sigue tras recargar, queda en el host del sitio estático y se borra.

**3. Método, cuerpo y firma (`cuerpo`, `dormido-post`):**
- Se envían `POST`, `PUT`, `PATCH` y `DELETE`, cuerpos de 1 KB a 900 KB con «ñ» y el webhook simulado con `stripe-signature` de prueba.
- Tienen que llegar intactos: método, query, `Content-Type`, bytes, sha256 y firma.
- Cada petición tiene que llegar **exactamente una vez** (con el servicio dormido, **como mucho una**).

**4. Pantalla desde la primera visita y continuación (`dormido-http`, `dormido-navegador`):**
- La página estática responde sin esperar al servicio.
- Se registra qué devuelve la reescritura de `/api` con el servicio dormido.
- En Chromium, en frío:
  - la pantalla aparece al instante con el texto del destino y el aviso de pago;
  - la app continúa **sin recargar** (navegación de tipo `navigate`, un solo documento);
  - la URL es la misma, con su fragmento, y el servicio recibe la misma ruta y los mismos parámetros;
  - no hay peticiones después de abrir.

**Confirmación del frío** (tres señales):
- ≥ 16 min sin peticiones (registro local);
- `startedAt` nuevo;
- la línea `wake-pilot listening … startedAt=` en `list_logs` [Render API], justo después de la primera petición.

**Duración:** pruebas con el servicio despierto, unos 10 min; 3–4 ciclos en frío de unos 18 min cada uno. En total, **unas 1,5–2 h**.

## 5. Pruebas locales de las herramientas [Claude] (no son el piloto)
- `pilot/test/static.test.mjs` corre todas las pruebas contra un emulador local de reescrituras.
- Las pruebas también detectan fallos:
  - con un servicio que confía en `X-Forwarded-For` falsificado, `ip` → **FALLA**;
  - con un proxy que quita `Set-Cookie`, `cookies-http` → **FALLA**.
- **El emulador no reproduce el proxy de Render:** la IP, las cabeceras y lo que pasa con el servicio dormido son justo lo que mide el piloto.

## 6. Fuera de este piloto
- Vistas previas de WhatsApp: se decide después, si las cuatro pruebas pasan.
- Cambios en `public/index.html`, dominios, DNS, producción y pagos reales.
- H-TLS del dominio final.
