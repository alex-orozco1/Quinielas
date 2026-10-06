// Technical QA (independiente) — #30 + #31 en el SANDBOX, por API.
// Un co-admin intenta adelantarse a la creadora antes y después de que exista la
// contraseña de administrador; carrera al configurarla; rutas alternativas.
// Uso: SANDBOX=https://qracks-mon003-sandbox.onrender.com node tqa-sbx31-api.js
// Sólo el sandbox. PINs y contraseñas aleatorios por corrida, nunca impresos.
// Nada de pagos, checkout, Stripe ni endpoints de plataforma. Tope de peticiones.
"use strict";
const crypto = require("crypto");

const ALLOWED = "https://qracks-mon003-sandbox.onrender.com";
const B = process.env.SANDBOX;
if (B !== ALLOWED) { console.error("Me niego: SANDBOX debe ser exactamente " + ALLOWED); process.exit(2); }

const MAX_REQUESTS = 150;
let nreq = 0, fails = 0, passes = 0, infos = 0;
const out = (s) => console.log(s);
const check = (name, ok, detail = "") => { if (ok) passes++; else fails++; out(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); };
const info = (name, detail = "") => { infos++; out(`INFO ${name}${detail ? " :: " + detail : ""}`); };

const pin4 = (avoid = []) => { let p; do { p = String(crypto.randomInt(0, 10000)).padStart(4, "0"); } while (/^(\d)\1{3}$/.test(p) || avoid.includes(p)); return p; };
const secret = () => "tqa-" + crypto.randomBytes(15).toString("base64url");
const rid = () => crypto.randomBytes(4).toString("hex");
const PATH_OK = /^\/api\/(kv\/[^/]+|create-quiniela|set-pin|self-register|verify-pin|verify-owner|set-admin-password|recover-admin-pin)$/;

// Actor = cabeceras fijas + su propio tarro de cookies.
const actor = (headers = {}) => ({ headers, jar: new Map() });
const anon = () => actor();
async function api(who, method, path, body, extra = {}) {
  if (!PATH_OK.test(path)) throw new Error("ruta no permitida por la sonda");
  if (++nreq > MAX_REQUESTS) throw new Error("tope de peticiones alcanzado");
  const headers = { "Content-Type": "application/json", ...who.headers, ...extra };
  const cookie = [...who.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  for (const c of sc) { const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim(); if (v) who.jar.set(k, v); else who.jar.delete(k); }
  if (r.status >= 500) { fails++; out(`FAIL ${method} ${path.replace(/quiniela%3A[^%]+/, "quiniela:<slug>")} devolvió ${r.status} ${(j && j.error) || ""}`); }
  if (/stack|at \w+ \(|\/opt\/render|node_modules/.test(t)) { fails++; out(`FAIL ${path} respuesta con detalle interno sin sanitizar`); }
  return { status: r.status, body: j || {}, setCookies: sc.map((c) => c.split("=")[0]) };
}
const said = (r) => `${r.status} ${r.body.error || (r.body.ok === false ? "ok:false" : r.body.ok === true ? "ok:true" : "")}`.trim();
const kvPath = (slug) => "/api/kv/" + encodeURIComponent(`quiniela:${slug}:meta`);
const clone = (x) => JSON.parse(JSON.stringify(x));

function quiniela(tag) {
  const slug = `tqa31-${tag}-${Date.now().toString(36)}${rid().slice(0, 3)}`;
  return { slug, metaKey: `quiniela:${slug}:meta` };
}
const futureIso = (days) => { const d = new Date(Date.now() + days * 864e5); d.setSeconds(0, 0); return d.toISOString(); };
const round = (id, published) => {
  const r = { id, number: 1, deadline: futureIso(3), results: {}, resultsPublished: false, matches: [{ id: id + "_m1", teamA: "Toluca", teamB: "Pumas" }] };
  if (published !== undefined) r.published = published;
  return r;
};

// Crea una quiniela con Ana (creadora, con PIN), Carla (co-admin) y Beto (participante).
async function seed(tag, { withCoadmin = true } = {}) {
  const q = quiniela(tag);
  const anaJar = anon();
  const c = await api(anaJar, "POST", "/api/create-quiniela", { slug: q.slug, groupName: "TQA " + tag, creatorName: "Ana" });
  if (c.status !== 200) throw new Error(`create ${tag}: ${said(c)}`);
  q.createSetCookies = c.setCookies;
  q.rawClaim = [...anaJar.jar].find(([k]) => k.startsWith("qracks_setup_")) || null;
  const m0 = (await api(anon(), "GET", kvPath(q.slug))).body.value || {};
  q.anaId = m0.creatorId;
  q.m0 = m0;
  q.anaPin = pin4();
  const sp = await api(anaJar, "POST", "/api/set-pin", { metaKey: q.metaKey, participantId: q.anaId, newPin: q.anaPin, slug: q.slug });
  if (sp.status !== 200) throw new Error(`set-pin ${tag}: ${said(sp)}`);
  q.ana = actor({ "X-Qracks-Auth": q.anaPin, "X-Qracks-Participant": q.anaId });
  if (!withCoadmin) return q;
  q.carlaPin = pin4([q.anaPin]);
  q.betoPin = pin4([q.anaPin, q.carlaPin]);
  const reg = async (name, pin) => {
    const r = await api(anon(), "POST", "/api/self-register", { metaKey: q.metaKey, name, pin, slug: q.slug });
    if (r.status !== 200) throw new Error(`self-register ${name}: ${said(r)}`);
    return r.body.participant.id;
  };
  q.carlaId = await reg("Carla", q.carlaPin);
  q.betoId = await reg("Beto", q.betoPin);
  const v = await get(q, q.ana);
  v.participants.find((x) => x.id === q.carlaId).isAdmin = true;
  const w = await write(q, v, q.ana);
  if (w.status !== 200) throw new Error(`promote Carla ${tag}: ${said(w)}`);
  q.carla = actor({ "X-Qracks-Auth": q.carlaPin, "X-Qracks-Participant": q.carlaId });
  q.beto = actor({ "X-Qracks-Auth": q.betoPin, "X-Qracks-Participant": q.betoId });
  return q;
}
async function get(q, who) { const r = await api(who, "GET", kvPath(q.slug)); return r.body.value; }
async function write(q, value, who, extra) { const r = await api(who, "POST", kvPath(q.slug), { value }, extra); if (r.status === 200) q.cache = null; return r; }
// Estado visto por la creadora; se reutiliza entre intentos rechazados (no cambian nada) para ahorrar peticiones.
async function current(q) { if (!q.cache) q.cache = await get(q, q.ana); return clone(q.cache); }
async function setPw(q, who, password, extra) { const r = await api(who, "POST", "/api/set-admin-password", { metaKey: q.metaKey, password }, extra); if (r.status === 200) q.cache = null; return r; }
const verifyOwner = (q, password) => api(anon(), "POST", "/api/verify-owner", { metaKey: q.metaKey, password });
async function session(q, participantId, pin) {
  const a = anon();
  const r = await api(a, "POST", "/api/verify-pin", { metaKey: q.metaKey, participantId, pin, slug: q.slug });
  if (!(r.status === 200 && r.body.ok === true && [...a.jar.keys()].some((k) => k.startsWith("qracks_session_")))) throw new Error("verify-pin sin sesión: " + said(r));
  return a;
}
const anaOk = (m, q) => {
  const a = (m.participants || []).find((x) => x.id === q.anaId);
  return !!(a && a.isAdmin && a.hasPin !== false && a.name === "Ana" && m.creatorId === q.anaId);
};
const noPublished = (m) => (m.rounds || []).every((r) => r.published === false);
const ruleSnap = (m) => JSON.stringify([m.groupName, (m.settings || {}).entryFee, (m.settings || {}).pointsPerCorrectPick]);

(async () => {
  out(`INFO sandbox ${B}`);

  // ================= Q1: antes de la contraseña =================
  const q = await seed("main");
  check("Q1 nace con creatorId, sin contraseña y sin hashes en la lectura pública",
    !!q.anaId && q.m0.ownerPasswordSet === false && !JSON.stringify(q.m0).includes("scrypt") && !("ownerPassword" in (q.m0.settings || {})) && (q.m0.participants || []).every((p) => !("pin" in p)));
  check("Q1 crear sin contraseña no confía el dispositivo para el dueño (sin cookie de confianza)", !q.createSetCookies.some((n) => n.startsWith("qracks_trust_")), q.createSetCookies.join(","));
  const carlaS = await session(q, q.carlaId, q.carlaPin);
  const anaS = await session(q, q.anaId, q.anaPin);
  let r, v, m;

  // set-admin-password por todas las vías que no son «la creadora con su PIN en esta petición»
  r = await setPw(q, q.carla, secret());
  check("PRE set-admin-password co-admin con su PIN ligado -> 403 not_creator", r.status === 403 && r.body.error === "not_creator", said(r));
  r = await setPw(q, carlaS, secret());
  check("PRE set-admin-password co-admin sólo con su sesión -> 403", r.status === 403, said(r));
  r = await setPw(q, carlaS, secret(), { "X-Qracks-Participant": q.anaId });
  check("PRE set-admin-password sesión de co-admin + cabecera que suplanta a la creadora sin PIN -> 403", r.status === 403, said(r));
  r = await setPw(q, anaS, secret());
  check("PRE set-admin-password sesión de la CREADORA sin PIN en la petición -> 403 (la sesión no basta)", r.status === 403, said(r));
  r = await setPw(q, q.carla, { toString: "x" });
  check("PRE set-admin-password con contraseña no-string -> 400", r.status === 400, said(r));
  r = await setPw(q, actor({ "X-Qracks-Participant": q.anaId, "X-Qracks-Auth": q.anaPin }), "corta");
  check("PRE set-admin-password con contraseña corta -> 400 y no se configura", r.status === 400 && r.body.error === "admin_password_too_short", said(r));
  m = await get(q, q.ana);
  check("PRE tras todo eso sigue sin contraseña", m.ownerPasswordSet === false);

  // Escrituras genéricas que intentan meter la contraseña o cambiar la creadora
  const sneakPw = secret();
  v = await get(q, q.carla);
  v.settings = { ...(v.settings || {}), ownerPassword: sneakPw }; v.creatorId = q.carlaId; v.ownerPasswordSet = true;
  r = await write(q, v, q.carla);
  m = await get(q, q.ana);
  check("PRE co-admin escribe settings.ownerPassword/creatorId/ownerPasswordSet por /api/kv: nada de eso queda",
    m.ownerPasswordSet === false && m.creatorId === q.anaId, `${said(r)} creatorId=${m.creatorId === q.anaId ? "Ana" : "OTRO"} pwSet=${m.ownerPasswordSet}`);
  r = await verifyOwner(q, sneakPw);
  check("PRE la contraseña colada por la co-admin no abre Ajustes", r.status === 200 && r.body.ok === false, said(r));
  v = await get(q, q.ana);
  v.settings = { ...(v.settings || {}), ownerPassword: secret() };
  r = await write(q, v, q.ana);
  m = await get(q, q.ana);
  check("PRE ni la creadora configura la contraseña por /api/kv (sólo por set-admin-password)", m.ownerPasswordSet === false, said(r));

  // Publicar antes de la contraseña, por variantes
  const pubTry = async (label, mutate, who = q.carla, extra) => {
    const val = await current(q); mutate(val);
    const w = await write(q, val, who, extra);
    const after = await get(q, q.ana); q.cache = after;
    check(`PRE ${label}: no publica`, noPublished(after), said(w));
    if (w.status === 200) info(`PRE ${label}: respondió 200 sin publicar (¿silencioso?)`);
    return w;
  };
  await pubTry("co-admin por sesión, jornada nueva published:true", (x) => x.rounds.push(round("r_s_" + rid(), true)), carlaS);
  await pubTry("co-admin, jornada nueva SIN campo published", (x) => x.rounds.push(round("r_u_" + rid())));
  await pubTry("co-admin, published:\"false\" (string)", (x) => x.rounds.push(round("r_str_" + rid(), "false")));
  await pubTry("co-admin, published:null", (x) => x.rounds.push(round("r_null_" + rid(), null)));
  // Preparar sí, y luego intentar publicarla cambiándole el id o con revisiones viejas
  v = await get(q, q.carla); v.rounds.push(round("r_prep", false));
  r = await write(q, v, q.carla);
  m = await get(q, q.ana);
  check("PRE co-admin prepara una jornada sin publicar -> 200", r.status === 200 && m.rounds.length === 1 && m.rounds[0].published === false, said(r));
  const staleRev = m.roundsRevision;
  await pubTry("co-admin cambia el id de la preparada a uno nuevo con published:true", (x) => { x.rounds[0] = { ...x.rounds[0], id: "r_prep2", published: true }; });
  await pubTry("co-admin borra published de la preparada", (x) => { delete x.rounds[0].published; });
  await pubTry("co-admin publica con roundsRevision vieja", (x) => { x.rounds[0].published = true; x.roundsRevision = (typeof staleRev === "number" ? staleRev - 1 : 0); });
  await pubTry("co-admin publica sin roundsRevision", (x) => { x.rounds[0].published = true; delete x.roundsRevision; });
  await pubTry("co-admin con su PIN pero suplantando a la creadora en X-Qracks-Participant", (x) => { x.rounds[0].published = true; },
    actor({ "X-Qracks-Auth": q.carlaPin, "X-Qracks-Participant": q.anaId }));
  await pubTry("co-admin con su PIN sin ligar", (x) => { x.rounds[0].published = true; }, actor({ "X-Qracks-Auth": q.carlaPin }));
  await pubTry("la propia creadora (PIN) antes de configurar la contraseña", (x) => { x.rounds[0].published = true; }, q.ana);

  // Roles y la creadora
  const roleTry = async (label, mutate, who, want) => {
    const val = await current(q); mutate(val);
    const w = await write(q, val, who);
    const after = await get(q, q.ana); q.cache = after;
    const ok = w.status === 403 && (!want || w.body.error === want) && anaOk(after, q)
      && after.participants.filter((x) => x.isAdmin).map((x) => x.id).sort().join() === [q.anaId, q.carlaId].sort().join();
    check(`${label}`, ok, said(w));
  };
  await roleTry("PRE co-admin (sesión) nombra admin a Beto -> 403 creator_only", (x) => { x.participants.find((p) => p.id === q.betoId).isAdmin = true; }, carlaS, "creator_only");
  await roleTry("PRE co-admin agrega a alguien ya admin -> 403 creator_only", (x) => { x.participants.push({ id: "p_tqa" + rid(), name: "Dora", isAdmin: true, paid: false }); }, q.carla, "creator_only");
  await roleTry("PRE co-admin (sesión) le quita el rol a la creadora -> 403 creator_protected", (x) => { x.participants.find((p) => p.id === q.anaId).isAdmin = false; }, carlaS, "creator_protected");
  await roleTry("PRE co-admin cambia el PIN de la creadora por /api/kv -> 403 creator_protected", (x) => { x.participants.find((p) => p.id === q.anaId).pin = "0000"; }, q.carla, "creator_protected");
  await roleTry("PRE co-admin sustituye a la creadora por otro id -> 403", (x) => { const a = x.participants.find((p) => p.id === q.anaId); a.id = "p_tqa" + rid(); }, q.carla);
  r = await api(q.carla, "POST", "/api/set-pin", { metaKey: q.metaKey, participantId: q.anaId, newPin: pin4(), slug: q.slug });
  check("PRE co-admin set-pin de la creadora sin PIN actual -> 403", r.status === 403, said(r));
  r = await api(q.carla, "POST", "/api/recover-admin-pin", { metaKey: q.metaKey, participantId: q.anaId, newPin: pin4() });
  check("PRE co-admin recover-admin-pin de la creadora (no hay contraseña) -> no cambia nada", r.status === 409 || r.status === 403, said(r));
  r = await api(carlaS, "POST", "/api/verify-owner", { metaKey: q.metaKey, password: "" }, { "X-Qracks-Auth": q.carlaPin, "X-Qracks-Participant": q.carlaId });
  check("PRE el PIN/sesión de la co-admin no abre Ajustes protegidos", r.status === 200 && r.body.ok === false, said(r));

  // Reglas del juego: co-admin por sesión y creadora por sesión
  const rules0 = ruleSnap(await get(q, q.ana));
  v = await get(q, carlaS); v.groupName = "Hackeada"; v.settings = { ...v.settings, entryFee: 777, pointsPerCorrectPick: 5 };
  r = await write(q, v, carlaS);
  check("PRE co-admin (sesión) no cambia nombre/cuota/puntos", r.status === 200 && r.body.ruleFieldsKept === true && ruleSnap(await get(q, q.ana)) === rules0, said(r));
  v = await get(q, carlaS); v.settings = []; 
  r = await write(q, v, carlaS);
  check("PRE co-admin manda settings como array -> 400 y reglas intactas", r.status === 400 && ruleSnap(await get(q, q.ana)) === rules0, said(r));
  v = await get(q, carlaS); delete v.groupName; delete v.settings.entryFee; delete v.settings.pointsPerCorrectPick;
  r = await write(q, v, carlaS);
  check("PRE co-admin borra nombre/cuota/puntos del documento -> se conservan", r.status === 200 && ruleSnap(await get(q, q.ana)) === rules0, said(r));

  // «No toca a la creadora»: renombrarla (observación, sin veredicto de la sonda)
  v = await get(q, q.carla); v.participants.find((p) => p.id === q.anaId).name = "Ana (ex)";
  r = await write(q, v, q.carla);
  m = await get(q, q.ana);
  const renamed = (m.participants.find((p) => p.id === q.anaId) || {}).name !== "Ana";
  info("PRE co-admin renombra a la creadora", `${said(r)} renombrada=${renamed}`);
  if (renamed) { v = await get(q, q.ana); v.participants.find((p) => p.id === q.anaId).name = "Ana"; await write(q, v, q.ana); }

  // Lo que ve un participante
  m = await get(q, q.beto);
  check("PRE participante no recibe la jornada preparada ni secretos", Array.isArray(m.rounds) && m.rounds.length === 0 && !("ownerPassword" in (m.settings || {})) && !JSON.stringify(m).includes("scrypt"));

  // Re-crear con el mismo slug
  r = await api(anon(), "POST", "/api/create-quiniela", { slug: q.slug, groupName: "Otra", creatorName: "Mallory" });
  m = await get(q, q.ana);
  check("PRE re-crear con el mismo slug no la reemplaza", r.status !== 200 && anaOk(m, q) && m.groupName === "TQA main", said(r));

  // ================= La creadora configura la contraseña =================
  const ownerPw = secret();
  r = await setPw(q, q.ana, ownerPw);
  check("La creadora configura la contraseña con su PIN ligado -> 200", r.status === 200 && r.body.ok === true, said(r));
  m = await get(q, q.ana);
  check("Configurar la contraseña no publica nada", m.ownerPasswordSet === true && noPublished(m) && m.rounds.length === 1);
  r = await setPw(q, q.ana, secret());
  check("Segunda vez -> 409 already_set", r.status === 409 && r.body.error === "already_set", said(r));

  // ================= Después =================
  r = await setPw(q, q.carla, secret());
  check("POST co-admin set-admin-password -> 403", r.status === 403, said(r));
  const sneak2 = secret();
  v = await get(q, q.carla); v.settings = { ...v.settings, ownerPassword: sneak2 };
  r = await write(q, v, q.carla);
  const vo1 = await verifyOwner(q, sneak2), vo2 = await verifyOwner(q, ownerPw);
  check("POST co-admin no reemplaza la contraseña por /api/kv", vo1.body.ok === false && vo2.body.ok === true, `${said(r)} nueva=${said(vo1)} original=${said(vo2)}`);
  await roleTry("POST co-admin (sesión) le quita el rol a la creadora -> 403 creator_protected", (x) => { x.participants.find((p) => p.id === q.anaId).isAdmin = false; }, carlaS, "creator_protected");
  await roleTry("POST co-admin elimina a la creadora -> 403 creator_protected", (x) => { x.participants = x.participants.filter((p) => p.id !== q.anaId); }, q.carla, "creator_protected");
  await roleTry("POST co-admin nombra admin a Beto -> 403 owner_password_required", (x) => { x.participants.find((p) => p.id === q.betoId).isAdmin = true; }, q.carla, "owner_password_required");
  await roleTry("POST la creadora con su PIN (sin contraseña) ya no nombra admins -> 403", (x) => { x.participants.find((p) => p.id === q.betoId).isAdmin = true; }, q.ana, "owner_password_required");
  r = await api(q.carla, "POST", "/api/recover-admin-pin", { metaKey: q.metaKey, participantId: q.anaId, newPin: pin4() }, { "X-Qracks-Auth": q.carlaPin });
  check("POST co-admin recover-admin-pin de la creadora con su PIN -> 403", r.status === 403, said(r));
  v = await get(q, carlaS); v.groupName = "Hackeada 2"; v.settings = { ...v.settings, entryFee: 666 };
  r = await write(q, v, carlaS);
  check("POST co-admin (sesión) sigue sin cambiar reglas", r.status === 200 && r.body.ruleFieldsKept === true && ruleSnap(await get(q, q.ana)) === rules0, said(r));
  v = await get(q, anaS); v.settings = { ...v.settings, pointsPerCorrectPick: 4 };
  r = await write(q, v, anaS);
  check("POST la creadora por sesión (sin contraseña) tampoco cambia reglas", r.status === 200 && r.body.ruleFieldsKept === true && ruleSnap(await get(q, q.ana)) === rules0, said(r));
  v = await get(q, q.carla); v.rounds[0].published = true;
  r = await write(q, v, q.carla);
  m = await get(q, q.ana);
  check("POST con la contraseña ya configurada, la co-admin publica (diseño)", r.status === 200 && m.rounds[0].published === true, said(r));
  m = await get(q, q.beto);
  check("POST participante ve la jornada publicada y ningún secreto", m.rounds.length === 1 && !("ownerPassword" in (m.settings || {})) && !JSON.stringify(m).includes("scrypt"));

  // ================= Q2: carrera al configurar la contraseña =================
  const q2 = await seed("race");
  v = await get(q2, q2.ana); v.rounds.push(round("r_race", false));
  r = await write(q2, v, q2.ana);
  if (r.status !== 200) throw new Error("preparar Q2: " + said(r));
  const snap = await get(q2, q2.carla);
  const pubVal = clone(snap); pubVal.rounds[0].published = true;
  const paidVal = clone(snap); paidVal.participants.find((p) => p.id === q2.betoId).paid = true;
  const pwA = secret(), pwB = secret(), pwC = secret();
  const [ra, rb, rc, rp, rpaid] = await Promise.all([
    setPw(q2, q2.ana, pwA), setPw(q2, q2.ana, pwB), setPw(q2, q2.carla, pwC),
    write(q2, pubVal, q2.carla), write(q2, paidVal, q2.carla),
  ]);
  const anaWins = [ra, rb].filter((x) => x.status === 200).length;
  check("RACE exactamente una configuración de la creadora gana; la otra 409 already_set",
    anaWins === 1 && [ra, rb].some((x) => x.status === 409 && x.body.error === "already_set"), `${said(ra)} | ${said(rb)}`);
  check("RACE la co-admin no la configura", rc.status === 403, said(rc));
  info("RACE publicación de la co-admin en paralelo", said(rp));
  info("RACE escritura benigna de la co-admin en paralelo", said(rpaid));
  const winner = ra.status === 200 ? pwA : pwB, loser = ra.status === 200 ? pwB : pwA;
  const [w1, w2, w3] = [await verifyOwner(q2, winner), await verifyOwner(q2, loser), await verifyOwner(q2, pwC)];
  m = await get(q2, q2.ana);
  check("RACE queda la contraseña ganadora (no la perdedora ni la de la co-admin) y nada la borró",
    m.ownerPasswordSet === true && w1.body.ok === true && w2.body.ok === false && w3.body.ok === false, `${said(w1)} ${said(w2)} ${said(w3)}`);
  check("RACE coherencia: si la publicación entró fue con contraseña; la creadora intacta",
    anaOk(m, q2) && (rp.status === 200 ? m.rounds[0].published === true : m.rounds[0].published === false));

  // ================= Q3: creadora sin PIN (nadie ocupa su asiento) =================
  const q3 = quiniela("nopin");
  const c3 = await api(anon(), "POST", "/api/create-quiniela", { slug: q3.slug, groupName: "TQA nopin", creatorName: "Ana" });
  if (c3.status !== 200) throw new Error("create Q3: " + said(c3));
  const m3 = (await api(anon(), "GET", kvPath(q3.slug))).body.value;
  const ana3 = m3.creatorId;
  const malloryPin = pin4();
  r = await api(anon(), "POST", "/api/self-register", { metaKey: q3.metaKey, name: "Mallory", pin: malloryPin, slug: q3.slug });
  const malloryId = r.body.participant && r.body.participant.id;
  r = await api(anon(), "POST", "/api/set-pin", { metaKey: q3.metaKey, participantId: ana3, newPin: pin4(), slug: q3.slug });
  check("NOPIN un extraño no elige el PIN de la creadora", r.status === 403, said(r));
  r = await api(actor({ "X-Qracks-Auth": malloryPin, "X-Qracks-Participant": malloryId }), "POST", "/api/set-pin", { metaKey: q3.metaKey, participantId: ana3, newPin: pin4(), slug: q3.slug });
  check("NOPIN un participante con su PIN tampoco", r.status === 403, said(r));
  // Cookie de creación de OTRA quiniela (Q1) renombrada para Q3
  const q1Claim = q.rawClaim;
  if (q1Claim) {
    const forged = actor(); forged.jar.set(`qracks_setup_${q3.slug}`, q1Claim[1]);
    r = await api(forged, "POST", "/api/set-pin", { metaKey: q3.metaKey, participantId: ana3, newPin: pin4(), slug: q3.slug });
    check("NOPIN la cookie de creación de otra quiniela no sirve aquí", r.status === 403, said(r));
  } else info("NOPIN la creación de Q1 no devolvió cookie de creación");
  r = await setPw(q3, actor({ "X-Qracks-Participant": ana3, "X-Qracks-Auth": "0000" }), secret());
  check("NOPIN set-admin-password sin PIN de creadora -> 403 not_creator", r.status === 403 && r.body.error === "not_creator", said(r));
  const m3b = (await api(anon(), "GET", kvPath(q3.slug))).body.value;
  const a3 = (m3b.participants || []).find((p) => p.id === ana3) || {};
  check("NOPIN la creadora sigue sin PIN y sin contraseña", a3.hasPin === false && m3b.ownerPasswordSet === false);

  out(`INFO peticiones=${nreq} slugs=${q.slug},${q2.slug},${q3.slug}`);
  out(fails ? `RESULT: FAIL ${fails} / PASS ${passes} / INFO ${infos}` : `RESULT: ALL PASS ${passes} / INFO ${infos}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { out(`FAIL error inesperado: ${e && e.message}`); out(`RESULT: FAIL (abortado) / PASS ${passes} / peticiones=${nreq}`); process.exit(1); });
