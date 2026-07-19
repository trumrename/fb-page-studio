/**
 * Hard release gate. A release must never upload a stale/wrong EXE.
 * Run after build:desktop + pack:customer.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const pass = (label) => console.log(`✓ ${label}`);
const assert = (condition, label, detail = "") => {
  if (condition) return pass(label);
  failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
};
const json = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const parts = (v) => String(v || "0").replace(/^v/i, "").split("-")[0].split(".").map((n) => Number(n) || 0);
const newer = (a, b) => {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) > (y[i] || 0)) return true;
    if ((x[i] || 0) < (y[i] || 0)) return false;
  }
  return false;
};
const getJson = (url) => new Promise((resolve, reject) => {
  const req = https.get(url, { headers: { "User-Agent": "FB-Page-Studio-Release-Gate", "Cache-Control": "no-cache" } }, (res) => {
    let body = "";
    res.on("data", (c) => { body += c; });
    res.on("end", () => {
      if ((res.statusCode || 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
  });
  req.on("error", reject);
  req.setTimeout(30000, () => req.destroy(new Error("timeout")));
});

const pkg = json(path.join(root, "package.json"));
const lock = json(path.join(root, "package-lock.json"));
const exe = path.join(root, "dist-desktop-oauth", "FB-Page-Studio-Desktop.exe");
const versionedExe = path.join(root, "dist-desktop-oauth", `FB-Page-Studio-Desktop-v${pkg.version}.exe`);
const checksumFile = `${versionedExe}.sha256.txt`;
const customerExe = path.join(root, "pack-customer", "FB-Page-Studio-Desktop.exe");
const appAsar = path.join(root, "dist-desktop-oauth", "win-unpacked", "resources", "app.asar");
const customerVersionFile = path.join(root, "pack-customer", "VERSION.txt");

assert(/^\d+\.\d+\.\d+$/.test(pkg.version), "package version is strict semver", pkg.version);
assert(lock.version === pkg.version && lock.packages?.[""]?.version === pkg.version, "package-lock versions match package.json");
assert(fs.existsSync(exe), "desktop EXE exists");
assert(fs.existsSync(versionedExe), "versioned release EXE exists");
assert(fs.existsSync(checksumFile), "versioned release SHA-256 file exists");
assert(fs.existsSync(customerExe), "customer EXE exists");
assert(fs.existsSync(appAsar), "packaged app.asar exists");
assert(fs.existsSync(customerVersionFile), "customer VERSION.txt exists");

if (fs.existsSync(appAsar)) {
  const embeddedPkg = JSON.parse(asar.extractFile(appAsar, "package.json").toString());
  const embeddedMain = asar.extractFile(appAsar, path.join("electron", "main.cjs")).toString();
  const embeddedUpdater = asar.extractFile(appAsar, path.join("src", "services", "updater.js")).toString();
  const embeddedNgrok = asar.extractFile(appAsar, path.join("src", "services", "ngrokManager.js")).toString();
  const embeddedServer = asar.extractFile(appAsar, path.join("src", "server.js")).toString();
  assert(embeddedPkg.version === pkg.version, "EXE embedded version matches package.json", embeddedPkg.version);
  assert(embeddedMain.includes("app.exit(0)"), "EXE contains forced updater shutdown safeguard");
  assert(embeddedUpdater.includes("no-cache") && embeddedUpdater.includes("Date.now()"), "EXE contains GitHub cache-busting safeguard");
  assert(embeddedNgrok.includes("await stopNgrok(); stopRequested = false") && embeddedNgrok.includes("child === proc"), "EXE contains safe Ngrok restart logic");
  assert(embeddedNgrok.includes("find((x) => domainOf(x.public_url) === domain)") && !embeddedNgrok.includes("|| j.tunnels?.[0]"), "EXE only accepts the configured Ngrok domain");
  assert(embeddedServer.includes('msg?.type === "shutdown"') && embeddedMain.includes('serverProc.send({ type: "shutdown" })'), "EXE shuts Ngrok down through Electron IPC");
}

if (fs.existsSync(customerVersionFile)) {
  const m = fs.readFileSync(customerVersionFile, "utf8").match(/^version=(.+)$/m);
  assert(m?.[1]?.trim() === pkg.version, "customer VERSION.txt matches package.json", m?.[1]?.trim() || "missing");
}
if (fs.existsSync(exe) && fs.existsSync(customerExe)) {
  assert(sha256(exe) === sha256(customerExe), "customer EXE hash matches release EXE");
}
if (fs.existsSync(exe) && fs.existsSync(versionedExe)) {
  assert(sha256(exe) === sha256(versionedExe), "versioned asset hash matches verified build EXE");
  const checksumText = fs.existsSync(checksumFile) ? fs.readFileSync(checksumFile, "utf8") : "";
  assert(checksumText.startsWith(sha256(versionedExe)), "SHA-256 sidecar matches versioned asset");
}

for (const rel of ["pack-customer/.env", "pack-customer/data", "pack-customer/src", "pack-customer/desktop-startup.log", "pack-customer/keys/license-private.pem"]) {
  assert(!fs.existsSync(path.join(root, rel)), `customer pack excludes ${rel.replace("pack-customer/", "")}`);
}

if (!process.argv.includes("--offline")) {
  try {
    const release = await getJson(`https://api.github.com/repos/${pkg.githubRepo}/releases/latest?ts=${Date.now()}`);
    const remoteVersion = String(release.tag_name || "").replace(/^v/i, "");
    if (remoteVersion === pkg.version) {
      pass(`GitHub latest already equals v${pkg.version} (re-verification)`);
    } else {
      assert(newer(pkg.version, remoteVersion), "local version is newer than GitHub latest", `${pkg.version} <= ${remoteVersion}`);
      const oldAsset = (release.assets || []).find((a) => a.name === pkg.updateAsset) || (release.assets || []).find((a) => /\.exe$/i.test(a.name || ""));
      const oldDigest = String(oldAsset?.digest || "").replace(/^sha256:/, "").toLowerCase();
      if (oldDigest && fs.existsSync(versionedExe)) assert(sha256(versionedExe) !== oldDigest, "new EXE is not a stale copy of previous release");
    }
  } catch (e) {
    assert(false, "online GitHub release verification", e.message);
  }
}

if (failures.length) {
  console.error(`\nRELEASE BLOCKED (${failures.length} lỗi):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nRELEASE VERIFIED: v${pkg.version}`);
