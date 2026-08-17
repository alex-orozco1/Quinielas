# Operación — QRACKS en Render

Guía corta para diagnosticar y responder si algo falla en producción. No sustituye monitoreo dedicado — es lo mínimo para operar con los primeros organizadores.

## 1. Verificar que el servicio está vivo

```
GET https://<tu-dominio-render>/api/health
```

Respuesta esperada:
```json
{"ok": true, "time": "2026-08-14T..."}
```

- **Responde con `ok:true`** → el servidor está arriba y conectado a la base de datos (el endpoint no depende de la DB directamente, así que si el servidor responde pero las páginas fallan, ver paso 2 — puede ser un problema de conexión a Postgres).
- **No responde / timeout / 502** → el servicio está caído o Render no pudo levantarlo. Ir a Render.
- **Responde pero las páginas normales fallan** → revisar logs (paso 2), probable problema de `DATABASE_URL` o conexión a Supabase.

## 2. Dónde revisar logs en Render

1. Entra a [dashboard.render.com](https://dashboard.render.com) → selecciona el servicio `quiniela-liga-mx`.
2. Pestaña **"Logs"** (menú lateral) — muestra el output en vivo del proceso (`console.log`/`console.error` de `server.js`).
3. Filtra por fecha/hora si buscas un evento específico (ej. el momento en que alguien reportó un error).
4. Errores de conexión a base de datos suelen verse como `ECONNREFUSED`, `password authentication failed`, o timeouts de Postgres — casi siempre apuntan a que `DATABASE_URL` cambió, expiró, o Supabase está teniendo un problema por su lado.
5. Pestaña **"Events"** — muestra el historial de deploys (cuándo se desplegó qué commit, y si el build/deploy falló).

## 3. Procedimiento básico de rollback

Render conserva los deploys anteriores — no hace falta revertir código a mano:

1. Dashboard → servicio → pestaña **"Events"** (o **"Deploys"**).
2. Busca el último deploy que sabías que funcionaba bien.
3. Botón **"Rollback to this deploy"** (o **"Redeploy"** sobre ese commit específico, según la versión de la interfaz de Render).
4. Confirma. Render vuelve a desplegar ese commit — toma unos minutos, igual que un deploy normal.
5. Verifica con `/api/health` y una revisión visual rápida (login, Jornada) de que todo responde bien otra vez.

**Nota:** el rollback es sobre el código/deploy, no sobre la base de datos. Si el problema fue causado por un cambio de datos (no de código), el rollback de Render no lo revierte — eso requeriría una acción aparte sobre Supabase.

## 4. Qué revisar si un deploy falla

1. **Events → el deploy fallido** → abre el log de build de ese intento específico.
2. Errores más comunes:
   - **`npm install` falla** → revisar si `package.json`/`package-lock.json` cambiaron de forma incompatible.
   - **El proceso arranca y muere enseguida** → revisar los logs (paso 2) del primer minuto tras el arranque — casi siempre `DATABASE_URL` o `PLATFORM_PASSWORD` faltante o mal configurado en el servicio.
   - **Build exitoso pero `/api/health` no responde** → puede ser que el servicio tarde en levantar (Render free tier duerme instancias inactivas — el primer request tras inactividad puede tardar ~30-60s, no es necesariamente un fallo).
3. Si nada de lo anterior resuelve: rollback (paso 3) al último deploy funcional mientras se investiga con más calma — no hay necesidad de diagnosticar bajo presión con el servicio caído.

## Variables de entorno requeridas (Render → Environment)

| Variable | Qué es |
|---|---|
| `DATABASE_URL` | Cadena de conexión a Postgres (Supabase) |
| `PLATFORM_PASSWORD` | Contraseña del panel de plataforma (`/api/platform-*`) |

Si alguna falta o es incorrecta, el servicio puede levantar pero fallar en cualquier operación que toque la base de datos.
