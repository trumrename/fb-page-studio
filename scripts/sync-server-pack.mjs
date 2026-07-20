/**
 * Gói SERVER gọn — copy file PowerShell THẬT (không nhúng $ vào JS).
 *   node scripts/sync-server-pack.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "pack-server");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function rimraf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
function writeBat(dest, lines) {
  fs.writeFileSync(dest, lines.join("\r\n") + "\r\n", "utf8");
}

rimraf(out);
fs.mkdirSync(path.join(out, "oauth-relay"), { recursive: true });

copyFile(
  path.join(root, "oauth-relay", "server.mjs"),
  path.join(out, "oauth-relay", "server.mjs")
);

const envExample = `# Máy SERVER — OAuth Relay (CÓ SECRET sau khi CAI)
# Domain: modelswiki.top

PORT=8080
LISTEN_HOST=127.0.0.1

RELAY_PUBLIC_URL=https://modelswiki.top
FB_REDIRECT_URI=https://modelswiki.top/auth/facebook/callback

RELAY_EXCHANGE=1
FB_APP_ID=
FB_APP_SECRET=

FB_GRAPH_VERSION=v21.0
DEFAULT_LOCAL_PORT=3847
`;
fs.writeFileSync(path.join(out, "oauth-relay", ".env.example"), envExample, "utf8");

// PowerShell installer — file thật, không template JS
copyFile(
  path.join(root, "server-setup", "install-pack-server.ps1"),
  path.join(out, "install-server.ps1")
);

writeBat(path.join(out, "CAI-MAY-SERVER.bat"), [
  "@echo off",
  "chcp 65001 >nul",
  'cd /d "%~dp0"',
  "title Cai may SERVER - pack-server",
  "echo.",
  "echo  Goi SERVER gon - OAuth Relay + Cloudflare Tunnel",
  "echo  Domain: modelswiki.top",
  "echo  Nen: Run as administrator",
  "echo.",
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-server.ps1"',
  "if errorlevel 1 echo.",
  "pause",
]);

writeBat(path.join(out, "CHAY-SERVER-TAT-CA.bat"), [
  "@echo off",
  "chcp 65001 >nul",
  "setlocal",
  'cd /d "%~dp0"',
  "title FB OAuth SERVER",
  "echo.",
  "echo  Domain: https://modelswiki.top",
  "echo.",
  'if not exist "oauth-relay\\server.mjs" (',
  "  echo [LOI] Thieu oauth-relay\\server.mjs - copy thieu folder!",
  "  pause",
  "  exit /b 1",
  ")",
  'if not exist "oauth-relay\\.env" (',
  "  echo [LOI] Chua co oauth-relay\\.env",
  "  echo Chay CAI-MAY-SERVER.bat truoc.",
  "  pause",
  "  exit /b 1",
  ")",
  "echo [1/2] OAuth Relay...",
  'start "OAuth-Relay" cmd /k "cd /d %~dp0 && node oauth-relay\\server.mjs"',
  "timeout /t 2 /nobreak >nul",
  "where cloudflared >nul 2>&1",
  "if errorlevel 1 (",
  "  echo [CANH BAO] Chua cloudflared - chi chay relay local.",
  "  echo Cai: winget install Cloudflare.cloudflared",
  "  pause",
  "  exit /b 0",
  ")",
  "echo [2/2] Cloudflare Tunnel...",
  'start "Cloudflare-Tunnel" cmd /k "cloudflared tunnel run fb-oauth-relay"',
  "echo.",
  "echo Kiem tra: https://modelswiki.top/health",
  "echo Meta: https://modelswiki.top/auth/facebook/callback",
  "pause",
]);

writeBat(path.join(out, "CHAY-RELAY-ONLY.bat"), [
  "@echo off",
  "chcp 65001 >nul",
  'cd /d "%~dp0"',
  'if not exist "oauth-relay\\.env" (echo Thieu oauth-relay\\.env & pause & exit /b 1)',
  "node oauth-relay\\server.mjs",
  "pause",
]);

// Fix cert.pem when cloudflared login cannot write cert
copyFile(
  path.join(root, "server-setup", "FIX-CLOUDFLARE-CERT.ps1"),
  path.join(out, "FIX-CLOUDFLARE-CERT.ps1")
);
writeBat(path.join(out, "FIX-CLOUDFLARE-CERT.bat"), [
  "@echo off",
  "chcp 65001 >nul",
  'cd /d "%~dp0"',
  "echo Fix missing cert.pem after Cloudflare login...",
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0FIX-CLOUDFLARE-CERT.ps1"',
  "pause",
]);

fs.writeFileSync(
  path.join(out, "README.txt"),
  [
    "GOI SERVER GON - OAuth Relay",
    "==============================",
    "Domain: https://modelswiki.top",
    "",
    "BAT BUOC - phai co du:",
    "  pack-server\\",
    "    CAI-MAY-SERVER.bat",
    "    CHAY-SERVER-TAT-CA.bat",
    "    install-server.ps1",
    "    oauth-relay\\",
    "      server.mjs          <-- THIEU FILE NAY = loi ban gap",
    "      .env.example",
    "",
    "Cach copy DUNG:",
    "  - Copy ca folder pack-server (keo ca thu muc oauth-relay)",
    "  - HOAC dung zip: FB-Page-Studio-pack-server.zip",
    "    Giai nen -> vao pack-server -> chay CAI-MAY-SERVER.bat",
    "",
    "CAI 1 LAN:",
    "  1. Giai nen / copy pack-server sang may server",
    "  2. Vao BEN TRONG folder pack-server",
    "  3. Cai Node.js LTS neu chua: https://nodejs.org",
    "  4. Chuot phai CAI-MAY-SERVER.bat -> Run as administrator",
    "  5. Dien FB_APP_ID + FB_APP_SECRET",
    "  6. Login Cloudflare (chon chainityai.com)",
    "",
    "HANG NGAY: CHAY-SERVER-TAT-CA.bat",
    "",
    "Kiem tra: https://modelswiki.top/health",
    "Meta Redirect:",
    "  https://modelswiki.top/auth/facebook/callback",
    "",
    "Tool EXE: copy them pack-internal (rieng).",
    "version: " + pkg.version,
    "built: " + new Date().toISOString(),
    "",
  ].join("\n"),
  "utf8"
);

fs.writeFileSync(
  path.join(out, "VERSION.txt"),
  `pack=server-only\nversion=${pkg.version}\ndomain=modelswiki.top\nbuilt_at=${new Date().toISOString()}\n`,
  "utf8"
);

const files = [];
function walk(d, prefix = "") {
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(p).isDirectory()) walk(p, rel);
    else files.push(rel);
  }
}
walk(out);
fs.writeFileSync(
  path.join(out, "MANIFEST.txt"),
  ["pack-server:", ...files.sort().map((f) => ` - ${f}`), ""].join("\n"),
  "utf8"
);

const gi = path.join(root, ".gitignore");
let giText = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
if (!giText.includes("pack-server/")) {
  fs.appendFileSync(gi, "\npack-server/\n");
}

// Sanity: install-server.ps1 must not be empty / broken
const ps1 = fs.readFileSync(path.join(out, "install-server.ps1"), "utf8");
if (!ps1.includes("Write-Step") || ps1.includes("$envBody = @")) {
  // allow either style
}
if (ps1.length < 500) {
  throw new Error("install-server.ps1 qua ngan / loi");
}
// Ensure no accidental JS leftover
if (ps1.includes("${") && ps1.includes("import ")) {
  throw new Error("install-server.ps1 bi nhung JS");
}

console.log("pack-server san sang:", out);
console.log("Files:", files.length);
console.log("Copy ca folder pack-server sang may treo.");
