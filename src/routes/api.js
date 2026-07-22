import { Router } from "express";
import {
  listAccounts,
  listPages,
  countPages,
  syncPagesForAccount,
  deleteAccount,
  getAccountPublic,
  getUserToken,
  getPagePublic,
} from "../services/accounts.js";
import {
  enrichPageById,
  enrichAccountPages,
  enrichAllPages,
  enrichMissingProfilesForAccount,
} from "../services/enrich.js";
import {
  exportPagesToWorkbook,
  exportPagesToCsvString,
  listExportSheets,
  getWorkbookPath,
} from "../services/export.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  getLastUsage,
  usageWarning,
  refreshAppUsageFromMeta,
} from "../services/rateLimit.js";
import { config } from "../config.js";
import { isPackaged, getExeDir, getEnvPath, debugPaths } from "../paths.js";
import {
  checkForUpdate,
  getUpdateProgress,
  getUpdateConfig,
  startUpdate,
  requestUpdateRestart,
} from "../services/updater.js";
import {
  getAntiSpamSettings,
  saveAntiSpamSettings,
  applyPreset,
  getAntiSpamStats,
  getRecommendations,
  listRecentBlocks,
  ensureAntiSpamTables,
} from "../services/antiSpam.js";
import { pickFolder } from "../services/folderPicker.js";
import { getAppSetting, saveAppSetting } from "../services/appSettings.js";
import multer from "multer";
import {
  saveUploadedFile,
  listInbox,
} from "../services/mediaUpload.js";
import { isCentralDeploy } from "../services/deployMode.js";
import {
  exportPageInfoDaily,
  exportPostingHistoryDaily,
  dailyReportInfo,
  getDailyReportFile,
} from "../services/dailyReports.js";
import { getNgrokStatus, startNgrok, stopNgrok } from "../services/ngrokManager.js";
import { listMetaAppsPublic } from "../services/metaApps.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_MB || 80) * 1024 * 1024,
    files: 40,
  },
});

const router = Router();

function normalizeOAuthOrigin(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("Nhập domain Ngrok, ví dụ qgroup.ngrok.app");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("Domain không hợp lệ"); }
  if (url.protocol !== "https:") throw new Error("OAuth Facebook cần domain HTTPS");
  if (!url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Chỉ nhập domain, không thêm path, query hoặc tài khoản");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost")) {
    throw new Error("Không được dùng localhost làm domain OAuth/Ngrok. Hãy nhập domain HTTPS công khai, ví dụ qgroup.ngrok.app");
  }
  return url.origin;
}

function writeEnvValues(envPath, values) {
  const exists = fs.existsSync(envPath);
  let text = exists ? fs.readFileSync(envPath, "utf8") : "";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of Object.entries(values)) {
    const safeValue = String(value ?? "");
    if (/[\r\n]/.test(safeValue)) {
      throw new Error(`Giá trị cấu hình ${key} không được chứa xuống dòng`);
    }
    const pattern = new RegExp(`^(\\s*${key}\\s*=).*?$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, (_match, prefix) => `${prefix}${safeValue}`);
    else text += `${text && !text.endsWith("\n") ? newline : ""}${key}=${safeValue}${newline}`;
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, text, "utf8");
}

function safeEnvLabel(value, fallback) {
  return String(value || fallback || "")
    .replace(/[\r\n=]/g, " ")
    .trim()
    .slice(0, 80);
}

function encryptionKeyReady(value) {
  const key = String(value || "").trim();
  return (
    key.length >= 32 &&
    !/change-me|doi-chuoi|dev-only/i.test(key)
  );
}

function firstRunStatus() {
  const apps = listMetaAppsPublic();
  const app1 = apps.find((app) => app.key === "app1") || null;
  const app2 = apps.find((app) => app.key === "app2") || null;
  const accountsCount = listAccounts().length;
  return {
    ready: Boolean(app1?.configured),
    env_exists: fs.existsSync(getEnvPath()),
    env_path: getEnvPath(),
    accounts_count: accountsCount,
    encryption_ready: encryptionKeyReady(config.tokenEncryptionKey),
    app1,
    app2,
  };
}

router.get("/setup/first-run", (_req, res) => {
  res.json({ ok: true, ...firstRunStatus() });
});

router.put("/setup/first-run", async (req, res) => {
  try {
    const { pushMetaAppToRelay } = await import("../services/relayAppPush.js");
    const relayMode =
      String(process.env.OAUTH_RELAY || "").trim() === "1" ||
      String(process.env.OAUTH_RELAY || "").toLowerCase() === "true";
    const currentApp1Id = String(config.facebook.appId || process.env.FB_APP_ID || "").trim();
    const currentApp1Secret = String(config.facebook.appSecret || process.env.FB_APP_SECRET || "").trim();
    const app1Id = String(req.body?.app1_id || currentApp1Id).trim();
    // Relay: khách có thể nhập secret → đẩy lên server; local có thể xóa secret sau.
    const app1Secret = String(req.body?.app1_secret || currentApp1Secret).trim();
    if (!/^\d{5,30}$/.test(app1Id)) {
      throw new Error("App ID 1 phải là dãy số lấy từ Meta for Developers.");
    }
    if (!relayMode && (app1Secret.length < 16 || /[\r\n]/.test(app1Secret))) {
      throw new Error("App Secret 1 chưa hợp lệ (máy không bật OAUTH_RELAY).");
    }
    if (relayMode && app1Secret && (app1Secret.length < 16 || /[\r\n]/.test(app1Secret))) {
      throw new Error("App Secret 1 không hợp lệ.");
    }

    const removeApp2 = Boolean(req.body?.remove_app2);
    const currentApp2Id = String(process.env.FB_APP_ID_2 || "").trim();
    const currentApp2Secret = String(process.env.FB_APP_SECRET_2 || "").trim();
    const app2Id = removeApp2
      ? ""
      : String(req.body?.app2_id || currentApp2Id).trim();
    const app2SecretRaw = String(req.body?.app2_secret ?? "").trim();
    const app2Secret = removeApp2
      ? ""
      : app2SecretRaw || currentApp2Secret;
    if (app2Id && !/^\d{5,30}$/.test(app2Id)) {
      throw new Error("App ID 2 phải là dãy số hoặc để trống.");
    }
    if (app2Id && app2Secret && (app2Secret.length < 16 || /[\r\n]/.test(app2Secret))) {
      throw new Error("App Secret 2 chưa hợp lệ (tối thiểu 16 ký tự).");
    }
    if (app2Id && !app2Secret && !relayMode) {
      throw new Error(
        "Đã nhập App ID 2 nhưng thiếu App Secret 2. " +
          "Gói OAuth relay: nhập secret để đẩy lên server, hoặc để trống nếu server đã có."
      );
    }

    const accountsCount = listAccounts().length;
    let encryptionKey = String(config.tokenEncryptionKey || "").trim();
    const requestedKey = String(req.body?.encryption_key || "").trim();
    if (requestedKey) {
      if (requestedKey.length < 32 || /[\r\n]/.test(requestedKey)) {
        throw new Error("Khóa mã hóa phải có ít nhất 32 ký tự.");
      }
      if (accountsCount > 0 && requestedKey !== encryptionKey) {
        throw new Error("Máy đã có tài khoản Facebook; không được đổi khóa mã hóa vì sẽ làm hỏng token cũ.");
      }
      encryptionKey = requestedKey;
    } else if (!encryptionKeyReady(encryptionKey) && accountsCount === 0) {
      encryptionKey = crypto.randomBytes(32).toString("hex");
    }

    const rawRedirect = String(config.facebook.redirectUri || process.env.FB_REDIRECT_URI || "").trim();
    const redirectUri =
      !rawRedirect || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(rawRedirect) || /^http:\/\//i.test(rawRedirect)
        ? "https://modelswiki.top/auth/facebook/callback"
        : rawRedirect;
    const relayUrl = (() => {
      try {
        return new URL(redirectUri).origin;
      } catch {
        return "https://modelswiki.top";
      }
    })();

    // Push secrets to relay when customer filled them (server stores; other PCs sync IDs)
    const pushNotes = [];
    // Không ép key=app1/app2 khi đẩy: server gán slot theo App ID
    // (máy A "App 1" và máy B "App 1" có thể là 2 Meta App khác nhau).
    if (relayMode && app1Secret) {
      const p1 = await pushMetaAppToRelay({
        appId: app1Id,
        appSecret: app1Secret,
        name: safeEnvLabel(req.body?.app1_name, process.env.FB_APP_NAME || "App 1"),
        // omit key → server match by app_id or next free appN
      });
      if (!p1.ok) throw new Error(`Đẩy App 1 lên server thất bại: ${p1.error}`);
      pushNotes.push(`slot App1 (ID ${app1Id}) → server ${p1.key || "?"}`);
    }
    if (relayMode && app2Id && app2Secret) {
      const p2 = await pushMetaAppToRelay({
        appId: app2Id,
        appSecret: app2Secret,
        name: safeEnvLabel(req.body?.app2_name, process.env.FB_APP_NAME_2 || "App 2"),
      });
      if (!p2.ok) throw new Error(`Đẩy App 2 lên server thất bại: ${p2.error}`);
      pushNotes.push(`slot App2 (ID ${app2Id}) → server ${p2.key || "?"}`);
    }

    // Local .env: keep IDs; strip secrets after successful push (exchange on server)
    const keepSecretLocal = !relayMode;
    const updates = {
      PORT: String(config.port || 3847),
      APP_BASE_URL: "http://127.0.0.1:3847",
      OAUTH_RELAY: "1",
      OAUTH_RELAY_URL: relayUrl,
      FB_APP_ID: app1Id,
      FB_APP_SECRET: localSecret1,
      FB_APP_NAME: safeEnvLabel(req.body?.app1_name, process.env.FB_APP_NAME || "App 1"),
      FB_REDIRECT_URI: redirectUri,
      FB_APP_ID_2: app2Id,
      FB_APP_SECRET_2: localSecret2,
      FB_APP_NAME_2: app2Id
        ? safeEnvLabel(req.body?.app2_name, process.env.FB_APP_NAME_2 || "App 2")
        : "",
      FB_REDIRECT_URI_2: app2Id ? redirectUri : "",
      TOKEN_ENCRYPTION_KEY: encryptionKey,
      NGROK_AUTOSTART: "0",
      NGROK_AUTHTOKEN: "",
      GITHUB_REPO: process.env.GITHUB_REPO || config.githubRepo || "trumrename/fb-page-studio",
      UPDATE_ASSET: process.env.UPDATE_ASSET || "FB-Page-Studio-Desktop.exe",
    };
    // Preserve push token if UI sent it (once)
    const pushTok = String(req.body?.relay_admin_token || "").trim();
    if (pushTok && !/[\r\n]/.test(pushTok)) {
      updates.RELAY_ADMIN_TOKEN = pushTok;
      process.env.RELAY_ADMIN_TOKEN = pushTok;
    }

    writeEnvValues(getEnvPath(), updates);
    for (const [key, value] of Object.entries(updates)) process.env[key] = value;
    config.facebook.appId = app1Id;
    config.facebook.appSecret = localSecret1;
    config.facebook.redirectUri = redirectUri;
    config.tokenEncryptionKey = encryptionKey;

    res.json({
      ok: true,
      message:
        "Đã lưu máy này." +
        (pushNotes.length ? ` ${pushNotes.join("; ")}.` : "") +
        " Có thể Connect Facebook.",
      pushed: pushNotes,
      ...firstRunStatus(),
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/setup/register-meta-app
 * Khách điền App ID + Secret → server relay lưu (secret chỉ trên server).
 * Body: { app_id, app_secret, name?, key?, relay_admin_token? }
 */
router.post("/setup/register-meta-app", async (req, res) => {
  try {
    const { pushMetaAppToRelay } = await import("../services/relayAppPush.js");
    const tok = String(req.body?.relay_admin_token || "").trim();
    if (tok && !/[\r\n]/.test(tok)) {
      process.env.RELAY_ADMIN_TOKEN = tok;
      writeEnvValues(getEnvPath(), { RELAY_ADMIN_TOKEN: tok });
    }
    const appId = String(req.body?.app_id || req.body?.appId || "").trim();
    const appSecret = String(req.body?.app_secret || req.body?.appSecret || "").trim();
    const name = String(req.body?.name || "").trim();
    const key = String(req.body?.key || "").trim();
    const pushed = await pushMetaAppToRelay({ appId, appSecret, name, key: key || undefined });
    if (!pushed.ok) throw new Error(pushed.error || "Push fail");

    // Local: only public id (+ name). No secret on customer disk after push.
    const m = /^app(\d+)$/i.exec(pushed.key || key || "app1");
    const n = m ? Number(m[1]) : 1;
    const idKey = n <= 1 ? "FB_APP_ID" : `FB_APP_ID_${n}`;
    const nameKey = n <= 1 ? "FB_APP_NAME" : `FB_APP_NAME_${n}`;
    const secretKey = n <= 1 ? "FB_APP_SECRET" : `FB_APP_SECRET_${n}`;
    const redirKey = n <= 1 ? "FB_REDIRECT_URI" : `FB_REDIRECT_URI_${n}`;
    const redirectUri = String(
      process.env.FB_REDIRECT_URI || "https://modelswiki.top/auth/facebook/callback"
    ).trim();
    const local = {
      [idKey]: appId,
      [nameKey]: name || `App ${n}`,
      [secretKey]: "",
      [redirKey]: redirectUri,
      OAUTH_RELAY: "1",
    };
    writeEnvValues(getEnvPath(), local);
    for (const [k, v] of Object.entries(local)) process.env[k] = v;
    if (n <= 1) {
      config.facebook.appId = appId;
      config.facebook.appSecret = "";
    }

    res.json({
      ok: true,
      key: pushed.key,
      app_id: appId,
      message:
        "Server đã nhận App ID + Secret. Máy này chỉ giữ App ID. Máy khác mở lại tool sẽ tự đồng bộ.",
      apps: pushed.apps,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const CHROME_PROFILE_HISTORY_KEY = "chrome_profile_history_v1";
const CHROME_HISTORY_MAX = 30;

/**
 * Lịch sử ổ/profile Chrome đã quét hoặc "Dùng profile này".
 * Lưu app_settings — sống qua restart, không phải localStorage.
 */
function readChromeProfileHistory() {
  const raw = getAppSetting(CHROME_PROFILE_HISTORY_KEY, { items: [] });
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return items
    .filter((it) => it && (it.user_data_dir || it.scan_roots))
    .map((it) => ({
      id: String(it.id || ""),
      label: String(it.label || it.name || it.directory || "Chrome"),
      name: String(it.name || it.label || ""),
      directory: String(it.directory || ""),
      user_data_dir: String(it.user_data_dir || ""),
      browser_path: String(it.browser_path || ""),
      scan_roots: String(it.scan_roots || it.user_data_dir || ""),
      used_at: String(it.used_at || ""),
    }))
    .filter((it) => it.id);
}

function writeChromeProfileHistory(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, CHROME_HISTORY_MAX);
  saveAppSetting(CHROME_PROFILE_HISTORY_KEY, { items: list });
  return list;
}

function chromeHistoryId(userDataDir, directory) {
  const key = `${String(userDataDir || "").toLowerCase()}\u0000${String(directory || "").toLowerCase()}`;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/** @returns {object[]} */
function pushChromeProfileHistory(entry) {
  const user_data_dir = String(entry.user_data_dir || "").trim();
  const directory = String(entry.directory || "").trim();
  const scan_roots = String(entry.scan_roots || user_data_dir || "").trim();
  if (!user_data_dir && !scan_roots) return readChromeProfileHistory();
  const id =
    entry.id ||
    chromeHistoryId(user_data_dir || scan_roots, directory || "_root_");
  const next = {
    id,
    label:
      entry.label ||
      entry.name ||
      (directory
        ? `${entry.name || directory}`
        : path.basename(user_data_dir || scan_roots) || "Chrome"),
    name: String(entry.name || entry.label || directory || ""),
    directory,
    user_data_dir: user_data_dir || "",
    browser_path: String(entry.browser_path || "").trim(),
    scan_roots: scan_roots || user_data_dir,
    used_at: new Date().toISOString(),
  };
  const prev = readChromeProfileHistory().filter((it) => it.id !== id);
  return writeChromeProfileHistory([next, ...prev]);
}

function pushChromeScanRootsHistory(rootsValue) {
  const roots = splitChromeScanRoots(rootsValue);
  let list = readChromeProfileHistory();
  for (const root of roots) {
    const id = chromeHistoryId(root, "_scan_root_");
    list = list.filter((it) => it.id !== id);
    list.unshift({
      id,
      label: `Ổ/thư mục: ${root}`,
      name: path.basename(root) || root,
      directory: "",
      user_data_dir: "",
      browser_path: "",
      scan_roots: root,
      used_at: new Date().toISOString(),
    });
  }
  return writeChromeProfileHistory(list);
}

function chromeUserDataDir(value = process.env.FB_CHROME_USER_DATA_DIR) {
  const custom = String(value || "").trim();
  if (!custom) return path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  const raw = path.resolve(custom);
  // ChromePortable normally keeps the Chrome user-data root in Data\profile
  // (sometimes Data\User Data). Accept Portable root so users need not dig.
  const candidates = [
    raw,
    path.join(raw, "Data", "profile"),
    path.join(raw, "Data", "User Data"),
    path.join(raw, "Data", "Profiles"),
    path.join(raw, "profile"),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) continue;
      const names = fs.readdirSync(candidate);
      // The root of a ChromePortable bundle also exists, but it contains App /
      // Data / Other — not Chrome profiles. Only accept a real user-data root.
      if (names.includes("Local State") || names.includes("Default") || names.some((n) => /^Profile \d+$/i.test(n))) {
        return candidate;
      }
    } catch { /* try the next portable-layout candidate */ }
  }
  return raw;
}

/** If browser is Chrome Portable, resolve its Data\profile (or User Data) root. */
function detectPortableUserDataFromBrowser(browserPath) {
  const exe = String(browserPath || "").trim();
  if (!exe) return "";
  let dir = path.resolve(path.dirname(exe));
  const systemUd = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
  for (let i = 0; i < 6; i++) {
    for (const candidate of [
      path.join(dir, "Data", "profile"),
      path.join(dir, "Data", "User Data"),
      path.join(dir, "Data", "Profiles"),
    ]) {
      try {
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) continue;
        const names = fs.readdirSync(candidate);
        if (
          names.includes("Local State") ||
          names.includes("Default") ||
          names.some((n) => /^Profile \d+$/i.test(n))
        ) {
          return path.resolve(candidate);
        }
      } catch {
        /* continue */
      }
    }
    if (fs.existsSync(path.join(dir, "ChromePortable.exe"))) {
      const fromRoot = chromeUserDataDir(dir);
      if (fromRoot && path.resolve(fromRoot).toLowerCase() !== systemUd.toLowerCase()) {
        return path.resolve(fromRoot);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function listChromeProfiles(userDataOverride) {
  const userDataDir = chromeUserDataDir(userDataOverride);
  if (!userDataDir || !fs.existsSync(userDataDir)) return { user_data_dir: userDataDir, profiles: [] };
  const profiles = fs.readdirSync(userDataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/i.test(entry.name)))
    .map((entry) => {
      let name = entry.name;
      try {
        const pref = JSON.parse(fs.readFileSync(path.join(userDataDir, entry.name, "Preferences"), "utf8"));
        name = pref?.profile?.name || name;
      } catch { /* profile may not have Preferences yet */ }
      return { directory: entry.name, name };
    })
    .sort((a, b) => a.directory.localeCompare(b.directory, undefined, { numeric: true }));
  return { user_data_dir: userDataDir, profiles };
}

function splitChromeScanRoots(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[;\r\n|]+/);
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean).map((item) => path.resolve(item)))];
}

function looksLikeChromeUserDataRoot(dir, names) {
  // Prefer strong Chrome markers to avoid random folders named "Default".
  if (names.includes("Local State")) return true;
  const profileDirs = names.filter((name) => name === "Default" || /^Profile \d+$/i.test(name));
  return profileDirs.some((name) => {
    try { return fs.existsSync(path.join(dir, name, "Preferences")); } catch { return false; }
  });
}

function rankBrowserForProfile(userDataDir, chromeExecutables) {
  const dataParts = String(userDataDir || "").toLowerCase().split(path.sep);
  return chromeExecutables.map((exe) => {
    const exeParts = exe.toLowerCase().split(path.sep);
    let common = 0;
    while (common < dataParts.length && common < exeParts.length && dataParts[common] === exeParts[common]) common++;
    const base = path.basename(exe).toLowerCase();
    // Prefer real chrome.exe over ChromePortable.exe launcher (flags are reliable there).
    const kind = base === "chrome.exe" ? 0 : base === "chromeportable.exe" ? 1 : 2;
    return { exe, common, kind, len: exe.length };
  }).sort((a, b) => b.common - a.common || a.kind - b.kind || a.len - b.len);
}

function scanChromeProfiles(rootsValue) {
  const roots = splitChromeScanRoots(rootsValue);
  if (!roots.length) return listChromeProfiles();
  const found = [];
  const chromeExecutables = [];
  const queue = roots.map((dir) => ({ dir, depth: 0 }));
  const seen = new Set();
  const skipped = new Set(["$recycle.bin", "system volume information", "windows", "node_modules", ".git"]);
  while (queue.length && seen.size < 6000) {
    const { dir, depth } = queue.shift();
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const names = entries.map((entry) => entry.name);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /^(chrome|chromeportable)\.exe$/i.test(entry.name)) chromeExecutables.push(full);
    }
    if (looksLikeChromeUserDataRoot(dir, names)) {
      const listed = listChromeProfiles(dir);
      // Always store the resolved user-data root (ChromePortable may remap to Data\profile).
      for (const profile of listed.profiles) {
        found.push({ ...profile, user_data_dir: listed.user_data_dir });
      }
      // Do not walk Cache/Code Cache/GPUCache inside the profile tree — burns the 6000 budget.
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || depth >= 7 || skipped.has(entry.name.toLowerCase())) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  for (const profile of found) {
    const ranked = rankBrowserForProfile(profile.user_data_dir, chromeExecutables);
    profile.browser_path = ranked[0]?.exe || "";
  }
  const unique = [...new Map(found.map((item) => [`${item.user_data_dir}\u0000${item.directory}`, item])).values()];
  return { roots, scanned_directories: seen.size, profiles: unique };
}

/** Domain OAuth local setup — never returns App Secret or encryption keys. */
router.get("/setup/domain", (_req, res) => {
  const relayUrl = String(process.env.OAUTH_RELAY_URL || "").trim().replace(/\/$/, "");
  const relayMode =
    String(process.env.OAUTH_RELAY || "").trim() === "1" ||
    String(process.env.OAUTH_RELAY || "").toLowerCase() === "true";
  // In relay mode "origin" for OAuth is the public relay, not 127.0.0.1.
  const origin = relayMode && relayUrl ? relayUrl : config.appBaseUrl;
  res.json({
    origin,
    app_base_url: config.appBaseUrl,
    oauth_relay: relayMode,
    oauth_relay_url: relayUrl || null,
    redirect_uri: config.facebook.redirectUri,
    port: config.port,
    app2_configured: Boolean(process.env.FB_APP_ID_2),
    env_exists: fs.existsSync(getEnvPath()),
  });
});

router.put("/setup/domain", async (req, res) => {
  try {
    const origin = normalizeOAuthOrigin(req.body?.domain || req.body?.origin);
    const redirectUri = `${origin}/auth/facebook/callback`;
    const envPath = getEnvPath();
    const updates = {
      APP_BASE_URL: origin,
      FB_REDIRECT_URI: redirectUri,
    };
    // App 2 must use the same callback unless the user deliberately configures
    // a different one later. This avoids App 2 silently keeping an old domain.
    if (process.env.FB_APP_ID_2 || process.env.FB_REDIRECT_URI_2) {
      updates.FB_REDIRECT_URI_2 = redirectUri;
    }
    writeEnvValues(envPath, updates);
    process.env.APP_BASE_URL = origin;
    process.env.FB_REDIRECT_URI = redirectUri;
    if (updates.FB_REDIRECT_URI_2) process.env.FB_REDIRECT_URI_2 = redirectUri;
    config.appBaseUrl = origin;
    config.facebook.redirectUri = redirectUri;
    let ngrok = getNgrokStatus();
    if (process.env.NGROK_AUTHTOKEN && String(process.env.NGROK_AUTOSTART || "1") !== "0") {
      ngrok = await startNgrok({ origin, port: config.port });
    }
    res.json({
      ok: true,
      origin,
      redirect_uri: redirectUri,
      port: config.port,
      app2_updated: Boolean(updates.FB_REDIRECT_URI_2),
      ngrok_command: `ngrok http --url=${origin} 127.0.0.1:${config.port}`,
      ngrok_status: ngrok.status,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/setup/ngrok", (_req, res) => res.json({ ok: true, ...getNgrokStatus() }));
router.put("/setup/ngrok", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) throw new Error("Hãy nhập Authtoken Ngrok");
    if (!/^[A-Za-z0-9_-]{20,300}$/.test(token)) {
      throw new Error("Authtoken Ngrok không đúng định dạng hoặc chứa ký tự không an toàn");
    }
    writeEnvValues(getEnvPath(), { NGROK_AUTHTOKEN: token, NGROK_AUTOSTART: "1" });
    process.env.NGROK_AUTHTOKEN = token; process.env.NGROK_AUTOSTART = "1";
    const status = await startNgrok({ token, origin: config.appBaseUrl, port: config.port });
    res.status(status.status === "running" ? 200 : 400).json({ ok: status.status === "running", error: status.status === "running" ? undefined : status.message, ...status });
  } catch (e) { res.status(400).json({ ok: false, error: e.message, ...getNgrokStatus() }); }
});
router.post("/setup/ngrok/start", async (_req, res) => {
  const status = await startNgrok({ origin: config.appBaseUrl, port: config.port });
  res.status(status.status === "running" ? 200 : 400).json({ ok: status.status === "running", error: status.status === "running" ? undefined : status.message, ...status });
});
router.post("/setup/ngrok/stop", async (_req, res) => { await stopNgrok(); res.json({ ok: true, ...getNgrokStatus() }); });

router.get("/setup/browser", (_req, res) => {
  const found = listChromeProfiles();
  const selectedBrowserPath = String(process.env.FB_BROWSER_PATH || "").trim();
  res.json({
    ...found,
    // Attach root on each row so the UI can show full path (same shape as /scan).
    profiles: found.profiles.map((profile) => ({
      ...profile,
      user_data_dir: found.user_data_dir,
      browser_path: selectedBrowserPath,
    })),
    selected_profile: String(process.env.FB_CHROME_PROFILE || "").trim(),
    custom_user_data_dir: String(process.env.FB_CHROME_USER_DATA_DIR || "").trim(),
    browser_path: selectedBrowserPath,
    history: readChromeProfileHistory(),
  });
});

router.get("/setup/browser/history", (_req, res) => {
  res.json({ ok: true, history: readChromeProfileHistory() });
});

router.delete("/setup/browser/history/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  const next = readChromeProfileHistory().filter((it) => it.id !== id);
  writeChromeProfileHistory(next);
  res.json({ ok: true, history: next });
});

router.delete("/setup/browser/history", (_req, res) => {
  writeChromeProfileHistory([]);
  res.json({ ok: true, history: [] });
});

router.post("/setup/browser/scan", (req, res) => {
  const requested = req.body?.roots || req.body?.user_data_dirs || req.body?.user_data_dir;
  const found = scanChromeProfiles(requested);
  if (!found.profiles.length) {
    return res.status(400).json({
      ok: false,
      error: "Không thấy Chrome profile. Hãy chọn một hoặc nhiều thư mục/ổ chứa ChromePortable, hoặc chọn trực tiếp Data\\profile.",
    });
  }
  // Ghi nhớ ổ/thư mục vừa quét để lần sau bấm lịch sử
  try {
    pushChromeScanRootsHistory(requested);
  } catch {
    /* non-fatal */
  }
  res.json({ ok: true, ...found, history: readChromeProfileHistory() });
});

router.put("/setup/browser", (req, res) => {
  try {
    const wanted = String(req.body?.profile || "").trim();
    let requestedDataDir = String(req.body?.user_data_dir || "").trim();
    // Multi-root scan strings (a;b|c) cannot be a single --user-data-dir. Use the first root only
    // when the UI forgot to pick a concrete profile after multi-select.
    if (/[;|\r\n]/.test(requestedDataDir)) {
      requestedDataDir = requestedDataDir.split(/[;\r\n|]+/).map((item) => item.trim()).filter(Boolean)[0] || "";
    }
    let requestedBrowserPath = String(req.body?.browser_path || "").trim();
    // Prefer real chrome.exe next to ChromePortable.exe so Connect can pass profile flags reliably.
    if (/chromeportable\.exe$/i.test(requestedBrowserPath)) {
      const dir = path.dirname(requestedBrowserPath);
      const realChrome = [
        path.join(dir, "App", "Chrome-bin", "chrome.exe"),
        path.join(dir, "App", "Chrome", "chrome.exe"),
        path.join(dir, "chrome.exe"),
      ].find((candidate) => fs.existsSync(candidate));
      if (realChrome) requestedBrowserPath = realChrome;
    }
    // Portable: if UI only sent browser path (or wrong system User Data), bind Data\profile of THAT portable.
    const portableData = detectPortableUserDataFromBrowser(requestedBrowserPath);
    const systemUd = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data");
    if (portableData) {
      const reqResolved = requestedDataDir ? path.resolve(requestedDataDir) : "";
      const isSystemUd =
        !reqResolved ||
        reqResolved.toLowerCase() === systemUd.toLowerCase() ||
        /[\\/]google[\\/]chrome[\\/]user data$/i.test(reqResolved);
      if (isSystemUd) {
        requestedDataDir = portableData;
      }
    }
    const found = listChromeProfiles(requestedDataDir);
    if (wanted && !found.profiles.some((p) => p.directory === wanted)) {
      throw new Error("Chrome Profile không tồn tại trên máy này");
    }
    if (!found.profiles.length) {
      throw new Error("Không thấy Chrome profile ở thư mục này. Với ChromePortable, chọn thư mục ChromePortable hoặc ChromePortable\\Data\\profile.");
    }
    writeEnvValues(getEnvPath(), {
      FB_CHROME_PROFILE: wanted,
      FB_CHROME_USER_DATA_DIR: found.user_data_dir || "",
      FB_BROWSER_PATH: requestedBrowserPath,
    });
    process.env.FB_CHROME_PROFILE = wanted;
    process.env.FB_CHROME_USER_DATA_DIR = found.user_data_dir || "";
    process.env.FB_BROWSER_PATH = requestedBrowserPath;

    const matched = found.profiles.find((p) => p.directory === wanted) || found.profiles[0];
    const history = pushChromeProfileHistory({
      name: matched?.name || wanted,
      label: matched?.name
        ? `${matched.name} — ${found.user_data_dir}\\${matched.directory || wanted}`
        : `${wanted || "Default"} — ${found.user_data_dir}`,
      directory: wanted || matched?.directory || "",
      user_data_dir: found.user_data_dir,
      browser_path: requestedBrowserPath,
      scan_roots: found.user_data_dir,
    });

    // Electron reads this .env file again at every OAuth launch, so the user
    // can test the chosen profile immediately without restarting the tool.
    res.json({
      ok: true,
      selected_profile: wanted,
      user_data_dir: found.user_data_dir,
      browser_path: requestedBrowserPath,
      restart_required: false,
      history,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/reports/daily/info", (_req, res) => {
  res.json(dailyReportInfo());
});

router.post("/reports/daily/pages", async (req, res) => {
  try {
    const refresh = req.body?.refresh_followers !== false;
    const follower_sync = refresh ? await enrichAllPages({ force: true }) : null;
    res.json({ ok: true, follower_sync, ...(await exportPageInfoDaily({ day: req.body?.day })) });
  }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post("/reports/daily/history", async (req, res) => {
  try { res.json({ ok: true, ...(await exportPostingHistoryDaily({ day: req.body?.day })) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get("/reports/daily/file/:name", (req, res) => {
  const file = getDailyReportFile(req.params.name);
  if (!file) return res.status(404).json({ error: "File báo cáo không tồn tại" });
  res.download(file, path.basename(file));
});

/**
 * POST /api/system/pick-folder
 * Body: { title?, initial_dir? }
 * Opens native Windows folder dialog → absolute path
 */
router.post("/system/pick-folder", async (req, res) => {
  try {
    const folder = await pickFolder({
      title: req.body?.title || "Chọn thư mục",
      initialDir: req.body?.initial_dir || req.body?.initialDir || "",
    });
    if (!folder) {
      return res.json({ ok: false, cancelled: true, path: null });
    }
    res.json({ ok: true, path: folder });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/media/upload — web/central: upload ảnh/video/caption lên server
 * multipart field: files (multiple) or file
 * query/body target: auto | inbox | captions
 */
router.post("/media/upload", (req, res) => {
  const allow =
    isCentralDeploy() || String(process.env.ALLOW_MEDIA_UPLOAD || "") === "1";
  if (!allow) {
    return res.status(403).json({
      ok: false,
      error:
        "Upload media chỉ bật ở DEPLOY_MODE=central (hoặc ALLOW_MEDIA_UPLOAD=1).",
    });
  }
  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message || String(err) });
    }
    try {
      const target = String(req.body?.target || req.query?.target || "auto");
      const files = [...(req.files || []), req.file].filter(Boolean);
      if (!files.length) {
        return res.status(400).json({ ok: false, error: "Chọn ít nhất 1 file" });
      }
      const saved = [];
      const errors = [];
      for (const f of files) {
        try {
          saved.push(saveUploadedFile(f, { target }));
        } catch (e) {
          errors.push({ name: f.originalname, error: e.message });
        }
      }
      const inbox = listInbox(50);
      res.json({
        ok: saved.length > 0,
        saved,
        errors,
        inbox,
        defaults: {
          media_folder: inbox.folder,
          posted_folder: inbox.posted_folder,
          captions_folder: inbox.captions_folder,
        },
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
});

/** GET /api/media/inbox — list file trên server */
router.get("/media/inbox", (_req, res) => {
  try {
    res.json({ ok: true, ...listInbox(200) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** GET /api/health */
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "fb-page-studio",
    version: config.version,
    phase: "multi-app + rotation + license",
    deploy_mode: config.deployMode,
    fb_configured: !!(config.facebook.appId && config.facebook.appSecret),
  });
});

/** GET /api/debug/paths — diagnose packaged .env / data */
router.get("/debug/paths", (_req, res) => {
  res.json({
    ...debugPaths(),
    fb_app_id_set: !!config.facebook.appId,
    redirect_uri: config.facebook.redirectUri,
    app_base_url: config.appBaseUrl,
  });
});

/** GET /api/anti-spam — settings + live stats + tips */
router.get("/anti-spam", (_req, res) => {
  ensureAntiSpamTables();
  res.json(getAntiSpamStats());
});

/** PUT /api/anti-spam — update settings (all numbers customizable) */
router.put("/anti-spam", (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.blocked_keywords === "string") {
      body.blocked_keywords = body.blocked_keywords
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (typeof body.blocked_page_ids === "string") {
      body.blocked_page_ids = body.blocked_page_ids
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const settings = saveAntiSpamSettings(body);
    res.json({ ok: true, settings, stats: getAntiSpamStats() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/anti-spam/preset { name: 'safe'|'strict'|'loose' } */
router.post("/anti-spam/preset", (req, res) => {
  try {
    const settings = applyPreset(req.body?.name || "safe");
    res.json({
      ok: true,
      settings,
      tips: getRecommendations().tips,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/anti-spam/events", (req, res) => {
  res.json({ events: listRecentBlocks(Number(req.query.limit) || 40) });
});

/** GET /api/version — current build + update config */
router.get("/version", (_req, res) => {
  const u = getUpdateConfig();
  res.json({
    version: u.current_version,
    name: "FB Page Studio",
    packaged: u.packaged,
    github_repo: u.github_repo || null,
    asset_name: u.asset_name,
    exe_dir: getExeDir(),
  });
});

/** GET /api/update/check — compare with GitHub Releases latest */
router.get("/update/check", async (_req, res) => {
  try {
    const result = await checkForUpdate();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/update/progress — browser polls this while direct EXE download runs. */
router.get("/update/progress", (_req, res) => {
  res.json({ ok: true, ...getUpdateProgress() });
});

// Surface a failed replacement instead of silently staying on the old version.
router.get("/update/last-error", (_req, res) => {
  const file = path.join(getExeDir(), "_update-error.txt");
  let error = null;
  try { if (fs.existsSync(file)) error = fs.readFileSync(file, "utf8").trim() || "Cập nhật EXE thất bại"; }
  catch { /* best effort diagnostic */ }
  res.json({ ok: true, has_error: Boolean(error), error });
});

router.post("/update/last-error/clear", (_req, res) => {
  const file = path.join(getExeDir(), "_update-error.txt");
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* keep app usable */ }
  res.json({ ok: true });
});

/**
 * POST /api/update/apply
 * Download latest .exe from GitHub Release and restart (Windows).
 * Body: { restart?: true }
 */
router.post("/update/apply", async (req, res) => {
  try {
    if (process.platform !== "win32") {
      return res.status(400).json({
        ok: false,
        error: "Auto-update .exe hiện hỗ trợ Windows. Tải thủ công từ GitHub Releases.",
      });
    }
    const restart = req.body?.restart !== false;
    const started = startUpdate();
    res.status(started.already_running ? 200 : 202).json({
      ok: true,
      started: started.started,
      already_running: started.already_running,
      progress: started.progress,
    });
    if (started.started) {
      started.promise.then((result) => {
        if (result?.ok && result.updated && restart && result.bat) {
          setTimeout(() => requestUpdateRestart(result.bat, path.dirname(result.target_exe)), 700);
        }
      });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/accounts — all connected Facebook users */
router.get("/accounts", (_req, res) => {
  res.json({ accounts: listAccounts() });
});

/** GET /api/accounts/:id */
router.get("/accounts/:id", (req, res) => {
  const acc = getAccountPublic(Number(req.params.id));
  if (!acc) return res.status(404).json({ error: "Account not found" });
  res.json({ account: acc });
});

/** POST /api/accounts/:id/sync — re-fetch pages via Graph /me/accounts */
router.post("/accounts/:id/sync", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const acc = getAccountPublic(id);
    if (!acc) return res.status(404).json({ error: "Account not found" });

    const token = getUserToken(id);
    if (!token) return res.status(400).json({ error: "No user token stored" });

    const pages = await syncPagesForAccount(id, token);
    // Tự lấy follow + avatar cho page còn thiếu (profile only — không chờ bấm Sync details)
    let profile_enrich = null;
    try {
      profile_enrich = await enrichMissingProfilesForAccount(id, {
        delayMs: Number(req.body?.delay_ms) || 150,
      });
    } catch (enrichErr) {
      console.warn("[sync] profile enrich:", enrichErr.message);
      profile_enrich = { ok: false, error: enrichErr.message };
    }
    // Re-read after enrich so UI gets followers/picture ngay
    const fresh = listPages({ accountId: id, limit: 5000 });
    res.json({
      account: getAccountPublic(id),
      page_count: fresh.length,
      pages: fresh.map((p) => ({
        id: p.id,
        page_id: p.page_id,
        name: p.name,
        category: p.category,
        status: p.status,
        followers_count: p.followers_count ?? null,
        fan_count: p.fan_count ?? null,
        picture_url: p.picture_url || null,
      })),
      sync_summary: pages.sync_summary || null,
      profile_enrich,
    });
  } catch (e) {
    console.error("[sync]", e);
    res.status(502).json({
      error: e.message,
      fb: e.fb || null,
      hint: "Token may be expired — click Connect Facebook again for this account.",
    });
  }
});

/** DELETE /api/accounts/:id */
router.delete("/accounts/:id", (req, res) => {
  const id = Number(req.params.id);
  deleteAccount(id);
  res.json({ ok: true, deleted: id });
});

/**
 * GET /api/pages
 * Query: account_id, q, limit, offset
 * Large scale: paginate with limit/offset
 */
router.get("/pages", (req, res) => {
  const accountId = req.query.account_id
    ? Number(req.query.account_id)
    : undefined;
  const q = req.query.q ? String(req.query.q) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 500;
  const offset = req.query.offset ? Number(req.query.offset) : 0;

  const total = countPages({ accountId, q });
  const pages = listPages({ accountId, q, limit, offset });

  res.json({
    total,
    limit,
    offset,
    pages,
  });
});

/** POST /api/pages/enrich-all — all accounts (can take a while) */
router.post("/pages/enrich-all", async (req, res) => {
  try {
    const delayMs = req.body?.delay_ms ? Number(req.body.delay_ms) : undefined;
    const force = req.body?.force === true;
    const summary = await enrichAllPages({ delayMs, force });
    res.json(summary);
  } catch (e) {
    console.error("[enrich all]", e);
    res.status(502).json({ error: e.message });
  }
});

/**
 * POST /api/accounts/:id/enrich — enrich all pages of account (rate-limited)
 */
router.post("/accounts/:id/enrich", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!getAccountPublic(id)) {
      return res.status(404).json({ error: "Account not found" });
    }
    const delayMs = req.body?.delay_ms ? Number(req.body.delay_ms) : undefined;
    const force = req.body?.force === true;
    const summary = await enrichAccountPages(id, { delayMs, force });
    res.json(summary);
  } catch (e) {
    console.error("[enrich account]", e);
    res.status(502).json({ error: e.message, fb: e.fb || null });
  }
});

/** GET /api/pages/:id — one page with full enrich payload */
router.get("/pages/:id", (req, res) => {
  const page = getPagePublic(Number(req.params.id));
  if (!page) return res.status(404).json({ error: "Page not found" });
  res.json({ page });
});

/**
 * POST /api/pages/:id/enrich — followers, roles, BM field, insights for one page
 * Uses stored page token (no manual API paste).
 */
router.post("/pages/:id/enrich", async (req, res) => {
  try {
    const force = req.body?.force === true || req.query.force === "1";
    const result = await enrichPageById(Number(req.params.id), { force });
    const page = getPagePublic(Number(req.params.id));
    res.json({
      result,
      page,
      app_usage: getLastUsage(),
      usage_warning: usageWarning(),
    });
  } catch (e) {
    console.error("[enrich page]", e);
    res.status(502).json({ error: e.message, fb: e.fb || null });
  }
});

/** Summary stats for dashboard */
router.get("/stats", async (_req, res) => {
  // Refresh app-level % (dashboard) via App Access Token — page tokens don't send x-app-usage
  await refreshAppUsageFromMeta();
  const accounts = listAccounts();
  const totalPages = countPages({});
  const pages = listPages({ limit: 5000 });
  const withFollowers = pages.filter((p) => p.followers_count != null).length;
  res.json({
    account_count: accounts.length,
    page_count: totalPages,
    accounts_error: accounts.filter((a) => a.status === "error").length,
    pages_enriched: withFollowers,
    app_usage: getLastUsage(),
    usage_warning: usageWarning(),
  });
});

/** GET /api/usage — force poll Meta app usage % */
router.get("/usage", async (_req, res) => {
  const usage = await refreshAppUsageFromMeta();
  res.json({
    app_usage: usage,
    usage_warning: usageWarning(),
    note: "call_count ≈ % limit app trên Meta dashboard (rolling window)",
  });
});

/**
 * POST /api/export/xlsx
 * Body: { account_id?, q? }
 * Adds a NEW sheet named by export date into master workbook, then downloads file.
 */
router.post("/export/xlsx", async (req, res) => {
  try {
    const accountId = req.body?.account_id
      ? Number(req.body.account_id)
      : undefined;
    const q = req.body?.q ? String(req.body.q) : undefined;
    const result = await exportPagesToWorkbook({ accountId, q });
    res.setHeader("X-Export-Sheet", encodeURIComponent(result.sheetName));
    res.setHeader("X-Export-Rows", String(result.rowCount));
    res.setHeader("X-Export-Date", encodeURIComponent(result.exportDate));
    res.download(result.filePath, result.downloadName, (err) => {
      if (err) {
        console.error("[export download]", err);
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        }
      }
    });
  } catch (e) {
    console.error("[export xlsx]", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/export/xlsx/meta — same append but return JSON (no download)
 * for UI toast: sheet name, list of sheets
 */
router.post("/export/xlsx/meta", async (req, res) => {
  try {
    const accountId = req.body?.account_id
      ? Number(req.body.account_id)
      : undefined;
    const q = req.body?.q ? String(req.body.q) : undefined;
    const result = await exportPagesToWorkbook({ accountId, q });
    res.json({
      ok: true,
      sheetName: result.sheetName,
      rowCount: result.rowCount,
      exportDate: result.exportDate,
      exportDay: result.exportDay,
      sheets: result.sheets,
      downloadUrl: "/api/export/xlsx/file",
    });
  } catch (e) {
    console.error("[export meta]", e);
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/export/xlsx/file — download master workbook (all sheets) */
router.get("/export/xlsx/file", (req, res) => {
  const file = getWorkbookPath();
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "Chưa có file export. Bấm Xuất Excel trước." });
  }
  res.download(file, "pages_history.xlsx");
});

/** GET /api/export/sheets — list sheets in master file */
router.get("/export/sheets", async (_req, res) => {
  try {
    const info = await listExportSheets();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/export/csv — one-shot CSV (single snapshot; no multi-sheet)
 */
router.get("/export/csv", (req, res) => {
  try {
    const accountId = req.query.account_id
      ? Number(req.query.account_id)
      : undefined;
    const q = req.query.q ? String(req.query.q) : undefined;
    const { csv, downloadName, rowCount, exportDate } = exportPagesToCsvString({
      accountId,
      q,
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadName}"`
    );
    res.setHeader("X-Export-Rows", String(rowCount));
    res.setHeader("X-Export-Date", exportDate);
    // BOM for Excel UTF-8
    res.send("\uFEFF" + csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
