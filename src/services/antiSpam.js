/**
 * Anti-spam / safety layer — configurable, with safe defaults (recommended).
 * - Media hash: 1 file content = 1 post ever (any page), then move to posted
 * - Caption duplicate window
 * - Global hourly/daily caps
 * - Page cooldown / keyword block
 * - Graph error backoff
 * - Bulk hard limits + jitter
 * - Production lock: ignore_quota / ignore_interval off by default
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "../db/index.js";
import { getLastUsage } from "./rateLimit.js";
import {
  ensureDir,
  moveToPosted,
  listMediaFiles as listMediaFilesSync,
  pickMedia as pickMediaSync,
} from "./mediaLibrary.js";

/** Recommended defaults (safe-ish for multi-page organic) */
export const SAFE_PRESET = {
  enabled: 1,
  max_posts_per_hour_global: 12,
  max_posts_per_day_global: 40,
  block_duplicate_caption: 1,
  caption_dup_window_hours: 48,
  block_duplicate_media: 1,
  media_once_forever: 1,
  page_cooldown_minutes: 90,
  blocked_page_ids_json: "[]",
  blocked_keywords_json: "[]",
  jitter_minutes_min: 3,
  jitter_minutes_max: 18,
  bulk_max_pages: 15,
  bulk_max_slots_per_page: 10,
  bulk_max_total: 40,
  allow_ignore_quota: 0,
  allow_ignore_interval: 0,
  graph_backoff_base_sec: 90,
  graph_backoff_max_sec: 3600,
  pause_on_app_usage_pct: 45,
  min_interval_minutes_floor: 60,
  min_max_posts_per_day_cap: 8,
};

export const LOOSE_PRESET = {
  ...SAFE_PRESET,
  max_posts_per_hour_global: 40,
  max_posts_per_day_global: 150,
  caption_dup_window_hours: 12,
  page_cooldown_minutes: 30,
  jitter_minutes_min: 0,
  jitter_minutes_max: 5,
  bulk_max_pages: 50,
  bulk_max_slots_per_page: 30,
  bulk_max_total: 120,
  allow_ignore_quota: 1,
  allow_ignore_interval: 1,
  pause_on_app_usage_pct: 80,
  min_interval_minutes_floor: 15,
  min_max_posts_per_day_cap: 20,
};

export const STRICT_PRESET = {
  ...SAFE_PRESET,
  max_posts_per_hour_global: 6,
  max_posts_per_day_global: 20,
  caption_dup_window_hours: 168,
  page_cooldown_minutes: 180,
  jitter_minutes_min: 5,
  jitter_minutes_max: 35,
  bulk_max_pages: 8,
  bulk_max_slots_per_page: 5,
  bulk_max_total: 20,
  allow_ignore_quota: 0,
  allow_ignore_interval: 0,
  pause_on_app_usage_pct: 30,
  min_interval_minutes_floor: 120,
  min_max_posts_per_day_cap: 4,
};

function parseJsonArr(s) {
  try {
    const a = JSON.parse(s || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function ensureAntiSpamTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS anti_spam_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_hash_used (
      hash TEXT PRIMARY KEY,
      page_row_id INTEGER,
      page_id TEXT,
      original_name TEXT,
      posted_path TEXT,
      fb_post_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS caption_recent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caption_norm TEXT NOT NULL,
      page_row_id INTEGER,
      page_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_caption_recent_norm ON caption_recent(caption_norm);
    CREATE INDEX IF NOT EXISTS idx_caption_recent_at ON caption_recent(created_at);

    CREATE TABLE IF NOT EXISTS anti_spam_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS graph_backoff (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      until_ts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      streak INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const row = db.prepare(`SELECT id FROM anti_spam_settings WHERE id = 1`).get();
  if (!row) {
    db.prepare(
      `INSERT INTO anti_spam_settings (id, settings_json) VALUES (1, ?)`
    ).run(JSON.stringify(SAFE_PRESET));
  }
  const bo = db.prepare(`SELECT id FROM graph_backoff WHERE id = 1`).get();
  if (!bo) {
    db.prepare(`INSERT INTO graph_backoff (id, until_ts, streak) VALUES (1, 0, 0)`).run();
  }
}

export function getAntiSpamSettings() {
  ensureAntiSpamTables();
  const db = getDb();
  const row = db.prepare(`SELECT settings_json FROM anti_spam_settings WHERE id = 1`).get();
  let s = { ...SAFE_PRESET };
  try {
    s = { ...SAFE_PRESET, ...JSON.parse(row?.settings_json || "{}") };
  } catch {
    /* keep default */
  }
  return normalizeSettings(s);
}

function normalizeSettings(raw) {
  const s = { ...SAFE_PRESET, ...raw };
  const num = (k, min, max) => {
    let v = Number(s[k]);
    if (!Number.isFinite(v)) v = SAFE_PRESET[k];
    s[k] = Math.min(max, Math.max(min, v));
  };
  s.enabled = s.enabled ? 1 : 0;
  s.block_duplicate_caption = s.block_duplicate_caption ? 1 : 0;
  s.block_duplicate_media = s.block_duplicate_media ? 1 : 0;
  s.media_once_forever = s.media_once_forever ? 1 : 0;
  s.allow_ignore_quota = s.allow_ignore_quota ? 1 : 0;
  s.allow_ignore_interval = s.allow_ignore_interval ? 1 : 0;
  num("max_posts_per_hour_global", 1, 500);
  num("max_posts_per_day_global", 1, 2000);
  num("caption_dup_window_hours", 1, 720);
  num("page_cooldown_minutes", 0, 10080);
  num("jitter_minutes_min", 0, 120);
  num("jitter_minutes_max", 0, 240);
  if (s.jitter_minutes_max < s.jitter_minutes_min) {
    s.jitter_minutes_max = s.jitter_minutes_min;
  }
  num("bulk_max_pages", 1, 200);
  num("bulk_max_slots_per_page", 1, 100);
  num("bulk_max_total", 1, 500);
  num("graph_backoff_base_sec", 10, 7200);
  num("graph_backoff_max_sec", 60, 86400);
  num("pause_on_app_usage_pct", 10, 100);
  num("min_interval_minutes_floor", 0, 1440);
  num("min_max_posts_per_day_cap", 1, 100);

  if (Array.isArray(s.blocked_page_ids)) {
    s.blocked_page_ids_json = JSON.stringify(s.blocked_page_ids.map(String));
  }
  if (Array.isArray(s.blocked_keywords)) {
    s.blocked_keywords_json = JSON.stringify(
      s.blocked_keywords.map((x) => String(x).toLowerCase().trim()).filter(Boolean)
    );
  }
  s.blocked_page_ids = parseJsonArr(s.blocked_page_ids_json).map(String);
  s.blocked_keywords = parseJsonArr(s.blocked_keywords_json).map((x) =>
    String(x).toLowerCase().trim()
  );
  return s;
}

export function saveAntiSpamSettings(body = {}) {
  ensureAntiSpamTables();
  const cur = getAntiSpamSettings();
  const next = normalizeSettings({ ...cur, ...body });
  // persist without array fields (use json)
  const store = { ...next };
  delete store.blocked_page_ids;
  delete store.blocked_keywords;
  store.blocked_page_ids_json = JSON.stringify(next.blocked_page_ids);
  store.blocked_keywords_json = JSON.stringify(next.blocked_keywords);
  getDb()
    .prepare(
      `UPDATE anti_spam_settings SET settings_json = ?, updated_at = datetime('now') WHERE id = 1`
    )
    .run(JSON.stringify(store));
  return getAntiSpamSettings();
}

export function applyPreset(name) {
  const map = {
    safe: SAFE_PRESET,
    recommended: SAFE_PRESET,
    loose: LOOSE_PRESET,
    strict: STRICT_PRESET,
  };
  const p = map[String(name || "safe").toLowerCase()] || SAFE_PRESET;
  return saveAntiSpamSettings(p);
}

export function getRecommendations() {
  return {
    recommended: SAFE_PRESET,
    strict: STRICT_PRESET,
    loose: LOOSE_PRESET,
    tips: [
      "Mặc định Recommended: ~12 bài/giờ toàn app, 40/ngày, interval sàn 60 phút.",
      "1 file ảnh/video (hash) chỉ đăng 1 lần duy nhất (mọi page) rồi chuyển sang folder posted.",
      "Caption trùng trong 48h bị chặn — dùng kho caption lớn + random.",
      "allow_ignore_quota = OFF khi production (không bypass bằng nút Force).",
      "Jitter 3–18 phút tránh pattern hẹn giờ cứng.",
      "App usage Graph > 45% → tạm dừng publish/schedule.",
      "Bulk schedule: tối đa 15 page × 10 slot, tổng ≤ 40/lần.",
      "Siết hơn (nhiều page/nick): preset Strict. Test nội bộ: Loose (cẩn thận).",
    ],
  };
}

function logEvent(kind, detail) {
  try {
    ensureAntiSpamTables();
    getDb()
      .prepare(`INSERT INTO anti_spam_events (kind, detail) VALUES (?, ?)`)
      .run(kind, String(detail || "").slice(0, 2000));
  } catch {
    /* ignore */
  }
}

export function fileSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function normalizeCaption(caption) {
  return String(caption || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isMediaHashUsed(hash) {
  ensureAntiSpamTables();
  return !!getDb().prepare(`SELECT hash FROM media_hash_used WHERE hash = ?`).get(hash);
}

export function recordMediaHash({
  hash,
  page_row_id,
  page_id,
  original_name,
  posted_path,
  fb_post_id,
}) {
  ensureAntiSpamTables();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO media_hash_used
       (hash, page_row_id, page_id, original_name, posted_path, fb_post_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(
      hash,
      page_row_id || null,
      page_id || null,
      original_name || null,
      posted_path || null,
      fb_post_id || null
    );
}

export function recordCaption(caption, page_row_id, page_id) {
  ensureAntiSpamTables();
  const norm = normalizeCaption(caption);
  if (!norm) return;
  getDb()
    .prepare(
      `INSERT INTO caption_recent (caption_norm, page_row_id, page_id) VALUES (?, ?, ?)`
    )
    .run(norm, page_row_id || null, page_id || null);
}

function countPostsSince(isoCutoff) {
  const db = getDb();
  // success statuses
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM post_logs
       WHERE status IN ('ok','ok_comment_failed','scheduled')
         AND created_at >= ?`
    )
    .get(isoCutoff);
  return row?.n || 0;
}

export function getBackoffState() {
  ensureAntiSpamTables();
  const row = getDb().prepare(`SELECT * FROM graph_backoff WHERE id = 1`).get();
  const now = Math.floor(Date.now() / 1000);
  return {
    until_ts: row?.until_ts || 0,
    active: (row?.until_ts || 0) > now,
    seconds_left: Math.max(0, (row?.until_ts || 0) - now),
    last_error: row?.last_error || null,
    streak: row?.streak || 0,
  };
}

export function noteGraphSuccess() {
  ensureAntiSpamTables();
  getDb()
    .prepare(
      `UPDATE graph_backoff SET until_ts = 0, streak = 0, last_error = NULL, updated_at = datetime('now') WHERE id = 1`
    )
    .run();
}

export function noteGraphFailure(err) {
  ensureAntiSpamTables();
  const s = getAntiSpamSettings();
  if (!s.enabled) return getBackoffState();
  const msg = String(err?.message || err || "");
  const code = err?.code || err?.fb?.code;
  const spamLike =
    /spam|rate limit|too many|temporarily blocked|reduce the amount|permission denied|(#4)|(#17)|(#32)|(#613)|(#368)/i.test(
      msg
    ) || [4, 17, 32, 613, 368, 80001, 80006].includes(Number(code));

  const row = getDb().prepare(`SELECT streak FROM graph_backoff WHERE id = 1`).get();
  const streak = (row?.streak || 0) + 1;
  let until = 0;
  // Only real Graph spam/rate issues (not local validation) start backoff immediately;
  // require spamLike OR streak of Graph failures >= 3
  if (spamLike || streak >= 3) {
    const exp = Math.min(
      s.graph_backoff_max_sec,
      s.graph_backoff_base_sec * Math.pow(2, Math.min(Math.max(streak - 1, 0), 6))
    );
    until = Math.floor(Date.now() / 1000) + exp;
    logEvent("backoff", `streak=${streak} until+${exp}s err=${msg.slice(0, 200)}`);
  }
  getDb()
    .prepare(
      `UPDATE graph_backoff SET until_ts = ?, streak = ?, last_error = ?, updated_at = datetime('now') WHERE id = 1`
    )
    .run(until, streak, msg.slice(0, 500));
  return getBackoffState();
}

/**
 * Pre-flight checks before publishing/scheduling one post.
 * @returns {{ ok: true } | { ok: false, error: string, code: string }}
 */
export function assertCanPublish({
  pageRowId,
  pageId,
  caption,
  mediaPath,
  ignore_quota,
  ignore_interval,
  isSchedule = false,
} = {}) {
  ensureAntiSpamTables();
  const s = getAntiSpamSettings();
  if (!s.enabled) return { ok: true, settings: s };

  // Production locks
  if (ignore_quota && !s.allow_ignore_quota) {
    return {
      ok: false,
      code: "IGNORE_QUOTA_LOCKED",
      error:
        "Anti-spam: không cho bỏ qua quota (allow_ignore_quota=OFF). Bật trong Anti-spam settings nếu thật sự cần test.",
    };
  }
  if (ignore_interval && !s.allow_ignore_interval) {
    return {
      ok: false,
      code: "IGNORE_INTERVAL_LOCKED",
      error:
        "Anti-spam: không cho bỏ qua interval (allow_ignore_interval=OFF).",
    };
  }

  // Backoff
  const bo = getBackoffState();
  if (bo.active) {
    return {
      ok: false,
      code: "GRAPH_BACKOFF",
      error: `Anti-spam backoff Graph ~${Math.ceil(bo.seconds_left / 60)} phút (lỗi trước: ${bo.last_error || "—"})`,
    };
  }

  // App usage pause
  const usage = getLastUsage();
  if (
    usage?.call_count != null &&
    Number(usage.call_count) >= s.pause_on_app_usage_pct
  ) {
    return {
      ok: false,
      code: "APP_USAGE_HIGH",
      error: `Anti-spam: App API usage ${usage.call_count}% ≥ ${s.pause_on_app_usage_pct}% — tạm dừng publish.`,
    };
  }

  // Blocked pages
  if (
    s.blocked_page_ids.length &&
    (s.blocked_page_ids.includes(String(pageRowId)) ||
      s.blocked_page_ids.includes(String(pageId)))
  ) {
    return {
      ok: false,
      code: "PAGE_BLOCKED",
      error: "Anti-spam: page nằm trong cooldown/block list.",
    };
  }

  // Global caps
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const nHour = countPostsSince(hourAgo);
  const nDay = countPostsSince(dayAgo);
  if (nHour >= s.max_posts_per_hour_global) {
    return {
      ok: false,
      code: "GLOBAL_HOUR_CAP",
      error: `Anti-spam: đủ global ${nHour}/${s.max_posts_per_hour_global} bài/giờ (mọi page).`,
    };
  }
  if (nDay >= s.max_posts_per_day_global) {
    return {
      ok: false,
      code: "GLOBAL_DAY_CAP",
      error: `Anti-spam: đủ global ${nDay}/${s.max_posts_per_day_global} bài/24h (mọi page).`,
    };
  }

  // Page cooldown (last successful post any type on this page)
  if (s.page_cooldown_minutes > 0 && pageRowId) {
    const last = getDb()
      .prepare(
        `SELECT created_at FROM post_logs
         WHERE page_row_id = ? AND status IN ('ok','ok_comment_failed','scheduled')
         ORDER BY id DESC LIMIT 1`
      )
      .get(pageRowId);
    if (last?.created_at) {
      const t = new Date(last.created_at.replace(" ", "T")).getTime();
      const need = s.page_cooldown_minutes * 60 * 1000;
      if (Number.isFinite(t) && Date.now() - t < need) {
        const left = Math.ceil((need - (Date.now() - t)) / 60000);
        return {
          ok: false,
          code: "PAGE_COOLDOWN",
          error: `Anti-spam: page cooldown còn ~${left} phút (cài ${s.page_cooldown_minutes}p).`,
        };
      }
    }
  }

  // Keywords
  const cap = String(caption || "");
  const capLow = cap.toLowerCase();
  for (const kw of s.blocked_keywords) {
    if (kw && capLow.includes(kw)) {
      return {
        ok: false,
        code: "KEYWORD_BLOCK",
        error: `Anti-spam: caption chứa từ khóa chặn «${kw}».`,
      };
    }
  }

  // Caption duplicate
  if (s.block_duplicate_caption && cap.trim()) {
    const norm = normalizeCaption(cap);
    const since = new Date(
      Date.now() - s.caption_dup_window_hours * 60 * 60 * 1000
    ).toISOString();
    const hit = getDb()
      .prepare(
        `SELECT id, page_id, created_at FROM caption_recent
         WHERE caption_norm = ? AND created_at >= ?
         LIMIT 1`
      )
      .get(norm, since);
    if (hit) {
      return {
        ok: false,
        code: "CAPTION_DUP",
        error: `Anti-spam: caption trùng trong ${s.caption_dup_window_hours}h (đã dùng ${hit.created_at}).`,
      };
    }
    // also check post_logs
    const hit2 = getDb()
      .prepare(
        `SELECT id, created_at FROM post_logs
         WHERE status IN ('ok','ok_comment_failed','scheduled')
           AND created_at >= ?
           AND lower(trim(caption)) = ?
         LIMIT 1`
      )
      .get(since, norm);
    if (hit2) {
      return {
        ok: false,
        code: "CAPTION_DUP",
        error: `Anti-spam: caption trùng log trong ${s.caption_dup_window_hours}h.`,
      };
    }
  }

  // Media hash once
  if (s.block_duplicate_media && mediaPath && fs.existsSync(mediaPath)) {
    try {
      const hash = fileSha256(mediaPath);
      if (isMediaHashUsed(hash)) {
        return {
          ok: false,
          code: "MEDIA_DUP",
          error:
            "Anti-spam: ảnh/video này (hash) đã đăng 1 lần — không đăng lại. File nên chuyển sang posted.",
          media_hash: hash,
        };
      }
    } catch (e) {
      return {
        ok: false,
        code: "MEDIA_HASH_FAIL",
        error: `Anti-spam: không hash được media: ${e.message}`,
      };
    }
  }

  return { ok: true, settings: s, isSchedule };
}

/**
 * After successful publish: record caption + media hash, move media to posted.
 * Always moves media when media_once_forever (even if posted_folder empty → still try).
 */
export function finalizeMediaAfterSuccess({
  mediaPath,
  postedFolder,
  page_row_id,
  page_id,
  fb_post_id,
  caption,
}) {
  const s = getAntiSpamSettings();
  let movedPath = null;
  let hash = null;

  if (mediaPath && fs.existsSync(mediaPath)) {
    try {
      hash = fileSha256(mediaPath);
    } catch {
      hash = null;
    }
    const destDir = postedFolder || path.join(path.dirname(mediaPath), "..", "posted");
    try {
      ensureDir(destDir);
      movedPath = moveToPosted(mediaPath, destDir);
    } catch (e) {
      logEvent("move_fail", e.message);
      // If move failed but we must not re-use: still record hash
      movedPath = mediaPath;
    }
    if (hash && (s.block_duplicate_media || s.media_once_forever)) {
      recordMediaHash({
        hash,
        page_row_id,
        page_id,
        original_name: path.basename(mediaPath),
        posted_path: movedPath,
        fb_post_id,
      });
    }
  }

  if (caption) recordCaption(caption, page_row_id, page_id);
  noteGraphSuccess();
  return { movedPath, hash };
}

/**
 * Pick media skipping already-used hashes. Moves dups out of inbox → posted.
 */
export function pickUnusedMedia(folder, kind, pickMode, slotIndex, postedFolder) {
  const s = getAntiSpamSettings();
  const files = listMediaFilesSync(folder, kind);
  if (!files.length) return { path: null, skipped: 0 };

  if (!s.enabled || !s.block_duplicate_media) {
    return { path: pickMediaSync(folder, kind, pickMode, slotIndex), skipped: 0 };
  }

  let skipped = 0;
  const usable = [];
  for (const f of files) {
    try {
      const h = fileSha256(f);
      if (isMediaHashUsed(h)) {
        skipped++;
        if (postedFolder) {
          try {
            ensureDir(postedFolder);
            moveToPosted(f, postedFolder);
            logEvent("media_dup_moved", path.basename(f));
          } catch {
            /* ignore */
          }
        }
        continue;
      }
      usable.push(f);
    } catch {
      usable.push(f);
    }
  }
  if (!usable.length) return { path: null, skipped };
  if (pickMode === "random") {
    return {
      path: usable[Math.floor(Math.random() * usable.length)],
      skipped,
    };
  }
  return { path: usable[slotIndex % usable.length], skipped };
}

/** Apply floor to page config interval / daily max */
export function clampPageLimits(cfg) {
  const s = getAntiSpamSettings();
  if (!s.enabled) return cfg;
  const next = { ...cfg };
  if (s.min_interval_minutes_floor > 0) {
    next.interval_minutes = Math.max(
      Number(next.interval_minutes) || 0,
      s.min_interval_minutes_floor
    );
  }
  if (s.min_max_posts_per_day_cap > 0) {
    next.max_posts_per_day = Math.min(
      Number(next.max_posts_per_day) || s.min_max_posts_per_day_cap,
      s.min_max_posts_per_day_cap
    );
  }
  return next;
}

/** Jitter milliseconds random in [min,max] minutes */
export function randomJitterMs() {
  const s = getAntiSpamSettings();
  if (!s.enabled) return 0;
  const a = s.jitter_minutes_min;
  const b = s.jitter_minutes_max;
  if (b <= 0) return 0;
  const mins = a + Math.random() * (b - a);
  return Math.floor(mins * 60 * 1000);
}

export function applyJitterToDate(date) {
  const ms = randomJitterMs();
  return new Date(date.getTime() + ms);
}

/** Hard limits for bulk schedule plan */
export function enforceBulkLimits(plan, body = {}) {
  const s = getAntiSpamSettings();
  if (!s.enabled) {
    return { plan, trimmed: false, settings: s };
  }
  let pages = Array.isArray(plan) ? [...plan] : [];
  let trimmed = false;
  if (pages.length > s.bulk_max_pages) {
    pages = pages.slice(0, s.bulk_max_pages);
    trimmed = true;
  }
  let total = 0;
  pages = pages.map((p) => {
    let slots = Array.isArray(p.slots) ? [...p.slots] : [];
    if (slots.length > s.bulk_max_slots_per_page) {
      slots = slots.slice(0, s.bulk_max_slots_per_page);
      trimmed = true;
    }
    // jitter each slot
    slots = slots.map((d) => {
      const dt = d instanceof Date ? d : new Date(d);
      return applyJitterToDate(dt);
    });
    // re-filter 10min-30d after jitter
    const now = Date.now();
    slots = slots.filter(
      (d) =>
        d.getTime() >= now + 10 * 60 * 1000 &&
        d.getTime() <= now + 30 * 24 * 60 * 60 * 1000
    );
    return { ...p, slots };
  });

  const out = [];
  for (const p of pages) {
    if (total >= s.bulk_max_total) {
      trimmed = true;
      out.push({
        ...p,
        slots: [],
        error: p.error || `Anti-spam bulk: đủ total ${s.bulk_max_total} slot/lần`,
      });
      continue;
    }
    let slots = p.slots || [];
    if (total + slots.length > s.bulk_max_total) {
      slots = slots.slice(0, s.bulk_max_total - total);
      trimmed = true;
    }
    total += slots.length;
    out.push({ ...p, slots });
  }

  return {
    plan: out,
    trimmed,
    settings: s,
    caps: {
      bulk_max_pages: s.bulk_max_pages,
      bulk_max_slots_per_page: s.bulk_max_slots_per_page,
      bulk_max_total: s.bulk_max_total,
    },
  };
}

export function getAntiSpamStats() {
  ensureAntiSpamTables();
  const db = getDb();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return {
    settings: getAntiSpamSettings(),
    posts_last_hour: countPostsSince(hourAgo),
    posts_last_24h: countPostsSince(dayAgo),
    media_hashes: db.prepare(`SELECT COUNT(*) AS n FROM media_hash_used`).get().n,
    captions_tracked: db.prepare(`SELECT COUNT(*) AS n FROM caption_recent`).get().n,
    backoff: getBackoffState(),
    app_usage: getLastUsage(),
    recommendations: getRecommendations().tips,
  };
}

export function listRecentBlocks(limit = 30) {
  ensureAntiSpamTables();
  return getDb()
    .prepare(
      `SELECT * FROM anti_spam_events ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
}
