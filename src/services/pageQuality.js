/**
 * Chất lượng Page + đề xuất hành động (từ profile, insights, post_logs).
 */
import { getDb } from "../db/index.js";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function growthFromInsights(insights) {
  if (!insights || typeof insights !== "object") return null;
  return insights.growth_7d || null;
}

/**
 * Recent post activity for one page_row_id
 */
export function getPagePostStats(pageRowId, days = 7) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'success' OR status = 'ok' OR status = 'published' THEN 1 ELSE 0 END) AS ok_n,
         SUM(CASE WHEN status = 'error' OR status = 'failed' THEN 1 ELSE 0 END) AS fail_n,
         MAX(created_at) AS last_at
       FROM post_logs
       WHERE page_row_id = ?
         AND created_at >= datetime('now', ?)`
    )
    .get(Number(pageRowId), `-${Number(days)} days`);
  return {
    posts_7d: Number(row?.total || 0),
    ok_7d: Number(row?.ok_n || 0),
    fail_7d: Number(row?.fail_n || 0),
    last_post_at: row?.last_at || null,
  };
}

/**
 * @param {object} page — formatPageRow style
 * @param {object} [postStats]
 */
export function assessPageQuality(page, postStats = null) {
  const stats = postStats || getPagePostStats(page.id);
  const followers = num(page.followers_count) ?? num(page.fan_count) ?? 0;
  const growth = growthFromInsights(page.insights);
  const growthAbs = growth?.absolute != null ? Number(growth.absolute) : null;
  const growthPct = growth?.percent != null ? Number(growth.percent) : null;
  const verified = /blue|gray|verified/i.test(String(page.verification_status || ""));
  const hasPic = !!String(page.picture_url || "").trim();
  const hasAbout = !!String(page.about || "").trim();
  const hasLink = !!String(page.link || "").trim();
  const insightsOk = page.insights?.ok !== false && page.insights != null;
  const enrichAgeH = page.enriched_at
    ? (Date.now() - new Date(String(page.enriched_at).replace(" ", "T") + "Z").getTime()) /
      3600000
    : 999;
  const enrichFresh = enrichAgeH < 48;

  const tips = [];
  let score = 40; // baseline

  // Followers scale
  if (followers >= 100000) score += 20;
  else if (followers >= 10000) score += 15;
  else if (followers >= 1000) score += 10;
  else if (followers >= 100) score += 5;
  else {
    score -= 5;
    tips.push({
      level: "warn",
      code: "LOW_FOLLOWERS",
      text: "Followers thấp — ưu tiên nuôi tương tác và đăng đều, tránh spam group.",
    });
  }

  // Growth
  if (growthAbs != null) {
    if (growthAbs > 0) score += Math.min(15, 5 + Math.floor(growthAbs / 20));
    else if (growthAbs < 0) {
      score -= 10;
      tips.push({
        level: "danger",
        code: "NEGATIVE_GROWTH",
        text: `Followers 7 ngày giảm ${growthAbs}${growthPct != null ? ` (${growthPct}%)` : ""} — kiểm tra nội dung / tần suất / anti-spam.`,
      });
    } else {
      tips.push({
        level: "info",
        code: "FLAT_GROWTH",
        text: "Followers 7 ngày đứng yên — thử caption/CTA và khung giờ peak.",
      });
    }
  } else {
    tips.push({
      level: "info",
      code: "NO_GROWTH_DATA",
      text: "Chưa có growth 7d — bấm Làm mới insights (cần quyền read_insights).",
    });
  }

  if (verified) score += 8;
  else
    tips.push({
      level: "info",
      code: "NOT_VERIFIED",
      text: "Page chưa verified — hoàn thiện thông tin doanh nghiệp nếu đủ điều kiện.",
    });

  if (hasPic) score += 5;
  else {
    score -= 8;
    tips.push({
      level: "warn",
      code: "NO_AVATAR",
      text: "Thiếu ảnh đại diện — cập nhật avatar page trên Facebook.",
    });
  }

  if (hasAbout) score += 4;
  else
    tips.push({
      level: "warn",
      code: "NO_ABOUT",
      text: "Thiếu phần Giới thiệu (about) — thêm mô tả ngắn + từ khóa ngành.",
    });

  if (hasLink) score += 3;

  if (insightsOk) score += 5;
  else if (page.enrich_error) {
    score -= 5;
    tips.push({
      level: "warn",
      code: "ENRICH_ERROR",
      text: `Lỗi enrich: ${String(page.enrich_error).slice(0, 120)}`,
    });
  }

  if (!enrichFresh) {
    tips.push({
      level: "info",
      code: "STALE_DATA",
      text: "Dữ liệu page cũ — nên Làm mới để insights/followers chính xác.",
    });
  }

  // Posting health
  if (stats.fail_7d > 0 && stats.fail_7d >= stats.ok_7d) {
    score -= 12;
    tips.push({
      level: "danger",
      code: "HIGH_FAIL_RATE",
      text: `7 ngày: ${stats.fail_7d} lỗi / ${stats.ok_7d} OK — kiểm tra token, media, anti-spam.`,
    });
  } else if (stats.fail_7d > 0) {
    score -= 4;
    tips.push({
      level: "warn",
      code: "SOME_FAILS",
      text: `${stats.fail_7d} lần đăng lỗi trong 7 ngày — xem log chi tiết.`,
    });
  }

  if (stats.posts_7d === 0) {
    score -= 6;
    tips.push({
      level: "warn",
      code: "NO_POSTS_7D",
      text: "7 ngày chưa có log đăng từ tool — bật cấu hình & lịch nếu page đang vận hành.",
    });
  } else if (stats.posts_7d >= 3 && stats.ok_7d >= stats.fail_7d) {
    score += 8;
    tips.push({
      level: "ok",
      code: "ACTIVE_POSTING",
      text: `Đang đăng ổn: ${stats.ok_7d} OK / ${stats.posts_7d} job (7 ngày).`,
    });
  }

  // Story / link suggestion
  if (followers >= 500) {
    tips.push({
      level: "ok",
      code: "STORY_COMBO",
      text: "Nên dùng Story combo (media + feed link) theo khung giờ peak để tăng reach + click.",
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let grade = "D";
  let grade_label = "Yếu — cần cải thiện";
  if (score >= 85) {
    grade = "A";
    grade_label = "Rất tốt — ưu tiên scale";
  } else if (score >= 70) {
    grade = "B";
    grade_label = "Tốt — duy trì & tối ưu";
  } else if (score >= 55) {
    grade = "C";
    grade_label = "Trung bình — cần chăm";
  }

  // Top recommendations (prioritize danger > warn > actionable)
  const order = { danger: 0, warn: 1, info: 2, ok: 3 };
  const recommendations = [...tips].sort(
    (a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9)
  );

  return {
    score,
    grade,
    grade_label,
    followers,
    growth_7d: growth,
    post_stats: stats,
    flags: {
      verified,
      has_picture: hasPic,
      has_about: hasAbout,
      insights_ok: insightsOk,
      enrich_fresh: enrichFresh,
    },
    recommendations,
    top_action: recommendations.find((r) => r.level === "danger" || r.level === "warn")
      || recommendations[0]
      || null,
  };
}

/**
 * Attach quality to a list of pages (batch post_stats query).
 */
export function attachQualityToPages(pages) {
  const ids = pages.map((p) => p.id).filter(Boolean);
  const statsMap = new Map();
  if (ids.length) {
    const db = getDb();
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT page_row_id AS id,
           COUNT(*) AS total,
           SUM(CASE WHEN status IN ('success','ok','published') THEN 1 ELSE 0 END) AS ok_n,
           SUM(CASE WHEN status IN ('error','failed') THEN 1 ELSE 0 END) AS fail_n,
           MAX(created_at) AS last_at
         FROM post_logs
         WHERE page_row_id IN (${placeholders})
           AND created_at >= datetime('now', '-7 days')
         GROUP BY page_row_id`
      )
      .all(...ids);
    for (const r of rows) {
      statsMap.set(r.id, {
        posts_7d: Number(r.total || 0),
        ok_7d: Number(r.ok_n || 0),
        fail_7d: Number(r.fail_n || 0),
        last_post_at: r.last_at || null,
      });
    }
  }
  return pages.map((p) => {
    const st = statsMap.get(p.id) || {
      posts_7d: 0,
      ok_7d: 0,
      fail_7d: 0,
      last_post_at: null,
    };
    const quality = assessPageQuality(p, st);
    return { ...p, quality };
  });
}

/** Portfolio-level suggestions */
export function portfolioRecommendations(pagesWithQuality) {
  const list = pagesWithQuality || [];
  const out = [];
  const low = list.filter((p) => (p.quality?.score ?? 0) < 55);
  const neg = list.filter((p) => (p.quality?.growth_7d?.absolute ?? 0) < 0);
  const noPost = list.filter((p) => (p.quality?.post_stats?.posts_7d ?? 0) === 0);
  const best = [...list].sort((a, b) => (b.quality?.score || 0) - (a.quality?.score || 0)).slice(0, 5);
  const worst = [...list].sort((a, b) => (a.quality?.score || 0) - (b.quality?.score || 0)).slice(0, 5);

  if (low.length) {
    out.push({
      level: "warn",
      text: `${low.length} page điểm thấp (C/D) — ưu tiên avatar/about/insights và giảm fail đăng.`,
    });
  }
  if (neg.length) {
    out.push({
      level: "danger",
      text: `${neg.length} page followers giảm 7 ngày — rà nội dung và tần suất.`,
    });
  }
  if (noPost.length && list.length) {
    out.push({
      level: "info",
      text: `${noPost.length}/${list.length} page chưa có log đăng 7 ngày từ tool.`,
    });
  }
  if (best.length) {
    out.push({
      level: "ok",
      text: `Page đề xuất scale: ${best.map((p) => p.name).filter(Boolean).slice(0, 3).join(", ")}.`,
      page_ids: best.map((p) => p.id),
    });
  }
  if (worst.length && worst[0]?.quality?.score < 70) {
    out.push({
      level: "warn",
      text: `Page cần chăm trước: ${worst.map((p) => p.name).filter(Boolean).slice(0, 3).join(", ")}.`,
      page_ids: worst.map((p) => p.id),
    });
  }
  return { tips: out, best_pages: best, worst_pages: worst };
}
