import { getDb } from "../db/index.js";
import { encryptToken, decryptToken, maskToken } from "./crypto.js";
import {
  exchangeCodeForToken,
  exchangeLongLivedUserToken,
  getMe,
  getAllPages,
} from "./facebook.js";

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
 */
export async function connectFromOAuthCode(code) {
  const short = await exchangeCodeForToken(code);
  if (!short.access_token) {
    throw new Error("No access_token from code exchange");
  }

  let userToken = short.access_token;
  let expiresAt = expiresAtFromSeconds(short.expires_in);

  try {
    const long = await exchangeLongLivedUserToken(short.access_token);
    if (long.access_token) {
      userToken = long.access_token;
      expiresAt = expiresAtFromSeconds(long.expires_in);
    }
  } catch (e) {
    // Keep short-lived if exchange fails (still usable briefly)
    console.warn("[accounts] long-lived exchange failed:", e.message);
  }

  const me = await getMe(userToken);
  const picture =
    me.picture?.data?.url || me.picture?.url || null;

  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM fb_accounts WHERE fb_user_id = ?`)
    .get(me.id);

  let accountId;
  if (existing) {
    accountId = existing.id;
    db.prepare(
      `UPDATE fb_accounts SET
        name = ?, email = ?, picture_url = ?,
        user_token_enc = ?, user_token_expires_at = ?,
        status = 'active', last_error = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      me.name || null,
      me.email || null,
      picture,
      encryptToken(userToken),
      expiresAt,
      accountId
    );
  } else {
    const info = db
      .prepare(
        `INSERT INTO fb_accounts
          (fb_user_id, name, email, picture_url, user_token_enc, user_token_expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`
      )
      .run(
        me.id,
        me.name || null,
        me.email || null,
        picture,
        encryptToken(userToken),
        expiresAt
      );
    accountId = info.lastInsertRowid;
  }

  const pages = await syncPagesForAccount(accountId, userToken);

  return {
    account: getAccountPublic(accountId),
    pages: pages.map(publicPage),
  };
}

/**
 * Re-fetch /me/accounts for one account (large lists supported).
 */
export async function syncPagesForAccount(accountId, userTokenOptional) {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM fb_accounts WHERE id = ?`)
    .get(accountId);
  if (!row) throw new Error("Account not found");

  const userToken =
    userTokenOptional || decryptToken(row.user_token_enc);

  let pages;
  try {
    pages = await getAllPages(userToken);
  } catch (e) {
    db.prepare(
      `UPDATE fb_accounts SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(e.message, accountId);
    throw e;
  }

  const upsert = db.prepare(`
    INSERT INTO fb_pages (account_id, page_id, name, category, tasks_json, page_token_enc, status, last_synced_at, updated_at)
    VALUES (@account_id, @page_id, @name, @category, @tasks_json, @page_token_enc, 'active', datetime('now'), datetime('now'))
    ON CONFLICT(account_id, page_id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      tasks_json = excluded.tasks_json,
      page_token_enc = excluded.page_token_enc,
      status = 'active',
      last_synced_at = datetime('now'),
      updated_at = datetime('now')
  `);

  const seen = new Set();
  const tx = db.transaction((list) => {
    for (const p of list) {
      if (!p.id || !p.access_token) continue;
      seen.add(p.id);
      upsert.run({
        account_id: accountId,
        page_id: p.id,
        name: p.name || null,
        category: p.category || null,
        tasks_json: JSON.stringify(p.tasks || []),
        page_token_enc: encryptToken(p.access_token),
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
    db.prepare(
      `UPDATE fb_accounts SET page_count = ?, last_sync_at = datetime('now'), status = 'active', last_error = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(seen.size, accountId);
  });

  tx(pages);

  return db
    .prepare(
      `SELECT * FROM fb_pages WHERE account_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE`
    )
    .all(accountId);
}

export function listAccounts() {
  return getDb()
    .prepare(
      `SELECT id, fb_user_id, name, email, picture_url, user_token_expires_at,
              status, last_sync_at, last_error, page_count, created_at, updated_at
       FROM fb_accounts ORDER BY id DESC`
    )
    .all();
}

export function getAccountPublic(id) {
  return getDb()
    .prepare(
      `SELECT id, fb_user_id, name, email, picture_url, user_token_expires_at,
              status, last_sync_at, last_error, page_count, created_at, updated_at
       FROM fb_accounts WHERE id = ?`
    )
    .get(id);
}

export function listPages({ accountId, q, limit = 500, offset = 0 } = {}) {
  const db = getDb();
  const lim = Math.min(Number(limit) || 500, 5000);
  const off = Math.max(Number(offset) || 0, 0);

  let sql = `
    SELECT p.id, p.account_id, p.page_id, p.name, p.category, p.tasks_json,
           p.status, p.last_synced_at, p.updated_at,
           p.followers_count, p.fan_count, p.overall_star_rating, p.rating_count,
           p.verification_status, p.link, p.about, p.picture_url,
           p.business_id, p.business_name,
           p.roles_json, p.assigned_users_json, p.insights_json,
           p.enrich_error, p.enriched_at,
           a.name AS account_name, a.fb_user_id AS account_fb_user_id
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
      `SELECT p.*, a.name AS account_name, a.fb_user_id AS account_fb_user_id
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
