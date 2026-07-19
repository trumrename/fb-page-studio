/**
 * Verify a license key string offline (admin).
 * Usage:
 *   node scripts/verify-license-key.mjs "payload.sig"
 *   node scripts/verify-license-key.mjs --file keys/issued/xxx.txt
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extractKey(text) {
  const raw = String(text || "").trim();
  if (raw.includes(".") && !raw.includes("\n")) return raw.replace(/\s+/g, "");
  const m = raw.match(/KEY[^\n]*:\s*\n([A-Za-z0-9_\-\.]+)/i) || raw.match(/([A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,})/);
  return m ? m[1].trim() : raw.replace(/\s+/g, "");
}

async function main() {
  const args = process.argv.slice(2);
  let keyStr = "";
  if (args[0] === "--file" && args[1]) {
    keyStr = extractKey(fs.readFileSync(path.resolve(args[1]), "utf8"));
  } else if (args[0]) {
    keyStr = extractKey(args[0]);
  } else {
    console.error('Usage: node scripts/verify-license-key.mjs "KEY" | --file path.txt');
    process.exit(1);
  }

  // Import verify from app license service
  const mod = await import(pathToFileURL(path.join(root, "src/services/license.js")).href);
  const v = mod.verifyLicenseKey(keyStr);
  if (!v.ok) {
    console.log("INVALID");
    console.log("error:", v.error);
    if (v.claims) console.log("claims:", JSON.stringify(v.claims, null, 2));
    process.exit(2);
  }
  console.log("VALID");
  console.log(JSON.stringify(v.claims, null, 2));
  console.log("machine_now:", mod.getMachineId());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
