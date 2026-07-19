/**
 * License / activation key (commercial + employee + trial).
 *
 * Design (honest anti-crack):
 * - Ed25519 signed payload — only YOU hold private key (keys/license-private.pem)
 * - Public key embedded for offline verify
 * - Optional machine bind (HWID)
 * - Limits: max_accounts, max_pages, expires_at, features
 * - This DETERS casual crack/copy; determined reverse-engineering of desktop
 *   apps can still patch — pair with later online check if needed.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { config } from "../config.js";
import { LICENSE_PUBLIC_KEY_PEM } from "./licensePublicKey.js";

const LICENSE_FILE = () =>
  path.join(config.dataDir || path.dirname(config.databasePath), "license.json");

/** Soft trial if no key: days from first run */
const TRIAL_DAYS = Number(process.env.LICENSE_TRIAL_DAYS || 7);
const TRIAL_MAX_ACCOUNTS = Number(process.env.LICENSE_TRIAL_MAX_ACCOUNTS || 2);
const TRIAL_MAX_PAGES = Number(process.env.LICENSE_TRIAL_MAX_PAGES || 6);

const FIRST_RUN_FILE = () =>
  path.join(config.dataDir || path.dirname(config.databasePath), ".first_run");

export function getMachineId() {
  try {
    const raw = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.cpus()?.[0]?.model || "",
      os.totalmem(),
    ].join("|");
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
  } catch {
    return "unknown-machine";
  }
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

/**
 * Verify license key string: payload.sig (base64url)
 * @returns {{ ok: boolean, claims?: object, error?: string }}
 */
export function verifyLicenseKey(keyString) {
  try {
    const raw = String(keyString || "").trim().replace(/\s+/g, "");
    if (!raw || !raw.includes(".")) {
      return { ok: false, error: "Key không đúng định dạng (payload.chữ_ký)" };
    }
    const [payloadB64, sigB64] = raw.split(".");
    if (!payloadB64 || !sigB64) {
      return { ok: false, error: "Key thiếu payload hoặc chữ ký" };
    }
    const payloadBuf = b64urlDecode(payloadB64);
    const sigBuf = b64urlDecode(sigB64);
    const ok = crypto.verify(
      null,
      payloadBuf,
      LICENSE_PUBLIC_KEY_PEM,
      sigBuf
    );
    if (!ok) return { ok: false, error: "Chữ ký key không hợp lệ (sai key / giả mạo)" };

    const claims = JSON.parse(payloadBuf.toString("utf8"));
    if (!claims || typeof claims !== "object") {
      return { ok: false, error: "Payload key không đọc được" };
    }

    // Lifetime / no date = never expires. Dated keys only fail after expires_at.
    const isLifetime =
      claims.type === "lifetime" ||
      claims.lifetime === true ||
      claims.expires_at == null ||
      claims.expires_at === "" ||
      String(claims.expires_at).toLowerCase() === "never";
    if (!isLifetime && claims.expires_at) {
      const exp = new Date(claims.expires_at).getTime();
      if (Number.isFinite(exp) && Date.now() > exp) {
        return {
          ok: false,
          error: `Key hết hạn (${claims.expires_at})`,
          claims,
          expired: true,
        };
      }
    }

    if (claims.machine_id && claims.machine_id !== "ANY") {
      const mid = getMachineId();
      if (claims.machine_id !== mid) {
        return {
          ok: false,
          error: "Key gắn máy khác (machine_id không khớp). Xin key mới hoặc key không bind máy.",
          claims,
        };
      }
    }

    if (claims.revoked) {
      return { ok: false, error: "Key đã bị thu hồi", claims };
    }

    return { ok: true, claims };
  } catch (e) {
    return { ok: false, error: e.message || "Verify key lỗi" };
  }
}

export function loadStoredLicense() {
  try {
    const f = LICENSE_FILE();
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

export function saveLicense(keyString, claims) {
  const f = LICENSE_FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const data = {
    key: keyString.trim().replace(/\s+/g, ""),
    claims,
    activated_at: new Date().toISOString(),
    machine_id: getMachineId(),
    /** Survives app auto-update (stored under data/, not inside .exe) */
    preserve_across_updates: true,
  };
  fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
  // Mirror next to data parent for recovery if data/ path shifts slightly
  try {
    const mirror = path.join(
      path.dirname(path.dirname(f)),
      "license.backup.json"
    );
    fs.writeFileSync(mirror, JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* ignore */
  }
  return data;
}

/** Absolute path of active license file (for update docs / status) */
export function getLicenseFilePath() {
  return LICENSE_FILE();
}

/**
 * Candidate license files when data/license.json is missing (portable EXE
 * folder vs project root data/, update backup, explicit bootstrap path).
 */
function licenseRecoveryCandidates(primary) {
  const exeDir = path.dirname(path.dirname(primary)); // …/data → parent of data
  const list = [
    path.join(exeDir, "license.backup.json"),
    path.join(exeDir, "license.json"),
    // Dev / admin: project root data when running from FB-Page-Studio-App/
    path.join(exeDir, "..", "data", "license.json"),
    path.join(exeDir, "..", "license.json"),
    process.env.LICENSE_BOOTSTRAP_PATH
      ? path.resolve(String(process.env.LICENSE_BOOTSTRAP_PATH))
      : "",
  ].filter(Boolean);
  // de-dupe + drop primary
  const seen = new Set([path.resolve(primary)]);
  return list.filter((p) => {
    const abs = path.resolve(p);
    if (seen.has(abs)) return false;
    seen.add(abs);
    return true;
  });
}

/**
 * Ensure license still valid after app update / restart.
 * Does NOT re-prompt if key on disk is still valid (lifetime or not expired).
 * Tries license.backup.json and nearby admin/project license files if missing.
 */
export function ensureLicenseAfterUpdate() {
  const primary = LICENSE_FILE();

  if (!fs.existsSync(primary)) {
    for (const candidate of licenseRecoveryCandidates(primary)) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
        const key = String(raw?.key || "").trim();
        if (!key) continue;
        const v = verifyLicenseKey(key);
        if (!v.ok) {
          console.warn(
            `[license] Bỏ qua file recovery không hợp lệ: ${candidate} · ${v.error}`
          );
          continue;
        }
        fs.mkdirSync(path.dirname(primary), { recursive: true });
        // Normalize into active data/license.json (same machine)
        saveLicense(key, v.claims);
        console.log(
          `[license] Khôi phục license từ ${candidate} → ${primary}`
        );
        break;
      } catch (e) {
        console.warn(
          `[license] restore from ${candidate} failed:`,
          e.message
        );
      }
    }
  }

  const st = getLicenseStatus();
  if (st.active && st.source === "key") {
    const exp =
      st.claims?.type === "lifetime" || !st.expires_at
        ? "vĩnh viễn"
        : st.expires_at;
    console.log(
      `[license] Key còn hiệu lực sau update · ${st.label} · hết hạn: ${exp}`
    );
  } else if (st.mode === "invalid" && st.error) {
    console.warn(`[license] Key trên máy không còn hợp lệ: ${st.error}`);
  } else if (st.mode === "trial") {
    console.log(`[license] Trial · còn ~${st.trial?.days_left ?? "?"} ngày`);
  }
  return st;
}

export function clearLicense() {
  const f = LICENSE_FILE();
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

function ensureFirstRun() {
  const f = FIRST_RUN_FILE();
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      JSON.stringify({ first_run_at: new Date().toISOString() }, null, 2),
      "utf8"
    );
  }
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return { first_run_at: new Date().toISOString() };
  }
}

/**
 * Effective license status for the running app.
 */
export function getLicenseStatus() {
  const machine_id = getMachineId();
  const stored = loadStoredLicense();

  if (stored?.key) {
    const v = verifyLicenseKey(stored.key);
    if (v.ok) {
      const c = v.claims || {};
      const isLifetime =
        c.type === "lifetime" ||
        c.lifetime === true ||
        !c.expires_at ||
        String(c.expires_at).toLowerCase() === "never";
      return {
        active: true,
        mode: c.type || "licensed",
        source: "key",
        claims: c,
        machine_id,
        label: licenseLabel(c),
        limits: {
          max_accounts: Number(c.max_accounts) || 0, // 0 = unlimited
          max_pages: Number(c.max_pages) || 0,
        },
        expires_at: isLifetime ? null : c.expires_at || null,
        is_lifetime: isLifetime,
        holder: c.holder || c.email || c.name || null,
        message: isLifetime
          ? "License hợp lệ · vĩnh viễn (giữ sau mỗi lần update app)"
          : "License hợp lệ · còn hạn (giữ sau mỗi lần update app)",
        preserve_across_updates: true,
        license_file: LICENSE_FILE(),
      };
    }
    // Expired / invalid — keep file on disk, do not wipe on app update
    return {
      active: false,
      mode: v.expired ? "expired_key" : "invalid",
      source: "key",
      error: v.error,
      claims: v.claims || stored.claims || null,
      machine_id,
      label: v.expired ? "Key hết hạn" : "Key không hợp lệ",
      limits: trialLimits(),
      message: v.error || "Key lỗi — nhập key mới",
      trial: buildTrialInfo(),
      preserve_across_updates: true,
    };
  }

  const trial = buildTrialInfo();
  if (trial.active) {
    return {
      active: true,
      mode: "trial",
      source: "trial",
      machine_id,
      label: `Trial ${trial.days_left} ngày`,
      limits: trialLimits(),
      expires_at: trial.expires_at,
      message: `Dùng thử ${TRIAL_DAYS} ngày · giới hạn account/page`,
      trial,
    };
  }

  return {
    active: false,
    mode: "expired",
    source: "none",
    machine_id,
    label: "Chưa kích hoạt",
    limits: { max_accounts: 0, max_pages: 0 },
    message: "Hết trial — nhập license key để tiếp tục",
    trial,
  };
}

function trialLimits() {
  return {
    max_accounts: TRIAL_MAX_ACCOUNTS,
    max_pages: TRIAL_MAX_PAGES,
  };
}

function buildTrialInfo() {
  const fr = ensureFirstRun();
  const start = new Date(fr.first_run_at).getTime();
  const end = start + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  const left = Math.max(0, end - Date.now());
  return {
    active: Date.now() < end,
    first_run_at: fr.first_run_at,
    expires_at: new Date(end).toISOString(),
    days_left: Math.ceil(left / (24 * 60 * 60 * 1000)),
  };
}

function licenseLabel(c) {
  const t = c.type || "licensed";
  const map = {
    trial: "Trial",
    employee: "Nhân viên",
    commercial: "Thương mại",
    partner: "Đối tác",
    lifetime: "Vĩnh viễn",
  };
  const name = map[t] || t;
  const holder = c.holder || c.email || "";
  return holder ? `${name} · ${holder}` : name;
}

/**
 * Gate: can we add/use more accounts or pages?
 */
export function checkQuota(kind, currentCount) {
  const st = getLicenseStatus();
  if (!st.active && st.mode === "expired") {
    return {
      ok: false,
      error: "Chưa có license / hết trial. Vào License để nhập key.",
      status: st,
    };
  }
  const limits = st.limits || {};
  if (kind === "account" && limits.max_accounts > 0 && currentCount >= limits.max_accounts) {
    return {
      ok: false,
      error: `License giới hạn ${limits.max_accounts} account (hiện ${currentCount}). Nâng key.`,
      status: st,
    };
  }
  if (kind === "page" && limits.max_pages > 0 && currentCount >= limits.max_pages) {
    return {
      ok: false,
      error: `License giới hạn ${limits.max_pages} page (hiện ${currentCount}). Nâng key.`,
      status: st,
    };
  }
  // Publish hard block if fully expired
  if (!st.active) {
    return {
      ok: false,
      error: st.message || "License không active",
      status: st,
    };
  }
  return { ok: true, status: st };
}

/** Block publish/schedule when license dead */
export function assertCanPublish() {
  const st = getLicenseStatus();
  if (st.active) return st;
  const err = new Error(
    st.error || st.message || "License không hợp lệ — không thể đăng bài"
  );
  err.code = "LICENSE";
  err.license = st;
  throw err;
}

export function activateLicense(keyString) {
  const v = verifyLicenseKey(keyString);
  if (!v.ok) {
    return { ok: false, error: v.error, claims: v.claims || null };
  }
  const saved = saveLicense(keyString, v.claims);
  return { ok: true, status: getLicenseStatus(), saved };
}

/**
 * Sign claims with private key (vendor tool only).
 * @param {object} claims
 * @param {string} privateKeyPem
 */
export function signLicenseClaims(claims, privateKeyPem) {
  const payload = {
    v: 1,
    ...claims,
    issued_at: claims.issued_at || new Date().toISOString(),
  };
  const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const sig = crypto.sign(null, payloadBuf, privateKeyPem);
  return `${b64url(payloadBuf)}.${b64url(sig)}`;
}
