/**
 * Portable paths for dev vs single-file .exe (caxa).
 * - Code/public: inside caxa extract (CAXA) or project root
 * - User data (.env, data/): folder where user runs the .exe (cwd on double-click)
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function isPackaged() {
  return Boolean(process.env.CAXA) || Boolean(process.pkg);
}

/**
 * Writable dir next to distributed .exe.
 * caxa runs node from a TEMP extract, so argv[0] is NOT the outer exe —
 * on Windows double-click, process.cwd() is the folder containing the .exe.
 */
export function getExeDir() {
  if (process.env.FB_USER_DIR) return path.resolve(process.env.FB_USER_DIR);
  if (process.env.FB_EXE_DIR) return path.resolve(process.env.FB_EXE_DIR);

  if (isPackaged()) {
    const cwd = process.cwd();
    // Prefer folder that already has our exe or .env
    const markers = ["FB-Page-Studio.exe", ".env", ".env.example"];
    if (markers.some((m) => fs.existsSync(path.join(cwd, m)))) {
      return cwd;
    }
    // Walk up a few levels from argv0 looking for the distributed exe
    let dir = path.dirname(path.resolve(process.argv[0] || process.execPath));
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, "FB-Page-Studio.exe"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return cwd;
  }

  return path.resolve(__dirname, "..");
}

/** Read-only app bundle (source + public + node_modules) */
export function getBundleRoot() {
  if (process.env.CAXA) return path.resolve(process.env.CAXA);
  return path.resolve(__dirname, "..");
}

export function getDataDir() {
  if (process.env.DATABASE_PATH) {
    return path.dirname(path.resolve(process.env.DATABASE_PATH));
  }
  return path.join(getExeDir(), "data");
}

export function getPublicDir() {
  return path.join(getBundleRoot(), "public");
}

export function getEnvPath() {
  const beside = path.join(getExeDir(), ".env");
  if (fs.existsSync(beside)) return beside;
  const inBundle = path.join(getBundleRoot(), ".env");
  if (fs.existsSync(inBundle)) return inBundle;
  return beside;
}

export function getPackageJson() {
  try {
    const p = path.join(getBundleRoot(), "package.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { name: "fb-page-studio", version: "0.0.0" };
  }
}

/** Path to the distributed exe for self-update */
export function getOuterExePath() {
  if (process.env.FB_OUTER_EXE && fs.existsSync(process.env.FB_OUTER_EXE)) {
    return path.resolve(process.env.FB_OUTER_EXE);
  }
  const candidate = path.join(getExeDir(), "FB-Page-Studio.exe");
  if (fs.existsSync(candidate)) return candidate;
  return candidate;
}
