/** Create a clearly versioned GitHub asset from the verified portable build. */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { archiveOldInDir } from "./archive-old-builds.mjs";
import { archiveVaultDir } from "./deliver-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const distDir = path.join(root, "dist-desktop-oauth");
const source = path.join(distDir, "FB-Page-Studio-Desktop.exe");
const versionedName = `FB-Page-Studio-Desktop-v${pkg.version}.exe`;
const target = path.join(distDir, versionedName);
const checksumFile = `${target}.sha256.txt`;

if (!fs.existsSync(source)) throw new Error(`Chưa có EXE build: ${source}`);
fs.copyFileSync(source, target);
const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
fs.writeFileSync(checksumFile, `${digest}  ${versionedName}\n`, "utf8");

// dist-desktop-oauth: giữ Desktop.exe + vCURRENT; bản v cũ → Luu-Tru-Ban-Cu
const pruned = archiveOldInDir(distDir, { currentVersion: pkg.version });
if (pruned.moved.length) {
  console.log(`Old dist assets → ${archiveVaultDir()}`);
  for (const line of pruned.moved) console.log(" ", line);
}

console.log(`Release asset: ${target}`);
console.log(`SHA-256: ${digest}`);
