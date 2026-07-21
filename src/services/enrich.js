import { getDb } from "../db/index.js";
import { decryptToken } from "./crypto.js";
import { config } from "../config.js";
import { getPageProfile, getPageInsights, sleep } from "./facebook.js";
import { suggestedDelayMs, getLastUsage, usageWarning } from "./rateLimit.js";
import { saveFollowerSnapshot } from "./followerHistory.js";

const DEFAULT_DELAY_MS = config.enrichDelayMs || 200;

function sumValues(values) {
  let sum = 0;
  let n = 0;
  for (const v of values || []) {
    const x = v?.value;
    if (typeof x === "number") {
      sum += x;
      n++;
    }
  }
  return {
    sum,
    n,
    latest: values?.length ? values[values.length - 1]?.value ?? null : null,
    first:
      values?.length && typeof values[0]?.value === "number"
        ? values[0].value
        : null,
  };
}

/** 7-day follower growth from page_follows series */
function computeGrowth7d(metrics) {
  const follows = metrics.page_follows;
  if (
    follows &&
    typeof follows.first === "number" &&
    typeof follows.latest === "number" &&
    follows.values_count >= 2
  ) {
    const start = follows.first;
    const end = follows.latest;
    const absolute = end - start;
    const percent =
      start > 0 ? Math.round((absolute / start) * 10000) / 100 : null;
    return {
      absolute,
      percent,
      start,
      end,
      method: "page_follows_delta",
    };
  }
  const daily = metrics.page_daily_follows;
  if (daily && typeof daily.sum === "number") {
    const absolute = daily.sum;
    const end =
      typeof metrics.page_follows?.latest === "number"
        ? metrics.page_follows.latest
        : null;
    const start = end != null ? end - absolute : null;
    const percent =
      start != null && start > 0
        ? Math.round((absolute / start) * 10000) / 100
        : null;
    return {
      absolute,
      percent,
      start,
      end,
      method: "page_daily_follows_sum",
    };
  }
  return {
    absolute: null,
    percent: null,
    start: null,
    end: null,
    method: null,
  };
}

function mapInsights(insightsResult) {
  if (!insightsResult.ok) {
    return {
      ok: false,
      error: insightsResult.error,
      metrics: {},
      growth_7d: null,
      label: "—",
    };
  }
  const metrics = {};
  for (const row of insightsResult.data.data || []) {
    const name = row.name;
    const values = row.values || [];
    const agg = sumValues(values);
    metrics[name] = {
      title: row.title || name,
      period: row.period,
      latest: agg.latest,
      first: agg.first,
      sum: agg.sum,
      end_time: values[values.length - 1]?.end_time || null,
      values_count: values.length,
    };
  }
  const growth_7d = computeGrowth7d(metrics);
  let label = "—";
  if (growth_7d.absolute != null) {
    const sign = growth_7d.absolute > 0 ? "+" : "";
    label =
      `7d ${sign}${growth_7d.absolute}` +
      (growth_7d.percent != null ? ` (${sign}${growth_7d.percent}%)` : "");
  }
  return {
    ok: true,
    error: null,
    metrics,
    growth_7d,
    label,
    tried_errors: insightsResult.errors || [],
  };
}

/**
 * Enrich one page: profile (followers) + growth 7d only.
 * Removed: countries, admin/BTV list, BM people (no reliable Graph API).
 */
export async function enrichPageById(pageRowId, opts = {}) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, account_id, page_id, page_token_enc, name, enriched_at,
              followers_count, picture_url
       FROM fb_pages WHERE id = ?`
    )
    .get(pageRowId);
  if (!row) throw new Error("Page not found");

  const force = opts.force === true;
  const profileOnly = opts.profileOnly === true;
  const ttlH = config.enrichTtlHours ?? 12;
  // Chỉ skip khi đã có follow + avatar; thiếu 1 trong 2 thì enrich lại
  const hasCore =
    row.followers_count != null &&
    String(row.picture_url || "").trim().length > 0;
  if (!force && hasCore && row.enriched_at) {
    const ageMs2 = Date.now() - new Date(row.enriched_at.replace(" ", "T") + "Z").getTime();
    if (Number.isFinite(ageMs2) && ageMs2 < ttlH * 3600 * 1000) {
      return {
        id: pageRowId,
        page_id: row.page_id,
        name: row.name,
        ok: true,
        skipped: true,
        reason: `fresh (<${ttlH}h)`,
        followers_count: row.followers_count,
        picture_url: row.picture_url || null,
      };
    }
  }

  const pageToken = decryptToken(row.page_token_enc);
  if (!pageToken) throw new Error("No page token");

  const errors = [];
  let profile;
  try {
    profile = await getPageProfile(row.page_id, pageToken);
  } catch (e) {
    db.prepare(
      `UPDATE fb_pages SET enrich_error = ?, enriched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(e.message, pageRowId);
    return {
      id: pageRowId,
      page_id: row.page_id,
      name: row.name,
      ok: false,
      error: e.message,
    };
  }

  let insights = {
    ok: true,
    error: null,
    metrics: {},
    growth_7d: null,
    label: "—",
  };
  if (!profileOnly) {
    const insightsR = await getPageInsights(row.page_id, pageToken);
    insights = mapInsights(insightsR);
    if (!insights.ok) errors.push(`insights: ${insights.error}`);
  }

  const picture =
    profile.picture?.data?.url ||
    profile.picture?.url ||
    row.picture_url ||
    null;

  db.prepare(
    `UPDATE fb_pages SET
      name = COALESCE(?, name),
      category = COALESCE(?, category),
      followers_count = ?,
      fan_count = ?,
      overall_star_rating = NULL,
      rating_count = NULL,
      verification_status = ?,
      link = ?,
      about = ?,
      picture_url = ?,
      business_id = NULL,
      business_name = NULL,
      roles_json = NULL,
      assigned_users_json = NULL,
      insights_json = CASE WHEN ? = 1 THEN insights_json ELSE ? END,
      enrich_error = ?,
      enriched_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?`
  ).run(
    profile.name || null,
    profile.category || null,
    profile.followers_count ?? null,
    profile.fan_count ?? null,
    profile.verification_status || null,
    profile.link || null,
    profile.about || null,
    picture,
    profileOnly ? 1 : 0,
    profileOnly ? null : JSON.stringify(insights),
    errors.length ? errors.join(" | ") : null,
    pageRowId
  );

  saveFollowerSnapshot(
    pageRowId,
    profile.followers_count ?? null,
    profile.fan_count ?? null
  );

  return {
    id: pageRowId,
    page_id: row.page_id,
    name: profile.name || row.name,
    ok: true,
    followers_count: profile.followers_count ?? null,
    fan_count: profile.fan_count ?? null,
    picture_url: picture,
    growth_7d: insights.growth_7d || null,
    insights_ok: insights.ok,
    profile_only: profileOnly,
    warnings: errors,
  };
}

export async function enrichAccountPages(
  accountId,
  { delayMs = DEFAULT_DELAY_MS, force = false, profileOnly = false } = {}
) {
  const db = getDb();
  const pages = db
    .prepare(
      `SELECT id FROM fb_pages WHERE account_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE`
    )
    .all(accountId);

  const results = [];
  let skipped = 0;
  for (let i = 0; i < pages.length; i++) {
    try {
      const r = await enrichPageById(pages[i].id, { force, profileOnly });
      if (r.skipped) skipped++;
      results.push(r);
    } catch (e) {
      results.push({ id: pages[i].id, ok: false, error: e.message });
    }
    if (i < pages.length - 1) await sleep(suggestedDelayMs(delayMs));
  }

  return {
    account_id: accountId,
    total: pages.length,
    ok_count: results.filter((r) => r.ok && !r.skipped).length,
    skipped_count: skipped,
    fail_count: results.filter((r) => !r.ok).length,
    results,
    app_usage: getLastUsage(),
    usage_warning: usageWarning(),
  };
}

/**
 * Sau Sync list: lấy follow + avatar cho page còn thiếu (nhanh, không insights).
 */
export async function enrichMissingProfilesForAccount(accountId, opts = {}) {
  const db = getDb();
  const pages = db
    .prepare(
      `SELECT id FROM fb_pages
       WHERE account_id = ? AND status = 'active'
         AND (followers_count IS NULL OR picture_url IS NULL OR picture_url = '')
       ORDER BY name COLLATE NOCASE`
    )
    .all(accountId);
  if (!pages.length) {
    return {
      account_id: accountId,
      total: 0,
      ok_count: 0,
      skipped_count: 0,
      fail_count: 0,
      results: [],
      message: "all_profiles_present",
    };
  }
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const results = [];
  for (let i = 0; i < pages.length; i++) {
    try {
      results.push(
        await enrichPageById(pages[i].id, { force: true, profileOnly: true })
      );
    } catch (e) {
      results.push({ id: pages[i].id, ok: false, error: e.message });
    }
    if (i < pages.length - 1) await sleep(suggestedDelayMs(delayMs));
  }
  return {
    account_id: accountId,
    total: pages.length,
    ok_count: results.filter((r) => r.ok).length,
    skipped_count: 0,
    fail_count: results.filter((r) => !r.ok).length,
    results,
    app_usage: getLastUsage(),
    usage_warning: usageWarning(),
  };
}

export async function enrichAllPages({
  delayMs = DEFAULT_DELAY_MS,
  force = false,
} = {}) {
  const db = getDb();
  const accounts = db
    .prepare(`SELECT id FROM fb_accounts WHERE status != 'deleted' ORDER BY id`)
    .all();
  const byAccount = [];
  for (const a of accounts) {
    byAccount.push(await enrichAccountPages(a.id, { delayMs, force }));
  }
  return {
    accounts: byAccount.length,
    by_account: byAccount,
    app_usage: getLastUsage(),
    usage_warning: usageWarning(),
  };
}
