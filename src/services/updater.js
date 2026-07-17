/**
 * GitHub Releases auto-update for portable .exe
 * Checks latest release, downloads asset, stages replace on restart.
 */
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { spawn } from "child_process";
import { getExeDir, getOuterExePath, getPackageJson, isPackaged } from "../paths.js";
import { config } from "../config.js";

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
export function pickReleaseAsset(assets, preferredName) {
  const list = Array.isArray(assets) ? assets : [];
  if (!list.length) return null;
  const byName = (n) => list.find((a) => a.name === n);
  const prefer = [
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

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": "FB-Page-Studio-Updater",
          Accept: "application/vnd.github+json",
          ...headers,
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchJson(res.headers.location, headers).then(resolve, reject);
          return;
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`GitHub HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("GitHub request timeout"));
    });
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": "FB-Page-Studio-Updater",
          Accept: "application/octet-stream",
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          file.close();
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
  });
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

  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.name}/releases/latest`;
  let release;
  try {
    release = await fetchJson(url);
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      current_version: cfg.current_version,
      github_repo: `${parsed.owner}/${parsed.name}`,
    };
  }

  if (release.message) {
    return {
      ok: false,
      error: release.message,
      current_version: cfg.current_version,
      github_repo: `${parsed.owner}/${parsed.name}`,
    };
  }

  const tag = release.tag_name || release.name || "";
  const remoteVersion = String(tag).replace(/^v/i, "");
  const assets = release.assets || [];
  const asset = pickReleaseAsset(assets, cfg.asset_name);

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
    missing_asset: newer && !asset,
    github_repo: `${parsed.owner}/${parsed.name}`,
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
export async function applyUpdate({ restart = true } = {}) {
  const check = await checkForUpdate();
  if (!check.ok) return check;
  if (!check.has_update) {
    return { ok: true, updated: false, message: "Đã là phiên bản mới nhất", ...check };
  }
  if (!check.asset?.download_url) {
    return {
      ok: false,
      error: `Release có tag ${check.latest_version} nhưng không có file .exe trên GitHub (cần upload asset). Không mở bản khác — chờ admin upload rồi bấm lại.`,
      ...check,
    };
  }

  // Prefer exact path of running outer portable exe (FB_OUTER_EXE from Electron)
  const currentExe = getOuterExePath();
  const exeDir = path.dirname(currentExe);
  const targetName = path.basename(currentExe) || getUpdateConfig().asset_name;
  // Always stage next to current app — same folder, same final name
  const destNew = path.join(exeDir, targetName + ".new");
  const destBak = path.join(exeDir, targetName + ".bak");
  const batPath = path.join(exeDir, "_apply_update.bat");

  // Clean old leftovers so user doesn't see "many versions"
  for (const junk of [
    destNew,
    path.join(exeDir, "FB-Page-Studio-Desktop.exe.new"),
    path.join(exeDir, "FB-Page-Studio.exe.new"),
  ]) {
    try {
      if (fs.existsSync(junk)) fs.unlinkSync(junk);
    } catch {
      /* ignore */
    }
  }

  await downloadFile(check.asset.download_url, destNew);

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

  // Replace IN PLACE: old → .bak → delete; .new → same original name; start same path
  const bat = [
    "@echo off",
    "setlocal",
    `cd /d "${exeDir}"`,
    "echo Cap nhat TAI CHO — cung file, cung thu muc...",
    `echo Target: ${targetName}`,
    "echo Giữ data, .env, license (khong tao app moi).",
    "timeout /t 2 /nobreak >nul",
    `:retry`,
    `if exist "${targetName}" (`,
    `  del /f /q "${path.basename(destBak)}" 2>nul`,
    `  ren "${targetName}" "${path.basename(destBak)}" 2>nul`,
    `  if exist "${targetName}" (`,
    `    timeout /t 1 /nobreak >nul`,
    `    goto retry`,
    `  )`,
    `)`,
    `if not exist "${path.basename(destNew)}" (`,
    `  echo LOI: khong thay file .new`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `move /y "${path.basename(destNew)}" "${targetName}"`,
    `del /f /q "${path.basename(destBak)}" 2>nul`,
    `del /f /q "*.new" 2>nul`,
    `if exist "license.backup.json" if not exist "data\\license.json" (`,
    `  if not exist "data" mkdir "data"`,
    `  copy /y "license.backup.json" "data\\license.json" >nul`,
    `)`,
    `start "" "${targetName}"`,
    `del /f /q "%~f0"`,
    "endlocal",
    "",
  ].join("\r\n");

  fs.writeFileSync(batPath, bat, "utf8");

  const payload = {
    ok: true,
    updated: true,
    message:
      `Cập nhật tại chỗ: ${currentExe}\n` +
      `v${check.current_version} → v${check.latest_version}\n` +
      `Cùng file/tên — không tạo bản app khác. License & data giữ nguyên.` +
      (restart ? "\nĐang khởi động lại…" : ""),
    from: check.current_version,
    to: check.latest_version,
    target_exe: currentExe,
    dest: destNew,
    bat: batPath,
    inplace: true,
    preserves: ["data/", ".env", "license.json", "license.backup.json"],
  };

  if (restart) {
    scheduleRestart(batPath, exeDir);
  }

  return payload;
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
