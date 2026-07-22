/**
 * Canonical customer install env (Setup + portable pack).
 * OAuth redirect = HTTPS relay domain — never http://localhost for Facebook Live.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getBundleRoot, getEnvPath, isPackaged } from "../paths.js";

export const DEFAULT_OAUTH_RELAY_URL = "https://modelswiki.top";
export const DEFAULT_FB_REDIRECT_URI = `${DEFAULT_OAUTH_RELAY_URL}/auth/facebook/callback`;
export const DEFAULT_CUSTOMER_APP_ID = "1418846112578001";

/** Bundled template locations (asar / resources / pack). */
export function customerDefaultEnvCandidates() {
  const root = getBundleRoot();
  const list = [
    path.join(root, "build", "customer-default.env"),
    path.join(root, "customer-default.env"),
    path.join(root, ".env.public"),
    // electron-builder resources path when unpacked
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
  // Hard fallback — must stay HTTPS relay
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
    "FB_SCOPES=pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile",
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
    // Also drop .env.public for user reference
    try {
      fs.writeFileSync(besidePublic, text, "utf8");
    } catch {
      /* ignore */
    }
  }

  text = ensureEncryptionKey(text);
  // Force relay HTTPS markers if template somehow had localhost (safety)
  if (/FB_REDIRECT_URI=https?:\/\/(localhost|127\.0\.0\.1)/i.test(text)) {
    text = text
      .replace(/^FB_REDIRECT_URI=.*$/m, `FB_REDIRECT_URI=${DEFAULT_FB_REDIRECT_URI}`)
      .replace(/^OAUTH_RELAY_URL=.*$/m, `OAUTH_RELAY_URL=${DEFAULT_OAUTH_RELAY_URL}`);
    if (!/^OAUTH_RELAY=/m.test(text)) text += "\nOAUTH_RELAY=1\n";
    else text = text.replace(/^OAUTH_RELAY=.*$/m, "OAUTH_RELAY=1");
  }

  fs.writeFileSync(envPath, text, "utf8");
  console.log(`[config] Created .env (${source}) → ${envPath}`);
  return { created: true, path: envPath, source };
}

/**
 * Packaged installs that still have broken http://localhost redirect
 * (old first-run / wrong template) → heal to HTTPS relay without wiping keys.
 * Only when packaged or OAUTH already intended for customers.
 */
export function healLocalhostRedirectEnv() {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return { healed: false };
  let text = fs.readFileSync(envPath, "utf8");
  const redirect = (text.match(/^FB_REDIRECT_URI=(.*)$/m) || [])[1]?.trim() || "";
  const isBad =
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(redirect) ||
    /^http:\/\//i.test(redirect);

  if (!isBad) return { healed: false, reason: "redirect_ok" };

  // Don't auto-heal pure dev trees unless packaged
  if (!isPackaged() && process.env.FB_FORCE_HEAL_REDIRECT !== "1") {
    return { healed: false, reason: "dev_skip" };
  }

  const keepKey = (text.match(/^TOKEN_ENCRYPTION_KEY=(.*)$/m) || [])[1] || "";
  const keepAppId = (text.match(/^FB_APP_ID=(.*)$/m) || [])[1]?.trim() || DEFAULT_CUSTOMER_APP_ID;

  let next = readCustomerDefaultEnvText();
  next = next.replace(/^FB_APP_ID=.*$/m, `FB_APP_ID=${keepAppId || DEFAULT_CUSTOMER_APP_ID}`);
  if (keepKey.trim()) {
    next = next.replace(/^TOKEN_ENCRYPTION_KEY=.*$/m, `TOKEN_ENCRYPTION_KEY=${keepKey.trim()}`);
  } else {
    next = ensureEncryptionKey(next);
  }

  // Preserve chrome profile prefs if present
  for (const key of ["FB_CHROME_PROFILE", "FB_CHROME_USER_DATA_DIR", "FB_BROWSER_PATH", "BROWSER_PATH"]) {
    const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m) {
      if (new RegExp(`^${key}=`, "m").test(next)) {
        next = next.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${m[1]}`);
      } else {
        next += `\n${key}=${m[1]}\n`;
      }
    }
  }

  fs.writeFileSync(envPath, next, "utf8");
  console.log(`[config] Healed localhost/http redirect → ${DEFAULT_FB_REDIRECT_URI}`);
  return { healed: true, path: envPath };
}
