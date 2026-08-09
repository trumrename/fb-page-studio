/**
 * Pure HTTP client for cookie sessions (no browser window).
 * Used for health checks and future session-mapped ops.
 *
 * Does NOT embed reverse-engineered private publish mutations.
 * Callers pass explicit URL + body once endpoint maps are registered.
 */
import { loadSessionSecrets, markSessionStatus } from "./cookieVault.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * @param {number} sessionId
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string|Buffer|null, timeoutMs?: number }} [opts]
 */
export async function sessionFetch(sessionId, url, opts = {}) {
  const secrets = loadSessionSecrets(sessionId);
  if (!secrets?.cookieHeader) {
    throw new Error(`Session #${sessionId} không có cookie`);
  }

  const method = String(opts.method || "GET").toUpperCase();
  const headers = {
    "user-agent": secrets.userAgent || DEFAULT_UA,
    cookie: secrets.cookieHeader,
    accept: "text/html,application/json,*/*",
    "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    ...(opts.headers || {}),
  };

  // Note: Node undici fetch does not use proxy_url natively.
  // Proxy support can be added via undici ProxyAgent later.
  if (secrets.proxyUrl) {
    headers["x-session-proxy"] = "configured-not-yet-applied";
  }

  const controller = new AbortController();
  const timeoutMs = Number(opts.timeoutMs || 45000);
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body ?? undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      ok: res.ok || res.status === 302 || res.status === 301,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: text,
      url,
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Lightweight liveness probe: hit m.facebook.com / www with cookies.
 * Does not publish anything.
 */
export async function checkSessionHealth(sessionId) {
  try {
    const r = await sessionFetch(sessionId, "https://www.facebook.com/", {
      method: "GET",
      timeoutMs: 25000,
    });
    const body = String(r.body || "");
    const loggedOut =
      /login_form|name="email"|\/login\/|checkpoint/i.test(body) &&
      !/logout|composer|feed_story/i.test(body.slice(0, 8000));
    const checkpoint = /checkpoint|two_step|captcha|security.?check/i.test(body);

    if (checkpoint) {
      markSessionStatus(sessionId, "checkpoint", "Checkpoint / security check");
      return { ok: false, status: "checkpoint", http: r.status };
    }
    if (r.status === 302 || r.status === 301) {
      const loc = r.headers.location || r.headers.Location || "";
      if (/login|checkpoint/i.test(loc)) {
        markSessionStatus(sessionId, "dead", `Redirect ${loc.slice(0, 120)}`);
        return { ok: false, status: "dead", http: r.status, location: loc };
      }
    }
    if (loggedOut || r.status === 401 || r.status === 403) {
      markSessionStatus(sessionId, "dead", `HTTP ${r.status} logged out?`);
      return { ok: false, status: "dead", http: r.status };
    }
    // Soft pass: got HTML with cookies accepted
    markSessionStatus(sessionId, "alive", null);
    return { ok: true, status: "alive", http: r.status, bytes: body.length };
  } catch (e) {
    const msg = e?.message || String(e);
    markSessionStatus(sessionId, "error", msg);
    return { ok: false, status: "error", error: msg };
  }
}
