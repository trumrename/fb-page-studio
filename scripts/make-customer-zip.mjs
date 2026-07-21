/**
 * Tạo ZIP máy khách từ pack-customer (không secret).
 *   node scripts/make-customer-zip.mjs
 * Output: pack-customer/FB-Page-Studio-vX.Y.Z-Windows.zip
 *          release-assets/ (cùng file, cho GH upload)
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { PROJECT_ROOT as root, packCustomerDir, releaseAssetsDir, archiveVaultDir } from "./deliver-paths.mjs";
import { archiveOldInDir } from "./archive-old-builds.mjs";

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const packDir = packCustomerDir();
const zipName = `FB-Page-Studio-v${version}-Windows.zip`;
const zipOut = path.join(packDir, zipName);
const releaseDir = releaseAssetsDir();
const releaseZip = path.join(releaseDir, zipName);

const exeName = `FB-Page-Studio-Desktop-v${version}.exe`;
const exePath = path.join(packDir, exeName);
if (!fs.existsSync(exePath)) {
  throw new Error(`Thiếu ${exeName} — chạy npm run pack:customer trước`);
}

// Safety: no secrets inside pack
const forbidden = [".env", "data", "src", "keys", "license-private.pem", "app.db"];
for (const name of forbidden) {
  const p = path.join(packDir, name);
  if (fs.existsSync(p)) {
    throw new Error(`Gói khách còn file cấm trước khi zip: ${p}`);
  }
}

// Gom ZIP/EXE bản cũ trong pack-customer + release-assets → 1 ổ
archiveOldInDir(packDir, { currentVersion: version });
fs.mkdirSync(releaseDir, { recursive: true });
archiveOldInDir(releaseDir, { currentVersion: version });
console.log("Archive vault (bản cũ):", archiveVaultDir());

// Prefer PowerShell Compress-Archive (Windows)
const ps = `
$ErrorActionPreference = 'Stop'
$src = '${packDir.replace(/'/g, "''")}'
$dest = '${zipOut.replace(/'/g, "''")}'
if (Test-Path $dest) { Remove-Item -LiteralPath $dest -Force }
$items = Get-ChildItem -LiteralPath $src -Force | Where-Object { $_.Name -notmatch '\\.zip$' }
Compress-Archive -Path ($items.FullName) -DestinationPath $dest -CompressionLevel Optimal -Force
`;
const r = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
  { encoding: "utf8", windowsHide: true }
);
if (r.status !== 0) {
  throw new Error(`Zip failed: ${r.stderr || r.stdout || r.status}`);
}
if (!fs.existsSync(zipOut)) throw new Error("Zip không tạo được: " + zipOut);

fs.copyFileSync(zipOut, releaseZip);
// Also copy versioned EXE + sha into release-assets
const shaSrc = path.join(packDir, `${exeName}.sha256.txt`);
fs.copyFileSync(exePath, path.join(releaseDir, exeName));
if (fs.existsSync(shaSrc)) {
  fs.copyFileSync(shaSrc, path.join(releaseDir, `${exeName}.sha256.txt`));
}

const hash = crypto.createHash("sha256").update(fs.readFileSync(zipOut)).digest("hex");
fs.writeFileSync(
  path.join(releaseDir, `${zipName}.sha256.txt`),
  `${hash}  ${zipName}\n`,
  "utf8"
);

console.log("Customer ZIP:", zipOut);
console.log("Release copy:", releaseZip);
console.log("ZIP SHA-256:", hash);
console.log("size_mb:", (fs.statSync(zipOut).size / (1024 * 1024)).toFixed(1));
