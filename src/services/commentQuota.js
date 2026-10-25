/**
 * Quota comment-link: **mỗi page / mỗi ngày** tối đa N bài được comment
 * (mỗi bài 1 comment + 1 link random).
 * N = 0 / trống → mọi bài (page bật comment) đều comment như cũ.
 *
 * VD: 10 page × 4 bài/ngày, N=1 → mỗi page random 1/4 bài → ~10 comment/ngày.
 */
import { getPagePostConfig } from "./poster.js";

function vnDayFromDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Lấy ngày VN của slot (hẹn FB unix / run_at ISO). */
export function slotPlanDay(item) {
  const opts = item?.opts || {};
  const unix = Number(
    opts.scheduled_publish_time || item?.unix || item?.scheduled_publish_time
  );
  if (Number.isFinite(unix) && unix > 1e9) {
    return vnDayFromDate(new Date(unix * 1000));
  }
  if (Number.isFinite(unix) && unix > 1e12) {
    return vnDayFromDate(new Date(unix));
  }
  const iso = opts.run_at || item?.run_at || item?.iso || null;
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return vnDayFromDate(d);
  }
  return vnDayFromDate(new Date());
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * @param {Array<{ page_row_id?: number, pageRowId?: number, opts?: object }>} slotsOrTasks
 * @param {number|string|null|undefined} quotaPerPagePerDay
 */
export function applyCommentLinkQuota(slotsOrTasks, quotaPerPagePerDay) {
  const items = Array.isArray(slotsOrTasks) ? slotsOrTasks : [];
  const raw =
    quotaPerPagePerDay == null || quotaPerPagePerDay === ""
      ? 0
      : Number(quotaPerPagePerDay);
  const quota = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;

  /** @type {number[]} */
  const eligibleIdx = [];
  for (let i = 0; i < items.length; i++) {
    const id = Number(items[i].page_row_id || items[i].pageRowId) || 0;
    if (!id) {
      items[i].opts = { ...(items[i].opts || {}), comment_skip: true };
      continue;
    }
    let enabled = false;
    try {
      enabled = !!getPagePostConfig(id)?.comment_enabled;
    } catch {
      enabled = false;
    }
    if (enabled) eligibleIdx.push(i);
    else items[i].opts = { ...(items[i].opts || {}), comment_skip: true };
  }

  if (!quota) {
    for (const i of eligibleIdx) {
      items[i].opts = { ...(items[i].opts || {}), comment_skip: false };
    }
    return {
      items,
      eligible: eligibleIdx.length,
      selected: eligibleIdx.length,
      warn: null,
      quota: 0,
      mode: "all",
    };
  }

  // Group eligible by page + VN day
  /** @type {Map<string, number[]>} */
  const groups = new Map();
  for (const i of eligibleIdx) {
    const pageId = Number(items[i].page_row_id || items[i].pageRowId);
    const day = slotPlanDay(items[i]);
    const key = `${pageId}|${day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }

  const chosen = new Set();
  const warnParts = [];
  let selected = 0;

  for (const [key, idxs] of groups.entries()) {
    const [, day] = key.split("|");
    let take = quota;
    if (quota > idxs.length) {
      warnParts.push(
        `page ngày ${day}: cài ${quota} nhưng chỉ ${idxs.length} bài → dùng ${idxs.length}`
      );
      take = idxs.length;
    }
    const shuffled = shuffleInPlace([...idxs]);
    for (const i of shuffled.slice(0, take)) {
      chosen.add(i);
      selected += 1;
    }
  }

  for (const i of eligibleIdx) {
    items[i].opts = {
      ...(items[i].opts || {}),
      comment_skip: !chosen.has(i),
    };
  }

  let warn = null;
  if (warnParts.length) {
    const head = warnParts.slice(0, 3).join("; ");
    const more =
      warnParts.length > 3 ? ` … +${warnParts.length - 3} page/ngày` : "";
    warn = `Comment link / page / ngày: ${head}${more}`;
  }

  return {
    items,
    eligible: eligibleIdx.length,
    selected,
    warn,
    quota,
    mode: "per_page_per_day",
    groups: groups.size,
  };
}
