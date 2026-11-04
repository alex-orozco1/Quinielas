// UX-INFRA-001 · H-WAKE · Worker de medición en workers.dev mediante la API de Cloudflare.
//
// El token de API NO pasa por aquí: en la sesión en la nube lo añade el proxy como
// «secreto de red» para api.cloudflare.com. Este script nunca envía, lee ni imprime
// Authorization. El PILOT_TOKEN del Worker se genera aquí y se guarda sólo en
// pilot/measure/out/pilot-token (0600, fuera de git).
//
//   node pilot/measure/cloudflare.mjs comprobar            token válido, cuenta y subdominio workers.dev
//   node pilot/measure/cloudflare.mjs desplegar <ORIGIN>   sube dist/worker.mjs y activa workers.dev
//   node pilot/measure/cloudflare.mjs estado               ¿existe el Worker?
//   node pilot/measure/cloudflare.mjs borrar               borra el Worker (apagado)
//   … --simular                                            muestra las peticiones sin enviarlas
// Cuenta: CLOUDFLARE_ACCOUNT_ID o, si el token puede listarla, la única cuenta visible.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { rawRequest } from "./probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_NAME = "qracks-hwake-pilot";
const API = "https://api.cloudflare.com/client/v4";
const COMPAT_DATE = "2025-09-01";

export function buildUpload({ code, origin, pilotToken, boundary = "----qracks" + crypto.randomBytes(8).toString("hex") }) {
  const u = new URL(origin);
  if (u.protocol !== "https:" || !u.hostname.endsWith(".onrender.com") || u.pathname !== "/") throw new Error("ORIGIN debe ser https://<servicio>.onrender.com");
  const metadata = { main_module: "worker.mjs", compatibility_date: COMPAT_DATE,
    bindings: [{ type: "plain_text", name: "ORIGIN", text: u.origin }, { type: "secret_text", name: "PILOT_TOKEN", text: pilotToken }] };
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: application/javascript+module\r\n\r\n${code}\r\n`,
    `--${boundary}--\r\n`,
  ];
  return { body: Buffer.from(parts.join(""), "utf8"), contentType: `multipart/form-data; boundary=${boundary}`, metadata };
}

export function createCloudflare({ simulate = false, log = console.log, request = rawRequest, accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "" } = {}) {
  async function call(method, p, { json, body, contentType } = {}) {
    const payload = json ? Buffer.from(JSON.stringify(json)) : body || null;
    const headers = { accept: "application/json" };
    if (payload) headers["content-type"] = json ? "application/json" : contentType;
    if (simulate) { log(`[simulado] ${method} ${p} ${payload ? payload.length + " bytes" : ""}`); return { success: true, simulated: true, result: null }; }
    const r = await request(API + p, { method, headers, body: payload, timeoutMs: 60_000 });
    let j = null; try { j = JSON.parse(r.body.toString("utf8")); } catch { j = { success: false, errors: [{ message: `HTTP ${r.status} sin JSON` }] }; }
    j.httpStatus = r.status; return j;
  }
  const errs = (j) => (j.errors || []).map((e) => `${e.code || ""} ${e.message || ""}`.trim()).join("; ");
  async function account() {
    if (accountId) return accountId;
    const j = await call("GET", "/accounts");
    if (!j.success || !Array.isArray(j.result) || j.result.length !== 1) throw new Error(`no pude determinar la cuenta (${j.httpStatus}: ${errs(j) || (j.result || []).length + " cuentas"}); indica CLOUDFLARE_ACCOUNT_ID`);
    return (accountId = j.result[0].id);
  }
  return {
    async check() {
      const acc = await account();
      const v = await call("GET", `/accounts/${acc}/tokens/verify`); const vu = v.success ? v : await call("GET", "/user/tokens/verify");
      const sub = await call("GET", `/accounts/${acc}/workers/subdomain`);
      const out = { tokenValid: Boolean(vu.success), tokenStatus: vu.result && vu.result.status, tokenExpires: vu.result && vu.result.expires_on || null,
        accountId: acc, workersDevSubdomain: sub.success && sub.result ? sub.result.subdomain : null, subdomainError: sub.success ? null : errs(sub) };
      out.workerHost = out.workersDevSubdomain ? `${WORKER_NAME}.${out.workersDevSubdomain}.workers.dev` : null;
      log(JSON.stringify(out, null, 2)); return out;
    },
    async deploy(origin) {
      const acc = await account();
      const code = fs.readFileSync(path.join(here, "dist/worker.mjs"), "utf8");
      const tokPath = path.join(here, "out/pilot-token");
      let pilotToken = fs.existsSync(tokPath) ? fs.readFileSync(tokPath, "utf8").trim() : "";
      if (!pilotToken) { pilotToken = crypto.randomBytes(24).toString("hex"); fs.mkdirSync(path.dirname(tokPath), { recursive: true }); if (!simulate) fs.writeFileSync(tokPath, pilotToken, { mode: 0o600 }); }
      const up = buildUpload({ code, origin, pilotToken });
      const put = await call("PUT", `/accounts/${acc}/workers/scripts/${WORKER_NAME}`, { body: up.body, contentType: up.contentType });
      if (!put.success) throw new Error(`subida rechazada (${put.httpStatus}): ${errs(put)}`);
      const en = await call("POST", `/accounts/${acc}/workers/scripts/${WORKER_NAME}/subdomain`, { json: { enabled: true } });
      if (!en.success) throw new Error(`no se activó workers.dev (${en.httpStatus}): ${errs(en)}`);
      const sha = crypto.createHash("sha256").update(code).digest("hex");
      log(`${simulate ? "[simulado] " : ""}Worker ${WORKER_NAME} desplegado · bundle sha256 ${sha} · ORIGIN ${new URL(origin).origin}`); return { sha };
    },
    async status() {
      const acc = await account();
      const j = await call("GET", `/accounts/${acc}/workers/scripts`);
      const exists = Boolean(j.success && (j.result || []).some((s) => s.id === WORKER_NAME));
      log(`Worker ${WORKER_NAME}: ${j.success ? (exists ? "existe" : "no existe") : "error " + errs(j)}`); return { exists, ok: j.success };
    },
    async remove() {
      const acc = await account();
      const j = await call("DELETE", `/accounts/${acc}/workers/scripts/${WORKER_NAME}`);
      log(`borrar ${WORKER_NAME}: ${j.success ? "hecho" : "error " + errs(j)}`); return j.success;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg] = process.argv.slice(2);
  const cf = createCloudflare({ simulate: process.argv.includes("--simular") });
  const run = { comprobar: () => cf.check(), desplegar: () => cf.deploy(arg), estado: () => cf.status(), borrar: () => cf.remove() }[cmd];
  if (!run) { console.error("Uso: node pilot/measure/cloudflare.mjs comprobar | desplegar <ORIGIN> | estado | borrar [--simular]"); process.exit(2); }
  run().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
