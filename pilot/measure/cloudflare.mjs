// UX-INFRA-001 · H-WAKE · Worker de medición en workers.dev mediante la API de Cloudflare.
//
// El token de API NO pasa por aquí: en la sesión en la nube lo añade el proxy como
// «secreto de red» para api.cloudflare.com. Este script nunca envía, lee ni imprime
// Authorization. El PILOT_TOKEN del Worker se genera aquí y se guarda sólo en
// pilot/measure/out/pilot-token (0600, fuera de git).
//
//   node pilot/measure/cloudflare.mjs comprobar            token válido, cuenta y subdominio workers.dev
//   node pilot/measure/cloudflare.mjs desplegar <ORIGIN>   crea el Worker SÓLO si no existe, y lo registra
//   node pilot/measure/cloudflare.mjs estado               ¿existe? ¿lo creó esta ejecución?
//   node pilot/measure/cloudflare.mjs borrar               borra SÓLO los Workers registrados (apagado)
//
// Protecciones: antes de crear, la lista de Workers de la cuenta debe responder de forma
// concluyente (HTTP 200, success:true, result en forma de lista). Si el nombre ya existe,
// o la consulta falla o es inconclusa, se detiene sin PUT ni POST. El Worker se registra
// en recursos.json ANTES de crearlo; el apagado sólo actúa sobre lo registrado y vuelve a
// comprobar la lista antes y después del DELETE.
//   … --simular                                            muestra las peticiones sin enviarlas
// Cuenta: CLOUDFLARE_ACCOUNT_ID o, si el token puede listarla, la única cuenta visible.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { rawRequest } from "./probe.mjs";
import { createRegistry } from "./recursos.mjs";

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

export function createCloudflare({ simulate = false, log = console.log, request = rawRequest, accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "", outDir = path.join(here, "out") } = {}) {
  const reg = createRegistry({ outDir });
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
    // Lista de Workers de la cuenta. Devuelve { ok: true, exists } sólo si la respuesta es
    // concluyente; si no, { ok: false, reason } y quien llama debe detenerse.
    async exists(acc) {
      let j;
      try { j = await call("GET", `/accounts/${acc}/workers/scripts`); } catch (e) { return { ok: false, reason: `sin respuesta (${e.code || e.message})` }; }
      if (simulate) return { ok: false, reason: "simulado: no se consultó la cuenta" };
      if (j.httpStatus !== 200 || j.success !== true || !Array.isArray(j.result)) return { ok: false, reason: `respuesta inconclusa (${j.httpStatus}${errs(j) ? ": " + errs(j) : ""})` };
      if (j.result.some((x) => !x || typeof x.id !== "string")) return { ok: false, reason: "respuesta inconclusa (entradas sin id)" };
      if (j.result_info && j.result_info.total_count != null && j.result_info.total_count > j.result.length) return { ok: false, reason: "respuesta inconclusa (lista paginada)" };
      return { ok: true, exists: j.result.some((x) => x.id === WORKER_NAME) };
    },
    async deploy(origin) {
      const acc = await account();
      const code = fs.readFileSync(path.join(here, "dist/worker.mjs"), "utf8");
      const tokPath = path.join(outDir, "pilot-token");
      const before = await this.exists(acc);
      if (!before.ok) throw new Error(`detenido sin cambios: no pude confirmar que «${WORKER_NAME}» no exista (${before.reason})`);
      if (before.exists) throw new Error(`detenido sin cambios: ya existe un Worker «${WORKER_NAME}» en la cuenta; no es de este piloto y no se toca`);
      let pilotToken = fs.existsSync(tokPath) ? fs.readFileSync(tokPath, "utf8").trim() : "";
      if (!pilotToken) { pilotToken = crypto.randomBytes(24).toString("hex"); fs.mkdirSync(path.dirname(tokPath), { recursive: true }); fs.writeFileSync(tokPath, pilotToken, { mode: 0o600 }); }
      const up = buildUpload({ code, origin, pilotToken });
      const sha = crypto.createHash("sha256").update(code).digest("hex");
      reg.add("cloudflare-worker", WORKER_NAME, { scope: acc, state: "creando", note: `ORIGIN ${new URL(origin).origin} · bundle ${sha}` });
      let put;
      try { put = await call("PUT", `/accounts/${acc}/workers/scripts/${WORKER_NAME}`, { body: up.body, contentType: up.contentType }); }
      catch (e) { reg.setState("cloudflare-worker", WORKER_NAME, acc, "incierto"); throw new Error(`subida sin respuesta (${e.code || e.message}); registrado como «incierto»`); }
      if (!put.success) {
        // Un rechazo con respuesta concluyente no crea el Worker; aun así se comprueba.
        const after = await this.exists(acc);
        reg.setState("cloudflare-worker", WORKER_NAME, acc, after.ok && !after.exists ? "no-creado" : "incierto");
        throw new Error(`subida rechazada (${put.httpStatus}): ${errs(put)}`);
      }
      reg.setState("cloudflare-worker", WORKER_NAME, acc, "creado", { bundleSha: sha });
      const en = await call("POST", `/accounts/${acc}/workers/scripts/${WORKER_NAME}/subdomain`, { json: { enabled: true } });
      if (!en.success) throw new Error(`creado y registrado, pero no se activó workers.dev (${en.httpStatus}): ${errs(en)}`);
      log(`Worker ${WORKER_NAME} creado y registrado · bundle sha256 ${sha} · ORIGIN ${new URL(origin).origin}`); return { sha };
    },
    async status() {
      const acc = await account();
      const e = await this.exists(acc); const mine = reg.find("cloudflare-worker", WORKER_NAME, acc);
      log(`Worker ${WORKER_NAME}: ${e.ok ? (e.exists ? "existe" : "no existe") : "desconocido: " + e.reason} · registro: ${mine ? mine.state : "no lo creó esta ejecución"}`);
      return { ...e, registered: mine ? mine.state : null };
    },
    // Apagado: SÓLO los Workers que esta ejecución registró (cualquier nombre o cuenta
    // que no esté en recursos.json queda fuera, aunque se llame igual).
    async remove() {
      const acc = await account();
      const mine = reg.list().filter((r) => r.kind === "cloudflare-worker" && r.scope === acc && ["creado", "creando", "incierto"].includes(r.state));
      if (!mine.length) { log("nada que borrar: esta ejecución no tiene Workers registrados en esta cuenta"); return { deleted: 0 }; }
      let deleted = 0;
      for (const r of mine) {
        const before = await this.exists(acc);
        if (!before.ok) throw new Error(`detenido: no pude comprobar «${r.id}» antes de borrar (${before.reason})`);
        if (!before.exists) { reg.setState(r.kind, r.id, acc, r.state === "creado" ? "borrado" : "no-creado", { note: (r.note || "") + " · no existía al apagar" }); log(`${r.id}: ya no existe`); continue; }
        const d = await call("DELETE", `/accounts/${acc}/workers/scripts/${r.id}`);
        const after = await this.exists(acc);
        if (!d.success || !after.ok || after.exists) throw new Error(`borrado de «${r.id}» sin confirmar (${d.httpStatus}${errs(d) ? ": " + errs(d) : ""}; después: ${after.ok ? (after.exists ? "sigue existiendo" : "no existe") : after.reason})`);
        reg.setState(r.kind, r.id, acc, "borrado"); deleted++; log(`${r.id}: borrado y comprobado`);
      }
      return { deleted };
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
