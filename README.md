# Quiniela Liga MX — Guía para publicarlo en tu propio dominio (gratis)

Esta carpeta ya tiene todo el código: el sitio (`public/index.html`) y un pequeño
servidor (`server.js`) que guarda los datos en una base de datos real, en vez de
depender de Claude. Para que quede en línea con un link propio como el de tu
amigo (`algo.onrender.com`) necesitas 3 cosas gratuitas: una base de datos, un
repositorio de GitHub, y una cuenta de Render. Toma unos 15-20 minutos la
primera vez.

## Paso 1 — Crear la base de datos (Supabase, gratis)

Usamos Supabase en vez de la base de datos gratuita de Render porque la de
Render **se borra automáticamente a los 30 días**. La de Supabase no expira.

1. Ve a https://supabase.com y crea una cuenta gratis (con GitHub es más rápido).
2. Crea un **New Project**. Ponle un nombre, elige una contraseña para la base
   de datos (guárdala) y espera 1-2 minutos a que se cree.
3. Ya dentro del proyecto, click en el botón **Connect** (arriba a la derecha
   del dashboard). Se abre una ventana con varias opciones de conexión.
4. Ahí eliges la pestaña **Session pooler** (NO "Direct connection"). Esto es
   importante: la conexión directa de Supabase solo funciona por IPv6, y el
   plan gratis de Render solo tiene salida por IPv4 — si usas la conexión
   directa, Render no va a poder conectarse a la base de datos.
5. Copia esa URI. Se ve algo así:
   `postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-region.pooler.supabase.com:5432/postgres`
6. Reemplaza `[YOUR-PASSWORD]` con la contraseña que pusiste en el paso 2.
   Guarda esta URL completa — la vas a necesitar en el Paso 3.

## Paso 2 — Subir el código a GitHub

1. Ve a https://github.com y crea una cuenta si no tienes.
2. Crea un repositorio nuevo (botón verde **New**), por ejemplo
   `quiniela-liga-mx`. Puede ser privado o público, no importa.
3. Sube todos los archivos de esta carpeta al repositorio. La forma más fácil
   sin usar la terminal: en la página del repo, click **"uploading an existing
   file"** y arrastra todos los archivos (incluyendo la carpeta `public/`).

## Paso 3 — Publicar en Render (gratis)

1. Ve a https://render.com y crea una cuenta (con GitHub es más rápido — así
   Render ya puede ver tu repositorio).
2. Click **New → Web Service**.
3. Conecta el repositorio `quiniela-liga-mx` que acabas de subir.
4. Configuración:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. Antes de crear el servicio, agrega la variable de entorno:
   - **Key**: `DATABASE_URL`
   - **Value**: la URL de Supabase que guardaste en el Paso 1
6. Click **Create Web Service**. Render va a instalar todo y publicarlo — toma
   2-3 minutos la primera vez.
7. Cuando termine, Render te da un link como
   `https://quiniela-liga-mx.onrender.com` — ese es tu link final, compártelo
   con el grupo.

## Cosas que debes saber

- **Primer acceso más lento**: el plan gratis de Render "duerme" el sitio
  después de 15 minutos sin visitas. La primera persona que entre después de
  eso espera unos 30-60 segundos mientras despierta. Después va normal. (El
  link de Claude que usábamos antes no tenía este problema — es el trade-off
  de tener tu propio dominio gratis.)
  - Opcional: si quieres evitarlo, un servicio gratis como
    https://uptimerobot.com puede visitar `https://tu-link.onrender.com/api/health`
    cada 10 minutos para mantenerlo despierto.
- **Los datos ahora viven en Supabase**, no en Claude. Son tuyos, permanentes,
  y no dependen de esta conversación ni de tu cuenta de Claude.
- **Contraseña de dueño por defecto**: `gol2026` — cámbiala en cuanto entres
  (Admin → Ajustes).
- **Actualizaciones futuras**: si quieres que yo (Claude) le haga cambios al
  sitio más adelante, dame los archivos actualizados y solo tienes que subir
  los cambios a GitHub — Render vuelve a publicar automáticamente.
