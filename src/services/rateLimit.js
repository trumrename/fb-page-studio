/**
 * Track Graph API usage from response headers.
 * Note: Page access tokens often return x-business-use-case-usage only.
 * App-level % (dashboard) comes from x-app-usage — usually needs App Access Token.
 *
 * Also: detect rate-limit errors + wait/resume helpers for bulk jobs.
 */

import { config, graphBase } from "../config.js";

let lastUsage = {
  call_count: 0,
  total_time: 0,
  total_cputime: 0,
  updated_at: null,
  source: null,
  raw: null,
};

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
    call_count: call,
    total_time: Number(u.total_time) || 0,
    total_cputime: Number(u.total_cputime) || 0,
    updated_at: new Date().toISOString(),
    source,
    raw: raw || u,
  };
}

/** Call after each Graph response */
export function noteGraphResponse(res) {
  const appRaw =
    res.headers.get("x-app-usage") || res.headers.get("X-App-Usage");
  const appUsage = parseUsageHeader(appRaw);
  if (appUsage) {
    applyAppUsage(appUsage, "x-app-usage", appUsage);
  }

  // Page-level usage — do NOT overwrite app % (different scale), just store side info
  const bucRaw =
    res.headers.get("x-business-use-case-usage") ||
    res.headers.get("X-Business-Use-Case-Usage");
  if (bucRaw && !appUsage) {
    // Keep previous app usage; attach note that last call was page-scoped
    lastUsage = {
      ...lastUsage,
      page_usage_raw: parseUsageHeader(bucRaw),
      updated_at: lastUsage.updated_at || new Date().toISOString(),
    };
  }

  return lastUsage;
}

/**
 * Force-refresh app-level usage with App Access Token (matches developer dashboard %).
 */
export async function refreshAppUsageFromMeta() {
  const { appId, appSecret, graphVersion } = config.facebook;
  if (!appId || !appSecret) {
    return { ...lastUsage, error: "Missing FB_APP_ID/SECRET" };
  }
  const appToken = `${appId}|${appSecret}`;
  const url = new URL(`${graphBase()}/${appId}`);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("access_token", appToken);

  try {
    const res = await fetch(url);
    noteGraphResponse(res);
    // Prefer explicit parse again
    const appRaw = res.headers.get("x-app-usage");
    const u = parseUsageHeader(appRaw);
    if (u) applyAppUsage(u, "app_token_poll", u);
    await res.json().catch(() => ({}));
  } catch (e) {
    return { ...lastUsage, error: e.message };
  }
  return getLastUsage();
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
  const c = lastUsage.call_count || 0;
  if (c >= 80) return "App usage rất cao — dừng enrich, chờ ~1h.";
  if (c >= 50) return "App usage >50% — chỉ enrich page cần thiết.";
  if (c >= 20) return "App usage >20% — tránh Sync details hàng loạt.";
  return null;
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

export function isGraphRateLimitError(errOrBody) {
  if (!errOrBody) return false;

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
    /rate limit|request limit|too many calls|too many requests|user request limit|application request limit|page request limit|api calls.*exceed|reduce the amount|temporarily blocked|try again later|throttl|spam|slow down/i.test(
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
    ].includes(code)
  ) {
    return true;
  }
  if (
    /fetch failed|networkerror|network error|socket hang up|socket closed|connection reset|connection refused|timed out|timeout|temporarily unavailable|could not connect|getaddrinfo|certificate|ssl|tls|und_err_|failed to fetch|econnreset|etimedout/i.test(
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
    /unknown error|unexpected error|temporarily|try again|service unavailable|server error|please retry|something went wrong|an unexpected error|internal error|is not available right now|please wait/i.test(
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
  const minMs = Math.max(5_000, Number(opts.minMs) || 30_000);
  const maxMs = Math.max(minMs, Number(opts.maxMs) || 15 * 60_000);

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

  // Usage-based: near 100% → wait longer
  const usage = Number(lastUsage.call_count) || 0;
  let base = minMs;
  if (usage >= 95) base = 10 * 60_000;
  else if (usage >= 85) base = 5 * 60_000;
  else if (usage >= 70) base = 2 * 60_000;
  else base = minMs;

  // Exponential-ish: 30s, 60s, 2m, 4m, 8m… capped
  const exp = Math.min(maxMs, base * Math.pow(2, Math.min(attempt, 5)));
  // Jitter ±15%
  const jitter = exp * (0.85 + Math.random() * 0.3);
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
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.shouldStop?.()) {
      const err = new Error("Đã dừng khi đang chờ/xử lý rate limit");
      err.code = "STOPPED";
      throw err;
    }
    try {
      return await fn();
    } catch (e) {
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
      const waitMs = isLimit
        ? estimateRateLimitWaitMs(e, { attempt })
        : estimateTransientWaitMs(e, { attempt });
      const resumeAt = new Date(Date.now() + waitMs).toISOString();
      const info = {
        attempt: attempt + 1,
        max_attempts: maxAttempts,
        wait_ms: waitMs,
        remaining_sec: Math.ceil(waitMs / 1000),
        resume_at: resumeAt,
        error: e.message || String(e),
        code: e.code,
        rate_limit: isLimit,
        network: isNetworkTransientError(e),
        label: opts.label || "Graph API",
        message: isLimit
          ? `⚠ FB limit (${e.code ?? "?"}): tạm dừng ~${Math.ceil(waitMs / 1000)}s rồi tự chạy lại`
          : `⚠ FB tạm lỗi / mạng: chờ ~${Math.ceil(waitMs / 1000)}s rồi thử lại (${attempt + 1}/${maxAttempts})`,
      };
      opts.onRateLimit?.(info);
      opts.onRetry?.(info);
      const w = await waitWhileRateLimited(waitMs, {
        attempt: attempt + 1,
        shouldStop: opts.shouldStop,
        message: info.message,
        onTick: (tick) => {
          const tickInfo = {
            ...info,
            wait_ms: tick.wait_ms,
            remaining_sec: tick.remaining_sec,
            remaining_ms: tick.remaining_ms,
            message: isLimit
              ? `⚠ FB limit — tạm dừng, còn ${tick.remaining_sec}s… (lần ${attempt + 1}/${maxAttempts})`
              : `⚠ FB tạm lỗi / mạng — còn ${tick.remaining_sec}s… (lần ${attempt + 1}/${maxAttempts})`,
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
