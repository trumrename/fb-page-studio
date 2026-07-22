/** Create versioned portable + setup (NSIS) assets for GitHub release. */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { archiveOldInDir } from "./archive-old-builds.mjs";
import { archiveVaultDir, releaseAssetsDir } from "./deliver-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const distDir = path.join(root, "dist-desktop-oauth");
const releaseDir = releaseAssetsDir();
const source = path.join(distDir, "FB-Page-Studio-Desktop.exe");
const versionedName = `FB-Page-Studio-Desktop-v${pkg.version}.exe`;
const setupName = `FB-Page-Studio-Setup-v${pkg.version}.exe`;
const target = path.join(distDir, versionedName);
const checksumFile = `${target}.sha256.txt`;

function shaOf(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

if (!fs.existsSync(source)) throw new Error(`Chưa có portable EXE: ${source}`);
fs.copyFileSync(source, target);
const digest = shaOf(target);
fs.writeFileSync(checksumFile, `${digest}  ${versionedName}\n`, "utf8");

// NSIS setup (icon + Start Menu + pin taskbar)
const setupCandidates = [
  path.join(distDir, setupName),
  path.join(distDir, `FB Page Studio Setup ${pkg.version}.exe`),
  path.join(distDir, `FB-Page-Studio-Setup-${pkg.version}.exe`),
];
let setupSrc = setupCandidates.find((p) => fs.existsSync(p));
// electron-builder may use productName pattern
if (!setupSrc) {
  const found = fs
    .readdirSync(distDir)
    .find(
      (n) =>
        /\.exe$/i.test(n) &&
        /setup/i.test(n) &&
        n.includes(pkg.version) &&
        !/Desktop/i.test(n)
    );
  if (found) setupSrc = path.join(distDir, found);
}
if (setupSrc) {
  const setupDest = path.join(distDir, setupName);
  if (path.resolve(setupSrc) !== path.resolve(setupDest)) {
    fs.copyFileSync(setupSrc, setupDest);
  }
  const setupHash = shaOf(setupDest);
  fs.writeFileSync(`${setupDest}.sha256.txt`, `${setupHash}  ${setupName}\n`, "utf8");
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(setupDest, path.join(releaseDir, setupName));
  fs.copyFileSync(`${setupDest}.sha256.txt`, path.join(releaseDir, `${setupName}.sha256.txt`));
  console.log(`Setup installer: ${setupDest}`);
  console.log(`Setup SHA-256: ${setupHash}`);
} else {
  console.warn("⚠ Chưa thấy NSIS Setup EXE — kiểm tra electron-builder nsis target");
}

// dist-desktop-oauth: giữ Desktop.exe + vCURRENT + Setup; bản v cũ → vault
const pruned = archiveOldInDir(distDir, { currentVersion: pkg.version });
if (pruned.moved.length) {
  console.log(`Old dist assets → ${archiveVaultDir()}`);
  for (const line of pruned.moved) console.log(" ", line);
}

console.log(`Release portable: ${target}`);
console.log(`SHA-256: ${digest}`);
