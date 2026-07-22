/**
 * Đồng bộ gói MÁY KHÁCH — KHÔNG ship secret quan trọng.
 *
 *   node scripts/sync-customer-pack.mjs
 *
 * Public ok: FB_APP_ID, redirect relay, OAUTH_RELAY=1
 * Không: FB_APP_SECRET, NGROK token, private license key, TOKEN hardcode yếu
 * Connect FB: secret chỉ trên oauth-relay (RELAY_EXCHANGE=1)
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PROJECT_ROOT as root, packCustomerDir, archiveVaultDir } from "./deliver-paths.mjs";
import { archiveOldInDir } from "./archive-old-builds.mjs";

const out = packCustomerDir();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const customerAssetName = `FB-Page-Studio-Desktop-v${pkg.version}.exe`;

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

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(out, "media-sample", "captions"), { recursive: true });

// Gom EXE/ZIP bản cũ → Luu-Tru-Ban-Cu (chỉ giữ bản package.json)
{
  const pruned = archiveOldInDir(out, { currentVersion: pkg.version });
  if (pruned.moved.length) {
    console.log(`[pack-customer] Đã gom bản cũ → ${archiveVaultDir()}`);
    for (const line of pruned.moved) console.log("  ", line);
  }
}

// Safety: never ship secrets that may have been copied in by mistake
const forbidden = [
  path.join(out, ".env"),
  path.join(out, "data"),
  path.join(out, "src"),
  path.join(out, "keys", "license-private.pem"),
  path.join(out, "desktop-startup.log"),
];
for (const p of forbidden) {
  if (fs.existsSync(p) && fs.statSync(p).isFile() && p.endsWith(".env")) {
    fs.unlinkSync(p);
    console.warn("Removed accidental .env from pack-customer");
  } else if (fs.existsSync(p) && !p.endsWith(".env")) {
    // leave dirs check for throw
  }
}
const unsafe = forbidden.filter((p) => fs.existsSync(p) && !p.endsWith(path.join("pack-customer", ".env")));
// re-check
const still = [
  path.join(out, "data"),
  path.join(out, "src"),
  path.join(out, "keys", "license-private.pem"),
  path.join(out, "desktop-startup.log"),
  path.join(out, ".env"),
].filter((p) => fs.existsSync(p));
if (still.length) {
  throw new Error(
    `Gói khách chứa dữ liệu cấm:\n${still.map((p) => ` - ${p}`).join("\n")}`
  );
}

const DEFAULT_CUSTOMER_RELAY =
  process.env.PACK_OAUTH_DOMAIN
    ? `https://${String(process.env.PACK_OAUTH_DOMAIN).replace(/^https?:\/\//, "").replace(/\/$/, "")}`
    : "https://modelswiki.top";

function pickCustomerRelayUrl() {
  const raw =
    srcEnv.OAUTH_RELAY_URL ||
    srcEnv.RELAY_PUBLIC_URL ||
    (() => {
      try {
        if (srcEnv.FB_REDIRECT_URI) {
          const u = new URL(srcEnv.FB_REDIRECT_URI);
          return `${u.protocol}//${u.host}`;
        }
      } catch {
        /* */
      }
      return "";
    })();
  const s = String(raw || "").trim().replace(/\/$/, "");
  if (!s || /ngrok|localhost|127\.0\.0\.1|example\.com/i.test(s)) {
    if (s && /ngrok/i.test(s)) {
      console.warn(`[pack-customer] Bo qua relay ngrok (${s}) → ${DEFAULT_CUSTOMER_RELAY}`);
    }
    return DEFAULT_CUSTOMER_RELAY;
  }
  return s;
}

const relayUrl = pickCustomerRelayUrl();
const redirect = `${String(relayUrl).replace(/\/$/, "")}/auth/facebook/callback`;
const appId = srcEnv.FB_APP_ID || "";

// Public-only .env for first run (NO SECRET)
const publicEnv = [
  "# GÓI KHÁCH — PUBLIC. Không chứa App Secret / Ngrok token.",
  "# Connect FB qua OAuth relay (secret chỉ trên server relay).",
  `# version=${pkg.version}`,
  "",
  "PORT=3847",
  "APP_BASE_URL=http://127.0.0.1:3847",
  "OAUTH_RELAY=1",
  "NGROK_AUTOSTART=0",
  "NGROK_AUTHTOKEN=",
  `OAUTH_RELAY_URL=${String(relayUrl).replace(/\/$/, "")}`,
  `FB_REDIRECT_URI=${redirect}`,
  `FB_APP_ID=${appId}`,
  "# FB_APP_SECRET=   ← KHÔNG ship. Relay RELAY_EXCHANGE=1 giữ secret.",
  "FB_APP_NAME=App 1",
  "FB_GRAPH_VERSION=v21.0",
  "FB_SCOPES=pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile",
  "# TOKEN_ENCRYPTION_KEY tự sinh lần đầu nếu trống (app first-run)",
  "TOKEN_ENCRYPTION_KEY=",
  `GITHUB_REPO=${pkg.githubRepo || "trumrename/fb-page-studio"}`,
  "",
].join("\n");

fs.writeFileSync(path.join(out, ".env.public"), publicEnv, "utf8");
fs.writeFileSync(path.join(out, ".env.example"), publicEnv, "utf8");

// VERSION
fs.writeFileSync(
  path.join(out, "VERSION.txt"),
  [
    `FB Page Studio — gói khách (không secret)`,
    `version=${pkg.version}`,
    `built_at=${new Date().toISOString()}`,
    `github=${pkg.githubRepo || ""}`,
    `asset=${customerAssetName}`,
    `setup=FB-Page-Studio-Setup-v${pkg.version}.exe`,
    `oauth_relay=1`,
    `app_id_set=${appId ? "yes" : "no"}`,
    ``,
  ].join("\n"),
  "utf8"
);

fs.writeFileSync(
  path.join(out, "README-KHACH.txt"),
  [
    "FB Page Studio — GÓI KHÁCH (an toàn)",
    "====================================",
    "",
    "CÁCH 1 — BẢN CÀI (khuyến nghị, ghim taskbar):",
    `  1) Chạy FB-Page-Studio-Setup-v${pkg.version}.exe`,
    "  2) Cài xong → Start Menu / Desktop: FB Page Studio",
    "  3) Chuột phải icon thanh taskbar → Ghim vào thanh tác vụ",
    "",
    "CÁCH 2 — Portable (không cài):",
    "  1) Copy EXE + .env.public",
    "  2) Đổi tên .env.public → .env (cạnh EXE)",
    "  3) Mở EXE → Connect Facebook",
    "",
    "KHÔNG cần Ngrok. KHÔNG cần App Secret trên máy bạn.",
    "Login Facebook qua domain relay của nhà cung cấp.",
    "",
    "Gói này KHÔNG chứa: FB_APP_SECRET, Ngrok token, license-private.pem",
    "",
    `version ${pkg.version}`,
    "",
  ].join("\n"),
  "utf8"
);

const exeCandidates = [
  path.join(root, "dist-desktop-oauth", "FB-Page-Studio-Desktop.exe"),
  path.join(root, "dist-desktop-oauth", customerAssetName),
  path.join(root, "FB-Page-Studio-App", customerAssetName),
];

let copiedExe = null;
for (const c of exeCandidates) {
  if (!fs.existsSync(c)) continue;
  // Xóa hết EXE/sha bản cũ — chỉ còn file version hiện tại
  for (const entry of fs.readdirSync(out)) {
    if (
      /^FB-Page-Studio-Desktop(?:-v\d+\.\d+\.\d+)?\.exe(?:\.(?:sha256\.txt|bak|old|new))?$/i.test(
        entry
      ) ||
      /^FB-Page-Studio\.exe$/i.test(entry) ||
      /^FB Page Studio\.exe$/i.test(entry) ||
      /^FB-Page-Studio-v\d+\.\d+\.\d+-Windows\.zip(?:\.sha256\.txt)?$/i.test(entry)
    ) {
      try {
        fs.unlinkSync(path.join(out, entry));
      } catch {
        /* */
      }
    }
  }
  const dest = path.join(out, customerAssetName);
  fs.copyFileSync(c, dest);
  copiedExe = dest;
  console.log("Copied exe:", c, "→", dest);
  break;
}
if (!copiedExe) {
  console.warn("⚠ Chưa có .exe — npm run build:desktop rồi sync lại.");
} else {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(copiedExe)).digest("hex");
  fs.writeFileSync(
    path.join(out, `${customerAssetName}.sha256.txt`),
    `${hash}  ${customerAssetName}\n`,
    "utf8"
  );
}

// Bản cài NSIS (icon + Start Menu + ghim taskbar) — nếu đã build
const setupName = `FB-Page-Studio-Setup-v${pkg.version}.exe`;
const setupSrc = [
  path.join(root, "dist-desktop-oauth", setupName),
  path.join(root, "dist-desktop-oauth", `FB Page Studio Setup ${pkg.version}.exe`),
].find((p) => fs.existsSync(p));
if (setupSrc) {
  for (const entry of fs.readdirSync(out)) {
    if (/^FB-Page-Studio-Setup-v\d+\.\d+\.\d+\.exe(?:\.sha256\.txt)?$/i.test(entry)) {
      try {
        fs.unlinkSync(path.join(out, entry));
      } catch {
        /* */
      }
    }
  }
  const setupDest = path.join(out, setupName);
  fs.copyFileSync(setupSrc, setupDest);
  const sh = crypto.createHash("sha256").update(fs.readFileSync(setupDest)).digest("hex");
  fs.writeFileSync(path.join(out, `${setupName}.sha256.txt`), `${sh}  ${setupName}\n`, "utf8");
  console.log("Copied Setup installer:", setupDest);
} else {
  console.warn("⚠ Chưa có Setup NSIS — chạy npm run build:desktop (nsis+portable)");
}

const cap = path.join(out, "media-sample", "captions", "captions.txt");
if (!fs.existsSync(cap)) {
  fs.writeFileSync(
    cap,
    "# Caption mẫu\nHello from FB Page Studio\n",
    "utf8"
  );
}

// Copy customer guide if present
const guide = path.join(root, "HUONG-DAN-OAUTH-RELAY.md");
if (fs.existsSync(guide)) {
  fs.copyFileSync(guide, path.join(out, "HUONG-DAN-OAUTH-RELAY.md"));
}

const files = fs
  .readdirSync(out)
  .filter((name) => !/\.(zip|7z|rar)$/i.test(name))
  .sort((a, b) => a.localeCompare(b));
fs.writeFileSync(
  path.join(out, "MANIFEST.txt"),
  [
    "Gói khách — không secret:",
    ...files.map((f) => ` - ${f}`),
    "",
    "CẤM trong gói khách: FB_APP_SECRET, NGROK_AUTHTOKEN, license-private.pem, data/app.db, .env đầy secret",
    "Connect: OAUTH_RELAY + relay RELAY_EXCHANGE=1",
    "",
  ].join("\n"),
  "utf8"
);

// Scan public files for accidental secrets
const secretPatterns = [
  /FB_APP_SECRET\s*=\s*[^\s#]+/,
  /NGROK_AUTHTOKEN\s*=\s*[^\s#]+/,
  /BEGIN PRIVATE KEY/,
];
for (const f of files) {
  const fp = path.join(out, f);
  if (!fs.statSync(fp).isFile()) continue;
  if (/\.(exe|png|jpg|zip)$/i.test(f)) continue;
  const text = fs.readFileSync(fp, "utf8");
  for (const re of secretPatterns) {
    if (re.test(text) && !text.includes("KHÔNG ship") && !text.includes("← KHÔNG")) {
      // allow commented empty
      const m = text.match(re);
      if (m && !/=\s*$/.test(m[0]) && !/=\s*#/.test(m[0])) {
        const val = m[0].split("=")[1]?.trim();
        if (val && val.length > 8 && !val.startsWith("←")) {
          throw new Error(`Phát hiện secret nghi ngờ trong pack-customer/${f}: ${m[0].slice(0, 40)}`);
        }
      }
    }
  }
}

console.log("pack-customer (an toàn) sẵn sàng:", out);
console.log("version", pkg.version, "| App ID", appId ? "có" : "THIẾU — điền FB_APP_ID trên máy admin trước khi sync");
