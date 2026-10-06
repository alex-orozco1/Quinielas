// Onboarding B (#30 + #31) en el SANDBOX, por API: un co-admin no se adelanta a la
// creadora, ni antes ni después de que exista la contraseña de administrador.
// Uso: SANDBOX=https://qracks-mon003-sandbox.onrender.com node ci/sbx-b-api.js
// Nunca producción: el script se niega a correr contra otra URL. PINs y contraseñas
// aleatorios y desechables; no se imprimen.
"use strict";
const crypto = require("crypto");

const B = process.env.SANDBOX;
if (B !== "https://qracks-mon003-sandbox.onrender.com") { console.error("Sólo contra el sandbox."); process.exit(2); }

let fails = 0, passes = 0;
const check = (name, ok, detail = "") => { if (ok) passes++; else fails++; console.log(`${ok ? "PASS" : "FAIL"} [api] ${name}${detail ? ": " + detail : ""}`); };
const pin4 = () => { let p; do { p = String(crypto.randomInt(0, 10000)).padStart(4, "0"); } while (/^(\d)\1{3}$/.test(p)); return p; };
const secret = () => "sbx-" + crypto.randomBytes(12).toString("base64url");
const api = async (method, path, body, headers = {}) => {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, body: j || {}, sc: typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [] };
};
const kv = (slug) => "/api/kv/" + encodeURIComponent(`quiniela:${slug}:meta`);
const said = (r) => `${r.status} ${r.body.error || (r.body.ok === false ? "ok:false" : "")}`.trim();

(async () => {
  const slug = `sbx31-api-${Date.now().toString(36)}`;
  const metaKey = `quiniela:${slug}:meta`;

  // Ana crea la quiniela (sin contraseña) y elige su PIN con la cookie de creación.
  const c = await api("POST", "/api/create-quiniela", { slug, groupName: "Sandbox API", creatorName: "Ana" });
  check("Crear sin contraseña", c.status === 200 && c.body.slug === slug, said(c));
  const claim = (c.sc.find((x) => x.startsWith("qracks_setup_")) || "").split(";")[0];
  const m0 = (await api("GET", kv(slug))).body.value;
  const anaId = m0.creatorId, anaPin = pin4();
  const sp = await api("POST", "/api/set-pin", { metaKey, participantId: anaId, newPin: anaPin, slug }, { Cookie: claim });
  check("La creadora elige su PIN con la cookie de creación", sp.status === 200, said(sp));
  const ana = { "X-Qracks-Auth": anaPin, "X-Qracks-Participant": anaId };

  // Carla (co-admin) y Beto (participante).
  const carlaPin = pin4();
  const reg = async (name, pin) => (await api("POST", "/api/self-register", { metaKey, name, pin, slug })).body.participant.id;
  const carlaId = await reg("Carla", carlaPin);
  const betoId = await reg("Beto", pin4());
  const get = async (auth = ana) => (await api("GET", kv(slug), null, auth)).body.value;
  const write = (value, auth) => api("POST", kv(slug), { value }, auth);
  let v = await get();
  v.participants.find((x) => x.id === carlaId).isAdmin = true;
  let r = await write(v, ana);
  check("La creadora nombra co-admin a Carla", r.status === 200, said(r));
  const carla = { "X-Qracks-Auth": carlaPin, "X-Qracks-Participant": carlaId };

  const rules0 = await get();
  const sameRules = (m) => m.groupName === rules0.groupName
    && JSON.stringify((m.settings || {}).entryFee) === JSON.stringify((rules0.settings || {}).entryFee)
    && JSON.stringify((m.settings || {}).pointsPerCorrectPick) === JSON.stringify((rules0.settings || {}).pointsPerCorrectPick);
  const deadline = new Date(Date.now() + 3 * 864e5); deadline.setSeconds(0, 0);
  const round = (id, published) => ({ id, number: 1, deadline: deadline.toISOString(), results: {}, resultsPublished: false, published,
    matches: [{ id: id + "_m1", teamA: "América", teamB: "Chivas" }] });

  // ---------- Antes de la contraseña ----------
  r = await api("POST", "/api/set-admin-password", { metaKey, password: secret() }, carla);
  check("Antes: la co-admin no puede configurar la contraseña con su PIN", r.status === 403 && r.body.error === "not_creator", said(r));
  r = await api("POST", "/api/set-admin-password", { metaKey, password: secret() }, { "X-Qracks-Auth": carlaPin, "X-Qracks-Participant": anaId });
  check("Antes: tampoco presentándose como la creadora con su propio PIN", r.status === 403 && r.body.error === "wrong_pin", said(r));
  r = await api("POST", "/api/set-admin-password", { metaKey, password: secret() }, { "X-Qracks-Auth": carlaPin });
  check("Antes: tampoco con su PIN sin ligar a un participante", r.status === 403 && r.body.error === "not_creator", said(r));
  check("Antes: la quiniela sigue sin contraseña", (await get()).ownerPasswordSet === false);

  v = await get(carla); v.rounds.push(round("r_c1", true));
  r = await write(v, carla);
  check("Antes: la co-admin no puede publicar una jornada", r.status === 409 && r.body.error === "admin_password_required", said(r));
  check("Antes: no quedó ninguna jornada", (await get()).rounds.length === 0);
  v = await get(carla); v.rounds.push(round("r_c1", false));
  r = await write(v, carla);
  let m = await get();
  check("Antes: la co-admin sí puede preparar una jornada sin publicar", r.status === 200 && m.rounds.length === 1 && m.rounds[0].published === false, said(r));
  v = await get(carla); v.rounds[0].published = true;
  r = await write(v, carla);
  check("Antes: la co-admin no puede publicar la jornada preparada", r.status === 409 && r.body.error === "admin_password_required" && (await get()).rounds[0].published === false, said(r));

  v = await get(carla); v.groupName = "Cambiada por la co-admin"; v.settings = { ...(v.settings || {}), entryFee: 999, pointsPerCorrectPick: 7 };
  r = await write(v, carla);
  check("Antes: la co-admin no cambia nombre, cuota ni puntos (se conservan)", r.status === 200 && r.body.ruleFieldsKept === true && sameRules(await get()), said(r));
  v = await get(ana); v.groupName = "Cambiada por la creadora con su PIN"; v.settings = { ...(v.settings || {}), entryFee: 888 };
  r = await write(v, ana);
  check("Antes: tampoco la creadora con su PIN (las reglas piden la contraseña)", r.status === 200 && r.body.ruleFieldsKept === true && sameRules(await get()), said(r));

  v = await get(carla); v.participants.find((x) => x.id === betoId).isAdmin = true;
  r = await write(v, carla);
  check("Antes: la co-admin no puede nombrar admins", r.status === 403 && r.body.error === "creator_only", said(r));
  v = await get(carla); v.participants.find((x) => x.id === anaId).isAdmin = false;
  r = await write(v, carla);
  check("Antes: la co-admin no puede quitarle el rol a la creadora", r.status === 403 && r.body.error === "creator_protected", said(r));
  v = await get(carla); v.participants = v.participants.filter((x) => x.id !== anaId);
  r = await write(v, carla);
  check("Antes: la co-admin no puede eliminar a la creadora", r.status === 403 && r.body.error === "creator_protected", said(r));
  v = await get(carla); v.participants.find((x) => x.id === anaId).pin = null;
  r = await write(v, carla);
  check("Antes: la co-admin no puede resetear el PIN de la creadora", r.status === 403 && r.body.error === "creator_protected", said(r));
  r = await api("POST", "/api/set-pin", { metaKey, participantId: anaId, currentPin: carlaPin, newPin: pin4(), slug }, carla);
  check("Antes: la co-admin no puede cambiar el PIN de la creadora", r.status === 403, said(r));
  r = await api("POST", "/api/verify-owner", { metaKey, password: carlaPin }, carla);
  check("Antes: el PIN de la co-admin no abre los Ajustes protegidos", r.status === 200 && r.body.ok === false, said(r));
  m = await get();
  check("Antes: la creadora sigue siendo admin, con su PIN y en la quiniela", !!m.participants.find((x) => x.id === anaId && x.isAdmin));

  // ---------- La creadora configura la contraseña ----------
  const ownerPw = secret();
  r = await api("POST", "/api/set-admin-password", { metaKey, password: ownerPw }, ana);
  check("La creadora configura la contraseña con su PIN", r.status === 200 && (await get()).ownerPasswordSet === true, said(r));
  r = await api("POST", "/api/set-admin-password", { metaKey, password: secret() }, ana);
  check("Sólo una vez: el segundo intento responde already_set", r.status === 409 && r.body.error === "already_set", said(r));

  // ---------- Después de la contraseña ----------
  r = await api("POST", "/api/set-admin-password", { metaKey, password: secret() }, carla);
  check("Después: la co-admin no puede reemplazar la contraseña", r.status === 403 && r.body.error === "not_creator", said(r));
  v = await get(carla); v.groupName = "Otra vez cambiada"; v.settings = { ...(v.settings || {}), entryFee: 555, pointsPerCorrectPick: 9 };
  r = await write(v, carla);
  check("Después: la co-admin sigue sin poder cambiar nombre, cuota ni puntos", r.status === 200 && r.body.ruleFieldsKept === true && sameRules(await get()), said(r));
  v = await get(carla); v.participants.find((x) => x.id === anaId).isAdmin = false;
  r = await write(v, carla);
  check("Después: la co-admin no puede quitarle el rol a la creadora", r.status === 403 && r.body.error === "creator_protected", said(r));
  v = await get(carla); v.participants.find((x) => x.id === betoId).isAdmin = true;
  r = await write(v, carla);
  check("Después: nombrar admins pide la contraseña", r.status === 403 && r.body.error === "owner_password_required", said(r));
  v = await get(carla); v.rounds[0].published = true;
  r = await write(v, carla);
  check("Después: con la contraseña ya configurada, la co-admin sí publica", r.status === 200 && (await get()).rounds[0].published === true, said(r));
  v = await get(ana); v.groupName = "Nombre nuevo con contraseña"; v.settings = { ...(v.settings || {}), entryFee: 150, pointsPerCorrectPick: 3 };
  r = await write(v, { "X-Qracks-Auth": ownerPw });
  m = await get();
  check("Con la contraseña de administrador sí cambian nombre, cuota y puntos", r.status === 200 && m.groupName === "Nombre nuevo con contraseña" && m.settings.entryFee === 150 && m.settings.pointsPerCorrectPick === 3, said(r));

  console.log(fails ? `RESULT: ${fails} FAIL / ${passes} PASS` : `RESULT: ALL PASS (${passes})`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e && e.message); process.exit(1); });
