import { config, graphBase } from "../config.js";
import { noteGraphResponse } from "./rateLimit.js";

/**
 * Official Graph API helpers (no cookies).
 * Multi-account: call these with each account's tokens.
 */

export function buildLoginUrl(state) {
  const { appId, redirectUri, scopes } = config.facebook;
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: scopes.join(","),
    response_type: "code",
    // auth_type=rerequest forces re-prompt when permissions missing
    auth_type: "rerequest",
  });
  return `https://www.facebook.com/${config.facebook.graphVersion}/dialog/oauth?${params}`;
}

async function graphGet(path, accessToken, query = {}) {
  const url = new URL(`${graphBase()}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (accessToken) url.searchParams.set("access_token", accessToken);

  const res = await fetch(url);
  noteGraphResponse(res);
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message || "Graph API error");
    err.code = data.error.code;
    err.type = data.error.type;
    err.fb = data.error;
    throw err;
  }
  return data;
}

/** Exchange OAuth code → short-lived user token */
export async function exchangeCodeForToken(code) {
  return graphGet("/oauth/access_token", null, {
    client_id: config.facebook.appId,
    client_secret: config.facebook.appSecret,
    redirect_uri: config.facebook.redirectUri,
    code,
  });
}

/** Short-lived → long-lived user token (~60 days) */
export async function exchangeLongLivedUserToken(shortLivedToken) {
  return graphGet("/oauth/access_token", null, {
    grant_type: "fb_exchange_token",
    client_id: config.facebook.appId,
    client_secret: config.facebook.appSecret,
    fb_exchange_token: shortLivedToken,
  });
}

/** Profile of the connected user */
export async function getMe(userToken) {
  return graphGet("/me", userToken, {
    fields: "id,name,email,picture.type(large)",
  });
}

/**
 * Fetch ALL pages the user manages (paginated).
 * Scale: loops until no paging.next — safe for hundreds of pages per account.
 */
export async function getAllPages(userToken, { onPage } = {}) {
  const fields = "id,name,category,access_token,tasks";
  let urlPath = "/me/accounts";
  let query = { fields, limit: 100 };
  const pages = [];

  // First request via helper; subsequent via absolute paging URL
  let data = await graphGet(urlPath, userToken, query);

  while (true) {
    const batch = data.data || [];
    for (const p of batch) {
      pages.push(p);
      if (onPage) onPage(p, pages.length);
    }

    const next = data.paging?.next;
    if (!next) break;

    const res = await fetch(next);
    data = await res.json();
    if (data.error) {
      const err = new Error(data.error.message || "Graph paging error");
      err.fb = data.error;
      throw err;
    }
  }

  return pages;
}

/** Debug token (optional health check) */
export async function debugToken(inputToken) {
  const appToken = `${config.facebook.appId}|${config.facebook.appSecret}`;
  return graphGet("/debug_token", appToken, { input_token: inputToken });
}

/**
 * Soft Graph GET — returns { ok, data } or { ok:false, error } without throwing.
 * Used for optional enrich fields (roles/insights may lack permission).
 */
export async function graphGetSoft(path, accessToken, query = {}) {
  try {
    const data = await graphGet(path, accessToken, query);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      code: e.code,
      fb: e.fb || null,
    };
  }
}

/**
 * Core page profile (no business field — that needs business_management
 * and can fail the whole request with #200 if missing).
 */
export async function getPageProfile(pageId, pageToken) {
  // Try full set first
  let r = await graphGetSoft(`/${pageId}`, pageToken, {
    fields: [
      "id",
      "name",
      "category",
      "followers_count",
      "fan_count",
      "verification_status",
      "link",
      "about",
      "picture.type(large)",
      "is_published",
    ].join(","),
  });

  if (r.ok) return r.data;

  r = await graphGetSoft(`/${pageId}`, pageToken, {
    fields: "id,name,category,followers_count,fan_count,link,picture.type(large)",
  });
  if (r.ok) return r.data;

  const err = new Error(r.error || "Failed to load page profile");
  err.code = r.code;
  err.fb = r.fb;
  throw err;
}

/** Optional: BM linked to page (needs business_management on token) */
export async function getPageBusiness(pageId, pageToken) {
  return graphGetSoft(`/${pageId}`, pageToken, {
    fields: "business",
  });
}

/** People with roles (non-business users primarily) */
export async function getPageRoles(pageId, pageToken) {
  return graphGetSoft(`/${pageId}/roles`, pageToken, { limit: 100 });
}

/** Users assigned via Business Manager */
export async function getPageAssignedUsers(pageId, pageToken) {
  return graphGetSoft(`/${pageId}/assigned_users`, pageToken, {
    limit: 100,
    fields: "id,name,tasks,user_type",
  });
}

/**
 * Page insights — only growth 7d (page_follows). ~1 call/page.
 * Countries / fans_country removed: Meta often returns empty for NPE pages.
 */
export async function getPageInsights(pageId, pageToken) {
  const rows = [];
  const errors = [];

  let r = await graphGetSoft(`/${pageId}/insights`, pageToken, {
    metric: "page_follows",
    period: "day",
    date_preset: "last_7d",
  });
  if (r.ok && (r.data?.data || []).length) {
    rows.push(...r.data.data);
  } else {
    if (!r.ok) errors.push(`page_follows: ${r.error}`);
    r = await graphGetSoft(`/${pageId}/insights`, pageToken, {
      metric: "page_daily_follows",
      period: "day",
      date_preset: "last_7d",
    });
    if (r.ok && (r.data?.data || []).length) rows.push(...r.data.data);
    else if (!r.ok) errors.push(`page_daily_follows: ${r.error}`);
  }

  if (!rows.length) {
    return {
      ok: false,
      error: errors[0] || "No insight metrics",
      data: { data: [] },
      errors,
    };
  }
  return { ok: true, data: { data: rows }, errors };
}

/** Businesses the user is in (needs business_management) */
export async function getMyBusinesses(userToken) {
  return graphGetSoft("/me/businesses", userToken, {
    fields: "id,name,verification_status,created_time",
    limit: 50,
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
