/**
 * Split active Pages into Publish groups of N per token (default 15).
 * Extra System User tokens (imported) can receive pages if Graph still
 * returns a page access_token for that token — otherwise page stays put.
 */
import { getDb } from "../db/index.js";
import { decryptToken, encryptToken } from "./crypto.js";
import { graphGetSoft, resolveAppSecret } from "./facebook.js";
import { PAGE_TOKEN_IMPORT_UID } from "./accounts.js";
import { getSelectionGroups, saveSelectionGroups } from "./selectionGroups.js";

const GROUP_PREFIX = "toksplit_";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampPer(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 15;
  return Math.max(5, Math.min(50, Math.round(v)));
}

function recountAccount(db, accountId) {
  const n = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fb_pages WHERE account_id = ? AND status = 'active'`
    )
    .get(accountId).n;
  db.prepare(
    `UPDATE fb_accounts SET page_count = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(n, accountId);
}

async function pageTokenForAccount(pageFbId, userToken, graphOpts) {
  const r = await graphGetSoft(
    `/${pageFbId}`,
    userToken,
    {
      fields:
        "id,name,category,access_token,tasks,followers_count,fan_count,link,picture.type(large)",
    },
    graphOpts
  );
  if (r.ok && r.data?.access_token) return r.data.access_token;
  return null;
}

export async function splitPagesByToken(opts = {}) {
  const per = clampPer(opts.pages_per_token ?? 15);
  const db = getDb();

  const accounts = db
    .prepare(
      `SELECT id, fb_user_id, name, user_token_enc, meta_app_key, status
       FROM fb_accounts
       WHERE status = 'active' AND fb_user_id != ?
       ORDER BY id`
    )
    .all(PAGE_TOKEN_IMPORT_UID);

  if (!accounts.length) {
    throw new Error(
      "Chưa có token System User. Vào Connect → Import token BM trước."
    );
  }

  const pages = db
    .prepare(
      `SELECT id, account_id, page_id, name, page_token_enc
       FROM fb_pages WHERE status = 'active'
       ORDER BY account_id, id`
    )
    .all();

  if (!pages.length) {
    throw new Error("Chưa có page active. Import token rồi lấy danh sách page trước.");
  }

  const tokenCache = new Map();
  function userTokenOf(acc) {
    if (tokenCache.has(acc.id)) return tokenCache.get(acc.id);
    let t = null;
    try {
      t = decryptToken(acc.user_token_enc);
    } catch {
      t = null;
    }
    tokenCache.set(acc.id, t);
    return t;
  }

  const assigned = accounts.map(() => []);
  for (let i = 0; i < pages.length; i++) {
    const idx = Math.min(Math.floor(i / per), accounts.length - 1);
    assigned[idx].push(pages[i]);
  }

  const moved = [];
  const kept = [];
  const failed = [];

  for (let ai = 0; ai < accounts.length; ai++) {
    const acc = accounts[ai];
    const graphOpts = {
      appSecret: resolveAppSecret(null, acc.meta_app_key),
      metaAppKey: acc.meta_app_key,
    };
    const ut = userTokenOf(acc);
    for (const page of assigned[ai]) {
      if (Number(page.account_id) === Number(acc.id)) {
        kept.push({ page_id: page.page_id, name: page.name, account_id: acc.id });
        continue;
      }
      if (!ut) {
        failed.push({
          page_id: page.page_id,
          name: page.name,
          error: `Token account #${acc.id} không đọc được`,
        });
        continue;
      }
      const dup = db
        .prepare(
          `SELECT id FROM fb_pages WHERE account_id = ? AND page_id = ? AND id != ?`
        )
        .get(acc.id, page.page_id, page.id);
      if (dup) {
        failed.push({
          page_id: page.page_id,
          name: page.name,
          error: `Page đã nằm trên token «${acc.name}»`,
        });
        continue;
      }
      const newPageTok = await pageTokenForAccount(page.page_id, ut, graphOpts);
      await sleep(40);
      if (!newPageTok) {
        failed.push({
          page_id: page.page_id,
          name: page.name,
          error: `Token «${acc.name}» không lấy được page access_token — System User chưa được gán CREATE_CONTENT trên page này`,
        });
        continue;
      }
      const fromId = page.account_id;
      db.prepare(
        `UPDATE fb_pages SET account_id = ?, page_token_enc = ?,
           last_synced_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      ).run(acc.id, encryptToken(newPageTok), page.id);
      page.account_id = acc.id;
      moved.push({
        page_id: page.page_id,
        name: page.name,
        from_account_id: fromId,
        to_account_id: acc.id,
        to_name: acc.name,
      });
    }
  }

  const touched = new Set(accounts.map((a) => a.id));
  for (const id of touched) recountAccount(db, id);

  const newGroups = [];
  for (let ai = 0; ai < accounts.length; ai++) {
    const acc = accounts[ai];
    const list = assigned[ai];
    if (!list.length) continue;
    for (let c = 0; c * per < list.length; c++) {
      const chunk = list.slice(c * per, c * per + per);
      newGroups.push({
        id: `${GROUP_PREFIX}${acc.id}_${c + 1}`,
        name: `${acc.name || "Token"} · ${c + 1} (${chunk.length} page)`,
        page_row_ids: chunk.map((p) => Number(p.id)),
        color: null,
        updated_at: new Date().toISOString(),
      });
    }
  }

  const current = getSelectionGroups();
  const keptCustom = (current.page_groups || []).filter(
    (g) => !String(g.id || "").startsWith(GROUP_PREFIX)
  );
  const saved = saveSelectionGroups({
    account_groups: current.account_groups,
    page_groups: [...keptCustom, ...newGroups],
  });

  return {
    ok: true,
    pages_per_token: per,
    token_count: accounts.length,
    page_count: pages.length,
    groups_created: newGroups.length,
    moved: moved.length,
    kept: kept.length,
    failed: failed.length,
    failed_sample: failed.slice(0, 12),
    groups: (saved.page_groups || []).filter((g) =>
      String(g.id || "").startsWith(GROUP_PREFIX)
    ),
    hint:
      accounts.length === 1
        ? `Một token — đã chia ${pages.length} page thành nhóm ${per}/nhóm để chọn trên Publish. Import thêm token BM nếu muốn mỗi nhóm một token Graph khác.`
        : failed.length
          ? "Một số page không chuyển token được (System User chưa gán page đó). Nhóm Publish vẫn tạo theo chia đều."
          : `Đã gán tối đa ${per} page / token và tạo nhóm trên Publish.`,
  };
}
