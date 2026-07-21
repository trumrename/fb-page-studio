/**
 * Rotation campaign planner
 * ----------------------
 * Order (sequential API / schedule calls):
 *   for pageIndex 0..max:
 *     for adminIndex 0..max:
 *       for group in groups (so le App1/App2…):
 *         if that admin has that page → enqueue 1 slot (or skip)
 * Short group/admin without page → skip; longer continues alone.
 *
 * Same page + same admin: times spaced by gap range inside windows.
 * Different admin / different group: no extra wait (job runner ~350ms).
 *
 * Multi Meta App is supported in one process; each account keeps its
 * meta_app_key and uses the matching OAuth credentials/token.
 */
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { getDb } from "../db/index.js";
import {
  enforceBulkLimits,
  getAntiSpamSettings,
  countEffectivePostsBetween,
  countUnusedMedia,
} from "./antiSpam.js";
import { listMetaAppsPublic } from "./metaApps.js";
import { getPagePostConfig, getCaptionStats } from "./poster.js";
import { captionPoolIdentity } from "./captionPoolState.js";

const SETTINGS_FILE = () =>
  path.join(config.dataDir || path.dirname(config.databasePath), "rotation_settings.json");

export const DEFAULT_ROTATION = {
  /** @type {{ id: string, name: string, account_ids: number[] }[]} */
  groups: [],
  /**
   * empty groups + auto_groups_by_meta_app:
   *   → Nhóm theo meta_app_key (App1 / App2) — đúng ý 1 app = 1 nhóm tài khoản
   * empty groups + auto false → 1 nhóm tất cả
   */
  auto_groups_by_meta_app: true,
  /** per_app | interleave_apps */
  app_rotation_mode: "interleave_apps",
  between_tasks_gap_minutes_min: 15,
  between_tasks_gap_minutes_max: 25,
  posts_per_page_per_day: 2,
  days_ahead: 1,
  /** windows mode: distribute posts into named ranges */
  mode: "windows", // windows | fixed_gap
  windows: [
    { name: "Sáng", start: "07:30", end: "11:30", posts: 1 },
    { name: "Tối", start: "18:00", end: "21:30", posts: 1 },
  ],
  fixed_gap: {
    first_start: "08:00",
    first_end: "10:00",
    gap_hours_min: 2,
    gap_hours_max: 2.5,
  },
  /** same page same admin — min/max hours between consecutive posts */
  same_page_gap_hours_min: 1.75,
  same_page_gap_hours_max: 2.5,
  /** extra random minutes on each planned time */
  jitter_minutes_min: 3,
  jitter_minutes_max: 35,
  /** tiny stagger between so-le slots so clocks aren't identical (seconds) */
  interleave_stagger_sec_min: 15,
  interleave_stagger_sec_max: 90,
  tz_offset_minutes: 420,
  post_type: "auto",
  /**
   * selected = chỉ page đã tick (page_row_ids bắt buộc)
   * all = mọi page active (bỏ qua tick; page_row_ids = [])
   * Mutual exclusive — không được vừa “tất cả” vừa “một phần tick” mơ hồ.
   */
  page_target_mode: "selected",
  /**
   * Direct Local time:
   * gap_chain = bài #1 now, các bài sau + gap (cũ)
   * windows = dùng khung Sáng/Tối (rot windows) trong ngày
   */
  run_now_time_mode: "gap_chain",
  /**
   * fixed = post_type cố định (photo|video|text)
   * page_sequence = sequence từng page (post_type auto cũ)
   * pattern = pattern chung: photo,video hoặc photo,video,video,photo
   */
  media_pattern_mode: "page_sequence",
  /** e.g. "photo,video" or "photo,video,video,photo" */
  media_pattern: "photo,video",
  /** only include enabled page configs if true */
  only_enabled_pages: false,
  /** account_ids filter (empty = all) when groups empty */
  account_ids: [],
  page_row_ids: [], // empty = all pages when page_target_mode=all
};

/** @param {string} raw */
export function parseMediaPattern(raw) {
  const allowed = new Set(["photo", "video", "text"]);
  return String(raw || "")
    .split(/[,|;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => allowed.has(s));
}

/**
 * Resolve post type for round index (0-based) for one page config.
 */
export function resolvePlannedPostType(settings, cfg, roundIndex = 0) {
  const mode =
    settings.media_pattern_mode ||
    (settings.post_type && settings.post_type !== "auto" ? "fixed" : "page_sequence");
  const round = Math.max(0, Number(roundIndex) || 0);

  if (mode === "pattern") {
    const pat = parseMediaPattern(settings.media_pattern);
    if (pat.length) return pat[round % pat.length];
  }
  if (mode === "fixed") {
    const t = String(settings.post_type || "photo").toLowerCase();
    if (t && t !== "auto") return t;
  }
  const sequence =
    Array.isArray(cfg?.sequence) && cfg.sequence.length
      ? cfg.sequence.map((x) => String(x).toLowerCase())
      : ["photo", "text"];
  const base = Math.max(0, Number(cfg?.next_slot_index) || 0);
  return String(sequence[(base + round) % sequence.length] || "photo").toLowerCase();
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function randBetween(min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a || 0;
  if (b <= a) return a;
  return a + Math.random() * (b - a);
}

function parseHm(hm) {
  const m = String(hm || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Local wall time → UTC Date using fixed offset minutes (VN=420) */
function localMinutesToUtcDate(dayYmd, minutesFromMidnight, tzOffsetMin) {
  const [y, mo, d] = dayYmd.split("-").map(Number);
  // UTC = local - offset
  const utcMs =
    Date.UTC(y, mo - 1, d, 0, 0, 0) +
    minutesFromMidnight * 60 * 1000 -
    tzOffsetMin * 60 * 1000;
  return new Date(utcMs);
}

function todayYmd(tzOffsetMin) {
  const ms = Date.now() + tzOffsetMin * 60 * 1000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function formatLocal(date, tzOffsetMin) {
  const ms = date.getTime() + tzOffsetMin * 60 * 1000;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function loadRotationSettings() {
  try {
    const f = SETTINGS_FILE();
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, "utf8"));
      return normalizeSettings({ ...DEFAULT_ROTATION, ...raw });
    }
  } catch (e) {
    console.warn("[rotation] load settings:", e.message);
  }
  return normalizeSettings({ ...DEFAULT_ROTATION });
}

export function saveRotationSettings(partial) {
  const next = normalizeSettings({ ...loadRotationSettings(), ...partial });
  const f = SETTINGS_FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function normalizeSettings(s) {
  const out = { ...DEFAULT_ROTATION, ...s };
  out.posts_per_page_per_day = clamp(Number(out.posts_per_page_per_day) || 2, 1, 12);
  out.days_ahead = clamp(Number(out.days_ahead) || 1, 1, 14);
  out.tz_offset_minutes = Number.isFinite(Number(out.tz_offset_minutes))
    ? Number(out.tz_offset_minutes)
    : 420;
  out.same_page_gap_hours_min = clamp(Number(out.same_page_gap_hours_min) || 1.5, 0.25, 24);
  out.same_page_gap_hours_max = clamp(
    Number(out.same_page_gap_hours_max) || out.same_page_gap_hours_min,
    out.same_page_gap_hours_min,
    48
  );
  out.jitter_minutes_min = clamp(Number(out.jitter_minutes_min) || 0, 0, 180);
  out.jitter_minutes_max = clamp(
    Number(out.jitter_minutes_max) || out.jitter_minutes_min,
    out.jitter_minutes_min,
    240
  );
  out.interleave_stagger_sec_min = clamp(Number(out.interleave_stagger_sec_min) || 0, 0, 600);
  out.interleave_stagger_sec_max = clamp(
    Number(out.interleave_stagger_sec_max) || out.interleave_stagger_sec_min,
    out.interleave_stagger_sec_min,
    900
  );
  out.mode = out.mode === "fixed_gap" ? "fixed_gap" : "windows";
  out.only_enabled_pages = !!out.only_enabled_pages;
  out.auto_groups_by_meta_app =
    out.auto_groups_by_meta_app === undefined
      ? true
      : !!out.auto_groups_by_meta_app;
  out.app_rotation_mode = out.app_rotation_mode === "per_app" ? "per_app" : "interleave_apps";
  out.between_tasks_gap_minutes_min = clamp(Number(out.between_tasks_gap_minutes_min) || 15, 12, 1440);
  out.between_tasks_gap_minutes_max = clamp(
    Number(out.between_tasks_gap_minutes_max) || out.between_tasks_gap_minutes_min,
    out.between_tasks_gap_minutes_min,
    2880
  );
  out.post_type = out.post_type || "auto";
  out.page_target_mode = out.page_target_mode === "all" ? "all" : "selected";
  out.run_now_time_mode = out.run_now_time_mode === "windows" ? "windows" : "gap_chain";
  const mpm = String(out.media_pattern_mode || "").toLowerCase();
  if (mpm === "fixed" || mpm === "pattern" || mpm === "page_sequence") {
    out.media_pattern_mode = mpm;
  } else if (out.post_type && out.post_type !== "auto") {
    out.media_pattern_mode = "fixed";
  } else {
    out.media_pattern_mode = "page_sequence";
  }
  const pat = parseMediaPattern(out.media_pattern);
  out.media_pattern = pat.length ? pat.join(",") : "photo,video";
  out.account_ids = Array.isArray(out.account_ids)
    ? out.account_ids.map(Number).filter((n) => n > 0)
    : [];
  out.page_row_ids = Array.isArray(out.page_row_ids)
    ? out.page_row_ids.map(Number).filter((n) => n > 0)
    : [];
  // Mutual exclusive page scope
  if (out.page_target_mode === "all") {
    out.page_row_ids = [];
  }

  if (Array.isArray(out.windows) && out.windows.length) {
    const rawWindows = out.windows;
    out.windows = rawWindows.map((w) => ({
      name: String(w?.name || "Khung").trim() || "Khung",
      start: String(w?.start || "").trim(),
      end: String(w?.end || "").trim(),
      posts: Number(w?.posts),
    }));
    if (out.mode === "windows") {
      const invalid = out.windows.find(
        (w) =>
          parseHm(w.start) == null ||
          parseHm(w.end) == null ||
          !Number.isInteger(w.posts) ||
          w.posts < 1 ||
          w.posts > 12
      );
      if (invalid) {
        throw new Error(
          `Khung giờ không hợp lệ: ${invalid.name} | ${invalid.start} | ${invalid.end} | ${invalid.posts}. ` +
            "Mỗi dòng cần giờ HH:mm và số bài nguyên từ 1 đến 12."
        );
      }
    } else {
      out.windows = out.windows.filter(
        (w) => parseHm(w.start) != null && parseHm(w.end) != null && Number.isFinite(w.posts)
      );
    }
  } else {
    if (out.mode === "windows") {
      throw new Error("Chế độ khung giờ cần ít nhất một dòng: tên | HH:mm | HH:mm | số bài.");
    }
    out.windows = DEFAULT_ROTATION.windows.map((w) => ({ ...w }));
  }

  // Facebook-window mode has one authoritative count: the sum of its rows.
  // Direct-local mode supplies its own count separately in buildRunNowPlan().
  if (out.mode === "windows") {
    const sum = out.windows.reduce((n, w) => n + (w.posts || 0), 0);
    if (sum < 1) throw new Error("Tổng số bài trong các khung giờ phải lớn hơn 0.");
    out.posts_per_page_per_day = sum;
  }

  out.fixed_gap = {
    first_start: out.fixed_gap?.first_start || "08:00",
    first_end: out.fixed_gap?.first_end || "10:00",
    gap_hours_min: clamp(Number(out.fixed_gap?.gap_hours_min) || 2, 0.25, 24),
    gap_hours_max: clamp(
      Number(out.fixed_gap?.gap_hours_max) || 2.5,
      Number(out.fixed_gap?.gap_hours_min) || 2,
      48
    ),
  };

  if (Array.isArray(out.groups)) {
    out.groups = out.groups
      .map((g, i) => ({
        id: String(g.id || `g${i + 1}`),
        name: String(g.name || `Nhóm ${i + 1}`),
        account_ids: Array.isArray(g.account_ids)
          ? g.account_ids.map(Number).filter((n) => n > 0)
          : [],
      }))
      .filter((g) => g.account_ids.length);
  } else {
    out.groups = [];
  }

  return out;
}

/**
 * Load accounts + pages matrix from DB.
 */
export function loadAccountPageMatrix(settings) {
  const db = getDb();
  const appNames = new Map(listMetaAppsPublic().map((a) => [a.key, a.name]));
  let accounts = db
    .prepare(
      `SELECT id, name, fb_user_id, page_count, status, meta_app_key, meta_app_id
       FROM fb_accounts
       WHERE status != 'deleted'
       ORDER BY meta_app_key, id`
    )
    .all();

  if (settings.account_ids?.length) {
    const set = new Set(settings.account_ids);
    accounts = accounts.filter((a) => set.has(a.id));
  }

  const pageFilter = settings.page_row_ids?.length
    ? new Set(settings.page_row_ids)
    : null;

  return accounts.map((a) => {
    let pages = db
      .prepare(
        `SELECT p.id, p.page_id, p.name, p.account_id, c.enabled
         FROM fb_pages p
         LEFT JOIN page_post_config c ON c.page_row_id = p.id
         WHERE p.account_id = ? AND p.status = 'active'
         ORDER BY p.name COLLATE NOCASE`
      )
      .all(a.id);

    if (pageFilter) pages = pages.filter((p) => pageFilter.has(p.id));
    if (settings.only_enabled_pages) {
      pages = pages.filter((p) => p.enabled);
    }

    const metaKey = a.meta_app_key || "app1";
    return {
      account_id: a.id,
      account_name: a.name || `Admin#${a.id}`,
      fb_user_id: a.fb_user_id,
      meta_app_key: metaKey,
      meta_app_id: a.meta_app_id || null,
      meta_app_name:
        appNames.get(metaKey) || (metaKey === "app2" ? "App 2" : metaKey === "app1" ? "App 1" : metaKey),
      pages: pages.map((p, idx) => ({
        page_row_id: p.id,
        page_id: p.page_id,
        page_name: p.name,
        page_index: idx, // 0-based order in this admin
        enabled: !!p.enabled,
      })),
    };
  });
}

/**
 * Resolve groups for so-le.
 * - Manual settings.groups if provided
 * - Else auto by meta_app_key (App1 / App2) when auto_groups_by_meta_app
 * - Else one group all accounts
 */
export function resolveGroups(settings, matrix) {
  const byId = new Map(matrix.map((a) => [a.account_id, a]));
  let groups = settings.groups || [];

  if (!groups.length && settings.auto_groups_by_meta_app !== false) {
    const byApp = new Map();
    for (const a of matrix) {
      const key = a.meta_app_key || "app1";
      if (!byApp.has(key)) {
        byApp.set(key, {
          id: key,
          name: a.meta_app_name || (key === "app2" ? "App 2" : "App 1"),
          account_ids: [],
        });
      }
      byApp.get(key).account_ids.push(a.account_id);
    }
    // Stable order: app1, app2, then others
    const keys = [...byApp.keys()].sort((x, y) => {
      if (x === "app1") return -1;
      if (y === "app1") return 1;
      if (x === "app2") return -1;
      if (y === "app2") return 1;
      return x.localeCompare(y);
    });
    groups = keys.map((k) => byApp.get(k));
  }

  if (!groups.length) {
    groups = [
      {
        id: "all",
        name: "Tất cả admin (1 nhóm)",
        account_ids: matrix.map((a) => a.account_id),
      },
    ];
  }

  return groups.map((g) => {
    const admins = g.account_ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((a) => ({
        account_id: a.account_id,
        account_name: a.account_name,
        meta_app_key: a.meta_app_key,
        pages: a.pages,
      }));
    return {
      id: g.id,
      name: g.name,
      meta_app_key: g.id,
      admins,
      max_pages: Math.max(0, ...admins.map((a) => a.pages.length), 0),
      admin_count: admins.length,
    };
  });
}

/**
 * Plan N post times for one page on one local day.
 * Returns Date[] sorted ascending (UTC instants).
 */
export function planTimesForPageDay(settings, dayYmd) {
  const tz = settings.tz_offset_minutes;
  const gapMinMs = settings.same_page_gap_hours_min * 3600 * 1000;
  const gapMaxMs = settings.same_page_gap_hours_max * 3600 * 1000;
  const times = [];

  if (settings.mode === "fixed_gap") {
    const n = settings.posts_per_page_per_day;
    const fs = parseHm(settings.fixed_gap.first_start);
    const fe = parseHm(settings.fixed_gap.first_end);
    if (fs == null || fe == null) return [];
    const firstMin = randBetween(Math.min(fs, fe), Math.max(fs, fe));
    let t = localMinutesToUtcDate(dayYmd, firstMin, tz).getTime();
    t += randBetween(settings.jitter_minutes_min, settings.jitter_minutes_max) * 60 * 1000;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        t += randBetween(gapMinMs, gapMaxMs);
        t += randBetween(settings.jitter_minutes_min, settings.jitter_minutes_max) * 60 * 1000;
      }
      times.push(new Date(t));
    }
    return times;
  }

  // windows mode
  for (const w of settings.windows) {
    const posts = w.posts || 0;
    if (!posts) continue;
    const a = parseHm(w.start);
    const b = parseHm(w.end);
    if (a == null || b == null || b <= a) continue;
    const span = b - a;
    const windowTimes = [];
    for (let i = 0; i < posts; i++) {
      // spread roughly evenly + random jitter inside window
      const base = a + ((i + 0.5) / posts) * span;
      const jitterMin = randBetween(-span / (posts * 3), span / (posts * 3));
      let mins = clamp(base + jitterMin, a, b - 1);
      mins += randBetween(0, Math.min(settings.jitter_minutes_max, 20)) / 1; // minutes already
      // convert leftover: jitter already in minutes domain partially — keep simple:
      let t = localMinutesToUtcDate(dayYmd, mins, tz).getTime();
      t += randBetween(settings.jitter_minutes_min, settings.jitter_minutes_max) * 60 * 1000;
      // clamp back into window roughly
      const winStart = localMinutesToUtcDate(dayYmd, a, tz).getTime();
      const winEnd = localMinutesToUtcDate(dayYmd, b, tz).getTime();
      t = clamp(t, winStart, winEnd - 60 * 1000);
      windowTimes.push(t);
    }
    windowTimes.sort((x, y) => x - y);
    // enforce same-page gap inside window
    for (let i = 0; i < windowTimes.length; i++) {
      if (i > 0) {
        const need = randBetween(gapMinMs, gapMaxMs);
        if (windowTimes[i] - windowTimes[i - 1] < need) {
          windowTimes[i] = windowTimes[i - 1] + need;
        }
      }
      times.push(new Date(windowTimes[i]));
    }
  }

  times.sort((x, y) => x - y);
  // enforce gap across window boundaries
  for (let i = 1; i < times.length; i++) {
    const need = settings.same_page_gap_hours_min * 3600 * 1000;
    if (times[i].getTime() - times[i - 1].getTime() < need) {
      times[i] = new Date(times[i - 1].getTime() + need);
    }
  }
  return times;
}

/**
 * Build full interleaved plan.
 * Returns { settings, groups_meta, slots: [...], summary }
 */
export function buildRotationPlan(inputSettings = {}) {
  const settings = normalizeSettings({ ...loadRotationSettings(), ...inputSettings });
  const matrix = loadAccountPageMatrix(settings).filter((a) => a.pages.length > 0);
  const groups = resolveGroups(settings, matrix);

  const maxAdmins = Math.max(0, ...groups.map((g) => g.admin_count), 0);
  const maxPages = Math.max(0, ...groups.map((g) => g.max_pages), 0);
  const maxPosts = settings.posts_per_page_per_day;
  const tz = settings.tz_offset_minutes;
  const startDay = todayYmd(tz);

  // Precompute times per page_row_id per dayYmd → Date[]
  const pageTimeMap = new Map(); // key: `${pageRowId}|${dayYmd}` → Date[]
  const allPages = [];
  for (const g of groups) {
    for (const admin of g.admins) {
      for (const p of admin.pages) {
        allPages.push(p);
      }
    }
  }
  // unique pages
  const seen = new Set();
  for (const p of allPages) {
    if (seen.has(p.page_row_id)) continue;
    seen.add(p.page_row_id);
    for (let d = 0; d < settings.days_ahead; d++) {
      const day = addDaysYmd(startDay, d);
      const times = planTimesForPageDay(settings, day);
      pageTimeMap.set(`${p.page_row_id}|${day}`, times);
    }
  }

  /** Order follows app_rotation_mode for both Facebook schedule and Direct Local. */
  const slots = [];
  let order = 0;

  for (let d = 0; d < settings.days_ahead; d++) {
    const day = addDaysYmd(startDay, d);
    for (let postRound = 0; postRound < maxPosts; postRound++) {
      const enqueue = (g, adminIdx, pageIdx) => {
        const admin = g.admins[adminIdx];
        if (!admin) return;
        const page = admin.pages[pageIdx];
        if (!page) return;
        const times = pageTimeMap.get(`${page.page_row_id}|${day}`) || [];
        const when = times[postRound];
        if (!when) return;
        const finalWhen = new Date(
          when.getTime() +
            randBetween(
              settings.interleave_stagger_sec_min,
              settings.interleave_stagger_sec_max
            ) * 1000
        );
        order += 1;
        slots.push({
          order,
          day,
          post_round: postRound + 1,
          page_index: pageIdx + 1,
          group_id: g.id,
          group_name: g.name,
          account_id: admin.account_id,
          account_name: admin.account_name,
          page_row_id: page.page_row_id,
          page_id: page.page_id,
          page_name: page.page_name,
          scheduled_at: finalWhen,
          unix: Math.floor(finalWhen.getTime() / 1000),
          local_label: formatLocal(finalWhen, tz),
        });
      };
      if (settings.app_rotation_mode === "per_app") {
        for (const g of groups) {
          for (let pageIdx = 0; pageIdx < g.max_pages; pageIdx++) {
            for (let adminIdx = 0; adminIdx < g.admin_count; adminIdx++) {
              enqueue(g, adminIdx, pageIdx);
            }
          }
        }
      } else {
        for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
          for (let adminIdx = 0; adminIdx < maxAdmins; adminIdx++) {
            for (const g of groups) enqueue(g, adminIdx, pageIdx);
          }
        }
      }
    }
  }

  // Filter Graph-valid window: 10 min .. 30 days
  // Past slots (e.g. morning window already over) → bump +1 day once
  const now = Date.now();
  const minFuture = now + 10 * 60 * 1000;
  const valid = [];
  const skipped = [];
  for (const s of slots) {
    let t = s.scheduled_at.getTime();
    let bumped = false;
    if (t < minFuture) {
      t += 24 * 60 * 60 * 1000;
      bumped = true;
    }
    if (t < minFuture) {
      skipped.push({ ...s, skip_reason: "quá gần / đã qua (<10 phút)" });
      continue;
    }
    if (t > now + 30 * 24 * 60 * 60 * 1000) {
      skipped.push({ ...s, skip_reason: ">30 ngày" });
      continue;
    }
    if (bumped) {
      s.scheduled_at = new Date(t);
      s.unix = Math.floor(t / 1000);
      s.local_label = formatLocal(s.scheduled_at, tz);
      s.day = addDaysYmd(s.day, 1);
      s.bumped_plus_1d = true;
    }
    valid.push(s);
  }

  // Anti-spam bulk caps: group by page then enforce, keep interleave order
  const byPage = new Map();
  for (const s of valid) {
    if (!byPage.has(s.page_row_id)) {
      byPage.set(s.page_row_id, {
        page_row_id: s.page_row_id,
        page_name: s.page_name,
        slots: [],
      });
    }
    byPage.get(s.page_row_id).slots.push(s.scheduled_at);
  }
  const limited = enforceBulkLimits([...byPage.values()], {});
  const capTotal = limited.caps?.bulk_max_total || 40;
  let finalSlots = valid;
  if (limited.trimmed || valid.length > capTotal) {
    finalSlots = valid.slice(0, capTotal);
  }

  // Re-number order
  finalSlots = finalSlots.map((s, i) => ({ ...s, order: i + 1 }));

  return {
    settings: {
      mode: settings.mode,
      posts_per_page_per_day: settings.posts_per_page_per_day,
      days_ahead: settings.days_ahead,
      windows: settings.windows,
      fixed_gap: settings.fixed_gap,
      same_page_gap_hours_min: settings.same_page_gap_hours_min,
      same_page_gap_hours_max: settings.same_page_gap_hours_max,
      jitter_minutes_min: settings.jitter_minutes_min,
      jitter_minutes_max: settings.jitter_minutes_max,
      tz_offset_minutes: settings.tz_offset_minutes,
      post_type: settings.post_type,
      app_rotation_mode: settings.app_rotation_mode,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        admin_count: g.admin_count,
        max_pages: g.max_pages,
        account_ids: g.admins.map((a) => a.account_id),
      })),
    },
    summary: {
      accounts: matrix.length,
      groups: groups.length,
      max_admins: maxAdmins,
      max_pages: maxPages,
      posts_per_page_per_day: maxPosts,
      days_ahead: settings.days_ahead,
      total_planned: slots.length,
      total_valid: valid.length,
      total_final: finalSlots.length,
      skipped: skipped.length,
      anti_spam_trimmed: !!limited.trimmed,
      anti_spam_caps: limited.caps,
      order_logic: settings.app_rotation_mode === "per_app"
        ? "day → bài# → từng App → pageIndex → toàn bộ admin của App"
        : "day → bài# → pageIndex → adminIndex → group so-le (app ngắn skip)",
      wait_logic:
        "Chỉ gap cùng page+admin trong khung giờ; khác admin/group = API sequential ~350ms, không chờ phút",
      note_meta_app:
        "Một tiến trình hỗ trợ nhiều Meta App; mỗi Profile giữ meta_app_key và được nhóm đúng App 1/App 2.",
    },
    slots: finalSlots.map((s) => ({
      order: s.order,
      day: s.day,
      post_round: s.post_round,
      page_index: s.page_index,
      group_id: s.group_id,
      group_name: s.group_name,
      account_id: s.account_id,
      account_name: s.account_name,
      page_row_id: s.page_row_id,
      page_id: s.page_id,
      page_name: s.page_name,
      unix: s.unix,
      local_label: s.local_label,
      iso: s.scheduled_at.toISOString(),
    })),
    skipped: skipped.slice(0, 30).map((s) => ({
      page_name: s.page_name,
      local_label: s.local_label,
      reason: s.skip_reason,
    })),
    preview_order: finalSlots.slice(0, 24).map((s) => ({
      order: s.order,
      label: `${s.group_name} · ${s.account_name} · P${s.page_index} · bài${s.post_round} · ${s.local_label}`,
    })),
  };
}

/**
 * Plan local direct posting: first task is due now; later tasks wait inside the
 * running tool and publish directly when their local due time arrives.
 * Order per round depends on app_rotation_mode:
 * - per_app: app → page → admin
 * - interleave_apps: page → admin → app
 */
export function buildRunNowPlan(inputSettings = {}) {
  const settings = normalizeSettings({ ...loadRotationSettings(), ...inputSettings });
  if (settings.page_target_mode === "selected" && !settings.page_row_ids.length) {
    throw new Error(
      "Chế độ «Chỉ page đã tick»: hãy tick ít nhất 1 Page ở bước 1, hoặc chọn «Tất cả page»."
    );
  }
  const matrix = loadAccountPageMatrix(settings).filter((a) => a.pages.length > 0);
  if (!matrix.length) {
    throw new Error(
      settings.page_target_mode === "all"
        ? "Không có Page active nào để chạy."
        : "Không có Page đã tick (hoặc Page không active)."
    );
  }
  const groups = resolveGroups(settings, matrix);
  const useWindows = settings.run_now_time_mode === "windows";
  // Windows: số bài/ngày = tổng posts trong khung Sáng/Tối (authoritative).
  // Gap chain: posts_per_page_per_day from Direct Local input.
  let rounds;
  let dayWindowTimes = null;
  const tz = settings.tz_offset_minutes;
  const todayVn = todayYmd(tz);
  if (useWindows) {
    const winSettings = normalizeSettings({
      ...settings,
      mode: "windows",
    });
    const sum = (winSettings.windows || []).reduce((n, w) => n + (Number(w.posts) || 0), 0);
    if (sum < 1) {
      throw new Error(
        "Chế độ khung giờ Direct Local cần ít nhất 1 bài trong các dòng Sáng/Tối (ví dụ Sáng|07:30|11:30|1 và Tối|18:00|21:30|1)."
      );
    }
    rounds = clamp(sum, 1, 12);
    dayWindowTimes = planTimesForPageDay(winSettings, todayVn);
    if (!dayWindowTimes.length) {
      throw new Error("Không lập được giờ trong khung Sáng/Tối — kiểm tra HH:mm start < end.");
    }
  } else {
    rounds = clamp(
      Number(inputSettings.posts_per_page_per_day) || settings.posts_per_page_per_day,
      1,
      12
    );
  }
  const anti = getAntiSpamSettings();
  const pageConfigs = new Map();
  for (const account of matrix) {
    for (const page of account.pages) {
      pageConfigs.set(page.page_row_id, getPagePostConfig(page.page_row_id));
    }
  }
  const maxPageIntervalHours = Math.max(
    0,
    ...[...pageConfigs.values()].map((c) => (Number(c.interval_minutes) || 0) / 60)
  );
  const antiCooldownHours = anti.enabled ? (Number(anti.page_cooldown_minutes) || 0) / 60 : 0;
  const effectiveGapMinHours = Math.max(
    settings.same_page_gap_hours_min,
    maxPageIntervalHours,
    antiCooldownHours,
    0.25
  );
  const effectiveGapMaxHours = Math.max(settings.same_page_gap_hours_max, effectiveGapMinHours);
  const gapMinMs = effectiveGapMinHours * 3600 * 1000;
  const gapMaxMs = effectiveGapMaxHours * 3600 * 1000;
  const maxAdmins = Math.max(0, ...groups.map((g) => g.admin_count), 0);
  const maxPages = Math.max(0, ...groups.map((g) => g.max_pages), 0);
  const taskGapMinMs = settings.between_tasks_gap_minutes_min * 60 * 1000;
  const taskGapMaxMs = settings.between_tasks_gap_minutes_max * 60 * 1000;
  const roundTimes = [];

  const slots = [];
  let order = 0;
  let previousRoundStartMs = null;
  let previousRoundEndMs = null;
  for (let round = 0; round < rounds; round++) {
    let cursorMs;
    if (round === 0) {
      cursorMs = Date.now();
    } else {
      const bySamePageGap = previousRoundStartMs + randBetween(gapMinMs, gapMaxMs);
      const afterPreviousRound = previousRoundEndMs + randBetween(taskGapMinMs, taskGapMaxMs);
      cursorMs = Math.max(bySamePageGap, afterPreviousRound);
    }
    roundTimes.push(new Date(cursorMs));
    previousRoundStartMs = cursorMs;
    let lastSlotMs = cursorMs;
    const enqueue = (g, adminIdx, pageIdx) => {
        const admin = g.admins[adminIdx];
        if (!admin) return;
          const page = admin.pages[pageIdx];
          if (!page) return;
          const cfg = pageConfigs.get(page.page_row_id);
          const postedToday = cfg?.posts_today_date === todayVn
            ? Math.max(0, Number(cfg?.posts_today) || 0)
            : 0;
          const remainingToday = Math.max(
            0,
            (Number(cfg?.max_posts_per_day) || rounds) - postedToday
          );
          const pageRounds = Math.min(rounds, remainingToday);
          if (round >= pageRounds) return;
          const plannedPostType = resolvePlannedPostType(settings, cfg, round);
          let when;
          if (useWindows && dayWindowTimes[round]) {
            // Base = planned window time; never before now; small stagger by order.
            const baseMs = dayWindowTimes[round].getTime();
            const stagger = (order + 1) * 1500;
            when = new Date(Math.max(Date.now() + 2000, baseMs + stagger));
            cursorMs = when.getTime();
          } else {
            when = new Date(cursorMs);
          }
          order += 1;
          slots.push({
            order,
            // Only "immediate" if due within ~5s — windows mode may plan evening later today.
            immediate: when.getTime() <= Date.now() + 5000,
            post_round: round + 1,
            page_index: pageIdx + 1,
            group_id: g.id,
            group_name: g.name,
            account_id: admin.account_id,
            account_name: admin.account_name,
            page_row_id: page.page_row_id,
            page_id: page.page_id,
            page_name: page.page_name,
            planned_post_type: plannedPostType,
            unix: Math.floor(when.getTime() / 1000),
            iso: when.toISOString(),
            local_label: formatLocal(when, tz),
            time_mode: useWindows ? "windows" : "gap_chain",
          });
          lastSlotMs = when.getTime();
          if (!useWindows) {
            cursorMs += randBetween(taskGapMinMs, taskGapMaxMs);
          } else {
            cursorMs = when.getTime() + randBetween(taskGapMinMs * 0.15, taskGapMinMs * 0.35);
          }
    };

    if (settings.app_rotation_mode === "per_app") {
      // App 1: Page 1 across every admin, then Page 2...; then next App.
      for (const g of groups) {
        for (let pageIdx = 0; pageIdx < g.max_pages; pageIdx++) {
          for (let adminIdx = 0; adminIdx < g.admin_count; adminIdx++) {
            enqueue(g, adminIdx, pageIdx);
          }
        }
      }
    } else {
      // Page 1: App1 Admin1, App2 Admin1, App1 Admin2, App2 Admin2... then Page 2.
      for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
        for (let adminIdx = 0; adminIdx < maxAdmins; adminIdx++) {
          for (const g of groups) enqueue(g, adminIdx, pageIdx);
        }
      }
    }
    previousRoundEndMs = lastSlotMs;
  }

  const finalSlots = slots.map((s, i) => ({ ...s, order: i + 1 }));
  const warnings = [];
  const blockers = [];

  if (effectiveGapMinHours > settings.same_page_gap_hours_min) {
    warnings.push(
      `Gap min đã tự nâng từ ${settings.same_page_gap_hours_min}h lên ${effectiveGapMinHours}h để khớp interval/cooldown Page.`
    );
  }
  const limitedPages = [...pageConfigs.entries()]
    .map(([id, c]) => {
      const postedToday = c.posts_today_date === todayVn ? Math.max(0, Number(c.posts_today) || 0) : 0;
      const remaining = Math.max(0, (Number(c.max_posts_per_day) || rounds) - postedToday);
      return { id, postedToday, remaining, max: Number(c.max_posts_per_day) || rounds };
    })
    .filter((x) => x.remaining < rounds)
    .map((x) => `Page#${x.id}: còn ${x.remaining}/${x.max} (đã ${x.postedToday})`);
  if (limitedPages.length) {
    warnings.push(`Một số Page bị giới hạn theo max bài/ngày: ${limitedPages.slice(0, 8).join(", ")}`);
  }

  const startLocalDay = todayYmd(tz);
  const overflowSlots = finalSlots.filter((s) => s.local_label.slice(0, 10) !== startLocalDay);
  if (overflowSlots.length) {
    warnings.push(`Lịch vượt sang ngày kế tiếp từ vòng ${overflowSlots[0].post_round} (${overflowSlots[0].page_name}); ngày/giờ đã hiển thị đầy đủ trong preview.`);
  }

  // Media/caption requirements are aggregated by shared pool. Multiple Pages
  // pointing at one caption folder consume one common sequential pool.
  const mediaNeeds = new Map();
  const captionNeeds = new Map();
  const captionStatsByPool = new Map();
  for (const s of finalSlots) {
    const cfg = pageConfigs.get(s.page_row_id);
    const type = String(s.planned_post_type || "text").toLowerCase();
    const identity = captionPoolIdentity({
      captionsFolder: cfg?.captions_folder,
      captions: cfg?.captions,
      pageRowId: s.page_row_id,
    });
    if (!captionStatsByPool.has(identity.key)) {
      captionStatsByPool.set(identity.key, getCaptionStats(cfg));
    }
    const stats = captionStatsByPool.get(identity.key);
    const captionRequired = type === "text" || Number(stats?.total) > 0;
    if (captionRequired) {
      if (!captionNeeds.has(identity.key)) {
        captionNeeds.set(identity.key, {
          pool_key: identity.key,
          page_names: [],
          folder: cfg?.captions_folder || identity.source,
          required: 0,
          available: Number(stats?.available ?? stats?.total) || 0,
          total: Number(stats?.total) || 0,
          used_recent: Number(stats?.used_recent) || 0,
          duplicate_window_hours: Number(stats?.duplicate_window_hours) || 0,
        });
      }
      const need = captionNeeds.get(identity.key);
      need.required += 1;
      if (!need.page_names.includes(s.page_name)) need.page_names.push(s.page_name);
    }
    if (type === "text" || !["photo", "image", "video"].includes(type)) continue;
    const kind = type === "video" ? "video" : "photo";
    const folder = cfg?.media_folder || "";
    const key = `${path.resolve(folder || ".").toLowerCase()}|${kind}`;
    if (!mediaNeeds.has(key)) mediaNeeds.set(key, { folder, kind, required: 0, available: 0 });
    mediaNeeds.get(key).required += 1;
  }
  for (const need of mediaNeeds.values()) {
    need.available = countUnusedMedia(need.folder, need.kind);
    if (need.available < need.required) {
      blockers.push(`Thiếu ${need.kind}: cần ${need.required}, hiện có ${need.available} trong ${need.folder || "(chưa chọn folder)"}`);
    }
  }
  for (const need of captionNeeds.values()) {
    if (need.available < need.required) {
      blockers.push(
        `Thiếu caption chưa dùng trong kho chung: cần ${need.required}, hiện còn ${need.available}/${need.total} ` +
          `trong ${need.folder || "(chưa chọn folder)"}. Đã note ${need.used_recent} caption ` +
          `trong ${need.duplicate_window_hours || 48}h cho ${need.page_names.length} Page.`
      );
    }
  }

  if (anti.enabled) {
    for (const rt of roundTimes) {
      const end = rt.toISOString();
      const hourStart = new Date(rt.getTime() - 3600 * 1000).toISOString();
      const dayStart = new Date(rt.getTime() - 24 * 3600 * 1000).toISOString();
      const plannedHour = finalSlots.filter((s) => s.unix * 1000 > rt.getTime() - 3600 * 1000 && s.unix * 1000 <= rt.getTime() + 3600 * 1000).length;
      const plannedDay = finalSlots.filter((s) => s.unix * 1000 > rt.getTime() - 24 * 3600 * 1000 && s.unix * 1000 <= rt.getTime()).length;
      const existingHour = countEffectivePostsBetween(hourStart, end);
      const existingDay = countEffectivePostsBetween(dayStart, end);
      if (existingHour + plannedHour > anti.max_posts_per_hour_global) {
        blockers.push(`Vượt anti-spam giờ tại ${formatLocal(rt, tz)}: ${existingHour + plannedHour}/${anti.max_posts_per_hour_global}.`);
        break;
      }
      if (existingDay + plannedDay > anti.max_posts_per_day_global) {
        blockers.push(`Vượt anti-spam 24h tại ${formatLocal(rt, tz)}: ${existingDay + plannedDay}/${anti.max_posts_per_day_global}.`);
        break;
      }
    }
  }
  return {
    settings: {
      posts_per_page_per_day: rounds,
      same_page_gap_hours_min: settings.same_page_gap_hours_min,
      same_page_gap_hours_max: settings.same_page_gap_hours_max,
      effective_gap_hours_min: effectiveGapMinHours,
      effective_gap_hours_max: effectiveGapMaxHours,
      tz_offset_minutes: tz,
      post_type: settings.post_type,
      page_target_mode: settings.page_target_mode,
      run_now_time_mode: settings.run_now_time_mode,
      media_pattern_mode: settings.media_pattern_mode,
      media_pattern: settings.media_pattern,
      windows: settings.windows,
      app_rotation_mode: settings.app_rotation_mode,
      between_tasks_gap_minutes_min: settings.between_tasks_gap_minutes_min,
      between_tasks_gap_minutes_max: settings.between_tasks_gap_minutes_max,
    },
    summary: {
      accounts: matrix.length,
      groups: groups.length,
      posts_per_page_per_day: rounds,
      total_planned: slots.length,
      total_final: finalSlots.length,
      anti_spam_trimmed: false,
      page_scope: settings.page_target_mode === "all" ? "tất cả page active" : "chỉ page đã tick",
      media_logic:
        settings.media_pattern_mode === "pattern"
          ? `pattern xen kẽ: ${settings.media_pattern}`
          : settings.media_pattern_mode === "fixed"
            ? `cố định: ${settings.post_type}`
            : "sequence từng Page",
      order_logic: settings.app_rotation_mode === "per_app"
        ? "vòng bài# → từng App → pageIndex → toàn bộ admin của App"
        : "vòng bài# → pageIndex → adminIndex → App 1/App 2 so le",
      wait_logic: useWindows
        ? `Khung giờ Sáng/Tối trong ngày (VN); task trong cùng khung so le Page/Admin ~${settings.between_tasks_gap_minutes_min}–${settings.between_tasks_gap_minutes_max} phút`
        : `Task đầu đăng ngay; mỗi Page/Admin kế tiếp cách ${settings.between_tasks_gap_minutes_min}–${settings.between_tasks_gap_minutes_max} phút; vòng sau gap cùng Page ${effectiveGapMinHours}–${effectiveGapMaxHours} giờ`,
      timezone: "Asia/Ho_Chi_Minh (UTC+7)",
      can_run: blockers.length === 0,
    },
    round_times: roundTimes.map((d, i) => ({
      post_round: i + 1,
      immediate: i === 0,
      local_label: formatLocal(d, tz),
      iso: d.toISOString(),
    })),
    slots: finalSlots,
    warnings,
    blockers,
    media_requirements: [...mediaNeeds.values()],
    caption_requirements: [...captionNeeds.values()],
    preview_order: finalSlots.map((s) => ({
      order: s.order,
      label: `Vòng ${s.post_round} · ${s.planned_post_type} · ${s.group_name} · ${s.account_name} · ${s.page_name} · ${s.immediate ? "ĐĂNG TRỰC TIẾP NGAY" : "TOOL CHỜ → ĐĂNG TRỰC TIẾP " + s.local_label + " VN"}`,
    })),
  };
}

/**
 * Convert plan slots → jobRunner schedule tasks payload.
 */
export function planToScheduleSlots(plan, postType) {
  const pt = postType && postType !== "auto" ? postType : undefined;
  return (plan.slots || []).map((s) => ({
    page_row_id: s.page_row_id,
    page_name: s.page_name,
    page_id: s.page_id,
    unix: s.unix,
    local_label: `${s.order}. ${s.group_name} · ${s.account_name} · ${s.page_name} · bài${s.post_round} · ${s.local_label}`,
    post_type: pt,
  }));
}
