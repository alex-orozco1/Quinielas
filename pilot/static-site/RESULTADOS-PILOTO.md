# UX-INFRA-001 · Alternativa Render Static Site · Resultados del piloto (2026-11-05)

**Recursos:**
- sitio estático `qracks-ss-pilot-web` (`srv-dbmccgutlv9c73dvanq0`);
- servicio web free `qracks-ss-pilot-api` (`srv-dbmccdutlv9c73dvag4g`);
- rama `ux-infra/piloto-static` en `11bed0e`.

Coste $0. Sin `qracks.net`, DNS, producción, Stripe ni datos reales. No se modificó `clientIp.js` ni la app.

Fuentes: **[Claude]** medido desde esta sesión contra Render · **[Render API]** logs del conector · **[GPT]** sin evidencia nueva en este informe.

## Veredicto
**La variante, tal como está, no puede ir a producción.** Bloquea la prueba 1: al llegar por el sitio estático, la app no ve la IP del visitante. Las pruebas 2, 3 y 4 pasan.

## 1. IP por visitante · **FALLA (bloqueo)** [Claude]
- **Directo al servicio:** `CF-Connecting-IP` y `True-Client-IP` = la IP de salida de la sesión. Es correcto.
- **Por el sitio estático:** `CF-Connecting-IP` y `True-Client-IP` = `74.220.48.207` o `.216`, direcciones del proxy de Render. Con `clientIp.js` actual (fuente «render»), **todas las visitas por el sitio estático compartirían la clave del limitador de PIN** (P1).
- **La IP del visitante sí viaja en `X-Forwarded-For`:** `<visitante>, <CF>, <CF>, <proxy Render>, <CF>, <interna>`. No se evaluó como solución: depende de un comportamiento no documentado de Render.
- **Cabeceras falsificadas:**
  - `CF-Connecting-IP` falsificado → **403** de Cloudflare (código 1000), en los dos caminos;
  - `X-Forwarded-For`, `True-Client-IP`, `X-Real-IP` y `Forwarded` falsificados → la IP decidida no cambia.
- **M3 (dos redes) no se hizo:** la prueba ya falla desde una sola red.

## 2. Cookies y Set-Cookie · **PASA** [Claude]
- **HTTP:** los dos `Set-Cookie` pasan la reescritura con `HttpOnly` (sólo la de sesión), `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age` de 1 año y sin `Domain`.
- **En Chromium:** la cookie `HttpOnly` es invisible para JS, se envía, sigue tras recargar, queda en el host del sitio estático y se borra.

## 3. Método, cuerpo y firma · **PASA** [Claude]
- **Con el servicio despierto:**
  - se probaron `POST`, `PUT`, `PATCH` y `DELETE` (1 KB a 900 KB) y el webhook simulado con `stripe-signature` de prueba;
  - método, ruta, `Content-Type`, bytes, sha256 y firma llegan intactos, y cada petición llega **exactamente una vez**.
- **Query:** por el sitio estático llega **reordenada** (6 de 6) y directo llega idéntica (6 de 6). Ningún parámetro se pierde ni cambia de valor o de multiplicidad.
- **La corrida de las 19:06 marcaba FALLA** porque comparaba el texto exacto de la query. Con la comparación por parámetros (19:31) pasa.
- **En frío (`dormido-post`, frío confirmado):** el proxy retuvo el webhook **12,5 s** hasta que el servicio despertó. Respondió el propio servicio con 200 y llegó **una sola vez**, intacto (20.534 bytes, sha256 y firma).

## 4. Pantalla desde la primera visita y continuación · **PASA** [Claude]
- **`dormido-navegador`, en Chromium y en frío:**
  - la pantalla aparece en **0,9 s**, con el título de administración y el aviso de pago;
  - la app continúa a los **16,3 s** sin recargar: un solo documento, navegación de tipo `navigate`;
  - la URL es la misma, con su fragmento, y el servicio recibe la misma ruta y los mismos parámetros;
  - después de abrir no hay más peticiones.
- **`dormido-http`, en frío:**
  - la página estática responde en **0,8 s** sin esperar al servicio;
  - la primera `GET /api/health` queda retenida **22,7 s** por el proxy y luego responde **200 JSON** del servicio. **No apareció ninguna página de arranque de Render.**
  - El servicio la recibió una sola vez.

## Confirmación de los casos en frío
Inactividad, más un `startedAt` nuevo, más los logs [Render API]:

| Caso | Inactividad | `startedAt` nuevo | Log de Render (instancia) |
|---|---|---|---|
| `dormido-navegador` | 17 min | 19:30:46.201 | `…-l742z`, 19:30:46 |
| `dormido-post` | 18 min | 19:48:56.005 | `…-96pbr`, 19:48:56 |
| `dormido-http` | 18 min | 20:07:27.628 | `…-zxs5q`, 20:07:27 |

En cada caso hubo **un solo arranque**, justo después de la primera petición, y ninguno entre ciclos.

## Límites
- Una sola muestra por caso en frío, un solo navegador (Chromium) y una sola red de origen (la de la sesión). No se probaron IPv6, Safari ni Firefox.
- El servicio mínimo arranca sin base de datos. La app real tarda más en despertar, así que la espera real será más larga que 12–23 s.
- Las IP del proxy de Render (`74.220.48.x`) se observaron en esta corrida; Render no las documenta como estables.
- **Sin evaluar:** las vistas previas de WhatsApp, el tiempo con la app completa y el cambio de dominio.
- Antes de las 19:13 hubo una medición manual por cabecera que no pasó por el registro de inactividad. La marca se ajustó de forma conservadora a 19:13:16 UTC, y el primer caso en frío corrió a las 19:30 (17 min).
