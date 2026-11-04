// Junta el Worker de medición en UN archivo (para pegarlo en el editor de Cloudflare
// o desplegarlo con wrangler). Sólo quita los imports locales y los `export` de los
// módulos internos; no transforma código. Uso: node pilot/dev/bundle.mjs [salida]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const ORDER = ["edge/copy.mjs", "edge/waker.mjs", "edge/page.mjs", "edge/worker.mjs", "measure/probe-worker.mjs"];
const ENTRY = ORDER[ORDER.length - 1];

export function bundle() {
  const parts = ORDER.map((rel) => {
    let src = fs.readFileSync(path.join(root, rel), "utf8");
    if (/^import\s.+from\s+"(?!\.)/m.test(src)) throw new Error(`${rel}: import externo no soportado`);
    src = src.replace(/^import\s[^;]+from\s+"\.\.?\/[^"]+";\s*$/gm, "");
    if (rel !== ENTRY) {
      src = src.replace(/^export default .*$/gm, "");
      src = src.replace(/^export (?=(async )?function |const )/gm, "");
    }
    return `// ── ${rel} ──\n${src}`;
  });
  return `// UX-INFRA-001 · Worker de medición H-WAKE (generado por pilot/dev/bundle.mjs; no editar a mano)\n${parts.join("\n")}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || path.join(root, "measure/dist/worker.mjs");
  const code = bundle();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  console.log(`${out} · ${code.length} bytes · sha256 ${crypto.createHash("sha256").update(code).digest("hex")}`);
}
