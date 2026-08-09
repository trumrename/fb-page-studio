/**
 * Workspace hub: tài khoản FB → danh sách Page + insights + chất lượng + đề xuất.
 */
import {
  listAccounts,
  listPages,
  countPages,
  getAccountPublic,
} from "./accounts.js";
import {
  attachQualityToPages,
  portfolioRecommendations,
} from "./pageQuality.js";
import { listLoginAccountsPublic } from "./httpOps/accountLogin.js";
import { listSessionsPublic } from "./httpOps/cookieVault.js";
import { getDb } from "../db/index.js";

/**
 * Full tree for UI: mỗi OAuth account + pages (kèm quality).
 */
export function getWorkspaceTree({ q = "", includeQuality = true } = {}) {
  const accounts = listAccounts();
  const loginAccounts = listLoginAccountsPublic();
  const sessions = listSessionsPublic();

  const branches = accounts.map((acc) => {
    let pages = listPages({ accountId: acc.id, limit: 5000, q: q || undefined });
    if (includeQuality) pages = attachQualityToPages(pages);

    const followersSum = pages.reduce(
      (s, p) => s + (Number(p.followers_count) || 0),
      0
    );
    const avgScore = pages.length
      ? Math.round(
          pages.reduce((s, p) => s + (p.quality?.score || 0), 0) / pages.length
        )
      : null;
    const gradeCount = { A: 0, B: 0, C: 0, D: 0 };
    for (const p of pages) {
      const g = p.quality?.grade || "D";
      if (gradeCount[g] != null) gradeCount[g]++;
    }

    return {
      account: {
        id: acc.id,
        fb_user_id: acc.fb_user_id,
        name: acc.name,
        email: acc.email,
        picture_url: acc.picture_url,
        status: acc.status,
        meta_app_key: acc.meta_app_key,
        meta_app_name: acc.meta_app_name,
        page_count: acc.page_count ?? pages.length,
        last_sync_at: acc.last_sync_at,
        last_error: acc.last_error,
      },
      pages,
      summary: {
        page_count: pages.length,
        followers_sum: followersSum,
        avg_quality: avgScore,
        grades: gradeCount,
      },
    };
  });

  const allPages = branches.flatMap((b) =>
    b.pages.map((p) => ({
      ...p,
      account_name: b.account.name,
      account_id: b.account.id,
    }))
  );
  const portfolio = portfolioRecommendations(allPages);

  // Pages without account edge cases
  const totalPages = countPages({ q: q || undefined });

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    totals: {
      oauth_accounts: accounts.length,
      pages: totalPages,
      login_accounts: loginAccounts.length,
      sessions: sessions.length,
      followers_sum: branches.reduce((s, b) => s + b.summary.followers_sum, 0),
    },
    oauth_accounts: branches,
    login_accounts: loginAccounts,
    sessions,
    portfolio,
  };
}

export function getAccountWorkspace(accountId) {
  const acc = getAccountPublic(accountId);
  if (!acc) return null;
  let pages = listPages({ accountId, limit: 5000 });
  pages = attachQualityToPages(pages);
  return {
    account: acc,
    pages,
    summary: {
      page_count: pages.length,
      followers_sum: pages.reduce((s, p) => s + (Number(p.followers_count) || 0), 0),
      avg_quality: pages.length
        ? Math.round(
            pages.reduce((s, p) => s + (p.quality?.score || 0), 0) / pages.length
          )
        : null,
    },
    portfolio: portfolioRecommendations(pages),
  };
}

/** Flat ranking for “đề xuất trang” */
export function rankPages({ limit = 50, sort = "quality" } = {}) {
  let pages = attachQualityToPages(listPages({ limit: 5000 }));
  if (sort === "followers") {
    pages.sort((a, b) => (b.followers_count || 0) - (a.followers_count || 0));
  } else if (sort === "growth") {
    pages.sort(
      (a, b) =>
        (b.quality?.growth_7d?.absolute ?? -999999) -
        (a.quality?.growth_7d?.absolute ?? -999999)
    );
  } else {
    pages.sort((a, b) => (b.quality?.score || 0) - (a.quality?.score || 0));
  }
  return pages.slice(0, Math.min(200, Number(limit) || 50));
}

/** Config + posting readiness snapshot */
export function pageOpsHints(pageRowId) {
  const db = getDb();
  const cfg = db
    .prepare(`SELECT * FROM page_post_config WHERE page_row_id = ?`)
    .get(Number(pageRowId));
  return {
    posting_enabled: !!cfg?.enabled,
    max_posts_per_day: cfg?.max_posts_per_day ?? null,
    story_enabled: !!cfg?.story_enabled,
    media_folder: cfg?.media_folder || null,
    last_post_at: cfg?.last_post_at || null,
    posts_today: cfg?.posts_today ?? 0,
  };
}
