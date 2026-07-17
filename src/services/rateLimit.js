/**
 * Track Graph API usage from response headers.
 * Note: Page access tokens often return x-business-use-case-usage only.
 * App-level % (dashboard) comes from x-app-usage — usually needs App Access Token.
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
