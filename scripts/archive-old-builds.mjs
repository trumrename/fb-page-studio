/**
 * Gom EXE/ZIP/sha bản cũ vào "Tổng Hợp Tool/Luu-Tru-Ban-Cu"
 * — chỉ giữ bản hiện tại (package.json version) trong folder đang dọn.
 *
 *   node scripts/archive-old-builds.mjs
 *   node scripts/archive-old-builds.mjs --dir "Tổng Hợp Tool/pack-internal"
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  PROJECT_ROOT as root,
  packCustomerDir,
  packInternalDir,
  packDevDir,
  releaseAssetsDir,
  archiveVaultDir,
} from "./deliver-paths.mjs";

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const CURRENT = String(pkg.version || "").replace(/^v/i, "");

const EXE_RE =
  /^FB-Page-Studio-Desktop(?:-v(\d+\.\d+\.\d+))?\.exe(?:\.sha256\.txt)?$/i;
const ZIP_RE = /^FB-Page-Studio-v(\d+\.\d+\.\d+)-Windows\.zip(?:\.sha256\.txt)?$/i;
const INTERNAL_ZIP_RE =
  /^FB-Page-Studio-INTERNAL-v(\d+\.\d+\.\d+)(?:-.+)?\.zip(?:\.sha256\.txt)?$/i;
const PACK_INTERNAL_DIR_RE = /^pack-internal-v(\d+\.\d+\.\d+)$/i;

function versionFromName(name) {
  let m = name.match(EXE_RE);
  if (m) return m[1] || null; // unversioned Desktop.exe → null (keep runner)
  m = name.match(ZIP_RE);
  if (m) return m[1];
  m = name.match(INTERNAL_ZIP_RE);
  if (m) return m[1];
  m = name.match(PACK_INTERNAL_DIR_RE);
  if (m) return m[1];
  return undefined; // not a build artifact
}

function isCurrentArtifact(name, currentVersion) {
  const ver = versionFromName(name);
  if (ver === undefined) return true;
  if (ver === null) return true; // unversioned runner
  return ver === currentVersion;
}

function safeMove(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(src);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    dest = path.join(destDir, `${stem}__${stamp}${ext}`);
  }
  try {
    fs.renameSync(src, dest);
    return dest;
  } catch {
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    }
    return dest;
  }
}

/**
 * @param {string} dir
 * @param {{ currentVersion?: string, vault?: string }} [opts]
 */
export function archiveOldInDir(dir, opts = {}) {
  const currentVersion = String(opts.currentVersion || CURRENT).replace(/^v/i, "");
  const vault = opts.vault || archiveVaultDir();
  const moved = [];
  const kept = [];
  const skipped = [];

  if (!dir || !fs.existsSync(dir)) {
    return { moved, kept, skipped };
  }

  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const ver = versionFromName(name);

    if (ver === undefined) {
      skipped.push(name);
      continue;
    }

    if (isCurrentArtifact(name, currentVersion)) {
      kept.push(name);
      continue;
    }

    try {
      const dest = safeMove(full, vault);
      moved.push(`${name} → ${path.relative(root, dest)}`);
    } catch (e) {
      skipped.push(`${name} (locked: ${e.message})`);
    }
  }

  return { moved, kept, skipped };
}

export function archiveAllOldBuilds(currentVersion = CURRENT) {
  const ver = String(currentVersion).replace(/^v/i, "");
  const targets = [
    packInternalDir(),
    packCustomerDir(),
    packDevDir(),
    releaseAssetsDir(),
    path.join(root, "dist-desktop-oauth"),
  ];
  const summary = [];
  for (const dir of targets) {
    const r = archiveOldInDir(dir, { currentVersion: ver });
    summary.push({ dir: path.relative(root, dir), ...r });
  }
  return { vault: archiveVaultDir(), version: ver, summary };
}

const thisFile = path.resolve(fileURLToPath(import.meta.url));
const invoked = process.argv[1] && path.resolve(process.argv[1]) === thisFile;

if (invoked) {
  const dirArgIdx = process.argv.indexOf("--dir");
  if (dirArgIdx >= 0 && process.argv[dirArgIdx + 1]) {
    const raw = process.argv[dirArgIdx + 1];
    const dir = path.isAbsolute(raw) ? raw : path.join(root, raw);
    const r = archiveOldInDir(dir);
    console.log("Vault:", archiveVaultDir());
    console.log("Keep version:", CURRENT);
    console.log("Moved:", r.moved.length ? "\n  " + r.moved.join("\n  ") : "(none)");
    console.log("Kept:", r.kept.join(", ") || "(none)");
    if (r.skipped.some((s) => s.includes("locked"))) {
      console.log("Locked:", r.skipped.filter((s) => s.includes("locked")).join(", "));
    }
  } else {
    const all = archiveAllOldBuilds();
    console.log("Vault:", all.vault);
    console.log("Keep version:", all.version);
    for (const s of all.summary) {
      if (!s.moved.length && !s.kept.length) continue;
      console.log(`\n[${s.dir}]`);
      if (s.moved.length) console.log("  moved:\n    " + s.moved.join("\n    "));
      console.log("  kept:", s.kept.join(", ") || "(none)");
      const locked = s.skipped.filter((x) => x.includes("locked"));
      if (locked.length) console.log("  locked:", locked.join(", "));
    }
  }
}
