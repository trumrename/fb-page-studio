/**
 * Generate license keys (vendor only).
 *
 * Usage:
 *   node scripts/gen-license.mjs --type commercial --holder "ACME Co" --days 365
 *   node scripts/gen-license.mjs --type employee --holder "NV01" --days 90 --max-accounts 10 --max-pages 40
 *   node scripts/gen-license.mjs --type lifetime --holder "VIP" --max-accounts 0 --max-pages 0
 *   node scripts/gen-license.mjs --type commercial --holder "PC shop" --bind-machine <machine_id>
 *
 * Private key: keys/license-private.pem (gitignored — backup offline!)
 * Public key embedded in src/services/licensePublicKey.js
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privPath = path.join(root, "keys", "license-private.pem");
const pubPath = path.join(root, "keys", "license-public.pem");

function parseArgs(argv) {
  const o = {
    type: "commercial",
    holder: "Customer",
    days: 365,
    maxAccounts: 0,
    maxPages: 0,
    machineId: "ANY",
    email: "",
    note: "",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--type") o.type = n;
    else if (a === "--holder") o.holder = n;
    else if (a === "--email") o.email = n;
    else if (a === "--days") o.days = Number(n);
    else if (a === "--max-accounts") o.maxAccounts = Number(n);
    else if (a === "--max-pages") o.maxPages = Number(n);
    else if (a === "--bind-machine") o.machineId = n;
    else if (a === "--note") o.note = n;
    else if (a === "--lifetime") {
      o.days = 0;
      o.type = "lifetime";
    }
  }
  return o;
}

function ensureKeys() {
  fs.mkdirSync(path.join(root, "keys"), { recursive: true });
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) return;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(
    privPath,
    privateKey.export({ type: "pkcs8", format: "pem" })
  );
  fs.writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));
  console.log("Created new keypair in keys/");
  console.log("→ Copy public key into src/services/licensePublicKey.js if new!");
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function main() {
  ensureKeys();
  const args = parseArgs(process.argv);
  const priv = fs.readFileSync(privPath, "utf8");

  const claims = {
    v: 1,
    type: args.type,
    holder: args.holder,
    email: args.email || undefined,
    note: args.note || undefined,
    max_accounts: args.maxAccounts,
    max_pages: args.maxPages,
    machine_id: args.machineId || "ANY",
    issued_at: new Date().toISOString(),
  };
  if (args.days > 0 && args.type !== "lifetime") {
    claims.expires_at = new Date(
      Date.now() + args.days * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  const payloadBuf = Buffer.from(JSON.stringify(claims), "utf8");
  const sig = crypto.sign(null, payloadBuf, priv);
  const key = `${b64url(payloadBuf)}.${b64url(sig)}`;

  const outDir = path.join(root, "keys", "issued");
  fs.mkdirSync(outDir, { recursive: true });
  const safe = String(args.holder).replace(/[^\w.-]+/g, "_").slice(0, 40);
  const outFile = path.join(
    outDir,
    `${args.type}_${safe}_${Date.now()}.txt`
  );
  const text = [
    "FB Page Studio — License Key",
    "============================",
    `Type:     ${claims.type}`,
    `Holder:   ${claims.holder}`,
    `Expires:  ${claims.expires_at || "never"}`,
    `Accounts: ${claims.max_accounts || "unlimited"}`,
    `Pages:    ${claims.max_pages || "unlimited"}`,
    `Machine:  ${claims.machine_id}`,
    "",
    "KEY (paste into app License page):",
    key,
    "",
  ].join("\n");
  fs.writeFileSync(outFile, text, "utf8");

  console.log(text);
  console.log("Saved:", outFile);
}

main();
