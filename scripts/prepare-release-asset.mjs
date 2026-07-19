/** Create a clearly versioned GitHub asset from the verified portable build. */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const source = path.join(root, "dist-desktop-oauth", "FB-Page-Studio-Desktop.exe");
const versionedName = `FB-Page-Studio-Desktop-v${pkg.version}.exe`;
const target = path.join(root, "dist-desktop-oauth", versionedName);
const checksumFile = `${target}.sha256.txt`;

if (!fs.existsSync(source)) throw new Error(`Chưa có EXE build: ${source}`);
fs.copyFileSync(source, target);
const digest = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
fs.writeFileSync(checksumFile, `${digest}  ${versionedName}\n`, "utf8");
console.log(`Release asset: ${target}`);
console.log(`SHA-256: ${digest}`);
