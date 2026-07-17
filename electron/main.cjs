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

const PORT = Number(process.env.PORT || 3847);

let mainWindow = null;
let tray = null;
let serverProc = null;
let USER_DIR = null;
let logFile = null;

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

function loadAppIcon() {
  const p =
    iconPath("icon.ico") || iconPath("icon-256.png") || iconPath("icon.png");
  if (!p) return undefined;
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? undefined : img;
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
  }

  const serverJs = path.join(appRoot(), "src", "server.js");
  log("serverJs", serverJs);

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    OPEN_BROWSER: "0",
    ELECTRON_RUN: "1",
    APP_PACKAGED: app.isPackaged ? "1" : "0",
    ELECTRON_APP_PATH: appRoot(),
    FB_USER_DIR: USER_DIR,
    FB_EXE_DIR: USER_DIR,
    FB_OUTER_EXE: process.execPath,
    PORT: String(PORT),
  };

  // Run server with Electron binary as Node (matches native module ABI)
  serverProc = spawn(process.execPath, [serverJs], {
    env,
    cwd: USER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProc.stdout.on("data", (d) => log("SRV", d.toString().trim()));
  serverProc.stderr.on("data", (d) => log("ERR", d.toString().trim()));
  serverProc.on("exit", (code) => log("Server exit", String(code)));
  serverProc.on("error", (e) => log("Server spawn error", e.message));

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

  // Always open OAuth / Facebook in system browser (full 2FA)
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (e, navUrl) => {
    try {
      const u = new URL(navUrl);
      const isLocal =
        u.hostname === "127.0.0.1" || u.hostname === "localhost";
      // Connect flow → system browser so password + 2FA complete in one place
      if (isLocal && u.pathname.startsWith("/auth/facebook")) {
        e.preventDefault();
        shell.openExternal(
          `http://127.0.0.1:${PORT}/auth/facebook?external=1`
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
        shell.openExternal(navUrl);
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
