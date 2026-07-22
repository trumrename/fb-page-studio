/**
 * Đồng bộ gói DEV (máy admin/lập trình) — không ship khách.
 *   node scripts/sync-dev-pack.mjs
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PROJECT_ROOT as root, packDevDir } from "./deliver-paths.mjs";

const out = packDevDir();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

fs.mkdirSync(out, { recursive: true });

const ver = pkg.version;
const versionedName = `FB-Page-Studio-Desktop-v${ver}.exe`;
const exeSrc =
  [
    path.join(root, "dist-desktop-oauth", "FB-Page-Studio-Desktop.exe"),
    path.join(root, "dist-desktop-oauth", versionedName),
  ].find((p) => fs.existsSync(p)) || null;

// Chỉ giữ 1 EXE bản mới (versioned) — xóa Desktop.exe / v cũ
for (const entry of fs.readdirSync(out)) {
  if (/^FB-Page-Studio(?:-Desktop)?(?:-v\d+\.\d+\.\d+)?\.exe(?:\.sha256\.txt)?$/i.test(entry) ||
      /^FB Page Studio\.exe$/i.test(entry)) {
    try {
      fs.unlinkSync(path.join(out, entry));
    } catch {
      /* locked */
    }
  }
}

if (exeSrc) {
  const exeDest = path.join(out, versionedName);
  fs.copyFileSync(exeSrc, exeDest);
  // Stable alias for scripts that still expect unversioned name
  fs.copyFileSync(exeSrc, path.join(out, "FB-Page-Studio-Desktop.exe"));
  const hash = crypto.createHash("sha256").update(fs.readFileSync(exeDest)).digest("hex");
  fs.writeFileSync(
    path.join(out, `${versionedName}.sha256.txt`),
    `${hash}  ${versionedName}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(out, "FB-Page-Studio-Desktop.exe.sha256.txt"),
    `${hash}  FB-Page-Studio-Desktop.exe\n`,
    "utf8"
  );
  console.log("Copied DEV exe", exeSrc, "→", versionedName, "+ Desktop.exe alias");
} else {
  console.warn("⚠ Chưa có dist-desktop-oauth EXE — chạy npm run build:desktop trước");
}

const setupName = `FB-Page-Studio-Setup-v${ver}.exe`;
const setupSrc = path.join(root, "dist-desktop-oauth", setupName);
if (fs.existsSync(setupSrc)) {
  for (const entry of fs.readdirSync(out)) {
    if (/^FB-Page-Studio-Setup/i.test(entry)) {
      try {
        fs.unlinkSync(path.join(out, entry));
      } catch {
        /* */
      }
    }
  }
  fs.copyFileSync(setupSrc, path.join(out, setupName));
  const sh = crypto.createHash("sha256").update(fs.readFileSync(setupSrc)).digest("hex");
  fs.writeFileSync(path.join(out, `${setupName}.sha256.txt`), `${sh}  ${setupName}\n`, "utf8");
  console.log("Copied DEV Setup:", setupName);
}

// Shortcut docs (re-write so pack-dev stays current)
fs.writeFileSync(
  path.join(out, "VERSION.txt"),
  [
    `FB Page Studio — gói DEV`,
    `version=${pkg.version}`,
    `built_at=${new Date().toISOString()}`,
    `github=${pkg.githubRepo || ""}`,
    `root=${root}`,
    ``,
  ].join("\n"),
  "utf8"
);

// Keep helper BAT if missing
const bat = path.join(out, "CHAY-NGROK-DOMAIN-CO-DINH.bat");
if (!fs.existsSync(bat)) {
  fs.writeFileSync(
    bat,
    [
      "@echo off",
      "chcp 65001 >nul",
      "echo Ngrok da tich hop trong EXE. Mo app → Kết nối Meta → dán token.",
      "echo Domain: qgroup.ngrok.app",
      "pause",
      "",
    ].join("\r\n"),
    "utf8"
  );
}

const files = fs.readdirSync(out).sort((a, b) => a.localeCompare(b));
fs.writeFileSync(
  path.join(out, "MANIFEST-DEV.txt"),
  [
    "Gói DEV (máy admin) — KHÔNG zip gửi khách:",
    ...files.map((f) => ` - ${f}`),
    "",
    "Source / keys / data thật nằm ở project root, không copy full secret vào đây.",
    "Admin cấp key: Tổng Hợp Tool\\Admin-Quan-Ly\\MENU-ADMIN.bat",
    "Lưu trữ bản cũ: Luu-Tru-Ban-Cu\\",
    "",
  ].join("\n"),
  "utf8"
);

console.log("pack-dev sẵn sàng:", out);
