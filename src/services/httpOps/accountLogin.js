/**
 * Auto-login FB: id|pass|2fa — ưu tiên cookie còn sống, login khi dead.
 * Checkpoint 282 (mã email): chờ dán mã hoặc poll IMAP (nếu cấu hình).
 *
 * Nguyên tắc "ít lỗi":
 *  1) Không login nếu cookie alive
 *  2) Profile browser bền (giữ device trust)
 *  3) 2FA = TOTP từ secret
 *  4) 282 = chờ code (mail auto / tay) — không spam login
 *  5) Mọi fail = mã lỗi rõ (loginErrors.js)
 */
import path from "path";
import fs from "fs";
import { getDb } from "../../db/index.js";
import { encryptToken, decryptToken, maskToken } from "../crypto.js";
import { getDataDir } from "../../paths.js";
import { generateTotp, isLikelyTotpSecret } from "./totp.js";
import { loginError, classifyLoginPage, LOGIN_ERRORS } from "./loginErrors.js";
import {
  upsertSession,
  updateSessionCookie,
  getSessionPublic,
  markSessionStatus,
  ensureSessionTables,
} from "./cookieVault.js";
import { checkSessionHealth } from "./sessionClient.js";

function ensureLoginTables() {
  ensureSessionTables();
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS fb_login_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT '',
      login_id TEXT NOT NULL,
      pass_enc TEXT NOT NULL,
      totp_secret_enc TEXT,
      email_for_282 TEXT,
      email_imap_json_enc TEXT,
      proxy_url TEXT,
      user_agent TEXT,
      session_id INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      last_error_code TEXT,
      last_error_json TEXT,
      last_login_at TEXT,
      pending_challenge TEXT,
      pending_meta_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(login_id)
    );
    CREATE INDEX IF NOT EXISTS idx_login_accounts_status ON fb_login_accounts(status);

    CREATE TABLE IF NOT EXISTS fb_login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      phase TEXT,
      error_code TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Parse one line: id|pass|2fa  (2fa optional)
 * Also supports id|pass|2fa|email
 */
export function parseAccountLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#")) return null;
  const parts = raw.split("|").map((p) => p.trim());
  if (parts.length < 2) {
    return { error: loginError("BAD_FORMAT", raw.slice(0, 80)) };
  }
  const [loginId, password, twoFa = "", email282 = ""] = parts;
  if (!loginId || !password) {
    return { error: loginError("MISSING_CREDENTIALS") };
  }
  if (twoFa && !isLikelyTotpSecret(twoFa) && !/^[A-Za-z2-7=]{10,}$/i.test(twoFa)) {
    // allow short secrets; reject pure 6-digit
    if (/^\d{6}$/.test(twoFa)) {
      return { error: loginError("INVALID_2FA_SECRET", "Đừng dán mã 6 số — dán secret key") };
    }
  }
  return {
    loginId,
    password,
    totpSecret: twoFa || null,
    emailFor282: email282 || null,
  };
}

export function parseAccountBatch(text) {
  const lines = String(text || "").split(/\r?\n/);
  const ok = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const p = parseAccountLine(lines[i]);
    if (!p) continue;
    if (p.error) errors.push({ line: i + 1, ...p.error });
    else ok.push(p);
  }
  return { accounts: ok, errors };
}

function logAttempt(accountId, phase, errorCode, detail = "") {
  ensureLoginTables();
  getDb()
    .prepare(
      `INSERT INTO fb_login_attempts (account_id, phase, error_code, detail) VALUES (?,?,?,?)`
    )
    .run(accountId, phase, errorCode || null, String(detail || "").slice(0, 2000));
}

/**
 * @param {{ loginId: string, password: string, totpSecret?: string, emailFor282?: string, label?: string, proxyUrl?: string, emailImap?: object }} acc
 */
export function upsertLoginAccount(acc) {
  ensureLoginTables();
  const loginId = String(acc.loginId || acc.login_id || "").trim();
  if (!loginId || !acc.password) throw new Error("MISSING_CREDENTIALS");
  if (acc.totpSecret && /^\d{6}$/.test(String(acc.totpSecret).trim())) {
    throw Object.assign(new Error("INVALID_2FA_SECRET"), {
      loginError: loginError("INVALID_2FA_SECRET"),
    });
  }
  const label = acc.label || loginId;
  getDb()
    .prepare(
      `INSERT INTO fb_login_accounts
        (label, login_id, pass_enc, totp_secret_enc, email_for_282, email_imap_json_enc, proxy_url, user_agent, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle')
       ON CONFLICT(login_id) DO UPDATE SET
         label = excluded.label,
         pass_enc = excluded.pass_enc,
         totp_secret_enc = excluded.totp_secret_enc,
         email_for_282 = COALESCE(excluded.email_for_282, email_for_282),
         email_imap_json_enc = COALESCE(excluded.email_imap_json_enc, email_imap_json_enc),
         proxy_url = COALESCE(excluded.proxy_url, proxy_url),
         user_agent = COALESCE(excluded.user_agent, user_agent),
         updated_at = datetime('now')`
    )
    .run(
      label,
      loginId,
      encryptToken(acc.password),
      acc.totpSecret ? encryptToken(acc.totpSecret) : null,
      acc.emailFor282 || null,
      acc.emailImap ? encryptToken(JSON.stringify(acc.emailImap)) : null,
      acc.proxyUrl || null,
      acc.userAgent || null
    );
  return getLoginAccountPublicByLoginId(loginId);
}

export function importLoginBatch(text) {
  const { accounts, errors } = parseAccountBatch(text);
  const imported = [];
  for (const a of accounts) {
    try {
      imported.push(upsertLoginAccount(a));
    } catch (e) {
      errors.push({
        line: a.loginId,
        ...(e.loginError || loginError("UNKNOWN", e.message)),
      });
    }
  }
  return { imported, errors, count: imported.length };
}

export function listLoginAccountsPublic() {
  ensureLoginTables();
  return getDb()
    .prepare(
      `SELECT id, label, login_id, email_for_282, proxy_url, session_id, status,
              last_error_code, last_login_at, pending_challenge, created_at, updated_at,
              CASE WHEN totp_secret_enc IS NOT NULL THEN 1 ELSE 0 END AS has_2fa,
              CASE WHEN email_imap_json_enc IS NOT NULL THEN 1 ELSE 0 END AS has_imap
       FROM fb_login_accounts ORDER BY id DESC`
    )
    .all()
    .map((r) => ({
      ...r,
      has_2fa: !!r.has_2fa,
      has_imap: !!r.has_imap,
      error_info: r.last_error_code
        ? LOGIN_ERRORS[r.last_error_code] || LOGIN_ERRORS.UNKNOWN
        : null,
    }));
}

export function getLoginAccountPublicByLoginId(loginId) {
  return listLoginAccountsPublic().find((a) => a.login_id === loginId) || null;
}

export function getLoginAccountPublic(id) {
  return listLoginAccountsPublic().find((a) => a.id === Number(id)) || null;
}

function loadAccountSecrets(id) {
  ensureLoginTables();
  const row = getDb()
    .prepare(`SELECT * FROM fb_login_accounts WHERE id = ?`)
    .get(Number(id));
  if (!row) return null;
  return {
    row,
    password: decryptToken(row.pass_enc),
    totpSecret: row.totp_secret_enc ? decryptToken(row.totp_secret_enc) : null,
    emailImap: row.email_imap_json_enc
      ? JSON.parse(decryptToken(row.email_imap_json_enc) || "null")
      : null,
  };
}

function setAccountStatus(id, status, errObj = null, extra = {}) {
  ensureLoginTables();
  getDb()
    .prepare(
      `UPDATE fb_login_accounts SET
         status = ?,
         last_error_code = ?,
         last_error_json = ?,
         pending_challenge = COALESCE(?, pending_challenge),
         pending_meta_json = COALESCE(?, pending_meta_json),
         session_id = COALESCE(?, session_id),
         last_login_at = CASE WHEN ? = 'alive' THEN datetime('now') ELSE last_login_at END,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(
      status,
      errObj?.code || null,
      errObj ? JSON.stringify(errObj) : null,
      extra.pending_challenge ?? null,
      extra.pending_meta_json ?? null,
      extra.session_id ?? null,
      status,
      Number(id)
    );
}

function profileDirFor(accountId) {
  const dir = path.join(getDataDir(), "fb-login-profiles", `acc_${accountId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Prefer cookie reuse — "tiện và ít lỗi" rule #1
 */
export async function ensureSessionForAccount(accountId, opts = {}) {
  ensureLoginTables();
  const secrets = loadAccountSecrets(accountId);
  if (!secrets) return loginError("UNKNOWN", "account not found");

  const sessionId = secrets.row.session_id;
  if (sessionId && !opts.forceLogin) {
    try {
      const health = await checkSessionHealth(sessionId);
      if (health.ok) {
        setAccountStatus(accountId, "alive", loginError("COOKIE_ALIVE"));
        logAttempt(accountId, "cookie_reuse", "COOKIE_ALIVE");
        return {
          ...loginError("COOKIE_ALIVE"),
          session_id: sessionId,
          session: getSessionPublic(sessionId),
        };
      }
    } catch {
      /* fall through to login */
    }
  }

  return runAutoLogin(accountId, opts);
}

/**
 * Full auto login attempt (browser). Falls back to clear errors if Playwright missing.
 */
export async function runAutoLogin(accountId, opts = {}) {
  ensureLoginTables();
  const secrets = loadAccountSecrets(accountId);
  if (!secrets) return loginError("UNKNOWN", "account not found");

  setAccountStatus(accountId, "logging_in", null);
  logAttempt(accountId, "login_start", null);

  let browserLogin;
  try {
    browserLogin = await import("./browserLogin.js");
  } catch (e) {
    const err = loginError("BROWSER_NOT_AVAILABLE", e.message);
    setAccountStatus(accountId, "error", err);
    logAttempt(accountId, "browser", err.code, err.detail);
    return err;
  }

  try {
    const totpCode = secrets.totpSecret
      ? generateTotp(secrets.totpSecret)
      : null;

    const result = await browserLogin.loginWithBrowser({
      loginId: secrets.row.login_id,
      password: secrets.password,
      totpCode,
      proxyUrl: secrets.row.proxy_url || opts.proxyUrl,
      userDataDir: profileDirFor(accountId),
      headless: opts.headless === true, // default headed (ổn định hơn)
      timeoutMs: opts.timeoutMs || 120000,
    });

    if (result.ok && result.cookieHeader) {
      let session;
      if (secrets.row.session_id) {
        session = updateSessionCookie(secrets.row.session_id, result.cookieHeader, {
          label: secrets.row.label,
          proxyUrl: secrets.row.proxy_url,
        });
      } else {
        session = upsertSession({
          label: secrets.row.label || secrets.row.login_id,
          cookie: result.cookieHeader,
          proxyUrl: secrets.row.proxy_url,
          fbUserId: result.fbUserId,
          name: result.name,
        });
      }
      markSessionStatus(session.id, "alive", null);
      const ok = loginError("OK", "login success");
      setAccountStatus(accountId, "alive", ok, { session_id: session.id });
      logAttempt(accountId, "login_ok", "OK");
      return { ...ok, session_id: session.id, session };
    }

    // Checkpoint 282 — wait for email code
    if (result.code === "CHECKPOINT_282" || result.code === "CHECKPOINT_282_CODE_SENT") {
      const err = loginError(
        result.code === "CHECKPOINT_282_CODE_SENT"
          ? "CHECKPOINT_282_CODE_SENT"
          : "CHECKPOINT_282",
        result.detail
      );
      setAccountStatus(accountId, "wait_282_code", err, {
        pending_challenge: "282_email",
        pending_meta_json: JSON.stringify({
          since: new Date().toISOString(),
          profile: profileDirFor(accountId),
          hint: result.detail,
        }),
      });
      logAttempt(accountId, "checkpoint_282", err.code, result.detail);

      // Optional: try IMAP poll once in background style (sync short poll)
      if (secrets.emailImap || opts.pollEmail) {
        const code = await tryPollEmailCode(secrets, opts.emailPollMs || 45000);
        if (code) {
          return submitCheckpoint282Code(accountId, code, opts);
        }
        const mailErr = loginError(
          "EMAIL_CODE_NOT_FOUND",
          "Poll mail xong chưa thấy mã — chờ dán tay"
        );
        setAccountStatus(accountId, "wait_282_code", mailErr, {
          pending_challenge: "282_email",
        });
        return {
          ...loginError("CHECKPOINT_282_WAIT_CODE", "Cần dán mã email 282"),
          account_id: accountId,
          need_code: true,
          submit_path: `/api/http-ops/login/accounts/${accountId}/submit-282-code`,
        };
      }

      return {
        ...err,
        account_id: accountId,
        need_code: true,
        submit_path: `/api/http-ops/login/accounts/${accountId}/submit-282-code`,
      };
    }

    const err = loginError(result.code || "UNKNOWN", result.detail || result.message);
    setAccountStatus(accountId, "error", err);
    logAttempt(accountId, "login_fail", err.code, err.detail);
    return err;
  } catch (e) {
    const msg = e?.message || String(e);
    let code = "UNKNOWN";
    if (/BROWSER_NOT_AVAILABLE|playwright|Cannot find module/i.test(msg)) {
      code = "BROWSER_NOT_AVAILABLE";
    } else if (/timeout/i.test(msg)) code = "BROWSER_TIMEOUT";
    else if (/proxy/i.test(msg)) code = "PROXY_ERROR";
    else if (/fetch failed|ENOTFOUND|ECONN/i.test(msg)) code = "NETWORK";
    const err = loginError(code, msg);
    setAccountStatus(accountId, "error", err);
    logAttempt(accountId, "exception", err.code, msg);
    return err;
  }
}

/**
 * User / IMAP submits email verification code for checkpoint 282.
 */
export async function submitCheckpoint282Code(accountId, code, opts = {}) {
  ensureLoginTables();
  const secrets = loadAccountSecrets(accountId);
  if (!secrets) return loginError("UNKNOWN", "account not found");
  const cleaned = String(code || "").replace(/\s+/g, "");
  if (!/^\d{4,8}$/.test(cleaned)) {
    return loginError("CHECKPOINT_282_BAD_CODE", "Mã phải 4–8 chữ số");
  }

  setAccountStatus(accountId, "submitting_282", null);
  logAttempt(accountId, "submit_282", null, "****" + cleaned.slice(-2));

  let browserLogin;
  try {
    browserLogin = await import("./browserLogin.js");
  } catch (e) {
    const err = loginError("BROWSER_NOT_AVAILABLE", e.message);
    setAccountStatus(accountId, "error", err);
    return err;
  }

  try {
    const result = await browserLogin.submitEmailCode({
      userDataDir: profileDirFor(accountId),
      code: cleaned,
      proxyUrl: secrets.row.proxy_url,
      headless: opts.headless === true,
      timeoutMs: opts.timeoutMs || 90000,
    });

    if (result.ok && result.cookieHeader) {
      let session;
      if (secrets.row.session_id) {
        session = updateSessionCookie(secrets.row.session_id, result.cookieHeader, {
          label: secrets.row.label,
        });
      } else {
        session = upsertSession({
          label: secrets.row.label || secrets.row.login_id,
          cookie: result.cookieHeader,
          fbUserId: result.fbUserId,
        });
      }
      const ok = loginError("OK", "282 passed");
      setAccountStatus(accountId, "alive", ok, {
        session_id: session.id,
        pending_challenge: "",
        pending_meta_json: "{}",
      });
      // clear pending
      getDb()
        .prepare(
          `UPDATE fb_login_accounts SET pending_challenge = NULL, pending_meta_json = NULL WHERE id = ?`
        )
        .run(Number(accountId));
      logAttempt(accountId, "282_ok", "OK");
      return { ...ok, session_id: session.id, session };
    }

    const err = loginError(
      result.code || "CHECKPOINT_282_BAD_CODE",
      result.detail || result.message
    );
    setAccountStatus(accountId, "wait_282_code", err, {
      pending_challenge: "282_email",
    });
    logAttempt(accountId, "282_fail", err.code, err.detail);
    return err;
  } catch (e) {
    const err = loginError("UNKNOWN", e.message);
    setAccountStatus(accountId, "error", err);
    return err;
  }
}

/** Short IMAP poll — requires optional `imapflow` package */
async function tryPollEmailCode(secrets, timeoutMs = 45000) {
  const imapCfg = secrets.emailImap;
  if (!imapCfg?.host || !imapCfg?.user || !imapCfg?.pass) return null;
  try {
    const { pollFacebookEmailCode } = await import("./emailCodePoll.js");
    return await pollFacebookEmailCode(imapCfg, { timeoutMs });
  } catch {
    return null;
  }
}

export function listLoginErrorCatalog() {
  return Object.values(LOGIN_ERRORS);
}

export function listRecentAttempts(accountId, limit = 20) {
  ensureLoginTables();
  return getDb()
    .prepare(
      `SELECT * FROM fb_login_attempts WHERE account_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(Number(accountId), Number(limit));
}

export function previewTotp(accountId) {
  const secrets = loadAccountSecrets(accountId);
  if (!secrets?.totpSecret) return { ok: false, error: "no 2fa secret" };
  try {
    return {
      ok: true,
      code: generateTotp(secrets.totpSecret),
      // never return secret
      note: "Mã đổi mỗi 30s — chỉ để debug",
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export { loginError, classifyLoginPage };
