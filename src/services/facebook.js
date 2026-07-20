import crypto from "crypto";
import { config, graphBase } from "../config.js";
import { noteGraphResponse } from "./rateLimit.js";

/**
 * Official Graph API helpers (no cookies).
 * Multi-account: call these with each account's tokens.
 *
 * Meta “Require App Secret Proof”: every server-side call with a user/page
 * access token must send appsecret_proof = HMAC-SHA256(token, app_secret).
 */

/** @param {string} accessToken @param {string} appSecret */
export function appsecretProof(accessToken, appSecret) {
  const token = String(accessToken || "").trim();
  const secret = String(appSecret || "").trim();
  if (!token || !secret) return "";
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

function resolveAppSecret(explicit) {
  const s = String(explicit || "").trim();
  if (s) return s;
  return String(config.facebook.appSecret || process.env.FB_APP_SECRET || "").trim();
}

/**
 * Official Facebook Login dialog URL.
 * - Do NOT force auth_type=rerequest on first login (breaks 2FA / "could not validate").
 * - Use display=page so full 2FA works in system browser.
 * @param {string} state
 * @param {{ rerequest?: boolean, app?: { appId, redirectUri, scopes } }} [opts]
 */
export function buildLoginUrl(state, opts = {}) {
  const app = opts.app || config.facebook;
  const appId = app.appId || app.client_id;
  const redirectUri = app.redirectUri || app.redirect_uri;
  const scopes = app.scopes || config.facebook.scopes;
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: Array.isArray(scopes) ? scopes.join(",") : String(scopes || ""),
    response_type: "code",
    // Full page in real browser — supports password + 2FA + device check
    display: "page",
  });
  // Only when user explicitly re-grants missing permissions
  if (opts.rerequest) {
    params.set("auth_type", "rerequest");
  }
  return `https://www.facebook.com/${config.facebook.graphVersion}/dialog/oauth?${params}`;
}

/**
 * @param {string} path
 * @param {string|null} accessToken
 * @param {Record<string, unknown>} [query]
 * @param {{ appSecret?: string }} [opts]
 */
async function graphGet(path, accessToken, query = {}, opts = {}) {
  const url = new URL(`${graphBase()}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (accessToken) {
    url.searchParams.set("access_token", accessToken);
    const secret = resolveAppSecret(opts.appSecret);
    const proof = appsecretProof(accessToken, secret);
    if (proof) url.searchParams.set("appsecret_proof", proof);
  }

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

/** Follow paging.next absolute URLs while keeping appsecret_proof. */
async function graphFetchAbsolute(absoluteUrl, accessToken, opts = {}) {
  const url = new URL(absoluteUrl);
  if (accessToken && !url.searchParams.get("access_token")) {
    url.searchParams.set("access_token", accessToken);
  }
  const secret = resolveAppSecret(opts.appSecret);
  const token = url.searchParams.get("access_token") || accessToken;
  const proof = appsecretProof(token, secret);
  if (proof) url.searchParams.set("appsecret_proof", proof);

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

/**
 * Exchange OAuth code → short-lived user token
 * @param {string} code
 * @param {{ appId?, appSecret?, redirectUri? }} [appCreds]
 */
export async function exchangeCodeForToken(code, appCreds = null) {
  const app = appCreds || config.facebook;
  return graphGet("/oauth/access_token", null, {
    client_id: app.appId || app.client_id,
    client_secret: app.appSecret || app.client_secret || app.app_secret,
    redirect_uri: app.redirectUri || app.redirect_uri,
    code,
  });
}

/**
 * Short-lived → long-lived user token (~60 days)
 * @param {string} shortLivedToken
 * @param {{ appId?, appSecret? }} [appCreds]
 */
export async function exchangeLongLivedUserToken(shortLivedToken, appCreds = null) {
  const app = appCreds || config.facebook;
  return graphGet("/oauth/access_token", null, {
    grant_type: "fb_exchange_token",
    client_id: app.appId || app.client_id,
    client_secret: app.appSecret || app.client_secret || app.app_secret,
    fb_exchange_token: shortLivedToken,
  });
}

/** Profile of the connected user */
export async function getMe(userToken, opts = {}) {
  return graphGet(
    "/me",
    userToken,
    { fields: "id,name,email,picture.type(large)" },
    { appSecret: opts.appSecret }
  );
}

/**
 * Fetch ALL pages the user manages (paginated).
 * Scale: loops until no paging.next — safe for hundreds of pages per account.
 * @param {string} userToken
 * @param {{ onPage?: Function, appSecret?: string }} [opts]
 */
export async function getAllPages(userToken, opts = {}) {
  const onPage = typeof opts === "function" ? opts : opts.onPage;
  const appSecret = typeof opts === "object" && opts ? opts.appSecret : undefined;
  const fields = "id,name,category,access_token,tasks";
  let urlPath = "/me/accounts";
  let query = { fields, limit: 100 };
  const pages = [];

  // First request via helper; subsequent via absolute paging URL
  let data = await graphGet(urlPath, userToken, query, { appSecret });

  while (true) {
    const batch = data.data || [];
    for (const p of batch) {
      pages.push(p);
      if (onPage) onPage(p, pages.length);
    }

    const next = data.paging?.next;
    if (!next) break;

    data = await graphFetchAbsolute(next, userToken, { appSecret });
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
export async function graphGetSoft(path, accessToken, query = {}, opts = {}) {
  try {
    const data = await graphGet(path, accessToken, query, opts);
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
