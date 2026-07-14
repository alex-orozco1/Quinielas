## Quinielas — plataforma de quinielas de Liga MX

Sitio donde cualquier grupo de amigos puede armar su propia quiniela: se eligen
los partidos de cada jornada, cada quien vota antes de la hora límite, y los
puntos se calculan solos en cuanto se capturan los resultados. Empezó como la
quiniela de un solo grupo y se convirtió en una plataforma donde cualquiera
puede crear la suya.

# Qué incluye esta carpeta


public/index.html — todo el sitio (frontend): una sola página que
cambia de vista según la URL.
server.js — un servidor pequeño en Node/Express que guarda los datos
en una base de datos Postgres real (no depende de Claude ni de esta
conversación).
package.json, render.yaml, .gitignore — configuración para
desplegarlo en Render.


Cómo está organizado el sitio

RutaQué es/Página de inicio pública, invita a crear una quiniela/crearFormulario para que cualquiera cree su propia quiniela/q/mi-quinielaUna quiniela específica (una por cada grupo)/panel-plataformaPanel privado del dueño de la plataforma: ve todas las quinielas creadas, cuánto debe cobrar cada una, y puede inspeccionarlas sin modificarlas

Funciones para los participantes de una quiniela


Eligen su nombre de una lista (ordenada alfabéticamente) o se agregan ellos
mismos si no aparecen.
Cada nombre se protege con un PIN de 4 dígitos que la misma persona
elige la primera vez que entra, y puede cambiar cuando quiera — así nadie
más puede votar en su lugar.
Votan quién gana cada partido (o empate) mientras la jornada sigue abierta;
un reloj de cuenta regresiva muestra cuánto falta para el cierre.
Una vez que una jornada cierra, pueden ver lo que votó todo el grupo (ya no
hay ventaja en ocultarlo).
Tabla de posiciones en vivo, historial de jornadas jugadas, y una gráfica de
cómo ha ido cambiando el lugar de cada quien a lo largo del torneo.


Funciones para el administrador de una quiniela

Panel de Admin con estas secciones:


Rondas — crear y editar jornadas (equipos, fecha y hora límite).
Resultados — capturar el resultado real de cada partido; incluye un
botón para buscar resultados automáticos en TheSportsDB (API gratuita)
y solo hay que confirmarlos.
Participación — ver quién ya contestó una jornada abierta y quién no
(sin mostrar los votos), con un botón para copiar un recordatorio.
Participantes — agregar, quitar, renombrar, marcar quién pagó su cuota,
resetear el PIN de alguien que lo olvidó.
Ajustes — nombre de la quiniela, cuota, contraseña de administrador, y
la opción de mover la quiniela de la página principal a su propio link fijo.


Funciones para el dueño de la plataforma (/panel-plataforma)


Lista de todas las quinielas creadas, con link directo, creador, datos de
contacto, número de participantes y estatus de cobro.
Exenta — marca cualquier quiniela para que nunca se le cobre.
Pagado — marca cuando ya se recibió el depósito de una quiniela que
pasó el límite gratuito.
👁 Ver — inspecciona cualquier quiniela (tabla de posiciones, jornadas)
sin necesitar su contraseña y sin poder modificar nada.
Configuración: umbral de participantes gratis, precio por participante, y
los datos de depósito que se le muestran automáticamente al admin de una
quiniela cuando le toca pagar.


Cómo se guardan los datos

Todo pasa por una API genérica de "guardar/leer por clave" (/api/kv/:key)
respaldada por una tabla de Postgres. El frontend nunca sabe que es SQL por
debajo — solo pide guardar o leer un valor con un nombre. Esto hace que el
mismo código sirva tanto para la quiniela original como para cualquier
quiniela nueva creada después, sin duplicar lógica.

Publicarlo en tu propio dominio (gratis)

Necesitas 3 cosas gratuitas: una base de datos, un repositorio de GitHub, y
una cuenta de Render. Toma unos 15-20 minutos la primera vez.

Paso 1 — Base de datos (Supabase)

Se usa Supabase en vez de la base de datos gratuita de Render porque la de
Render se borra automáticamente a los 30 días; la de Supabase no expira.


Crea una cuenta gratis en https://supabase.com.
Crea un New Project, ponle nombre, elige una contraseña (guárdala).
Dentro del proyecto, click en Connect (arriba a la derecha).
Elige la pestaña Session pooler (NO "Direct connection" — esa solo
funciona por IPv6, y Render solo tiene salida por IPv4).
Copia la URI que aparece y reemplaza [YOUR-PASSWORD] con tu contraseña
real. Guárdala, se usa en el Paso 3.


Paso 2 — Subir el código a GitHub


Crea una cuenta en https://github.com si no tienes.
Crea un repositorio nuevo.
Sube todos los archivos de esta carpeta (incluida la carpeta public/),
usando "uploading an existing file" en la página del repositorio.


Paso 3 — Publicar en Render


Crea una cuenta gratis en https://render.com (con GitHub es más rápido).
New → Web Service → conecta tu repositorio.
Configuración: Runtime Node, Build Command npm install, Start Command
npm start, Plan Free.
Antes de crear el servicio, agrega la variable de entorno DATABASE_URL
con la URI de Supabase del Paso 1.
Create Web Service. Toma 2-4 minutos la primera vez.
Tu link final se ve como https://tu-app.onrender.com.


Cosas que debes saber


Primer acceso más lento: el plan gratis de Render "duerme" el sitio
después de 15 minutos sin visitas — la primera persona que entra después
espera 30-60 segundos. Un servicio gratis como https://uptimerobot.com
puede pingear /api/health cada 10 minutos para evitarlo.
Seguridad, con honestidad: los PIN de participantes y las contraseñas de
administrador se guardan tal cual, sin encriptar. Está pensado para frenar
bromas o errores entre amigos, no para proteger dinero real de un ataque
serio — no lo uses para algo más sensible que esto.
Cobro manual, a propósito: la plataforma no procesa pagos ni bloquea el
acceso si alguien no paga — solo avisa a quién y cuánto cobrar. La cobranza
real (transferencia, efectivo, etc.) la haces tú, fuera del sitio.
Actualizaciones futuras: para pedir cambios, se le puede seguir dando
seguimiento a esto con Claude — da los archivos actualizados y solo hay que
subirlos a GitHub; Render vuelve a publicar solo.
