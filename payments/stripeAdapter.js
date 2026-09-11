// stripeAdapter.js — MON-003: la frontera con Stripe, y el único sitio del
// repositorio donde aparecen sus nombres.
//
// Todo lo que sube de aquí ya está en vocabulario de QRACKS. Todo lo que baja
// se traduce aquí. Cuando entre otro proveedor, entra otro archivo como éste
// y nada más se mueve.
//
// Sin SDK, a propósito: QRACKS tiene dos dependencias (express y pg) y la
// superficie que se usa de Stripe son dos endpoints REST y una verificación
// HMAC de veinte líneas. Añadir un SDK entero por eso engorda el despliegue y
// esconde detrás de una capa justamente la parte que hay que poder auditar.
// El contrato implementado abajo está tomado de la fuente primaria: el propio
// SDK oficial de Stripe (stripe@22.6.2, cjs/Webhooks.js y cjs/RequestSender.js).

const crypto = require("crypto");

const STRIPE_API_BASE = "https://api.stripe.com";
// Fijada, no "la última". Una versión de API que cambia sola bajo un servicio
// que cobra dinero es un cambio de comportamiento que nadie desplegó.
const STRIPE_API_VERSION = "2026-08-26.dahlia";

// Los cuatro eventos de un Checkout de pago único, tal y como los declara el
// SDK oficial. No se escucha nada más: cada evento extra es una vía más por la
// que algo podría otorgar un plan.
const EVENT = Object.freeze({
  COMPLETED: "checkout.session.completed",
  ASYNC_SUCCEEDED: "checkout.session.async_payment_succeeded",
  ASYNC_FAILED: "checkout.session.async_payment_failed",
  EXPIRED: "checkout.session.expired",
  // Sólo auditoría: no revocan nada por su cuenta (ver MON-003 §REFUNDS).
  REFUNDED: "charge.refunded",
  DISPUTED: "charge.dispute.created",
});
const HANDLED_EVENTS = Object.freeze(Object.values(EVENT));

// La tolerancia por defecto del SDK oficial (Webhook.DEFAULT_TOLERANCE = 300).
const SIGNATURE_TOLERANCE_SECONDS = 300;

// ---- verificación de firma ------------------------------------------------
//
// LA AUTORIDAD DE TODO MON-003. Si esto se puede falsificar, PLUS es gratis.
//
// El contrato: la cabecera `Stripe-Signature` trae `t=<unix>,v1=<hex>` y puede
// traer VARIOS `v1` a la vez (es lo que permite rotar el secreto sin cortar
// entregas). Lo firmado es exactamente `${t}.${cuerpo crudo}` con HMAC-SHA256
// y el signing secret, en hex.
//
// "Cuerpo crudo" es literal: el JSON tal y como llegó, byte a byte. Si algo lo
// parsea y lo vuelve a serializar, la firma deja de cuadrar aunque el
// contenido sea el mismo — por eso la ruta del webhook monta su propio parser
// y no el global.
function parseSignatureHeader(header) {
  if (typeof header !== "string" || !header) return null;
  let timestamp = -1;
  const signatures = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      const t = parseInt(value, 10);
      if (Number.isFinite(t)) timestamp = t;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === -1 || !signatures.length) return null;
  return { timestamp, signatures };
}

// Comparación en tiempo constante. La comprobación de longitud va ANTES porque
// timingSafeEqual lanza si difieren, y una excepción es un canal lateral tan
// bueno como una diferencia de tiempo.
function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

// `rawBody` DEBE ser un Buffer o una cadena con el cuerpo original. Se rechaza
// cualquier otra cosa —un objeto ya parseado, por ejemplo— en vez de
// convertirla: verificar la firma de algo reconstruido es verificar otra cosa.
function verifyWebhookSignature(rawBody, signatureHeader, secret, opts) {
  const o = opts || {};
  if (!secret || typeof secret !== "string") return { ok: false, reason: "no_signing_secret" };
  const isBuffer = Buffer.isBuffer(rawBody);
  if (!isBuffer && typeof rawBody !== "string") return { ok: false, reason: "payload_not_raw" };
  const payload = isBuffer ? rawBody.toString("utf8") : rawBody;

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, reason: "malformed_signature_header" };

  const expected = crypto.createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${payload}`, "utf8")
    .digest("hex");
  // Cualquiera de las firmas presentes vale: durante una rotación de secreto
  // Stripe manda la del secreto viejo y la del nuevo en la misma cabecera.
  if (!parsed.signatures.some((sig) => safeEqualHex(expected, sig))) {
    return { ok: false, reason: "signature_mismatch" };
  }

  const nowSec = Math.floor((Number.isFinite(o.nowMs) ? o.nowMs : Date.now()) / 1000);
  const tolerance = Number.isFinite(o.toleranceSeconds) ? o.toleranceSeconds : SIGNATURE_TOLERANCE_SECONDS;
  // Sólo hacia el pasado, que es lo que acota una reproducción. Una marca de
  // tiempo en el futuro viene de un reloj desajustado, no de un ataque, y
  // rechazarla sólo rompería entregas legítimas.
  if (tolerance > 0 && nowSec - parsed.timestamp > tolerance) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }
  return { ok: true, timestamp: parsed.timestamp };
}

// ---- traducción: evento de Stripe -> vocabulario de QRACKS ----------------
//
// A partir de esta función, nada aguas arriba sabe qué es un
// `checkout.session` ni un `payment_status`.
function normalizeEvent(parsedBody) {
  const ev = parsedBody;
  if (!ev || typeof ev !== "object") return null;
  const type = typeof ev.type === "string" ? ev.type : null;
  const id = typeof ev.id === "string" ? ev.id : null;
  if (!type || !id) return null;
  const obj = (ev.data && ev.data.object) || null;
  if (!obj || typeof obj !== "object") return null;

  const meta = (obj.metadata && typeof obj.metadata === "object") ? obj.metadata : {};
  const asId = (v) => (typeof v === "string" && v ? v : (typeof v === "object" && v && typeof v.id === "string" ? v.id : null));

  if (type === EVENT.REFUNDED || type === EVENT.DISPUTED) {
    // Un cargo, no una sesión. Sólo se audita: la política de revocación es
    // una decisión comercial que este ticket NO inventa.
    return {
      eventId: id, type, kind: "audit_only",
      purchaseId: meta.qracks_purchase_id || null,
      sessionId: null,
      paymentIntentId: asId(obj.payment_intent),
      paid: false, amountMinor: null, currency: null, terminalStatus: null,
      attentionHint: type === EVENT.REFUNDED ? "refunded" : "disputed",
    };
  }

  if (!HANDLED_EVENTS.includes(type)) return null;

  // `payment_status: "paid"` es la única afirmación de cobro que se acepta.
  // `status: "complete"` NO basta: una sesión puede completarse con el pago
  // todavía en curso, y tratarlo como cobrado sería regalar el plan.
  const paid = obj.payment_status === "paid";
  let terminalStatus = null;
  if (type === EVENT.EXPIRED) terminalStatus = "expired";
  else if (type === EVENT.ASYNC_FAILED) terminalStatus = "failed";

  return {
    eventId: id, type, kind: "checkout",
    lifecycle: (typeof obj.status === "string" && SESSION_LIFECYCLE[obj.status]) || "unknown",
    // Pista para localizar el registro durable. NO es autoridad: quien decide
    // es el intent guardado (ver paymentsDomain.locateIntent).
    purchaseId: meta.qracks_purchase_id || null,
    slugHint: meta.qracks_slug || null,
    scopeHint: meta.qracks_scope_id || null,
    sessionId: asId(obj.id),
    paymentIntentId: asId(obj.payment_intent),
    paid,
    amountMinor: Number.isSafeInteger(obj.amount_total) ? obj.amount_total : null,
    currency: typeof obj.currency === "string" ? obj.currency : null,
    terminalStatus,
  };
}

// La misma traducción para una sesión leída directamente (reconciliación).
// Comparte forma con normalizeEvent a propósito: el dominio evalúa las dos con
// la misma función y no puede ser más laxo con una que con la otra.
// Los tres estados que Stripe declara para una sesión de Checkout: `open`,
// `complete` y `expired` (ver la documentación del propio SDK sobre /expire:
// "A Checkout Session can be expired when it is in one of these statuses:
// open"). Cualquier otra cosa es desconocida, y desconocido NUNCA se traduce
// como seguro.
const SESSION_LIFECYCLE = Object.freeze({
  open: "chargeable",     // todavía puede aceptar dinero
  complete: "used",       // ya se usó: hay pago, o lo habrá
  expired: "dead",        // no puede aceptar dinero nunca más
});

function normalizeSession(session) {
  if (!session || typeof session !== "object") return null;
  const meta = (session.metadata && typeof session.metadata === "object") ? session.metadata : {};
  const asId = (v) => (typeof v === "string" && v ? v : (typeof v === "object" && v && typeof v.id === "string" ? v.id : null));
  let terminalStatus = null;
  if (session.status === "expired") terminalStatus = "expired";
  // Correction 02: el invariant de "un solo checkout cobrable" necesita saber
  // si ESTA sesión todavía puede cobrar. Se traduce aquí, una vez, y aguas
  // arriba nadie vuelve a ver la palabra "open".
  const lifecycle = (typeof session.status === "string" && SESSION_LIFECYCLE[session.status]) || "unknown";
  return {
    lifecycle,
    eventId: null, type: "reconciliation", kind: "checkout",
    purchaseId: meta.qracks_purchase_id || null,
    slugHint: meta.qracks_slug || null,
    scopeHint: meta.qracks_scope_id || null,
    sessionId: asId(session.id),
    paymentIntentId: asId(session.payment_intent),
    paid: session.payment_status === "paid",
    amountMinor: Number.isSafeInteger(session.amount_total) ? session.amount_total : null,
    currency: typeof session.currency === "string" ? session.currency : null,
    terminalStatus,
  };
}

// ---- configuración --------------------------------------------------------
//
// Las claves viven SÓLO en el entorno del servidor. No hay ruta que las
// devuelva, no se escriben en un log y no se guardan en la base.
function readConfig(env) {
  const e = env || process.env;
  const secretKey = typeof e.STRIPE_SECRET_KEY === "string" ? e.STRIPE_SECRET_KEY.trim() : "";
  const webhookSecret = typeof e.STRIPE_WEBHOOK_SECRET === "string" ? e.STRIPE_WEBHOOK_SECRET.trim() : "";
  const publicBaseUrl = typeof e.PUBLIC_BASE_URL === "string" ? e.PUBLIC_BASE_URL.trim() : "";
  return { secretKey, webhookSecret, publicBaseUrl };
}

// Configurado significa: se puede cobrar Y se puede verificar el cobro. Tener
// sólo la mitad es peor que no tener nada — se podría crear un checkout cuya
// confirmación jamás se aceptaría — así que las dos claves se exigen juntas.
function isConfigured(env) {
  const c = readConfig(env);
  return !!(c.secretKey && c.webhookSecret && c.publicBaseUrl);
}

// ---- llamadas a la API ----------------------------------------------------

function formEncode(params, prefix, out) {
  const acc = out || [];
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) formEncode(v, key, acc);
    else if (Array.isArray(v)) v.forEach((item, i) => {
      if (item != null && typeof item === "object") formEncode(item, `${key}[${i}]`, acc);
      else acc.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
    });
    else acc.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return acc;
}

class StripeError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "StripeError";
    this.code = code;
    this.status = status || null;
  }
}

async function stripeRequest(method, path, { params, idempotencyKey, env, timeoutMs } = {}) {
  const cfg = readConfig(env);
  if (!cfg.secretKey) throw new StripeError("not_configured", "Stripe secret key is not configured");
  const headers = {
    Authorization: `Bearer ${cfg.secretKey}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  let body;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = formEncode(params || {}).join("&");
    // La idempotencia del LADO DE STRIPE. La nuestra vive en el purchase
    // intent; ésta es la segunda red, para que un reintento nuestro sobre una
    // respuesta perdida no cree una segunda sesión allí tampoco.
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 12000);
  let res;
  try {
    res = await fetch(`${STRIPE_API_BASE}${path}`, { method, headers, body, signal: controller.signal });
  } catch (err) {
    throw new StripeError(err && err.name === "AbortError" ? "timeout" : "network_error",
      "Stripe request failed");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    // El mensaje del proveedor NO se propaga tal cual hacia arriba: puede
    // llevar detalle que no queremos ni en un log ni en una pantalla. Sólo
    // el código.
    const code = (json && json.error && json.error.code) || `http_${res.status}`;
    throw new StripeError(code, "Stripe rejected the request", res.status);
  }
  return json;
}

// Crea la sesión de Checkout hospedado.
//
// El importe, la moneda y la descripción los pone el SERVIDOR desde la
// configuración comercial. Nada de esto llega del navegador, y por eso una
// llamada fabricada no puede comprar PLUS por un peso.
async function createCheckoutSession({
  amountMinor, currency, productName, purchaseId, slug, scopeId,
  successUrl, cancelUrl, idempotencyKey, env, expiresAt,
}) {
  const params = {
    mode: "payment",
    // Tarjeta y las wallets que Checkout activa sobre ella. Nada asíncrono ni
    // local en V1: un método cuyo ciclo de vida no está implementado de verdad
    // es una forma elegante de perder un pago.
    "payment_method_types[0]": "card",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": currency,
    "line_items[0][price_data][unit_amount]": amountMinor,
    "line_items[0][price_data][product_data][name]": productName,
    // Lo mínimo para reconciliar, y nada sensible: ni PINs, ni contraseñas,
    // ni datos de participantes.
    "metadata[qracks_purchase_id]": purchaseId,
    "metadata[qracks_slug]": slug,
    "metadata[qracks_scope_id]": scopeId,
    // Se propaga al PaymentIntent para poder reconciliar también desde el
    // lado del cargo, no sólo desde la sesión.
    "payment_intent_data[metadata][qracks_purchase_id]": purchaseId,
  };
  if (Number.isSafeInteger(expiresAt)) params.expires_at = expiresAt;
  const session = await stripeRequest("POST", "/v1/checkout/sessions", { params, idempotencyKey, env });
  if (!session || typeof session.id !== "string" || typeof session.url !== "string") {
    throw new StripeError("invalid_response", "Stripe returned an unusable session");
  }
  return { sessionId: session.id, url: session.url };
}

async function retrieveCheckoutSession(sessionId, { env } = {}) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const session = await stripeRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { env });
  return normalizeSession(session);
}

// Deja una sesión definitivamente incobrable.
//
// Stripe sólo admite expirar una sesión en estado `open` — su propio SDK lo
// documenta así — y por eso esta función NO se usa a ciegas: quien llama
// consulta primero el estado y sólo expira lo que está abierto. Depender del
// error de Stripe para distinguir "ya estaba completada" de "ya estaba
// expirada" significaría leer sus mensajes, que no son un contrato.
//
// Devuelve la sesión ya normalizada, para poder COMPROBAR que quedó muerta en
// vez de suponerlo.
async function expireCheckoutSession(sessionId, { env } = {}) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const session = await stripeRequest(
    "POST", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    // Sin cuerpo, pero con clave de idempotencia: dos pestañas reemplazando a
    // la vez no producen dos llamadas con efectos distintos.
    { params: {}, idempotencyKey: `expire:${sessionId}`, env });
  return normalizeSession(session);
}

module.exports = {
  STRIPE_API_VERSION, EVENT, HANDLED_EVENTS, SIGNATURE_TOLERANCE_SECONDS,
  StripeError,
  parseSignatureHeader, verifyWebhookSignature,
  normalizeEvent, normalizeSession,
  readConfig, isConfigured,
  createCheckoutSession, retrieveCheckoutSession, expireCheckoutSession,
  SESSION_LIFECYCLE,
  _formEncode: formEncode,
};
