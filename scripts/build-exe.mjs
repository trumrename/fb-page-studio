/**
 * Build single-file Windows executable: dist/FB-Page-Studio.exe
 * Uses caxa (embeds Node + app into one .exe).
 *
 *   npm run build:exe
 *   npm run release:zip
 */
import caxa from "caxa";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const staging = path.join(root, "build-staging");
const dist = path.join(root, "dist");
const outExe = path.join(dist, "FB-Page-Studio.exe");
const doZip = process.argv.includes("--zip");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFiltered(src, dest, ignoreNames) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (ignoreNames.has(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyFiltered(s, d, ignoreNames);
    else fs.copyFileSync(s, d);
  }
}

console.log(`\n📦 Building FB Page Studio v${pkg.version}\n`);

rmrf(staging);
fs.mkdirSync(staging, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

const ignore = new Set([
  "node_modules",
  "data",
  "dist",
  "build-staging",
  ".git",
  ".grok",
  "ảnh  check bug",
  "bug-screenshot.png",
  ".env",
]);

console.log("→ Copy project files…");
copyFiltered(root, staging, ignore);

console.log("→ npm ci --omit=dev (staging)…");
execSync("npm ci --omit=dev", {
  cwd: staging,
  stdio: "inherit",
  shell: true,
  env: process.env,
});

console.log("→ rebuild better-sqlite3…");
try {
  execSync("npm rebuild better-sqlite3", {
    cwd: staging,
    stdio: "inherit",
    shell: true,
  });
} catch (e) {
  console.warn("rebuild warning:", e.message);
}

// Bootstrap: set user dir next to the distributed .exe
const bootstrap = path.join(staging, "bootstrap.cjs");
fs.writeFileSync(
  bootstrap,
  `const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
try {
  // caxa extracts to TEMP and runs node from there — user data = cwd
  // (Windows double-click sets cwd to the folder of FB-Page-Studio.exe)
  const cwd = process.cwd();
  process.env.FB_USER_DIR = cwd;
  process.env.FB_EXE_DIR = cwd;
  const outer = path.join(cwd, "FB-Page-Studio.exe");
  if (fs.existsSync(outer)) process.env.FB_OUTER_EXE = outer;
} catch (_) {}
import(pathToFileURL(path.join(__dirname, "src", "server.js")).href).catch((e) => {
  console.error(e);
  console.error("\\nTip: chay .exe tu folder cua no (double-click). Can file .env canh .exe.");
  process.exit(1);
});
`,
  "utf8"
);

fs.writeFileSync(
  path.join(staging, "VERSION.txt"),
  `FB Page Studio v${pkg.version}\nBuilt: ${new Date().toISOString()}\n`,
  "utf8"
);

// caxa copies node into node_modules/.bin/<basename>
const nodeBinName = path.basename(process.execPath); // node.exe on Windows
const nodeCmd = `{{caxa}}/node_modules/.bin/${nodeBinName}`;

console.log("→ Packing with caxa (single .exe)…");
await caxa({
  input: staging,
  output: outExe,
  command: [nodeCmd, "{{caxa}}/bootstrap.cjs"],
  includeNode: true,
  exclude: [
    "**/data/**",
    "**/.git/**",
    "**/dist/**",
    "**/build-staging/**",
  ],
  force: true,
});

const sizeMb = (fs.statSync(outExe).size / 1024 / 1024).toFixed(1);
console.log(`\n✅ Built: ${outExe} (${sizeMb} MB)`);

const envExample = path.join(dist, ".env.example");
fs.writeFileSync(
  envExample,
  [
    "PORT=3847",
    "APP_BASE_URL=http://localhost:3847",
    "FB_APP_ID=",
    "FB_APP_SECRET=",
    "FB_REDIRECT_URI=http://localhost:3847/auth/facebook/callback",
    "FB_GRAPH_VERSION=v21.0",
    "FB_SCOPES=pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,read_insights,public_profile",
    "TOKEN_ENCRYPTION_KEY=change-me-to-a-long-random-string-32+",
    "GITHUB_REPO=your-github-user/fb-page-studio",
    "",
  ].join("\n"),
  "utf8"
);

const readmeDist = path.join(dist, "README-CHAY-APP.txt");
fs.writeFileSync(
  readmeDist,
  [
    `FB Page Studio v${pkg.version}`,
    "",
    "1) Copy FB-Page-Studio.exe + .env.example vao 1 folder",
    "2) Doi .env.example thanh .env, dien FB_APP_ID / SECRET / GITHUB_REPO",
    "3) Chay FB-Page-Studio.exe (mo http://localhost:3847)",
    "4) Nut Cap nhat trong app = tai ban moi tu GitHub Releases",
    "",
    "Data (db, media, log) nam canh file .exe trong folder data/",
    "",
  ].join("\n"),
  "utf8"
);

if (doZip) {
  const zipName = `FB-Page-Studio-v${pkg.version}-win-x64.zip`;
  const zipPath = path.join(dist, zipName);
  console.log(`→ Creating ${zipName}…`);
  try {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${outExe.replace(/'/g, "''")}','${envExample.replace(/'/g, "''")}','${readmeDist.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" }
    );
    console.log(`✅ Zip: ${zipPath}`);
  } catch (e) {
    console.warn("Zip failed:", e.message);
  }
}

if (process.env.BUILD_KEEP_STAGING !== "1") {
  console.log("→ Cleanup staging…");
  rmrf(staging);
}

console.log(`
Next — day len GitHub:
  1. Tao repo (xem GITHUB.md)
  2. git push
  3. Releases → tag v${pkg.version} → upload FB-Page-Studio.exe
  4. .env: GITHUB_REPO=USER/fb-page-studio
`);
