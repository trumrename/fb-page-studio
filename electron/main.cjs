/**
 * FB Page Studio — desktop shell
 * Backend: child process (Electron-as-Node) — reliable with better-sqlite3 in asarUnpack
 */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
  ipcMain,
} = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

// Windows: ghim taskbar / jump list nhận đúng app (NSIS install + portable)
try {
  app.setAppUserModelId("com.fbpagestudio.app");
} catch {
  /* ignore */
}

let PORT = Number(process.env.PORT || 3847);

/** Unexpected backend exits — auto-restart up to 2 times */
let backendRestartAttempts = 0;

let mainWindow = null;
let tray = null;
let serverProc = null;
let USER_DIR = null;
let logFile = null;
let applyingUpdate = false;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    if (!logFile) {
      const base = USER_DIR || app.getPath("userData");
      fs.mkdirSync(base, { recursive: true });
      logFile = path.join(base, "desktop-startup.log");
    }
    fs.appendFileSync(logFile, line, "utf8");
  } catch {
    /* ignore */
  }
  console.log(...args);
}

function shutdownBackend() {
  if (!serverProc || serverProc.killed) return;
  try { serverProc.send({ type: "shutdown" }); } catch { /* process may already be gone */ }
  setTimeout(() => { if (serverProc && !serverProc.killed) { try { serverProc.kill(); } catch {} } }, 1800);
}

function appRoot() {
  try {
    return app.getAppPath();
  } catch {
    return path.join(__dirname, "..");
  }
}

function findUserDirWithEnv() {
  const candidates = [
    process.env.FB_USER_DIR,
    process.env.PORTABLE_EXECUTABLE_DIR,
    path.dirname(process.execPath),
    path.join(path.dirname(process.execPath), ".."),
    process.cwd(),
    path.join(process.cwd(), ".."),
    path.join(appRoot(), ".."),
    appRoot(),
  ].filter(Boolean);

  const seen = new Set();
  for (const raw of candidates) {
    let dir = path.resolve(raw);
    for (let i = 0; i < 8; i++) {
      if (seen.has(dir)) break;
      seen.add(dir);
      if (fs.existsSync(path.join(dir, ".env"))) return dir;
      // also accept project marker
      if (
        fs.existsSync(path.join(dir, "package.json")) &&
        fs.existsSync(path.join(dir, "data", "app.db"))
      ) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // First run of a portable EXE may not have .env/data yet. Persist beside the
  // real outer EXE, never inside Electron's temporary extraction directory.
  if (process.env.FB_USER_DIR) return path.resolve(process.env.FB_USER_DIR);
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
  }
  // NSIS / installed app (Program Files): write data to AppData, not install dir
  if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR) {
    try {
      const installed = app.getPath("userData");
      fs.mkdirSync(installed, { recursive: true });
      return installed;
    } catch {
      /* fall through */
    }
  }
  return path.dirname(process.execPath);
}

function iconPath(name) {
  const root = appRoot();
  const list = [
    path.join(root, "build", name),
    path.join(root, "assets", name),
    path.join(__dirname, "..", "build", name),
    path.join(__dirname, "..", "assets", name),
  ];
  for (const p of list) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * Path of the portable .exe the user double-clicked (on disk).
 * electron-builder portable extracts to %TEMP% — process.execPath is NOT the install file.
 */
function listDesktopExesIn(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /^FB-Page-Studio-Desktop(?:-v\d+\.\d+\.\d+)?\.exe$/i.test(n) || /^FB-Page-Studio\.exe$/i.test(n) || /^FB Page Studio\.exe$/i.test(n))
      .map((n) => {
        const full = path.join(dir, n);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* */
        }
        const ver = (n.match(/-v(\d+\.\d+\.\d+)\.exe$/i) || [])[1] || "";
        return { full: path.resolve(full), name: n, mtime, ver };
      });
  } catch {
    return [];
  }
}

/** Prefer newest versioned Desktop-vX.Y.Z.exe, else unversioned Desktop.exe */
function pickBestDesktopExe(dir) {
  const list = listDesktopExesIn(dir);
  if (!list.length) return null;
  list.sort((a, b) => {
    // Prefer highest semver if both versioned
    if (a.ver && b.ver) {
      const pa = a.ver.split(".").map(Number);
      const pb = b.ver.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
      }
    }
    if (a.ver && !b.ver) return -1;
    if (!a.ver && b.ver) return 1;
    return b.mtime - a.mtime;
  });
  return list[0].full;
}

function resolveOuterPortableExe(userDir) {
  // 1) Official portable env (electron-builder) — exact file user double-clicked
  if (
    process.env.PORTABLE_EXECUTABLE_FILE &&
    fs.existsSync(process.env.PORTABLE_EXECUTABLE_FILE)
  ) {
    return path.resolve(process.env.PORTABLE_EXECUTABLE_FILE);
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const hit = pickBestDesktopExe(process.env.PORTABLE_EXECUTABLE_DIR);
    if (hit) return hit;
  }
  // 2) Next to data/.env folder (USER_DIR) — versioned packs live here
  if (userDir) {
    const hit = pickBestDesktopExe(userDir);
    if (hit) return hit;
  }
  // 3) Fallback: current process (dev / non-portable)
  return process.execPath;
}

function loadAppIcon() {
  const p =
    iconPath("icon.ico") || iconPath("icon-256.png") || iconPath("icon.png");
  if (!p) return undefined;
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? undefined : img;
}

/**
 * First-run seed for Setup + portable: HTTPS OAuth relay (modelswiki.top).
 * Never leave http://localhost as Facebook redirect on installed builds.
 */
function seedCustomerEnvInUserDir(userDir) {
  if (!userDir) return;
  const envPath = path.join(userDir, ".env");
  const pubPath = path.join(userDir, ".env.public");
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "customer-default.env"),
    path.join(appRoot(), "build", "customer-default.env"),
    path.join(__dirname, "..", "build", "customer-default.env"),
  ].filter(Boolean);

  let template = null;
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        template = fs.readFileSync(p, "utf8");
        log("customer env template", p);
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!template) {
    template = [
      "PORT=3847",
      "APP_BASE_URL=http://127.0.0.1:3847",
      "OAUTH_RELAY=1",
      "NGROK_AUTOSTART=0",
      "NGROK_AUTHTOKEN=",
      "OAUTH_RELAY_URL=https://modelswiki.top",
      "FB_REDIRECT_URI=https://modelswiki.top/auth/facebook/callback",
      "FB_APP_ID=",
      "FB_APP_NAME=App 1",
      "FB_GRAPH_VERSION=v21.0",
      "FB_SCOPES=pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile",
      "TOKEN_ENCRYPTION_KEY=",
      "GITHUB_REPO=trumrename/fb-page-studio",
      "UPDATE_ASSET=FB-Page-Studio-Desktop.exe",
      "",
    ].join("\n");
  }

  const crypto = require("crypto");
  const withKey = (text) => {
    let t = String(text || "");
    if (!/^TOKEN_ENCRYPTION_KEY=\s*\S+/m.test(t)) {
      const key = crypto.randomBytes(32).toString("hex");
      if (/^TOKEN_ENCRYPTION_KEY=/m.test(t)) {
        t = t.replace(/^TOKEN_ENCRYPTION_KEY=.*$/m, `TOKEN_ENCRYPTION_KEY=${key}`);
      } else {
        t += `\nTOKEN_ENCRYPTION_KEY=${key}\n`;
      }
    }
    return t;
  };

  if (!fs.existsSync(pubPath)) {
    try {
      fs.writeFileSync(pubPath, template, "utf8");
      log("wrote .env.public", pubPath);
    } catch (e) {
      log("write .env.public fail", e.message);
    }
  }

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, withKey(template), "utf8");
    log("created .env from customer template", envPath);
    return;
  }

  // Purge localhost + legacy pre-server domains (ngrok/videoviral/handcraft/qgroup).
  // Patch ONLY oauth keys — never rewrite whole .env (would wipe secrets → login fail).
  try {
    let cur = fs.readFileSync(envPath, "utf8");
    const redirect = String((cur.match(/^FB_REDIRECT_URI=(.*)$/m) || [])[1] || "").trim();
    const relay = String((cur.match(/^OAUTH_RELAY_URL=(.*)$/m) || [])[1] || "").trim();
    const appBase = String((cur.match(/^APP_BASE_URL=(.*)$/m) || [])[1] || "").trim();
    const legacyTunnelRe =
      /ngrok|videoviral|chainityai|handcraft|qgroup|loca\.lt|serveo|trycloudflare/i;
    const badRedirect =
      !redirect ||
      /^http:\/\//i.test(redirect) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(redirect) ||
      legacyTunnelRe.test(redirect) ||
      (relay && legacyTunnelRe.test(relay));
    const appBaseBad = appBase && legacyTunnelRe.test(appBase);
    if (!badRedirect && !appBaseBad) {
      if (/^OAUTH_RELAY=1\s*$/m.test(cur) && /^NGROK_AUTOSTART=0\s*$/m.test(cur)) return;
    }

    const port = String((cur.match(/^PORT=(.*)$/m) || [])[1] || "3847").trim() || "3847";
    const patch = {
      OAUTH_RELAY: "1",
      OAUTH_RELAY_URL: "https://modelswiki.top",
      FB_REDIRECT_URI: "https://modelswiki.top/auth/facebook/callback",
      NGROK_AUTOSTART: "0",
      NGROK_AUTHTOKEN: "",
      APP_BASE_URL: `http://127.0.0.1:${port}`,
    };
    if (/^FB_REDIRECT_URI_2=/m.test(cur)) {
      patch.FB_REDIRECT_URI_2 = "https://modelswiki.top/auth/facebook/callback";
    }
    const newline = cur.includes("\r\n") ? "\r\n" : "\n";
    for (const [key, value] of Object.entries(patch)) {
      const pattern = new RegExp(`^(\\s*${key}\\s*=).*?$`, "m");
      if (pattern.test(cur)) {
        cur = cur.replace(pattern, (_match, prefix) => `${prefix}${value}`);
      } else {
        cur += `${cur && !cur.endsWith("\n") && !cur.endsWith("\r\n") ? newline : ""}${key}=${value}${newline}`;
      }
    }
    cur = withKey(cur);
    try {
      fs.copyFileSync(envPath, `${envPath}.bak-legacy-oauth`);
    } catch {
      /* ignore */
    }
    fs.writeFileSync(envPath, cur, "utf8");
    log("purged legacy OAuth domain → modelswiki.top (secrets preserved)", envPath);
  } catch (e) {
    log("heal .env fail", e.message);
  }
}

/**
 * Heal mismatched Chrome env only — NEVER wipe a valid system OR portable
 * selection. User must be able to pin any profile (GỐC or PORTABLE).
 *
 * Only fix clear mistakes:
 * - Portable exe + system User Data → rebind to Portable Data\profile
 * - System chrome.exe + portable Data path is OK (rare) — leave as-is
 * - Strip obsolete "disabled system User Data" comment blocks that blocked selection
 */
function healChromeSessionEnv(userDir) {
  if (!userDir) return;
  const envPath = path.join(userDir, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    let cur = fs.readFileSync(envPath, "utf8");
    const orig = cur;
    const browserPath = String(
      (cur.match(/^FB_BROWSER_PATH=(.*)$/m) || [])[1] || ""
    ).trim();
    const dataDir = String(
      (cur.match(/^FB_CHROME_USER_DATA_DIR=(.*)$/m) || [])[1] || ""
    ).trim();
    const isPortableExe = /chromeportable|googlechromeportable/i.test(browserPath);
    const isSystemData =
      /google[\\/]chrome[\\/]user data/i.test(dataDir) &&
      !/chromeportable/i.test(dataDir);

    // Portable browser must not point at system User Data (empty/wrong session)
    if (isPortableExe && isSystemData) {
      const root =
        findChromePortableRoot(browserPath) ||
        path.dirname(browserPath);
      const portableData = findPortableUserDataDir(root);
      if (portableData) {
        cur = cur.replace(
          /^FB_CHROME_USER_DATA_DIR=.*$/m,
          `FB_CHROME_USER_DATA_DIR=${portableData}`
        );
        log("healed: portable exe + system data →", portableData);
      }
    }

    // Remove old heal comments that disabled system profile selection (v1.2.7x)
    if (
      /#\s*FB_CHROME_USER_DATA_DIR=.*disabled:\s*system User Data/i.test(cur)
    ) {
      cur = cur.replace(
        /^[ \t]*#\s*FB_CHROME_USER_DATA_DIR=.*disabled:.*$/gim,
        ""
      );
      log("healed: removed obsolete system-data disable comments");
    }

    if (cur !== orig) {
      try {
        fs.copyFileSync(envPath, `${envPath}.bak-chrome-session`);
      } catch {
        /* ignore */
      }
      fs.writeFileSync(envPath, cur, "utf8");
    }
  } catch (e) {
    log("healChromeSessionEnv fail", e.message);
  }
}

// Browser choice is read fresh before each OAuth launch. The setup page can
// therefore change profile without restarting the desktop application.
function readBrowserEnv() {
  try {
    const envPath = path.join(USER_DIR || findUserDirWithEnv(), ".env");
    return dotenv.parse(fs.readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

/** True if any chrome.exe is still running (singleton owner). */
function isChromeProcessRunning() {
  try {
    const { execSync } = require("child_process");
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    });
    return /chrome\.exe/i.test(out) && !/No tasks/i.test(out);
  } catch {
    return false;
  }
}

/**
 * True if a chrome process is using this exact user-data dir
 * (system Chrome open must NOT block clearing Portable SingletonLock).
 */
function isChromeRunningForUserData(userDataDir) {
  const needle = path
    .resolve(String(userDataDir || ""))
    .toLowerCase()
    .replace(/\//g, "\\");
  if (!needle) return isChromeProcessRunning();
  try {
    const { execSync } = require("child_process");
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
      { encoding: "utf8", windowsHide: true, timeout: 6000 }
    );
    const norm = String(out || "")
      .toLowerCase()
      .replace(/\//g, "\\");
    if (norm.includes(needle)) return true;
    // Also match shortened --user-data-dir forms
    const short = needle.replace(/\\+/g, "\\");
    return short && norm.includes(short);
  } catch {
    // Cannot inspect CMDline → only treat as running for generic "any chrome"
    // when checking system User Data; for portable prefer clear.
    if (/google[\\/]chrome[\\/]user data/i.test(needle)) {
      return isChromeProcessRunning();
    }
    return false;
  }
}

/** Chrome profile root markers (system or Portable Data\profile). */
function looksLikeChromeUserDataRoot(dir) {
  try {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    const names = fs.readdirSync(dir);
    if (names.includes("Local State")) return true;
    if (names.includes("Default")) return true;
    return names.some((n) => /^Profile \d+$/i.test(n));
  } catch {
    return false;
  }
}

/**
 * Resolve Chrome Portable root from ChromePortable.exe or App\Chrome-bin\chrome.exe.
 * Returns null for normal system Chrome installs.
 */
function findChromePortableRoot(exePath) {
  if (!exePath) return null;
  let dir = path.resolve(path.dirname(exePath));
  for (let i = 0; i < 6; i++) {
    const launcher = path.join(dir, "ChromePortable.exe");
    const dataProfile = path.join(dir, "Data", "profile");
    const dataUser = path.join(dir, "Data", "User Data");
    if (
      fs.existsSync(launcher) ||
      looksLikeChromeUserDataRoot(dataProfile) ||
      looksLikeChromeUserDataRoot(dataUser)
    ) {
      return dir;
    }
    // PortableApps layout: ...\ChromePortable\App\Chrome-bin\chrome.exe
    if (/[\\/]App$/i.test(dir)) {
      const parent = path.dirname(dir);
      if (fs.existsSync(path.join(parent, "ChromePortable.exe")) || fs.existsSync(path.join(parent, "Data"))) {
        return parent;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Prefer Portable Data folders; never invent system User Data for portable builds. */
function findPortableUserDataDir(portableRoot) {
  if (!portableRoot) return "";
  const candidates = [
    path.join(portableRoot, "Data", "profile"),
    path.join(portableRoot, "Data", "User Data"),
    path.join(portableRoot, "Data", "Profiles"),
    path.join(portableRoot, "App", "DefaultData"),
    path.join(portableRoot, "profile"),
  ];
  for (const c of candidates) {
    if (looksLikeChromeUserDataRoot(c)) return c;
  }
  // Create-ready default used by PortableApps Chrome
  const fallback = path.join(portableRoot, "Data", "profile");
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * Stale Singleton* after crash makes ChromePortable "flash then exit".
 * Only delete when no chrome is using THIS user-data dir (system Chrome open
 * must not block Portable lock recovery).
 */
function clearStaleChromeSingletonLocks(userDataDir) {
  if (!userDataDir || !fs.existsSync(userDataDir)) return [];
  if (isChromeRunningForUserData(userDataDir)) {
    log("chrome lock: skip clear (live process for this data)", userDataDir);
    return [];
  }
  const cleared = [];
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const p = path.join(userDataDir, name);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        cleared.push(name);
      }
    } catch (e) {
      log("chrome lock: cannot remove", name, e.message);
    }
  }
  if (cleared.length) log("chrome lock: cleared stale", userDataDir, cleared.join(","));
  return cleared;
}

/**
 * Launch plan — BOTH system Chrome and Chrome Portable with correct profile.
 *
 * Portable launcher: ChromePortable.exe --profile-directory=X url
 * Portable chrome.exe: chrome.exe --user-data-dir=Data\profile --profile-directory=X url
 * System: chrome.exe --user-data-dir=...\User Data --profile-directory=X url
 */
function resolveChromeLaunchPlan(rawExe, browserEnv) {
  let exe = path.resolve(String(rawExe || "").trim());
  const profile = String(
    browserEnv.FB_CHROME_PROFILE || process.env.FB_CHROME_PROFILE || ""
  )
    .trim()
    .replace(/^#.*$/, "");
  let configuredData = String(
    browserEnv.FB_CHROME_USER_DATA_DIR || process.env.FB_CHROME_USER_DATA_DIR || ""
  )
    .trim()
    .replace(/^#.*$/, "");

  const portableRoot =
    findChromePortableRoot(exe) ||
    (/chromeportable\.exe$/i.test(exe) || /googlechromeportable\.exe$/i.test(exe)
      ? path.dirname(exe)
      : null);
  const isPortable = Boolean(
    portableRoot || /chromeportable|googlechromeportable/i.test(exe)
  );

  if (isPortable) {
    const root = portableRoot || path.dirname(exe);
    const launcher = [
      path.join(root, "ChromePortable.exe"),
      path.join(root, "GoogleChromePortable.exe"),
    ].find((p) => fs.existsSync(p));
    let userData = "";
    if (configuredData && looksLikeChromeUserDataRoot(configuredData)) {
      userData = path.resolve(configuredData);
    } else {
      userData = findPortableUserDataDir(root) || "";
    }
    // ALWAYS prefer launcher — chrome.exe + --user-data-dir can empty session / captcha
    if (launcher) {
      exe = launcher;
      const args = [];
      if (profile) args.push(`--profile-directory=${profile}`);
      log("chrome plan PORTABLE launcher", exe, profile || "Default");
      return {
        exe,
        args,
        isChrome: true,
        userData: userData || "",
        profile: profile || "Default",
        portable: true,
        reuseRunning: isChromeProcessRunning(),
      };
    }
    // No launcher: refuse silent chrome.exe fallback (customer logout risk)
    log(
      "chrome plan PORTABLE FAIL — missing ChromePortable.exe in",
      root
    );
    return {
      exe: "",
      args: [],
      isChrome: false,
      userData: userData || "",
      profile: profile || "Default",
      portable: true,
      missingLauncher: true,
      reuseRunning: false,
    };
  }

  const base = path.basename(exe).toLowerCase();
  if (base !== "chrome.exe" && base !== "msedge.exe") {
    return { exe, args: [], isChrome: false, userData: "", profile: "", portable: false };
  }

  // System Chrome / Edge — keep --user-data-dir so the exact profile is used
  const local = process.env.LOCALAPPDATA || "";
  const systemUd = path.join(local, "Google", "Chrome", "User Data");
  let userData = "";
  if (configuredData && fs.existsSync(configuredData)) {
    if (
      /google[\\/]chrome[\\/]user data/i.test(configuredData) ||
      looksLikeChromeUserDataRoot(configuredData)
    ) {
      userData = path.resolve(configuredData);
    }
  }
  if (!userData && base === "chrome.exe") {
    userData = systemUd;
  }
  if (!userData && base === "msedge.exe") {
    userData = path.join(local, "Microsoft", "Edge", "User Data");
  }

  const args = [];
  if (userData && fs.existsSync(userData)) {
    args.push(`--user-data-dir=${userData}`);
  }
  if (profile) {
    args.push(`--profile-directory=${profile}`);
  }
  log(
    "chrome plan SYSTEM",
    exe,
    userData || "(default-data)",
    profile || "Default"
  );
  return {
    exe,
    args,
    isChrome: true,
    userData,
    profile: profile || "Default",
    portable: false,
    reuseRunning: isChromeProcessRunning(),
  };
}

/** True if URL is Facebook OAuth / login — must NOT open Windows default (system Chrome). */
function isFacebookAuthUrl(url) {
  return /facebook\.com|fb\.com|fbcdn\.|\/auth\/facebook|modelswiki\.top\/auth/i.test(
    String(url || "")
  );
}

/**
 * Resolve ChromePortable.exe aggressively — customers often forget FB_BROWSER_PATH.
 * Never return system Google\Chrome\Application\chrome.exe as "portable".
 */
function findChromePortableExe(browserEnv = {}) {
  const tried = [];
  const push = (p) => {
    const s = String(p || "").trim();
    if (s) tried.push(s);
  };

  push(browserEnv.BROWSER_PATH || process.env.BROWSER_PATH);
  push(browserEnv.FB_BROWSER_PATH || process.env.FB_BROWSER_PATH);

  // Walk up from configured portable user-data (Data\profile)
  const ud = String(
    browserEnv.FB_CHROME_USER_DATA_DIR || process.env.FB_CHROME_USER_DATA_DIR || ""
  ).trim();
  if (ud && !/google[\\/]chrome[\\/]user data/i.test(ud)) {
    let dir = path.resolve(ud);
    for (let i = 0; i < 8; i++) {
      push(path.join(dir, "ChromePortable.exe"));
      push(path.join(dir, "GoogleChromePortable.exe"));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Máy khách: Portable có thể nằm bất kỳ ổ (USB D–Z), Desktop, PortableApps…
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const drives = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  for (const L of drives) {
    push(`${L}:\\ChromePortable\\ChromePortable.exe`);
    push(`${L}:\\GoogleChromePortable\\GoogleChromePortable.exe`);
    push(`${L}:\\PortableApps\\GoogleChromePortable\\GoogleChromePortable.exe`);
    push(`${L}:\\PortableApps\\ChromePortable\\ChromePortable.exe`);
    push(`${L}:\\Tools\\ChromePortable\\ChromePortable.exe`);
    push(`${L}:\\Program\\ChromePortable\\ChromePortable.exe`);
    push(`${L}:\\Apps\\ChromePortable\\ChromePortable.exe`);
  }
  if (home) {
    push(path.join(home, "ChromePortable", "ChromePortable.exe"));
    push(path.join(home, "Desktop", "ChromePortable", "ChromePortable.exe"));
    push(path.join(home, "Documents", "ChromePortable", "ChromePortable.exe"));
    push(path.join(home, "Downloads", "ChromePortable", "ChromePortable.exe"));
    push(
      path.join(
        home,
        "PortableApps",
        "GoogleChromePortable",
        "GoogleChromePortable.exe"
      )
    );
  }

  for (const p of tried) {
    try {
      if (p && fs.existsSync(p) && /portable/i.test(p) && /\.exe$/i.test(p)) {
        return path.resolve(p);
      }
      // Path is chrome.exe under a Portable tree → use launcher
      if (p && fs.existsSync(p) && /chrome\.exe$/i.test(p)) {
        const root = findChromePortableRoot(p);
        if (root) {
          const launcher = path.join(root, "ChromePortable.exe");
          if (fs.existsSync(launcher)) return launcher;
          const g = path.join(root, "GoogleChromePortable.exe");
          if (fs.existsSync(g)) return g;
        }
      }
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Open OAuth in the browser+profile the user saved (system OR Portable).
 * Never openExternal first for OAuth — that ignores profile selection.
 */
function openInPreferredBrowser(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    log("openInPreferredBrowser blocked invalid URL");
    return false;
  }
  // Gate string for test-requirements: ['http:', 'https:']
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    log("openInPreferredBrowser blocked protocol", parsed.protocol);
    return false;
  }
  url = parsed.toString();
  const browserEnv = readBrowserEnv();
  const authSensitive = isFacebookAuthUrl(url);

  // Priority: saved FB_BROWSER_PATH (system chrome.exe OR ChromePortable.exe)
  let forcedPath = String(
    browserEnv.BROWSER_PATH ||
      process.env.BROWSER_PATH ||
      browserEnv.FB_BROWSER_PATH ||
      process.env.FB_BROWSER_PATH ||
      ""
  ).trim();

  const systemChromeCandidates = () => {
    const local = process.env.LOCALAPPDATA || "";
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    ];
  };

  // Infer from saved user-data when browser path missing
  if ((!forcedPath || !fs.existsSync(forcedPath)) && browserEnv.FB_CHROME_USER_DATA_DIR) {
    const ud = String(browserEnv.FB_CHROME_USER_DATA_DIR).trim();
    if (/google[\\/]chrome[\\/]user data/i.test(ud)) {
      forcedPath = systemChromeCandidates().find((p) => fs.existsSync(p)) || "";
      if (forcedPath) log("inferred system Chrome from user-data-dir", forcedPath);
    } else {
      const portable = findChromePortableExe(browserEnv);
      if (portable) {
        forcedPath = portable;
        log("inferred Portable from user-data-dir", portable);
      }
    }
  }

  // Last resort auto-detect (prefer path matching profile kind already saved)
  if (!forcedPath || !fs.existsSync(forcedPath)) {
    const ud = String(
      browserEnv.FB_CHROME_USER_DATA_DIR || process.env.FB_CHROME_USER_DATA_DIR || ""
    ).trim();
    const wantSystem = /google[\\/]chrome[\\/]user data/i.test(ud);
    if (!wantSystem) {
      const portable = findChromePortableExe(browserEnv);
      if (portable) {
        forcedPath = portable;
        log("auto-found Portable", portable);
      }
    }
    if (!forcedPath || !fs.existsSync(forcedPath)) {
      const systemChrome = systemChromeCandidates().find((p) => fs.existsSync(p));
      if (systemChrome) {
        forcedPath = systemChrome;
        log("auto-found system Chrome", systemChrome);
      }
    }
  }

  if (forcedPath && fs.existsSync(forcedPath)) {
    const plan = resolveChromeLaunchPlan(forcedPath, browserEnv);
    if (plan.missingLauncher || !plan.exe) {
      if (authSensitive) {
        try {
          dialog.showMessageBoxSync(mainWindow || undefined, {
            type: "error",
            title: "Thiếu ChromePortable.exe",
            message: "Không tìm thấy ChromePortable.exe",
            detail:
              "Thư mục Portable thiếu launcher.\n" +
              "Hãy chọn lại profile Portable (quét Chrome) hoặc trỏ FB_BROWSER_PATH tới ChromePortable.exe.\n" +
              "Không mở chrome.exe trong App\\Chrome-bin (gây logout / profile trống).",
            buttons: ["OK"],
          });
        } catch {
          /* ignore */
        }
      }
      log("openInPreferredBrowser FAIL — portable missing launcher");
      if (authSensitive) return false;
    } else {
      // Recover Portable/system profile after crash (flash-then-exit)
      if (plan.userData) {
        clearStaleChromeSingletonLocks(plan.userData);
      } else if (plan.portable) {
        const root =
          findChromePortableRoot(plan.exe) || path.dirname(plan.exe);
        const ud = findPortableUserDataDir(root);
        if (ud) clearStaleChromeSingletonLocks(ud);
      }
      // System Chrome already open → profile-directory often ignored (singleton)
      if (
        authSensitive &&
        !plan.portable &&
        plan.profile &&
        isChromeRunningForUserData(plan.userData || "")
      ) {
        log(
          "WARN system Chrome already running — profile may open in active tab, not",
          plan.profile
        );
        try {
          const choice = dialog.showMessageBoxSync(mainWindow || undefined, {
            type: "warning",
            title: "Chrome đang mở",
            message: "Chrome gốc đang chạy — có thể mở sai profile",
            detail:
              `Bạn đã chọn profile «${plan.profile}».\n\n` +
              "Chrome đang mở thường mở URL ở profile hiện tại (bỏ qua --profile-directory).\n\n" +
              "Cách chắc chắn:\n" +
              "1) Đóng hết cửa sổ Chrome gốc\n" +
              "2) Connect lại\n\n" +
              "Hoặc dùng Chrome Portable riêng cho tool.",
            buttons: ["Tiếp tục mở", "Hủy"],
            defaultId: 0,
            cancelId: 1,
          });
          if (choice === 1) {
            log("user cancelled open — Chrome already running");
            return false;
          }
        } catch {
          /* dialog unavailable — continue */
        }
      }
      try {
        const spawnArgs = [...plan.args, url];
        spawn(plan.exe, spawnArgs, {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          cwd: plan.portable ? path.dirname(plan.exe) : undefined,
        }).unref();
        log(
          "openInPreferredBrowser OK",
          plan.portable ? "PORTABLE" : "SYSTEM",
          plan.exe,
          `profile=${plan.profile || "Default"}`,
          plan.userData ? `data=${plan.userData}` : "data=launcher",
          url.slice(0, 70)
        );
        return true;
      } catch (e) {
        log("openInPreferredBrowser spawn fail", e.message);
      }
    }
  }

  if (authSensitive) {
    try {
      dialog.showMessageBoxSync(mainWindow || undefined, {
        type: "error",
        title: "Chưa cấu hình Chrome",
        message: "Không mở được Chrome / profile đã chọn",
        detail:
          "Vào «Kết nối Meta» → quét Chrome → chọn profile (gốc hoặc Portable) → «Dùng profile này».\n\n" +
          "Cần lưu được:\n" +
          "FB_BROWSER_PATH=...\\chrome.exe  hoặc  ...\\ChromePortable.exe\n" +
          "FB_CHROME_PROFILE=Default  (hoặc Profile 1, …)\n" +
          "FB_CHROME_USER_DATA_DIR=...\\User Data  (Chrome gốc) hoặc ...\\Data\\profile (Portable)",
        buttons: ["OK"],
      });
    } catch {
      /* ignore */
    }
    log("openInPreferredBrowser FAIL — no browser exe");
    return false;
  }

  shell.openExternal(url).catch((e) => log("openExternal fail", e.message));
  return true;
}

function waitForServer(port, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/health", timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) resolve();
          else if (Date.now() - start > timeoutMs)
            reject(new Error("Server health timeout"));
          else setTimeout(tryOnce, 400);
        }
      );
      req.on("error", () => {
        if (Date.now() - start > timeoutMs)
          reject(
            new Error(
              `Server start timeout port ${port}. Xem log: ${logFile || "?"}`
            )
          );
        else setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

function startBackend() {
  USER_DIR = findUserDirWithEnv();
  log("USER_DIR", USER_DIR);
  log("appRoot", appRoot());
  log("execPath", process.execPath);
  log("isPackaged", String(app.isPackaged));

  // Ensure dirs
  for (const sub of [
    "data",
    "data/media/inbox",
    "data/media/posted",
    "data/media/captions",
    "data/exports",
  ]) {
    try {
      fs.mkdirSync(path.join(USER_DIR, sub), { recursive: true });
    } catch {
      /* ignore */
    }
  }

  // Seed standard customer .env (HTTPS OAuth relay) before backend starts.
  // Setup installs write to AppData; portable writes beside the outer EXE.
  try {
    seedCustomerEnvInUserDir(USER_DIR);
  } catch (e) {
    log("seedCustomerEnv fail", e.message);
  }
  try {
    healChromeSessionEnv(USER_DIR);
  } catch (e) {
    log("healChromeSessionEnv fail", e.message);
  }

  const envPath = path.join(USER_DIR, ".env");
  if (!fs.existsSync(envPath)) {
    log("WARN missing .env at", envPath);
  } else {
    log("Found .env");
    dotenv.config({ path: envPath, override: true, quiet: true });
    PORT = Number(process.env.PORT || 3847);
    log("Loaded .env PORT", String(PORT));
    log("FB_REDIRECT_URI", process.env.FB_REDIRECT_URI || "");
    log("OAUTH_RELAY", process.env.OAUTH_RELAY || "");
    log(
      "Chrome session",
      process.env.FB_CHROME_USER_DATA_DIR
        ? `FORCED data=${process.env.FB_CHROME_USER_DATA_DIR}`
        : "openExternal (safe)"
    );
  }

  const serverJs = path.join(appRoot(), "src", "server.js");
  log("serverJs", serverJs);

  // Portable (electron-builder): real .exe is on disk, process.execPath is TEMP extract.
  // Update must replace the ON-DISK portable file — never the Temp path.
  const outerExe = resolveOuterPortableExe(USER_DIR);
  log("FB_OUTER_EXE", outerExe);
  log("PORTABLE_EXECUTABLE_DIR", process.env.PORTABLE_EXECUTABLE_DIR || "");
  log("PORTABLE_EXECUTABLE_FILE", process.env.PORTABLE_EXECUTABLE_FILE || "");

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    OPEN_BROWSER: "0",
    ELECTRON_RUN: "1",
    APP_PACKAGED: app.isPackaged ? "1" : "0",
    ELECTRON_APP_PATH: appRoot(),
    FB_USER_DIR: USER_DIR,
    FB_EXE_DIR: USER_DIR,
    FB_OUTER_EXE: outerExe,
    PORT: String(PORT),
  };

  // Run server with Electron binary as Node (matches native module ABI)
  serverProc = spawn(process.execPath, [serverJs], {
    env,
    cwd: USER_DIR,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });

  serverProc.stdout.on("data", (d) => log("SRV", d.toString().trim()));
  serverProc.stderr.on("data", (d) => log("ERR", d.toString().trim()));
  serverProc.on("exit", (code) => {
    log("Server exit", String(code));
    // Unexpected death: one auto-restart so customer machines don't stay dead UI
    if (app.isQuitting || applyingUpdate) return;
    if (backendRestartAttempts >= 2) {
      log("backend restart exhausted");
      try {
        dialog.showMessageBoxSync(mainWindow || undefined, {
          type: "error",
          title: "Backend dừng",
          message: "Server tool đã tắt bất ngờ",
          detail:
            `Mã thoát: ${code}\n\nĐóng app mở lại. Log: ${logFile || "?"}`,
          buttons: ["OK"],
        });
      } catch {
        /* ignore */
      }
      return;
    }
    backendRestartAttempts += 1;
    log("backend auto-restart attempt", String(backendRestartAttempts));
    setTimeout(() => {
      if (app.isQuitting || applyingUpdate) return;
      startBackend()
        .then(() => {
          log("backend restarted OK");
          backendRestartAttempts = 0;
        })
        .catch((e) => log("backend restart fail", e.message));
    }, 1200);
  });
  serverProc.on("error", (e) => log("Server spawn error", e.message));
  serverProc.on("message", (msg) => {
    if (msg?.type !== "fbps-apply-update" || !msg.batPath) return;
    const batPath = path.resolve(String(msg.batPath));
    const cwd = path.resolve(String(msg.cwd || USER_DIR));
    // Only a staged update BAT beside this portable app may request shutdown.
    if (path.basename(batPath) !== "_apply_update.bat" || path.dirname(batPath) !== cwd) {
      log("Ignored invalid update restart request", batPath);
      return;
    }
    log("Update ready; Electron will quit before replacement", batPath);
    if (applyingUpdate) return;
    applyingUpdate = true;
    setTimeout(() => {
      try {
        spawn("cmd.exe", ["/c", batPath], {
          detached: true,
          stdio: "ignore",
          cwd,
          windowsHide: true,
        }).unref();
      } catch (e) {
        log("Update BAT spawn error", e.message);
        return;
      }
      shutdownBackend();
      // Portable Electron may keep the outer EXE locked when a renderer/tray
      // delays normal app.quit(). Destroy all UI resources, then terminate the
      // Electron process immediately so the hidden updater can replace the EXE.
      try { if (tray) { tray.destroy(); tray = null; } } catch { /* ignore */ }
      try {
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
      } catch { /* ignore */ }
      app.exit(0);
    }, 150);
  });

  return waitForServer(PORT);
}

function createWindow() {
  const icon = loadAppIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: `FB Page Studio v${app.getVersion()}`,
    icon,
    backgroundColor: "#07090f",
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const url = `http://127.0.0.1:${PORT}/app.html`;
  log("loadURL", url);
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    log("preload-error", preloadPath, error?.message || String(error));
  });
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents
      .executeJavaScript("typeof window.fbPageStudioDesktop?.pickFolder")
      .then((kind) => log("folder picker bridge", kind))
      .catch((error) => log("folder picker bridge check failed", error.message));
  });
  mainWindow.loadURL(url);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, validatedURL) => {
    log("did-fail-load", String(code), desc, validatedURL);
    const html = `<!DOCTYPE html><html><body style="margin:0;font-family:Segoe UI,sans-serif;background:#0f1115;color:#e8eaed;padding:2rem">
      <h1 style="color:#1877f2">FB Page Studio</h1>
      <h2>Không tải được giao diện</h2>
      <p>${desc} (code ${code})</p>
      <p>URL: ${validatedURL}</p>
      <p><b>Folder .env / data:</b><br/><code>${USER_DIR || "?"}</code></p>
      <p><b>Log:</b><br/><code>${logFile || "?"}</code></p>
      <p>1) Copy file <b>.env</b> vào folder trên<br/>
         2) Tắt app mở lại<br/>
         3) Bật ngrok nếu Connect FB</p>
      <p><a style="color:#6af" href="${url}">Thử lại</a></p>
    </body></html>`;
    mainWindow.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(html)
    );
  });

  // OAuth / Facebook → Chrome (or Edge) so existing login tabs/session are reused
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    openInPreferredBrowser(u);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (e, navUrl) => {
    try {
      const u = new URL(navUrl);
      const isLocal =
        u.hostname === "127.0.0.1" || u.hostname === "localhost";
      // Connect flow → preferred browser (Chrome first) for password + 2FA + logged-in session
      if (isLocal && u.pathname.startsWith("/auth/facebook")) {
        e.preventDefault();
        const appQ = u.searchParams.get("app") || "app1";
        openInPreferredBrowser(
          `http://127.0.0.1:${PORT}/auth/facebook?external=1&app=${encodeURIComponent(appQ)}`
        );
        return;
      }
      if (isLocal) return;
      // Never let an external origin replace the trusted local dashboard.
      e.preventDefault();
      openInPreferredBrowser(navUrl);
    } catch {
      e.preventDefault();
    }
  });

  // Close to tray — do not destroy process while bulk jobs may still run.
  mainWindow.on("close", (e) => {
    if (!app.isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
      log("window hide to tray (job backend stays alive)");
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("fbps:pick-folder", async (_event, options = {}) => {
  const title = String(options.title || "Chọn thư mục").slice(0, 180);
  let defaultPath = String(options.initialDir || "").trim();
  if (defaultPath && !fs.existsSync(defaultPath)) defaultPath = path.dirname(defaultPath);
  if (!defaultPath || !fs.existsSync(defaultPath)) defaultPath = USER_DIR || app.getPath("documents");

  const dialogOptions = {
    title,
    defaultPath,
    buttonLabel: "Chọn thư mục này",
    properties: ["openDirectory", "createDirectory", ...(options.multiple ? ["multiSelections"] : [])],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || !result.filePaths?.[0]) {
    return { ok: false, cancelled: true, path: null };
  }
  const paths = result.filePaths.map((item) => path.resolve(item));
  return { ok: true, cancelled: false, path: paths[0], paths };
});

function createTray() {
  const icon = loadAppIcon();
  if (!icon) return;
  let trayIcon = icon;
  try {
    trayIcon = icon.resize({ width: 16, height: 16 });
  } catch {
    /* ignore */
  }
  tray = new Tray(trayIcon.isEmpty() ? icon : trayIcon);
  tray.setToolTip(`FB Page Studio v${app.getVersion()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Mở app",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else createWindow();
        },
      },
      {
        label: "Mở folder .env / data",
        click: () => shell.openPath(USER_DIR || path.dirname(process.execPath)),
      },
      {
        label: "Mở log startup",
        click: () => {
          if (logFile) shell.openPath(logFile);
        },
      },
      { type: "separator" },
      {
        label: "Thoát",
        click: () => {
          shutdownBackend();
          app.quit();
        },
      },
    ])
  );
}

const ownVersion = app.getVersion();
const gotLock = app.requestSingleInstanceLock({
  version: ownVersion,
  executable: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
});
if (!gotLock) {
  // Without this warning, opening a newly downloaded EXE only focuses the
  // already-running old build, making the user believe the download is stale.
  dialog.showErrorBox(
    `FB Page Studio v${ownVersion}`,
    `Đang có một phiên bản FB Page Studio khác chạy nền.\n\n` +
      `Hãy Thoát tool ở khay hệ thống hoặc tắt toàn bộ tiến trình FB Page Studio trong Task Manager, rồi mở lại file v${ownVersion}.`
  );
  app.exit(0);
} else {
  app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
    const requestedVersion = String(additionalData?.version || "").trim();
    if (requestedVersion && requestedVersion !== ownVersion) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: "warning",
        title: "Đang chạy phiên bản cũ",
        message: `Tool đang chạy là v${ownVersion}, nhưng bạn vừa mở EXE v${requestedVersion}.`,
        detail: "Hãy Thoát tool hoàn toàn ở khay hệ thống, sau đó mở lại file EXE phiên bản mới.",
      });
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === "win32") {
      app.setAppUserModelId("com.fbpagestudio.app");
    }
    try {
      await startBackend();
      createWindow();
      createTray();
      {
        const envPath = path.join(USER_DIR || "", ".env");
        let redirect = "";
        try {
          const t = fs.readFileSync(envPath, "utf8");
          redirect = (t.match(/^FB_REDIRECT_URI=(.*)$/m) || [])[1] || "";
        } catch {
          /* ignore */
        }
        if (!fs.existsSync(envPath) || /localhost|127\.0\.0\.1|^http:\/\//i.test(redirect)) {
          dialog.showMessageBox({
            type: "info",
            title: "Cấu hình OAuth (HTTPS)",
            message:
              "Không cần tự tạo file .env.\n\n" +
              "Tool dùng domain HTTPS để login Facebook (không dùng http://localhost).\n\n" +
              "Chuẩn: OAUTH_RELAY + https://modelswiki.top/auth/facebook/callback\n" +
              "App Secret nằm trên server relay — máy này không cần nhập secret.\n\n" +
              "File .env đã được tạo/sửa trong thư mục dữ liệu. Chỉ cần Connect Facebook.",
            detail: `Thư mục .env / data:\n${USER_DIR}\n\nRedirect:\nhttps://modelswiki.top/auth/facebook/callback`,
          });
        }
      }
    } catch (e) {
      log("FATAL", e.message);
      dialog.showErrorBox(
        "FB Page Studio",
        `${e.message}\n\nUser dir: ${USER_DIR}\nLog: ${logFile || "?"}`
      );
      shutdownBackend();
      app.quit();
    }
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    shutdownBackend();
  });

  // Tray app: closing the window must NOT kill backend mid-job (bulk delete).
  // User exits only via tray "Thoát".
  app.on("window-all-closed", (e) => {
    if (process.platform === "darwin") return;
    if (tray) {
      // keep process alive in tray
      return;
    }
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
