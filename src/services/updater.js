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

function downloadFileOnce(url, dest, onProgress, maxRedirects = 8) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error("Quá nhiều redirect khi tải EXE"));
      return;
    }
    const lib = String(url).startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
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
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch {
            /* ignore */
          }
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          downloadFileOnce(next, dest, onProgress, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch {
            /* ignore */
          }
          res.resume();
          reject(new Error(`Download HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers["content-length"] || 0);
        let got = 0;
        res.on("data", (chunk) => {
          got += chunk.length;
          if (onProgress && total) onProgress(got, total);
        });
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(dest)));
      }
    );
    req.on("error", (e) => {
      try {
        file.close();
        fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      reject(e);
    });
    req.on("timeout", () => {
      req.destroy();
      try {
        file.close();
        fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      reject(new Error("Download timeout"));
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

  // Snapshot license (data/ never deleted)
  try {
    const dataLic = path.join(exeDir, "data", "license.json");
    const bakLic = path.join(exeDir, "license.backup.json");
    if (fs.existsSync(dataLic)) {
      fs.copyFileSync(dataLic, bakLic);
    }
  } catch {
    /* ignore */
  }

  // 1) Unlock current EXE → .bak  2) Place new as finalName (v{new})  3) DELETE all other Desktop EXEs
  //    so Explorer shows the new version number and no leftover v1.2.25/v1.2.27.
  const bakBase = path.basename(destBak);
  const newBase = path.basename(destNew);
  const bat = [
    "@echo off",
    "setlocal EnableExtensions",
    `cd /d "${exeDir}"`,
    `del /f /q "_update-error.txt" 2>nul`,
    "timeout /t 1 /nobreak >nul",
    "set /a tries=0",
    `:retry`,
    "set /a tries+=1",
    "if %tries% GTR 30 goto locked",
    // Free the currently running file (any old name)
    `if exist "${currentName}" (`,
    `  del /f /q "${bakBase}" 2>nul`,
    `  ren "${currentName}" "${bakBase}" 2>nul`,
    `  if exist "${currentName}" (`,
    `    timeout /t 1 /nobreak >nul`,
    `    goto retry`,
    `  )`,
    `)`,
    // If finalName already exists (another copy), free it too
    `if /I not "${currentName}"=="${finalName}" if exist "${finalName}" (`,
    `  del /f /q "${finalName}.old" 2>nul`,
    `  ren "${finalName}" "${finalName}.old" 2>nul`,
    `  if exist "${finalName}" (`,
    `    timeout /t 1 /nobreak >nul`,
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

/** Spawn update bat and exit process shortly after */
export function scheduleRestart(batPath, cwd) {
  spawn("cmd.exe", ["/c", batPath], {
    detached: true,
    stdio: "ignore",
    cwd: cwd || getExeDir(),
    windowsHide: true,
  }).unref();
  setTimeout(() => process.exit(0), 600);
}

/** Ask Electron parent to exit first; plain Node keeps a safe fallback. */
export function requestUpdateRestart(batPath, cwd) {
  setUpdateProgress({ state: "restarting", message: "Đang đóng app cũ và thay EXE…" });
  if (typeof process.send === "function") {
    process.send({ type: "fbps-apply-update", batPath, cwd });
    return true;
  }
  scheduleRestart(batPath, cwd);
  return false;
}
