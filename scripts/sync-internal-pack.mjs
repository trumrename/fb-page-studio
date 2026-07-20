/**
 * Gói NỘI BỘ tin cậy — cấu hình sẵn, CÓ secret (không public lung tung).
 *   node scripts/sync-internal-pack.mjs
 *
 * Nguồn secret: project .env (máy admin) — không commit pack-internal/.env
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "pack-internal");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const ver = pkg.version;
const exeName = `FB-Page-Studio-Desktop-v${ver}.exe`;

fs.mkdirSync(out, { recursive: true });

function readEnvFile(p) {
  const map = {};
  if (!fs.existsSync(p)) return map;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    map[m[1]] = v;
  }
  return map;
}

const srcEnv = {
  ...readEnvFile(path.join(root, ".env")),
  ...readEnvFile(path.join(root, "FB-Page-Studio-App", ".env")),
};

// Domain OAuth chung (khớp pack-server / relay). Ghi đè: PACK_OAUTH_DOMAIN=oauth.xxx.com
const DEFAULT_OAUTH_HOST =
  process.env.PACK_OAUTH_DOMAIN || "modelswiki.top";

function hostFromUrl(raw) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.toLowerCase();
  } catch {
    return "";
  }
}

let relayHost = hostFromUrl(
  srcEnv.OAUTH_RELAY_URL || srcEnv.RELAY_PUBLIC_URL || srcEnv.FB_REDIRECT_URI || ""
);
// Dev .env may still use ngrok — pack nội bộ mặc định domain chính thức
if (
  !relayHost ||
  relayHost.includes("ngrok") ||
  relayHost === "localhost" ||
  relayHost === "127.0.0.1"
) {
  if (relayHost && relayHost.includes("ngrok")) {
    console.warn(
      `[pack-internal] Bo qua redirect ngrok (${relayHost}) → dung ${DEFAULT_OAUTH_HOST}`
    );
  }
  relayHost = DEFAULT_OAUTH_HOST;
}

const relayUrl = `https://${relayHost}`;
const redirect = `${relayUrl}/auth/facebook/callback`;

const lines = [
  "# GÓI NỘI BỘ — TIN CẬY — CÓ SECRET. Không gửi ra ngoài / không public repo.",
  `# version=${ver} built=${new Date().toISOString()}`,
  "",
  "PORT=3847",
  "APP_BASE_URL=http://127.0.0.1:3847",
  "OAUTH_RELAY=1",
  "NGROK_AUTOSTART=0",
  "NGROK_AUTHTOKEN=",
  `OAUTH_RELAY_URL=${relayUrl.replace(/\/$/, "")}`,
  `FB_REDIRECT_URI=${redirect}`,
  `FB_APP_ID=${srcEnv.FB_APP_ID || ""}`,
  `FB_APP_SECRET=${srcEnv.FB_APP_SECRET || ""}`,
  `FB_APP_NAME=${srcEnv.FB_APP_NAME || "App 1"}`,
  srcEnv.FB_APP_ID_2 ? `FB_APP_ID_2=${srcEnv.FB_APP_ID_2}` : "# FB_APP_ID_2=",
  srcEnv.FB_APP_SECRET_2 ? `FB_APP_SECRET_2=${srcEnv.FB_APP_SECRET_2}` : "# FB_APP_SECRET_2=",
  `FB_GRAPH_VERSION=${srcEnv.FB_GRAPH_VERSION || "v21.0"}`,
  `FB_SCOPES=${srcEnv.FB_SCOPES || "pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile"}`,
  `TOKEN_ENCRYPTION_KEY=${srcEnv.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex")}`,
  `GITHUB_REPO=${srcEnv.GITHUB_REPO || pkg.githubRepo || "trumrename/fb-page-studio"}`,
  "",
];
fs.writeFileSync(path.join(out, ".env"), lines.join("\n"), "utf8");

// Copy EXE if present
const exeSrc = [
  path.join(root, "dist-desktop-oauth", "FB-Page-Studio-Desktop.exe"),
  path.join(root, "dist-desktop-oauth", exeName),
  path.join(root, "pack-customer", exeName),
].find((p) => fs.existsSync(p));

if (exeSrc) {
  const dest = path.join(out, exeName);
  fs.copyFileSync(exeSrc, dest);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
  fs.writeFileSync(path.join(out, `${exeName}.sha256.txt`), `${hash}  ${exeName}\n`);
  console.log("EXE →", dest);
} else {
  console.warn("⚠ Chưa có EXE — chạy npm run build:desktop rồi sync lại");
}

fs.writeFileSync(
  path.join(out, "README-NOI-BO.txt"),
  [
    "GOI NOI BO - TIN CAY",
    "====================",
    "- Da nhung .env (CO App Secret) - chi may tin cay.",
    "- OAUTH_RELAY=1 - Connect FB khong Ngrok (can may server pack-server).",
    "- Mo EXE -> Connect Facebook. Folder anh local.",
    "- KHONG public, KHONG dua khach ngoai, KHONG commit git.",
    "",
    "Can co may server (pack-server) dang chay khi Connect:",
    "  CHAY-SERVER-TAT-CA.bat",
    "",
    `version=${ver}`,
    `relay=${relayUrl}`,
    `redirect=${redirect}`,
    "",
    "Meta Redirect URI phai dung:",
    `  ${redirect}`,
    "",
  ].join("\n"),
  "utf8"
);

fs.writeFileSync(
  path.join(out, "VERSION.txt"),
  `pack=internal\nversion=${ver}\nbuilt_at=${new Date().toISOString()}\n`,
  "utf8"
);

fs.writeFileSync(
  path.join(out, "MANIFEST.txt"),
  [
    "Nội dung pack-internal (CÓ SECRET):",
    ...fs.readdirSync(out).sort().map((f) => ` - ${f}`),
    "",
    "CẤM: public GitHub Release, gửi khách ngoài, share Zalo lung tung.",
    "",
  ].join("\n"),
  "utf8"
);

// Ensure gitignore
const gi = path.join(root, ".gitignore");
let giText = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
if (!giText.includes("pack-internal/")) {
  fs.appendFileSync(gi, "\n# Gói nội bộ có secret\npack-internal/\npack-internal/**\n");
}

console.log("pack-internal sẵn sàng:", out);
console.log("⚠ File .env trong pack-internal CÓ SECRET — chỉ máy tin cậy.");
