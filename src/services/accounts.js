import crypto from "crypto";
import { getDb } from "../db/index.js";
import { config } from "../config.js";
import { encryptToken, decryptToken, maskToken } from "./crypto.js";
import {
  exchangeCodeForToken,
  exchangeLongLivedUserToken,
  getMe,
  getAllPages,
  diagnoseUserPageAccess,
  graphGetSoft,
} from "./facebook.js";
import { checkQuota } from "./license.js";

/** Synthetic account for individually pasted Page tokens (not a Facebook user). */
export const PAGE_TOKEN_IMPORT_UID = "__page_token_import__";

function nowIso() {
  return new Date().toISOString();
}

function expiresAtFromSeconds(expiresIn) {
  if (!expiresIn) return null;
  return new Date(Date.now() + Number(expiresIn) * 1000).toISOString();
}

/** Nickname for imported System User token (Token 1 / Token 2 / tên app BM). */
function sanitizeAccountLabel(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.slice(0, 80);
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
  const labelName = sanitizeAccountLabel(opts.label || opts.name);

  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, name FROM fb_accounts WHERE fb_user_id = ? AND meta_app_key = ?`
    )
    .get(me.id, metaAppKey);
  const displayName =
    labelName ||
    (Object.hasOwn(opts, "label") && existing?.name) ||
    me.name ||
    existing?.name ||
    null;

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
      displayName,
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
        displayName,
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

function splitAccessTokens(raw) {
  return String(raw || "")
    .split(/[\r\n,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 20);
}

function isPageTokenAccountsError(err) {
  const m = String(err || "").toLowerCase();
  return (
    m.includes("page access token") ||
    m.includes("does not support this operation") ||
    m.includes("cannot be loaded")
  );
}

/**
 * Classify a pasted Graph token: user / system user (lists pages) vs page token.
 */
async function classifyAccessToken(token, graphOpts) {
  const me = await getMe(token, graphOpts);
  if (!me?.id) throw new Error("Token không gọi được /me — token sai hoặc hết hạn");
  const acc = await graphGetSoft(
    "/me/accounts",
    token,
    { fields: "id", limit: 1 },
    graphOpts
  );
  if (acc.ok) {
    return { kind: "user", me };
  }
  if (isPageTokenAccountsError(acc.error)) {
    return { kind: "page", me, accountsError: acc.error || null };
  }
  if (acc.code === 190) {
    throw new Error(acc.error || "Token hết hạn (OAuthException #190)");
  }
  // User/System User thiếu /me/accounts (thiếu pages_show_list) — vẫn import, sync BM.
  return { kind: "user", me, accountsError: acc.error || null };
}

/**
 * Import System User / user token (all assigned Pages) or one-or-more Page tokens.
 * Does not add Pages onto a personal via — Graph returns page tokens from BM assignment.
 */
export async function importFromAccessToken(rawToken, opts = {}) {
  const tokens = splitAccessTokens(rawToken);
  if (!tokens.length) {
    throw new Error(
      "Dán System User token (BM) hoặc Page token. Lấy trong Business Settings → System users → Generate token."
    );
  }

  const metaAppKey = String(opts.metaAppKey || opts.meta_app_key || "app1");
  const app = opts.app || {};
  const baseLabel = sanitizeAccountLabel(opts.label || opts.name);
  const graphOpts = {
    appSecret: String(app.appSecret || "").trim() || undefined,
    metaAppKey,
  };

  const results = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const label =
      !baseLabel
        ? ""
        : tokens.length === 1
          ? baseLabel
          : `${baseLabel} · ${i + 1}`;
    const classified = await classifyAccessToken(token, graphOpts);
    if (classified.kind === "user") {
      const connected = await importSystemUserToken(token, classified.me, {
        metaAppKey,
        app,
        label,
      });
      results.push({
        kind: "system_or_user",
        extra_slot: Boolean(connected.extra_slot),
        name: connected.account?.name || label || classified.me.name,
        fb_id: classified.me.id,
        account_id: connected.account?.id,
        page_count: connected.pages?.length || 0,
        sync_summary: connected.sync_summary || null,
      });
    } else {
      const one = await importPageToken(token, classified.me, {
        metaAppKey,
        app,
        label,
      });
      results.push({
        kind: "page",
        name: one.page?.name || classified.me.name,
        fb_id: classified.me.id,
        account_id: one.account_id,
        page_count: 1,
        page_id: one.page?.page_id,
      });
    }
  }

  const pageCount = results.reduce((n, r) => n + (r.page_count || 0), 0);
  return {
    ok: true,
    imported: results.length,
    page_count: pageCount,
    results,
  };
}

function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 10);
}

/**
 * First System User token → sync all Pages.
 * Extra tokens of the same SU (khác app / khác mã) → slot riêng, không đè token cũ, không kéo lại hết page.
 */
async function importSystemUserToken(token, me, opts = {}) {
  const metaAppKey = String(opts.metaAppKey || "app1");
  const app = opts.app || {};
  const label = sanitizeAccountLabel(opts.label);
  const db = getDb();
  const primary = db
    .prepare(
      `SELECT id, user_token_enc FROM fb_accounts WHERE fb_user_id = ? AND meta_app_key = ?`
    )
    .get(String(me.id), metaAppKey);

  if (!primary) {
    return connectFromUserToken(token, {
      metaAppKey,
      app,
      upgradeLongLived: false,
      label,
    });
  }

  let same = false;
  try {
    same = decryptToken(primary.user_token_enc) === token;
  } catch {
    same = false;
  }
  if (same) {
    return connectFromUserToken(token, {
      metaAppKey,
      app,
      upgradeLongLived: false,
      label,
    });
  }

  const slotUid = `${me.id}~${tokenFingerprint(token)}`;
  const slot = db
    .prepare(
      `SELECT id, name FROM fb_accounts WHERE fb_user_id = ? AND meta_app_key = ?`
    )
    .get(slotUid, metaAppKey);

  const picture = me.picture?.data?.url || me.picture?.url || null;
  const slotCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fb_accounts
       WHERE meta_app_key = ? AND (fb_user_id = ? OR fb_user_id LIKE ?)`
    )
    .get(metaAppKey, String(me.id), `${me.id}~%`).n;
  const slotName =
    label ||
    (slot && slot.name) ||
    `${me.name || "System User"} · token ${slotCount + 1}`;

  if (slot) {
    db.prepare(
      `UPDATE fb_accounts SET
        name = ?, picture_url = ?, user_token_enc = ?,
        status = 'active', last_error = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(slotName, picture, encryptToken(token), slot.id);
    return {
      extra_slot: true,
      account: getAccountPublic(slot.id),
      pages: listPages({ accountId: slot.id, limit: 5000 }),
    };
  }

  const n = db
    .prepare(`SELECT COUNT(*) AS c FROM fb_accounts WHERE status != 'deleted'`)
    .get().c;
  const q = checkQuota("account", n);
  if (!q.ok) throw new Error(q.error || "License không cho thêm token (account)");

  const info = db
    .prepare(
      `INSERT INTO fb_accounts
        (fb_user_id, name, email, picture_url, user_token_enc, user_token_expires_at,
         status, meta_app_key, meta_app_id)
       VALUES (?, ?, NULL, ?, ?, NULL, 'active', ?, ?)`
    )
    .run(
      slotUid,
      slotName,
      picture,
      encryptToken(token),
      metaAppKey,
      app.appId || null
    );
  return {
    extra_slot: true,
    account: getAccountPublic(info.lastInsertRowid),
    pages: [],
  };
}

function getOrCreatePageTokenImportAccount(metaAppKey, appId) {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM fb_accounts WHERE fb_user_id = ? AND meta_app_key = ?`
    )
    .get(PAGE_TOKEN_IMPORT_UID, metaAppKey);
  if (existing) return existing.id;

  const n = db
    .prepare(`SELECT COUNT(*) AS c FROM fb_accounts WHERE status != 'deleted'`)
    .get().c;
  const q = checkQuota("account", n);
  if (!q.ok) throw new Error(q.error || "License không cho thêm account");

  const info = db
    .prepare(
      `INSERT INTO fb_accounts
        (fb_user_id, name, email, picture_url, user_token_enc, user_token_expires_at,
         status, meta_app_key, meta_app_id)
       VALUES (?, ?, NULL, NULL, ?, NULL, 'active', ?, ?)`
    )
    .run(
      PAGE_TOKEN_IMPORT_UID,
      "Page tokens (BM import)",
      encryptToken("page-token-import"),
      metaAppKey,
      appId || null
    );
  return info.lastInsertRowid;
}

async function importPageToken(token, me, opts = {}) {
  const metaAppKey = String(opts.metaAppKey || "app1");
  const app = opts.app || {};
  const accountId = getOrCreatePageTokenImportAccount(
    metaAppKey,
    app.appId || null
  );

  const db = getDb();
  const pageId = String(me.id);
  const existingPage = db
    .prepare(
      `SELECT id FROM fb_pages WHERE account_id = ? AND page_id = ?`
    )
    .get(accountId, pageId);
  if (!existingPage) {
    const activeGlobal = db
      .prepare(`SELECT COUNT(*) AS n FROM fb_pages WHERE status = 'active'`)
      .get().n;
    const quota = checkQuota("page", activeGlobal);
    if (!quota.ok) throw new Error(quota.error || "License hết slot Page");
  }

  const picture = me.picture?.data?.url || me.picture?.url || null;
  db.prepare(
    `INSERT INTO fb_pages (
      account_id, page_id, name, category, tasks_json, page_token_enc,
      followers_count, fan_count, picture_url, link,
      status, last_synced_at, updated_at
    ) VALUES (
      ?, ?, ?, NULL, '[]', ?, NULL, NULL, ?, NULL,
      'active', datetime('now'), datetime('now')
    )
    ON CONFLICT(account_id, page_id) DO UPDATE SET
      name = excluded.name,
      page_token_enc = excluded.page_token_enc,
      picture_url = COALESCE(excluded.picture_url, fb_pages.picture_url),
      status = 'active',
      last_synced_at = datetime('now'),
      updated_at = datetime('now')`
  ).run(accountId, pageId, me.name || pageId, encryptToken(token), picture);

  const activeForAccount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fb_pages WHERE account_id = ? AND status = 'active'`
    )
    .get(accountId).n;
  db.prepare(
    `UPDATE fb_accounts SET page_count = ?, last_sync_at = datetime('now'),
       status = 'active', last_error = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(activeForAccount, accountId);

  const page = db
    .prepare(
      `SELECT id, page_id, name, status FROM fb_pages WHERE account_id = ? AND page_id = ?`
    )
    .get(accountId, pageId);
  return { account_id: accountId, page };
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

  let short;
  try {
    short = await exchangeCodeForToken(code, creds);
  } catch (e) {
    const m = String(e.message || e);
    if (/redirect_uri|verification code|identical/i.test(m)) {
      throw new Error(
        `${m} — redirect_uri khi đổi code phải = dialog: «${creds.redirectUri || "?"}». ` +
          `Kiểm tra FB_REDIRECT_URI / OAUTH_RELAY_URL (modelswiki.top) và Meta Valid OAuth Redirect URIs.`
      );
    }
    throw e;
  }
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

  if (String(row.fb_user_id || "") === PAGE_TOKEN_IMPORT_UID) {
    throw new Error(
      "Account này là Page token dán tay — không Sync /me/accounts. " +
        "Dán thêm token ở «Import token BM» hoặc xóa Page không dùng."
    );
  }

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
    pages = await getAllPages(userToken, {
      appSecret,
      metaAppKey: metaKey,
      appId: row.meta_app_id || process.env.FB_APP_ID || config.facebook?.appId,
    });
  } catch (e) {
    db.prepare(
      `UPDATE fb_accounts SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(e.message, accountId);
    throw e;
  }

  const graphMeta = pages?.__syncMeta || null;
  const diag = graphMeta?.diagnose || null;
  const remoteTotal = Array.isArray(pages) ? pages.length : 0;
  const skippedNoToken = [];
  const withToken = [];
  for (const p of pages || []) {
    if (!p?.id) continue;
    if (!p.access_token) {
      skippedNoToken.push({
        page_id: String(p.id),
        name: p.name || String(p.id),
        sources: p._sources || [],
      });
      continue;
    }
    withToken.push(p);
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

  tx(withToken);

  const result = db
    .prepare(
      `SELECT * FROM fb_pages WHERE account_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE`
    )
    .all(accountId);

  // Ghi chú lỗi dễ hiểu khi 0 page (không nuốt im lặng)
  let hint = null;
  const bmClient = Number(graphMeta?.bm_client || 0);
  const bmOwned = Number(graphMeta?.bm_owned || 0);
  const bmAssigned = Number(graphMeta?.bm_assigned || 0);
  const bmBiz = Number(graphMeta?.bm_businesses || 0);
  const meAcc = Number(graphMeta?.me_accounts || 0);
  const partnerListed = bmClient + bmOwned + bmAssigned;

  if (result.length === 0) {
    if (remoteTotal === 0) {
      const declined = (diag?.permissions_declined || []).join(", ");
      const granted = (diag?.permissions_granted || []).slice(0, 12).join(", ");
      const granularN = Number(diag?.page_target_ids?.length || graphMeta?.granular_page_ids || 0);
      const parts = [];
      parts.push(
        "Graph không trả Page nào (me/accounts + BM + page đã chọn lúc login)."
      );
      if (diag && !diag.me_ok) {
        parts.push(
          `Token lỗi: ${diag.me_error || "không gọi được /me"} — Connect lại (đổi pass / session Meta).`
        );
      } else if (diag && !diag.has_pages_show_list) {
        parts.push(
          "Thiếu quyền pages_show_list trên token (bị từ chối hoặc chưa xin). Connect lại → rerequest → bật đủ quyền."
        );
      } else if (diag && !diag.has_business_management) {
        parts.push(
          "Token KHÔNG có business_management (dù App Meta có thể đã bật quyền). " +
            "Khác nhau: quyền trên App Dashboard ≠ quyền đã grant vào token. " +
            "Cách: (1) trong .env máy này FB_SCOPES phải có business_management; " +
            "(2) Facebook → Business integrations → gỡ app; " +
            "(3) Connect rerequest, bật đủ quyền, chọn Page."
        );
      } else if (granularN > 0) {
        parts.push(
          `Login đã chọn ${granularN} Page (granular) nhưng Graph không cấp page access_token. ` +
            "Thường do: (A) App đang Development — nick Connect phải là Admin/Developer/Tester của Meta App; " +
            "(B) pages_* / business_management chỉ Standard Access khi App Live; " +
            "(C) Nick chỉ có quyền BM/partner, chưa có task CREATE_CONTENT trên Page."
        );
      } else {
        parts.push(
          "Không thấy Page nào trong token. Kiểm tra: (1) Meta App Development → thêm nick vào Roles (Admin/Developer/Tester) hoặc bật App Live + Advanced Access; " +
            "(2) Share đối tác Full ≠ quyền đăng API — gán Page CREATE_CONTENT cho nick; " +
            "(3) Connect lại, bấm Edit access, chọn đủ Page, không bỏ quyền."
        );
      }
      if (declined) parts.push(`Quyền bị từ chối: ${declined}.`);
      if (granted) parts.push(`Đã cấp: ${granted}.`);
      if (diag?.accounts_error) parts.push(`me/accounts: ${diag.accounts_error}`);
      if (diag?.businesses_error) parts.push(`me/businesses: ${diag.businesses_error}`);
      hint = parts.join(" ");
    } else if (skippedNoToken.length > 0 && skippedNoToken.length === remoteTotal) {
      const sample = skippedNoToken
        .slice(0, 3)
        .map((p) => p.name)
        .join(", ");
      if (partnerListed > 0 || skippedNoToken.some((p) => (p.sources || []).some((s) => String(s).startsWith("bm:")))) {
        hint =
          `Đã thấy ${remoteTotal} Page qua Business/đối tác (BM client/owned/assigned) nhưng KHÔNG có page access_token — tool không đăng được. ` +
          `Share “Full partner” ≠ gán quyền đăng cho nick. ` +
          `Cách đúng: Business Settings → People → chọn nick Connect → Assign assets → Pages → bật Content (CREATE_CONTENT) / Full control; ` +
          `hoặc Page → Page access thêm nick làm Editor/Admin. Sau đó Connect lại / Sync Pages. ` +
          `Mẫu: ${sample}.`;
      } else {
        hint =
          `Graph thấy ${remoteTotal} Page nhưng không có page access_token (bị bỏ). ` +
          `Cần role Admin/Editor với CREATE_CONTENT + scope pages_manage_posts. ` +
          `Page mẫu: ${sample}.`;
      }
    } else if (skippedByLicense.length > 0) {
      hint = `License chặn ${skippedByLicense.length} Page mới — nâng license hoặc xóa Page cũ.`;
    } else {
      hint = "Không lưu được Page — kiểm tra token / quyền / license.";
    }
    db.prepare(
      `UPDATE fb_accounts SET last_error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(hint.slice(0, 900), accountId);
    console.warn(
      `[syncPages] account=${accountId} 0 pages · remote=${remoteTotal} no_token=${skippedNoToken.length} ` +
        `license=${skippedByLicense.length} me=${meAcc} bm_biz=${bmBiz} bm_client=${bmClient} ` +
        `bm_owned=${bmOwned} bm_assigned=${bmAssigned}`
    );
  } else {
    db.prepare(
      `UPDATE fb_accounts SET last_error = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(accountId);
  }

  result.sync_summary = {
    remote_pages: remoteTotal,
    remote_with_token: withToken.length,
    active_pages: result.length,
    added_pages: acceptedNew,
    skipped_license: skippedByLicense.length,
    skipped_pages: skippedByLicense,
    skipped_no_token: skippedNoToken.length,
    skipped_no_token_pages: skippedNoToken.slice(0, 20),
    graph: graphMeta
      ? {
          me_accounts: meAcc,
          bm_businesses: bmBiz,
          bm_owned: bmOwned,
          bm_client: bmClient,
          bm_assigned: bmAssigned,
          granular_page_ids: graphMeta.granular_page_ids || 0,
          token_resolved: graphMeta.token_resolved || 0,
          token_resolve_fail: graphMeta.token_resolve_fail || 0,
          bm_errors: (graphMeta.bm_errors || []).slice(0, 8),
        }
      : null,
    diagnose: diag
      ? {
          me_ok: diag.me_ok,
          me_name: diag.me_name,
          has_pages_show_list: diag.has_pages_show_list,
          has_pages_manage_posts: diag.has_pages_manage_posts,
          has_business_management: diag.has_business_management,
          permissions_granted: diag.permissions_granted,
          permissions_declined: diag.permissions_declined,
          page_target_ids_count: (diag.page_target_ids || []).length,
          accounts_total: diag.accounts_total,
          businesses_count: diag.businesses_count,
          token_valid: diag.token_valid,
          debug_error: diag.debug_error,
        }
      : null,
    hint,
  };
  return result;
}

/**
 * Deep diagnose why Connect shows 0 pages (permissions / App mode / partner).
 */
export async function diagnoseAccountPages(accountId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM fb_accounts WHERE id = ?`).get(accountId);
  if (!row) throw new Error("Account not found");
  const userToken = decryptToken(row.user_token_enc);
  const metaKey = String(row.meta_app_key || "app1");
  const appSecret =
    metaKey === "app2"
      ? String(process.env.FB_APP_SECRET_2 || process.env.FB_APP_SECRET || "").trim()
      : String(process.env.FB_APP_SECRET || config.facebook?.appSecret || "").trim();
  const diag = await diagnoseUserPageAccess(userToken, {
    appSecret,
    metaAppKey: metaKey,
    appId: row.meta_app_id || process.env.FB_APP_ID || config.facebook?.appId,
  });
  return {
    account_id: accountId,
    name: row.name,
    meta_app_key: metaKey,
    ...diag,
    checklist_vi: buildZeroPageChecklist(diag),
  };
}

function buildZeroPageChecklist(diag) {
  const items = [];
  items.push({
    ok: !!diag?.me_ok,
    text: diag?.me_ok
      ? `Token /me OK — ${diag.me_name || diag.me_id}`
      : `Token hỏng: ${diag?.me_error || "Connect lại"}`,
  });
  items.push({
    ok: !!diag?.has_pages_show_list,
    text: diag?.has_pages_show_list
      ? "Có pages_show_list"
      : "THIẾU pages_show_list — Connect rerequest, đừng bỏ quyền",
  });
  items.push({
    ok: !!diag?.has_business_management,
    text: diag?.has_business_management
      ? "Có business_management trên TOKEN"
      : "TOKEN thiếu business_management (App có quyền ≠ token đã grant). Kiểm tra FB_SCOPES + Connect rerequest + gỡ Business integrations rồi login lại",
  });
  items.push({
    ok: !!diag?.has_pages_manage_posts,
    text: diag?.has_pages_manage_posts
      ? "Có pages_manage_posts (đăng bài)"
      : "THIẾU pages_manage_posts",
  });
  const n = diag?.page_target_ids?.length || 0;
  items.push({
    ok: n > 0,
    text:
      n > 0
        ? `Login đã chọn ~${n} Page (granular target_ids)`
        : "Token không có Page ID đã chọn — lúc login phải Edit → chọn Page, không «Only as myself»",
  });
  items.push({
    ok: (diag?.accounts_total || 0) > 0,
    text:
      (diag?.accounts_total || 0) > 0
        ? `me/accounts total=${diag.accounts_total}`
        : "me/accounts = 0 — App Development (thêm nick Roles) HOẶC chưa Advanced Access HOẶC nick không có task Page",
  });
  items.push({
    ok: (diag?.businesses_count || 0) > 0,
    text:
      (diag?.businesses_count || 0) > 0
        ? `Nick thấy ${diag.businesses_count} Business`
        : "Không thấy Business — share partner chưa vào nick này / thiếu business_management",
  });
  items.push({
    ok: false,
    text:
      "Lưu ý: tick Page lúc login ≠ đủ. Nick phải có CREATE_CONTENT trên Page (Page access Editor) " +
      "và Meta App Live + Advanced Access (hoặc nick là Tester/Admin App).",
  });
  return items;
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

/**
 * Xóa nhiều tài khoản OAuth (+ page tokens CASCADE).
 * @param {number[]} ids
 * @returns {{ deleted: number[], missing: number[], deleted_count: number }}
 */
export function deleteAccounts(ids) {
  const list = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ];
  if (!list.length) {
    return { deleted: [], missing: [], deleted_count: 0 };
  }
  const db = getDb();
  const del = db.prepare(`DELETE FROM fb_accounts WHERE id = ?`);
  const exists = db.prepare(`SELECT id FROM fb_accounts WHERE id = ?`);
  const deleted = [];
  const missing = [];
  const tx = db.transaction((rows) => {
    for (const id of rows) {
      if (!exists.get(id)) {
        missing.push(id);
        continue;
      }
      del.run(id);
      deleted.push(id);
    }
  });
  tx(list);
  return { deleted, missing, deleted_count: deleted.length };
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
