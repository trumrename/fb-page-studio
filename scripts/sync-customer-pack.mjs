/**
 * Đồng bộ gói MÁY KHÁCH từ build mới nhất (chạy trên máy DEV).
 *
 *   node scripts/sync-customer-pack.mjs
 *
 * Copy:
 *  - FB-Page-Studio-Desktop.exe (nếu có)
 *  - .env.example, README-KHACH, VERSION
 * Không copy: .env secret, private key, data/, source
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "pack-customer");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const exeCandidates = [
  path.join(root, "dist-desktop-oauth", "FB-Page-Studio-Desktop.exe"),
  path.join(root, "dist-desktop", "FB-Page-Studio-Desktop.exe"),
  path.join(root, "FB-Page-Studio-App", "FB-Page-Studio-Desktop.exe"),
  path.join(root, "dist", "FB-Page-Studio.exe"),
];

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(out, "media-sample", "captions"), { recursive: true });

// Never declare a customer pack ready while it contains local credentials,
// tokens, databases, logs, private keys, or source code.
const forbidden = [
  path.join(out, ".env"),
  path.join(out, "data"),
  path.join(out, "src"),
  path.join(out, "keys", "license-private.pem"),
  path.join(out, "desktop-startup.log"),
];
const unsafe = forbidden.filter((p) => fs.existsSync(p));
if (unsafe.length) {
  throw new Error(
    `Gói khách chứa dữ liệu riêng, dừng sync:\n${unsafe.map((p) => ` - ${p}`).join("\n")}\n` +
      "Di chuyển chúng về gói DEV trước khi build khách."
  );
}

// VERSION
fs.writeFileSync(
  path.join(out, "VERSION.txt"),
  [
    `FB Page Studio — gói khách`,
    `version=${pkg.version}`,
    `built_at=${new Date().toISOString()}`,
    `github=${pkg.githubRepo || ""}`,
    `asset=${pkg.updateAsset || "FB-Page-Studio-Desktop.exe"}`,
    ``,
  ].join("\n"),
  "utf8"
);

// Ensure readme + env example exist (don't wipe custom README if already written)
const readmeSrc = path.join(out, "README-KHACH.txt");
if (!fs.existsSync(readmeSrc)) {
  console.warn("Missing README-KHACH.txt — create pack-customer first");
}

const envEx = path.join(root, "pack-customer", ".env.example");
// Customer template is maintained separately because it contains the official
// domain/repository defaults. Never overwrite it with the generic DEV sample.

let copiedExe = null;
for (const c of exeCandidates) {
  if (fs.existsSync(c)) {
    const dest = path.join(out, path.basename(c));
    fs.copyFileSync(c, dest);
    copiedExe = dest;
    console.log("Copied exe:", c, "→", dest);
    break;
  }
}
if (!copiedExe) {
  console.warn(
    "⚠ Chưa có file .exe build. Chạy: npm run build:desktop rồi sync lại."
  );
}

// Sample captions (harmless)
const cap = path.join(out, "media-sample", "captions", "captions.txt");
if (!fs.existsSync(cap)) {
  fs.writeFileSync(
    cap,
    "# Caption mẫu — copy vào data/media/captions sau khi chạy app\nHello from FB Page Studio\n",
    "utf8"
  );
}

// MANIFEST an toàn
// Do not advertise stale/nested archives that a user may have copied into
// pack-customer. Release ZIPs must be built from the safe delivery files only.
const files = fs.readdirSync(out)
  .filter((name) => !/\.(zip|7z|rar)$/i.test(name))
  .sort((a, b) => a.localeCompare(b));
fs.writeFileSync(
  path.join(out, "MANIFEST.txt"),
  [
    "Nội dung gói khách (không secret):",
    ...files.map((f) => ` - ${f}`),
    "",
    "CẤM có trong gói khách: license-private.pem, .env có secret, data/app.db token, source src/",
    "",
  ].join("\n"),
  "utf8"
);

console.log("pack-customer sẵn sàng:", out);
console.log("version", pkg.version);
console.log("→ Zip folder pack-customer gửi khách (sau khi có .exe).");
