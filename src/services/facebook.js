import crypto from "crypto";
import { config, graphBase } from "../config.js";
import {
  noteGraphResponse,
  isGraphRateLimitError,
  isTransientGraphError,
  isAlreadyGoneGraphError,
  classifyDeleteBatchItem,
  withRateLimitRetry,
  estimateRateLimitWaitMs,
  waitWhileRateLimited,
} from "./rateLimit.js";

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
  // Ignore placeholders / too-short values that would produce invalid proofs.
  if (!token || secret.length < 16) return "";
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

export function isInvalidAppSecretProofError(message) {
  return /invalid appsecret_proof/i.test(String(message || ""));
}

/**
 * Resolve App Secret for Graph proof.
 * @param {string} [explicit]
 * @param {string} [metaAppKey] app1 | app2
 */
export function resolveAppSecret(explicit, metaAppKey = "") {
  const s = String(explicit || "").trim();
  if (s.length >= 16) return s;
  const key = String(metaAppKey || "").trim().toLowerCase();
  if (key === "app2") {
    const s2 = String(process.env.FB_APP_SECRET_2 || "").trim();
    if (s2.length >= 16) return s2;
  }
  const s1 = String(
    process.env.FB_APP_SECRET || config.facebook?.appSecret || ""
  ).trim();
  return s1.length >= 16 ? s1 : "";
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
 * @param {{ appSecret?: string, metaAppKey?: string, skipAppsecretProof?: boolean }} [opts]
 */
async function graphGet(path, accessToken, query = {}, opts = {}) {
  const tryOnce = async (withProof) => {
    const url = new URL(`${graphBase()}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    if (accessToken) {
      url.searchParams.set("access_token", accessToken);
      if (withProof && !opts.skipAppsecretProof) {
        const secret = resolveAppSecret(opts.appSecret, opts.metaAppKey);
        const proof = appsecretProof(accessToken, secret);
        if (proof) url.searchParams.set("appsecret_proof", proof);
      }
    }
    const res = await fetch(url);
    noteGraphResponse(res);
    return res.json();
  };

  let data = await tryOnce(true);
  // Customer packs may have wrong/stale secret → invalid proof. Retry without proof
  // when Meta does not require it (common for gói khách).
  if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
    data = await tryOnce(false);
  }
  if (data.error) {
    const err = new Error(data.error.message || "Graph API error");
    err.code = data.error.code;
    err.type = data.error.type;
    err.fb = data.error;
    if (isInvalidAppSecretProofError(err.message)) {
      err.message =
        "Invalid appsecret_proof: FB_APP_SECRET trên máy này không khớp App đã Connect. " +
        "Gói khách: xóa hẳn dòng FB_APP_SECRET trong .env (để trống) và tắt Require App Secret Proof trên Meta. " +
        "Gói nội bộ: điền đúng secret của đúng App (App 1 / App 2).";
    }
    throw err;
  }
  return data;
}

/** Follow paging.next absolute URLs while keeping appsecret_proof. */
async function graphFetchAbsolute(absoluteUrl, accessToken, opts = {}) {
  const tryOnce = async (withProof) => {
    const url = new URL(absoluteUrl);
    if (accessToken && !url.searchParams.get("access_token")) {
      url.searchParams.set("access_token", accessToken);
    }
    if (withProof && !opts.skipAppsecretProof) {
      const secret = resolveAppSecret(opts.appSecret, opts.metaAppKey);
      const token = url.searchParams.get("access_token") || accessToken;
      const proof = appsecretProof(token, secret);
      if (proof) url.searchParams.set("appsecret_proof", proof);
      else url.searchParams.delete("appsecret_proof");
    } else {
      url.searchParams.delete("appsecret_proof");
    }
    const res = await fetch(url);
    noteGraphResponse(res);
    return res.json();
  };

  let data = await tryOnce(true);
  if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
    data = await tryOnce(false);
  }
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
  const metaAppKey = typeof opts === "object" && opts ? opts.metaAppKey : undefined;
  // picture + followers khi Graph cho phép (không phải lúc nào cũng có đủ → enrich bổ sung)
  const fields =
    "id,name,category,access_token,tasks,followers_count,fan_count,link,picture.type(large)";
  let urlPath = "/me/accounts";
  let query = { fields, limit: 100 };
  const pages = [];
  const graphOpts = { appSecret, metaAppKey };

  // First request via helper; subsequent via absolute paging URL
  let data = await graphGet(urlPath, userToken, query, graphOpts);

  while (true) {
    const batch = data.data || [];
    for (const p of batch) {
      pages.push(p);
      if (onPage) onPage(p, pages.length);
    }

    const next = data.paging?.next;
    if (!next) break;

    data = await graphFetchAbsolute(next, userToken, graphOpts);
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
/**
 * @param {string} pageId
 * @param {string} pageToken
 * @param {{ metaAppKey?: string, appSecret?: string }} [opts]
 */
export async function getPageProfile(pageId, pageToken, opts = {}) {
  const graphOpts = {
    metaAppKey: opts.metaAppKey,
    appSecret: opts.appSecret,
  };
  // Try full set first
  let r = await graphGetSoft(
    `/${pageId}`,
    pageToken,
    {
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
    },
    graphOpts
  );

  if (r.ok) return r.data;

  r = await graphGetSoft(
    `/${pageId}`,
    pageToken,
    {
      fields: "id,name,category,followers_count,fan_count,link,picture.type(large)",
    },
    graphOpts
  );
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

/**
 * List Facebook Groups the user can see / manages.
 * Note: Meta deprecated Groups API (v19+) — may fail without legacy perms;
 * we try several edges and return best-effort + error notes.
 *
 * @param {string} userToken
 * @param {{ adminOnly?: boolean, metaAppKey?: string, appSecret?: string, onBatch?: Function }} [opts]
 */
export async function listUserGroups(userToken, opts = {}) {
  const graphOpts = {
    metaAppKey: opts.metaAppKey,
    appSecret: opts.appSecret,
  };
  const fields =
    "id,name,privacy,administrator,member_count,icon,updated_time,email";
  const attempts = [
    {
      path: "/me/groups",
      query: {
        fields,
        limit: 100,
        ...(opts.adminOnly !== false ? { admin_only: "true" } : {}),
      },
      label: "me/groups admin_only",
    },
    {
      path: "/me/groups",
      query: { fields, limit: 100 },
      label: "me/groups all",
    },
  ];

  const errors = [];
  for (const a of attempts) {
    try {
      const groups = [];
      let data = await graphGet(a.path, userToken, a.query, graphOpts);
      while (true) {
        for (const g of data.data || []) {
          groups.push({
            id: g.id,
            name: g.name,
            privacy: g.privacy || null,
            administrator: Boolean(g.administrator),
            member_count: g.member_count ?? null,
            icon: g.icon || null,
            updated_time: g.updated_time || null,
            source: a.label,
          });
          if (opts.onBatch) opts.onBatch(groups.length);
        }
        const next = data.paging?.next;
        if (!next) break;
        data = await graphFetchAbsolute(next, userToken, graphOpts);
      }
      if (groups.length) {
        // de-dupe by id
        const map = new Map();
        for (const g of groups) map.set(g.id, g);
        return { ok: true, groups: [...map.values()], errors, source: a.label };
      }
      errors.push(`${a.label}: empty`);
    } catch (e) {
      errors.push(`${a.label}: ${e.message || e}`);
    }
  }
  return {
    ok: false,
    groups: [],
    errors,
    error:
      errors[0] ||
      "Không list được Group. Meta đã deprecate Groups API — app cần quyền group (nếu còn) hoặc dán Group ID thủ công. Bạn phải là Admin/Mod.",
  };
}

/**
 * List posts in a Group feed (admin/moderator).
 * Meta deprecated Groups API (v19+) — /feed and /posts often return
 * (#100) nonexisting field. We try several shapes + optional extra tokens
 * (e.g. Page token when Page is group admin).
 *
 * @param {string} groupId
 * @param {string} accessToken primary token (usually user)
 * @param {{
 *   limit?: number,
 *   maxPosts?: number,
 *   since?: string|number,
 *   until?: string|number,
 *   fields?: string,
 *   onBatch?: Function,
 *   onRateLimit?: Function,
 *   shouldStop?: () => boolean,
 *   metaAppKey?: string,
 *   appSecret?: string,
 *   extraTokens?: Array<{ token: string, label?: string, metaAppKey?: string }>,
 * }} [opts]
 */
export async function listGroupPosts(groupId, accessToken, opts = {}) {
  const gid = String(groupId || "").trim();
  if (!gid) throw new Error("Thiếu group_id");
  const pageLimit = Math.min(100, Math.max(1, Number(opts.limit) || 100));
  const maxPosts = Math.max(0, Number(opts.maxPosts) || 0);
  const fields =
    opts.fields ||
    "id,message,story,created_time,permalink_url,updated_time,from{id,name},attachments{media_type,type,title}";

  const tokenPacks = [
    {
      token: accessToken,
      label: "user",
      metaAppKey: opts.metaAppKey,
      appSecret: opts.appSecret,
    },
    ...((opts.extraTokens || [])
      .filter((t) => t?.token)
      .map((t) => ({
        token: t.token,
        label: t.label || "page",
        metaAppKey: t.metaAppKey || opts.metaAppKey,
        appSecret: t.appSecret || opts.appSecret,
      }))),
  ];

  /** @type {string[]} */
  const attemptLog = [];

  async function paginateFromData(firstData, graphOpts, rlOpts) {
    const posts = [];
    let data = firstData;
    while (true) {
      if (opts.shouldStop?.()) break;
      const batch = data.data || [];
      for (const p of batch) {
        posts.push(p);
        if (maxPosts > 0 && posts.length >= maxPosts) {
          if (opts.onBatch) opts.onBatch(batch, posts.length);
          return posts.slice(0, maxPosts);
        }
      }
      if (opts.onBatch) opts.onBatch(batch, posts.length);
      const next = data.paging?.next;
      if (!next) break;
      data = await withRateLimitRetry(
        () => graphFetchAbsolute(next, graphOpts._token, graphOpts),
        { ...rlOpts, label: `${rlOpts.label} next` }
      );
    }
    return posts;
  }

  for (const pack of tokenPacks) {
    const graphOpts = {
      metaAppKey: pack.metaAppKey,
      appSecret: pack.appSecret,
      _token: pack.token,
    };
    const rlOpts = {
      maxAttempts: 8,
      shouldStop: opts.shouldStop,
      label: `list group ${gid} (${pack.label})`,
      onRateLimit: opts.onRateLimit,
    };

    // Strategy A: edge /feed
    // Strategy B: nested fields feed{...}
    // Strategy C: edge /posted  (legacy alias some nodes)
    // Skip bare /posts last — often (#100) nonexisting field on Group after deprecation
    const strategies = [
      {
        name: `${pack.label}:/${gid}/feed`,
        run: async () => {
          const q = { fields, limit: pageLimit };
          if (opts.since != null && opts.since !== "") q.since = opts.since;
          if (opts.until != null && opts.until !== "") q.until = opts.until;
          return graphGet(`/${gid}/feed`, pack.token, q, graphOpts);
        },
      },
      {
        name: `${pack.label}:nested feed`,
        run: async () => {
          // Nested connection (sometimes works when edge path is blocked)
          const feedFields = fields;
          const nested = `feed.limit(${pageLimit}){${feedFields}}`;
          const data = await graphGet(
            `/${gid}`,
            pack.token,
            { fields: nested },
            graphOpts
          );
          // Normalize to { data, paging }
          if (data?.feed) return data.feed;
          if (Array.isArray(data?.data)) return data;
          return { data: [] };
        },
      },
      {
        name: `${pack.label}:/${gid}/posts`,
        run: async () => {
          const q = { fields, limit: pageLimit };
          if (opts.since != null && opts.since !== "") q.since = opts.since;
          if (opts.until != null && opts.until !== "") q.until = opts.until;
          return graphGet(`/${gid}/posts`, pack.token, q, graphOpts);
        },
      },
    ];

    for (const s of strategies) {
      try {
        const first = await withRateLimitRetry(() => s.run(), {
          ...rlOpts,
          label: s.name,
        });
        // nested empty feed
        const hasItems = (first?.data || []).length > 0 || first?.paging?.next;
        if (!hasItems && s.name.includes("nested")) {
          attemptLog.push(`${s.name}: empty`);
          continue;
        }
        const posts = await paginateFromData(first, graphOpts, {
          ...rlOpts,
          label: s.name,
        });
        if (posts.length || hasItems) {
          return posts;
        }
        attemptLog.push(`${s.name}: 0 posts`);
      } catch (e) {
        if (e.code === "STOPPED") throw e;
        if (isGraphRateLimitError(e) || e.rate_limit) throw e;
        const msg = String(e.message || e);
        attemptLog.push(`${s.name}: ${msg.slice(0, 160)}`);
        // keep trying other strategies
      }
    }
  }

  const detail = attemptLog.slice(0, 8).join(" | ");
  const err = new Error(
    "Không đọc được feed Group qua Graph API. " +
      "Meta đã deprecate Groups API — thường lỗi (#100) nonexisting field (feed/posts). " +
      "Cách dùng được: (1) Page là Admin group + Connect page cùng nick, tool sẽ thử Page token; " +
      "(2) Dán danh sách post_id / link bài thủ công rồi xóa; " +
      "(3) Xóa tay trên Facebook. " +
      (detail ? `Chi tiết: ${detail}` : "")
  );
  err.code = 100;
  err.attempts = attemptLog;
  err.group_api_blocked = true;
  throw err;
}

/**
 * Graph DELETE (e.g. page post). Requires pages_manage_posts on page token.
 * @param {string} path e.g. "/123_456"
 * @param {string} accessToken page access token
 * @param {{ appSecret?: string, metaAppKey?: string, skipAppsecretProof?: boolean }} [opts]
 */
export async function graphDelete(path, accessToken, opts = {}) {
  const tryOnce = async (withProof) => {
    const url = new URL(`${graphBase()}${path.startsWith("/") ? path : `/${path}`}`);
    if (accessToken) {
      url.searchParams.set("access_token", accessToken);
      if (withProof && !opts.skipAppsecretProof) {
        const secret = resolveAppSecret(opts.appSecret, opts.metaAppKey);
        const proof = appsecretProof(accessToken, secret);
        if (proof) url.searchParams.set("appsecret_proof", proof);
      }
    }
    const res = await fetch(url, { method: "DELETE" });
    noteGraphResponse(res);
    return res.json();
  };

  let data = await tryOnce(true);
  if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
    data = await tryOnce(false);
  }
  if (data.error) {
    const err = new Error(data.error.message || "Graph DELETE error");
    err.code = data.error.code;
    err.type = data.error.type;
    err.fb = data.error;
    throw err;
  }
  return data;
}

/** Delete one Page post by id. Success: { success: true } */
export async function deletePagePost(postId, pageToken, opts = {}) {
  const id = String(postId || "").trim();
  if (!id) throw new Error("Thiếu post_id");
  return graphDelete(`/${id}`, pageToken, opts);
}

/**
 * List posts published by the Page (paginated).
 * Prefer /published_posts (page-authored). Falls back to /posts then /feed.
 *
 * @param {string} pageId
 * @param {string} pageToken
 * @param {{
 *   limit?: number,
 *   maxPosts?: number,
 *   since?: string|number,
 *   until?: string|number,
 *   fields?: string,
 *   onBatch?: (posts: object[], total: number) => void,
 *   metaAppKey?: string,
 *   appSecret?: string,
 * }} [opts]
 */
export async function listPagePosts(pageId, pageToken, opts = {}) {
  const pid = String(pageId || "").trim();
  if (!pid) throw new Error("Thiếu page_id");
  const pageLimit = Math.min(100, Math.max(1, Number(opts.limit) || 100));
  const maxPosts = Math.max(0, Number(opts.maxPosts) || 0); // 0 = no cap
  const fields =
    opts.fields ||
    "id,message,story,created_time,permalink_url,full_picture,status_type,is_published,attachments{media_type,type,url,title}";
  const graphOpts = {
    metaAppKey: opts.metaAppKey,
    appSecret: opts.appSecret,
  };

  const query = { fields, limit: pageLimit };
  if (opts.since != null && opts.since !== "") query.since = opts.since;
  if (opts.until != null && opts.until !== "") query.until = opts.until;

  const endpoints = [
    `/${pid}/published_posts`,
    `/${pid}/posts`,
    `/${pid}/feed`,
  ];

  const rlOpts = {
    maxAttempts: 12,
    shouldStop: opts.shouldStop,
    label: `list posts ${pid}`,
    onRateLimit: opts.onRateLimit,
  };

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const posts = [];
      let data = await withRateLimitRetry(
        () => graphGet(endpoint, pageToken, query, graphOpts),
        rlOpts
      );
      while (true) {
        if (opts.shouldStop?.()) break;
        const batch = data.data || [];
        for (const p of batch) {
          posts.push(p);
          if (maxPosts > 0 && posts.length >= maxPosts) {
            if (opts.onBatch) opts.onBatch(batch, posts.length);
            return posts.slice(0, maxPosts);
          }
        }
        if (opts.onBatch) opts.onBatch(batch, posts.length);
        const next = data.paging?.next;
        if (!next) break;
        data = await withRateLimitRetry(
          () => graphFetchAbsolute(next, pageToken, graphOpts),
          { ...rlOpts, label: `list posts next ${pid}` }
        );
      }
      return posts;
    } catch (e) {
      lastError = e;
      if (e.code === "STOPPED") throw e;
      // Rate limit exhausted after retries — bubble up
      if (isGraphRateLimitError(e) || e.rate_limit) throw e;
      // Try next endpoint if permission / unknown edge
      const code = e.code;
      const msg = String(e.message || "");
      if (
        code === 100 ||
        code === 200 ||
        code === 10 ||
        /does not exist|permission|unsupported|unknown path/i.test(msg)
      ) {
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error("Không lấy được danh sách bài Page");
}

/**
 * Graph Batch API — up to 50 sub-requests per call (faster bulk delete).
 * @param {string} accessToken default token for all items
 * @param {Array<{method:string, relative_url:string, body?:string, access_token?:string, name?:string}>} batch
 * @param {{ appSecret?: string, metaAppKey?: string }} [opts]
 * @returns {Promise<Array<{code:number, headers?:any, body:any}>>}
 */
export async function graphBatch(accessToken, batch, opts = {}) {
  if (!Array.isArray(batch) || !batch.length) return [];
  if (batch.length > 50) {
    throw new Error("Graph batch tối đa 50 request / lần");
  }

  const tryOnce = async (withProof) => {
    // Meta Batch: POST https://graph.facebook.com (or versioned base)
    const form = new URLSearchParams();
    form.set("access_token", accessToken);
    form.set("batch", JSON.stringify(batch));
    if (withProof && !opts.skipAppsecretProof) {
      const secret = resolveAppSecret(opts.appSecret, opts.metaAppKey);
      const proof = appsecretProof(accessToken, secret);
      if (proof) form.set("appsecret_proof", proof);
    }
    const endpoints = [
      "https://graph.facebook.com",
      graphBase(),
    ];
    let lastData = null;
    for (const endpoint of endpoints) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      noteGraphResponse(res);
      lastData = await res.json();
      // Array response = success; error object may mean wrong path → try next
      if (Array.isArray(lastData)) return lastData;
      if (!lastData?.error) return lastData;
      const msg = String(lastData.error.message || "");
      if (/unknown path|unsupported get request|nonexisting field/i.test(msg)) {
        continue;
      }
      return lastData;
    }
    return lastData;
  };

  let data = await tryOnce(true);
  if (data?.error && isInvalidAppSecretProofError(data.error.message)) {
    data = await tryOnce(false);
  }
  if (data?.error) {
    const err = new Error(data.error.message || "Graph batch error");
    err.code = data.error.code;
    err.fb = data.error;
    throw err;
  }
  if (!Array.isArray(data)) {
    throw new Error("Graph batch trả về không phải mảng");
  }
  return data.map((item) => {
    let body = item?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep string */
      }
    }
    return {
      code: item?.code,
      headers: item?.headers,
      body,
    };
  });
}

/**
 * Delete many posts quickly via batch (chunks of 50) or concurrent singles.
 * On Facebook rate-limit: pause (countdown) then auto-resume retries.
 *
 * @param {string[]} postIds
 * @param {string} pageToken
 * @param {{
 *   concurrency?: number,
 *   useBatch?: boolean,
 *   delayMs?: number,
 *   onProgress?: (info: object) => void,
 *   onRateLimit?: (info: object) => void,
 *   shouldStop?: () => boolean,
 *   metaAppKey?: string,
 *   appSecret?: string,
 * }} [opts]
 */
export async function deletePagePostsFast(postIds, pageToken, opts = {}) {
  const ids = [...new Set((postIds || []).map((x) => String(x || "").trim()).filter(Boolean))];
  const useBatch = opts.useBatch !== false;
  const concurrency = Math.min(20, Math.max(1, Number(opts.concurrency) || 8));
  let delayMs = Math.max(0, Number(opts.delayMs) || 0);
  const graphOpts = {
    metaAppKey: opts.metaAppKey,
    appSecret: opts.appSecret,
  };

  /** @type {Record<string, number>} */
  const errorCounts = {};
  const noteError = (msg) => {
    const key = String(msg || "unknown").slice(0, 160);
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  };

  const results = {
    total: ids.length,
    ok: 0,
    fail: 0,
    gone: 0,
    rate_limit_pauses: 0,
    error_summary: /** @type {Array<{message:string,count:number}>} */ ([]),
    items: /** @type {Array<{post_id:string, ok:boolean, error?:string}>} */ ([]),
  };

  const report = (extra = {}) => {
    if (opts.onProgress) {
      opts.onProgress({
        total: results.total,
        ok: results.ok,
        fail: results.fail,
        gone: results.gone,
        done: results.ok + results.fail,
        rate_limit_pauses: results.rate_limit_pauses,
        error_summary: topErrors(),
        ...extra,
      });
    }
  };

  const topErrors = () =>
    Object.entries(errorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([message, count]) => ({ message, count }));

  const markOk = (postId, gone = false) => {
    results.ok++;
    if (gone) results.gone++;
    results.items.push({ post_id: postId, ok: true, gone: gone || undefined });
  };

  const markFail = (postId, msg) => {
    results.fail++;
    noteError(msg);
    results.items.push({ post_id: postId, ok: false, error: msg });
  };

  const notifyLimit = (info) => {
    results.rate_limit_pauses = Math.max(
      results.rate_limit_pauses,
      info.attempt || 1
    );
    if (opts.onRateLimit) opts.onRateLimit(info);
    report({
      phase: "rate_limited",
      rate_limit: true,
      ...info,
    });
  };

  if (!ids.length) return results;

  async function waitRetry(sampleErr, attempt, retryCount, label) {
    const isRl = isGraphRateLimitError(sampleErr);
    const waitMs = isRl
      ? estimateRateLimitWaitMs(sampleErr, { attempt })
      : Math.min(
          120_000,
          Math.max(3_000, 4_000 * Math.pow(1.6, Math.min(attempt, 8)))
        );
    notifyLimit({
      attempt: attempt + 1,
      wait_ms: waitMs,
      remaining_sec: Math.ceil(waitMs / 1000),
      resume_at: new Date(Date.now() + waitMs).toISOString(),
      error: sampleErr?.message || String(sampleErr || "retry"),
      code: sampleErr?.code,
      label,
      message: isRl
        ? `⚠ FB limit — tạm dừng ~${Math.ceil(waitMs / 1000)}s, còn ${retryCount} bài sẽ xóa lại`
        : `⚠ Lỗi tạm thời FB — chờ ~${Math.ceil(waitMs / 1000)}s rồi thử lại ${retryCount} bài`,
    });
    const w = await waitWhileRateLimited(waitMs, {
      attempt: attempt + 1,
      shouldStop: opts.shouldStop,
      onTick: (tick) => {
        notifyLimit({
          attempt: attempt + 1,
          wait_ms: tick.wait_ms,
          remaining_sec: tick.remaining_sec,
          remaining_ms: tick.remaining_ms,
          error: sampleErr?.message || "retry",
          code: sampleErr?.code,
          label,
          message: `⚠ Tạm dừng do FB — còn ${tick.remaining_sec}s… (còn ${retryCount} bài)`,
          ticking: true,
        });
      },
    });
    return w;
  }

  /**
   * Process one batch chunk — retry transient + rate-limit; permanent fails only at end.
   */
  async function processChunk(chunk) {
    let pending = [...chunk];
    let attempt = 0;
    const maxRounds = 25;

    while (pending.length && attempt < maxRounds) {
      if (opts.shouldStop?.()) break;

      let responses;
      try {
        responses = await withRateLimitRetry(
          () =>
            graphBatch(
              pageToken,
              pending.map((id) => ({ method: "DELETE", relative_url: id })),
              graphOpts
            ),
          {
            maxAttempts: 12,
            shouldStop: opts.shouldStop,
            label: `batch DELETE ×${pending.length}`,
            onRateLimit: notifyLimit,
          }
        );
      } catch (e) {
        if (e.code === "STOPPED") break;
        // Batch transport broken → single delete with retries
        const still = [];
        for (const postId of pending) {
          if (opts.shouldStop?.()) break;
          try {
            await withRateLimitRetry(
              () => deletePagePost(postId, pageToken, graphOpts),
              {
                maxAttempts: 10,
                shouldStop: opts.shouldStop,
                label: `DELETE ${postId}`,
                onRateLimit: notifyLimit,
              }
            );
            markOk(postId);
          } catch (err) {
            if (err.code === "STOPPED") break;
            if (isAlreadyGoneGraphError(err)) {
              markOk(postId, true);
            } else if (isTransientGraphError(err)) {
              still.push(postId);
            } else {
              markFail(postId, err.message || String(err));
            }
          }
          if (delayMs) await sleep(delayMs);
        }
        if (!still.length) {
          pending = [];
          break;
        }
        const w = await waitRetry(e, attempt, still.length, "single-fallback");
        if (w.stopped) break;
        pending = still;
        attempt++;
        continue;
      }

      const retryIds = [];
      let sampleRetryErr = null;
      let retryIsLimit = false;
      let okInRound = 0;

      for (let j = 0; j < pending.length; j++) {
        const postId = pending[j];
        const r = responses[j] || { code: 0, body: { error: { message: "empty batch slot", code: 1 } } };
        const cls = classifyDeleteBatchItem(r);

        if (cls.kind === "ok") {
          markOk(postId);
          okInRound++;
          continue;
        }
        if (cls.kind === "gone") {
          markOk(postId, true);
          okInRound++;
          continue;
        }
        if (cls.kind === "retry") {
          retryIds.push(postId);
          sampleRetryErr = cls.error || sampleRetryErr;
          if (cls.rate_limit) retryIsLimit = true;
          continue;
        }
        // permanent fail
        markFail(postId, cls.message || cls.error?.message || "delete failed");
      }

      // Adaptive slowdown if many retries in this batch
      if (retryIds.length >= pending.length * 0.3) {
        delayMs = Math.min(2000, Math.max(delayMs, 80) + 40);
      }
      if (okInRound > 0 && retryIds.length === 0) {
        // healthy — gently reduce delay floor
        delayMs = Math.max(Number(opts.delayMs) || 0, Math.floor(delayMs * 0.9));
      }

      if (!retryIds.length) {
        pending = [];
        break;
      }

      const w = await waitRetry(
        sampleRetryErr || { message: "transient", code: 1 },
        attempt,
        retryIds.length,
        retryIsLimit
          ? `batch limit (${retryIds.length})`
          : `batch temp (${retryIds.length})`
      );
      if (w.stopped) break;
      pending = retryIds;
      attempt++;
    }

    // Exhausted retries — mark remaining as fail (will try final sweep later)
    for (const postId of pending) {
      markFail(postId, "Hết số lần retry tự động (limit/lỗi tạm)");
    }
  }

  async function singleDeleteWithRetry(postId) {
    try {
      await withRateLimitRetry(
        () => deletePagePost(postId, pageToken, graphOpts),
        {
          maxAttempts: 8,
          shouldStop: opts.shouldStop,
          label: `DELETE ${postId}`,
          onRateLimit: notifyLimit,
        }
      );
      return { ok: true };
    } catch (e) {
      if (e.code === "STOPPED") return { ok: false, stopped: true };
      if (isAlreadyGoneGraphError(e)) return { ok: true, gone: true };
      return { ok: false, error: e.message || String(e), transient: isTransientGraphError(e) };
    }
  }

  if (useBatch) {
    for (let i = 0; i < ids.length; i += 50) {
      if (opts.shouldStop?.()) break;
      const chunk = ids.slice(i, i + 50);
      await processChunk(chunk);
      report({ phase: "delete", last_batch: chunk.length, delay_ms: delayMs });
      if (delayMs) await sleep(delayMs);
    }

    // Final sweep: re-try permanent fails once, slowly (often recovers limit ghosts)
    const failedIds = results.items.filter((x) => !x.ok).map((x) => x.post_id);
    if (failedIds.length && !opts.shouldStop?.() && opts.finalSweep !== false) {
      report({
        phase: "final_sweep",
        label: `Quét lại ${failedIds.length} bài fail…`,
      });
      // Reset fail counters for swept items — rebuild cleanly
      const sweepOk = new Set();
      // Process in small batches of 20 with longer delay
      for (let i = 0; i < failedIds.length; i += 20) {
        if (opts.shouldStop?.()) break;
        const chunk = failedIds.slice(i, i + 20);
        try {
          const responses = await withRateLimitRetry(
            () =>
              graphBatch(
                pageToken,
                chunk.map((id) => ({ method: "DELETE", relative_url: id })),
                graphOpts
              ),
            {
              maxAttempts: 8,
              shouldStop: opts.shouldStop,
              label: `final sweep ×${chunk.length}`,
              onRateLimit: notifyLimit,
            }
          );
          for (let j = 0; j < chunk.length; j++) {
            const cls = classifyDeleteBatchItem(responses[j] || {});
            if (cls.kind === "ok" || cls.kind === "gone") {
              sweepOk.add(chunk[j]);
            }
          }
        } catch {
          // ignore — leave as fail
        }
        await sleep(Math.max(delayMs, 200));
        report({
          phase: "final_sweep",
          sweep_done: i + chunk.length,
          sweep_total: failedIds.length,
        });
      }

      if (sweepOk.size) {
        // Rebuild tallies
        const kept = [];
        let ok = 0;
        let fail = 0;
        let gone = 0;
        const newErrorCounts = {};
        for (const it of results.items) {
          if (!it.ok && sweepOk.has(it.post_id)) {
            ok++;
            kept.push({ post_id: it.post_id, ok: true });
          } else if (it.ok) {
            ok++;
            if (it.gone) gone++;
            kept.push(it);
          } else {
            fail++;
            const key = String(it.error || "unknown").slice(0, 160);
            newErrorCounts[key] = (newErrorCounts[key] || 0) + 1;
            kept.push(it);
          }
        }
        results.items = kept;
        results.ok = ok;
        results.fail = fail;
        results.gone = gone;
        Object.keys(errorCounts).forEach((k) => delete errorCounts[k]);
        Object.assign(errorCounts, newErrorCounts);
        report({ phase: "final_sweep_done", recovered: sweepOk.size });
      }
    }

    results.error_summary = topErrors();
    return results;
  }

  // Concurrent single DELETEs
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      if (opts.shouldStop?.()) return;
      const idx = cursor++;
      const postId = ids[idx];
      const r = await singleDeleteWithRetry(postId);
      if (r.stopped) return;
      if (r.ok) markOk(postId, r.gone);
      else markFail(postId, r.error || "fail");
      report({ phase: "delete", post_id: postId });
      if (delayMs) await sleep(delayMs);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, () => worker())
  );
  results.error_summary = topErrors();
  return results;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
