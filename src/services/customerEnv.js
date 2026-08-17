/**
 * Canonical customer install env (Setup + portable pack).
 * OAuth ONLY via official relay: https://modelswiki.top
 * Old domains (ngrok / videoviral / qgroup / handcraft / localhost public) are purged.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getBundleRoot, getEnvPath, isPackaged } from "../paths.js";

/** Chỉ domain OAuth chính thức — không fallback domain cũ */
export const DEFAULT_OAUTH_RELAY_URL = "https://modelswiki.top";
export const DEFAULT_FB_REDIRECT_URI = `${DEFAULT_OAUTH_RELAY_URL}/auth/facebook/callback`;
export const DEFAULT_OAUTH_HOST = "modelswiki.top";

/**
 * Hosts / patterns from the pre-server era. Never use for Facebook OAuth.
 * (ngrok free/paid, videoviral1, handcraft tunnel, qgroup, etc.)
 */
export const LEGACY_OAUTH_HOST_RE =
  /ngrok|videoviral|chainityai|handcraft|qgroup|loca\.lt|serveo|trycloudflare|pagekite|cloudflared\.com|sslip\.io|nip\.io/i;

/**
 * KHÔNG hardcode App ID trong bản phát hành.
 * Máy khách tự điền trong UI (Cấu hình lần đầu) hoặc nhận từ relay /api/apps.
 */
export const DEFAULT_CUSTOMER_APP_ID = "";

export function hostnameOfUrl(raw) {
  try {
    const s = String(raw || "").trim();
    if (!s) return "";
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return String(u.hostname || "")
      .trim()
      .toLowerCase();
  } catch {
    return String(raw || "")
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .split(":")[0]
      .trim()
      .toLowerCase();
  }
}

/** True if host/URL is an obsolete pre-server OAuth endpoint */
export function isLegacyOauthHost(raw) {
  const host = hostnameOfUrl(raw);
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return true;
  return LEGACY_OAUTH_HOST_RE.test(host);
}

/** True if redirect_uri must be rewritten to official relay */
export function isBrokenOrLegacyRedirect(raw) {
  const s = String(raw || "").trim();
  if (!s) return true;
  if (/^http:\/\//i.test(s)) return true; // Facebook Live needs HTTPS public
  if (isLegacyOauthHost(s)) return true;
  try {
    const u = new URL(s);
    if (!/\/auth\/facebook\/callback$/i.test(u.pathname.replace(/\/+$/, "") || "")) {
      // bare origin without callback path is ok if host is official — normalize elsewhere
    }
  } catch {
    return true;
  }
  return false;
}

/** Reject legacy when picking a public relay URL for packs / sync */
export function sanitizeRelayBase(raw, fallback = DEFAULT_OAUTH_RELAY_URL) {
  const s = String(raw || "")
    .trim()
    .replace(/\/$/, "");
  if (!s || isLegacyOauthHost(s)) return fallback.replace(/\/$/, "");
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (isLegacyOauthHost(u.hostname)) return fallback.replace(/\/$/, "");
    return `${u.protocol}//${u.host}`;
  } catch {
    return fallback.replace(/\/$/, "");
  }
}

/** Bundled template locations (asar / resources / pack). */
export function customerDefaultEnvCandidates() {
  const root = getBundleRoot();
  const list = [
    path.join(root, "build", "customer-default.env"),
    path.join(root, "customer-default.env"),
    path.join(root, ".env.public"),
    process.resourcesPath
      ? path.join(process.resourcesPath, "customer-default.env")
      : null,
    process.resourcesPath
      ? path.join(process.resourcesPath, "app.asar.unpacked", "build", "customer-default.env")
      : null,
  ].filter(Boolean);
  return list;
}

export function readCustomerDefaultEnvText() {
  for (const p of customerDefaultEnvCandidates()) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return fs.readFileSync(p, "utf8");
      }
    } catch {
      /* try next */
    }
  }
  return [
    "PORT=3847",
    "APP_BASE_URL=http://127.0.0.1:3847",
    "OAUTH_RELAY=1",
    "NGROK_AUTOSTART=0",
    "NGROK_AUTHTOKEN=",
    `OAUTH_RELAY_URL=${DEFAULT_OAUTH_RELAY_URL}`,
    `FB_REDIRECT_URI=${DEFAULT_FB_REDIRECT_URI}`,
    `FB_APP_ID=${DEFAULT_CUSTOMER_APP_ID}`,
    "FB_APP_NAME=App 1",
    "FB_GRAPH_VERSION=v21.0",
    "FB_SCOPES=pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,pages_manage_metadata,pages_read_user_content,business_management,read_insights,public_profile",
    "TOKEN_ENCRYPTION_KEY=",
    "GITHUB_REPO=trumrename/fb-page-studio",
    "UPDATE_ASSET=FB-Page-Studio-Desktop.exe",
    "",
  ].join("\n");
}

function ensureEncryptionKey(text) {
  let out = String(text || "");
  if (!/^TOKEN_ENCRYPTION_KEY=\s*\S+/m.test(out)) {
    const key = crypto.randomBytes(32).toString("hex");
    if (/^TOKEN_ENCRYPTION_KEY=/m.test(out)) {
      out = out.replace(/^TOKEN_ENCRYPTION_KEY=.*$/m, `TOKEN_ENCRYPTION_KEY=${key}`);
    } else {
      out += `\nTOKEN_ENCRYPTION_KEY=${key}\n`;
    }
  }
  return out;
}

function patchEnvText(text, patch) {
  let out = String(text || "");
  const newline = out.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of Object.entries(patch)) {
    const safe = String(value ?? "");
    if (/[\r\n]/.test(safe)) continue;
    const pattern = new RegExp(`^(\\s*${key}\\s*=).*?$`, "m");
    if (pattern.test(out)) {
      out = out.replace(pattern, (_m, prefix) => `${prefix}${safe}`);
    } else {
      out += `${out && !out.endsWith("\n") && !out.endsWith("\r\n") ? newline : ""}${key}=${safe}${newline}`;
    }
  }
  return out;
}

/**
 * Create .env on first run from:
 * 1) .env.public next to user dir
 * 2) bundled customer-default.env (Setup / packaged)
 */
export function ensureCustomerEnvFile() {
  const envPath = getEnvPath();
  if (fs.existsSync(envPath)) return { created: false, path: envPath, source: "existing" };

  const dir = path.dirname(envPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }

  const besidePublic = path.join(dir, ".env.public");
  let text = "";
  let source = "bundled";
  if (fs.existsSync(besidePublic)) {
    text = fs.readFileSync(besidePublic, "utf8");
    source = ".env.public";
  } else {
    text = readCustomerDefaultEnvText();
    try {
      fs.writeFileSync(besidePublic, text, "utf8");
    } catch {
      /* ignore */
    }
  }

  text = ensureEncryptionKey(text);
  // Always force official relay on brand-new file if template had junk
  text = patchEnvText(text, {
    OAUTH_RELAY: "1",
    OAUTH_RELAY_URL: DEFAULT_OAUTH_RELAY_URL,
    FB_REDIRECT_URI: DEFAULT_FB_REDIRECT_URI,
    NGROK_AUTOSTART: "0",
    APP_BASE_URL: "http://127.0.0.1:3847",
  });

  fs.writeFileSync(envPath, text, "utf8");
  console.log(`[config] Created .env (${source}) → ${envPath}`);
  return { created: true, path: envPath, source };
}

/**
 * Purge localhost + legacy pre-server domains (ngrok, videoviral, handcraft, qgroup…).
 * Patch ONLY oauth/redirect/ngrok keys — never wipe App ID / secrets / encryption key.
 *
 * Runs for packaged installs always; for dev also when redirect is legacy
 * (so local .env with handcraft/ngrok cannot keep breaking Connect).
 */
export function healLocalhostRedirectEnv() {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return { healed: false };
  let text = fs.readFileSync(envPath, "utf8");
  const redirect = (text.match(/^FB_REDIRECT_URI=(.*)$/m) || [])[1]?.trim() || "";
  const relayUrl = (text.match(/^OAUTH_RELAY_URL=(.*)$/m) || [])[1]?.trim() || "";
  const appBase = (text.match(/^APP_BASE_URL=(.*)$/m) || [])[1]?.trim() || "";
  const redir2 = (text.match(/^FB_REDIRECT_URI_2=(.*)$/m) || [])[1]?.trim() || "";

  // APP_BASE_URL must stay 127.0.0.1 — only bad when it is a PUBLIC old tunnel host
  const appBaseIsPublicLegacy =
    Boolean(appBase) &&
    !/127\.0\.0\.1|localhost/i.test(appBase) &&
    LEGACY_OAUTH_HOST_RE.test(hostnameOfUrl(appBase) || appBase);

  const needsPurge =
    isBrokenOrLegacyRedirect(redirect) ||
    (relayUrl && isLegacyOauthHost(relayUrl)) ||
    appBaseIsPublicLegacy ||
    (redir2 && isBrokenOrLegacyRedirect(redir2));

  if (!needsPurge) {
    // Still force OAUTH_RELAY=1 + NGROK off if redirect already official but flags wrong
    const relayOff = !/^(1|true|yes|relay)$/i.test(
      String((text.match(/^OAUTH_RELAY=(.*)$/m) || [])[1] || "").trim()
    );
    const ngrokOn = String((text.match(/^NGROK_AUTOSTART=(.*)$/m) || [])[1] || "").trim() === "1";
    if (!relayOff && !ngrokOn) return { healed: false, reason: "redirect_ok" };
  }

  // Tests / intentional offline: do not force official relay
  if (String(process.env.OAUTH_RELAY_SYNC || "").trim() === "0") {
    return { healed: false, reason: "sync_disabled" };
  }
  // Dev: only auto-heal when clearly legacy/broken (not custom HTTPS test domains)
  if (!isPackaged() && process.env.FB_FORCE_HEAL_REDIRECT !== "1") {
    if (!needsPurge) return { healed: false, reason: "dev_ok" };
    // legacy/broken (ngrok/handcraft/…) → always heal even in dev
  }

  const port = (text.match(/^PORT=(.*)$/m) || [])[1]?.trim() || "3847";
  const patch = {
    OAUTH_RELAY: "1",
    OAUTH_RELAY_URL: DEFAULT_OAUTH_RELAY_URL,
    FB_REDIRECT_URI: DEFAULT_FB_REDIRECT_URI,
    NGROK_AUTOSTART: "0",
    // Clear free-ngrok token so tool never prefers old tunnel mode
    NGROK_AUTHTOKEN: "",
    APP_BASE_URL: `http://127.0.0.1:${port}`,
  };
  if (redir2 || /^FB_REDIRECT_URI_2=/m.test(text)) {
    patch.FB_REDIRECT_URI_2 = DEFAULT_FB_REDIRECT_URI;
  }

  text = patchEnvText(text, patch);
  text = ensureEncryptionKey(text);

  try {
    fs.copyFileSync(envPath, `${envPath}.bak-legacy-oauth`);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(envPath, text, "utf8");

  // Live process.env so current boot uses new values without restart race
  for (const [k, v] of Object.entries(patch)) {
    process.env[k] = v;
  }

  console.log(
    `[config] Purged legacy OAuth domain → ${DEFAULT_FB_REDIRECT_URI} (App ID/secret kept; backup .bak-legacy-oauth)`
  );
  return { healed: true, path: envPath, reason: needsPurge ? "legacy_domain" : "flags" };
}
