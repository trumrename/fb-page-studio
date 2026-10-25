/**
 * Track Graph API usage from response headers.
 * Note: Page access tokens often return x-business-use-case-usage only.
 * App-level % (dashboard) comes from x-app-usage — usually needs App Access Token.
 *
 * Also: detect rate-limit errors + wait/resume helpers for bulk jobs.
 */

import { config, graphBase } from "../config.js";
import { getDb } from "../db/index.js";
import { decryptToken } from "./crypto.js";

let lastUsage = {
  call_count: 0,
  total_time: 0,
  total_cputime: 0,
  updated_at: null,
  source: null,
  raw: null,
  estimated_time_to_regain_access_min: null,
  page_usage_raw: null,
};

/**
 * Per-Meta-App Graph pause — Meta best practice 2024–2026:
 * "When the limit has been reached, stop making API calls."
 * IMPORTANT: pause is keyed by meta_app_key (App 1 / App 2…).
 * Trước đây 1 GLOBAL pause → App 2 bị dừng dù chỉ App 1 bị #4.
 */
const DEFAULT_APP_KEY = "_default";
/** @type {Map<string, { until: number, hits: number, code: number|null, lastNotifyAt: number }>} */
const appGraphPauses = new Map();

function normalizeAppKey(metaAppKey) {
  const k = String(metaAppKey ?? "").trim();
  return k || DEFAULT_APP_KEY;
}

function getAppPauseState(metaAppKey) {
  const key = normalizeAppKey(metaAppKey);
  let st = appGraphPauses.get(key);
  if (!st) {
    st = { until: 0, hits: 0, code: null, lastNotifyAt: 0 };
    appGraphPauses.set(key, st);
  }
  return st;
}

/** @deprecated kept for older call sites — maps to default app bucket */
let lastGlobalNotifyAt = 0;

/** Max concurrent LIST page jobs (pagination is the #4 killer). Delete uses separate parallel. */
let listSlotMax = 1;
let listSlotCurrent = 0;
/** @type {Array<() => void>} */
const listSlotWaiters = [];

/** Meta error codes commonly used for throttling / rate limits */
const RATE_LIMIT_CODES = new Set([
  4, // Application request limit reached
  17, // User request limit reached
  32, // Page request limit reached
  613, // Calls to this api have exceeded the rate limit
  80004, // There have been too many calls to this fb application
  80001, // Temporary block / too many calls (varies)
  80000,
  80003,
  80005,
  80006,
  80014,
]);

const RATE_LIMIT_SUBCODES = new Set([
  2446079, // User request limit reached (common subcode)
  1504022,
  1487742,
]);

export function getLastUsage() {
  return { ...lastUsage };
}

export function parseUsageHeader(headerVal) {
  if (!headerVal) return null;
  try {
    return JSON.parse(headerVal);
  } catch {
    return null;
  }
}

function applyAppUsage(u, source, raw) {
  if (!u || typeof u !== "object") return;
  const call = Number(u.call_count);
  if (!Number.isFinite(call)) return;
  // Always take the latest app-usage snapshot (Meta rolling window %)
  lastUsage = {
    ...lastUsage,
    call_count: call,
    total_time: Number(u.total_time) || 0,
    total_cputime: Number(u.total_cputime) || 0,
    updated_at: new Date().toISOString(),
    source,
    raw: raw || u,
  };
}

/**
 * Meta: hạn mức là max(call_count, total_time, total_cputime), không chỉ call_count.
 * x-app-usage là object phẳng. x-business-use-case-usage là { id: [ row, ... ] }.
 * Page token thường chỉ có header BUC. Cả hai đến từ cùng một response, không gọi thêm.
 */
export function peakFromUsageObjects(...sources) {
  let call = null;
  let time = null;
  let cpu = null;
  let regain = null;
  const visit = (row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    const c = Number(row.call_count);
    const t = Number(row.total_time);
    const cpuN = Number(row.total_cputime);
    const g = Number(row.estimated_time_to_regain_access);
    if (Number.isFinite(c)) call = call == null ? c : Math.max(call, c);
    if (Number.isFinite(t)) time = time == null ? t : Math.max(time, t);
    if (Number.isFinite(cpuN)) cpu = cpu == null ? cpuN : Math.max(cpu, cpuN);
    if (Number.isFinite(g) && g > 0) regain = regain == null ? g : Math.max(regain, g);
  };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (
      node.call_count != null ||
      node.total_time != null ||
      node.total_cputime != null ||
      node.estimated_time_to_regain_access != null
    ) {
      visit(node);
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") walk(v);
    }
  };
  for (const src of sources) walk(src);
  const parts = [call, time, cpu].filter((n) => Number.isFinite(n));
  return {
    peak: parts.length ? Math.max(...parts) : null,
    call_count: call,
    total_time: time || 0,
    total_cputime: cpu || 0,
    regain_min: regain,
  };
}

/** Pull estimated_time_to_regain_access (minutes) from BUC header objects. */
function extractRegainMinutes(parsed) {
  return peakFromUsageObjects(parsed).regain_min;
}

const tokenToAccount = new Map();
let tokenIndexReady = false;

function rememberTokenAccount(token, accountId) {
  const t = String(token || "");
  const id = Number(accountId);
  if (!t || !id) return;
  tokenToAccount.set(t, id);
}

/** Local only. Maps saved user/page tokens to the account that owns them. */
function ensureTokenIndex() {
  if (tokenIndexReady) return;
  tokenIndexReady = true;
  try {
    const db = getDb();
    const accounts = db
      .prepare(
        `SELECT id, user_token_enc FROM fb_accounts
         WHERE status != 'deleted' AND user_token_enc IS NOT NULL AND TRIM(user_token_enc) != ''`
      )
      .all();
    for (const row of accounts) {
      try {
        rememberTokenAccount(decryptToken(row.user_token_enc), row.id);
      } catch {
        /* token hỏng thì bỏ qua */
      }
    }
    const pages = db
      .prepare(
        `SELECT account_id, page_token_enc FROM fb_pages
         WHERE page_token_enc IS NOT NULL AND TRIM(page_token_enc) != ''`
      )
      .all();
    for (const row of pages) {
      try {
        rememberTokenAccount(decryptToken(row.page_token_enc), row.account_id);
      } catch {
        /* token hỏng thì bỏ qua */
      }
    }
  } catch {
    tokenIndexReady = false;
  }
}

const tokenMisses = new Set();

function accountIdForToken(token) {
  const t = String(token || "");
  if (!t) return null;
  ensureTokenIndex();
  const hit = tokenToAccount.get(t);
  if (hit) return hit;
  if (tokenMisses.has(t)) return null;
  tokenMisses.add(t);
  tokenIndexReady = false;
  ensureTokenIndex();
  return tokenToAccount.get(t) || null;
}

function rememberAccountUsage(accountId, appUsage) {
  const id = Number(accountId);
  const call = Number(appUsage?.call_count);
  if (!id || !Number.isFinite(call)) return;
  const prev = usageByAccount.get(id) || {};
  usageByAccount.set(id, {
    ...prev,
    call_count: call,
    total_time: Number(appUsage.total_time) || 0,
    total_cputime: Number(appUsage.total_cputime) || 0,
    regain_min: Number(appUsage.regain_min) || prev.regain_min || 0,
    updated_at: new Date().toISOString(),
    error: null,
  });
}

/** Call after each Graph response. accessToken attaches the % to that token. No extra request. */
export function noteGraphResponse(res, accessToken) {
  const appRaw =
    res.headers.get("x-app-usage") || res.headers.get("X-App-Usage");
  const appUsage = parseUsageHeader(appRaw);
  const bucRaw =
    res.headers.get("x-business-use-case-usage") ||
    res.headers.get("X-Business-Use-Case-Usage");
  const bucParsed = bucRaw ? parseUsageHeader(bucRaw) : null;
  // Một response: lấy max của app header và BUC. call_count = 0 vẫn có thể bị #4 vì CPU/time.
  const combined = peakFromUsageObjects(appUsage, bucParsed);
  if (appUsage) applyAppUsage(appUsage, "x-app-usage", appUsage);
  if (combined.peak != null) {
    lastUsage = {
      ...lastUsage,
      call_count: combined.call_count ?? lastUsage.call_count,
      total_time: combined.total_time || 0,
      total_cputime: combined.total_cputime || 0,
      page_usage_raw: bucParsed || lastUsage.page_usage_raw,
      estimated_time_to_regain_access_min: combined.regain_min,
      updated_at: new Date().toISOString(),
      source: appUsage && bucParsed ? "x-app-usage+buc" : appUsage ? "x-app-usage" : "x-business-use-case-usage",
      raw: appUsage || bucParsed,
    };
    rememberAccountUsage(accountIdForToken(accessToken), {
      call_count: combined.peak,
      total_time: combined.total_time,
      total_cputime: combined.total_cputime,
      regain_min: combined.regain_min || 0,
    });
  } else if (bucParsed) {
    lastUsage = {
      ...lastUsage,
      page_usage_raw: bucParsed,
      updated_at: new Date().toISOString(),
    };
  }

  return lastUsage;
}

export function getGlobalGraphPauseRemainingMs(metaAppKey) {
  const st = getAppPauseState(metaAppKey);
  return Math.max(0, st.until - Date.now());
}

/**
 * @param {string} [metaAppKey] App đang gọi Graph. Bắt buộc để không chặn App khác.
 *   Không truyền → chỉ check bucket default (không còn «pause mọi App»).
 */
export function isGlobalGraphPaused(metaAppKey) {
  const st = getAppPauseState(metaAppKey);
  return Date.now() < st.until;
}

/** True nếu BẤT KỲ App nào đang pause (chỉ dùng cho UI tổng). */
export function isAnyAppGraphPaused() {
  const now = Date.now();
  for (const st of appGraphPauses.values()) {
    if (now < st.until) return true;
  }
  return false;
}

/**
 * Extend pause for ONE Meta App only (workers của App khác vẫn chạy).
 */
export function noteGlobalRateLimit(errOrBody, opts = {}) {
  const appKey = normalizeAppKey(opts.metaAppKey ?? opts.meta_app_key);
  const st = getAppPauseState(appKey);
  st.hits = Math.min(20, st.hits + 1);
  const code = Number(
    extractGraphError(errOrBody)?.code ?? errOrBody?.code ?? NaN
  );
  if (Number.isFinite(code)) st.code = code;

  const regainMin = Number(lastUsage.estimated_time_to_regain_access_min);
  let waitMs;
  if (Number.isFinite(regainMin) && regainMin > 0) {
    waitMs = Math.min(15 * 60_000, Math.max(30_000, regainMin * 60_000));
  } else {
    const attempt = Math.max(0, st.hits - 1);
    const isApp4 = code === 4;
    waitMs = estimateRateLimitWaitMs(errOrBody, {
      attempt,
      minMs: isApp4
        ? attempt >= 2
          ? 120_000
          : attempt >= 1
            ? 75_000
            : 45_000
        : 30_000,
      maxMs: isApp4
        ? attempt >= 3
          ? 360_000
          : attempt >= 2
            ? 240_000
            : 150_000
        : 180_000,
    });
  }
  const until = Date.now() + waitMs;
  if (until > st.until) {
    st.until = until + Math.floor(Math.random() * 3_000);
  }
  const left = getGlobalGraphPauseRemainingMs(appKey);
  return {
    wait_ms: left,
    remaining_sec: Math.ceil(left / 1000),
    hits: st.hits,
    code: st.code,
    meta_app_key: appKey,
    resume_at: new Date(st.until).toISOString(),
  };
}

/**
 * Wait until pause for THIS Meta App ends (không chờ App khác).
 */
export async function waitGlobalGraphPause(opts = {}) {
  const appKey = normalizeAppKey(opts.metaAppKey ?? opts.meta_app_key);
  const st = getAppPauseState(appKey);
  if (!isGlobalGraphPaused(appKey)) {
    if (st.hits > 0 && Date.now() - (st.lastNotifyAt || 0) > 60_000) {
      st.hits = Math.max(0, st.hits - 1);
    }
    return { waited_ms: 0, stopped: false, was_paused: false, meta_app_key: appKey };
  }
  const started = Date.now();
  while (Date.now() < st.until) {
    if (opts.shouldStop?.()) {
      return {
        waited_ms: Date.now() - started,
        stopped: true,
        was_paused: true,
        meta_app_key: appKey,
      };
    }
    const left = st.until - Date.now();
    const now = Date.now();
    if (
      opts.onTick &&
      (!opts.tickMinMs || now - (st.lastNotifyAt || 0) >= (opts.tickMinMs || 2000))
    ) {
      st.lastNotifyAt = now;
      lastGlobalNotifyAt = now;
      try {
        opts.onTick({
          wait_ms: left,
          remaining_ms: left,
          remaining_sec: Math.ceil(left / 1000),
          hits: st.hits,
          code: st.code,
          meta_app_key: appKey,
          message:
            opts.message ||
            `⚠ FB limit (#${st.code || "?"}) — tạm dừng App «${appKey}», còn ${Math.ceil(left / 1000)}s (lần ${st.hits})`,
        });
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) =>
      setTimeout(r, Math.min(1000, Math.max(50, left)))
    );
  }
  const stagger = Math.floor(Math.random() * 1500);
  if (stagger > 0 && !opts.shouldStop?.()) {
    await new Promise((r) => setTimeout(r, stagger));
  }
  return {
    waited_ms: Date.now() - started,
    stopped: false,
    was_paused: true,
    meta_app_key: appKey,
  };
}

export function setListSlotMax(n) {
  listSlotMax = Math.min(6, Math.max(1, Number(n) || 1));
  // wake waiters if capacity grew
  while (listSlotWaiters.length && listSlotCurrent < listSlotMax) {
    const w = listSlotWaiters.shift();
    try {
      w();
    } catch {
      /* */
    }
  }
}

export function getListSlotMax() {
  return listSlotMax;
}

/** Serialize expensive LIST (paginate many edges) — #1 cause of code 4 storms. */
export async function acquireListSlot(opts = {}) {
  while (listSlotCurrent >= listSlotMax) {
    if (opts.shouldStop?.()) {
      const err = new Error("Đã dừng khi chờ list slot");
      err.code = "STOPPED";
      throw err;
    }
    await new Promise((resolve) => {
      listSlotWaiters.push(resolve);
      // safety wake
      setTimeout(resolve, 2000);
    });
  }
  listSlotCurrent++;
}

export function releaseListSlot() {
  listSlotCurrent = Math.max(0, listSlotCurrent - 1);
  const w = listSlotWaiters.shift();
  if (w) {
    try {
      w();
    } catch {
      /* */
    }
  }
}

/** Soft success: reduce consecutive limit pressure after a good call streak. */
export function noteGlobalGraphSuccess(metaAppKey) {
  const st = getAppPauseState(metaAppKey);
  if (st.hits > 0 && !isGlobalGraphPaused(metaAppKey)) {
    st.hits = Math.max(0, st.hits - 1);
  }
  lastUsage.estimated_time_to_regain_access_min = null;
}

/** Không gọi Facebook. Số chỉ đến từ lệnh đăng thật hoặc nút Đo limit. */
export async function refreshAppUsageFromMeta() {
  return getLastUsage();
}

/** Một dòng chip = một token. % chỉ lấy từ header của lệnh Graph thật, không gọi thêm. */
const usageByAccount = new Map();

function listLimitTokens() {
  try {
    return getDb()
      .prepare(
        `SELECT id, name FROM fb_accounts
         WHERE status != 'deleted'
         ORDER BY id`
      )
      .all();
  } catch {
    return [];
  }
}

function publicTokenUsage(row, snap) {
  return {
    key: `acc:${row.id}`,
    name: String(row.name || "").trim() || `Token ${row.id}`,
    call_count: snap?.call_count ?? null,
    total_time: snap?.total_time || 0,
    total_cputime: snap?.total_cputime || 0,
    regain_min: snap?.regain_min || 0,
    updated_at: snap?.updated_at || null,
    error: snap?.error || null,
  };
}

export async function refreshAllAppUsage() {
  return getAppUsageBoard().apps;
}

export function getAppUsageBoard() {
  const tokens = listLimitTokens();
  return {
    apps: tokens.map((row) => usageByAccount.get(row.id) || publicTokenUsage(row, null)),
    usage_warning: usageWarning(),
    polled_at: [...usageByAccount.values()].reduce((best, row) => {
      if (!row?.updated_at) return best;
      return !best || row.updated_at > best ? row.updated_at : best;
    }, null),
  };
}

let measureBusy = false;

async function readOneTokenUsage(row) {
  let token = "";
  try {
    token = decryptToken(row.user_token_enc) || "";
  } catch {
    return { error: "decrypt" };
  }
  if (!token) return { error: "no_token" };
  const url = new URL(`${graphBase()}/me`);
  url.searchParams.set("fields", "id");
  url.searchParams.set("access_token", token);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const appUsage = parseUsageHeader(res.headers.get("x-app-usage"));
    const buc = parseUsageHeader(
      res.headers.get("x-business-use-case-usage") ||
        res.headers.get("X-Business-Use-Case-Usage")
    );
    await res.json().catch(() => ({}));
    const peak = peakFromUsageObjects(appUsage, buc);
    if (peak.peak == null) return { error: "no_header" };
    return {
      call_count: peak.peak,
      total_time: peak.total_time || 0,
      total_cputime: peak.total_cputime || 0,
      regain_min: peak.regain_min || 0,
      updated_at: new Date().toISOString(),
      error: null,
    };
  } catch {
    return { error: "poll_fail" };
  }
}

/** Một lần bấm = một GET /me cho mỗi token. Không có timer. */
export async function measureTokenUsageNow() {
  if (measureBusy) {
    const err = new Error("Đang đo. Đợi lần này xong.");
    err.status = 409;
    throw err;
  }
  measureBusy = true;
  try {
    const tokens = getDb()
      .prepare(
        `SELECT id, name, user_token_enc FROM fb_accounts
         WHERE status != 'deleted'
           AND user_token_enc IS NOT NULL
           AND TRIM(user_token_enc) != ''
         ORDER BY id`
      )
      .all();
    for (const row of tokens) {
      const snap = await readOneTokenUsage(row);
      usageByAccount.set(row.id, publicTokenUsage(row, snap));
    }
    return getAppUsageBoard();
  } finally {
    measureBusy = false;
  }
}

/**
 * Suggested delay between page enriches based on usage %.
 */
export function suggestedDelayMs(base = 200) {
  const c = lastUsage.call_count || 0;
  if (c >= 80) return Math.max(base, 3000);
  if (c >= 50) return Math.max(base, 1200);
  if (c >= 20) return Math.max(base, 400);
  return base;
}

export function usageWarning() {
  const c = getUsagePeakPercent();
  if (c >= 80) return "Hạn mức API rất cao — dừng enrich, chờ ~1h.";
  if (c >= 50) return "Hạn mức API >50% — chỉ enrich page cần thiết.";
  if (c >= 20) return "Hạn mức API >20% — tránh Sync details hàng loạt.";
  return null;
}

/**
 * Peak of call_count / total_time / total_cputime from last x-app-usage.
 * Meta docs + community: throttle before hitting hard #4; each batch sub-call counts.
 */
export function getUsagePeakPercent() {
  const c = Number(lastUsage.call_count) || 0;
  const t = Number(lastUsage.total_time) || 0;
  const cpu = Number(lastUsage.total_cputime) || 0;
  return Math.max(c, t, cpu);
}

/**
 * Adaptive batch-parallel for bulk DELETE (community best practice).
 * - Batch max 50; each DELETE counts as 1 call toward Platform Rate Limit.
 * - Run multiple independent batch HTTP requests in parallel for throughput.
 * - Read X-App-Usage and lower concurrency before hard throttle.
 * - After #4: stop completely (caller pauses), then resume at 1 and ramp up.
 *
 * @param {number} [maxParallel=8] ceiling from user/Turbo preset
 * @returns {number} recommended concurrent Graph batch requests
 */
export function suggestedBatchParallel(maxParallel = 8) {
  const max = Math.min(12, Math.max(1, Number(maxParallel) || 8));
  const peak = getUsagePeakPercent();
  if (peak >= 92) return 1;
  if (peak >= 85) return Math.min(2, max);
  if (peak >= 70) return Math.min(3, max);
  if (peak >= 50) return Math.min(4, max);
  if (peak >= 30) return Math.min(6, max);
  return max; // low usage → full blast
}

/**
 * Inter-batch delay (ms) to spread load — Meta: "spread queries evenly, avoid spikes".
 */
export function suggestedInterBatchDelayMs(baseMs = 0) {
  const base = Math.max(0, Number(baseMs) || 0);
  const peak = getUsagePeakPercent();
  if (peak >= 90) return Math.max(base, 400);
  if (peak >= 75) return Math.max(base, 200);
  if (peak >= 55) return Math.max(base, 80);
  if (peak >= 35) return Math.max(base, 30);
  return base;
}

/**
 * After a rate-limit hit, next live parallel should drop hard then ramp.
 */
export function parallelAfterRateLimit(currentParallel = 1) {
  return 1; // always collapse to 1 after #4 / 17 / 32
}

/**
 * After healthy batch(es), ramp parallel toward max (step +1 or +2 when cold).
 */
export function rampBatchParallel(current, maxParallel, healthyStreak = 1) {
  const max = Math.min(12, Math.max(1, Number(maxParallel) || 8));
  const cur = Math.min(max, Math.max(1, Number(current) || 1));
  const usageCap = suggestedBatchParallel(max);
  if (cur >= usageCap) return usageCap;
  // Fast ramp when usage low and streak good
  const step = healthyStreak >= 3 && getUsagePeakPercent() < 25 ? 2 : 1;
  return Math.min(usageCap, cur + step);
}

/**
 * True when Graph error (or batch item body) is a rate / throttle limit.
 * Accepts: Error with .code/.fb, raw Graph error object, or batch body.
 */
/**
 * Normalize Graph error object from Error | batch body | {error:{...}}.
 */
export function extractGraphError(errOrBody) {
  if (!errOrBody) return null;
  if (errOrBody.fb && typeof errOrBody.fb === "object") return errOrBody.fb;
  if (errOrBody.error && typeof errOrBody.error === "object") return errOrBody.error;
  if (errOrBody.code != null && (errOrBody.message != null || errOrBody.type != null)) {
    return errOrBody;
  }
  return null;
}

/** Facebook chặn tần suất đăng/comment của tài khoản. Gửi lại chỉ làm khóa lâu hơn. */
export function isCommunitySpamBlock(errOrBody) {
  if (!errOrBody) return false;
  const fb = extractGraphError(errOrBody) || {};
  const sub = Number(
    fb.error_subcode ?? errOrBody.error_subcode ?? errOrBody.subcode ?? NaN
  );
  const msg = String(
    fb.error_user_msg ||
      fb.message ||
      errOrBody.error ||
      errOrBody.message ||
      (typeof errOrBody === "string" ? errOrBody : "")
  );
  if (sub === 1390008) return true;
  return /bảo vệ cộng đồng khỏi spam|protect the community from spam|limit how often you can post/i.test(
    msg
  );
}

function graphErrorText(errOrBody) {
  const fb = extractGraphError(errOrBody) || {};
  return String(
    fb.error_user_msg ||
      fb.message ||
      errOrBody?.error_user_msg ||
      errOrBody?.message ||
      errOrBody?.error ||
      (typeof errOrBody === "string" ? errOrBody : "")
  );
}

/** #368 và câu Facebook cấm tiếp. Gửi lại làm khóa lâu hơn. */
export function isSpamBlockError(errOrBody) {
  if (!errOrBody) return false;
  if (isCommunitySpamBlock(errOrBody)) return true;
  const fb = extractGraphError(errOrBody) || errOrBody;
  const code = Number(fb?.code ?? errOrBody.code ?? errOrBody.error_code ?? NaN);
  if (code === 368) return true;
  return /temporarily blocked|deemed abusive|abusive.*disallowed/i.test(graphErrorText(errOrBody));
}

/** Thiếu quyền hoặc token chết. Không retry. */
export function isPermissionError(errOrBody) {
  if (!errOrBody) return false;
  const fb = extractGraphError(errOrBody) || errOrBody;
  const code = Number(fb?.code ?? errOrBody.code ?? errOrBody.error_code ?? NaN);
  return code === 200 || code === 10 || code === 190;
}

export function isGraphRateLimitError(errOrBody) {
  if (!errOrBody) return false;
  // 368 / 1390008 không phải limit tạm. Retry kéo dài khóa.
  if (isSpamBlockError(errOrBody)) return false;

  const fb = extractGraphError(errOrBody) || errOrBody;

  const code = Number(fb?.code ?? errOrBody.code ?? errOrBody.error_code ?? NaN);
  const subcode = Number(
    fb?.error_subcode ?? errOrBody.error_subcode ?? errOrBody.subcode ?? NaN
  );
  const msg = String(
    fb?.message || errOrBody.message || errOrBody.error_user_msg || ""
  ).toLowerCase();
  const type = String(fb?.type || errOrBody.type || "").toLowerCase();

  if (Number.isFinite(code) && RATE_LIMIT_CODES.has(code)) return true;
  if (Number.isFinite(subcode) && RATE_LIMIT_SUBCODES.has(subcode)) return true;

  if (
    /rate limit|request limit|too many calls|too many requests|user request limit|application request limit|page request limit|api calls.*exceed|reduce the amount|try again later|throttl|spam|slow down/i.test(
      msg
    )
  ) {
    return true;
  }
  if (type === "oauthexception" && /limit|throttl|too many|spam/i.test(msg)) {
    return true;
  }
  // HTTP-style
  if (errOrBody.http_status === 429 || errOrBody.status === 429) return true;
  if (errOrBody.code === 429) return true;

  return false;
}

/**
 * Network / transport failures (Node fetch, undici, DNS, TLS) — safe to retry.
 */
export function isNetworkTransientError(errOrBody) {
  if (!errOrBody) return false;
  const code = String(
    errOrBody.code || errOrBody.errno || errOrBody.cause?.code || ""
  ).toUpperCase();
  const msg = String(
    errOrBody.message || errOrBody.error || errOrBody.cause?.message || ""
  ).toLowerCase();
  const http = Number(errOrBody.status ?? errOrBody.http_status ?? NaN);
  // 413 = body quá lớn — retry cùng form POST vô ích (cần resumable upload)
  if (
    code === "PAYLOAD_TOO_LARGE" ||
    http === 413 ||
    /\bhttp\s*413\b|payload too large|request entity too large/i.test(msg)
  ) {
    return false;
  }
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
      "ABORT_ERR",
      "EMPTY_GRAPH_BODY",
      "BAD_GRAPH_JSON",
    ].includes(code)
  ) {
    return true;
  }
  if (
    /fetch failed|networkerror|network error|socket hang up|socket closed|connection reset|connection refused|timed out|timeout|temporarily unavailable|could not connect|getaddrinfo|certificate|ssl|tls|und_err_|failed to fetch|econnreset|etimedout|unexpected end of json|empty.?graph|trả về rỗng|json lỗi/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Transient Graph errors worth retrying (not permanent permission/type errors).
 * Includes rate limits + Meta temp errors + network/fetch failures.
 */
export function isTransientGraphError(errOrBody, httpCode) {
  if (isSpamBlockError(errOrBody) || isPermissionError(errOrBody)) return false;
  if (isGraphRateLimitError(errOrBody)) return true;
  if (isNetworkTransientError(errOrBody)) return true;
  const fb = extractGraphError(errOrBody) || errOrBody || {};
  const code = Number(fb.code ?? errOrBody?.code ?? NaN);
  const msg = String(
    fb.message || errOrBody?.message || errOrBody?.error || ""
  ).toLowerCase();
  const http = Number(httpCode ?? errOrBody?.http_status ?? errOrBody?.status ?? NaN);

  // Meta: 1 unknown, 2 service temp unavailable, 4/17/32 rate, etc.
  if ([1, 2].includes(code)) return true;
  if (http === 429 || http === 503 || http === 502 || http === 500 || http === 504) {
    return true;
  }
  if (
    /unknown error|unexpected error|temporarily(?! blocked)|try again|service unavailable|server error|please retry|something went wrong|an unexpected error|internal error|is not available right now|please wait/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Wait ms for transient failures.
 * Rate-limit → longer progressive pause; network/Meta "retry later" → shorter backoff.
 */
export function estimateTransientWaitMs(errOrBody, opts = {}) {
  if (isGraphRateLimitError(errOrBody)) {
    return estimateRateLimitWaitMs(errOrBody, opts);
  }
  const attempt = Math.max(0, Number(opts.attempt) || 0);
  const minMs = Math.max(1_500, Number(opts.minMs) || 4_000);
  const maxMs = Math.max(minMs, Number(opts.maxMs) || 90_000);
  // 4s → 8s → 16s → 32s → 64s… + jitter
  const base = minMs * Math.pow(2, Math.min(attempt, 5));
  const jitter = base * (0.85 + Math.random() * 0.3);
  return Math.round(Math.min(maxMs, Math.max(minMs, jitter)));
}

/**
 * Post already gone / not found — treat delete as success.
 */
export function isAlreadyGoneGraphError(errOrBody) {
  const fb = extractGraphError(errOrBody) || errOrBody || {};
  const code = Number(fb.code ?? NaN);
  const msg = String(fb.message || errOrBody?.message || "").toLowerCase();
  if (
    /does not exist|unsupported get request|cannot be loaded|was deleted|already deleted|invalid post|nonexisting|missing or invalid/i.test(
      msg
    )
  ) {
    // code 100 often = does not exist for delete
    return true;
  }
  // Some deletes return 803 path not found style messages
  if (code === 803) return true;
  return false;
}

/**
 * Classify a batch DELETE item outcome.
 * @returns {"ok"|"gone"|"retry"|"fail"}
 */
export function classifyDeleteBatchItem(response) {
  const r = response || {};
  const body = r.body;
  const http = Number(r.code);
  const err = body?.error || null;

  // Success shapes Meta returns
  if (
    http >= 200 &&
    http < 300 &&
    (body?.success === true ||
      body?.success === "true" ||
      body === true ||
      (body && body.success == null && !body.error && !err))
  ) {
    return { kind: "ok" };
  }
  // Empty 200
  if (http === 200 && (body == null || body === "" || body === "{}")) {
    return { kind: "ok" };
  }

  if (isAlreadyGoneGraphError(err || body) || isAlreadyGoneGraphError({ message: String(body || ""), code: http })) {
    return { kind: "gone", error: err || body };
  }
  if (isSpamBlockError(err || body) || isPermissionError(err || body)) {
    const errMsg = err?.message || graphErrorText(err || body) || `HTTP ${http || "?"}`;
    return {
      kind: "fail",
      permanent: true,
      spam: isSpamBlockError(err || body),
      permission: isPermissionError(err || body),
      error: err || body || { code: http, message: errMsg },
      message: errMsg,
    };
  }
  if (isTransientGraphError(err || body, http) || http === 429) {
    return {
      kind: "retry",
      error: err || body || { code: http, message: `HTTP ${http}` },
      rate_limit: isGraphRateLimitError(err || body) || http === 429,
    };
  }
  const errMsg =
    err?.message ||
    (typeof body === "string" ? body : null) ||
    (body && typeof body === "object" ? JSON.stringify(body).slice(0, 200) : null) ||
    `HTTP ${http || "?"}`;
  return {
    kind: "fail",
    error: err || { code: http, message: errMsg },
    message: errMsg,
  };
}

/**
 * Estimate wait ms from error + optional headers / usage %.
 * Meta rarely sends Retry-After; we use progressive backoff.
 *
 * @param {object} [errOrBody]
 * @param {{ attempt?: number, minMs?: number, maxMs?: number }} [opts]
 */
export function estimateRateLimitWaitMs(errOrBody, opts = {}) {
  const attempt = Math.max(0, Number(opts.attempt) || 0);
  // Code 4 (app limit) often recovers in 1–3 min — NEVER wait 10–15 min by default
  const code = Number(
    extractGraphError(errOrBody)?.code ?? errOrBody?.code ?? NaN
  );
  const defaultMin = code === 4 ? 20_000 : 25_000;
  const defaultMax = code === 4 ? 120_000 : 180_000; // was 15 min — too long
  const minMs = Math.max(5_000, Number(opts.minMs) || defaultMin);
  const maxMs = Math.max(minMs, Number(opts.maxMs) || defaultMax);

  // Retry-After seconds (if present)
  const ra =
    errOrBody?.fb?.error_data?.retry_after ||
    errOrBody?.error?.error_data?.retry_after ||
    errOrBody?.retry_after ||
    errOrBody?.headers?.["retry-after"] ||
    errOrBody?.headers?.["Retry-After"];
  if (ra != null && String(ra).trim() !== "") {
    const sec = Number(ra);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(maxMs, Math.max(minMs, Math.ceil(sec * 1000)));
    }
  }

  // Usage-based (dashboard % can be low while code 4 still fires on burst)
  const usage = Number(lastUsage.call_count) || 0;
  let base = minMs;
  if (usage >= 95) base = Math.min(maxMs, 90_000);
  else if (usage >= 85) base = Math.min(maxMs, 60_000);
  else if (usage >= 70) base = Math.min(maxMs, 40_000);
  else base = minMs;

  // Mild growth: attempt 0→base, 1→1.4x, 2→2x… not 2^5
  const exp = Math.min(maxMs, base * (1 + attempt * 0.45));
  const jitter = exp * (0.9 + Math.random() * 0.2);
  return Math.round(Math.min(maxMs, Math.max(minMs, jitter)));
}

/**
 * Sleep in 1s ticks so UI can countdown; abort if shouldStop().
 * @returns {Promise<{ waited_ms: number, stopped: boolean }>}
 */
export async function waitWhileRateLimited(waitMs, opts = {}) {
  const total = Math.max(1000, Number(waitMs) || 30_000);
  const started = Date.now();
  let left = total;
  while (left > 0) {
    if (opts.shouldStop?.()) {
      return { waited_ms: Date.now() - started, stopped: true };
    }
    const step = Math.min(1000, left);
    if (opts.onTick) {
      try {
        opts.onTick({
          wait_ms: total,
          remaining_ms: left,
          remaining_sec: Math.ceil(left / 1000),
          elapsed_ms: Date.now() - started,
          attempt: opts.attempt || 0,
          message: opts.message || "Facebook rate limit — tạm dừng",
        });
      } catch {
        /* ignore UI errors */
      }
    }
    await new Promise((r) => setTimeout(r, step));
    left = total - (Date.now() - started);
  }
  return { waited_ms: Date.now() - started, stopped: false };
}

/**
 * Run `fn` with automatic pause + retry on Graph rate limits
 * and other transient errors (unexpected / network / 5xx).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{
 *   maxAttempts?: number,
 *   shouldStop?: () => boolean,
 *   onRateLimit?: (info: object) => void,
 *   onRetry?: (info: object) => void,
 *   label?: string,
 *   onlyRateLimit?: boolean,
 * }} [opts]
 * @returns {Promise<T>}
 */
export async function withRateLimitRetry(fn, opts = {}) {
  const maxAttempts = Math.min(30, Math.max(1, Number(opts.maxAttempts) || 12));
  const onlyRateLimit = !!opts.onlyRateLimit;
  const appKey = normalizeAppKey(opts.metaAppKey ?? opts.meta_app_key);
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.shouldStop?.()) {
      const err = new Error("Đã dừng khi đang chờ/xử lý rate limit");
      err.code = "STOPPED";
      throw err;
    }
    // Chỉ chờ pause của ĐÚNG Meta App này — App khác vẫn chạy
    if (isGlobalGraphPaused(appKey)) {
      const g = await waitGlobalGraphPause({
        metaAppKey: appKey,
        shouldStop: opts.shouldStop,
        tickMinMs: 2000,
        onTick: (tick) => {
          opts.onRateLimit?.({
            ...tick,
            attempt: attempt + 1,
            max_attempts: maxAttempts,
            rate_limit: true,
            global: true,
            meta_app_key: appKey,
            label: opts.label || "Graph API",
          });
          opts.onRetry?.({ ...tick, global: true, meta_app_key: appKey });
        },
      });
      if (g.stopped) {
        const err = new Error(
          `Đã dừng khi đang chờ rate limit App «${appKey}»`
        );
        err.code = "STOPPED";
        throw err;
      }
    }
    try {
      const out = await fn();
      noteGlobalGraphSuccess(appKey);
      return out;
    } catch (e) {
      if (isSpamBlockError(e) || isPermissionError(e)) throw e;
      const retryable = onlyRateLimit
        ? isGraphRateLimitError(e)
        : isTransientGraphError(e);
      if (!retryable) throw e;
      if (attempt >= maxAttempts - 1) {
        const kind = isGraphRateLimitError(e) ? "rate-limit" : "lỗi tạm";
        const err = new Error(
          `Vẫn ${kind} sau ${maxAttempts} lần chờ: ${e.message || e}`
        );
        err.code = e.code;
        err.fb = e.fb;
        err.rate_limit = isGraphRateLimitError(e);
        err.transient = true;
        throw err;
      }
      const isLimit = isGraphRateLimitError(e);
      let waitMs;
      let resumeAt;
      let hits = 0;
      if (isLimit) {
        const gInfo = noteGlobalRateLimit(e, { attempt, metaAppKey: appKey });
        waitMs = gInfo.wait_ms;
        resumeAt = gInfo.resume_at;
        hits = gInfo.hits;
      } else {
        waitMs = estimateTransientWaitMs(e, { attempt });
        resumeAt = new Date(Date.now() + waitMs).toISOString();
      }
      const info = {
        attempt: attempt + 1,
        max_attempts: maxAttempts,
        wait_ms: waitMs,
        remaining_sec: Math.ceil(waitMs / 1000),
        resume_at: resumeAt,
        error: e.message || String(e),
        code: e.code,
        rate_limit: isLimit,
        global: isLimit,
        meta_app_key: appKey,
        network: isNetworkTransientError(e),
        label: opts.label || "Graph API",
        message: isLimit
          ? `⚠ FB limit (${e.code ?? "?"}): tạm dừng App «${appKey}» ~${Math.ceil(waitMs / 1000)}s (hit #${hits}) — App khác vẫn chạy`
          : `⚠ FB tạm lỗi / mạng: chờ ~${Math.ceil(waitMs / 1000)}s rồi thử lại (${attempt + 1}/${maxAttempts})`,
      };
      opts.onRateLimit?.(info);
      opts.onRetry?.(info);
      const w = isLimit
        ? await waitGlobalGraphPause({
            metaAppKey: appKey,
            shouldStop: opts.shouldStop,
            tickMinMs: 2000,
            message: info.message,
            onTick: (tick) => {
              const tickInfo = {
                ...info,
                wait_ms: tick.wait_ms,
                remaining_sec: tick.remaining_sec,
                remaining_ms: tick.remaining_ms,
                message: `⚠ FB limit — App «${appKey}», còn ${tick.remaining_sec}s… (lần ${attempt + 1}/${maxAttempts})`,
                ticking: true,
              };
              opts.onRateLimit?.(tickInfo);
              opts.onRetry?.(tickInfo);
            },
          })
        : await waitWhileRateLimited(waitMs, {
            attempt: attempt + 1,
            shouldStop: opts.shouldStop,
            message: info.message,
            onTick: (tick) => {
              const tickInfo = {
                ...info,
                wait_ms: tick.wait_ms,
                remaining_sec: tick.remaining_sec,
                remaining_ms: tick.remaining_ms,
                message: `⚠ FB tạm lỗi / mạng — còn ${tick.remaining_sec}s… (lần ${attempt + 1}/${maxAttempts})`,
                ticking: true,
              };
              opts.onRateLimit?.(tickInfo);
              opts.onRetry?.(tickInfo);
            },
          });
      if (w.stopped) {
        const err = new Error("Đã dừng khi đang chờ retry Facebook");
        err.code = "STOPPED";
        throw err;
      }
      attempt++;
    }
  }
}

/** Alias — same auto-retry for rate-limit + unexpected + fetch failed. */
export const withTransientGraphRetry = withRateLimitRetry;
