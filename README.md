# Quinielas — plataforma de quinielas deportivas

Sitio donde cualquier grupo de amigos puede armar su propia quiniela: se
eligen los partidos de cada jornada, cada quien vota antes de la hora límite,
y los puntos se calculan solos en cuanto se capturan los resultados. Empezó
como la quiniela de Liga MX de un solo grupo y se convirtió en una plataforma
donde cualquiera puede crear la suya, para la liga o competencia que quiera.

## Qué incluye esta carpeta

- **`public/index.html`** — todo el sitio (frontend): una sola página que
  cambia de vista según la URL.
- **`server.js`** — un servidor pequeño en Node/Express que guarda los datos
  en una base de datos Postgres real.
- **`package.json`, `render.yaml`, `.gitignore`** — configuración para
  desplegarlo en Render.

## Cómo está organizado el sitio

| Ruta | Qué es |
|---|---|
| `/` | La quiniela original del grupo (o la página de inicio pública, si ya se movió a su propio link) |
| `/crear` | Formulario para que cualquiera cree su propia quiniela, gratis |
| `/q/mi-quiniela` | Una quiniela específica, con su propio link fijo |
| `/panel-plataforma` | Panel privado del dueño de la plataforma |

---

## Funciones para los participantes de una quiniela

- Eligen su nombre de una lista **ordenada alfabéticamente**, o **se agregan
  ellos mismos** si no aparecen todavía.
- Cada nombre se protege con un **PIN de 4 dígitos**: la misma persona lo crea
  la primera vez que entra, lo puede **cambiar cuando quiera**, y el admin
  puede **resetearlo** si alguien lo olvida — así nadie más puede votar en su
  lugar ni ver quién falta por contestar.
- Votan quién gana cada partido (o empate) mientras la jornada sigue abierta,
  con guardado automático en cada tap y un reloj de cuenta regresiva.
- Tres vistas de cada jornada: **Por jugar** (para votar), **En vivo**
  (cerrada, esperando resultado — ahí ya se puede ver lo que votó todo el
  grupo, porque nadie tiene ventaja), y **Jugados** (picks marcados en verde o
  rojo según acertaron).
- **Tabla de posiciones** en vivo, con cuota y total recaudado arriba.
- **"Cómo llegaron aquí"** — gráfica de puntos acumulados por jornada,
  comparando a quien quieras.
- **Historial** de jornadas jugadas, y de **torneos anteriores ya cerrados**
  (con su campeón y tabla final guardados para siempre).

## Funciones para el administrador de una quiniela

Panel de Admin con estas secciones:

- **Rondas** — crear y editar jornadas (equipos con autocompletar, fecha y
  hora límite); también se pueden editar o borrar jornadas ya creadas.
- **Resultados** — capturar el resultado real de cada partido, con un botón
  para **buscar resultados automáticos** en TheSportsDB (API gratuita) que
  sugiere el marcador — el admin siempre confirma antes de que cuente.
  Funciona con **Liga MX, Premier League, La Liga, Bundesliga, Serie A,
  Ligue 1 o Champions League**, configurable por quiniela.
- **Participación** — ver quién ya contestó una jornada abierta y quién no
  (sin mostrar los votos de nadie), con un botón para **copiar el
  recordatorio** o **abrirlo directo en WhatsApp** con el mensaje listo.
- **Participantes** — agregar, quitar, renombrar, marcar quién pagó su
  cuota, resetear el PIN de alguien que lo olvidó.
- **Ajustes** — nombre de la quiniela, cuota, contraseña de administrador,
  liga/temporada para resultados automáticos, **cerrar el torneo** (guarda al
  campeón y la tabla final en el historial y deja todo listo para uno nuevo),
  y mover la quiniela de la página principal a su propio link fijo.

## Funciones para el dueño de la plataforma (`/panel-plataforma`)

- Lista de todas las quinielas creadas, con link directo, creador, datos de
  contacto, número de participantes, jornadas jugadas y estatus de cobro.
- **Exenta** — marca cualquier quiniela para que nunca se le cobre.
- **Pagado** — marca cuando ya se recibió el depósito de una quiniela que
  pasó el límite gratuito; se puede desmarcar para volver a cobrar en el
  siguiente torneo.
- **👁 Ver** — inspecciona cualquier quiniela (tabla de posiciones, estatus
  de sus jornadas) sin necesitar su contraseña y sin poder modificar nada.
- **Editar / Eliminar** cualquier quiniela de la plataforma.
- **Configuración de cobro**: cuántas jornadas gratis antes de pedir pago
  (global, con posibilidad de un límite distinto por cada quiniela), precio
  por participante, y los datos de depósito que se le muestran
  automáticamente al admin de una quiniela cuando le toca pagar.
- El cobro se calcula **por jornada, no por número de participantes** — así,
  si el grupo crece después de un pago anterior, el siguiente cobro ya
  refleja el tamaño real del grupo. Mientras una quiniela debe y no está
  exenta ni pagada, no puede crear jornadas nuevas hasta regularizarse (sin
  perder acceso a lo que ya tenía).

---

## Cómo se guardan los datos

Todo pasa por una API genérica de "guardar/leer/borrar por clave"
(`/api/kv/:key`) respaldada por una tabla de Postgres. El frontend nunca sabe
que es SQL por debajo — solo pide guardar, leer o borrar un valor con un
nombre. Esto hace que el mismo código sirva tanto para la quiniela original
como para cualquier quiniela nueva creada después, sin duplicar lógica.

## Publicarlo en tu propio dominio (gratis)

Necesitas 3 cosas gratuitas: una base de datos, un repositorio de GitHub, y
una cuenta de Render. Toma unos 15-20 minutos la primera vez.

### Paso 1 — Base de datos (Supabase)

Se usa Supabase en vez de la base de datos gratuita de Render porque la de
Render se borra automáticamente a los 30 días; la de Supabase no expira.

1. Crea una cuenta gratis en https://supabase.com.
2. Crea un **New Project**, ponle nombre, elige una contraseña (guárdala).
3. Dentro del proyecto, click en **Connect** (arriba a la derecha).
4. Elige la pestaña **Session pooler** (NO "Direct connection" — esa solo
   funciona por IPv6, y Render solo tiene salida por IPv4).
5. Copia la URI que aparece y reemplaza `[YOUR-PASSWORD]` con tu contraseña
   real. Guárdala, se usa en el Paso 3.

### Paso 2 — Subir el código a GitHub

1. Crea una cuenta en https://github.com si no tienes.
2. Crea un repositorio nuevo.
3. Sube todos los archivos de esta carpeta (incluida la carpeta `public/`),
   usando **"uploading an existing file"** en la página del repositorio.

### Paso 3 — Publicar en Render

1. Crea una cuenta gratis en https://render.com (con GitHub es más rápido).
2. **New → Web Service** → conecta tu repositorio.
3. Configuración: Runtime `Node`, Build Command `npm install`, Start Command
   `npm start`, Plan `Free`.
4. Antes de crear el servicio, agrega estas **dos** variables de entorno:
   - `DATABASE_URL` — la URI de Supabase del Paso 1.
   - `PLATFORM_PASSWORD` — una contraseña que tú inventes, para entrar la
     primera vez a `/panel-plataforma`. Elige una que no sea obvia — el
     servidor **no arranca** si esta variable no está puesta, a propósito,
     para que nunca quede una quiniela corriendo con una contraseña por
     default que cualquiera pueda adivinar. Una vez que entres al panel por
     primera vez, puedes cambiarla ahí mismo — desde ese momento, la que
     pusiste en Render ya no se vuelve a usar.
5. **Create Web Service**. Toma 2-4 minutos la primera vez.
6. Tu link final se ve como `https://tu-app.onrender.com`.

---

## Historial de lo construido

Resumen de las etapas principales de este proyecto, de más antiguo a más
reciente:

1. **Quiniela de un solo grupo** — jornadas, votación con deadline, cálculo
   de puntos, tabla de posiciones, export a Excel.
2. **Resultados automáticos** — integración con TheSportsDB (gratuita).
3. **Publicación en dominio propio** — migración de Claude a Node + Postgres
   en Render, con guía de despliegue.
4. **Mejoras de confiabilidad** — arreglo de un bug que podía borrar datos
   ante fallas de conexión; guardado automático de picks en cada tap.
5. **Plataforma multi-quiniela** — cualquiera puede crear la suya en
   `/crear`, con su propio link, admin y contraseña.
6. **Seguridad por participante** — PIN de 4 dígitos autoconfigurable,
   auto-registro de nuevos participantes.
7. **Monetización** — panel de plataforma con seguimiento de cobro por
   jornada, exenciones, límites personalizados por quiniela, y datos de
   depósito visibles automáticamente al admin correspondiente.
8. **Cierre de torneos** — anuncio de campeón, archivo de tabla final e
   historial permanente entre torneos.
9. **Soporte multi-liga** — resultados automáticos para Liga MX, las 5
   grandes ligas europeas y la Champions League.
10. **Pulido** — recordatorios de participación con integración a WhatsApp,
    ícono del sitio, limpieza de código.

## Cosas que debes saber

- **Primer acceso más lento**: el plan gratis de Render "duerme" el sitio
  después de 15 minutos sin visitas — la primera persona que entra después
  espera 30-60 segundos. Un servicio gratis como https://uptimerobot.com
  puede pingear `/api/health` cada 10 minutos para evitarlo.
- **Seguridad, con honestidad**: los PIN y las contraseñas se guardan con
  hash (no en texto plano), y el servidor valida los permisos de verdad, no
  solo el navegador. Aun así, esto sigue pensado para frenar bromas o
  errores entre amigos, no para proteger dinero real de un ataque serio —
  no lo uses para algo más sensible que esto.
- **Cobro manual, a propósito**: la plataforma no procesa pagos — solo avisa
  a quién y cuánto cobrar, y bloquea crear jornadas nuevas si no se ha
  pagado. La cobranza real (transferencia, efectivo, etc.) la haces tú, fuera
  del sitio.
- **Actualizaciones futuras**: para pedir cambios, se le puede seguir dando
  seguimiento a esto con Claude — da los archivos actualizados y solo hay que
  subirlos a GitHub; Render vuelve a publicar solo.
