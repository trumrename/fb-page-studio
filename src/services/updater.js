/**
 * GitHub Releases auto-update for portable .exe
 * Checks latest release, downloads asset, stages replace on restart.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import http from "http";
import { spawn } from "child_process";
import { getExeDir, getOuterExePath, getPackageJson, isPackaged } from "../paths.js";
// spawn already imported for setup installer launch
import { config } from "../config.js";

const updateProgress = {
  state: "idle", // idle | checking | downloading | ready | restarting | error
  bytes: 0,
  total: 0,
  percent: 0,
  from: null,
  to: null,
  error: null,
  message: "Chưa có cập nhật đang chạy",
  updated_at: null,
};
let activeUpdate = null;

function setUpdateProgress(next) {
  Object.assign(updateProgress, next, { updated_at: new Date().toISOString() });
}

export function getUpdateProgress() {
  return { ...updateProgress, active: Boolean(activeUpdate) };
}

function parseRepo(repo) {
  // owner/name or https://github.com/owner/name
  const s = String(repo || "").trim().replace(/\/$/, "");
  const m = s.match(/github\.com[/:]([^/]+)\/([^/#]+)/i);
  if (m) return { owner: m[1], name: m[2].replace(/\.git$/, "") };
  const parts = s.split("/").filter(Boolean);
  if (parts.length >= 2) return { owner: parts[0], name: parts[1] };
  return null;
}

export function getUpdateConfig() {
  const pkg = getPackageJson();
  return {
    current_version: pkg.version || config.version || "0.0.0",
    // Default repo so portable builds work without user editing .env
    github_repo:
      process.env.GITHUB_REPO ||
      pkg.githubRepo ||
      config.githubRepo ||
      "trumrename/fb-page-studio",
    asset_name:
      process.env.UPDATE_ASSET ||
      pkg.updateAsset ||
      "FB-Page-Studio-Desktop.exe",
    packaged: isPackaged(),
  };
}

/** Prefer portable desktop exe, then legacy names, then any .exe */
export function pickReleaseAsset(assets, preferredName, releaseVersion) {
  const list = Array.isArray(assets) ? assets : [];
  if (!list.length) return null;
  const byName = (n) => list.find((a) => a.name === n);
  const cleanVersion = String(releaseVersion || "").replace(/^v/i, "");
  const prefer = [
    cleanVersion
      ? `FB-Page-Studio-Desktop-v${cleanVersion}.exe`
      : null,
    preferredName,
    "FB-Page-Studio-Desktop.exe",
    "FB-Page-Studio.exe",
    "FB Page Studio.exe",
  ].filter(Boolean);
  for (const n of prefer) {
    const hit = byName(n);
    if (hit) return hit;
  }
  const fuzzy = list.find(
    (a) =>
      /\.exe$/i.test(a.name || "") &&
      /page.?studio|fb.?page/i.test(a.name || "")
  );
  if (fuzzy) return fuzzy;
  return list.find((a) => /\.exe$/i.test(a.name || "")) || null;
}

function semverParts(v) {
  const clean = String(v || "0").replace(/^v/i, "").split("-")[0];
  return clean.split(".").map((n) => parseInt(n, 10) || 0);
}

export function isNewerVersion(remote, local) {
  const a = semverParts(remote);
  const b = semverParts(local);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

const MANUAL_RELEASE =
  "https://github.com/trumrename/fb-page-studio/releases/latest";

/** Prefer system/proxy-friendly TLS; avoid hanging forever on blocked ISPs. */
function requestText(url, { headers = {}, timeoutMs = 20000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error("Quá nhiều redirect HTTP"));
      return;
    }
    const lib = String(url).startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": "FB-Page-Studio-Updater/1.2",
          Accept: "application/vnd.github+json, application/json;q=0.9, */*;q=0.1",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          requestText(next, { headers, timeoutMs, maxRedirects: maxRedirects - 1 }).then(
            resolve,
            reject
          );
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode || 0, body, headers: res.headers });
        });
      }
    );
    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`timeout ${timeoutMs}ms`));
    });
  });
}

async function fetchJson(url, headers = {}) {
  const { status, body } = await requestText(url, { headers, timeoutMs: 25000 });
  if (status >= 400) {
    throw new Error(`GitHub HTTP ${status}: ${String(body || "").slice(0, 180)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`GitHub JSON parse fail (${url.slice(0, 80)})`);
  }
}

/**
 * Build list of release JSON endpoints. Some ISPs block api.github.com
 * but still allow github.com or public mirrors.
 */
function releaseJsonUrls(owner, name) {
  const repo = `${owner}/${name}`;
  const ts = Date.now();
  const primary = `https://api.github.com/repos/${repo}/releases/latest?ts=${ts}`;
  const list = `https://api.github.com/repos/${repo}/releases?per_page=5&ts=${ts}`;
  const custom = String(process.env.UPDATE_GITHUB_API || process.env.GITHUB_API_MIRROR || "").trim();
  const urls = [];
  if (custom) {
    // e.g. https://ghproxy.com/https://api.github.com/repos/OWNER/REPO/releases/latest
    urls.push(
      custom
        .replace(/\{owner\}/g, owner)
        .replace(/\{name\}/g, name)
        .replace(/\{repo\}/g, repo)
    );
  }
  urls.push(primary, list);
  // Common public proxies (best-effort; skipped if dead)
  const mirrors = [
    `https://ghfast.top/https://api.github.com/repos/${repo}/releases/latest`,
    `https://mirror.ghproxy.com/https://api.github.com/repos/${repo}/releases/latest`,
    `https://gh-proxy.com/https://api.github.com/repos/${repo}/releases/latest`,
  ];
  if (process.env.UPDATE_DISABLE_MIRRORS !== "1") {
    urls.push(...mirrors);
  }
  return [...new Set(urls.filter(Boolean))];
}

function normalizeReleasePayload(data) {
  if (!data) return null;
  // /releases returns array
  if (Array.isArray(data)) {
    const stable = data.find((r) => r && !r.draft && !r.prerelease) || data[0];
    return stable || null;
  }
  if (data.tag_name || data.assets) return data;
  return null;
}

async function fetchLatestRelease(owner, name) {
  const urls = releaseJsonUrls(owner, name);
  const errors = [];
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await fetchJson(url);
        const release = normalizeReleasePayload(raw);
        if (release?.tag_name || release?.name) {
          return { release, source: url };
        }
        errors.push(`${url}: empty payload`);
      } catch (e) {
        errors.push(`${url}#${attempt}: ${e.message || e}`);
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  throw new Error(
    `Không kết nối được GitHub Releases.\n` +
      `Thử: tắt VPN / đổi mạng / DNS 8.8.8.8.\n` +
      `Hoặc tải tay: ${MANUAL_RELEASE}\n` +
      `Chi tiết: ${errors.slice(0, 4).join(" | ")}`
  );
}

function downloadUrlCandidates(primaryUrl) {
  const u = String(primaryUrl || "").trim();
  if (!u) return [];
  const list = [u];
  if (process.env.UPDATE_DISABLE_MIRRORS !== "1") {
    // Proxy raw github release assets when direct github.com is blocked
    list.push(
      `https://ghfast.top/${u}`,
      `https://mirror.ghproxy.com/${u}`,
      `https://gh-proxy.com/${u}`
    );
  }
  return [...new Set(list)];
}

function isDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `._fbps_write_${process.pid}.tmp`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** NSIS / Program Files installs cannot be replaced without elevation. */
function isProtectedInstallDir(dir) {
  const d = path.resolve(String(dir || "")).toLowerCase();
  if (!d) return false;
  if (d.includes("\\program files") || d.includes("\\program files (x86)")) return true;
  if (d.includes("\\windows\\")) return true;
  return !isDirWritable(dir);
}

/**
 * True when running the NSIS-installed app (Start Menu "FB Page Studio"),
 * not the portable Desktop.exe next to user files.
 */
function isNsisInstalledApp(currentExe, exeDir) {
  const base = path.basename(String(currentExe || ""));
  const dir = path.resolve(String(exeDir || "")).toLowerCase();
  if (/^FB Page Studio\.exe$/i.test(base)) return true;
  if (dir.includes("\\programs\\") && /fb.?page.?studio/i.test(dir)) return true;
  if (isProtectedInstallDir(exeDir)) return true;
  return false;
}

/** Default NSIS install locations to relaunch after Setup. */
function nsisAppLaunchCandidates(preferredExe) {
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const names = [
    preferredExe && /\.exe$/i.test(preferredExe) ? preferredExe : null,
    path.join(local, "Programs", "FB Page Studio", "FB Page Studio.exe"),
    path.join(local, "Programs", "fb-page-studio", "FB Page Studio.exe"),
    path.join(pf, "FB Page Studio", "FB Page Studio.exe"),
    path.join(pf86, "FB Page Studio", "FB Page Studio.exe"),
  ].filter(Boolean);
  // unique, preserve order
  const seen = new Set();
  return names.filter((p) => {
    const k = path.resolve(p).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Delay safe when BAT has no console (timeout.exe can hang with redirected stdio). */
function batDelaySeconds(seconds) {
  const n = Math.max(1, Math.min(30, Number(seconds) || 1));
  // ping -n N waits ~N-1 seconds
  return `ping 127.0.0.1 -n ${n + 1} >nul`;
}

/**
 * Snapshot user data BEFORE update so NSIS / force-kill never "mất dữ liệu".
 * Copies .env, license, app.db(+wal/shm), jobs-state, app_settings-critical files.
 * Never deletes originals. AppData is outside install dir — Setup must not touch it.
 */
export function backupUserDataBeforeUpdate(userDir, label = "pre-update") {
  const root = path.resolve(String(userDir || getExeDir() || ""));
  if (!root || !fs.existsSync(root)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bakDir = path.join(root, "data", "backups", `${label}-${stamp}`);
  try {
    fs.mkdirSync(bakDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const copyOne = (rel) => {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) return false;
    const dest = path.join(bakDir, path.basename(rel));
    try {
      fs.copyFileSync(src, dest);
      return true;
    } catch {
      return false;
    }
  };
  const copied = [];
  for (const rel of [
    ".env",
    "license.backup.json",
    path.join("data", "license.json"),
    path.join("data", "app.db"),
    path.join("data", "app.db-wal"),
    path.join("data", "app.db-shm"),
    path.join("data", "jobs-state.json"),
  ]) {
    if (copyOne(rel)) copied.push(rel);
  }
  // Keep last 8 backup folders
  try {
    const parent = path.join(root, "data", "backups");
    const dirs = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, t: fs.statSync(path.join(parent, d.name)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of dirs.slice(8)) {
      try {
        fs.rmSync(path.join(parent, old.name), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return { ok: true, dir: bakDir, copied };
}

/**
 * Write PowerShell apply script — NO cmd find/tasklist pipes (user hung on "find").
 * Preserves %APPDATA%\fb-page-studio (never deletes data/).
 */
function writeNsisUpdateScript({
  userWritable,
  setupPath,
  currentExe,
  fromVersion,
  toVersion,
}) {
  const psPath = path.join(userWritable, "_apply_update.ps1");
  const launchList = nsisAppLaunchCandidates(currentExe);
  const setupEsc = setupPath.replace(/'/g, "''");
  const userEsc = userWritable.replace(/'/g, "''");
  const ps = `# FB Page Studio auto-update (PowerShell) — do not use cmd find.exe
$ErrorActionPreference = 'Continue'
$userDir = '${userEsc}'
$setup = '${setupEsc}'
$log = Join-Path $userDir '_update-log.txt'
$status = Join-Path $userDir '_update-status.txt'
$errFile = Join-Path $userDir '_update-error.txt'
$launch = @(${launchList.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(",")})
function Log([string]$m) {
  try { Add-Content -LiteralPath $log -Value ("{0} {1}" -f (Get-Date -Format o), $m) -Encoding UTF8 } catch {}
}
function Set-Status([string]$m) {
  try { Set-Content -LiteralPath $status -Value $m -Encoding UTF8 } catch {}
  Log $m
}
try { Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue } catch {}
Set-Status "Backup data truoc khi cap nhat..."
# --- NEVER wipe AppData: only copy snapshot ---
try {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bak = Join-Path $userDir ("data\\backups\\pre-update-" + $stamp)
  New-Item -ItemType Directory -Force -Path $bak | Out-Null
  foreach ($rel in @('.env','license.backup.json','data\\license.json','data\\app.db','data\\app.db-wal','data\\app.db-shm','data\\jobs-state.json')) {
    $src = Join-Path $userDir $rel
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $bak (Split-Path $rel -Leaf)) -Force -ErrorAction SilentlyContinue
    }
  }
  Log ("Backup OK " + $bak)
} catch { Log ("Backup warn: " + $_.Exception.Message) }

Set-Status "Dang tat app cu (giu nguyen data)..."
# Soft then hard stop — by process name only, never delete data folders
for ($i = 0; $i -lt 8; $i++) {
  Get-Process -Name 'FB Page Studio' -ErrorAction SilentlyContinue | ForEach-Object {
    try { $_.CloseMainWindow() | Out-Null } catch {}
  }
  Start-Sleep -Milliseconds 400
}
Get-Process -Name 'FB Page Studio' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-Process -Name 'FB Page Studio' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if (-not (Test-Path -LiteralPath $setup)) {
  Set-Content -LiteralPath $errFile -Value 'LOI: thieu Setup' -Encoding UTF8
  exit 1
}

Set-Status "Dang cai Setup silent (khong xoa AppData)..."
# Run Setup WITHOUT -Wait forever. NSIS runAfterFinish keeps setup alive if we Wait.
$p = $null
try {
  $p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -WindowStyle Minimized
} catch {
  Log ("Start-Process fail: " + $_.Exception.Message)
  try { Start-Process -FilePath $setup } catch {}
  exit 1
}

$deadline = (Get-Date).AddSeconds(150)
$startedApp = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if ($p -and $p.HasExited) { Log ("Setup exited code=" + $p.ExitCode); break }
  $appRunning = @(Get-Process -Name 'FB Page Studio' -ErrorAction SilentlyContinue).Count -gt 0
  if ($appRunning) {
    $startedApp = $true
    # App relaunched by NSIS — Setup may stay open; kill Setup so we never hang
    if ($p -and -not $p.HasExited -and ((Get-Date) - $p.StartTime).TotalSeconds -gt 12) {
      Log 'App already running — stopping Setup remnant'
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
      break
    }
  }
}
if ($p -and -not $p.HasExited) {
  Log 'Setup still running after timeout — force stop Setup only'
  try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
}
# Kill leftover setup image names (never touch user data)
Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -like 'FB-Page-Studio-Setup*' -or $_.Path -like '*FB-Page-Studio-Setup*'
} | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 1
Set-Status "Dang mo ban moi..."
$appNow = @(Get-Process -Name 'FB Page Studio' -ErrorAction SilentlyContinue).Count -gt 0
if (-not $appNow) {
  $launched = $false
  foreach ($exe in $launch) {
    if ($exe -and (Test-Path -LiteralPath $exe)) {
      try {
        Start-Process -FilePath $exe
        Log ("Launched " + $exe)
        $launched = $true
        break
      } catch { Log ("Launch fail " + $exe + " " + $_.Exception.Message) }
    }
  }
  if (-not $launched) {
    $lnk = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\FB Page Studio.lnk'
    if (Test-Path -LiteralPath $lnk) {
      try { Start-Process -FilePath $lnk; Log 'Launched Start Menu shortcut' } catch {}
    }
  }
} else {
  Log 'App already running — skip second launch'
}

try { Remove-Item -LiteralPath $status -Force -ErrorAction SilentlyContinue } catch {}
Log "Update script done from=${fromVersion} to=${toVersion} (data dir kept: $userDir)"
# Self-delete
try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}
exit 0
`;
  fs.writeFileSync(psPath, ps, "utf8");
  // Tiny launcher .bat only starts PowerShell (no find/tasklist loops)
  const batPath = path.join(userWritable, "_apply_update.bat");
  const bat = [
    "@echo off",
    "title FB Page Studio - Cap nhat",
    `cd /d "${userWritable.replace(/"/g, "")}"`,
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${psPath.replace(/"/g, "")}"`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
  fs.writeFileSync(batPath, bat, "utf8");
  return { batPath, psPath, launchList };
}

function downloadFileOnce(url, dest, onProgress, maxRedirects = 8) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error("Quá nhiều redirect khi tải EXE"));
      return;
    }
    const parent = path.dirname(dest);
    try {
      fs.mkdirSync(parent, { recursive: true });
    } catch (e) {
      reject(
        new Error(
          `Không ghi được thư mục tải update:\n${parent}\n${e.message}\n` +
            `Bản cài Setup (Program Files) hãy tải Setup từ GitHub và cài đè.`
        )
      );
      return;
    }
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        file.close();
      } catch {
        /* ignore */
      }
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let file;
    try {
      file = fs.createWriteStream(dest);
    } catch (e) {
      reject(
        new Error(
          `EPERM/ghi file: ${dest}\n${e.message}\n` +
            `Không cập nhật in-place trong Program Files — dùng Setup-v….exe (Run as admin).`
        )
      );
      return;
    }
    file.on("error", (e) => {
      fail(
        new Error(
          `Không ghi được file update (${e.code || e.message}):\n${dest}\n` +
            (e.code === "EPERM" || e.code === "EACCES"
              ? "Thư mục cài đặt bị khóa (Program Files). Hãy tải Setup và cài đè."
              : "")
        )
      );
    });

    const lib = String(url).startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": "FB-Page-Studio-Updater/1.2",
          Accept: "application/octet-stream",
        },
        timeout: 120000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          try {
            file.close();
          } catch {
            /* ignore */
          }
          try {
            fs.unlinkSync(dest);
          } catch {
            /* ignore */
          }
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          downloadFileOnce(next, dest, onProgress, maxRedirects - 1).then(ok, fail);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          fail(new Error(`Download HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers["content-length"] || 0);
        let got = 0;
        res.on("data", (chunk) => {
          got += chunk.length;
          if (onProgress && total) onProgress(got, total);
        });
        res.on("error", fail);
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => ok(dest));
        });
      }
    );
    req.on("error", fail);
    req.on("timeout", () => {
      req.destroy();
      fail(new Error("Download timeout"));
    });
  });
}

async function downloadFile(url, dest, onProgress) {
  const candidates = downloadUrlCandidates(url);
  const errors = [];
  for (const u of candidates) {
    try {
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      return await downloadFileOnce(u, dest, onProgress);
    } catch (e) {
      errors.push(`${u.slice(0, 60)}… → ${e.message || e}`);
    }
  }
  throw new Error(
    `Tải EXE thất bại (mạng/GitHub).\n${errors.slice(0, 3).join("\n")}\nTải tay: ${MANUAL_RELEASE}`
  );
}

/**
 * Check GitHub latest release for newer version + exe asset.
 */
export async function checkForUpdate() {
  const cfg = getUpdateConfig();
  const parsed = parseRepo(cfg.github_repo);
  if (!parsed) {
    return {
      ok: false,
      error:
        "Chưa cấu hình GITHUB_REPO (vd owner/fb-page-studio). Thêm vào .env cạnh file .exe",
      current_version: cfg.current_version,
      github_repo: cfg.github_repo || null,
    };
  }

  // Some ISP/proxy caches or block api.github.com — try primary + mirrors.
  let release;
  let releaseSource = "";
  try {
    const got = await fetchLatestRelease(parsed.owner, parsed.name);
    release = got.release;
    releaseSource = got.source || "";
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      current_version: cfg.current_version,
      github_repo: `${parsed.owner}/${parsed.name}`,
      manual_url: MANUAL_RELEASE,
    };
  }

  if (release.message) {
    return {
      ok: false,
      error: release.message,
      current_version: cfg.current_version,
      github_repo: `${parsed.owner}/${parsed.name}`,
      manual_url: MANUAL_RELEASE,
    };
  }

  const tag = release.tag_name || release.name || "";
  const remoteVersion = String(tag).replace(/^v/i, "");
  const assets = release.assets || [];
  const asset = pickReleaseAsset(assets, cfg.asset_name, remoteVersion);
  const checksumAsset = asset
    ? assets.find((item) => item.name === `${asset.name}.sha256.txt`) || null
    : null;
  const setupName = `FB-Page-Studio-Setup-v${remoteVersion}.exe`;
  const setupAsset =
    assets.find((item) => item.name === setupName) ||
    assets.find(
      (item) =>
        /\.exe$/i.test(item.name || "") &&
        /setup/i.test(item.name || "") &&
        String(item.name || "").includes(remoteVersion)
    ) ||
    null;

  const newer = isNewerVersion(remoteVersion, cfg.current_version);

  return {
    ok: true,
    current_version: cfg.current_version,
    latest_version: remoteVersion,
    tag_name: tag,
    has_update: newer,
    release_name: release.name || tag,
    release_notes: (release.body || "").slice(0, 4000),
    release_url: release.html_url,
    published_at: release.published_at,
    asset: asset
      ? {
          name: asset.name,
          size: asset.size,
          download_url: asset.browser_download_url,
        }
      : null,
    setup_asset: setupAsset
      ? {
          name: setupAsset.name,
          size: setupAsset.size,
          download_url: setupAsset.browser_download_url,
        }
      : null,
    checksum_asset: checksumAsset
      ? {
          name: checksumAsset.name,
          size: checksumAsset.size,
          download_url: checksumAsset.browser_download_url,
        }
      : null,
    missing_asset: newer && !asset,
    github_repo: `${parsed.owner}/${parsed.name}`,
    release_source: releaseSource || null,
    manual_url: MANUAL_RELEASE,
    packaged: cfg.packaged,
    check_at: new Date().toISOString(),
  };
}

/**
 * In-place update: download into same folder as the RUNNING exe, then
 * replace THAT file (same name/path). Does NOT create a second app.
 *
 * Windows locks a running .exe → must: download .new → exit → rename → start same path.
 */
export async function applyUpdate() {
  setUpdateProgress({ state: "checking", bytes: 0, total: 0, percent: 0, error: null, message: "Đang kiểm tra bản phát hành…" });
  const check = await checkForUpdate();
  if (!check.ok) {
    setUpdateProgress({ state: "error", error: check.error || "Không kiểm tra được bản cập nhật", message: "Kiểm tra update thất bại" });
    return check;
  }
  if (!check.has_update) {
    setUpdateProgress({ state: "idle", message: "Đã là bản mới nhất" });
    return { ok: true, updated: false, message: "Đã là phiên bản mới nhất", ...check };
  }
  if (!check.asset?.download_url) {
    const result = {
      ok: false,
      error: `Release có tag ${check.latest_version} nhưng không có file .exe trên GitHub (cần upload asset). Không mở bản khác — chờ admin upload rồi bấm lại.`,
      ...check,
    };
    setUpdateProgress({ state: "error", error: result.error, message: "Release thiếu file EXE" });
    return result;
  }
  if (!check.checksum_asset?.download_url) {
    const result = {
      ok: false,
      error: `Release v${check.latest_version} thiếu file SHA-256 cho ${check.asset.name}; từ chối cập nhật để tránh EXE không được xác thực.`,
      ...check,
    };
    setUpdateProgress({ state: "error", error: result.error, message: "Release thiếu SHA-256" });
    return result;
  }

  // Prefer exact path of running outer portable exe (FB_OUTER_EXE from Electron)
  const currentExe = getOuterExePath();
  const exeDir = path.dirname(currentExe);
  const currentName = path.basename(currentExe) || getUpdateConfig().asset_name;
  const userWritable =
    process.env.FB_USER_DIR ||
    process.env.FB_EXE_DIR ||
    getExeDir();
  const protectedInstall = isProtectedInstallDir(exeDir);

  // ── NSIS / Start Menu install: cannot swap EXE while running → Setup + quit + relaunch ──
  if (protectedInstall || isNsisInstalledApp(currentExe, exeDir)) {
    const setupName = `FB-Page-Studio-Setup-v${check.latest_version}.exe`;
    let setupUrl = null;
    let setupSize = 0;
    try {
      const tag = check.tag_name || `v${check.latest_version}`;
      setupUrl = `https://github.com/${getUpdateConfig().github_repo}/releases/download/${tag}/${setupName}`;
    } catch {
      setupUrl = null;
    }
    if (check.setup_asset?.download_url) {
      setupUrl = check.setup_asset.download_url;
      setupSize = Number(check.setup_asset.size) || 0;
    }
    // Stable latest name also on GH
    const setupUrlStable = `https://github.com/${getUpdateConfig().github_repo}/releases/latest/download/FB-Page-Studio-Setup.exe`;

    const stageDir = path.join(userWritable, "updates");
    if (!isDirWritable(userWritable) && !isDirWritable(stageDir)) {
      const err =
        `Không ghi được thư mục cập nhật.\n` +
        `Tải tay và cài đè:\n${MANUAL_RELEASE}\nFile: ${setupName}`;
      setUpdateProgress({ state: "error", error: err, message: "Cần cài Setup thủ công" });
      return { ok: false, error: err, needs_setup: true, manual_url: MANUAL_RELEASE, ...check };
    }

    fs.mkdirSync(stageDir, { recursive: true });
    const destSetup = path.join(stageDir, setupName);
    setUpdateProgress({
      state: "downloading",
      from: check.current_version,
      to: check.latest_version,
      bytes: 0,
      total: setupSize || 0,
      percent: 0,
      message: `Bản cài Setup — đang tải ${setupName}…`,
    });
    try {
      await downloadFile(setupUrl || setupUrlStable, destSetup, (bytes, total) => {
        const expected = total || setupSize || 0;
        setUpdateProgress({
          state: "downloading",
          bytes,
          total: expected,
          percent: expected ? Math.min(100, Math.floor((bytes / expected) * 100)) : 0,
          message: `Đang tải Setup v${check.latest_version}…`,
        });
      });
    } catch (e1) {
      try {
        await downloadFile(setupUrlStable, destSetup, (bytes, total) => {
          const expected = total || setupSize || 0;
          setUpdateProgress({
            state: "downloading",
            bytes,
            total: expected,
            percent: expected ? Math.min(100, Math.floor((bytes / expected) * 100)) : 0,
            message: `Đang tải Setup (latest)…`,
          });
        });
      } catch (e) {
        const err = `${e.message || e}\n\nMở trang tải tay:\n${MANUAL_RELEASE}`;
        setUpdateProgress({ state: "error", error: err, message: "Tải Setup thất bại" });
        return { ok: false, error: err, needs_setup: true, manual_url: MANUAL_RELEASE, ...check };
      }
    }

    // Snapshot data first — Setup only replaces Program Files, never AppData.
    const dataBackup = backupUserDataBeforeUpdate(userWritable, "pre-nsis-update");
    const { batPath, psPath, launchList } = writeNsisUpdateScript({
      userWritable,
      setupPath: destSetup,
      currentExe,
      fromVersion: check.current_version,
      toVersion: check.latest_version,
    });

    setUpdateProgress({
      state: "ready",
      percent: 100,
      message: `Đã tải Setup v${check.latest_version}. Đã backup data → tắt app → cài đè (giữ AppData)…`,
      from: check.current_version,
      to: check.latest_version,
      setup_mode: true,
      setup_path: destSetup,
      will_restart: true,
      data_backup: dataBackup?.dir || null,
    });
    return {
      ok: true,
      updated: true,
      setup_mode: true,
      setup_path: destSetup,
      bat: batPath,
      ps1: psPath,
      target_exe: launchList[0],
      will_restart: true,
      data_backup: dataBackup?.dir || null,
      preserves: ["%APPDATA%\\fb-page-studio\\data", ".env", "license"],
      message:
        `Đã tải Setup v${check.latest_version}.\n` +
        `App sẽ TẮT → cài đè EXE → mở lại.\n` +
        `Data/license/token giữ nguyên trong %APPDATA%\\fb-page-studio (không xóa).\n` +
        (dataBackup?.dir ? `Backup: ${dataBackup.dir}` : ""),
      ...check,
    };
  }

  // Always end as versioned filename so Explorer / shortcut show NEW version (not v1.2.27 after update).
  const finalName = `FB-Page-Studio-Desktop-v${check.latest_version}.exe`;
  // Stage next to app; may differ from currentName when upgrading from old versioned/unversioned name
  const destNew = path.join(exeDir, `${finalName}.new`);
  const checksumFile = `${destNew}.sha256.txt`;
  const destBak = path.join(exeDir, `${currentName}.bak`);
  const batPath = path.join(exeDir, "_apply_update.bat");

  // Clean old leftovers so user doesn't see "many versions"
  for (const junk of [
    destNew,
    checksumFile,
    path.join(exeDir, "FB-Page-Studio-Desktop.exe.new"),
    path.join(exeDir, "FB-Page-Studio.exe.new"),
    path.join(exeDir, `${currentName}.new`),
  ]) {
    try {
      if (fs.existsSync(junk)) fs.unlinkSync(junk);
    } catch {
      /* ignore */
    }
  }

  setUpdateProgress({
    state: "downloading",
    from: check.current_version,
    to: check.latest_version,
    bytes: 0,
    total: Number(check.asset.size) || 0,
    percent: 0,
    message: `Đang tải v${check.latest_version} từ GitHub…`,
  });
  try {
    await downloadFile(check.asset.download_url, destNew, (bytes, total) => {
      const expected = total || Number(check.asset.size) || 0;
      setUpdateProgress({
        state: "downloading",
        bytes,
        total: expected,
        percent: expected ? Math.min(100, Math.floor((bytes / expected) * 100)) : 0,
        message: `Đang tải v${check.latest_version}…`,
      });
    });
  } catch (e) {
    const err = e.message || String(e);
    setUpdateProgress({ state: "error", error: err, message: "Tải update thất bại" });
    return { ok: false, error: err, manual_url: MANUAL_RELEASE, ...check };
  }
  if (Number(check.asset.size) > 0 && fs.statSync(destNew).size !== Number(check.asset.size)) {
    throw new Error("File update tải về không đủ dung lượng; không thay EXE hiện tại");
  }
  await downloadFile(check.checksum_asset.download_url, checksumFile);
  const checksumText = fs.readFileSync(checksumFile, "utf8");
  const expectedHash = checksumText.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase();
  const actualHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(destNew))
    .digest("hex");
  try { fs.unlinkSync(checksumFile); } catch { /* best effort */ }
  if (!expectedHash || actualHash !== expectedHash) {
    try { fs.unlinkSync(destNew); } catch { /* never install an unverified file */ }
    throw new Error(
      `SHA-256 EXE cập nhật không khớp; đã hủy thay file. Cần ${expectedHash || "checksum hợp lệ"}, nhận ${actualHash}.`
    );
  }

  // Snapshot license + full user data (never deleted by update)
  try {
    const dataLic = path.join(exeDir, "data", "license.json");
    const bakLic = path.join(exeDir, "license.backup.json");
    if (fs.existsSync(dataLic)) {
      fs.copyFileSync(dataLic, bakLic);
    }
  } catch {
    /* ignore */
  }
  backupUserDataBeforeUpdate(userWritable || exeDir, "pre-portable-update");

  // 1) Unlock current EXE → .bak  2) Place new as finalName (v{new})  3) DELETE all other Desktop EXEs
  //    so Explorer shows the new version number and no leftover v1.2.25/v1.2.27.
  const bakBase = path.basename(destBak);
  const newBase = path.basename(destNew);
  const bat = [
    "@echo off",
    "setlocal EnableExtensions",
    "title FB Page Studio - Dang cap nhat",
    `cd /d "${exeDir}"`,
    `del /f /q "_update-error.txt" 2>nul`,
    // Kill portable process by image name so ren succeeds
    `taskkill /F /IM "${currentName}" >nul 2>&1`,
    `taskkill /F /IM "${finalName}" >nul 2>&1`,
    batDelaySeconds(1),
    "set /a tries=0",
    `:retry`,
    "set /a tries+=1",
    "if %tries% GTR 30 goto locked",
    // Free the currently running file (any old name)
    `if exist "${currentName}" (`,
    `  del /f /q "${bakBase}" 2>nul`,
    `  ren "${currentName}" "${bakBase}" 2>nul`,
    `  if exist "${currentName}" (`,
    `    ${batDelaySeconds(1)}`,
    `    goto retry`,
    `  )`,
    `)`,
    // If finalName already exists (another copy), free it too
    `if /I not "${currentName}"=="${finalName}" if exist "${finalName}" (`,
    `  del /f /q "${finalName}.old" 2>nul`,
    `  ren "${finalName}" "${finalName}.old" 2>nul`,
    `  if exist "${finalName}" (`,
    `    ${batDelaySeconds(1)}`,
    `    goto retry`,
    `  )`,
    `)`,
    `if not exist "${newBase}" (`,
    `  echo LOI: khong thay file .new > "_update-error.txt"`,
    `  exit /b 1`,
    `)`,
    // Install as versioned final name so UI/Explorer show v${check.latest_version}
    `move /y "${newBase}" "${finalName}" >nul`,
    `if not exist "${finalName}" goto replace_failed`,
    // Restore license if needed
    `if exist "license.backup.json" if not exist "data\\license.json" (`,
    `  if not exist "data" mkdir "data"`,
    `  copy /y "license.backup.json" "data\\license.json" >nul`,
    `)`,
    // DELETE every other Desktop EXE / sha / bak / .new / .old (keep only finalName)
    `for %%F in ("FB-Page-Studio-Desktop*.exe" "FB-Page-Studio.exe" "FB Page Studio.exe") do (`,
    `  if /I not "%%~nxF"=="${finalName}" del /f /q "%%~fF" 2>nul`,
    `)`,
    `for %%F in ("FB-Page-Studio-Desktop*.exe.sha256.txt" "FB-Page-Studio-Desktop*.exe.bak" "FB-Page-Studio-Desktop*.exe.old" "FB-Page-Studio-Desktop*.exe.new" "*.bak" "*.new") do (`,
    `  del /f /q "%%~fF" 2>nul`,
    `)`,
    `del /f /q "${bakBase}" 2>nul`,
    `del /f /q "${finalName}.old" 2>nul`,
    `del /f /q "${finalName}.new" 2>nul`,
    // Optional: drop empty leftover vault copies that clutter pack folders (best-effort)
    `if exist "Luu-Tru-Ban-Cu" (`,
    `  del /f /q "Luu-Tru-Ban-Cu\\FB-Page-Studio-Desktop*.exe" 2>nul`,
    `  del /f /q "Luu-Tru-Ban-Cu\\FB-Page-Studio-Desktop*.exe.sha256.txt" 2>nul`,
    `)`,
    `start "" "${finalName}"`,
    `del /f /q "%~f0"`,
    "endlocal",
    "exit /b 0",
    `:replace_failed`,
    `if exist "${bakBase}" ren "${bakBase}" "${currentName}" 2>nul`,
    `echo LOI: khong the thay EXE moi, da rollback ban cu > "_update-error.txt"`,
    `if exist "${currentName}" start "" "${currentName}"`,
    `if exist "${finalName}" start "" "${finalName}"`,
    `exit /b 1`,
    `:locked`,
    `echo LOI: EXE van dang bi khoa sau 30 giay > "_update-error.txt"`,
    `if exist "${currentName}" start "" "${currentName}"`,
    `exit /b 1`,
    "",
  ].join("\r\n");

  fs.writeFileSync(batPath, bat, "utf8");

  const payload = {
    ok: true,
    updated: true,
    message:
      `Cập nhật tại chỗ:\n` +
      `v${check.current_version} → v${check.latest_version}\n` +
      `File mới: ${finalName}\n` +
      `EXE bản cũ cùng thư mục sẽ bị XÓA. License & data giữ nguyên.` +
      "\nĐã tải xong. App sẽ tự khởi động lại…",
    from: check.current_version,
    to: check.latest_version,
    target_exe: path.join(exeDir, finalName),
    previous_exe: currentExe,
    final_name: finalName,
    dest: destNew,
    bat: batPath,
    inplace: true,
    preserves: ["data/", ".env", "license.json", "license.backup.json"],
    deletes_old_exes: true,
    sha256: actualHash,
  };

  setUpdateProgress({ state: "ready", bytes: Number(check.asset.size) || fs.statSync(destNew).size, total: Number(check.asset.size) || fs.statSync(destNew).size, percent: 100, message: "Đã tải xong, đang chuẩn bị khởi động lại…" });
  return payload;
}

/** Start exactly one background download. UI polls getUpdateProgress(). */
export function startUpdate() {
  if (activeUpdate) {
    return {
      started: false,
      already_running: true,
      progress: getUpdateProgress(),
      promise: activeUpdate,
    };
  }
  // Set checking immediately so the first UI poll never sees idle/inactive
  // (which previously made progress bar jump to "done" with 0%).
  setUpdateProgress({
    state: "checking",
    bytes: 0,
    total: 0,
    percent: 0,
    error: null,
    message: "Đang kiểm tra bản phát hành…",
  });
  activeUpdate = applyUpdate()
    .catch((e) => {
      setUpdateProgress({ state: "error", error: e.message, message: "Tải update thất bại" });
      return { ok: false, updated: false, error: e.message };
    })
    .finally(() => {
      activeUpdate = null;
    });
  return { started: true, already_running: false, progress: getUpdateProgress(), promise: activeUpdate };
}

/** Spawn update script (bat/ps1) and exit process shortly after. */
export function scheduleRestart(scriptPath, cwd) {
  const resolved = path.resolve(String(scriptPath || ""));
  const dir = cwd || path.dirname(resolved) || getExeDir();
  const isPs1 = /\.ps1$/i.test(resolved);
  try {
    if (isPs1) {
      spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", resolved],
        { detached: true, stdio: "ignore", cwd: dir, windowsHide: true }
      ).unref();
    } else {
      spawn("cmd.exe", ["/c", resolved], {
        detached: true,
        stdio: "ignore",
        cwd: dir,
        windowsHide: true,
      }).unref();
    }
  } catch {
    spawn("cmd.exe", ["/c", resolved], {
      detached: true,
      stdio: "ignore",
      cwd: dir,
      windowsHide: false,
    }).unref();
  }
  setTimeout(() => process.exit(0), 800);
}

/** Ask Electron parent to exit first; plain Node keeps a safe fallback. */
export function requestUpdateRestart(scriptPath, cwd) {
  setUpdateProgress({
    state: "restarting",
    message: "Đang đóng app cũ và cài / mở bản mới (giữ nguyên data)…",
    will_restart: true,
  });
  const script = path.resolve(String(scriptPath || ""));
  const workDir = path.resolve(String(cwd || path.dirname(script)));
  if (typeof process.send === "function") {
    try {
      process.send({
        type: "fbps-apply-update",
        batPath: script,
        cwd: workDir,
      });
      // If Electron parent never kills us (IPC bug), force-exit so script can ren EXE
      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
          /* ignore */
        }
      }, 6000);
      return true;
    } catch {
      /* fall through */
    }
  }
  scheduleRestart(script, workDir);
  return false;
}
