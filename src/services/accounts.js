import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { encryptToken, decryptToken, maskToken } from "./crypto.js";
import {
  exchangeCodeForToken,
  exchangeLongLivedUserToken,
  getMe,
  getAllPages,
} from "./facebook.js";
import { checkQuota } from "./license.js";

function nowIso() {
  return new Date().toISOString();
}

function expiresAtFromSeconds(expiresIn) {
  if (!expiresIn) return null;
  return new Date(Date.now() + Number(expiresIn) * 1000).toISOString();
}

/**
 * Full connect flow after OAuth callback code.
 * Upserts account + replaces page list (scale-friendly transaction).
 * @param {string} code
 * @param {{ metaAppKey?: string, app?: object }} [opts] — which Meta App issued the code
 */
/**
 * Persist user token + sync pages (shared by code-exchange and relay claim).
 */
export async function connectFromUserToken(userToken, opts = {}) {
  const metaAppKey = String(opts.metaAppKey || opts.meta_app_key || "app1");
  const app = opts.app || {};
  let token = String(userToken || "").trim();
  if (!token) throw new Error("Thiếu user access token");

  let expiresAt =
    opts.expiresAt ||
    expiresAtFromSeconds(opts.expires_in) ||
    null;

  const creds =
    app.appId && app.appSecret
      ? {
          appId: app.appId,
          appSecret: app.appSecret,
          redirectUri: app.redirectUri,
        }
      : null;

  if (creds && opts.upgradeLongLived !== false) {
    try {
      const long = await exchangeLongLivedUserToken(token, creds);
      if (long.access_token) {
        token = long.access_token;
        expiresAt = expiresAtFromSeconds(long.expires_in) || expiresAt;
      }
    } catch (e) {
      console.warn("[accounts] long-lived exchange failed:", e.message);
    }
  }

  // Prefer secret from connect opts; else env App 1/2 for appsecret_proof (Meta Require proof).
  const appSecretForProof =
    String(app.appSecret || "").trim() ||
    (metaAppKey === "app2"
      ? String(process.env.FB_APP_SECRET_2 || process.env.FB_APP_SECRET || "").trim()
      : String(process.env.FB_APP_SECRET || config.facebook?.appSecret || "").trim());

  let me;
  try {
    me = await getMe(token, { appSecret: appSecretForProof });
  } catch (e) {
    if (/appsecret_proof/i.test(e.message || "")) {
      throw new Error(
        e.message +
          " | Gói khách: xóa FB_APP_SECRET trong .env (không để secret sai). " +
          "Meta: tắt Require App Secret Proof nếu không ship secret. " +
          "Gói nội bộ: secret phải đúng App 1/App 2 đã Connect."
      );
    }
    throw e;
  }
  const picture = me.picture?.data?.url || me.picture?.url || null;

  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM fb_accounts WHERE fb_user_id = ? AND meta_app_key = ?`
    )
    .get(me.id, metaAppKey);

  if (!existing) {
    const n = db
      .prepare(
        `SELECT COUNT(*) AS c FROM fb_accounts WHERE status != 'deleted'`
      )
      .get().c;
    const q = checkQuota("account", n);
    if (!q.ok) {
      throw new Error(q.error || "License không cho thêm account");
    }
  }

  let accountId;
  if (existing) {
    accountId = existing.id;
    db.prepare(
      `UPDATE fb_accounts SET
        name = ?, email = ?, picture_url = ?,
        user_token_enc = ?, user_token_expires_at = ?,
        meta_app_key = ?, meta_app_id = ?,
        status = 'active', last_error = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      me.name || null,
      me.email || null,
      picture,
      encryptToken(token),
      expiresAt,
      metaAppKey,
      app.appId || opts.appId || null,
      accountId
    );
  } else {
    const info = db
      .prepare(
        `INSERT INTO fb_accounts
          (fb_user_id, name, email, picture_url, user_token_enc, user_token_expires_at,
           status, meta_app_key, meta_app_id)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        me.id,
        me.name || null,
        me.email || null,
        picture,
        encryptToken(token),
        expiresAt,
        metaAppKey,
        app.appId || opts.appId || null
      );
    accountId = info.lastInsertRowid;
  }

  const pages = await syncPagesForAccount(accountId, token, {
    appSecret: appSecretForProof,
  });

  // Connect xong: lấy follow + avatar ngay (page còn thiếu)
  let profile_enrich = null;
  try {
    const { enrichMissingProfilesForAccount } = await import("./enrich.js");
    profile_enrich = await enrichMissingProfilesForAccount(accountId, {
      delayMs: 150,
    });
  } catch (e) {
    console.warn("[connect] profile enrich:", e.message);
    profile_enrich = { ok: false, error: e.message };
  }

  const fresh = listPages({ accountId, limit: 5000 });
  return {
    account: getAccountPublic(accountId),
    pages: fresh.map(publicPage),
    sync_summary: pages.sync_summary || null,
    profile_enrich,
    meta_app_key: metaAppKey,
  };
}

export async function connectFromOAuthCode(code, opts = {}) {
  const metaAppKey = String(opts.metaAppKey || opts.meta_app_key || "app1");
  const app = opts.app || {};
  const creds =
    app.appId && app.appSecret
      ? {
          appId: app.appId,
          appSecret: app.appSecret,
          redirectUri: app.redirectUri,
        }
      : null;

  if (!creds?.appSecret) {
    throw new Error(
      "Thiếu App Secret trên máy này. Gói khách dùng OAuth relay (ticket) — không đổi code local."
    );
  }

  const short = await exchangeCodeForToken(code, creds);
  if (!short.access_token) {
    throw new Error("No access_token from code exchange");
  }

  return connectFromUserToken(short.access_token, {
    metaAppKey,
    app,
    expires_in: short.expires_in,
    upgradeLongLived: true,
  });
}

/**
 * Re-fetch /me/accounts for one account (large lists supported).
 */
export async function syncPagesForAccount(accountId, userTokenOptional, opts = {}) {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM fb_accounts WHERE id = ?`)
    .get(accountId);
  if (!row) throw new Error("Account not found");

  const userToken =
    userTokenOptional || decryptToken(row.user_token_enc);

  const metaKey = String(row.meta_app_key || "app1");
  const appSecret =
    String(opts.appSecret || "").trim() ||
    (metaKey === "app2"
      ? String(process.env.FB_APP_SECRET_2 || process.env.FB_APP_SECRET || "").trim()
      : String(process.env.FB_APP_SECRET || config.facebook?.appSecret || "").trim());

  let pages;
  try {
    pages = await getAllPages(userToken, { appSecret, metaAppKey: metaKey });
  } catch (e) {
    db.prepare(
      `UPDATE fb_accounts SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(e.message, accountId);
    throw e;
  }

  const upsert = db.prepare(`
    INSERT INTO fb_pages (
      account_id, page_id, name, category, tasks_json, page_token_enc,
      followers_count, fan_count, picture_url, link,
      status, last_synced_at, updated_at
    )
    VALUES (
      @account_id, @page_id, @name, @category, @tasks_json, @page_token_enc,
      @followers_count, @fan_count, @picture_url, @link,
      'active', datetime('now'), datetime('now')
    )
    ON CONFLICT(account_id, page_id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      tasks_json = excluded.tasks_json,
      page_token_enc = excluded.page_token_enc,
      followers_count = COALESCE(excluded.followers_count, fb_pages.followers_count),
      fan_count = COALESCE(excluded.fan_count, fb_pages.fan_count),
      picture_url = COALESCE(excluded.picture_url, fb_pages.picture_url),
      link = COALESCE(excluded.link, fb_pages.link),
      status = 'active',
      last_synced_at = datetime('now'),
      updated_at = datetime('now')
  `);

  const existingRows = db
    .prepare(`SELECT id, page_id, status FROM fb_pages WHERE account_id = ?`)
    .all(accountId);
  const existingIds = new Set(existingRows.map((p) => String(p.page_id)));
  const activeGlobalBefore = db
    .prepare(`SELECT COUNT(*) AS n FROM fb_pages WHERE status = 'active'`)
    .get().n;
  const skippedByLicense = [];
  let acceptedNew = 0;

  const seen = new Set();
  const tx = db.transaction((list) => {
    for (const p of list) {
      if (!p.id || !p.access_token) continue;
      const isNew = !existingIds.has(String(p.id));
      if (isNew) {
        const quota = checkQuota("page", activeGlobalBefore + acceptedNew);
        if (!quota.ok) {
          skippedByLicense.push({ page_id: String(p.id), name: p.name || String(p.id), error: quota.error });
          continue;
        }
        acceptedNew++;
      }
      seen.add(p.id);
      const pictureUrl =
        p.picture?.data?.url || p.picture?.url || null;
      upsert.run({
        account_id: accountId,
        page_id: p.id,
        name: p.name || null,
        category: p.category || null,
        tasks_json: JSON.stringify(p.tasks || []),
        page_token_enc: encryptToken(p.access_token),
        followers_count:
          p.followers_count != null && Number.isFinite(Number(p.followers_count))
            ? Number(p.followers_count)
            : null,
        fan_count:
          p.fan_count != null && Number.isFinite(Number(p.fan_count))
            ? Number(p.fan_count)
            : null,
        picture_url: pictureUrl,
        link: p.link || null,
      });
    }
    // Soft-disable pages no longer returned
    const existingPages = db
      .prepare(`SELECT page_id FROM fb_pages WHERE account_id = ?`)
      .all(accountId);
    for (const ep of existingPages) {
      if (!seen.has(ep.page_id)) {
        db.prepare(
          `UPDATE fb_pages SET status = 'missing', updated_at = datetime('now') WHERE account_id = ? AND page_id = ?`
        ).run(accountId, ep.page_id);
      }
    }
    const activeForAccount = db
      .prepare(`SELECT COUNT(*) AS n FROM fb_pages WHERE account_id = ? AND status = 'active'`)
      .get(accountId).n;
    db.prepare(
      `UPDATE fb_accounts SET page_count = ?, last_sync_at = datetime('now'), status = 'active', last_error = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(activeForAccount, accountId);
  });

  tx(pages);

  const result = db
    .prepare(
      `SELECT * FROM fb_pages WHERE account_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE`
    )
    .all(accountId);
  result.sync_summary = {
    remote_pages: pages.length,
    active_pages: result.length,
    added_pages: acceptedNew,
    skipped_license: skippedByLicense.length,
    skipped_pages: skippedByLicense,
  };
  return result;
}

export function listAccounts() {
  return getDb()
    .prepare(
      `SELECT id, fb_user_id, name, email, picture_url, user_token_expires_at,
              status, last_sync_at, last_error, page_count, created_at, updated_at,
              meta_app_key, meta_app_id
       FROM fb_accounts ORDER BY meta_app_key, id DESC`
    )
    .all()
    .map(enrichAccountAppLabel);
}

export function getAccountPublic(id) {
  const row = getDb()
    .prepare(
      `SELECT id, fb_user_id, name, email, picture_url, user_token_expires_at,
              status, last_sync_at, last_error, page_count, created_at, updated_at,
              meta_app_key, meta_app_id
       FROM fb_accounts WHERE id = ?`
    )
    .get(id);
  return row ? enrichAccountAppLabel(row) : null;
}

function enrichAccountAppLabel(row) {
  if (!row) return row;
  const key = row.meta_app_key || "app1";
  return {
    ...row,
    meta_app_key: key,
    meta_app_name: key === "app2" ? "App 2" : key === "app1" ? "App 1" : key,
  };
}

export function listPages({ accountId, q, limit = 500, offset = 0 } = {}) {
  const db = getDb();
  const lim = Math.min(5000, Math.max(1, Number(limit) || 500));
  const off = Math.max(Number(offset) || 0, 0);

  let sql = `
    SELECT p.id, p.account_id, p.page_id, p.name, p.category, p.tasks_json,
           p.status, p.last_synced_at, p.updated_at,
           p.followers_count, p.fan_count, p.overall_star_rating, p.rating_count,
           p.verification_status, p.link, p.about, p.picture_url,
           p.business_id, p.business_name,
           p.roles_json, p.assigned_users_json, p.insights_json,
           p.enrich_error, p.enriched_at,
           a.name AS account_name, a.fb_user_id AS account_fb_user_id,
           a.meta_app_key AS account_meta_app_key, a.meta_app_id AS account_meta_app_id
    FROM fb_pages p
    JOIN fb_accounts a ON a.id = p.account_id
    WHERE p.status = 'active'
  `;
  const params = [];

  if (accountId) {
    sql += ` AND p.account_id = ?`;
    params.push(accountId);
  }
  if (q) {
    sql += ` AND (p.name LIKE ? OR p.page_id LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }

  sql += ` ORDER BY a.id, p.name COLLATE NOCASE LIMIT ? OFFSET ?`;
  params.push(lim, off);

  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => formatPageRow(r));
}

export function getPagePublic(pageRowId) {
  const r = getDb()
    .prepare(
      `SELECT p.*, a.name AS account_name, a.fb_user_id AS account_fb_user_id,
              a.meta_app_key AS account_meta_app_key, a.meta_app_id AS account_meta_app_id
       FROM fb_pages p
       JOIN fb_accounts a ON a.id = p.account_id
       WHERE p.id = ?`
    )
    .get(pageRowId);
  if (!r) return null;
  return formatPageRow(r);
}

function formatPageRow(r) {
  const insights = safeJson(r.insights_json, null);
  return {
    id: r.id,
    account_id: r.account_id,
    page_id: r.page_id,
    name: r.name,
    category: r.category,
    status: r.status,
    tasks: safeJson(r.tasks_json, []),
    last_synced_at: r.last_synced_at,
    updated_at: r.updated_at,
    account_name: r.account_name,
    account_fb_user_id: r.account_fb_user_id,
    meta_app_key: r.account_meta_app_key || "app1",
    meta_app_name:
      r.account_meta_app_key === "app2"
        ? "App 2"
        : !r.account_meta_app_key || r.account_meta_app_key === "app1"
          ? "App 1"
          : r.account_meta_app_key,
    followers_count: r.followers_count ?? null,
    fan_count: r.fan_count ?? null,
    verification_status: r.verification_status || null,
    link: r.link || null,
    about: r.about || null,
    picture_url: r.picture_url || null,
    insights,
    enrich_error: r.enrich_error || null,
    enriched_at: r.enriched_at || null,
  };
}

export function countPages({ accountId, q } = {}) {
  let sql = `SELECT COUNT(*) AS c FROM fb_pages p WHERE p.status = 'active'`;
  const params = [];
  if (accountId) {
    sql += ` AND p.account_id = ?`;
    params.push(accountId);
  }
  if (q) {
    sql += ` AND (p.name LIKE ? OR p.page_id LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`);
  }
  return getDb().prepare(sql).get(...params).c;
}

export function deleteAccount(id) {
  return getDb().prepare(`DELETE FROM fb_accounts WHERE id = ?`).run(id);
}

/** Internal: decrypt page token for future publish module */
export function getPageToken(pageRowId) {
  const row = getDb()
    .prepare(`SELECT page_token_enc FROM fb_pages WHERE id = ?`)
    .get(pageRowId);
  if (!row) return null;
  return decryptToken(row.page_token_enc);
}

export function getUserToken(accountId) {
  const row = getDb()
    .prepare(`SELECT user_token_enc FROM fb_accounts WHERE id = ?`)
    .get(accountId);
  if (!row) return null;
  return decryptToken(row.user_token_enc);
}

function publicPage(row) {
  return {
    id: row.id,
    account_id: row.account_id,
    page_id: row.page_id,
    name: row.name,
    category: row.category,
    status: row.status,
    tasks: safeJson(row.tasks_json, []),
    last_synced_at: row.last_synced_at,
  };
}

function safeJson(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

export { maskToken };
