/**
 * Shared posting policy — one source of truth for:
 *   - Page config: max_posts_per_day, interval_minutes, preferred_hours
 *   - Anti-spam: floors, cooldown, global caps, enabled master
 *
 * Used by FB schedule bulk, local auto-scheduler, and (hints) Direct Local.
 * Avoids contradictions: bulk ignoring page max, scheduler posting outside hours, etc.
 */
import { getDb } from "../db/index.js";
import { getAntiSpamSettings, clampPageLimits } from "./antiSpam.js";
import {
  getPreferredHours,
  DEFAULT_PREFERRED_HOURS,
} from "./activeTimes.js";

/** Lightweight page config read (avoid circular import with poster.js). */
function readPageConfigLite(pageRowId) {
  const row = getDb()
    .prepare(
      `SELECT page_row_id, enabled, max_posts_per_day, interval_minutes, last_post_at,
              posts_today, posts_today_date
       FROM page_post_config WHERE page_row_id = ?`
    )
    .get(pageRowId);
  if (!row) {
    return {
      page_row_id: pageRowId,
      enabled: 0,
      max_posts_per_day: 3,
      interval_minutes: 120,
      last_post_at: null,
      posts_today: 0,
      posts_today_date: null,
    };
  }
  return row;
}

/** Statuses that count as "will consume / did consume" a slot for the page. */
export const EFFECTIVE_POST_STATUSES = [
  "ok",
  "ok_comment_failed",
  "scheduled",
  "published",
  "schedule_overdue",
];

const EFFECTIVE_TIME_SQL = `COALESCE(NULLIF(scheduled_publish_time, ''), created_at)`;

export function todayYmd(tzOffsetMin = 420) {
  const ms = Date.now() + Number(tzOffsetMin) * 60 * 1000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Local calendar date (YYYY-MM-DD) for a Date under fixed offset minutes.
 */
export function localYmdOf(date, tzOffsetMin = 420) {
  const ms = (date instanceof Date ? date.getTime() : Number(date)) +
    Number(tzOffsetMin) * 60 * 1000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Count posts that already take a slot for this page on a local day.
 * Includes FB scheduled + direct publish (effective time = scheduled_publish_time or created_at).
 */
export function countPagePostsOnLocalDay(pageRowId, dayYmd, tzOffsetMin = 420) {
  const id = Number(pageRowId);
  if (!id || !dayYmd) return 0;
  const offMin = Number(tzOffsetMin);
  const offsetHours = Number.isFinite(offMin) ? offMin / 60 : 7;
  // SQLite modifier: '+7 hours' style
  const sign = offsetHours >= 0 ? "+" : "-";
  const absH = Math.abs(offsetHours);
  const mod =
    Number.isInteger(absH) && absH === Math.floor(absH)
      ? `${sign}${absH} hours`
      : `${sign}${Math.round(absH * 60)} minutes`;

  const placeholders = EFFECTIVE_POST_STATUSES.map(() => "?").join(",");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM post_logs
       WHERE page_row_id = ?
         AND status IN (${placeholders})
         AND date(${EFFECTIVE_TIME_SQL}, ?) = ?`
    )
    .get(id, ...EFFECTIVE_POST_STATUSES, mod, dayYmd);
  return row?.n || 0;
}

/**
 * Min gap (minutes) between two posts of the same page.
 * Direct + schedule + anti must agree:
 *   max(page.interval, anti.floor, anti.cooldown) when anti ON
 *   max(page.interval, softFloor) when anti OFF
 */
export function resolveMinGapMinutes(cfg, anti = null) {
  const s = anti || getAntiSpamSettings();
  const pageInterval = Math.max(0, Number(cfg?.interval_minutes) || 0);
  if (!s.enabled) {
    // Soft floor so bulk still spaces a bit even with anti OFF
    return Math.max(pageInterval, 30);
  }
  const floor = Math.max(0, Number(s.min_interval_minutes_floor) || 0);
  const cooldown = Math.max(0, Number(s.page_cooldown_minutes) || 0);
  // Cooldown is ±window; consecutive slots need gap >= cooldown to pass assertCanPublish
  return Math.max(pageInterval, floor, cooldown);
}

/**
 * Max posts/day for planning (page config, optionally clamped by anti cap).
 * @param {object} cfg page config
 * @param {object|null} anti
 * @param {number|null} requested optional request (bulk form / rotation rounds)
 * @param {{ ignorePageCap?: boolean }} opts
 */
export function resolveMaxPostsPerDay(cfg, anti = null, requested = null, opts = {}) {
  const s = anti || getAntiSpamSettings();
  const pageMax = Math.max(1, Math.min(50, Number(cfg?.max_posts_per_day) || 3));
  let antiCap = 50;
  if (s.enabled && Number(s.min_max_posts_per_day_cap) > 0) {
    // min_max_posts_per_day_cap is an UPPER clamp applied by clampPageLimits too
    antiCap = Number(s.min_max_posts_per_day_cap);
  }
  const hard = opts.ignorePageCap ? 50 : Math.min(pageMax, antiCap);
  if (requested == null || requested === "" || Number.isNaN(Number(requested))) {
    return Math.max(1, hard);
  }
  const want = Math.max(1, Math.min(50, Number(requested)));
  return Math.max(1, Math.min(want, hard));
}

/**
 * Preferred hours for a page (saved or tool default — never invent Meta insights).
 */
export function resolvePreferredHours(pageRowId) {
  const saved = getPreferredHours(pageRowId);
  if (saved.length) {
    return { hours: saved, source: "preferred", seeded: false };
  }
  return {
    hours: [...DEFAULT_PREFERRED_HOURS],
    source: "default",
    seeded: false,
  };
}

/**
 * Full policy snapshot for one page (planning + UI).
 */
export function resolvePagePostingPolicy(pageRowId, opts = {}) {
  const tz = Number.isFinite(Number(opts.tzOffsetMinutes))
    ? Number(opts.tzOffsetMinutes)
    : 420;
  const anti = getAntiSpamSettings();
  const cfg = clampPageLimits(readPageConfigLite(pageRowId));
  const pref = resolvePreferredHours(pageRowId);
  const today = todayYmd(tz);
  const usedToday = countPagePostsOnLocalDay(pageRowId, today, tz);
  const maxPerDay = resolveMaxPostsPerDay(
    cfg,
    anti,
    opts.postsPerDay ?? null,
    { ignorePageCap: !!opts.ignorePageCap }
  );
  const remainingToday = Math.max(0, maxPerDay - usedToday);
  const minGap = resolveMinGapMinutes(cfg, anti);

  return {
    page_row_id: pageRowId,
    enabled: !!cfg.enabled,
    interval_minutes: Number(cfg.interval_minutes) || 0,
    max_posts_per_day: Number(cfg.max_posts_per_day) || 3,
    max_posts_per_day_effective: maxPerDay,
    preferred_hours: pref.hours,
    preferred_source: pref.source,
    min_gap_minutes: minGap,
    anti_spam_enabled: !!anti.enabled,
    used_today: usedToday,
    remaining_today: remainingToday,
    today_ymd: today,
    tz_offset_minutes: tz,
    last_post_at: cfg.last_post_at || null,
    notes: buildPolicyNotes(cfg, anti, minGap, maxPerDay, remainingToday),
  };
}

function buildPolicyNotes(cfg, anti, minGap, maxPerDay, remainingToday) {
  const notes = [];
  notes.push(
    `Áp dụng chung: max ${maxPerDay} bài/ngày · gap ≥ ${minGap}p · (cấu hình page + anti${anti.enabled ? " ON" : " OFF"}).`
  );
  if (remainingToday < maxPerDay) {
    notes.push(`Hôm nay còn ${remainingToday}/${maxPerDay} slot (đã tính cả hẹn FB + đăng trực tiếp).`);
  }
  if (anti.enabled && Number(cfg.interval_minutes) < minGap) {
    notes.push(
      `Interval page ${cfg.interval_minutes}p < gap hiệu lực ${minGap}p (floor/cooldown anti) — dùng ${minGap}p.`
    );
  }
  return notes;
}

/**
 * True if "now" is inside a preferred-hour window (for local auto-scheduler).
 * Window: [hour:00 - graceBefore, hour:00 + graceAfter] local.
 * No preferred hours / empty → always true (user never set → don't block).
 */
export function isWithinPreferredWindow(opts = {}) {
  const hours = (opts.hours || [])
    .map(Number)
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  if (!hours.length) return { ok: true, reason: "no_preferred_hours" };

  const tz = Number.isFinite(Number(opts.tzOffsetMinutes))
    ? Number(opts.tzOffsetMinutes)
    : 420;
  const gb = Number(opts.graceBeforeMin);
  const ga = Number(opts.graceAfterMin);
  const graceBefore = Math.max(0, Number.isFinite(gb) ? gb : 10);
  const graceAfter = Math.max(0, Number.isFinite(ga) ? ga : 50);
  const now = opts.nowMs != null ? Number(opts.nowMs) : Date.now();
  const local = new Date(now + tz * 60 * 1000);
  const localMin = local.getUTCHours() * 60 + local.getUTCMinutes();

  for (const h of hours) {
    const center = h * 60;
    const start = center - graceBefore;
    const end = center + graceAfter;
    if (localMin >= start && localMin <= end) {
      return { ok: true, hour: h, local_minutes: localMin };
    }
  }
  return {
    ok: false,
    reason: "outside_preferred_hours",
    local_minutes: localMin,
    hours,
  };
}

/**
 * Cap planned Date slots by max posts per local day + remaining for "today".
 * @param {Date[]} slots
 * @param {{ maxPerDay: number, remainingToday: number, todayYmd: string, tzOffsetMinutes: number }} policy
 */
export function capSlotsByDailyQuota(slots, policy) {
  const tz = policy.tzOffsetMinutes ?? 420;
  const maxPerDay = Math.max(1, Number(policy.maxPerDay) || 3);
  const remainingToday = Math.max(0, Number(policy.remainingToday) ?? maxPerDay);
  const today = policy.todayYmd || todayYmd(tz);

  const sorted = [...(slots || [])].sort((a, b) => a.getTime() - b.getTime());
  const usedPerDay = new Map();
  const out = [];
  let trimmed = 0;

  for (const d of sorted) {
    const day = localYmdOf(d, tz);
    const limit = day === today ? remainingToday : maxPerDay;
    const used = usedPerDay.get(day) || 0;
    if (used >= limit) {
      trimmed += 1;
      continue;
    }
    usedPerDay.set(day, used + 1);
    out.push(d);
  }

  return { slots: out, trimmed, used_per_day: Object.fromEntries(usedPerDay) };
}

/**
 * Build Direct-Local / rotation-style windows from preferred hours.
 * Each hour → a 1h window with 1 post (unless postsPerDay samples subset).
 */
export function preferredHoursToWindows(hours, postsPerDay = null) {
  let list = [
    ...new Set(
      (hours || [])
        .map(Number)
        .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    ),
  ].sort((a, b) => a - b);
  if (!list.length) list = [...DEFAULT_PREFERRED_HOURS];

  const want =
    postsPerDay != null
      ? Math.min(list.length, Math.max(1, Number(postsPerDay) || list.length))
      : list.length;

  if (list.length > want) {
    const picked = [];
    for (let i = 0; i < want; i++) {
      const idx =
        want === 1
          ? Math.floor((list.length - 1) / 2)
          : Math.round((i * (list.length - 1)) / (want - 1));
      picked.push(list[idx]);
    }
    list = [...new Set(picked)].sort((a, b) => a - b);
  }

  const p = (n) => String(n).padStart(2, "0");
  return list.map((h) => ({
    name: `${p(h)}h`,
    start: `${p(h)}:00`,
    end: `${p(h)}:55`,
    posts: 1,
  }));
}
