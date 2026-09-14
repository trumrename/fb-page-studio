/**
 * Build Setup (NSIS) trên ổ F: only.
 * Tránh ổ C đầy → NSIS "can't write ... bytes to output".
 *
 *   node scripts/build-desktop.mjs --nsis          (mặc định — bản Setup)
 *   node scripts/build-desktop.mjs --portable      (tuỳ chọn)
 *   node scripts/build-desktop.mjs --nsis --portable
 *
 * Env:
 *   FBPS_BUILD_OUT=F:/FB-Page-Studio/dist-desktop-oauth
 *   FBPS_BUILD_TEMP=F:/FB-Page-Studio/temp
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const wantNsis = args.includes("--nsis") || (!args.includes("--portable") && !args.includes("--nsis"));
const wantPortable = args.includes("--portable");

function pickOutDir() {
  if (process.env.FBPS_BUILD_OUT) return path.resolve(process.env.FBPS_BUILD_OUT);
  // Chỉ F: (không mirror E:)
  for (const candidate of [
    "F:/FB-Page-Studio/dist-desktop-oauth",
    path.join(root, "dist-desktop-oauth"),
  ]) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const test = path.join(candidate, ".write-test");
      fs.writeFileSync(test, "ok");
      fs.unlinkSync(test);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return path.join(root, "dist-desktop-oauth");
}

function pickTempDir(outDir) {
  if (process.env.FBPS_BUILD_TEMP) {
    const t = path.resolve(process.env.FBPS_BUILD_TEMP);
    fs.mkdirSync(t, { recursive: true });
    return t;
  }
  const rootDrive = path.parse(outDir).root; // e.g. F:\
  const t = path.join(rootDrive, "FB-Page-Studio", "temp");
  try {
    fs.mkdirSync(t, { recursive: true });
    return t;
  } catch {
    const fallback = path.join(root, ".build-temp");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const outDir = pickOutDir();
const tempDir = pickTempDir(outDir);
const cacheDir = path.join(path.parse(outDir).root, "FB-Page-Studio", "electron-builder-cache");

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });
try {
  fs.mkdirSync(cacheDir, { recursive: true });
} catch {
  /* optional */
}

console.log(`\n📦 Desktop build`);
console.log(`   output : ${outDir}`);
console.log(`   TEMP   : ${tempDir}`);
console.log(`   targets: ${[wantNsis && "nsis", wantPortable && "portable"].filter(Boolean).join(", ")}\n`);

const ebArgs = [
  "electron-builder",
  "--config.npmRebuild=false",
  `--config.directories.output=${outDir.replace(/\\/g, "/")}`,
  "--win",
  "x64",
];
if (wantNsis) ebArgs.push("--config.win.target=nsis");
if (wantPortable) {
  // when both, electron-builder uses yml targets; force via CLI list
  if (!wantNsis) ebArgs.push("--config.win.target=portable");
}

// If only one target, override yml multi-target cleanly:
const finalArgs = [
  "electron-builder",
  "--config.npmRebuild=false",
  `--config.directories.output=${outDir.replace(/\\/g, "/")}`,
  "--win",
];
if (wantNsis && wantPortable) {
  finalArgs.push("--x64");
  // use yml both targets — already in electron-builder.yml
} else if (wantNsis) {
  finalArgs.push("nsis", "--x64");
} else if (wantPortable) {
  finalArgs.push("portable", "--x64");
}

const env = {
  ...process.env,
  TEMP: tempDir,
  TMP: tempDir,
  TMPDIR: tempDir,
  ELECTRON_BUILDER_CACHE: cacheDir,
  // Avoid signing noise / hangs
  CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY || "false",
};

const r = spawnSync("npx", finalArgs, {
  cwd: root,
  env,
  stdio: "inherit",
  shell: true,
});

if (r.status !== 0) {
  console.error("\n❌ Build failed. Check disk space on output drive.");
  process.exit(r.status || 1);
}

// List artifacts
console.log("\n✅ Artifacts:");
for (const name of fs.readdirSync(outDir)) {
  if (!/\.(exe|yml|yaml|blockmap)$/i.test(name)) continue;
  const p = path.join(outDir, name);
  const st = fs.statSync(p);
  if (!st.isFile()) continue;
  console.log(`   ${p}  (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
}

// Setup-only: copy bản Setup sang F:\FB-Page-Studio\Setup\ (1 chỗ lấy file)
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const setupName = `FB-Page-Studio-Setup-v${pkg.version}.exe`;
  const setupSrc = path.join(outDir, setupName);
  if (fs.existsSync(setupSrc)) {
    const setupDir = "F:\\FB-Page-Studio\\Setup";
    fs.mkdirSync(setupDir, { recursive: true });
    const dest = path.join(setupDir, setupName);
    fs.copyFileSync(setupSrc, dest);
    const stable = path.join(setupDir, "FB-Page-Studio-Setup.exe");
    fs.copyFileSync(setupSrc, stable);
    console.log(`\n📎 Setup (lấy tại đây): ${dest}`);
    console.log(`   Stable latest: ${stable}`);
  }
} catch (e) {
  console.warn("Copy Setup folder skipped:", e.message);
}

console.log("\nDone.\n");
