/**
 * Paths for: dev · Electron desktop (packaged) · caxa
 * - Bundle (code/public): app root / asar
 * - User data (.env, data/): folder containing .env next to exe (walk up if needed)
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function isElectron() {
  return Boolean(process.versions?.electron || process.env.ELECTRON_RUN);
}

export function isPackaged() {
  return (
    Boolean(process.env.CAXA) ||
    Boolean(process.pkg) ||
    process.env.APP_PACKAGED === "1" ||
    process.env.APP_PACKAGED === "true"
  );
}

function dirHasEnv(dir) {
  try {
    return fs.existsSync(path.join(dir, ".env"));
  } catch {
    return false;
  }
}

/** Walk up from start looking for .env (max 6 levels) */
function findEnvDir(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (dirHasEnv(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Writable user directory (.env + data/)
 */
export function getExeDir() {
  if (process.env.FB_USER_DIR) return path.resolve(process.env.FB_USER_DIR);
  if (process.env.FB_EXE_DIR) return path.resolve(process.env.FB_EXE_DIR);

  // Explicit search roots
  const roots = [];
  if (process.execPath) roots.push(path.dirname(process.execPath));
  if (process.cwd()) roots.push(process.cwd());
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    roots.push(process.env.PORTABLE_EXECUTABLE_DIR);
  }
  // Electron portable often runs from temp; also check parent of exec
  if (process.execPath) {
    roots.push(path.dirname(path.dirname(process.execPath)));
  }

  for (const r of roots) {
    const found = findEnvDir(r);
    if (found) return found;
  }

  // Packaged without .env yet → beside exe
  if (isPackaged() || isElectron()) {
    return path.dirname(process.execPath);
  }

  // Dev: project root (src/..)
  return path.resolve(__dirname, "..");
}

/** Read-only app bundle (source + public) */
export function getBundleRoot() {
  if (process.env.ELECTRON_APP_PATH) {
    return path.resolve(process.env.ELECTRON_APP_PATH);
  }
  if (process.env.CAXA) return path.resolve(process.env.CAXA);
  // src/ is inside bundle; parent is app root (or asar root)
  return path.resolve(__dirname, "..");
}

export function getDataDir() {
  if (process.env.DATABASE_PATH) {
    return path.dirname(path.resolve(process.env.DATABASE_PATH));
  }
  return path.join(getExeDir(), "data");
}

export function getPublicDir() {
  const root = getBundleRoot();
  const p = path.join(root, "public");
  if (fs.existsSync(p)) return p;
  // fallback
  return path.join(path.resolve(__dirname, ".."), "public");
}

export function getEnvPath() {
  const beside = path.join(getExeDir(), ".env");
  if (fs.existsSync(beside)) return beside;
  const inBundle = path.join(getBundleRoot(), ".env");
  if (fs.existsSync(inBundle)) return inBundle;
  // last resort: walk from cwd/exec again
  const found = findEnvDir(process.cwd()) || findEnvDir(path.dirname(process.execPath));
  if (found) return path.join(found, ".env");
  return beside;
}

export function getPackageJson() {
  try {
    const p = path.join(getBundleRoot(), "package.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    try {
      return JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")
      );
    } catch {
      return { name: "fb-page-studio", version: "0.0.0" };
    }
  }
}

export function getOuterExePath() {
  // Set by Electron main for portable — must be ON-DISK file, not Temp extract
  if (process.env.FB_OUTER_EXE && fs.existsSync(process.env.FB_OUTER_EXE)) {
    return path.resolve(process.env.FB_OUTER_EXE);
  }
  if (
    process.env.PORTABLE_EXECUTABLE_FILE &&
    fs.existsSync(process.env.PORTABLE_EXECUTABLE_FILE)
  ) {
    return path.resolve(process.env.PORTABLE_EXECUTABLE_FILE);
  }
  const names = [
    "FB-Page-Studio-Desktop.exe",
    "FB-Page-Studio.exe",
    "FB Page Studio.exe",
  ];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    for (const n of names) {
      const c = path.join(process.env.PORTABLE_EXECUTABLE_DIR, n);
      if (fs.existsSync(c)) return path.resolve(c);
    }
  }
  const dir = getExeDir();
  for (const n of names) {
    const c = path.join(dir, n);
    if (fs.existsSync(c)) return c;
  }
  // Never prefer Temp extract path for updates
  if (process.execPath && !/[\\/]Temp[\\/]/i.test(process.execPath)) {
    return process.execPath;
  }
  return path.join(dir, "FB-Page-Studio-Desktop.exe");
}

/** Debug snapshot for /api/debug/paths */
export function debugPaths() {
  return {
    cwd: process.cwd(),
    execPath: process.execPath,
    electron: isElectron(),
    packaged: isPackaged(),
    exeDir: getExeDir(),
    bundleRoot: getBundleRoot(),
    dataDir: getDataDir(),
    publicDir: getPublicDir(),
    envPath: getEnvPath(),
    envExists: fs.existsSync(getEnvPath()),
    electronAppPath: process.env.ELECTRON_APP_PATH || null,
    fbUserDir: process.env.FB_USER_DIR || null,
  };
}
