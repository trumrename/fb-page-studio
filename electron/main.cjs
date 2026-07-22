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
 * Only delete when no chrome.exe is running (never steal a live lock).
 */
function clearStaleChromeSingletonLocks(userDataDir) {
  if (!userDataDir || !fs.existsSync(userDataDir)) return [];
  if (isChromeProcessRunning()) {
    log("chrome lock: skip clear (chrome.exe still running)", userDataDir);
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
 * Build launch plan so Portable and system Chrome never cross user-data roots.
 * Root cause of "tool login OK, hand-open Portable flashes": tool used to spawn
 * App\Chrome-bin\chrome.exe with --user-data-dir=%LocalAppData%\...\User Data
 * (system), locking the wrong tree / leaving Singleton* that Portable launcher
 * then cannot open.
 */
function resolveChromeLaunchPlan(rawExe, browserEnv) {
  const local = process.env.LOCALAPPDATA || "";
  const systemUserData = path.join(local, "Google", "Chrome", "User Data");
  const profile = String(browserEnv.FB_CHROME_PROFILE || process.env.FB_CHROME_PROFILE || "").trim();
  let configuredData = String(
    browserEnv.FB_CHROME_USER_DATA_DIR || process.env.FB_CHROME_USER_DATA_DIR || ""
  ).trim();

  let exe = rawExe;
  const portableRoot =
    findChromePortableRoot(rawExe) ||
    (/chromeportable\.exe$/i.test(rawExe) ? path.dirname(path.resolve(rawExe)) : null);

  // Prefer real chrome.exe under Portable for reliable --profile-directory.
  if (/chromeportable\.exe$/i.test(rawExe) || portableRoot) {
    const root = portableRoot || path.dirname(path.resolve(rawExe));
    const realChrome = [
      path.join(root, "App", "Chrome-bin", "chrome.exe"),
      path.join(root, "App", "Chrome", "chrome.exe"),
      path.join(root, "chrome.exe"),
    ].find((candidate) => fs.existsSync(candidate));
    if (realChrome) exe = realChrome;
  }

  const base = path.basename(exe).toLowerCase();
  const isChrome = base === "chrome.exe" || base === "chromeportable.exe";
  if (!isChrome) {
    return { exe, args: [], isChrome: false, userData: "", profile: "", portable: false };
  }

  let userData = "";
  const isPortable = Boolean(portableRoot || /chromeportable/i.test(rawExe) || /chromeportable/i.test(exe));

  if (isPortable) {
    const portableData = findPortableUserDataDir(portableRoot || path.dirname(path.resolve(rawExe)));
    // Explicit config only when it is still a real profile root and NOT system Chrome.
    // Mis-saved system User Data + portable chrome.exe is the main "flash then exit" root cause.
    if (configuredData && looksLikeChromeUserDataRoot(configuredData)) {
      const resolved = path.resolve(configuredData);
      const root = portableRoot ? path.resolve(portableRoot) : "";
      const underPortable =
        root &&
        (resolved.toLowerCase() === root.toLowerCase() ||
          resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep));
      const isSystem =
        resolved.toLowerCase() === systemUserData.toLowerCase() ||
        /[\\/]google[\\/]chrome[\\/]user data$/i.test(resolved);
      if (isSystem) {
        log("chrome portable: ignore system FB_CHROME_USER_DATA_DIR, use", portableData);
        userData = portableData;
      } else if (underPortable || looksLikeChromeUserDataRoot(resolved)) {
        userData = resolved;
      } else {
        log("chrome portable: configured data invalid, use", portableData);
        userData = portableData;
      }
    } else {
      userData = portableData;
    }
  } else {
    userData = configuredData
      ? path.resolve(configuredData)
      : systemUserData;
  }

  // Stale locks only when Chrome is fully stopped (safe).
  if (userData) clearStaleChromeSingletonLocks(userData);

  const args = [
    ...(userData ? [`--user-data-dir=${userData}`] : []),
    ...(profile ? [`--profile-directory=${profile}`] : []),
  ];

  return {
    exe,
    args,
    isChrome: true,
    userData,
    profile,
    portable: isPortable,
  };
}

/**
 * Open OAuth / external URL in a real browser that keeps Facebook login cookies.
 * Prefer Chrome (user usually has tabs logged in) → Edge → Firefox → system default.
 *
 * Portable-safe: bind --user-data-dir to ChromePortable\Data\… never system User Data.
 */
function openInPreferredBrowser(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    log("openInPreferredBrowser blocked invalid URL");
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    log("openInPreferredBrowser blocked protocol", parsed.protocol);
    return false;
  }
  url = parsed.toString();
  const browserEnv = readBrowserEnv();
  const candidates = [];
  if (browserEnv.BROWSER_PATH || process.env.BROWSER_PATH) {
    candidates.push(browserEnv.BROWSER_PATH || process.env.BROWSER_PATH);
  }
  if (browserEnv.FB_BROWSER_PATH || process.env.FB_BROWSER_PATH) {
    candidates.push(browserEnv.FB_BROWSER_PATH || process.env.FB_BROWSER_PATH);
  }

  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  candidates.push(
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome Beta", "Application", "chrome.exe"),
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Mozilla Firefox", "firefox.exe"),
    path.join(pf86, "Mozilla Firefox", "firefox.exe")
  );

  for (const rawExe of candidates) {
    if (!rawExe || !fs.existsSync(rawExe)) continue;
    try {
      const plan = resolveChromeLaunchPlan(rawExe, browserEnv);
      const args = plan.isChrome ? [...plan.args, url] : [url];
      spawn(plan.exe, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }).unref();
      log(
        "openInPreferredBrowser",
        plan.exe,
        plan.portable ? "portable" : "system",
        plan.userData ? `userData=${plan.userData}` : "userData=default",
        plan.profile ? `profile=${plan.profile}` : "profile=auto",
        url.slice(0, 80)
      );
      return true;
    } catch (e) {
      log("openInPreferredBrowser fail", rawExe, e.message);
    }
  }

  shell.openExternal(url).catch((e) => log("openExternal fail", e.message));
  log("openInPreferredBrowser fallback shell.openExternal");
  return false;
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

  const envPath = path.join(USER_DIR, ".env");
  if (!fs.existsSync(envPath)) {
    log("WARN missing .env at", envPath);
  } else {
    log("Found .env");
    dotenv.config({ path: envPath, override: true, quiet: true });
    PORT = Number(process.env.PORT || 3847);
    log("Loaded .env PORT", String(PORT));
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
  serverProc.on("exit", (code) => log("Server exit", String(code)));
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
      if (!fs.existsSync(path.join(USER_DIR, ".env"))) {
        dialog.showMessageBox({
          type: "info",
          title: "Thiết lập máy mới",
          message:
            "Đây là lần chạy đầu tiên. Không cần tự tạo file .env.\n\n" +
            "Vào Kết nối Meta → Bước 1, nhập App ID và App Secret. Tool sẽ tự tạo cấu hình, khóa mã hóa và thư mục data cạnh EXE.",
          detail: `Thư mục lưu dữ liệu:\n${USER_DIR}`,
        });
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
    shutdownBackend();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
