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
} = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

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

function appRoot() {
  try {
    return app.getAppPath();
  } catch {
    return path.join(__dirname, "..");
  }
}

function findUserDirWithEnv() {
  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR,
    process.env.FB_USER_DIR,
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
function resolveOuterPortableExe(userDir) {
  const names = [
    "FB-Page-Studio-Desktop.exe",
    "FB-Page-Studio.exe",
    "FB Page Studio.exe",
  ];
  // 1) Official portable env (electron-builder)
  if (
    process.env.PORTABLE_EXECUTABLE_FILE &&
    fs.existsSync(process.env.PORTABLE_EXECUTABLE_FILE)
  ) {
    return path.resolve(process.env.PORTABLE_EXECUTABLE_FILE);
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    const dir = process.env.PORTABLE_EXECUTABLE_DIR;
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return path.resolve(p);
    }
  }
  // 2) Next to data/.env folder (USER_DIR)
  if (userDir) {
    for (const n of names) {
      const p = path.join(userDir, n);
      if (fs.existsSync(p)) return path.resolve(p);
    }
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

/**
 * Open OAuth / external URL in a real browser that keeps Facebook login cookies.
 * Prefer Chrome (user usually has tabs logged in) → Edge → Firefox → system default.
 * Opening chrome.exe with a URL reuses the running Chrome instance + profile.
 */
function openInPreferredBrowser(url) {
  const browserEnv = readBrowserEnv();
  const candidates = [];
  if (browserEnv.BROWSER_PATH || process.env.BROWSER_PATH) candidates.push(browserEnv.BROWSER_PATH || process.env.BROWSER_PATH);
  if (browserEnv.FB_BROWSER_PATH || process.env.FB_BROWSER_PATH) candidates.push(browserEnv.FB_BROWSER_PATH || process.env.FB_BROWSER_PATH);

  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  // Prefer Chrome first (Facebook sessions often live here)
  candidates.push(
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome Beta", "Application", "chrome.exe"),
    // Edge
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    // Firefox
    path.join(pf, "Mozilla Firefox", "firefox.exe"),
    path.join(pf86, "Mozilla Firefox", "firefox.exe")
  );

  for (const exe of candidates) {
    if (!exe || !fs.existsSync(exe)) continue;
    try {
      const isChrome = /(?:^|\\)chrome(?:\.exe)?$/i.test(exe);
      const profile = String(browserEnv.FB_CHROME_PROFILE || process.env.FB_CHROME_PROFILE || "").trim();
      // Supplying only --profile-directory is unreliable when Chrome is already
      // running: Windows can forward the URL to a different active Chrome
      // instance.  Always bind the launch to the real Chrome User Data root,
      // then select its exact profile folder.  This preserves that profile's
      // Facebook cookies (unless the user deliberately configured another root).
      const userData = String(
        browserEnv.FB_CHROME_USER_DATA_DIR ||
        process.env.FB_CHROME_USER_DATA_DIR ||
        path.join(local, "Google", "Chrome", "User Data")
      ).trim();
      // Chrome does not allow an external app to take over the active tab.
      // Passing the profile opens a new tab with that profile's FB cookies.
      const args = isChrome && profile
        ? [
            ...(userData ? [`--user-data-dir=${userData}`] : []),
            `--profile-directory=${profile}`,
            url,
          ]
        : [url];
      spawn(exe, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }).unref();
      log("openInPreferredBrowser", exe, profile ? `profile=${profile}` : "profile=auto", url.slice(0, 80));
      return true;
    } catch (e) {
      log("openInPreferredBrowser fail", exe, e.message);
    }
  }

  // Fallback: Windows default association
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
      if (serverProc && !serverProc.killed) {
        try { serverProc.kill(); } catch { /* ignore */ }
      }
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
    title: "FB Page Studio",
    icon,
    backgroundColor: "#07090f",
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const url = `http://127.0.0.1:${PORT}/app.html`;
  log("loadURL", url);
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
      // Facebook / ngrok OAuth
      if (
        u.hostname.includes("facebook.com") ||
        u.hostname.includes("fb.com") ||
        u.hostname.includes("ngrok") ||
        u.pathname.includes("/auth/facebook")
      ) {
        e.preventDefault();
        openInPreferredBrowser(navUrl);
      }
    } catch {
      /* ignore */
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

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
  tray.setToolTip("FB Page Studio");
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
          if (serverProc && !serverProc.killed) serverProc.kill();
          app.quit();
        },
      },
    ])
  );
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
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
          type: "warning",
          title: "Thiếu .env",
          message: `Đặt file .env vào:\n${USER_DIR}\n\nCần FB_APP_ID, FB_APP_SECRET, APP_BASE_URL, FB_REDIRECT_URI`,
        });
      }
    } catch (e) {
      log("FATAL", e.message);
      dialog.showErrorBox(
        "FB Page Studio",
        `${e.message}\n\nUser dir: ${USER_DIR}\nLog: ${logFile || "?"}`
      );
      if (serverProc && !serverProc.killed) serverProc.kill();
      app.quit();
    }
  });

  app.on("before-quit", () => {
    if (serverProc && !serverProc.killed) {
      try {
        serverProc.kill();
      } catch {
        /* ignore */
      }
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
